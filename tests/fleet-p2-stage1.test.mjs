import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

import { sha256 } from '../tools/seori-auth/src/host-encryption-provisioning.mjs';
import {
  buildVerifiedPrivateEvidence,
  decryptTangBackup,
  encryptTangBackup,
  isolatedRestoreInventory,
  readScopedTangInventory,
} from '../tools/seori-auth/src/p2-stage1.mjs';

const execFileAsync = promisify(execFile);
const controller = fileURLToPath(
  new URL('./fixtures/p2-stage1-controller-fixture-entrypoint.mjs', import.meta.url),
);
const productionController = fileURLToPath(
  new URL('../scripts/fleet/provision-p2-stage1.mjs', import.meta.url),
);
const hostCli = fileURLToPath(
  new URL('./fixtures/p2-stage1-tang-fixture-entrypoint.mjs', import.meta.url),
);
const productionHostCli = fileURLToPath(
  new URL('../scripts/fleet/p2-stage1-tang-backup.mjs', import.meta.url),
);
const localBootstrap = fileURLToPath(
  new URL('./fixtures/p2-stage1-local-bootstrap-fixture-entrypoint.mjs', import.meta.url),
);
const productionLocalBootstrap = fileURLToPath(
  new URL('../scripts/fleet/bootstrap-p2-stage1-local-hardening.mjs', import.meta.url),
);
const relayBuild = fileURLToPath(
  new URL('../scripts/fleet/build-p2-stage1-ssh-relay.mjs', import.meta.url),
);
const relay = fileURLToPath(
  new URL('../.build/seorilabs-p2-stage1-ssh-relay', import.meta.url),
);
const contract = parse(await readFile('contracts/fleet-p2-stage1.yaml', 'utf8'));
const schema = JSON.parse(await readFile('contracts/fleet-p2-stage1.schema.json', 'utf8'));
const hostContract = parse(await readFile('contracts/fleet-p2-host-encryption.yaml', 'utf8'));
const secretCanary = 'STAGE1_PRIVATE_TANG_JWK_CANARY_MUST_NOT_APPEAR_84017';

async function createFixture() {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'seorilabs-p2-stage1-')));
  const credentialRoot = join(temporary, 'credentials');
  const remoteRoot = join(temporary, 'remote');
  const log = join(temporary, 'remote-commands.jsonl');
  await Promise.all([
    mkdir(credentialRoot, { recursive: true, mode: 0o700 }),
    mkdir(remoteRoot, { recursive: true, mode: 0o700 }),
  ]);
  await chmod(credentialRoot, 0o700);
  for (const host of contract.hosts) {
    const root = join(remoteRoot, host.nodeName);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(
        join(root, 'host-identity.json'),
        `${JSON.stringify({
          hostname: host.hostname,
          ipv4: host.ipv4,
          architecture: host.architecture,
        })}\n`,
        { mode: 0o600 },
      ),
      writeFile(
        join(root, 'mount-namespace.json'),
        `${JSON.stringify({ initial: true, nsfs: true })}\n`,
        { mode: 0o600 },
      ),
    ]);
    if (host.role === 'tang') {
      const tang = join(root, 'var/lib/tang');
      await mkdir(tang, { recursive: true, mode: 0o750 });
      await chmod(tang, 0o750);
      await Promise.all([
        writeFile(
          join(tang, 'sig.jwk'),
          `${JSON.stringify({ kty: 'EC', kid: `${host.nodeName}-sig`, d: secretCanary })}\n`,
          { mode: 0o440 },
        ),
        writeFile(
          join(tang, 'exc.jwk'),
          `${JSON.stringify({ kty: 'EC', kid: `${host.nodeName}-exc`, d: `${secretCanary}-2` })}\n`,
          { mode: 0o440 },
        ),
      ]);
      await Promise.all([
        chmod(join(tang, 'sig.jwk'), 0o440),
        chmod(join(tang, 'exc.jwk'), 0o440),
      ]);
    }
  }
  return {
    temporary,
    credentialRoot,
    remoteRoot,
    log,
    environment: {
      ...process.env,
      SEORILABS_P2_STAGE1_FIXTURE_CREDENTIAL_ROOT: credentialRoot,
      SEORILABS_P2_STAGE1_FIXTURE_REMOTE_ROOT: remoteRoot,
      SEORILABS_P2_STAGE1_FIXTURE_LOG: log,
    },
    async cleanup() {
      await rm(temporary, { recursive: true, force: true });
    },
  };
}

async function createLocalBootstrapFixture() {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'seorilabs-p2-stage1-local-')));
  const home = join(temporary, 'home');
  const credentialRoot = join(home, '.config/seorilabs');
  await Promise.all([
    mkdir(credentialRoot, { recursive: true, mode: 0o700 }),
    mkdir(join(home, '.local/share'), { recursive: true, mode: 0o755 }),
  ]);
  await Promise.all([
    chmod(home, 0o700),
    chmod(join(home, '.config'), 0o700),
    chmod(credentialRoot, 0o700),
    chmod(join(home, '.local'), 0o755),
    chmod(join(home, '.local/share'), 0o755),
  ]);
  return {
    temporary,
    home,
    credentialRoot,
    environment: {
      ...process.env,
      SEORILABS_P2_STAGE1_FIXTURE_CREDENTIAL_ROOT: credentialRoot,
      SEORILABS_P2_STAGE1_FIXTURE_HOME: home,
    },
    async cleanup() {
      await rm(temporary, { recursive: true, force: true });
    },
  };
}

async function localBootstrapPlan(fixture) {
  return JSON.parse((await execFileAsync(process.execPath, [localBootstrap, 'plan'], {
    env: fixture.environment,
    maxBuffer: 8 * 1024 * 1024,
  })).stdout);
}

function localBootstrapApplyArguments(plan) {
  return [
    'apply',
    `--source-sha=${plan.sourceSha}`,
    `--archive-sha=${plan.archiveSha256}`,
    `--lock-sha=${plan.packageLockSha256}`,
    `--controller-sha=${plan.controllerSha256}`,
    `--launcher-sha=${plan.launcherSha256}`,
    `--module-sha=${plan.moduleSha256}`,
    `--relay-sha=${plan.relaySha256}`,
    `--confirmation=${plan.confirmation}`,
  ];
}

async function runController(fixture, mode, arguments_ = [], scenario) {
  return execFileAsync(process.execPath, [controller, mode, ...arguments_], {
    env: {
      ...fixture.environment,
      ...(scenario === undefined ? {} : { SEORILABS_P2_STAGE1_FIXTURE_SCENARIO: scenario }),
    },
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function expectControllerFailure(fixture, mode, arguments_, code, scenario) {
  await assert.rejects(
    runController(fixture, mode, arguments_, scenario),
    (error) => {
      assert.equal(error.code, 1);
      assert.deepEqual(JSON.parse(error.stderr), { ok: false, code });
      assert.doesNotMatch(`${error.stdout}${error.stderr}`, new RegExp(secretCanary, 'u'));
      return true;
    },
  );
}

async function bootstrapCredentials(fixture) {
  const plan = JSON.parse((await runController(fixture, 'plan')).stdout);
  const backup = contract.attestor.preBootstrapBackup;
  const arguments_ = [
    `--confirmation=${plan.confirmations.attestor}`,
    `--pre-backup-sha=${backup.artifactSha256}`,
    `--pre-backup-file-count=${backup.fileCount}`,
    '--pre-backup-restore-verified=true',
  ];
  const result = JSON.parse((await runController(fixture, 'bootstrap-attestor', arguments_)).stdout);
  return { plan, arguments_, result };
}

function hostEnvironment(root) {
  return {
    ...process.env,
    SEORILABS_P2_STAGE1_FIXTURE_ROOT: root,
  };
}

async function runHost(root, mode, arguments_ = [], fd3 = Buffer.alloc(0)) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hostCli, mode, ...arguments_], {
      env: hostEnvironment(root),
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.stdio[3].end(fd3);
    child.once('close', (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

test('P2 Stage1 contract fixes separate signing/encryption identities and trusted boundaries', async () => {
  const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
  assert.equal(validate(contract), true, JSON.stringify(validate.errors));
  assert.equal(contract.attestor.algorithm, 'Ed25519');
  assert.equal(contract.tangBackupEncryption.algorithm, 'X25519-HKDF-SHA256-AES-256-GCM');
  assert.notEqual(contract.attestor.logicalCredentialId, contract.tangBackupEncryption.logicalCredentialId);
  assert.equal(contract.tangBackup.keyFileMode, '0440');
  assert.equal(
    contract.hostProcessBoundary.launcherExecutable,
    '/usr/local/libexec/seori-auth-native',
  );
  assert.equal(
    contract.hostProcessBoundary.moduleExecutable,
    '/usr/local/libexec/seorilabs-p2-process-hardening.node',
  );
  assert.equal(
    contract.localProcessBoundary.runtimeRootRelativePath,
    '.local/share/seorilabs/fleet-p2',
  );
  assert.equal(contract.localProcessBoundary.controllerFd, 6);
  assert.equal(contract.localProcessBoundary.sourceReceiptFd, 7);
  assert.deepEqual(Object.keys(contract.localProcessBoundary).toSorted(), [
    'controllerFd', 'controllerRelativePath', 'directoryMode', 'installPolicy',
    'launchMarker', 'launchOperation', 'launcherMode', 'launcherRelativePath', 'loadPolicy',
    'moduleFd', 'moduleMode', 'moduleRelativePath', 'receiptMode', 'receiptRelativePath',
    'runtimeRootRelativePath', 'sameUidThreatPolicy', 'sourceArchiveLeaf', 'sourceFileMode',
    'sourceReceiptFd', 'sourceReceiptLeaf',
  ].toSorted());
  assert.equal(contract.ssh.copyExecutable, undefined);
  assert.match(contract.ssh.authenticationPolicy, /TRUSTED_NATIVE_RELAY/u);
  assert.equal(contract.attestor.preBootstrapBackup.isolatedRestoreVerified, true);
});

test('scoped Tang inventory encrypts and restores content plus exact 0440 metadata', async () => {
  const fixture = await createFixture();
  const tang = join(fixture.remoteRoot, 'rpi4001/var/lib/tang');
  const server = hostContract.tang.servers[0];
  const pair = generateKeyPairSync('x25519');
  const privateKey = Buffer.from(pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const publicKey = Buffer.from(pair.publicKey.export({ format: 'pem', type: 'spki' }));
  let artifact;
  let payload;
  try {
    const inventory = readScopedTangInventory(tang);
    assert.equal(inventory.publicInventory.fileCount, 2);
    assert.ok(inventory.archivePayload.files.every(({ mode }) => mode === '0440'));
    artifact = encryptTangBackup({
      contract,
      server,
      archivePayload: inventory.archivePayload,
      recipientPublicKeyBytes: publicKey,
    });
    assert.doesNotMatch(artifact.toString('utf8'), new RegExp(secretCanary, 'u'));
    payload = decryptTangBackup({
      contract,
      server,
      artifactBytes: artifact,
      recipientPrivateKeyBytes: privateKey,
      recipientPublicKeyBytes: publicKey,
    });
    const restoreParent = await mkdtemp(join(tmpdir(), 'p2-stage1-restore-'));
    try {
      const restored = isolatedRestoreInventory({
        payload,
        temporaryParent: restoreParent,
        applyOwnership: false,
      });
      assert.deepEqual(restored, inventory.privateInventory);
      assert.doesNotThrow(() => buildVerifiedPrivateEvidence({
        server,
        artifactSha256: sha256(artifact),
        live: inventory.privateInventory,
        restored,
      }));
    } finally {
      await rm(restoreParent, { recursive: true, force: true });
    }
    for (const file of inventory.archivePayload.files) file.content = '';
  } finally {
    privateKey.fill(0);
    publicKey.fill(0);
    artifact?.fill(0);
    if (payload !== undefined) for (const file of payload.files) file.content = '';
    await fixture.cleanup();
  }
});

test('Tang inventory rejects non-JWK scope, symlinks, and non-0440 live keys', async () => {
  for (const scenario of ['extra', 'symlink', 'mode']) {
    const fixture = await createFixture();
    const tang = join(fixture.remoteRoot, 'rpi4001/var/lib/tang');
    try {
      if (scenario === 'extra') await writeFile(join(tang, 'notes.txt'), 'not a key\n', { mode: 0o440 });
      if (scenario === 'symlink') await symlink('sig.jwk', join(tang, 'alias.jwk'));
      if (scenario === 'mode') await chmod(join(tang, 'sig.jwk'), 0o640);
      assert.throws(
        () => readScopedTangInventory(tang),
        /P2_STAGE1_(?:TANG_SCOPE|FILE_IDENTITY)_INVALID/u,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test('credential bootstrap is create-only, exact on rerun, and never emits private bytes', async () => {
  const fixture = await createFixture();
  try {
    const first = await bootstrapCredentials(fixture);
    assert.equal(first.result.state, 'STAGE1_CREDENTIALS_BOOTSTRAPPED_OR_RECOVERED');
    assert.equal(first.result.secretExposed, false);
    const privatePath = join(fixture.credentialRoot, contract.attestor.privateKeyRelativePath);
    const encryptionPath = join(
      fixture.credentialRoot,
      contract.tangBackupEncryption.privateKeyRelativePath,
    );
    const [privateBytes, encryptionBytes, privateEntry, encryptionEntry] = await Promise.all([
      readFile(privatePath),
      readFile(encryptionPath),
      lstat(privatePath),
      lstat(encryptionPath),
    ]);
    assert.equal(privateEntry.mode & 0o777, 0o600);
    assert.equal(encryptionEntry.mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(first.result), /PRIVATE KEY/u);
    assert.equal(JSON.stringify(first.result).includes(privateBytes.toString('base64')), false);
    assert.equal(JSON.stringify(first.result).includes(encryptionBytes.toString('base64')), false);
    const second = JSON.parse(
      (await runController(fixture, 'bootstrap-attestor', first.arguments_)).stdout,
    );
    assert.equal(second.state, 'STAGE1_CREDENTIALS_EXACT_READBACK');
    privateBytes.fill(0);
    encryptionBytes.fill(0);
  } finally {
    await fixture.cleanup();
  }
});

test('private-only crash state derives public/catalog and completes the second credential pair', async () => {
  const fixture = await createFixture();
  try {
    const pair = generateKeyPairSync('ed25519');
    const privateBytes = Buffer.from(pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));
    const privatePath = join(fixture.credentialRoot, contract.attestor.privateKeyRelativePath);
    await mkdir(dirname(privatePath), { recursive: true, mode: 0o700 });
    await writeFile(privatePath, privateBytes, { mode: 0o600 });
    await chmod(privatePath, 0o600);
    privateBytes.fill(0);
    const { result } = await bootstrapCredentials(fixture);
    assert.equal(result.state, 'STAGE1_CREDENTIALS_BOOTSTRAPPED_OR_RECOVERED');
    await Promise.all([
      lstat(join(fixture.credentialRoot, contract.attestor.publicKeyRelativePath)),
      lstat(join(fixture.credentialRoot, contract.attestor.catalogShardRelativePath)),
      lstat(join(fixture.credentialRoot, contract.tangBackupEncryption.privateKeyRelativePath)),
      lstat(join(fixture.credentialRoot, contract.tangBackupEncryption.publicKeyRelativePath)),
      lstat(join(fixture.credentialRoot, contract.tangBackupEncryption.catalogShardRelativePath)),
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test('public-only and mismatched credential states require human recovery', async () => {
  for (const scenario of ['public-only', 'mismatch']) {
    const fixture = await createFixture();
    try {
      const first = generateKeyPairSync('ed25519');
      const second = generateKeyPairSync('ed25519');
      const privatePath = join(fixture.credentialRoot, contract.attestor.privateKeyRelativePath);
      const publicPath = join(fixture.credentialRoot, contract.attestor.publicKeyRelativePath);
      await mkdir(dirname(publicPath), { recursive: true, mode: 0o700 });
      if (scenario === 'mismatch') {
        await writeFile(
          privatePath,
          first.privateKey.export({ format: 'pem', type: 'pkcs8' }),
          { mode: 0o600 },
        );
        await chmod(privatePath, 0o600);
      }
      await writeFile(
        publicPath,
        (scenario === 'mismatch' ? second : first).publicKey.export({ format: 'pem', type: 'spki' }),
        { mode: 0o644 },
      );
      await chmod(publicPath, 0o644);
      const plan = JSON.parse((await runController(fixture, 'plan')).stdout);
      const backup = contract.attestor.preBootstrapBackup;
      await expectControllerFailure(
        fixture,
        'bootstrap-attestor',
        [
          `--confirmation=${plan.confirmations.attestor}`,
          `--pre-backup-sha=${backup.artifactSha256}`,
          `--pre-backup-file-count=${backup.fileCount}`,
          '--pre-backup-restore-verified=true',
        ],
        'P2_STAGE1_CREDENTIAL_HUMAN_RECOVERY_REQUIRED',
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test('Stage1 controller provisions, backs up, restore-verifies, signs, and delivers both Tang records', async () => {
  const fixture = await createFixture();
  const sourceSha = 'a'.repeat(40);
  try {
    const { plan } = await bootstrapCredentials(fixture);
    for (const nodeName of ['rpi4001', 'seori-m6-01']) {
      const provisioned = JSON.parse((await runController(fixture, 'provision-tang', [
        `--server=${nodeName}`,
        `--source-sha=${sourceSha}`,
        `--confirmation=${plan.confirmations.tangProvision[nodeName]}`,
      ])).stdout);
      assert.equal(provisioned.state, 'TANG_SERVER_KEYS_BACKUP_REQUIRED');
      const backedUp = JSON.parse((await runController(fixture, 'backup-tang', [
        `--server=${nodeName}`,
        `--source-sha=${sourceSha}`,
        `--confirmation=${plan.confirmations.tang[nodeName]}`,
      ])).stdout);
      assert.equal(backedUp.state, 'TANG_BACKUP_SIGNED_AND_CATALOGED');
      assert.equal(backedUp.secretExposed, false);
      const artifact = await readFile(join(
        fixture.credentialRoot,
        contract.tangBackup.localRelativeRoot,
        nodeName,
        contract.tangBackup.archiveSuffix,
      ));
      assert.doesNotMatch(artifact.toString('utf8'), new RegExp(secretCanary, 'u'));
      artifact.fill(0);
    }
    const delivered = JSON.parse((await runController(fixture, 'deliver-rpi5-evidence', [
      `--source-sha=${sourceSha}`,
      `--confirmation=${plan.confirmations.rpi5}`,
    ])).stdout);
    assert.equal(delivered.state, 'RPI5_TANG_TRUST_EVIDENCE_INSTALLED');
    assert.equal(delivered.secretExposed, false);
    for (const server of hostContract.tang.servers) {
      await lstat(join(
        fixture.remoteRoot,
        'rpi5',
        contract.tangBackup.hostAttestationRoot.slice(1),
        `${server.nodeName}.json`,
      ));
    }
    const combinedOutput = await readFile(fixture.log, 'utf8');
    assert.doesNotMatch(combinedOutput, new RegExp(secretCanary, 'u'));
    assert.doesNotMatch(combinedOutput, /PRIVATE KEY/u);
  } finally {
    await fixture.cleanup();
  }
});

test('unknown backup response resumes readback-first from artifact-only crash state', async () => {
  const fixture = await createFixture();
  const sourceSha = 'b'.repeat(40);
  try {
    const { plan } = await bootstrapCredentials(fixture);
    const flags = [
      '--server=rpi4001',
      `--source-sha=${sourceSha}`,
      `--confirmation=${plan.confirmations.tang.rpi4001}`,
    ];
    await expectControllerFailure(
      fixture,
      'backup-tang',
      flags,
      'P2_STAGE1_REMOTE_OUTCOME_UNKNOWN',
      'response-unknown',
    );
    await unlink(join(
      fixture.remoteRoot,
      'rpi4001',
      contract.tangBackup.remoteRoot.slice(1),
      'rpi4001.live-evidence.json',
    ));
    const recovered = JSON.parse((await runController(fixture, 'backup-tang', flags)).stdout);
    assert.equal(recovered.state, 'TANG_BACKUP_SIGNED_AND_CATALOGED');
    assert.equal(recovered.artifactState, 'CREATED');
    assert.doesNotMatch(JSON.stringify(recovered), new RegExp(secretCanary, 'u'));
  } finally {
    await fixture.cleanup();
  }
});

test('host fixture rejects alternate mount namespace before backup mutation', async () => {
  const fixture = await createFixture();
  try {
    const root = join(fixture.remoteRoot, 'rpi4001');
    await writeFile(
      join(root, 'mount-namespace.json'),
      `${JSON.stringify({ initial: false, nsfs: true })}\n`,
      { mode: 0o600 },
    );
    const result = await runHost(root, 'backup-state', ['--server=rpi4001']);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      code: 'P2_STAGE1_INITIAL_MOUNT_NAMESPACE_REQUIRED',
    });
    await assert.rejects(lstat(join(
      root,
      contract.tangBackup.remoteRoot.slice(1),
      `rpi4001.${contract.tangBackup.archiveSuffix}`,
    )));
  } finally {
    await fixture.cleanup();
  }
});

test('production entrypoints reject fixture injection', async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [productionController, 'plan'], { env: fixture.environment }),
      (error) => {
        assert.deepEqual(JSON.parse(error.stderr), {
          ok: false,
          code: 'P2_STAGE1_FIXTURE_INJECTION_FORBIDDEN',
        });
        return true;
      },
    );
    await assert.rejects(
      execFileAsync(process.execPath, [productionHostCli, 'plan', '--server=rpi4001'], {
        env: {
          ...process.env,
          SEORILABS_P2_STAGE1_FIXTURE_ROOT: join(fixture.remoteRoot, 'rpi4001'),
        },
      }),
      (error) => {
        assert.deepEqual(JSON.parse(error.stderr), {
          ok: false,
          code: 'P2_STAGE1_FIXTURE_INJECTION_FORBIDDEN',
        });
        return true;
      },
    );
  } finally {
    await fixture.cleanup();
  }
});

test('native SSH relay cannot be used as a get-secret interface', async () => {
  await execFileAsync(process.execPath, [relayBuild]);
  const fixture = await createFixture();
  const passwordPath = join(fixture.temporary, 'ssh-password');
  const password = 'FIXTURE_SSH_PASSWORD_MUST_NEVER_APPEAR_91731';
  try {
    await writeFile(passwordPath, `${password}\n`, { mode: 0o600 });
    await chmod(passwordPath, 0o600);
    for (const args of [
      [],
      ['relay', 'rpi4001', passwordPath, '1', 'get-secret'],
      ['relay', 'rpi4001', passwordPath, '0',
        "sudo -S -p '' /bin/cat -- /var/backups/seori-auth/tang-v1/rpi4001.live-evidence.json"],
    ]) {
      await assert.rejects(
        execFileAsync(relay, args, {
          env: {
            PATH: '/usr/bin:/bin',
            SEORILABS_P2_STAGE1_PASSWORD_FILE: passwordPath,
          },
        }),
        (error) => {
          assert.equal(error.code, 126);
          assert.equal(error.stdout, '');
          assert.equal(error.stderr, '');
          assert.doesNotMatch(`${error.stdout}${error.stderr}`, new RegExp(password, 'u'));
          return true;
        },
      );
    }
    const [relaySource, controllerSource, payloadReadback] = await Promise.all([
      readFile('scripts/fleet/native/p2-stage1-ssh-relay.c', 'utf8'),
      readFile('scripts/fleet/provision-p2-stage1.mjs', 'utf8'),
      readFile('scripts/fleet/readback-p2-stage1-relay-payload.sh', 'utf8'),
    ]);
    assert.match(relaySource, /require_empty_privileged_payload/u);
    assert.doesNotMatch(relaySource, /sudo -S -p '' \/bin\/bash -s/u);
    assert.doesNotMatch(relaySource, /sudo -S -p ''.*3<&0/u);
    assert.match(relaySource, /relay-input-\[a-f0-9\]/u);
    assert.match(controllerSource, /P2_STAGE1_PRIVILEGED_INPUT_NOT_SEPARATED/u);
    assert.match(controllerSource, /preparePrivilegedInput/u);
    assert.match(payloadReadback, /EXACT_READBACK/u);
    assert.doesNotMatch(controllerSource, /password.*payload|payload.*password/iu);
  } finally {
    await fixture.cleanup();
  }
});

test('native SSH relay keeps privileged payload out of sudo stdin in prompt and cached modes', async () => {
  const fixture = await createFixture();
  const passwordPath = join(fixture.temporary, 'ssh-password');
  const fakeSsh = join(fixture.temporary, 'fake-ssh');
  const testRelay = join(fixture.temporary, 'relay-under-test');
  const password = 'FIXTURE_SUDO_PASSWORD_CANARY_58291';
  const safeCommand = "sudo -S -p '' /bin/sh -c 'exec /bin/cat -- " +
    "/var/backups/seori-auth/tang-v1/rpi4001.live-evidence.json </dev/null'";
  const runWithInput = (input, mode = 'prompted') => new Promise((resolve, reject) => {
    const child = spawn(testRelay, [
      'relay', 'rpi4001', passwordPath, '1', safeCommand,
    ], {
      env: { PATH: '/usr/bin:/bin', SEORI_TEST_SSH_MODE: mode },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    child.stdin.end(input);
  });
  try {
    await writeFile(passwordPath, `${password}\n`, { mode: 0o600 });
    await chmod(passwordPath, 0o600);
    await writeFile(fakeSsh, `#!/bin/bash
set -euo pipefail
if [[ "\${SEORI_TEST_SSH_MODE:-}" == "cached" ]]; then
  exit 0
fi
count="$(/usr/bin/wc -c | /usr/bin/tr -d ' ')"
printf '{"stdinBytes":%s}\n' "$count"
`, { mode: 0o700 });
    await chmod(fakeSsh, 0o700);
    await execFileAsync('/usr/bin/cc', [
      `-DSSH_PATH="${fakeSsh}"`,
      'scripts/fleet/native/p2-stage1-ssh-relay.c',
      '-o',
      testRelay,
    ]);
    const prompted = await runWithInput(Buffer.alloc(0));
    assert.equal(prompted.status, 0);
    assert.deepEqual(JSON.parse(prompted.stdout), {
      stdinBytes: Buffer.byteLength(password) + 1,
    });
    assert.doesNotMatch(`${prompted.stdout}${prompted.stderr}`, new RegExp(password, 'u'));
    const cached = await runWithInput(Buffer.alloc(0), 'cached');
    assert.equal(cached.status, 0);
    assert.equal(cached.stdout, '');
    assert.equal(cached.stderr, '');
    const rejected = await runWithInput(
      Buffer.from('PRIVILEGED_PAYLOAD_MUST_BE_REJECTED', 'utf8'),
    );
    assert.equal(rejected.status, 126);
    assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}`, new RegExp(password, 'u'));
    assert.doesNotMatch(
      `${rejected.stdout}${rejected.stderr}`,
      /PRIVILEGED_PAYLOAD_MUST_BE_REJECTED/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('source bootstrap remote fixture is exact-SHA and readback-first', async () => {
  const fixture = await createFixture();
  try {
    const sourcePlan = JSON.parse((await runController(
      fixture,
      'source-plan',
      ['--host=rpi5'],
    )).stdout);
    assert.equal(sourcePlan.state, 'DRY_RUN');
    const applied = JSON.parse((await runController(fixture, 'bootstrap-source', [
      '--host=rpi5',
      `--confirmation=${sourcePlan.confirmation}`,
    ])).stdout);
    assert.equal(applied.state, 'P2_STAGE1_SOURCE_READY');
    assert.equal(applied.sourceSha, sourcePlan.sourceSha);
    assert.equal(applied.archiveSha256, sourcePlan.archiveSha256);
    const commands = await readFile(fixture.log, 'utf8');
    assert.match(commands, /\/usr\/bin\/dd of=\/var\/tmp\/seorilabs-fleet-p2/u);
    assert.doesNotMatch(commands, new RegExp(secretCanary, 'u'));
  } finally {
    await fixture.cleanup();
  }
});

test('local hardening bootstrap is current-user, crash-recoverable, exact, and outside credential backup', {
  timeout: 240_000,
}, async () => {
  const fixture = await createLocalBootstrapFixture();
  try {
    const plan = await localBootstrapPlan(fixture);
    assert.equal(plan.state, 'DRY_RUN');
    assert.equal(plan.secretExposed, false);
    assert.match(plan.targets.runtime, /\.local\/share\/seorilabs\/fleet-p2\/[a-f0-9]{40}$/u);
    assert.equal(plan.targets.runtime.startsWith(fixture.credentialRoot), false);
    const arguments_ = localBootstrapApplyArguments(plan);
    await assert.rejects(
      execFileAsync(process.execPath, [localBootstrap, ...arguments_], {
        env: {
          ...fixture.environment,
          SEORILABS_P2_STAGE1_FIXTURE_LOCAL_CRASH: 'after-runtime-file',
        },
        maxBuffer: 8 * 1024 * 1024,
      }),
      (error) => error.code === 86,
    );
    const recovered = JSON.parse((await execFileAsync(
      process.execPath,
      [localBootstrap, ...arguments_],
      { env: fixture.environment, maxBuffer: 8 * 1024 * 1024 },
    )).stdout);
    assert.equal(recovered.state, 'P2_STAGE1_LOCAL_PROCESS_BOUNDARY_READY');
    assert.equal(recovered.secretExposed, false);
    assert.ok(recovered.runtimeFileCount > 1);
    const sourceReceipt = JSON.parse(await readFile(join(
      fixture.home,
      contract.localProcessBoundary.runtimeRootRelativePath,
      plan.sourceSha,
      contract.localProcessBoundary.sourceReceiptLeaf,
    ), 'utf8'));
    assert.deepEqual(Object.keys(sourceReceipt).toSorted(), [
      'archiveSha256', 'contractDigest', 'controllerRelativePath', 'controllerSha256',
      'packageLockSha256', 'runtimeFileCount', 'runtimeManifestSha256', 'schemaVersion',
      'secretExposed', 'sourceRepository', 'sourceSha', 'state',
    ].toSorted());
    const exact = JSON.parse((await execFileAsync(
      process.execPath,
      [localBootstrap, ...arguments_],
      { env: fixture.environment, maxBuffer: 8 * 1024 * 1024 },
    )).stdout);
    assert.equal(exact.launcherState, 'EXACT_READBACK');
    assert.equal(exact.moduleState, 'EXACT_READBACK');
    assert.equal(exact.sourceReceiptState, 'EXACT_READBACK');
    const configNames = await readFile(
      join(fixture.credentialRoot, contract.localProcessBoundary.receiptRelativePath),
      'utf8',
    );
    assert.doesNotMatch(configNames, /PRIVATE KEY|node_modules/u);
    await assert.rejects(lstat(join(fixture.credentialRoot, 'runtime')));
    await lstat(join(
      fixture.home,
      contract.localProcessBoundary.runtimeRootRelativePath,
      plan.sourceSha,
      'node_modules',
    ));
  } finally {
    await fixture.cleanup();
  }
});

test('local hardening bootstrap rejects drift, symlink targets, and production fixture injection', {
  timeout: 240_000,
}, async () => {
  const fixture = await createLocalBootstrapFixture();
  try {
    const plan = await localBootstrapPlan(fixture);
    const arguments_ = localBootstrapApplyArguments(plan);
    const installed = JSON.parse((await execFileAsync(
      process.execPath,
      [localBootstrap, ...arguments_],
      { env: fixture.environment, maxBuffer: 8 * 1024 * 1024 },
    )).stdout);
    assert.equal(installed.secretExposed, false);
    await chmod(join(
      fixture.credentialRoot,
      contract.localProcessBoundary.launcherRelativePath,
    ), 0o700);
    await assert.rejects(
      execFileAsync(process.execPath, [localBootstrap, ...arguments_], {
        env: fixture.environment,
        maxBuffer: 8 * 1024 * 1024,
      }),
      (error) => {
        assert.equal(JSON.parse(error.stderr).code, 'P2_STAGE1_LOCAL_TARGET_DRIFT');
        return true;
      },
    );
    await assert.rejects(
      execFileAsync(process.execPath, [productionLocalBootstrap, 'plan'], {
        env: fixture.environment,
      }),
      (error) => {
        assert.deepEqual(JSON.parse(error.stderr), {
          ok: false,
          code: 'P2_STAGE1_FIXTURE_INJECTION_FORBIDDEN',
        });
        return true;
      },
    );
  } finally {
    await fixture.cleanup();
  }

  const symlinkFixture = await createLocalBootstrapFixture();
  const outside = join(symlinkFixture.temporary, 'outside-bin');
  try {
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(symlinkFixture.credentialRoot, 'bin'));
    const plan = await localBootstrapPlan(symlinkFixture);
    await assert.rejects(
      execFileAsync(process.execPath, [
        localBootstrap,
        ...localBootstrapApplyArguments(plan),
      ], { env: symlinkFixture.environment, maxBuffer: 8 * 1024 * 1024 }),
      (error) => {
        assert.equal(JSON.parse(error.stderr).code, 'P2_STAGE1_LOCAL_DIRECTORY_INVALID');
        return true;
      },
    );
  } finally {
    await symlinkFixture.cleanup();
  }
});
