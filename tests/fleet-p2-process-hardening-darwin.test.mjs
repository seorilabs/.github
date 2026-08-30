import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const nativeLauncher = fileURLToPath(
  new URL('../tools/seori-auth/.build/seori-auth-native', import.meta.url),
);
const processBoundaryModule = fileURLToPath(
  new URL('../.build/seorilabs-p2-process-hardening.node', import.meta.url),
);
const child = fileURLToPath(
  new URL('./fixtures/p2-process-hardening-darwin-child.mjs', import.meta.url),
);
const localControllerSource = fileURLToPath(
  new URL('./fixtures/p2-process-hardening-local-controller.mjs', import.meta.url),
);
const nativeLauncherSource = fileURLToPath(
  new URL('../tools/seori-auth/native/seori-auth-native.c', import.meta.url),
);
const boundaryModuleSource = fileURLToPath(
  new URL('../scripts/fleet/p2-process-hardening-boundary.mjs', import.meta.url),
);

function run(executable, args, environment = process.env) {
  return spawnSync(executable, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: environment,
    shell: false,
  });
}

test('Darwin child reapplies PT_DENY_ATTACH after native launch before JavaScript continues', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, () => {
  const directEnvironment = { ...process.env };
  delete directEnvironment.SEORI_AUTH_NATIVE_LAUNCHED;
  const direct = run(process.execPath, [child, processBoundaryModule], directEnvironment);
  assert.equal(direct.status, 1);
  assert.equal(direct.signal, null);
  assert.deepEqual(JSON.parse(direct.stderr), {
    ok: false,
    code: 'P2_PROCESS_HARDENING_BOUNDARY_FAILED',
  });

  const launched = run(nativeLauncher, [
    'launch', '--', process.execPath, child, processBoundaryModule,
  ]);
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(launched.signal, null);
  assert.deepEqual(JSON.parse(launched.stdout), {
    state: 'PROCESS_HARDENING_OK',
    coreSoft: 0,
    coreHard: 0,
    denyAttachApplied: true,
  });
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function mkdirExact(path, mode) {
  mkdirSync(path, { mode });
  chmodSync(path, mode);
}

test('Darwin local controller is bound to exact runtime source and inherited FDs 5/6/7', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, () => {
  const temporaryHome = realpathSync(mkdtempSync(join(tmpdir(), 'p2-local-boundary.')));
  try {
    const sourceSha = '0123456789abcdef0123456789abcdef01234567';
    const credentialRoot = join(temporaryHome, '.config/seorilabs');
    const binaryRoot = join(credentialRoot, 'bin');
    const runtimeBase = join(temporaryHome, '.local/share/seorilabs/fleet-p2');
    const sourceRoot = join(runtimeBase, sourceSha);
    const controllerRoot = join(sourceRoot, 'scripts/fleet');
    mkdirExact(join(temporaryHome, '.config'), 0o700);
    mkdirExact(credentialRoot, 0o700);
    mkdirExact(binaryRoot, 0o700);
    mkdirExact(join(temporaryHome, '.local'), 0o755);
    mkdirExact(join(temporaryHome, '.local/share'), 0o755);
    mkdirExact(join(temporaryHome, '.local/share/seorilabs'), 0o700);
    mkdirExact(runtimeBase, 0o700);
    mkdirExact(sourceRoot, 0o700);
    mkdirExact(join(sourceRoot, 'scripts'), 0o700);
    mkdirExact(controllerRoot, 0o700);

    const installedLauncher = join(binaryRoot, 'seori-auth-native');
    const installedModule = join(binaryRoot, 'seorilabs-p2-process-hardening.node');
    const controller = join(controllerRoot, 'provision-p2-stage1.mjs');
    const archive = join(sourceRoot, 'source.tar');
    const receipt = join(sourceRoot, 'stage1-local-source.json');
    const compile = run('/usr/bin/cc', [
      '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-D_FORTIFY_SOURCE=2',
      '-fstack-protector-strong',
      `-DSEORI_AUTH_LOCAL_BOUNDARY_TEST_HOME="${temporaryHome}"`,
      `-DSEORI_AUTH_LOCAL_BOUNDARY_TEST_NODE="${process.execPath}"`,
      nativeLauncherSource, '-o', installedLauncher,
    ]);
    assert.equal(compile.status, 0, compile.stderr);
    chmodSync(installedLauncher, 0o500);
    copyFileSync(processBoundaryModule, installedModule, fsConstants.COPYFILE_EXCL);
    chmodSync(installedModule, 0o400);
    copyFileSync(localControllerSource, controller, fsConstants.COPYFILE_EXCL);
    chmodSync(controller, 0o400);
    const archiveBytes = Buffer.from('p2-local-runtime-source-archive-v1\n', 'utf8');
    writeFileSync(archive, archiveBytes, { flag: 'wx', mode: 0o400 });
    chmodSync(archive, 0o400);

    const controllerSha256 = sha256(readFileSync(controller));
    const archiveSha256 = sha256(archiveBytes);
    const packageLockSha256 = sha256(readFileSync(join(repositoryRoot, 'package-lock.json')));
    const contractDigest = sha256(Buffer.from('p2-stage1-contract-v1', 'utf8'));
    const runtimeManifestSha256 = sha256(Buffer.from(
      `scripts/fleet/provision-p2-stage1.mjs\0${controllerSha256}\0source.tar\0${archiveSha256}`,
      'utf8',
    ));
    const runtimeFileCount = 2;
    const receiptDocument = {
      schemaVersion: 1,
      state: 'P2_STAGE1_LOCAL_RUNTIME_READY',
      sourceRepository: 'seorilabs/.github',
      sourceSha,
      archiveSha256,
      packageLockSha256,
      contractDigest,
      controllerRelativePath: 'scripts/fleet/provision-p2-stage1.mjs',
      controllerSha256,
      runtimeManifestSha256,
      runtimeFileCount,
      secretExposed: false,
    };
    const receiptBytes = Buffer.from(`${JSON.stringify(receiptDocument)}\n`, 'utf8');
    writeFileSync(receipt, receiptBytes, { flag: 'wx', mode: 0o400 });
    chmodSync(receipt, 0o400);
    const sourceReceiptSha256 = sha256(receiptBytes);
    const controllerArguments = [
      `--boundary-module=${boundaryModuleSource}`,
      `--trusted-root=${credentialRoot}`,
      `--source-sha=${sourceSha}`,
      `--archive-sha256=${archiveSha256}`,
      `--package-lock-sha256=${packageLockSha256}`,
      `--contract-digest=${contractDigest}`,
      `--controller-sha256=${controllerSha256}`,
      `--runtime-manifest-sha256=${runtimeManifestSha256}`,
      `--runtime-file-count=${runtimeFileCount}`,
      `--source-receipt-sha256=${sourceReceiptSha256}`,
    ];

    const directEnvironment = { ...process.env };
    for (const marker of [
      'SEORI_AUTH_NATIVE_LAUNCHED',
      'SEORI_AUTH_PROCESS_BOUNDARY_FD',
      'SEORI_AUTH_LOCAL_CONTROLLER_FD',
      'SEORI_AUTH_LOCAL_SOURCE_RECEIPT_FD',
      'SEORI_AUTH_LOCAL_SOURCE_SHA',
      'SEORI_AUTH_LOCAL_CONTROLLER_SHA256',
      'SEORI_AUTH_LOCAL_SOURCE_RECEIPT_SHA256',
    ]) delete directEnvironment[marker];
    const direct = run(process.execPath, [controller, ...controllerArguments], directEnvironment);
    assert.equal(direct.status, 1);
    assert.deepEqual(JSON.parse(direct.stderr), {
      ok: false,
      code: 'P2_LOCAL_PROCESS_HARDENING_BOUNDARY_FAILED',
    });

    const nativeArguments = [
      'launch-local-controller',
      `--source-sha=${sourceSha}`,
      `--controller-sha256=${controllerSha256}`,
      `--receipt-sha256=${sourceReceiptSha256}`,
      '--', process.execPath, controller, ...controllerArguments,
    ];
    const launched = run(installedLauncher, nativeArguments);
    assert.equal(launched.status, 0, launched.stderr);
    assert.deepEqual(JSON.parse(launched.stdout), {
      state: 'PROCESS_HARDENING_OK',
      coreSoft: 0,
      coreHard: 0,
      denyAttachApplied: true,
      descriptorsClosed: true,
      markersCleared: true,
    });
    assert.equal(lstatSync(join(temporaryHome, '.local')).mode & 0o7777, 0o755);
    assert.equal(lstatSync(join(temporaryHome, '.local/share')).mode & 0o7777, 0o755);

    const wrongDigest = run(installedLauncher, nativeArguments.map((argument) =>
      argument === `--receipt-sha256=${sourceReceiptSha256}`
        ? `--receipt-sha256=${'0'.repeat(64)}`
        : argument));
    assert.equal(wrongDigest.status, 126);
    assert.match(wrongDigest.stderr, /artifact digest is invalid/u);

    const wrongControllerDigest = run(installedLauncher, nativeArguments.map((argument) =>
      argument === `--controller-sha256=${controllerSha256}`
        ? `--controller-sha256=${'0'.repeat(64)}`
        : argument));
    assert.equal(wrongControllerDigest.status, 126);
    assert.match(wrongControllerDigest.stderr, /artifact digest is invalid/u);

    const dirtyPrimary = run(installedLauncher, [
      ...nativeArguments.slice(0, 6),
      join(repositoryRoot, 'scripts/fleet/provision-p2-stage1.mjs'),
      ...nativeArguments.slice(7),
    ]);
    assert.equal(dirtyPrimary.status, 126);
    assert.match(dirtyPrimary.stderr, /exact Node and runtime controller paths/u);
  } finally {
    rmSync(temporaryHome, { recursive: true, force: true });
  }
});
