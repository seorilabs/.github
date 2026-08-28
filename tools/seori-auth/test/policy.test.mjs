import assert from 'node:assert/strict';
import test from 'node:test';

import { PolicyEngine, SeoriAuthError, normalizeHttpsOrigin } from '../src/index.mjs';
import { makePolicy, makeRequest } from '../fixtures/helpers.mjs';

test('logical credential references are required', () => {
  const engine = new PolicyEngine(makePolicy());
  assert.throws(
    () => engine.authorize(makeRequest({ credentialRef: '/tmp/plaintext-password' })),
    (error) => error instanceof SeoriAuthError && error.code === 'invalid_credential_ref',
  );
});

test('logical credential reference is an exact policy binding', () => {
  const engine = new PolicyEngine(makePolicy());
  assert.throws(
    () => engine.authorize(makeRequest({ credentialRef: 'shared/apps-in-toss/other-operator' })),
    (error) => error instanceof SeoriAuthError && error.code === 'capability_forbidden',
  );
});

test('invalid logical credential references fail policy validation explicitly', () => {
  assert.throws(
    () => new PolicyEngine(makePolicy({ credentialRefs: ['Shared/apps-in-toss/operator'] })),
    (error) => error instanceof SeoriAuthError && error.code === 'invalid_policy',
  );
});

test('audit-bound identifiers reject control characters', () => {
  const engine = new PolicyEngine(makePolicy());
  assert.throws(
    () => engine.authorize(makeRequest({ runId: 'github:123\nforged-log-entry' })),
    (error) => error instanceof SeoriAuthError && error.code === 'invalid_request',
  );
});

test('forbidden capability has no matching policy rule', () => {
  const engine = new PolicyEngine(makePolicy());
  assert.throws(
    () => engine.authorize(makeRequest({ capability: 'ait.release.public' })),
    (error) => error instanceof SeoriAuthError && error.code === 'capability_forbidden',
  );
});

test('run, repository, commit, provider, resource, and artifact are exact policy bindings', () => {
  const engine = new PolicyEngine(makePolicy());
  const mismatches = [
    { runId: 'github:124' },
    { repository: 'seorilabs/other-app' },
    { commitSha: '2'.repeat(40) },
    { provider: 'google-play' },
    { resource: { kind: 'miniapp', id: 'other-app', environment: 'private' } },
    { artifact: { sha256: 'b'.repeat(64), sizeBytes: 1024 } },
  ];

  for (const mismatch of mismatches) {
    assert.throws(
      () => engine.authorize(makeRequest(mismatch)),
      (error) => error instanceof SeoriAuthError && error.code === 'capability_forbidden',
    );
  }
});

test('lookalike origins and suffix matches are rejected', () => {
  const engine = new PolicyEngine(makePolicy());
  assert.throws(
    () => engine.authorize(makeRequest({ origin: 'https://apps-in-toss-api.toss.im.evil.example' })),
    (error) => error instanceof SeoriAuthError && error.code === 'capability_forbidden',
  );
  assert.throws(
    () => normalizeHttpsOrigin('https://apps-in-toss-api.toss.im/login'),
    (error) => error instanceof SeoriAuthError && error.code === 'invalid_origin',
  );
});

test('every redirect origin must be explicitly allowlisted', () => {
  const engine = new PolicyEngine(makePolicy());
  assert.throws(
    () => engine.authorize(makeRequest({ redirectOrigins: ['https://evil.example'] })),
    (error) => error instanceof SeoriAuthError && error.code === 'capability_forbidden',
  );
});

test('duplicate redirect origins are rejected before policy matching', () => {
  const engine = new PolicyEngine(makePolicy());
  assert.throws(
    () => engine.authorize(makeRequest({
      redirectOrigins: ['https://business.toss.im', 'https://business.toss.im'],
    })),
    (error) => error instanceof SeoriAuthError && error.code === 'invalid_request',
  );
});

test('policy generation is exact', () => {
  const engine = new PolicyEngine(makePolicy());
  assert.throws(
    () => engine.authorize(makeRequest({ policyGeneration: 6 })),
    (error) => error instanceof SeoriAuthError && error.code === 'stale_policy_generation',
  );
});

test('approval expiry and max-use are fixed by signed policy rather than caller input', () => {
  const engine = new PolicyEngine(makePolicy());
  assert.throws(
    () => engine.authorize(makeRequest({
      approval: {
        id: 'approval-123', mode: 'preapproved', expiresAt: '2098-01-01T00:00:00.000Z', maxUses: 1,
      },
    })),
    (error) => error instanceof SeoriAuthError && error.code === 'capability_forbidden',
  );

  const expiredApproval = {
    id: 'approval-123', mode: 'preapproved', expiresAt: '2000-01-01T00:00:00.000Z', maxUses: 1,
  };
  const expired = new PolicyEngine(makePolicy({ approvals: [expiredApproval] }));
  assert.throws(
    () => expired.authorize(makeRequest({ approval: expiredApproval })),
    (error) => error instanceof SeoriAuthError && error.code === 'approval_expired',
  );
});

test('password/TOTP is limited to canonical dedicated bot accounts and TOTP needs policy approval', () => {
  const policy = makePolicy({
    allowTotp: true,
    authStrategies: [['password', 'totp']],
  });
  const engine = new PolicyEngine(policy);

  assert.equal(
    engine.authorize(makeRequest({ authFactors: ['password', 'totp'] })).ruleId,
    'private-upload',
  );
  assert.throws(
    () => new PolicyEngine(makePolicy()).authorize(makeRequest({ authFactors: ['password', 'totp'] })),
    (error) => error instanceof SeoriAuthError && error.code === 'capability_forbidden',
  );
  const human = new PolicyEngine(makePolicy(
    { allowTotp: true, authStrategies: [['password'], ['password', 'totp']] },
    {
      accounts: [{
        provider: 'apps-in-toss',
        accountId: 'operator-account',
        kind: 'human',
        credentialRefs: ['shared/apps-in-toss/operator'],
      }],
    },
  ));
  for (const authFactors of [['password'], ['password', 'totp']]) {
    assert.throws(
      () => human.authorize(makeRequest({ authFactors })),
      (error) => error instanceof SeoriAuthError && error.code === 'HUMAN_REAUTH_REQUIRED',
    );
  }
  assert.throws(
    () => engine.authorize(makeRequest({ accountKind: 'dedicated_bot' })),
    (error) => error instanceof SeoriAuthError && error.code === 'invalid_request',
  );
});

test('authentication factors are an ordered exact policy strategy', () => {
  const engine = new PolicyEngine(makePolicy({
    authStrategies: [['api_key'], ['oidc', 'certificate']],
  }));
  assert.equal(engine.authorize(makeRequest({ authFactors: ['api_key'] })).authStrategyIndex, 0);
  assert.throws(
    () => engine.authorize(makeRequest({ authFactors: ['oidc', 'certificate'] })),
    (error) => error instanceof SeoriAuthError &&
      error.code === 'durable_auth_strategy_evidence_required',
  );
  assert.equal(
    engine.evaluateForDurableState(makeRequest({ authFactors: ['oidc', 'certificate'] })).authStrategyIndex,
    1,
  );
  for (const authFactors of [
    ['password'],
    ['session'],
    ['certificate', 'oidc'],
    ['api_key', 'oidc'],
  ]) {
    assert.throws(
      () => engine.authorize(makeRequest({ authFactors })),
      (error) => error instanceof SeoriAuthError && error.code === 'capability_forbidden',
    );
  }
});

test('protected actions always require an exact per-run approval', () => {
  const opaqueCapability = 'operation.execute';
  for (const actionClass of [
    'review_submit',
    'review_cancel',
    'public_release',
    'tester_change',
    'role_change',
    'permission_change',
    'credential_change',
    'certificate_change',
    'other_mutation',
  ]) {
    const preapproved = new PolicyEngine(makePolicy({
      capabilities: [opaqueCapability],
      actionClass,
    }));
    assert.throws(
      () => preapproved.authorize(makeRequest({ capability: opaqueCapability })),
      (error) => error instanceof SeoriAuthError && error.code === 'per_run_approval_required',
    );
    const approval = {
      id: `approval-${actionClass.replaceAll('_', '-')}`,
      mode: 'per_run',
      expiresAt: '2099-01-01T00:00:00.000Z',
      maxUses: 1,
    };
    const perRun = new PolicyEngine(makePolicy({
      capabilities: [opaqueCapability],
      actionClass,
      approvals: [approval],
    }));
    assert.equal(
      perRun.authorize(makeRequest({ capability: opaqueCapability, approval })).actionClass,
      actionClass,
    );
  }
  const productionResource = { kind: 'miniapp', id: 'example-app', environment: 'production' };
  const production = new PolicyEngine(makePolicy({
    actionClass: 'read_only',
    resources: [productionResource],
  }));
  assert.throws(
    () => production.authorize(makeRequest({ resource: productionResource })),
    (error) => error instanceof SeoriAuthError && error.code === 'per_run_approval_required',
  );
  assert.equal(
    new PolicyEngine(makePolicy({ actionClass: 'read_only' })).authorize(makeRequest()).actionClass,
    'read_only',
  );
});
