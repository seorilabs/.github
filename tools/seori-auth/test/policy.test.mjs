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

test('TOTP is limited to policy-approved dedicated bot accounts', () => {
  const policy = makePolicy({
    accountKinds: ['dedicated_bot', 'human'],
    allowTotp: true,
  });
  const engine = new PolicyEngine(policy);

  assert.equal(
    engine.authorize(makeRequest({ authFactors: ['password', 'totp'] })).ruleId,
    'private-upload',
  );
  assert.throws(
    () => engine.authorize(makeRequest({ accountKind: 'human', authFactors: ['password', 'totp'] })),
    (error) => error instanceof SeoriAuthError && error.code === 'capability_forbidden',
  );
});
