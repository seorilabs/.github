import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { applyHistoricalReviewCoverage } from '../scripts/release/historical-review-coverage.mjs';
import { policy } from '../scripts/release/test-plan.mjs';

const hash = document => createHash('sha256').update(JSON.stringify(document)).digest('hex');
const errors = ['FEATURE_COVERAGE ux-1', 'FEATURE_COVERAGE functional-4', 'FEATURE_COVERAGE ux-4'];
function fixture() {
  const sourceSha = 'a'.repeat(40);
  const document = { schemaVersion: 2, repository: 'seorilabs/test-coverage', sourceSha, target: 'google-play',
    reviewRounds: Array.from({ length: 6 }, (_, i) => ({ number: i + 1, sourceSha,
      functional: { status: 'passed' }, ux: { status: 'passed' } })) };
  document.reviewRounds[0].ux = { status: 'failed', resolutionEvidence: 'https://example.com/current-check' };
  document.reviewRounds[3].functional = { status: 'blocked', resolutionEvidence: 'https://example.com/current-check' };
  document.reviewRounds[3].ux = { status: 'failed', resolutionEvidence: 'https://example.com/current-check' };
  const context = { repository: document.repository, sourceSha, target: document.target, phase: 'before-build',
    tag: 'v1.9.0', now: '2026-10-19T07:00:00Z' };
  const original = { ok: false, errors: [...errors], level: 'L3', completedAt: '2026-10-19T06:30:00Z' };
  const grant = { schemaVersion: 1, id: 'test-approved-history', repository: document.repository, sourceSha,
    phases: ['before-build', 'before-deploy', 'before-release'], tags: ['development-evidence', 'v1.9.0'],
    latestRound: 6, approvedAt: '2026-10-19T06:45:00Z', expiresAt: '2026-10-20T06:45:00Z',
    errors: [...errors], evidenceHashes: { 'google-play': hash(document) } };
  return { document, context, original, grant };
}
const apply = f => applyHistoricalReviewCoverage(f.document, f.context, f.original, [f.grant]);

test('an approved exact historical failure yields human_exception and retains the failed original', () => {
  const f = fixture(), before = structuredClone(f);
  const result = apply(f);
  assert.equal(result.ok, true);
  assert.equal(result.decisionStatus, 'human_exception');
  assert.equal(result.exceptionId, f.grant.id);
  assert.deepEqual(result.waivedErrors, errors);
  assert.deepEqual(result.originalVerdict, f.original);
  assert.equal(result.originalVerdict.ok, false);
  assert.deepEqual(f, before);
});

test('formatting does not change the digest, while content and key order do', () => {
  const f = fixture();
  f.document = JSON.parse(JSON.stringify(f.document, null, 2));
  assert.equal(apply(f).ok, true);
  f.document.reviewRounds[0].ux.resolutionEvidence += '/changed';
  assert.equal(apply(f).ok, false);
  const reordered = fixture();
  reordered.document = Object.fromEntries(Object.entries(reordered.document).reverse());
  assert.equal(apply(reordered).ok, false);
});

for (const [name, mutate] of [
  ['other repository', f => { f.context.repository = 'seorilabs/other'; }],
  ['other candidate', f => { f.context.sourceSha = 'b'.repeat(40); }],
  ['other market', f => { f.context.target = 'app-store'; }],
  ['document market mismatch', f => { f.document.target = 'app-store'; }],
  ['other tag', f => { f.context.tag = 'v1.9.1'; }],
  ['other phase', f => { f.context.phase = 'after-release'; }],
  ['public release even if a grant lists it', f => { f.context.phase = 'before-release'; }],
  ['web deployment even with a matching grant', f => {
    f.context.phase = 'before-deploy'; f.context.target = f.document.target = 'web';
    f.grant.evidenceHashes.web = hash(f.document);
  }],
  ['service deployment even with a matching grant', f => {
    f.context.phase = 'before-deploy'; f.context.target = f.document.target = 'service';
    f.grant.evidenceHashes.service = hash(f.document);
  }],
  ['before approval', f => { f.context.now = '2026-10-19T06:44:59Z'; }],
  ['at expiry', f => { f.context.now = f.grant.expiresAt; }],
  ['past expiry', f => { f.context.now = '2026-10-21T00:00:00Z'; }],
  ['invalid current time', f => { f.context.now = 'invalid'; }],
  ['approval window over 168 hours', f => { f.grant.expiresAt = '2026-10-27T00:00:00Z'; }],
  ['invalid expiry', f => { f.grant.expiresAt = 'invalid'; }],
  ['non-array phases', f => { f.grant.phases = 'before-build'; }],
  ['missing tags', f => { delete f.grant.tags; }],
  ['wrong review grant', f => { f.grant.latestRound = 5; }],
  ['duplicate permitted errors', f => { f.grant.errors[2] = f.grant.errors[1]; }],
  ['L1 instead of L3', f => { f.original.level = 'L1'; }],
  ['CI failure', f => { f.original.errors.push('CI_RUN_UNVERIFIED ci'); }],
  ['expired run', f => { f.original.errors.push('RUN_EXPIRED ci'); }],
  ['release scope failure', f => { f.original.errors.push('RELEASE_NOT_AUTHORIZED until test-track'); }],
  ['SDK floor failure', f => { f.original.errors.push('TEST_LEVEL_BELOW_FLOOR platform purchase ios'); }],
  ['schema error', f => { f.original.errors.push('EVIDENCE_SCHEMA /'); }],
]) {
  test(`does not grant an exception for ${name}`, () => {
    const f = fixture(); mutate(f);
    assert.strictEqual(apply(f), f.original);
    assert.equal(f.original.ok, false);
  });
}

for (const [name, mutate] of [
  ['failed latest functional review', f => { f.document.reviewRounds[5].functional.status = 'failed'; }],
  ['failed latest UX review', f => { f.document.reviewRounds[5].ux.status = 'failed'; }],
  ['latest review on another candidate', f => { f.document.reviewRounds[5].sourceSha = 'b'.repeat(40); }],
  ['unresolved historical finding', f => { delete f.document.reviewRounds[0].ux.resolutionEvidence; }],
  ['empty historical resolution', f => { f.document.reviewRounds[0].ux.resolutionEvidence = ' '; }],
  ['passed historical aspect', f => { f.document.reviewRounds[0].ux.status = 'passed'; }],
  ['missing historical round', f => { f.document.reviewRounds.splice(0, 1); }],
  ['v1 document', f => { f.document.schemaVersion = 1; }],
]) {
  test(`even a matching digest cannot excuse ${name}`, () => {
    const f = fixture(); mutate(f); f.grant.evidenceHashes[f.context.target] = hash(f.document);
    assert.strictEqual(apply(f), f.original);
  });
}

test('current-round coverage and non-coverage failures cannot become grant errors', () => {
  for (const error of ['FEATURE_COVERAGE ux-6', 'RUN_EXPIRED ci', 'CI_RUN_UNVERIFIED ci']) {
    const f = fixture(); f.grant.errors = [error]; f.original.errors = [error];
    assert.strictEqual(apply(f), f.original);
  }
});

test('absent, revoked or ambiguous grants retain the original failure', () => {
  const f = fixture();
  for (const registry of [[], [null], [f.grant, structuredClone(f.grant)]]) {
    assert.strictEqual(applyHistoricalReviewCoverage(f.document, f.context, f.original, registry), f.original);
  }
});

test('normal successful evidence is unchanged and a pre-tag file check remains possible', () => {
  const f = fixture(); f.original = { ok: true, errors: [] };
  assert.strictEqual(apply(f), f.original);
  const preflight = fixture(); delete preflight.context.tag;
  assert.equal(apply(preflight).decisionStatus, 'human_exception');
  preflight.context.tag = 'development-evidence';
  assert.equal(apply(preflight).decisionStatus, 'human_exception');
});

test('the checked-in grant is limited to the approved candidate and three actual evidence hashes', () => {
  assert.deepEqual(policy.historicalReviewCoverage.grantRegistry,
    ['contracts/historical-review-coverage/lizard-tycoon-1.9.0.json']);
  const grant = JSON.parse(readFileSync(new URL('../contracts/historical-review-coverage/lizard-tycoon-1.9.0.json', import.meta.url)));
  assert.equal(grant.repository, 'seorilabs/lizard-tycoon');
  assert.equal(grant.sourceSha, '055aae4422610e279417f3f3a7d2b9007cb1754d');
  assert.equal(grant.latestRound, 6);
  assert.deepEqual(grant.errors, errors);
  assert.deepEqual(grant.tags, ['development-evidence', 'v1.9.0']);
  assert.deepEqual(grant.phases, ['before-build', 'before-deploy']);
  assert.deepEqual(Object.keys(grant.evidenceHashes).sort(), ['app-store', 'apps-in-toss', 'google-play']);
  for (const hash of Object.values(grant.evidenceHashes)) assert.match(hash, /^[a-f0-9]{64}$/u);
  assert.ok(Date.parse(grant.expiresAt) - Date.parse(grant.approvedAt) <= 168 * 3600000);
  assert.equal(grant.expiresAt, '2026-10-26T03:59:05Z');
  assert.match(grant.approvalEvidence, /^https:\/\/github\.com\/seorilabs\/lizard-tycoon\/issues\/805#issuecomment-/u);
});
