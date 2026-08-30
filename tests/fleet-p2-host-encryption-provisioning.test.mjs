import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

import {
  buildClevisPolicy,
  buildTangBackupAttestation,
  buildTangBackupEvidenceEnvelope,
  buildTangServerAttestation,
  buildSystemdConfiguration,
  canonicalDigest,
  canonicalJson,
  confirmations,
  sha256,
  tangBackupSignaturePayload,
  validateTangFleetAttestations,
} from '../tools/seori-auth/src/host-encryption-provisioning.mjs';

const execFileAsync = promisify(execFile);
const hostProductionCli = fileURLToPath(
  new URL('../scripts/fleet/provision-p2-host-encryption.mjs', import.meta.url),
);
const nativeBoundaryBuildCli = fileURLToPath(
  new URL('../scripts/fleet/build-p2-host-fs-boundary.mjs', import.meta.url),
);
const hostCli = fileURLToPath(
  new URL('./fixtures/p2-host-provision-fixture-entrypoint.mjs', import.meta.url),
);
const tangProductionCli = fileURLToPath(
  new URL('../scripts/fleet/provision-p2-tang-server.mjs', import.meta.url),
);
const tangCli = fileURLToPath(
  new URL('./fixtures/p2-tang-provision-fixture-entrypoint.mjs', import.meta.url),
);
const commandMock = fileURLToPath(
  new URL('./fixtures/p2-host-provision-command-mock.mjs', import.meta.url),
);
const contract = parse(await readFile('contracts/fleet-p2-host-encryption.yaml', 'utf8'));
const schema = JSON.parse(await readFile('contracts/fleet-p2-host-encryption.schema.json', 'utf8'));
const confirmationSet = confirmations(contract);
const fakeRecoverySecret = 'FAKE_LUKS_RECOVERY_SECRET_MUST_NEVER_APPEAR_0123456789';
const thumbprints = {
  rpi4001: 'A'.repeat(43),
  'seori-m6-01': 'B'.repeat(43),
};
const advertisements = {
  rpi4001: '{"server":"rpi4001","adv":1}\n',
  'seori-m6-01': '{"server":"seori-m6-01","adv":1}\n',
};
const tangKeyFixture = {
  'exc.jwk': '{"kty":"EC","kid":"fixture-exchange"}\n',
  'sig.jwk': '{"kty":"EC","kid":"fixture-signing"}\n',
};
const backupAuthorityKeyPair = generateKeyPairSync('ed25519');
const backupAuthorityPublicKey = backupAuthorityKeyPair.publicKey.export({
  type: 'spki',
  format: 'pem',
});

async function createFixture({ scenario = 'missing', nodeName = 'rpi5' } = {}) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'p2-host-provision-')));
  const root = join(temporary, 'root');
  const kubeconfig = join(temporary, 'kubeconfig');
  const recoveryKey = join(temporary, 'recovery-key');
  const state = join(temporary, 'state.json');
  const log = join(temporary, 'commands.jsonl');
  await Promise.all([
    mkdir(join(root, 'etc'), { recursive: true }),
    mkdir(join(root, 'var/lib/seori-auth'), { recursive: true }),
    mkdir(join(root, 'var/lib/tang'), { recursive: true }),
    mkdir(join(root, 'etc/systemd/system/tangd.socket.d'), { recursive: true }),
    mkdir(join(root, 'etc/seorilabs/trust'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, 'etc/fstab'), '# fixture fstab\n', { mode: 0o644 }),
    writeFile(join(root, 'etc/os-release'), 'ID=ubuntu\n', { mode: 0o644 }),
    writeFile(kubeconfig, 'fixture kubeconfig\n', { mode: 0o600 }),
    writeFile(recoveryKey, `${fakeRecoverySecret}\n`, { mode: 0o600 }),
    writeFile(
      join(root, contract.tang.backupAuthority.publicKeyPath.slice(1)),
      backupAuthorityPublicKey,
      { mode: 0o444 },
    ),
    ...Object.entries(tangKeyFixture).map(([name, bytes]) =>
      writeFile(join(root, 'var/lib/tang', name), bytes, { mode: 0o440 })),
  ]);
  await chmod(kubeconfig, 0o600);
  await chmod(recoveryKey, 0o600);
  await chmod(join(root, contract.tang.backupAuthority.publicKeyPath.slice(1)), 0o444);
  await chmod(join(root, 'var/lib/tang'), 0o750);
  await Promise.all(Object.keys(tangKeyFixture).map((name) =>
    chmod(join(root, 'var/lib/tang', name), 0o440)));

  const directoryMetadata = await stat(join(root, 'var/lib/tang'));
  const contentRecords = [];
  const metadataRecords = [];
  for (const name of Object.keys(tangKeyFixture).toSorted()) {
    const path = join(root, 'var/lib/tang', name);
    const entry = await stat(path);
    contentRecords.push({ name, sha256: sha256(await readFile(path)) });
    metadataRecords.push({
      name,
      ownerId: entry.uid,
      groupId: entry.gid,
      mode: (entry.mode & 0o7777).toString(8).padStart(4, '0'),
      sizeBytes: entry.size,
    });
  }
  const contentSha256 = canonicalDigest(contentRecords);
  const metadataSha256 = canonicalDigest({
    directory: {
      ownerId: directoryMetadata.uid,
      groupId: directoryMetadata.gid,
      mode: (directoryMetadata.mode & 0o7777).toString(8).padStart(4, '0'),
    },
    files: metadataRecords,
  });
  const inventoryEvidenceSha256 = canonicalDigest({ contentSha256, metadataSha256 });

  const tangAttestationPaths = [];
  const tangBackupEvidencePaths = [];
  for (const server of contract.tang.servers) {
    const keyInventory = {
      directory: server.keyDirectory,
      fileCount: 2,
      inventoryEvidenceSha256,
      backupLogicalId: server.backupLogicalId,
    };
    const privateEvidence = {
      schemaVersion: 1,
      nodeName: server.nodeName,
      logicalCredentialId: server.backupLogicalId,
      liveContentSha256: contentSha256,
      liveMetadataSha256: metadataSha256,
      inventoryEvidenceSha256,
      backupArtifactSha256: server.nodeName === 'rpi4001' ? 'c'.repeat(64) : 'd'.repeat(64),
      backupGeneration: `fixture-${server.nodeName}-generation-1`,
      isolatedRestoreContentSha256: contentSha256,
      isolatedRestoreMetadataSha256: metadataSha256,
      isolatedRestoreRunId: `fixture-${server.nodeName}-restore-1`,
    };
    const envelope = buildTangBackupEvidenceEnvelope({
      contract,
      server,
      privateEvidence,
      authorityPublicKey: backupAuthorityPublicKey,
    });
    const signature = sign(
      null,
      tangBackupSignaturePayload(contract, envelope),
      backupAuthorityKeyPair.privateKey,
    ).toString('base64');
    const backupAttestation = buildTangBackupAttestation({
      contract,
      server,
      privateEvidence,
      authorityPublicKey: backupAuthorityPublicKey,
      signature,
    });
    const attestation = buildTangServerAttestation({
      contract,
      server,
      hostname: server.expectedHostname,
      ipv4: server.ipv4,
      packageVersion: '15-3',
      signingKeyThumbprints: [thumbprints[server.nodeName]],
      advertisementSha256: sha256(advertisements[server.nodeName]),
      keyInventory,
      backupAttestation,
      authorityPublicKey: backupAuthorityPublicKey,
    });
    const path = join(temporary, `${server.nodeName}.json`);
    await writeFile(path, `${canonicalJson(attestation)}\n`, { mode: 0o600 });
    tangAttestationPaths.push(await realpath(path));
    const backupPath = join(temporary, `${server.nodeName}-backup-evidence.json`);
    await writeFile(backupPath, `${canonicalJson(backupAttestation)}\n`, { mode: 0o600 });
    tangBackupEvidencePaths.push(await realpath(backupPath));
  }

  const environment = {
    ...process.env,
    FAKE_RECOVERY_SECRET_CANARY: fakeRecoverySecret,
    SEORILABS_HOST_FIXTURE_LOG: log,
    SEORILABS_HOST_FIXTURE_NODE: nodeName,
    SEORILABS_HOST_FIXTURE_ROOT: root,
    SEORILABS_HOST_FIXTURE_RUNTIME: commandMock,
    SEORILABS_HOST_FIXTURE_SCENARIO: scenario,
    SEORILABS_HOST_FIXTURE_STATE: state,
    SEORI_AUTH_NATIVE_LAUNCHED: '1',
  };

  return {
    temporary,
    root,
    kubeconfig: await realpath(kubeconfig),
    recoveryKey: await realpath(recoveryKey),
    state,
    log,
    tangAttestationPaths,
    tangBackupEvidencePaths,
    authorityPublicKey: backupAuthorityPublicKey,
    environment,
    async cleanup() {
      await rm(temporary, { recursive: true, force: true });
    },
  };
}

function tangFlags(fixture) {
  return fixture.tangAttestationPaths.map((path) => `--tang-attestation=${path}`);
}

async function runHost(fixture, requestedMode, extra = [], scenario) {
  return execFileAsync(process.execPath, [hostCli, requestedMode, ...extra], {
    env: {
      ...fixture.environment,
      ...(scenario === undefined ? {} : { SEORILABS_HOST_FIXTURE_SCENARIO: scenario }),
    },
  });
}

async function expectHostFailure(fixture, requestedMode, extra, code, scenario) {
  await assert.rejects(
    runHost(fixture, requestedMode, extra, scenario),
    (error) => {
      assert.equal(error.code, 1);
      assert.deepEqual(JSON.parse(error.stderr), { ok: false, code });
      assert.doesNotMatch(`${error.stdout}${error.stderr}`, new RegExp(fakeRecoverySecret, 'u'));
      return true;
    },
  );
}

test('P2 host provisioning contract fixes non-sparse LUKS2, exact mount and Tang 1-of-2', async () => {
  const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
  assert.equal(validate(contract), true, JSON.stringify(validate.errors));
  assert.equal(contract.target.sourceSizeBytes, 16 * 1024 * 1024 * 1024);
  assert.equal(contract.target.allocationPolicy, 'NON_SPARSE');
  assert.equal(contract.target.mapperPath, '/dev/mapper/seori-auth-state');
  assert.equal(contract.target.mountPath, '/var/lib/seori-auth');
  assert.equal(
    contract.filesystemBoundary.executable,
    '/usr/local/libexec/seorilabs-p2-host-fs-boundary',
  );
  assert.equal(
    contract.filesystemBoundary.policy,
    'INITIAL_MOUNT_NAMESPACE_FIXED_DIRFD_NOREPLACE',
  );
  assert.ok(contract.filesystemBoundary.operations.includes('verify-namespace'));
  assert.ok(contract.filesystemBoundary.operations.includes('publish-record'));
  assert.equal(contract.gates.hostMountNamespacePolicy, 'PID1_INITIAL_MOUNT_NAMESPACE_EXACT');
  assert.equal(
    contract.gates.recordWritePolicy,
    'FIXED_RECORD_ID_STDIN_OPENAT_RENAME_NOREPLACE_ORPHAN_RECOVERY_FSYNC',
  );
  assert.equal(contract.tang.pin, 'sss');
  assert.deepEqual(contract.processBoundary, {
    launcherExecutable: '/usr/local/libexec/seori-auth-native',
    moduleExecutable: '/usr/local/libexec/seorilabs-p2-process-hardening.node',
    launchMarker: 'SEORI_AUTH_NATIVE_LAUNCHED',
    policy: 'INHERIT_CORE_NNP_REAPPLY_DUMPABLE_NATIVE_READBACK',
  });
  assert.equal(
    contract.gates.processHardeningPolicy,
    'NATIVE_LAUNCH_AND_NAPI_CHILD_READBACK_REQUIRED',
  );
  assert.equal(contract.tang.threshold, 1);
  assert.deepEqual(contract.tang.keyInventoryPolicy, {
    fileMode: '0440',
    ownershipPolicy: 'EXACT_KEY_DIRECTORY_UID_GID',
  });
  assert.deepEqual(contract.tang.servers.map(({ ipv4 }) => ipv4), [
    '192.168.0.100',
    '192.168.0.118',
  ]);
  assert.match(contract.systemd.crypttabLine, /luks,_netdev/u);
  assert.match(contract.systemd.fstabLine, /_netdev/u);
  assert.match(contract.systemd.fstabLine, /systemd-cryptsetup@seori\\x2dauth\\x2dstate\.service/u);
  assert.doesNotMatch(contract.systemd.fstabLine, /systemd-cryptsetup@seori-auth-state\.service/u);
  assert.equal(
    buildSystemdConfiguration(contract).cryptsetupUnit,
    'systemd-cryptsetup@seori\\x2dauth\\x2dstate.service',
  );
  assert.equal(contract.systemd.mountUnit, 'var-lib-seori\\x2dauth.mount');

  const { stdout, stderr } = await execFileAsync(process.execPath, [hostProductionCli, 'plan']);
  const plan = JSON.parse(stdout);
  assert.equal(stderr, '');
  assert.equal(plan.state, 'DRY_RUN');
  assert.equal(plan.secretValuesCreated, false);
  assert.equal(plan.secretValuesReturned, false);
  assert.equal(plan.confirmations.apply, confirmationSet.apply);
});

test('production native boundary build refuses a non-Linux artifact', {
  skip: process.platform === 'linux',
}, async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [nativeBoundaryBuildCli]),
    (error) => {
      assert.match(error.stderr, /production build requires Linux/u);
      return true;
    },
  );
});

test('central workflows gate Linux ARM64 host syscalls and Darwin child hardening', async () => {
  const [workflows, linuxHarness, linuxChild, linuxBuilder] = await Promise.all([
    Promise.all([
      '.github/workflows/contract-checks.yml',
      '.github/workflows/workflow-bundle-candidate.yml',
    ].map(async (path) => parse(await readFile(path, 'utf8')))),
    readFile('scripts/fleet/verify-p2-host-fs-boundary-linux-arm64.mjs', 'utf8'),
    readFile('scripts/fleet/verify-p2-process-hardening-child.mjs', 'utf8'),
    readFile('scripts/fleet/build-p2-host-fs-boundary.mjs', 'utf8'),
  ]);
  for (const source of [linuxHarness, linuxChild, linuxBuilder]) {
    const normalized = source.replaceAll('\\', '');
    assert.match(normalized, /\/root\/seorilabs-p2-native-harness-/u);
    assert.doesNotMatch(normalized, /\/(?:run|var\/tmp)\/seorilabs-p2-native-harness-/u);
  }
  for (const workflow of workflows) {
    const linux = workflow.jobs['p2-host-boundary-arm64'];
    const darwin = workflow.jobs['p2-process-boundary-macos'];
    assert.equal(linux['runs-on'], 'ubuntu-24.04-arm');
    assert.equal(linux['timeout-minutes'], 10);
    assert.equal(darwin['runs-on'], 'macos-26');
    assert.equal(darwin['timeout-minutes'], 10);
    assert.match(
      linux.steps.at(-1).run,
      /verify-p2-host-fs-boundary-linux-arm64\.mjs/u,
    );
    assert.match(
      darwin.steps.at(-1).run,
      /fleet-p2-process-hardening-darwin\.test\.mjs/u,
    );
  }
  assert.deepEqual(
    workflows[1].jobs.candidate.needs,
    ['p2-host-boundary-arm64', 'p2-process-boundary-macos'],
  );
});

test('Tang attestations exact-bind both host identities, port, advertisements and backup inventories', async (context) => {
  const fixture = await createFixture();
  context.after(() => fixture.cleanup());
  const attestations = await Promise.all(fixture.tangAttestationPaths.map(async (path) =>
    JSON.parse(await readFile(path, 'utf8'))));
  const validated = validateTangFleetAttestations(
    contract,
    attestations,
    fixture.authorityPublicKey,
  );
  assert.deepEqual(validated.map(({ nodeName }) => nodeName), ['rpi4001', 'seori-m6-01']);
  assert.equal(validated[0].backup.privateEvidence, undefined);
  assert.equal(validated[0].keyInventory.ownerId, undefined);
  assert.equal(validated[0].keyInventory.mode, undefined);
  assert.deepEqual(buildClevisPolicy(contract, validated, fixture.authorityPublicKey), {
    t: 1,
    pins: {
      tang: [
        { url: 'http://192.168.0.100:7500', thp: thumbprints.rpi4001 },
        { url: 'http://192.168.0.118:7500', thp: thumbprints['seori-m6-01'] },
      ],
    },
  });

  const partial = validated.slice(0, 1);
  assert.throws(
    () => validateTangFleetAttestations(contract, partial, fixture.authorityPublicKey),
    (error) => error?.code === 'P2_TANG_FLEET_ATTESTATION_PARTIAL',
  );
  const drifted = structuredClone(validated);
  drifted[0].ipv4 = '192.168.0.101';
  assert.throws(
    () => validateTangFleetAttestations(contract, drifted, fixture.authorityPublicKey),
    (error) => error?.code === 'P2_TANG_SERVER_ATTESTATION_INVALID',
  );

  const forged = structuredClone(validated);
  forged[0].backup.envelope.backupArtifactSha256 = 'e'.repeat(64);
  const forgedCore = { ...forged[0] };
  delete forgedCore.observedDigest;
  forged[0].observedDigest = canonicalDigest(forgedCore);
  assert.throws(
    () => validateTangFleetAttestations(contract, forged, fixture.authorityPublicKey),
    (error) => error?.code === 'P2_TANG_BACKUP_SIGNATURE_INVALID',
  );
});

test('success path backs up, provisions once, writes canonical marker and verifies a later boot', async (context) => {
  const fixture = await createFixture();
  context.after(() => fixture.cleanup());
  const backupResult = await runHost(fixture, 'backup', [
    `--confirmation=${confirmationSet.backup}`,
    `--kubeconfig=${fixture.kubeconfig}`,
  ]);
  const backupAttestation = JSON.parse(backupResult.stdout);
  assert.equal(backupAttestation.state, 'PRE_PROVISION_BACKUP_RESTORE_VERIFIED');
  assert.deepEqual(backupAttestation.unlockerState, { active: false, enabled: true });

  const applyResult = await runHost(fixture, 'apply', [
    `--confirmation=${confirmationSet.apply}`,
    `--kubeconfig=${fixture.kubeconfig}`,
    `--recovery-key-file=${fixture.recoveryKey}`,
    ...tangFlags(fixture),
  ]);
  const provisioned = JSON.parse(applyResult.stdout);
  assert.equal(provisioned.state, 'HOST_PROVISIONED_REBOOT_READBACK_REQUIRED');
  assert.equal(provisioned.hostEncryption.mapperPath, '/dev/mapper/seori-auth-state');
  assert.equal(provisioned.hostEncryption.pv.uid, 'fixture-pv-uid');
  assert.equal(provisioned.hostEncryption.pvc.resourceVersion, '17');
  assert.equal(provisioned.mapperBacking.backingDevice, '/dev/loop7');
  assert.equal(provisioned.mapperBacking.sourcePath, contract.target.sourcePath);

  const readbackResult = await runHost(fixture, 'readback', [
    `--kubeconfig=${fixture.kubeconfig}`,
    ...tangFlags(fixture),
  ]);
  assert.equal(JSON.parse(readbackResult.stdout).state, 'HOST_ENCRYPTED_MOUNT_VERIFIED');

  const persistentState = JSON.parse(await readFile(fixture.state, 'utf8'));
  persistentState.bootId = '22222222-2222-4222-8222-222222222222';
  await writeFile(fixture.state, `${JSON.stringify(persistentState)}\n`, 'utf8');
  const rebootResult = await runHost(fixture, 'reboot-readback', [
    `--kubeconfig=${fixture.kubeconfig}`,
    ...tangFlags(fixture),
  ]);
  assert.equal(JSON.parse(rebootResult.stdout).state, 'HOST_ENCRYPTED_MOUNT_REBOOT_VERIFIED');
  const markerPath = join(
    fixture.root,
    'var/lib/seori-auth/.seorilabs-host-encrypted-mount.json',
  );
  const markerBeforeRollback = await readFile(markerPath);
  const rollbackDestination = join(
    fixture.root,
    contract.target.rollbackSourcePath.slice(1),
  );
  await symlink('missing-rollback-target', rollbackDestination);
  const logBeforeRejectedRollback = (await readFile(fixture.log, 'utf8')).split('\n').length;
  await expectHostFailure(fixture, 'rollback', [
    `--confirmation=${confirmationSet.rollback}`,
    `--kubeconfig=${fixture.kubeconfig}`,
    `--recovery-key-file=${fixture.recoveryKey}`,
    ...tangFlags(fixture),
  ], 'P2_HOST_ROLLBACK_TARGET_ALREADY_EXISTS');
  const rejectedRollbackCalls = (await readFile(fixture.log, 'utf8'))
    .split('\n')
    .slice(logBeforeRejectedRollback - 1)
    .join('\n');
  assert.doesNotMatch(rejectedRollbackCalls, /"executable":"\/usr\/bin\/umount"|"executable":"\/usr\/bin\/mv"/u);
  await rm(rollbackDestination);

  const rollbackResult = await runHost(fixture, 'rollback', [
    `--confirmation=${confirmationSet.rollback}`,
    `--kubeconfig=${fixture.kubeconfig}`,
    `--recovery-key-file=${fixture.recoveryKey}`,
    ...tangFlags(fixture),
  ]);
  assert.equal(
    JSON.parse(rollbackResult.stdout).state,
    'HOST_ENCRYPTED_MOUNT_ROLLED_BACK_RECOVERABLE',
  );
  assert.equal(
    JSON.parse(rollbackResult.stdout).plaintextMarkerPresent,
    false,
  );
  assert.equal(
    JSON.parse(rollbackResult.stdout).encryptedMarkerDigest,
    JSON.parse(markerBeforeRollback).observedDigest,
  );
  const encryptedMarker = await readFile(
    join(fixture.root, '.encrypted-state/seori-auth-marker.json'),
  );
  assert.deepEqual(encryptedMarker, markerBeforeRollback);
  await assert.rejects(readFile(join(fixture.root, 'etc/crypttab'), 'utf8'), { code: 'ENOENT' });
  assert.equal(await readFile(join(fixture.root, 'etc/fstab'), 'utf8'), '# fixture fstab\n');
  assert.equal((await stat(join(fixture.root, 'etc/fstab'))).mode & 0o777, 0o644);
  const rolledBackState = JSON.parse(await readFile(fixture.state, 'utf8'));
  assert.equal(rolledBackState.unlockerEnabled, true);
  assert.equal(rolledBackState.unlockerActive, false);
  const rolledBackReadback = await runHost(fixture, 'readback', [
    `--kubeconfig=${fixture.kubeconfig}`,
    ...tangFlags(fixture),
  ]);
  assert.equal(JSON.parse(rolledBackReadback.stdout).state, 'HOST_ENCRYPTED_MOUNT_MISSING');

  const backupRoot = join(fixture.root, contract.target.backupRoot.slice(1));
  const originalProvision = await readFile(join(backupRoot, 'provision.json'));
  const restoreResult = await runHost(fixture, 'restore', [
    `--confirmation=${confirmationSet.restore}`,
    `--kubeconfig=${fixture.kubeconfig}`,
    `--recovery-key-file=${fixture.recoveryKey}`,
    ...tangFlags(fixture),
  ]);
  assert.equal(
    JSON.parse(restoreResult.stdout).state,
    'HOST_PROVISIONED_REBOOT_READBACK_REQUIRED',
  );
  assert.deepEqual(await readFile(join(backupRoot, 'provision.json')), originalProvision);
  assert.ok((await stat(join(backupRoot, 'provision.restored.json'))).isFile());

  const restoredPersistentState = JSON.parse(await readFile(fixture.state, 'utf8'));
  restoredPersistentState.bootId = '33333333-3333-4333-8333-333333333333';
  await writeFile(fixture.state, `${JSON.stringify(restoredPersistentState)}\n`, 'utf8');
  const restoredRebootResult = await runHost(fixture, 'reboot-readback', [
    `--kubeconfig=${fixture.kubeconfig}`,
    ...tangFlags(fixture),
  ]);
  assert.equal(
    JSON.parse(restoredRebootResult.stdout).state,
    'HOST_ENCRYPTED_MOUNT_REBOOT_VERIFIED',
  );
  assert.deepEqual(await readFile(join(backupRoot, 'provision.json')), originalProvision);
  assert.ok((await stat(join(backupRoot, 'reboot.restored.json'))).isFile());

  const restoredMarker = await readFile(markerPath);
  assert.deepEqual(restoredMarker, markerBeforeRollback);
  const marker = restoredMarker.toString('utf8');
  const log = await readFile(fixture.log, 'utf8');
  const publicArtifacts = [
    backupResult.stdout,
    applyResult.stdout,
    readbackResult.stdout,
    rebootResult.stdout,
    rollbackResult.stdout,
    rolledBackReadback.stdout,
    restoreResult.stdout,
    restoredRebootResult.stdout,
    marker,
    log,
    await readFile(join(fixture.root, 'etc/crypttab'), 'utf8'),
    await readFile(join(fixture.root, 'etc/fstab'), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(publicArtifacts, new RegExp(fakeRecoverySecret, 'u'));
  assert.doesNotMatch(log, new RegExp(fixture.recoveryKey.replaceAll('/', '\\/'), 'u'));
  assert.match(log, /\/proc\/self\/fd\/3/u);
  assert.doesNotMatch(log, /FAKE_RECOVERY_SECRET_CANARY/u);
  const calls = log.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.filter(({ executable, args }) =>
    executable === contract.filesystemBoundary.executable && args[0] === 'create-source').length, 1);
  assert.ok(calls.some(({ executable, args }) =>
    executable === contract.filesystemBoundary.executable && args[0] === 'backup-header'));
  assert.ok(calls.some(({ executable, args }) =>
    executable === contract.filesystemBoundary.executable && args[0] === 'apply-config'));
  assert.ok(calls.some(({ executable, args }) =>
    executable === contract.filesystemBoundary.executable && args[0] === 'rollback-config'));
  assert.ok(calls.some(({ executable, args }) =>
    executable === contract.filesystemBoundary.executable && args[0] === 'restore-config'));
  assert.deepEqual(
    calls.filter(({ executable, args }) =>
      executable === contract.filesystemBoundary.executable && args[0] === 'publish-record')
      .map(({ args }) => args[1]).toSorted(),
    [
      'crypttab-before', 'crypttab-managed', 'fstab-before', 'fstab-managed', 'marker',
      'pre-provision', 'provision', 'provision-restored', 'reboot', 'reboot-restored', 'rollback',
    ].toSorted(),
  );
  assert.doesNotMatch(log, /"executable":"\/usr\/bin\/fallocate"|"executable":"\/usr\/bin\/mv"|"luksHeaderBackup"/u);
  assert.ok(calls.some(({ executable, args }) =>
    executable === '/usr/sbin/cryptsetup' && args.includes('--test-passphrase')));
  assert.equal(calls.filter(({ executable, args }) =>
    executable === '/usr/bin/chown' &&
    args.includes(contract.target.markerPath)).length, 0);
  const secretCalls = calls.filter(({ args }) => args.includes('/proc/self/fd/3'));
  assert.ok(secretCalls.length >= 4);
  assert.equal(new Set(secretCalls.map(({ recoveryFdIdentity }) => recoveryFdIdentity)).size, 1);
});

test('partial, nonempty and identity drift fail before mutation', async (context) => {
  const partial = await createFixture({ scenario: 'partial' });
  const nonempty = await createFixture({ scenario: 'nonempty' });
  const wrongHost = await createFixture({ scenario: 'wrong-host' });
  const maskedUnlocker = await createFixture({ scenario: 'unlocker-masked' });
  const invalidActiveUnlocker = await createFixture({ scenario: 'unlocker-active-invalid' });
  context.after(async () => Promise.all([
    partial.cleanup(),
    nonempty.cleanup(),
    wrongHost.cleanup(),
    maskedUnlocker.cleanup(),
    invalidActiveUnlocker.cleanup(),
  ]));
  await expectHostFailure(partial, 'readback', [
    `--kubeconfig=${partial.kubeconfig}`,
    ...tangFlags(partial),
  ], 'P2_HOST_READBACK_PARTIAL');
  await expectHostFailure(nonempty, 'backup', [
    `--confirmation=${confirmationSet.backup}`,
    `--kubeconfig=${nonempty.kubeconfig}`,
  ], 'P2_HOST_STATE_DIRECTORY_NONEMPTY');
  await expectHostFailure(wrongHost, 'backup', [
    `--confirmation=${confirmationSet.backup}`,
    `--kubeconfig=${wrongHost.kubeconfig}`,
  ], 'P2_HOST_IDENTITY_MISMATCH');
  await expectHostFailure(maskedUnlocker, 'backup', [
    `--confirmation=${confirmationSet.backup}`,
    `--kubeconfig=${maskedUnlocker.kubeconfig}`,
  ], 'P2_HOST_SYSTEMD_ENABLED_STATE_INVALID');
  await expectHostFailure(invalidActiveUnlocker, 'backup', [
    `--confirmation=${confirmationSet.backup}`,
    `--kubeconfig=${invalidActiveUnlocker.kubeconfig}`,
  ], 'P2_HOST_SYSTEMD_ACTIVE_STATE_INVALID');
  for (const fixture of [partial, nonempty, wrongHost, maskedUnlocker, invalidActiveUnlocker]) {
    const log = await readFile(fixture.log, 'utf8');
    assert.doesNotMatch(log, /fallocate|luksFormat|"mount"/u);
  }
});

test('production entrypoints reject fixture injection before any command can run', async (context) => {
  const fixture = await createFixture();
  context.after(() => fixture.cleanup());
  for (const [cli, code, args] of [
    [hostProductionCli, 'P2_HOST_FIXTURE_INJECTION_FORBIDDEN', ['plan']],
    [tangProductionCli, 'P2_TANG_FIXTURE_INJECTION_FORBIDDEN', ['plan', '--server=rpi4001']],
  ]) {
    await assert.rejects(
      execFileAsync(process.execPath, [cli, ...args], { env: fixture.environment }),
      (error) => {
        assert.deepEqual(JSON.parse(error.stderr), { ok: false, code });
        return true;
      },
    );
  }
});

test('production host entrypoint rejects kubectl executable overrides', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [hostProductionCli, 'plan'], {
      env: { ...process.env, SEORILABS_KUBECTL: '/tmp/lookalike-kubectl' },
    }),
    (error) => {
      assert.deepEqual(JSON.parse(error.stderr), {
        ok: false,
        code: 'P2_HOST_KUBECTL_OVERRIDE_FORBIDDEN',
      });
      return true;
    },
  );
});

test('production host and Tang entrypoints reject plain Node execution', async () => {
  const environment = { ...process.env };
  delete environment.SEORI_AUTH_NATIVE_LAUNCHED;
  for (const [cli, args, code] of [
    [hostProductionCli, ['readback'], 'P2_HOST_NATIVE_LAUNCH_REQUIRED'],
    [tangProductionCli, ['readback', '--server=rpi4001'], 'P2_TANG_NATIVE_LAUNCH_REQUIRED'],
  ]) {
    await assert.rejects(
      execFileAsync(process.execPath, [cli, ...args], { env: environment }),
      (error) => {
        assert.deepEqual(JSON.parse(error.stderr), { ok: false, code });
        return true;
      },
    );
  }
});

test('host and Tang reject a forged launcher marker without native hardening readback', async (context) => {
  const hostFixture = await createFixture({ scenario: 'unhardened-process' });
  const tangFixture = await createFixture({ scenario: 'unhardened-process', nodeName: 'rpi4001' });
  context.after(async () => Promise.all([hostFixture.cleanup(), tangFixture.cleanup()]));
  await expectHostFailure(hostFixture, 'backup', [
    `--confirmation=${confirmationSet.backup}`,
    `--kubeconfig=${hostFixture.kubeconfig}`,
  ], 'P2_HOST_PROCESS_HARDENING_READBACK_FAILED');
  await assert.rejects(
    execFileAsync(process.execPath, [
      tangCli,
      'readback',
      '--server=rpi4001',
      `--backup-attestation=${tangFixture.tangBackupEvidencePaths[0]}`,
    ], { env: tangFixture.environment }),
    (error) => {
      assert.deepEqual(JSON.parse(error.stderr), {
        ok: false,
        code: 'P2_TANG_PROCESS_HARDENING_READBACK_FAILED',
      });
      return true;
    },
  );
  for (const fixture of [hostFixture, tangFixture]) {
    const log = await readFile(fixture.log, 'utf8');
    assert.doesNotMatch(log, /seorilabs-p2-host-fs-boundary|apt-get|cryptsetup|systemctl/u);
  }
});

test('host and Tang operations reject an alternate mount namespace before readback or mutation', async (context) => {
  const fixture = await createFixture({ scenario: 'alternate-mount-namespace' });
  context.after(() => fixture.cleanup());
  const plan = await runHost(fixture, 'plan');
  assert.equal(JSON.parse(plan.stdout).state, 'DRY_RUN');
  await expectHostFailure(fixture, 'backup', [
    `--confirmation=${confirmationSet.backup}`,
    `--kubeconfig=${fixture.kubeconfig}`,
  ], 'P2_HOST_MOUNT_NAMESPACE_MISMATCH');
  await assert.rejects(
    execFileAsync(process.execPath, [
      tangCli,
      'apply',
      '--server=rpi4001',
      `--confirmation=${confirmationSet.tang.rpi4001}`,
    ], { env: fixture.environment }),
    (error) => {
      assert.deepEqual(JSON.parse(error.stderr), {
        ok: false,
        code: 'P2_TANG_MOUNT_NAMESPACE_MISMATCH',
      });
      return true;
    },
  );
  await assert.rejects(readFile(fixture.log, 'utf8'), { code: 'ENOENT' });
});

test('recovery key is single-open and a path swap fails before a second secret consumer', async (context) => {
  const fixture = await createFixture({ scenario: 'recovery-key-swap' });
  context.after(() => fixture.cleanup());
  await runHost(fixture, 'backup', [
    `--confirmation=${confirmationSet.backup}`,
    `--kubeconfig=${fixture.kubeconfig}`,
  ]);
  await expectHostFailure(fixture, 'apply', [
    `--confirmation=${confirmationSet.apply}`,
    `--kubeconfig=${fixture.kubeconfig}`,
    `--recovery-key-file=${fixture.recoveryKey}`,
    ...tangFlags(fixture),
  ], 'P2_HOST_RECOVERY_KEY_FILE_CHANGED');
  const log = await readFile(fixture.log, 'utf8');
  const calls = log.trim().split('\n').map((line) => JSON.parse(line));
  const secretCalls = calls.filter(({ args }) => args.includes('/proc/self/fd/3'));
  assert.equal(secretCalls.length, 1);
  assert.equal(secretCalls[0].executable, '/usr/sbin/cryptsetup');
  assert.doesNotMatch(log, new RegExp(fakeRecoverySecret, 'u'));
  assert.doesNotMatch(log, new RegExp(fixture.recoveryKey.replaceAll('/', '\\/'), 'u'));
});

test('live Kubernetes consumers fail closed before host mutation', async (context) => {
  const fixture = await createFixture({ scenario: 'consumer-active' });
  context.after(() => fixture.cleanup());
  await expectHostFailure(fixture, 'backup', [
    `--confirmation=${confirmationSet.backup}`,
    `--kubeconfig=${fixture.kubeconfig}`,
  ], 'P2_HOST_LIVE_REPLICAS_NOT_ZERO');
  const log = await readFile(fixture.log, 'utf8');
  assert.doesNotMatch(log, /fallocate|luksFormat|"mount"|"mv"/u);
});

test('ancestor hostPath and mapper-directory consumers fail closed', async (context) => {
  const fixtures = await Promise.all([
    createFixture({ scenario: 'consumer-ancestor-hostpath' }),
    createFixture({ scenario: 'consumer-mapper-hostpath' }),
  ]);
  context.after(async () => Promise.all(fixtures.map((fixture) => fixture.cleanup())));
  for (const fixture of fixtures) {
    await expectHostFailure(fixture, 'backup', [
      `--confirmation=${confirmationSet.backup}`,
      `--kubeconfig=${fixture.kubeconfig}`,
    ], 'P2_HOST_LIVE_CONSUMER_PRESENT');
    assert.doesNotMatch(await readFile(fixture.log, 'utf8'), /create-source|luksFormat|"mount"/u);
  }
});

test('broken symlink and parent inode substitution fail before destructive mutation', async (context) => {
  const symlinkFixture = await createFixture();
  const driftFixture = await createFixture();
  context.after(async () => Promise.all([symlinkFixture.cleanup(), driftFixture.cleanup()]));

  const brokenSource = join(symlinkFixture.root, 'data/seori-auth/seori-auth-state.luks');
  await mkdir(join(symlinkFixture.root, 'data/seori-auth'), { recursive: true });
  await symlink('missing-target', brokenSource);
  await expectHostFailure(symlinkFixture, 'backup', [
    `--confirmation=${confirmationSet.backup}`,
    `--kubeconfig=${symlinkFixture.kubeconfig}`,
  ], 'P2_HOST_SOURCE_PATH_NOT_MISSING');

  await runHost(driftFixture, 'backup', [
    `--confirmation=${confirmationSet.backup}`,
    `--kubeconfig=${driftFixture.kubeconfig}`,
  ]);
  const originalParent = join(driftFixture.root, 'data/seori-auth');
  await rename(originalParent, `${originalParent}.substituted`);
  await mkdir(originalParent, { recursive: true, mode: 0o700 });
  await expectHostFailure(driftFixture, 'apply', [
    `--confirmation=${confirmationSet.apply}`,
    `--kubeconfig=${driftFixture.kubeconfig}`,
    `--recovery-key-file=${driftFixture.recoveryKey}`,
    ...tangFlags(driftFixture),
  ], 'P2_HOST_PATH_IDENTITY_DRIFT');
  for (const fixture of [symlinkFixture, driftFixture]) {
    const log = await readFile(fixture.log, 'utf8');
    assert.doesNotMatch(log, /fallocate|luksFormat|"mount"|"mv"/u);
  }
});

test('mount drift is rejected and marker is never accepted on a plaintext fallback', async (context) => {
  const fixture = await createFixture();
  context.after(() => fixture.cleanup());
  await runHost(fixture, 'backup', [
    `--confirmation=${confirmationSet.backup}`,
    `--kubeconfig=${fixture.kubeconfig}`,
  ]);
  await runHost(fixture, 'apply', [
    `--confirmation=${confirmationSet.apply}`,
    `--kubeconfig=${fixture.kubeconfig}`,
    `--recovery-key-file=${fixture.recoveryKey}`,
    ...tangFlags(fixture),
  ]);
  await expectHostFailure(fixture, 'readback', [
    `--kubeconfig=${fixture.kubeconfig}`,
    ...tangFlags(fixture),
  ], 'P2_HOST_MOUNT_IDENTITY_DRIFT', 'drift');
});

test('mapper readback rejects a lookalike loop backing file', async (context) => {
  const fixture = await createFixture();
  context.after(() => fixture.cleanup());
  await runHost(fixture, 'backup', [
    `--confirmation=${confirmationSet.backup}`,
    `--kubeconfig=${fixture.kubeconfig}`,
  ]);
  await runHost(fixture, 'apply', [
    `--confirmation=${confirmationSet.apply}`,
    `--kubeconfig=${fixture.kubeconfig}`,
    `--recovery-key-file=${fixture.recoveryKey}`,
    ...tangFlags(fixture),
  ]);
  await expectHostFailure(fixture, 'readback', [
    `--kubeconfig=${fixture.kubeconfig}`,
    ...tangFlags(fixture),
  ], 'P2_HOST_MAPPER_BACKING_DRIFT', 'wrong-backing');
});

test('native filesystem boundary uses fixed dirfds and atomic no-clobber operations', async () => {
  const source = await readFile('scripts/fleet/native/p2-host-fs-boundary.c', 'utf8');
  const caller = await readFile('scripts/fleet/provision-p2-host-encryption.mjs', 'utf8');
  assert.match(source, /openat\(/u);
  assert.match(source, /\.seorilabs-p2-record\.%s\.pending/u);
  assert.match(source, /SYS_renameat2/u);
  assert.match(source, /RENAME_NOREPLACE/u);
  assert.match(source, /RENAME_EXCHANGE/u);
  assert.match(source, /posix_fallocate/u);
  assert.match(source, /SOURCE_PATH/u);
  assert.match(source, /\/proc\/1\/ns\/mnt/u);
  assert.match(source, /NSFS_MAGIC/u);
  assert.match(source, /STDIN_FILENO/u);
  assert.match(source, /luksHeaderBackup[^]*source_child_path/u);
  assert.match(source, /require_same_entry\(source_parent, SOURCE_LEAF, &source_entry\)/u);
  assert.doesNotMatch(source, /luksHeaderBackup[^\n]*SOURCE_PATH/u);
  assert.doesNotMatch(source, /argv\[[0-9]+\].*SOURCE_PATH/u);
  assert.doesNotMatch(caller, /linkSync\(|openSync\(temporary|unlinkSync\(temporary/u);
});

test('unknown mutation outcome stops immediately and the next run is readback-first', async (context) => {
  const fixture = await createFixture({ scenario: 'response-unknown' });
  context.after(() => fixture.cleanup());
  await runHost(fixture, 'backup', [
    `--confirmation=${confirmationSet.backup}`,
    `--kubeconfig=${fixture.kubeconfig}`,
  ]);
  await expectHostFailure(fixture, 'apply', [
    `--confirmation=${confirmationSet.apply}`,
    `--kubeconfig=${fixture.kubeconfig}`,
    `--recovery-key-file=${fixture.recoveryKey}`,
    ...tangFlags(fixture),
  ], 'P2_HOST_MUTATION_OUTCOME_UNKNOWN');
  await expectHostFailure(fixture, 'readback', [
    `--kubeconfig=${fixture.kubeconfig}`,
    ...tangFlags(fixture),
  ], 'P2_HOST_READBACK_PARTIAL', 'partial');
  const log = await readFile(fixture.log, 'utf8');
  const calls = log.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.filter(({ executable, args }) =>
    executable === contract.filesystemBoundary.executable && args[0] === 'create-source').length, 1);
  assert.doesNotMatch(log, new RegExp(fakeRecoverySecret, 'u'));
});

test('Tang server plan is mutation-free and exact host readback requires a backup attestation', async (context) => {
  const fixture = await createFixture({ nodeName: 'rpi4001' });
  context.after(() => fixture.cleanup());
  const plan = await execFileAsync(process.execPath, [
    tangProductionCli,
    'plan',
    '--server=rpi4001',
  ]);
  assert.equal(JSON.parse(plan.stdout).state, 'DRY_RUN');
  await writeFile(
    join(fixture.root, 'etc/systemd/system/tangd.socket.d/seorilabs.conf'),
    '[Socket]\nListenStream=\nListenStream=7500\n',
    { mode: 0o644 },
  );
  const readback = await execFileAsync(process.execPath, [
    tangCli,
    'readback',
    '--server=rpi4001',
    `--backup-attestation=${fixture.tangBackupEvidencePaths[0]}`,
  ], { env: fixture.environment });
  const attestation = JSON.parse(readback.stdout);
  assert.equal(attestation.state, 'TANG_SERVER_VERIFIED');
  assert.equal(attestation.hostname, 'rpi4001');
  assert.equal(attestation.port, 7500);
  assert.equal(attestation.advertisementSha256, sha256(advertisements.rpi4001));
  assert.equal(attestation.backup.privateEvidence, undefined);
  assert.doesNotMatch(readback.stdout, /liveContentSha256|liveMetadataSha256|fixture-signing/u);
  assert.doesNotMatch(`${readback.stdout}${await readFile(fixture.log, 'utf8')}`, new RegExp(fakeRecoverySecret, 'u'));
});

test('Tang readback rejects live key content drift against signed isolated-restore evidence', async (context) => {
  const fixture = await createFixture({ nodeName: 'rpi4001' });
  context.after(() => fixture.cleanup());
  await writeFile(
    join(fixture.root, 'etc/systemd/system/tangd.socket.d/seorilabs.conf'),
    '[Socket]\nListenStream=\nListenStream=7500\n',
    { mode: 0o644 },
  );
  await chmod(join(fixture.root, 'var/lib/tang/sig.jwk'), 0o640);
  await writeFile(
    join(fixture.root, 'var/lib/tang/sig.jwk'),
    '{"kty":"EC","kid":"drifted-signing"}\n',
    { mode: 0o440 },
  );
  await chmod(join(fixture.root, 'var/lib/tang/sig.jwk'), 0o440);
  await assert.rejects(
    execFileAsync(process.execPath, [
      tangCli,
      'readback',
      '--server=rpi4001',
      `--backup-attestation=${fixture.tangBackupEvidencePaths[0]}`,
    ], { env: fixture.environment }),
    (error) => {
      assert.deepEqual(JSON.parse(error.stderr), {
        ok: false,
        code: 'P2_TANG_BACKUP_LIVE_INVENTORY_MISMATCH',
      });
      return true;
    },
  );
});

test('Tang readback accepts package 0440 keys and rejects mode drift', async (context) => {
  const fixture = await createFixture({ nodeName: 'rpi4001' });
  context.after(() => fixture.cleanup());
  await writeFile(
    join(fixture.root, 'etc/systemd/system/tangd.socket.d/seorilabs.conf'),
    '[Socket]\nListenStream=\nListenStream=7500\n',
    { mode: 0o644 },
  );
  await chmod(join(fixture.root, 'var/lib/tang/sig.jwk'), 0o640);
  await assert.rejects(
    execFileAsync(process.execPath, [
      tangCli,
      'readback',
      '--server=rpi4001',
      `--backup-attestation=${fixture.tangBackupEvidencePaths[0]}`,
    ], { env: fixture.environment }),
    (error) => {
      assert.deepEqual(JSON.parse(error.stderr), {
        ok: false,
        code: 'P2_TANG_KEY_INVENTORY_READBACK_INVALID',
      });
      return true;
    },
  );
});

test('both missing Tang servers install only after exact confirmation and stop at the backup gate', async (context) => {
  const fixtures = await Promise.all(contract.tang.servers.map(({ nodeName }) =>
    createFixture({ scenario: 'tang-missing', nodeName })));
  context.after(async () => Promise.all(fixtures.map((fixture) => fixture.cleanup())));

  for (const [index, server] of contract.tang.servers.entries()) {
    const fixture = fixtures[index];
    const result = await execFileAsync(process.execPath, [
      tangCli,
      'apply',
      `--server=${server.nodeName}`,
      `--confirmation=${confirmationSet.tang[server.nodeName]}`,
    ], { env: fixture.environment });
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.state, 'TANG_SERVER_KEYS_BACKUP_REQUIRED');
    assert.equal(observed.hostname, server.expectedHostname);
    assert.equal(observed.ipv4, server.ipv4);
    assert.equal(observed.port, 7500);
    assert.equal(observed.requiredBackupLogicalId, server.backupLogicalId);
    assert.equal(observed.secretValuesReturned, false);
    assert.equal(
      await readFile(join(fixture.root, 'etc/systemd/system/tangd.socket.d/seorilabs.conf'), 'utf8'),
      '[Socket]\nListenStream=\nListenStream=7500\n',
    );
    const log = await readFile(fixture.log, 'utf8');
    assert.match(log, /"executable":"\/usr\/bin\/apt-get"/u);
    assert.match(log, /"executable":"\/usr\/bin\/systemctl"/u);
    const calls = log.trim().split('\n').map((line) => JSON.parse(line));
    const overrideIndex = calls.findIndex(({ executable, args }) =>
      executable === contract.filesystemBoundary.executable &&
      args.join('\0') === ['publish-record', 'tang-socket-override'].join('\0'));
    const updateIndex = calls.findIndex(({ executable, args }) =>
      executable === '/usr/bin/apt-get' && args.join('\0') === ['update'].join('\0'));
    const installIndex = calls.findIndex(({ executable, args }) =>
      executable === '/usr/bin/apt-get' && args.join('\0') === ['install', '--yes', 'tang'].join('\0'));
    assert.ok(overrideIndex >= 0 && overrideIndex < updateIndex && updateIndex < installIndex);
    assert.ok(calls.some(({ executable, args }) =>
      executable === contract.filesystemBoundary.executable &&
      args.join('\0') === ['verify-namespace'].join('\0')));
    assert.ok(calls.some(({ executable, args }) =>
      executable === contract.filesystemBoundary.executable &&
      args.join('\0') === ['publish-record', 'tang-socket-override'].join('\0')));
    assert.doesNotMatch(`${result.stdout}${result.stderr}${log}`, new RegExp(fakeRecoverySecret, 'u'));
  }
});

test('Tang override publication fails before package mutation and a staged override resumes safely', async (context) => {
  const failed = await createFixture({ scenario: 'tang-boundary-failure', nodeName: 'rpi4001' });
  const staged = await createFixture({ scenario: 'tang-missing', nodeName: 'rpi4001' });
  context.after(async () => Promise.all([failed.cleanup(), staged.cleanup()]));

  await assert.rejects(
    execFileAsync(process.execPath, [
      tangCli,
      'apply',
      '--server=rpi4001',
      `--confirmation=${confirmationSet.tang.rpi4001}`,
    ], { env: failed.environment }),
    (error) => {
      assert.deepEqual(JSON.parse(error.stderr), {
        ok: false,
        code: 'P2_TANG_MUTATION_OUTCOME_UNKNOWN',
      });
      return true;
    },
  );
  assert.doesNotMatch(await readFile(failed.log, 'utf8'), /"executable":"\/usr\/bin\/apt-get"/u);

  await writeFile(
    join(staged.root, 'etc/systemd/system/tangd.socket.d/seorilabs.conf'),
    '[Socket]\nListenStream=\nListenStream=7500\n',
    { mode: 0o644 },
  );
  const resumed = await execFileAsync(process.execPath, [
    tangCli,
    'apply',
    '--server=rpi4001',
    `--confirmation=${confirmationSet.tang.rpi4001}`,
  ], { env: staged.environment });
  assert.equal(JSON.parse(resumed.stdout).state, 'TANG_SERVER_KEYS_BACKUP_REQUIRED');
  const resumedLog = await readFile(staged.log, 'utf8');
  assert.match(resumedLog, /"executable":"\/usr\/bin\/apt-get"/u);
  assert.doesNotMatch(resumedLog, /"args":\["publish-record","tang-socket-override"\]/u);
});
