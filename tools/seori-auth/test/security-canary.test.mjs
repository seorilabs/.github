import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  BrowserLoginBoundary,
  DurableAuthState,
  EncryptedBrowserVault,
  PolicyEngine,
  SeoriAuthBroker,
} from '../src/index.mjs';
import { makePolicy, makeRequest } from '../fixtures/helpers.mjs';

const fixture = fileURLToPath(new URL('../fixtures/echo-secret-child.mjs', import.meta.url));

function identity() {
  return {
    provider: 'apps-in-toss',
    accountId: 'fake-automation-account',
    teamId: 'seorilabs-team',
    workspaceId: 'fake-workspace',
    appId: 'fake-app',
  };
}

function executionBinding() {
  return {
    subject: 'k8s:release-workers:worker-a',
    runId: 'github:123',
    repository: 'seorilabs/example-app',
    workerId: 'worker-a',
  };
}

function assertNoCanaries(surface, value, canaries) {
  const serialized = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  for (const canary of canaries) {
    for (const representation of [
      canary,
      Buffer.from(canary).toString('base64'),
      Buffer.from(canary).toString('hex'),
    ]) {
      assert.equal(
        serialized.includes(representation),
        false,
        `${surface} exposed a canary representation`,
      );
    }
  }
}

async function directoryBytes(directory) {
  const values = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else values.push(await readFile(child));
    }
  }
  await visit(directory);
  return Buffer.concat(values);
}

test('deterministic canaries never cross prompt, output, argv, env, journal, log, trace, screenshot, or artifact surfaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seori-auth-canary-'));
  const stateDirectory = join(root, 'state');
  const profileSource = join(root, 'profile-source');
  const vaultDirectory = join(root, 'vault');
  const runtimeDirectory = join(root, 'runtime');
  const capturePath = join(root, 'argv-env.json');
  const artifactPath = join(root, 'artifact.json');
  const passwordCanary = 'FAKE_PASSWORD_CANARY_7f8c2a';
  const totpCanary = '73194628';
  const cookieCanary = 'FAKE_COOKIE_CANARY_d1e4b9';
  const canaries = [passwordCanary, totpCanary, cookieCanary];
  const journalMacKey = Buffer.alloc(32, 0x61);
  const vaultKey = Buffer.alloc(32, 0x72);
  let state;
  let vault;
  try {
    const audit = [];
    const request = makeRequest();
    const executionPassword = Buffer.from(passwordCanary);
    const broker = new SeoriAuthBroker({
      policy: makePolicy(),
      adapters: [{
        id: 'test-adapter',
        executable: process.execPath,
        providers: ['apps-in-toss'],
        capabilities: ['ait.bundle.upload.private'],
        credentialDelivery: 'fd3',
        environment: { TEST_CAPTURE_FILE: capturePath },
        buildArgs: () => [fixture],
      }],
      loadSecret: async () => executionPassword,
      onAudit: (event) => audit.push(event),
    });
    const lease = broker.issueLease(request);
    const execution = await broker.execute({
      leaseId: lease.leaseId,
      context: request,
      currentCredentialGeneration: request.credentialGeneration,
    });
    assert.deepEqual(Object.keys(execution).sort(), ['exitCode', 'signal']);
    assert.equal(Object.hasOwn(execution, 'stdout'), false);
    assert.equal(Object.hasOwn(execution, 'stderr'), false);
    assert.ok(executionPassword.every((byte) => byte === 0));

    let nextId = 0;
    state = await DurableAuthState.open({
      directory: stateDirectory,
      journalMacKey,
      requireIntegrity: true,
      idFactory: () => `canary-public-${++nextId}`,
    });
    await state.issueCredentialCheckout({
      authorized: new PolicyEngine(makePolicy()).authorize(request),
      workerId: 'worker-a',
      currentCredentialGeneration: request.credentialGeneration,
      currentPolicyGeneration: request.policyGeneration,
    });

    const browserTrace = [];
    const loginPassword = Buffer.from(passwordCanary);
    const loginTotp = Buffer.from(totpCanary);
    const login = new BrowserLoginBoundary({
      passwordLoader: { async loadPassword() { return loginPassword; } },
      totpSigner: {
        async signCode() {
          return { code: loginTotp, expiresAt: 1_700_000_020_000 };
        },
      },
      clock: () => 1_700_000_000_000,
    });
    const stages = {
      before_password: { authenticated: false, challenge: null },
      after_password: { authenticated: false, challenge: 'totp_required' },
      after_totp: { authenticated: true, challenge: null },
    };
    const loginResult = await login.authenticate({
      browser: {
        async securityControls() {
          return {
            allowedNetworkOrigins: ['https://business.toss.im', 'https://accounts.toss.im'],
            clipboard: false,
            downloads: false,
            extensions: false,
            har: false,
            profilePathExposed: false,
            screenshots: false,
            storageStateExport: false,
            traces: false,
            video: false,
          };
        },
        async inspect({ stage }) {
          browserTrace.push({ event: 'identity_readback', stage });
          return {
            origin: 'https://business.toss.im',
            redirectOrigins: ['https://accounts.toss.im'],
            publicIdentity: identity(),
            ...stages[stage],
          };
        },
        async injectPassword(value) {
          assert.equal(value.toString('utf8'), passwordCanary);
          browserTrace.push({ event: 'password_injected' });
        },
        async injectTotp(value) {
          assert.equal(value.toString('ascii'), totpCanary);
          browserTrace.push({ event: 'totp_injected' });
        },
      },
      passwordRef: 'shared/apps-in-toss/bot-password',
      passwordGeneration: 1,
      totpRef: 'shared/apps-in-toss/bot-totp',
      totpGeneration: 1,
      accountKind: 'dedicated_bot',
      expectedOrigin: 'https://business.toss.im',
      expectedRedirectOrigins: ['https://accounts.toss.im'],
      expectedIdentity: identity(),
      authFactors: ['password', 'totp'],
    });
    assert.ok(loginPassword.every((byte) => byte === 0));
    assert.ok(loginTotp.every((byte) => byte === 0));

    await mkdir(profileSource, { mode: 0o700 });
    await writeFile(join(profileSource, 'Cookies'), cookieCanary, { mode: 0o600 });
    vault = await EncryptedBrowserVault.open({
      vaultDirectory,
      runtimeDirectory,
      encryptionKey: vaultKey,
      idFactory: () => 'canary-browser-capability',
    });
    await vault.registerProfile({ sourceDirectory: profileSource, role: 'release', publicIdentity: identity() });
    const browserCheckout = await vault.checkout({
      role: 'release',
      expectedIdentity: identity(),
      expectedGeneration: 1,
      executionBinding: executionBinding(),
      sourceSha: request.commitSha,
    });
    await vault.withClone({
      capabilityId: browserCheckout.capabilityId,
      executionBinding: executionBinding(),
      sourceSha: request.commitSha,
    }, async (path) => {
      assert.equal(await readFile(join(path, 'Cookies'), 'utf8'), cookieCanary);
      browserTrace.push({ event: 'isolated_profile_consumed' });
    });
    const browserComplete = await vault.complete({
      capabilityId: browserCheckout.capabilityId,
      executionBinding: executionBinding(),
      sourceSha: request.commitSha,
      observedIdentity: identity(),
      persist: false,
    });

    const artifact = { sha256: request.artifact.sha256, sizeBytes: request.artifact.sizeBytes };
    await writeFile(artifactPath, JSON.stringify(artifact), { mode: 0o600 });
    const prompt = JSON.stringify({
      objective: 'execute one approved fake-account canary',
      leaseRequest: request,
    });
    const surfaces = {
      prompt,
      toolOutput: JSON.stringify({ execution, loginResult, browserCheckout, browserComplete }),
      argvAndEnvironment: await readFile(capturePath, 'utf8'),
      journal: await readFile(join(stateDirectory, 'auth-journal.jsonl'), 'utf8'),
      log: JSON.stringify(audit),
      trace: JSON.stringify(browserTrace),
      screenshotAndCapturePolicy: JSON.stringify({ screenshots: false, video: false, har: false, traces: false }),
      artifact: await readFile(artifactPath, 'utf8'),
      encryptedVault: await directoryBytes(vaultDirectory),
    };
    for (const [surface, value] of Object.entries(surfaces)) {
      assertNoCanaries(surface, value, canaries);
    }
  } finally {
    if (vault) await vault.close();
    if (state) await state.close();
    journalMacKey.fill(0);
    vaultKey.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});
