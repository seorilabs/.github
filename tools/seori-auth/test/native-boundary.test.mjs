import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  NativeSecurityBoundary,
  SeoriAuthBroker,
  SeoriAuthError,
} from '../src/index.mjs';
import { makePolicy, makeRequest } from '../fixtures/helpers.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const helper = join(packageRoot, '.build', 'seori-auth-native');
const fixture = fileURLToPath(new URL('../fixtures/echo-secret-child.mjs', import.meta.url));
const writerFixture = fileURLToPath(
  new URL('../fixtures/secret-manager-writer-fake-sink.mjs', import.meta.url),
);

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function principal() {
  return {
    subject: 'k8s:release-workers:worker-a',
    runId: 'github:123',
    repository: 'seorilabs/example-app',
    workerId: 'worker-a',
  };
}

test('native helper disables core dumps and debugger attachment', () => {
  const result = spawnSync(helper, ['self-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.coreSoft, 0);
  assert.equal(state.coreHard, 0);
  if (process.platform === 'darwin') assert.equal(state.denyAttach, true);
  if (process.platform === 'linux') assert.equal(state.dumpable, 0);
});

test('native Unix attestor derives UID/GID/PID from the accepted socket, not HTTP claims', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seori-native-attestor-'));
  const socketPath = join(root, 'broker.sock');
  const digest = createHash('sha256').update(await readFile(helper)).digest('hex');
  const boundary = await NativeSecurityBoundary.open({
    helperPath: helper,
    expectedSha256: digest,
    resolvePrincipal: async (peer) => {
      assert.equal(peer.uid, process.getuid());
      assert.equal(peer.gid, process.getgid());
      assert.ok(peer.pid > 0);
      return principal();
    },
  });
  let client;
  let server;
  try {
    const attested = new Promise((resolve, reject) => {
      server = createServer((socket) => boundary.authenticatePrincipal(socket).then(resolve, reject));
      server.once('error', reject);
    });
    await new Promise((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));
    client = createConnection(socketPath);
    await new Promise((resolve, reject) => client.once('connect', resolve).once('error', reject));
    assert.deepEqual(await attested, principal());
  } finally {
    client?.destroy();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }

  await assert.rejects(
    NativeSecurityBoundary.open({
      helperPath: helper,
      expectedSha256: '0'.repeat(64),
      resolvePrincipal: async () => principal(),
    }),
    (error) => error instanceof SeoriAuthError && error.code === 'native_helper_mismatch',
  );
});

test('native Unix attestor rejects a peer outside the approved OS identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seori-native-denied-peer-'));
  const socketPath = join(root, 'broker.sock');
  const boundary = await NativeSecurityBoundary.open({
    helperPath: helper,
    expectedUid: process.getuid() + 1,
    expectedGid: process.getgid(),
    resolvePrincipal: async () => {
      throw new Error('resolver must not run for denied UID');
    },
  });
  let client;
  let server;
  try {
    const denied = new Promise((resolve, reject) => {
      server = createServer((socket) => boundary.authenticatePrincipal(socket).then(resolve, reject));
      server.once('error', reject);
    });
    await new Promise((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));
    client = createConnection(socketPath);
    await new Promise((resolve, reject) => client.once('connect', resolve).once('error', reject));
    await assert.rejects(
      denied,
      (error) => error instanceof SeoriAuthError && error.code === 'peer_identity_mismatch',
    );
  } finally {
    client?.destroy();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('trusted adapter runs behind native non-dumpable launcher without secret argv/env exposure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seori-native-launcher-'));
  const capture = join(root, 'capture.json');
  const digest = createHash('sha256').update(await readFile(helper)).digest('hex');
  const boundary = await NativeSecurityBoundary.open({
    helperPath: helper,
    expectedSha256: digest,
    resolvePrincipal: async () => principal(),
  });
  const canary = 'native-launcher-fake-canary';
  const secret = Buffer.from(canary);
  try {
    const request = makeRequest();
    const broker = new SeoriAuthBroker({
      policy: makePolicy(),
      adapters: [{
        id: 'test-adapter',
        executable: process.execPath,
        providers: ['apps-in-toss'],
        capabilities: ['ait.bundle.upload.private'],
        credentialDelivery: 'fd3',
        environment: { TEST_CAPTURE_FILE: capture },
        launcher: boundary.launcher(),
        buildArgs: () => [fixture],
      }],
      loadSecret: async () => secret,
    });
    const lease = broker.issueLease(request, { idempotencyKey: 'native-boundary' });
    const result = await broker.execute({
      leaseId: lease.leaseId,
      context: request,
      currentCredentialGeneration: request.credentialGeneration,
    });
    assert.equal(result.exitCode, 0);
    const captured = await readFile(capture, 'utf8');
    assert.doesNotMatch(captured, new RegExp(canary));
    assert.doesNotMatch(captured, new RegExp(Buffer.from(canary).toString('base64')));
    assert.ok(secret.every((byte) => byte === 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Secret Manager writer exposes only a strict public result and verifies fake backup restore', async () => {
  const [helperSha256, executableSha256, childSha256] = await Promise.all([
    sha256(helper),
    sha256(process.execPath),
    sha256(writerFixture),
  ]);
  const boundary = await NativeSecurityBoundary.open({
    helperPath: helper,
    expectedSha256: helperSha256,
    resolvePrincipal: async () => principal(),
  });
  const writer = await boundary.secretManagerWriter({
    executablePath: process.execPath,
    executableSha256,
    childPath: writerFixture,
    childSha256,
  });
  assert.deepEqual(writer.identity, {
    mode: 'native-secret-manager-writer-v1',
    executablePath: process.execPath,
    executableSha256,
    childPath: writerFixture,
    childSha256,
  });

  const material = Buffer.from(`FAKE_WRITER_CANARY_${randomBytes(24).toString('hex')}`);
  const representations = [
    material.toString('utf8'),
    material.toString('base64'),
    material.toString('hex'),
  ];
  const result = await writer.writeVersion({
    resourceName: 'projects/seori-auth-canary/secrets/fake-writer',
    expectedVersion: 1,
    material,
  });
  assert.deepEqual(Object.keys(result).sort(), [
    'backupRestoreVerified',
    'dataCrc32c',
    'operation',
    'resourceName',
    'schemaVersion',
    'secretExposed',
    'versionResourceName',
  ]);
  assert.equal(result.backupRestoreVerified, true);
  assert.equal(result.secretExposed, false);
  assert.match(result.dataCrc32c, /^[0-9]+$/);
  assert.equal(
    result.versionResourceName,
    'projects/seori-auth-canary/secrets/fake-writer/versions/1',
  );
  const publicResult = JSON.stringify(result);
  for (const representation of representations) {
    assert.equal(publicResult.includes(representation), false);
  }
  assert.ok(material.every((byte) => byte === 0));

  const firstMaterial = randomBytes(32);
  const duplicateMaterial = randomBytes(32);
  const firstWrite = writer.writeVersion({
    resourceName: 'projects/seori-auth-canary/secrets/fake-concurrent-writer',
    expectedVersion: 1,
    material: firstMaterial,
  });
  await assert.rejects(
    writer.writeVersion({
      resourceName: 'projects/seori-auth-canary/secrets/fake-concurrent-writer',
      expectedVersion: 1,
      material: duplicateMaterial,
    }),
    (error) => error instanceof SeoriAuthError &&
      error.code === 'secret_write_failed' &&
      error.message === 'duplicate concurrent Secret Manager write is forbidden',
  );
  await firstWrite;
  assert.ok(firstMaterial.every((byte) => byte === 0));
  assert.ok(duplicateMaterial.every((byte) => byte === 0));

  const unexpectedResultMaterial = randomBytes(32);
  await assert.rejects(
    writer.writeVersion({
      resourceName: 'projects/seori-auth-canary/secrets/fake-unexpected-result',
      expectedVersion: 1,
      material: unexpectedResultMaterial,
    }),
    (error) => error instanceof SeoriAuthError &&
      error.code === 'secret_write_failed' &&
      error.message === 'trusted Secret Manager writer returned an invalid public result',
  );
  assert.ok(unexpectedResultMaterial.every((byte) => byte === 0));

  const checksumMismatchMaterial = randomBytes(32);
  await assert.rejects(
    writer.writeVersion({
      resourceName: 'projects/seori-auth-canary/secrets/fake-checksum-mismatch',
      expectedVersion: 1,
      material: checksumMismatchMaterial,
    }),
    (error) => error instanceof SeoriAuthError &&
      error.code === 'secret_write_failed' &&
      error.message === 'trusted Secret Manager writer returned an invalid public result',
  );
  assert.ok(checksumMismatchMaterial.every((byte) => byte === 0));

  await assert.rejects(
    boundary.secretManagerWriter({
      executablePath: process.execPath,
      executableSha256,
      childPath: writerFixture,
      childSha256: '0'.repeat(64),
    }),
    (error) => error instanceof SeoriAuthError && error.code === 'native_helper_mismatch',
  );
});
