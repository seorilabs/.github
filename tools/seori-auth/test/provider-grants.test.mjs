import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  executeConsumedProviderLease,
  LocalAuthDaemon,
  normalizeProviderGrantExpectation,
  normalizeProviderGrantRegistration,
  providerGrantLeaseRequest,
  publicJsonDigest,
  SeoriAuthError,
  TrustedAdapterRegistry,
} from '../src/index.mjs';
import {
  makeNativeBrowserAdapter,
  makeNativeLauncher,
  makePolicy,
  openDurableAuthState,
} from '../fixtures/helpers.mjs';

const adapterFixture = fileURLToPath(new URL('../fixtures/provider-adapter-child.mjs', import.meta.url));
const sourceSha = '1'.repeat(40);
const artifactChecksum = 'a'.repeat(64);
const bindingHash = 'b'.repeat(64);
const subject = 'k8s:platform:provider-execution-worker';
const executionBinding = Object.freeze({
  subject,
  runId: 'provider-execution-1',
  repository: 'seorilabs/example-app',
  workerId: 'provider-worker-a',
});

function providerCommand(now = Date.now(), overrides = {}) {
  const desired = overrides.desired ?? {
    market: 'apps-in-toss',
    publicAppId: 'example-app',
    releaseChannel: 'private',
  };
  return {
    schemaVersion: 1,
    executionId: executionBinding.runId,
    generation: 1,
    resumeMode: 'START',
    adapterId: 'ait-cli-v1',
    operation: 'UPLOAD_INTERNAL',
    provider: 'apps-in-toss',
    origin: 'https://apps-in-toss-api.toss.im',
    repository: executionBinding.repository,
    repoId: '123',
    sourceSha,
    configRevision: 2,
    desiredHash: publicJsonDigest(desired),
    desired,
    resource: {
      type: 'market-release',
      id: 'example-app',
      environment: 'internal',
      expectedPublicIdentity: 'example-app',
    },
    artifactChecksum,
    credential: {
      logicalId: 'shared/apps-in-toss/operator',
      generation: 3,
      policyGeneration: 7,
      capability: 'ait.bundle.upload.private',
      publicAccountId: 'operator-account',
      publicIdentity: 'apps-in-toss-automation-account',
      authFactors: ['api_key'],
    },
    approval: {
      id: 'provider-preapproval:provider-execution-1:1',
      mode: 'preapproved',
      expiresAt: new Date(now + 240_000).toISOString(),
      maxUses: 1,
    },
    bindingHash,
    ...overrides,
  };
}

function p5CanonicalJson(value) {
  const normalize = (nested) => {
    if (Array.isArray(nested)) return nested.map(normalize);
    if (nested && typeof nested === 'object') {
      return Object.fromEntries(
        Object.entries(nested)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return nested;
  };
  return JSON.stringify(normalize(value));
}

function rawRegistration(now = Date.now(), overrides = {}) {
  const command = providerCommand(now, overrides.command);
  const id = `provider-grant-${command.bindingHash.slice(0, 40)}-${command.generation}`;
  const actionClass = command.operation === 'READBACK'
    ? 'read_only'
    : command.operation === 'UPLOAD_INTERNAL' ? 'internal_upload' : 'other_mutation';
  const grant = {
    schemaVersion: 1,
    id,
    policyGeneration: command.credential.policyGeneration,
    bindingHash: command.bindingHash,
    commandDigest: publicJsonDigest(command),
    expiresAt: command.approval.expiresAt,
    maxUses: 1,
    rule: {
      id,
      enabled: true,
      credentialRefs: [command.credential.logicalId],
      subjects: [subject],
      repositories: [command.repository],
      runIds: [command.executionId],
      commitShas: [command.sourceSha],
      providers: [command.provider],
      origins: [command.origin],
      redirectOrigins: [],
      capabilities: [command.credential.capability],
      resources: [{
        kind: `${command.provider}.${command.resource.type}`,
        id: `binding:${command.bindingHash}`,
        environment: command.resource.environment,
      }],
      adapters: [command.adapterId],
      accountIds: [command.credential.publicAccountId],
      actionClass,
      authStrategies: [command.credential.authFactors],
      requiresArtifact: command.artifactChecksum !== null,
      artifactSha256s: command.artifactChecksum === null ? [] : [command.artifactChecksum],
      allowTotp: command.credential.authFactors.includes('totp'),
      approvals: [command.approval],
    },
    command,
  };
  return {
    idempotencyKey: 'provider-policy-grant:provider-execution-1:1',
    workerId: executionBinding.workerId,
    grant,
    digest: publicJsonDigest(grant),
    ...overrides.registration,
  };
}

function verifyExpectation(registration) {
  return normalizeProviderGrantExpectation({
    workerId: executionBinding.workerId,
    expectedDigest: registration.digest,
    expectedBindingHash: registration.grant.bindingHash,
    expectedCommandDigest: registration.grant.commandDigest,
    expectedPolicyGeneration: registration.grant.policyGeneration,
  });
}

function executionExpectation(registration, idempotencyKey) {
  return normalizeProviderGrantExpectation({
    workerId: executionBinding.workerId,
    expectedDigest: registration.digest,
    expectedBindingHash: registration.grant.bindingHash,
    expectedCommandDigest: registration.grant.commandDigest,
    expectedPolicyGeneration: registration.grant.policyGeneration,
    expectedExecutionGeneration: registration.grant.command.generation,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  }, {
    includeGeneration: true,
    includeIdempotencyKey: idempotencyKey !== undefined,
  });
}

function successResult(command) {
  return {
    schemaVersion: 1,
    outcome: 'SUCCESS',
    observation: {
      kind: 'MARKET',
      payload: {
        schemaVersion: 1,
        market: command.provider,
        publicAccountId: command.credential.publicAccountId,
        publicAppId: command.resource.id,
        gate: 'UPLOAD',
        state: 'SUCCEEDED',
        sourceSha: command.sourceSha,
        configRevision: command.configRevision,
        artifactChecksum: command.artifactChecksum,
        observedAt: new Date().toISOString(),
      },
    },
  };
}

function providerAdapter(launcher, mode = 'success', environment = {}, id = 'ait-cli-v1') {
  return {
    id,
    executable: process.execPath,
    providers: ['apps-in-toss'],
    capabilities: ['ait.bundle.upload.private'],
    credentialDelivery: 'fd3',
    buildArgs: () => [adapterFixture, mode],
    environment,
    launcher,
  };
}

function post(socketPath, path, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const request = httpRequest({
      socketPath,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode,
          body: text.length === 0 ? null : JSON.parse(text),
        });
      });
    });
    request.once('error', reject);
    request.end(payload);
  });
}

function browserVaultStub() {
  return {
    checkout: async () => {},
    withClone: async (_binding, operation) => operation('/trusted/ephemeral-clone'),
    complete: async () => {},
    abort: async () => {},
  };
}

test('P5 provider grant shape is five-minute exact-bound and protected actions require per-run approval', () => {
  const now = Date.now();
  const mixedKeys = { B: 1, a: 2, _x: 3, nested: { z: true, A: false } };
  assert.equal(
    publicJsonDigest(mixedKeys),
    createHash('sha256').update(p5CanonicalJson(mixedKeys)).digest('hex'),
    'digest must use the same recursive localeCompare canonical JSON ordering as the P5 client',
  );
  const raw = rawRegistration(now);
  const normalized = normalizeProviderGrantRegistration(raw, { subject, now });
  assert.equal(normalized.grant.id, raw.grant.id);
  assert.equal(normalized.grant.commandDigest, raw.grant.commandDigest);
  assert.equal(normalized.grant.bindingHash, bindingHash);

  const protectedRaw = rawRegistration(now, {
    command: {
      operation: 'APPLY',
      approval: {
        id: 'provider-approval:provider-execution-1:1',
        mode: 'preapproved',
        expiresAt: new Date(now + 240_000).toISOString(),
        maxUses: 1,
      },
    },
  });
  assert.throws(
    () => normalizeProviderGrantRegistration(protectedRaw, { subject, now }),
    (error) => error instanceof SeoriAuthError && error.code === 'per_run_approval_required',
  );

  const longLived = rawRegistration(now, {
    command: {
      approval: {
        id: 'provider-preapproval:provider-execution-1:1',
        mode: 'preapproved',
        expiresAt: new Date(now + 300_001).toISOString(),
        maxUses: 1,
      },
    },
  });
  assert.throws(
    () => normalizeProviderGrantRegistration(longLived, { subject, now }),
    (error) => error instanceof SeoriAuthError && error.code === 'approval_expired',
  );
});

test('provider command rejects shell surfaces, sensitive desired fields, and binding drift', () => {
  const now = Date.now();
  const withArgv = rawRegistration(now);
  withArgv.grant.command.argv = ['-c', 'printenv'];
  assert.throws(
    () => normalizeProviderGrantRegistration(withArgv, { subject, now }),
    (error) => error instanceof SeoriAuthError && error.code === 'invalid_provider_grant',
  );

  const sensitive = rawRegistration(now, { command: { desired: { password: 'canary-public-field' } } });
  assert.throws(
    () => normalizeProviderGrantRegistration(sensitive, { subject, now }),
    (error) => error instanceof SeoriAuthError && error.code === 'invalid_provider_grant',
  );
  for (const desired of [
    { accessToken: 'not-public' },
    { api_key: 'not-public' },
    { nested: { clientSecretValue: 'not-public' } },
  ]) {
    const secretShaped = rawRegistration(now, { command: { desired } });
    assert.throws(
      () => normalizeProviderGrantRegistration(secretShaped, { subject, now }),
      (error) => error instanceof SeoriAuthError && error.code === 'invalid_provider_grant',
    );
  }

  const drifted = rawRegistration(now);
  drifted.grant.bindingHash = 'c'.repeat(64);
  assert.throws(
    () => normalizeProviderGrantRegistration(drifted, { subject, now }),
    (error) => error instanceof SeoriAuthError && error.code === 'provider_grant_binding_mismatch',
  );
});

test('provider grant is one-use with generation CAS and survives HMAC journal replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seori-provider-grant-state-'));
  const journalMacKey = Buffer.alloc(32, 7);
  const now = Date.now();
  const raw = rawRegistration(now);
  const registration = normalizeProviderGrantRegistration(raw, { subject, now });
  let state = await openDurableAuthState({
    directory,
    journalMacKey,
    requireIntegrity: true,
    clock: () => now,
  });
  try {
    const registered = await state.registerProviderGrant({ registration, executionBinding });
    assert.deepEqual(registered, {
      id: raw.grant.id,
      digest: raw.digest,
      bindingHash,
      commandDigest: raw.grant.commandDigest,
      policyGeneration: 7,
      state: 'ACTIVE',
    });
    assert.deepEqual(
      await state.registerProviderGrant({ registration, executionBinding }),
      registered,
    );
    await state.verifyProviderGrant({
      id: raw.grant.id,
      expectation: verifyExpectation(raw),
      executionBinding,
    });
    const consumeExpectation = executionExpectation(raw, 'provider-consume:provider-execution-1:1');
    const consumed = await state.consumeProviderGrant({
      id: raw.grant.id,
      expectation: consumeExpectation,
      executionBinding,
    });
    assert.equal(consumed.shouldExecute, true);
    assert.equal(consumed.replay, false);
    const replay = await state.consumeProviderGrant({
      id: raw.grant.id,
      expectation: consumeExpectation,
      executionBinding,
    });
    assert.equal(replay.shouldExecute, false);
    assert.equal(replay.replay, true);
    await assert.rejects(
      state.consumeProviderGrant({
        id: raw.grant.id,
        expectation: executionExpectation(raw, 'provider-consume:other'),
        executionBinding,
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'provider_grant_already_used',
    );
    assert.deepEqual(
      (await state.readProviderGrantResult({
        id: raw.grant.id,
        expectation: executionExpectation(raw),
        executionBinding,
      })).execution,
      { generation: 1, outcome: 'RESULT_UNKNOWN' },
    );
    assert.equal(await state.readProviderGrantObservation({
      id: raw.grant.id,
      expectation: executionExpectation(raw),
      executionBinding,
    }), null);
    await state.recordProviderGrantResult({
      id: raw.grant.id,
      executionBinding,
      result: successResult(raw.grant.command),
    });
    assert.equal(
      (await state.readProviderGrantResult({
        id: raw.grant.id,
        expectation: executionExpectation(raw),
        executionBinding,
      })).execution.outcome,
      'SUCCESS',
    );
    const observed = await state.readProviderGrantObservation({
      id: raw.grant.id,
      expectation: executionExpectation(raw),
      executionBinding,
    });
    assert.equal(observed.observation.kind, 'MARKET');
    const audit = state.snapshot().auditEvents;
    assert.ok(audit.some((event) =>
      event.eventType === 'PROVIDER_GRANT_CONSUMED' &&
      event.commitSha === sourceSha &&
      event.capability === raw.grant.command.credential.capability &&
      event.credentialRef === raw.grant.command.credential.logicalId &&
      event.bindingHash === bindingHash));
    assert.doesNotMatch(JSON.stringify(audit), /canary-secret|secret-value/);
    const checkpoint = state.integrityCheckpoint();
    await state.close();
    state = undefined;

    await assert.rejects(
      openDurableAuthState({
        directory,
        journalMacKey: Buffer.alloc(32, 8),
        requireIntegrity: true,
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'invalid_state_journal',
    );
    state = await openDurableAuthState({
      directory,
      journalMacKey,
      requireIntegrity: true,
      expectedJournalHeadMac: checkpoint.headMac,
    });
    assert.equal(state.snapshot().providerGrants[0].state, 'COMPLETED');
  } finally {
    await state?.close();
    journalMacKey.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});

test('provider grant registration refuses a durable journal without HMAC integrity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seori-provider-grant-no-mac-'));
  const now = Date.now();
  const state = await openDurableAuthState({ directory, clock: () => now });
  try {
    const registration = normalizeProviderGrantRegistration(rawRegistration(now), { subject, now });
    await assert.rejects(
      state.registerProviderGrant({ registration, executionBinding }),
      (error) => error instanceof SeoriAuthError && error.code === 'state_integrity_required',
    );
    assert.equal(state.snapshot().providerGrants.length, 0);
  } finally {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('native provider adapter receives secret only on fd3 and returns strict public result on fd5', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seori-provider-adapter-'));
  const capturePath = join(root, 'capture.json');
  const command = providerCommand();
  const secretCanary = 'canary-provider-secret-value';
  const secret = Buffer.from(secretCanary);
  const launcher = await makeNativeLauncher();
  const registry = new TrustedAdapterRegistry([
    providerAdapter(launcher, 'success', { TEST_CAPTURE_FILE: capturePath }),
  ]);
  try {
    const executed = await executeConsumedProviderLease({
      consumed: { binding: providerGrantLeaseRequest(command, subject) },
      registry,
      loadSecret: async () => secret,
      command,
    });
    assert.equal(executed.adapterResult.outcome, 'SUCCESS');
    assert.equal(executed.adapterResult.observation.kind, 'MARKET');
    assert.ok(secret.every((byte) => byte === 0));
    const capture = await readFile(capturePath, 'utf8');
    assert.doesNotMatch(capture, new RegExp(secretCanary));
    assert.doesNotMatch(capture, new RegExp(Buffer.from(secretCanary).toString('base64')));
    assert.doesNotMatch(capture, /--command|--secret|AUTHORIZATION|PASSWORD|TOKEN/);
    assert.equal(JSON.parse(capture).command.bindingHash, bindingHash);

    const leaking = new TrustedAdapterRegistry([providerAdapter(launcher, 'leak-base64')]);
    await assert.rejects(
      executeConsumedProviderLease({
        consumed: { binding: providerGrantLeaseRequest(command, subject) },
        registry: leaking,
        loadSecret: async () => Buffer.from(secretCanary),
        command,
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'adapter_result_secret_detected',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('internal provider routes execute once, preserve exact errors, and expose separate result/observation readback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seori-provider-daemon-'));
  const socketPath = join(root, 'broker.sock');
  const journalMacKey = Buffer.alloc(32, 9);
  const raw = rawRegistration();
  const state = await openDurableAuthState({
    directory: join(root, 'state'),
    journalMacKey,
    requireIntegrity: true,
  });
  const launcher = await makeNativeLauncher();
  let internalPeerAllowed = true;
  let secretLoads = 0;
  const daemon = new LocalAuthDaemon({
    socketPath,
    state,
    policy: makePolicy(),
    adapters: [
      providerAdapter(launcher),
      providerAdapter(launcher, 'invalid', {}, 'ait-cli-invalid-v1'),
    ],
    loadSecret: async () => {
      secretLoads += 1;
      return Buffer.from('daemon-provider-secret-canary');
    },
    getCredentialGeneration: async () => 3,
    readBrowserIdentity: async () => assert.fail('browser identity is outside provider bridge'),
    authenticatePrincipal: async () => executionBinding,
    browserVault: browserVaultStub(),
    browserAdapter: await makeNativeBrowserAdapter({
      execute: async () => assert.fail('browser execution is outside provider bridge'),
    }),
    reconcileBrowserSession: async () => assert.fail('browser reconciliation is outside provider bridge'),
    authorizeInternalPrincipal: async () => {
      if (!internalPeerAllowed) throw new Error('wrong mTLS peer');
    },
  });
  await daemon.start();
  try {
    const publicRoute = await post(socketPath, '/auth/policy-grants', {});
    assert.equal(publicRoute.status, 404);
    assert.deepEqual(publicRoute.body, { error: { code: 'route_not_found' } });

    internalPeerAllowed = false;
    const denied = await post(socketPath, '/internal/control-plane/provider-grants', raw);
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.body, { error: { code: 'principal_unauthenticated' } });
    internalPeerAllowed = true;

    const registered = await post(socketPath, '/internal/control-plane/provider-grants', raw);
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    assert.equal(registered.body.policyGrant.state, 'ACTIVE');
    const verified = await post(
      socketPath,
      `/internal/control-plane/provider-grants/${raw.grant.id}/verify`,
      {
        workerId: executionBinding.workerId,
        expectedDigest: raw.digest,
        expectedBindingHash: raw.grant.bindingHash,
        expectedCommandDigest: raw.grant.commandDigest,
        expectedPolicyGeneration: raw.grant.policyGeneration,
      },
    );
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    const consumeBody = {
      workerId: executionBinding.workerId,
      expectedDigest: raw.digest,
      expectedBindingHash: raw.grant.bindingHash,
      expectedCommandDigest: raw.grant.commandDigest,
      expectedPolicyGeneration: raw.grant.policyGeneration,
      expectedExecutionGeneration: raw.grant.command.generation,
      idempotencyKey: 'provider-consume:provider-execution-1:1',
    };
    const consumed = await post(
      socketPath,
      `/internal/control-plane/provider-grants/${raw.grant.id}/consume`,
      consumeBody,
    );
    assert.equal(consumed.status, 200, JSON.stringify(consumed.body));
    assert.equal(consumed.body.execution.outcome, 'SUCCESS');
    assert.equal(secretLoads, 1);
    const duplicate = await post(
      socketPath,
      `/internal/control-plane/provider-grants/${raw.grant.id}/consume`,
      consumeBody,
    );
    assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.execution.outcome, 'SUCCESS');
    assert.equal(secretLoads, 1, 'same consume idempotency key must never rerun the adapter');

    const readBody = { ...consumeBody };
    delete readBody.idempotencyKey;
    const result = await post(
      socketPath,
      `/internal/control-plane/provider-grants/${raw.grant.id}/result`,
      readBody,
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.execution.outcome, 'SUCCESS');
    const observation = await post(
      socketPath,
      `/internal/control-plane/provider-grants/${raw.grant.id}/observation`,
      readBody,
    );
    assert.equal(observation.status, 200);
    assert.equal(observation.body.observation.kind, 'MARKET');

    const unknownRaw = rawRegistration(Date.now(), {
      command: {
        generation: 2,
        adapterId: 'ait-cli-invalid-v1',
        bindingHash: 'c'.repeat(64),
        approval: {
          id: 'provider-preapproval:provider-execution-1:2',
          mode: 'preapproved',
          expiresAt: new Date(Date.now() + 240_000).toISOString(),
          maxUses: 1,
        },
      },
      registration: {
        idempotencyKey: 'provider-policy-grant:provider-execution-1:2',
      },
    });
    const unknownRegistered = await post(socketPath, '/internal/control-plane/provider-grants', unknownRaw);
    assert.equal(unknownRegistered.status, 201, JSON.stringify(unknownRegistered.body));
    const unknownConsume = {
      workerId: executionBinding.workerId,
      expectedDigest: unknownRaw.digest,
      expectedBindingHash: unknownRaw.grant.bindingHash,
      expectedCommandDigest: unknownRaw.grant.commandDigest,
      expectedPolicyGeneration: unknownRaw.grant.policyGeneration,
      expectedExecutionGeneration: unknownRaw.grant.command.generation,
      idempotencyKey: 'provider-consume:provider-execution-1:2',
    };
    const loadsBeforeUnknown = secretLoads;
    const unknown = await post(
      socketPath,
      `/internal/control-plane/provider-grants/${unknownRaw.grant.id}/consume`,
      unknownConsume,
    );
    assert.equal(unknown.status, 200, JSON.stringify(unknown.body));
    assert.equal(unknown.body.execution.outcome, 'RESULT_UNKNOWN');
    assert.equal(secretLoads, loadsBeforeUnknown + 1);
    const unknownReplay = await post(
      socketPath,
      `/internal/control-plane/provider-grants/${unknownRaw.grant.id}/consume`,
      unknownConsume,
    );
    assert.equal(unknownReplay.status, 200, JSON.stringify(unknownReplay.body));
    assert.equal(unknownReplay.body.execution.outcome, 'RESULT_UNKNOWN');
    assert.equal(secretLoads, loadsBeforeUnknown + 1, 'RESULT_UNKNOWN must never rerun the adapter');
    const unknownReadBody = { ...unknownConsume };
    delete unknownReadBody.idempotencyKey;
    const noObservation = await post(
      socketPath,
      `/internal/control-plane/provider-grants/${unknownRaw.grant.id}/observation`,
      unknownReadBody,
    );
    assert.equal(noObservation.status, 204);
    assert.equal(noObservation.body, null);
    assert.doesNotMatch(JSON.stringify(state.snapshot()), /daemon-provider-secret-canary/);
  } finally {
    await daemon.stop();
    await state.close();
    journalMacKey.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});
