import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateReleaseException } from '../scripts/release/verify-release-exception.mjs';

const read = name => readFileSync(new URL(`../contracts/release-exceptions/${name}`, import.meta.url));
const grant = JSON.parse(read('reascend-1.1.1.json'));
const previous = JSON.parse(read('reascend-1.1.0.json'));
const observations = JSON.parse(read(grant.observationsFile));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const document = { schemaVersion: 1, kind: 'human_release_exception', state: 'active',
    decisionStatus: 'human_exception', productE2eStatus: 'blocked', id: grant.id,
    repository: grant.repository, releaseTag: grant.releaseTag, sourceSha: 'a'.repeat(40),
    baselineSourceSha: grant.baselineSourceSha, target: 'app-store', verifierSha: 'b'.repeat(40),
    configurationFingerprint: grant.configurationFingerprints['app-store'],
    inventorySha256: grant.inventorySha256, productTreeSha256: 'c'.repeat(64),
    approvalSha256: grant.approvalSha256, proposalSha256: grant.proposalSha256,
    observationsSha256: grant.observationsSha256, riskNotesSha256: 'd'.repeat(64),
    approvedAt: grant.approvedAt, expiresAt: new Date(Date.parse(grant.approvedAt) + grant.maxAgeHours * 3600000).toISOString(),
    approvedRisks: grant.approvedRisks, features: observations.features, releaseBinding: null };
  const context = { exceptionId: grant.id, repository: grant.repository, sourceSha: document.sourceSha,
    tag: grant.releaseTag, target: document.target, phase: 'before-build',
    configurationFingerprint: document.configurationFingerprint, verifierSha: document.verifierSha,
    verifierProof: { verified: true, revision: document.verifierSha }, now: '2026-10-13T12:33:07Z', preflightOnly: true };
  return { document, context };
}

test('iOS111 grant retains original risks, verdicts and evidence clock and preserves110', () => {
  assert.deepEqual(grant.targets, ['app-store']);
  assert.deepEqual(grant.approvedRisks, previous.approvedRisks);
  assert.equal(grant.approvedAt, previous.approvedAt);
  assert.equal(grant.maxAgeHours, previous.maxAgeHours);
  assert.deepEqual(observations, JSON.parse(read(previous.observationsFile)));
  assert.equal(hash(read(grant.approvalFile)), grant.approvalSha256);
  assert.equal(hash(read(grant.observationsFile)), grant.observationsSha256);
});
test('iOS111 grant cannot authorize Google Play', () => {
  const { document, context } = fixture(); document.target = context.target = 'google-play';
  assert.throws(() => validateReleaseException(document, context), /RELEASE_EXCEPTION_SCOPE/u);
});
test('iOS111 grant cannot authorize the old110 tag', () => {
  const { document, context } = fixture(); document.releaseTag = context.tag = 'v1.1.0';
  assert.throws(() => validateReleaseException(document, context), /RELEASE_EXCEPTION_SCOPE/u);
});
test('new scope does not extend the old evidence expiry', () => {
  const { document, context } = fixture(); context.now = '2026-10-19T22:39:43Z';
  assert.throws(() => validateReleaseException(document, context), /RELEASE_EXCEPTION_EXPIRED/u);
});
test('valid111 metadata without original evidence still cannot pass', () => {
  const { document, context } = fixture();
  assert.throws(() => validateReleaseException(document, context), /RELEASE_EXCEPTION_ORIGINAL_EVIDENCE_MISSING_OR_CHANGED/u);
});
