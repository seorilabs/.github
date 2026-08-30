#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const buildScript = resolve(repositoryRoot, 'scripts/fleet/build-p2-host-fs-boundary.mjs');
const launcherBuildScript = resolve(repositoryRoot, 'tools/seori-auth/scripts/build-native.mjs');
const processBoundaryBuildScript = resolve(
  repositoryRoot,
  'scripts/fleet/build-p2-process-hardening-boundary.mjs',
);
const processBoundaryChild = resolve(
  repositoryRoot,
  'scripts/fleet/verify-p2-process-hardening-child.mjs',
);
const harnessRoot = `/root/seorilabs-p2-native-harness-${randomUUID().replaceAll('-', '')}`;
const productionBinary = `${harnessRoot}/bin/seorilabs-p2-host-fs-boundary`;
const testBinary = `${harnessRoot}/bin/seorilabs-p2-host-fs-boundary-test`;
const nativeLauncher = `${harnessRoot}/bin/seori-auth-native`;
const processBoundaryModule = `${harnessRoot}/bin/seorilabs-p2-process-hardening.node`;
const publicEnvironment = {
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
};
const recordCanary = 'P2_RECORD_CONTENT_CANARY_MUST_NOT_APPEAR';
const replacementCanary = 'P2_REPLACEMENT_CANARY_MUST_NOT_APPEAR';

if (process.platform !== 'linux' || process.arch !== 'arm64') {
  throw new Error('P2 filesystem boundary harness requires Linux ARM64');
}
if (process.geteuid?.() !== 0) throw new Error('P2 filesystem boundary harness requires root');
if (!/^\/root\/seorilabs-p2-native-harness-[a-f0-9]+$/u.test(harnessRoot)) {
  throw new Error('P2 filesystem boundary harness root is invalid');
}

function run(executable, args, { allowHarnessPath = false, input, expectedStatus = 0 } = {}) {
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: publicEnvironment,
    input,
    maxBuffer: 2 * 1024 * 1024,
    shell: false,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(
    result.status,
    expectedStatus,
    `unexpected exit from ${executable}: ${result.stderr}`,
  );
  const publicOutput = `${result.stdout}${result.stderr}`;
  assert.doesNotMatch(publicOutput, new RegExp(recordCanary, 'u'));
  assert.doesNotMatch(publicOutput, new RegExp(replacementCanary, 'u'));
  if (!allowHarnessPath) assert.doesNotMatch(publicOutput, new RegExp(harnessRoot, 'u'));
  return result;
}

function build(output, testRoot) {
  const result = run(process.execPath, [
    buildScript,
    output,
    ...(testRoot === undefined ? [] : [`--test-root=${testRoot}`]),
  ], { allowHarnessPath: true });
  const receipt = JSON.parse(result.stdout);
  assert.deepEqual(receipt, {
    built: true,
    architecture: 'arm64',
    output,
    testBoundary: testRoot !== undefined,
  });
}

function buildLauncher() {
  const result = run(process.execPath, [launcherBuildScript, nativeLauncher], {
    allowHarnessPath: true,
  });
  assert.deepEqual(JSON.parse(result.stdout), { built: true, output: nativeLauncher });
}

function buildProcessBoundary() {
  const result = run(process.execPath, [processBoundaryBuildScript, processBoundaryModule], {
    allowHarnessPath: true,
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    built: true,
    platform: 'linux',
    architecture: 'arm64',
    output: processBoundaryModule,
  });
}

function assertArm64Elf(executable) {
  const header = readFileSync(executable).subarray(0, 64);
  assert.deepEqual([...header.subarray(0, 4)], [0x7f, 0x45, 0x4c, 0x46]);
  assert.equal(header[4], 2, 'ELF64 is required');
  assert.equal(header[5], 1, 'little-endian ELF is required');
  assert.equal(header.readUInt16LE(18), 183, 'AArch64 ELF machine is required');
  assert.equal(lstatSync(executable).mode & 0o022, 0);
}

try {
  for (const directory of [
    harnessRoot,
    `${harnessRoot}/bin`,
    `${harnessRoot}/data`,
    `${harnessRoot}/data/seori-auth`,
    `${harnessRoot}/data/seori-auth/rollback`,
    `${harnessRoot}/var`,
    `${harnessRoot}/var/backups`,
    `${harnessRoot}/var/lib`,
    `${harnessRoot}/var/lib/seori-auth`,
    `${harnessRoot}/etc`,
    `${harnessRoot}/etc/systemd`,
    `${harnessRoot}/etc/systemd/system`,
  ]) {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  build(productionBinary);
  assertArm64Elf(productionBinary);
  assert.deepEqual(JSON.parse(run(productionBinary, ['verify-namespace']).stdout), {
    operation: 'verify-namespace',
    verified: true,
  });
  const productionFailure = run(productionBinary, ['not-allowlisted'], { expectedStatus: 126 });
  assert.match(productionFailure.stderr, /operation is not allowlisted/u);

  buildLauncher();
  assertArm64Elf(nativeLauncher);
  buildProcessBoundary();
  assertArm64Elf(processBoundaryModule);
  const directHardeningReadback = run(process.execPath, [
    processBoundaryChild, processBoundaryModule,
  ], { expectedStatus: 1 });
  assert.deepEqual(JSON.parse(directHardeningReadback.stderr), {
    ok: false,
    code: 'P2_PROCESS_HARDENING_BOUNDARY_FAILED',
  });
  assert.deepEqual(
    JSON.parse(run(nativeLauncher, [
      'launch', '--', process.execPath, processBoundaryChild, processBoundaryModule,
    ]).stdout),
    {
      state: 'PROCESS_HARDENING_OK',
      coreSoft: 0,
      coreHard: 0,
      dumpable: 0,
      noNewPrivileges: 1,
    },
  );

  build(testBinary, harnessRoot);
  assertArm64Elf(testBinary);

  const recordBytes = Buffer.from(`${recordCanary}\n`, 'utf8');
  const published = run(testBinary, ['publish-record', 'pre-provision'], { input: recordBytes });
  assert.deepEqual(JSON.parse(published.stdout), {
    operation: 'publish-record',
    record: 'pre-provision',
    sizeBytes: recordBytes.length,
  });
  const recordPath = `${harnessRoot}/var/backups/seori-auth/fleet-p2-host-v1/pre-provision.json`;
  assert.deepEqual(readFileSync(recordPath), recordBytes);
  const recordEntry = lstatSync(recordPath);
  assert.equal(recordEntry.uid, 0);
  assert.equal(recordEntry.gid, 0);
  assert.equal(recordEntry.mode & 0o777, 0o600);
  assert.equal(recordEntry.nlink, 1);

  const orphanParent = `${harnessRoot}/var/backups/seori-auth/fleet-p2-host-v1`;
  const orphanPath = `${orphanParent}/.seorilabs-p2-record.fstab-before.pending`;
  const recoveredPath = `${orphanParent}/fstab.before`;
  writeFileSync(orphanPath, 'power-loss-partial', { mode: 0o600 });
  chmodSync(orphanPath, 0o600);
  const recoveredBytes = Buffer.from('RECOVERED_RECORD_AFTER_PARTIAL_WRITE\n', 'utf8');
  run(testBinary, ['publish-record', 'fstab-before'], { input: recoveredBytes });
  assert.deepEqual(readFileSync(recoveredPath), recoveredBytes);
  assert.equal(existsSync(orphanPath), false);
  assert.equal(lstatSync(recoveredPath).nlink, 1);

  const markerBytes = Buffer.from('{"publicMarker":true}\n', 'utf8');
  run(testBinary, ['publish-record', 'marker'], { input: markerBytes });
  const markerEntry = lstatSync(
    `${harnessRoot}/var/lib/seori-auth/.seorilabs-host-encrypted-mount.json`,
  );
  assert.equal(markerEntry.uid, 0);
  assert.equal(markerEntry.gid, 65532);
  assert.equal(markerEntry.mode & 0o777, 0o440);
  assert.equal(markerEntry.nlink, 1);

  const tangOverrideBytes = Buffer.from('[Socket]\nListenStream=\nListenStream=7500\n', 'utf8');
  run(testBinary, ['publish-record', 'tang-socket-override'], { input: tangOverrideBytes });
  const tangOverrideDirectory = lstatSync(`${harnessRoot}/etc/systemd/system/tangd.socket.d`);
  const tangOverridePath = `${harnessRoot}/etc/systemd/system/tangd.socket.d/seorilabs.conf`;
  const tangOverrideEntry = lstatSync(tangOverridePath);
  assert.equal(tangOverrideDirectory.uid, 0);
  assert.equal(tangOverrideDirectory.gid, 0);
  assert.equal(tangOverrideDirectory.mode & 0o777, 0o755);
  assert.deepEqual(readFileSync(tangOverridePath), tangOverrideBytes);
  assert.equal(tangOverrideEntry.uid, 0);
  assert.equal(tangOverrideEntry.gid, 0);
  assert.equal(tangOverrideEntry.mode & 0o777, 0o644);
  assert.equal(tangOverrideEntry.nlink, 1);
  run(testBinary, ['publish-record', 'tang-socket-override'], {
    input: Buffer.from(`${replacementCanary}\n`, 'utf8'),
    expectedStatus: 126,
  });
  assert.deepEqual(readFileSync(tangOverridePath), tangOverrideBytes);

  run(testBinary, ['publish-record', 'trust-anchor'], {
    input: Buffer.alloc((16 * 1024) + 1, 0x61),
    expectedStatus: 126,
  });
  const stage1Records = [
    ['backup-artifact-rpi4001', 'var/backups/seori-auth/tang-v1/rpi4001.server-keys.seori-aes256gcm', 0o600],
    ['live-evidence-rpi4001', 'var/backups/seori-auth/tang-v1/rpi4001.live-evidence.json', 0o600],
    ['backup-artifact-seori-m6-01', 'var/backups/seori-auth/tang-v1/seori-m6-01.server-keys.seori-aes256gcm', 0o600],
    ['live-evidence-seori-m6-01', 'var/backups/seori-auth/tang-v1/seori-m6-01.live-evidence.json', 0o600],
    ['trust-anchor', 'etc/seorilabs/trust/credential-backup-attestor.ed25519.pem', 0o444],
    ['tang-attestation-rpi4001', 'var/lib/seorilabs/tang-backup-attestations/rpi4001.json', 0o400],
    ['tang-attestation-seori-m6-01', 'var/lib/seorilabs/tang-backup-attestations/seori-m6-01.json', 0o400],
  ];
  for (const [identifier, relativePath, mode] of stage1Records) {
    const bytes = Buffer.from(`PUBLIC_STAGE1_PLACEHOLDER:${identifier}\n`, 'utf8');
    const receipt = JSON.parse(run(testBinary, ['publish-record', identifier], { input: bytes }).stdout);
    assert.deepEqual(receipt, {
      operation: 'publish-record',
      record: identifier,
      sizeBytes: bytes.length,
    });
    const path = `${harnessRoot}/${relativePath}`;
    const entry = lstatSync(path);
    assert.deepEqual(readFileSync(path), bytes);
    assert.equal(entry.uid, 0);
    assert.equal(entry.gid, 0);
    assert.equal(entry.mode & 0o777, mode);
    assert.equal(entry.nlink, 1);
  }
  for (const [relativePath, mode] of [
    ['var/backups/seori-auth', 0o700],
    ['var/backups/seori-auth/fleet-p2-host-v1', 0o700],
    ['var/backups/seori-auth/tang-v1', 0o700],
    ['etc/seorilabs', 0o755],
    ['etc/seorilabs/trust', 0o755],
    ['var/lib/seorilabs', 0o700],
    ['var/lib/seorilabs/tang-backup-attestations', 0o700],
  ]) {
    const entry = lstatSync(`${harnessRoot}/${relativePath}`);
    assert.equal(entry.uid, 0);
    assert.equal(entry.gid, 0);
    assert.equal(entry.mode & 0o777, mode);
  }

  run(testBinary, ['publish-record', 'pre-provision'], {
    input: Buffer.from(`${replacementCanary}\n`, 'utf8'),
    expectedStatus: 126,
  });
  assert.deepEqual(readFileSync(recordPath), recordBytes);
  run(testBinary, ['publish-record', '../pre-provision'], {
    input: Buffer.from(`${replacementCanary}\n`, 'utf8'),
    expectedStatus: 126,
  });

  const sourcePath = `${harnessRoot}/data/seori-auth/seori-auth-state.luks`;
  const rollbackPath = `${harnessRoot}/data/seori-auth/rollback/seori-auth-state.luks`;
  const sourceBytes = Buffer.from('PUBLIC_LUKS_IMAGE_PLACEHOLDER\n', 'utf8');
  const destinationBytes = Buffer.from('PUBLIC_EXISTING_DESTINATION\n', 'utf8');
  writeFileSync(sourcePath, sourceBytes, { mode: 0o600, flag: 'wx' });
  writeFileSync(rollbackPath, destinationBytes, { mode: 0o600, flag: 'wx' });
  run(testBinary, ['rollback-source'], { expectedStatus: 126 });
  assert.deepEqual(readFileSync(sourcePath), sourceBytes);
  assert.deepEqual(readFileSync(rollbackPath), destinationBytes);
  unlinkSync(rollbackPath);
  assert.equal(JSON.parse(run(testBinary, ['rollback-source']).stdout).moved, true);
  assert.deepEqual(readFileSync(rollbackPath), sourceBytes);
  assert.equal(JSON.parse(run(testBinary, ['restore-source']).stdout).moved, true);
  assert.deepEqual(readFileSync(sourcePath), sourceBytes);

  const namespaceFailure = run('/usr/bin/unshare', [
    '--mount', '--fork', productionBinary, 'verify-namespace',
  ], {
    expectedStatus: 126,
  });
  assert.match(namespaceFailure.stderr, /initial host mount namespace is required/u);

  process.stdout.write(`${JSON.stringify({
    architecture: 'linux-arm64',
    noClobberVerified: true,
    namespaceIsolationVerified: true,
    processHardeningVerified: true,
    productionBinaryExecuted: true,
    stage1RecordsVerified: true,
    syscallHarnessVerified: true,
  })}\n`);
} finally {
  if (existsSync(harnessRoot)) {
    const entry = lstatSync(harnessRoot);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== 0) {
      throw new Error('P2 filesystem boundary harness cleanup target is invalid');
    }
    rmSync(harnessRoot, { recursive: true, force: true, maxRetries: 2 });
  }
}
