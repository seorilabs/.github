import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  GoogleSecretManagerExecutionStore,
  GoogleWorkloadIdentityTokenProvider,
  MtlsRunAttestor,
  NativeSecretManagerExecutionStore,
  SecretManagerTotpSigner,
  SeoriAuthError,
} from '../src/index.mjs';
import { openDurableAuthState } from '../fixtures/helpers.mjs';

const execFileAsync = promisify(execFile);
const nativeHelper = fileURLToPath(new URL('../.build/seori-auth-native', import.meta.url));
const runtimeEntrypoint = fileURLToPath(new URL('../runtime/entrypoint.mjs', import.meta.url));
const domain = 'seori-run-attestation-v1\n';

function fakeTlsSocket(spiffeId) {
  return {
    encrypted: true,
    authorized: true,
    getPeerCertificate() {
      return { subjectaltname: `URI:${spiffeId}` };
    },
  };
}

function signedAttestation(privateKey, payload) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(`${domain}${encoded}`, 'utf8'), privateKey).toString('base64url');
  return `${encoded}.${signature}`;
}

function crc32c(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  }
  return String((crc ^ 0xffffffff) >>> 0);
}

test('mTLS run attestation exact-binds the client SPIFFE id and durable nonce CAS survives restart', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  let now = 1_700_000_000_000;
  const spiffeId = 'spiffe://seorilabs.local/ns/release-workers/sa/seori-worker';
  const directory = await mkdtemp(join(tmpdir(), 'seori-auth-attestation-state-'));
  const journalMacKey = Buffer.alloc(32, 6);
  let state = await openDurableAuthState({
    directory,
    journalMacKey,
    requireIntegrity: true,
    clock: () => now,
  });
  const attestor = () => new MtlsRunAttestor({
    publicKey,
    allowedClientSpiffeIds: [spiffeId],
    nonceStore: state,
    clock: () => now,
  });
  const token = signedAttestation(privateKey, {
    version: 1,
    clientSpiffeId: spiffeId,
    issuedAt: now - 1_000,
    expiresAt: now + 60_000,
    nonce: 'runtime-attestation-0001',
    subject: 'k8s:release-workers:worker-a',
    runId: 'github:123',
    repository: 'seorilabs/example-app',
    workerId: 'worker-a',
  });
  try {
    const concurrent = await Promise.allSettled([
      attestor().authenticate(fakeTlsSocket(spiffeId), { runAttestation: token }),
      attestor().authenticate(fakeTlsSocket(spiffeId), { runAttestation: token }),
    ]);
    const succeeded = concurrent.filter(({ status }) => status === 'fulfilled');
    const denied = concurrent.filter(({ status }) => status === 'rejected');
    assert.equal(succeeded.length, 1);
    assert.deepEqual(succeeded[0].value, {
      subject: 'k8s:release-workers:worker-a',
      runId: 'github:123',
      repository: 'seorilabs/example-app',
      workerId: 'worker-a',
    });
    assert.equal(denied.length, 1);
    assert.equal(denied[0].reason instanceof SeoriAuthError, true);
    assert.equal(denied[0].reason.code, 'principal_unauthenticated');
    assert.equal(state.snapshot().attestationNonces.length, 1);
    assert.equal(
      state.snapshot().auditEvents.filter(({ eventType }) => eventType === 'RUN_ATTESTATION_CONSUMED').length,
      1,
    );

    await assert.rejects(
      attestor().authenticate(fakeTlsSocket('spiffe://seorilabs.local/ns/other/sa/seori-worker'), {
        runAttestation: signedAttestation(privateKey, {
          version: 1,
          clientSpiffeId: spiffeId,
          issuedAt: now,
          expiresAt: now + 1_000,
          nonce: 'runtime-attestation-0002',
          subject: 'k8s:release-workers:worker-a',
          runId: 'github:123',
          repository: 'seorilabs/example-app',
          workerId: 'worker-a',
        }),
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'principal_unauthenticated',
    );

    await state.close();
    state = undefined;
    state = await openDurableAuthState({
      directory,
      journalMacKey,
      requireIntegrity: true,
      clock: () => now,
    });
    await assert.rejects(
      attestor().authenticate(fakeTlsSocket(spiffeId), { runAttestation: token }),
      (error) => error instanceof SeoriAuthError && error.code === 'principal_unauthenticated',
    );

    now += 61_000;
    const renewedToken = signedAttestation(privateKey, {
      version: 1,
      clientSpiffeId: spiffeId,
      issuedAt: now,
      expiresAt: now + 60_000,
      nonce: 'runtime-attestation-0001',
      subject: 'k8s:release-workers:worker-a',
      runId: 'github:123',
      repository: 'seorilabs/example-app',
      workerId: 'worker-a',
    });
    assert.deepEqual(
      await attestor().authenticate(fakeTlsSocket(spiffeId), { runAttestation: renewedToken }),
      succeeded[0].value,
    );
    assert.equal(state.snapshot().attestationNonces.length, 1);
    assert.equal(
      state.snapshot().auditEvents.filter(({ eventType }) => eventType === 'RUN_ATTESTATION_CONSUMED').length,
      2,
    );
  } finally {
    await state?.close();
    journalMacKey.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});

test('Secret Manager TOTP signer matches RFC 6238 without exposing the seed', async () => {
  const source = Buffer.from('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'ascii');
  const signer = new SecretManagerTotpSigner({
    bindings: [{
      credentialRef: 'shared/apps-in-toss/bot-totp',
      credentialGeneration: 2,
      factor: 'totp',
      provider: 'apps-in-toss',
      accountId: 'automation-account',
      origins: ['https://business.toss.im'],
      algorithm: 'sha1',
      digits: 8,
      periodSeconds: 30,
    }],
    loadSecret: async () => source,
    clock: () => 59_000,
  });
  const signed = await signer.signCode({
    credentialRef: 'shared/apps-in-toss/bot-totp',
    credentialGeneration: 2,
    provider: 'apps-in-toss',
    accountId: 'automation-account',
    origin: 'https://business.toss.im',
  });
  assert.equal(signed.code.toString('ascii'), '94287082');
  assert.equal(signed.expiresAt, 60_000);
  assert.ok(source.every((byte) => byte === 0));
  assert.equal('seed' in signer, false);
  signed.code.fill(0);
});

test('Google workload identity store pins numeric versions and verifies CRC32C', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seori-auth-wif-'));
  const tokenPath = join(root, 'token');
  await writeFile(tokenPath, 'headerheader.payloadpayload.signaturesignature\n', { mode: 0o400 });
  await chmod(tokenPath, 0o400);
  const secret = Buffer.from('fake-execution-copy');
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://sts.googleapis.com/v1/token') {
      return new Response(JSON.stringify({ access_token: 'fake-access-token-value', expires_in: 900 }), { status: 200 });
    }
    return new Response(JSON.stringify({
      payload: { data: secret.toString('base64'), dataCrc32c: crc32c(secret) },
    }), { status: 200 });
  };
  const tokenProvider = new GoogleWorkloadIdentityTokenProvider({
    subjectTokenFile: await realpath(tokenPath),
    audience: '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/seorilabs/providers/microk8s',
    fetchImpl,
    clock: () => 1_700_000_000_000,
  });
  const store = new GoogleSecretManagerExecutionStore({
    bindings: [{
      credentialRef: 'shared/apps-in-toss/operator',
      credentialGeneration: 3,
      resourceName: 'projects/seorilabs-ci/secrets/apps-in-toss-operator/versions/9',
    }],
    tokenProvider,
    fetchImpl,
  });
  const executionCopy = await store.loadSecret({
    credentialRef: 'shared/apps-in-toss/operator',
    credentialGeneration: 3,
  });
  assert.equal(executionCopy.toString('utf8'), 'fake-execution-copy');
  assert.equal(store.generation('shared/apps-in-toss/operator'), 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://secretmanager.googleapis.com/v1/projects/seorilabs-ci/secrets/apps-in-toss-operator/versions/9:access');
  assert.match(calls[1].options.headers.authorization, /^Bearer /);
  executionCopy.fill(0);
  secret.fill(0);
});

test('projected workload token rejects group write or execute while allowing group read policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seori-auth-wif-permissions-'));
  const tokenPath = join(root, 'token');
  await writeFile(tokenPath, 'headerheader.payloadpayload.signaturesignature\n', { mode: 0o400 });
  const canonicalTokenPath = await realpath(tokenPath);
  const provider = () => new GoogleWorkloadIdentityTokenProvider({
    subjectTokenFile: canonicalTokenPath,
    audience: '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/seorilabs/providers/microk8s',
    fetchImpl: async () => assert.fail('unsafe projected token must fail before network access'),
  });
  for (const mode of [0o460, 0o450]) {
    await chmod(tokenPath, mode);
    await assert.rejects(
      provider().accessToken(),
      (error) => error instanceof SeoriAuthError && error.code === 'workload_identity_unavailable',
    );
  }
});

test('native Secret Manager store accepts only its pre-bound logical id and numeric resource', async () => {
  const calls = [];
  const store = new NativeSecretManagerExecutionStore({
    bindings: [{
      credentialRef: 'shared/apps-in-toss/operator',
      credentialGeneration: 8,
      resourceName: 'projects/seorilabs-ci/secrets/apps-in-toss-operator/versions/12',
    }],
    accessor: {
      async accessVersion(input) {
        calls.push(input);
        return Buffer.from('fake-native-execution-copy');
      },
    },
  });
  const copy = await store.loadSecret({
    credentialRef: 'shared/apps-in-toss/operator',
    credentialGeneration: 8,
  });
  assert.equal(copy.toString('utf8'), 'fake-native-execution-copy');
  assert.deepEqual(calls, [{
    resourceName: 'projects/seorilabs-ci/secrets/apps-in-toss-operator/versions/12',
  }]);
  assert.throws(
    () => store.loadSecret({ credentialRef: 'shared/apps-in-toss/operator', credentialGeneration: 9 }),
    (error) => error instanceof SeoriAuthError && error.code === 'secret_load_failed',
  );
  copy.fill(0);
});

test('container entrypoint canary covers Vault, TOTP, and human stop gate while returning only public state', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    runtimeEntrypoint,
    'canary',
    `--native-helper=${nativeHelper}`,
  ]);
  assert.deepEqual(JSON.parse(stdout), { state: 'CANARY_OK', secretExposed: false });
  assert.equal(stderr, '');
});
