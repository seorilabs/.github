// 가상 입력: 실제 제품의 실행 근거가 아니다.
import assert from 'node:assert/strict';
import test from 'node:test';
import {validateDevelopmentEvidence} from '../scripts/release/verify-development-evidence.mjs';
import {DESIGN, context, evidence, inventory, plan, run} from './helpers/test-levels-fixture.mjs';

const ALL = ['create', 'settings', 'store', 'purchase', 'ads'];
const FINGERPRINT = 'c'.repeat(64);
const inv = () => ({...inventory(), schemaVersion: 2, e2e: {workflow: '.github/workflows/godot-checks.yml'},
  features: inventory().features.map(f => f.id === 'ads' ? {...f, platformPaths: ['native/ads/**']} : f)});
const alternative = () => ({featureId: 'ads', target: 'google-play', kind: 'native-development', configurationFingerprint: FINGERPRINT, reason: '실제 SDK와 서버 지급을 격리 개발 환경에서 검증', checks: ['sdk-completion', 'server-delivery']});
function fixture() {
  const source = inv();
  const baseline = {...source, features: source.features.filter(f => f.id !== 'ads')};
  const ctx = context({phase: 'before-release', configurationFingerprint: FINGERPRINT, featureInventory: source,
    baselineInventories: {'v1.0.0': baseline}, changes: {'v1.0.0': ['native/ads/bridge.kt']},
    plans: {[DESIGN]: {approved: true, plan: plan({level: 'L3', changedFeatures: ['ads'], platformValidation: [alternative()]})}}});
  const native = run('native-1', 'native-development', ['ads'], {executor: 'native-reviewer', target: 'google-play', build: 'QA 21', configurationFingerprint: FINGERPRINT,
    nativeSdk: {mode: 'real', runtime: 'android-emulator', sdkNames: ['Google Mobile Ads 25'], artifact: {path: 'https://example.com/qa.apk', sha256: 'd'.repeat(64)}, limitations: '알림 플러그인은 별도 검수'},
    scenarios: alternative().checks.map(id => ({id, status: 'passed', featureIds: ['ads'], evidence: [`https://example.com/${id}`]}))});
  return {ctx, document: evidence({runs: [run('dev', 'godot-headless-e2e', ALL, {executor: 'dev-reviewer'}), native]})};
}
const verify = f => validateDevelopmentEvidence(f.document, f.ctx);
test('approved real SDK development execution satisfies the new platform feature floor', () => {
  assert.deepEqual(verify(fixture()).errors, []);
});
test('iOS simulator execution is scoped to the App Store target', () => {
  const f = fixture(); f.ctx.target = f.document.target = 'app-store';
  f.ctx.plans[DESIGN].plan.release.markets = ['app-store'];
  f.ctx.plans[DESIGN].plan.platformValidation[0].target = 'app-store';
  f.document.runs[1].target = 'app-store'; f.document.runs[1].nativeSdk.runtime = 'ios-simulator';
  assert.deepEqual(verify(f).errors, []);
});
for (const [name, mutate] of [
  ['no approved alternative', f => { delete f.ctx.plans[DESIGN].plan.platformValidation; }],
  ['unapproved plan', f => { f.ctx.plans[DESIGN].approved = false; }],
  ['headless only', f => { f.document.runs.pop(); }],
  ['native run without real SDK provenance', f => { const r=f.document.runs[1]; delete r.nativeSdk; delete r.target; delete r.build; delete r.configurationFingerprint; }],
  ['wrong market execution', f => { f.document.runs[1].target = 'app-store'; f.document.runs[1].nativeSdk.runtime = 'ios-simulator'; }],
  ['wrong runtime platform', f => { f.document.runs[1].nativeSdk.runtime = 'ios-simulator'; }],
  ['missing required check', f => { f.document.runs[1].scenarios.pop(); }],
  ['required check for another feature', f => { f.document.runs[1].scenarios[1].featureIds = ['purchase']; }],
  ['different source SHA', f => { f.document.runs[1].sourceSha = 'e'.repeat(40); }],
  ['expired execution', f => { f.document.runs[1].completedAt = '2026-10-01T05:10:00Z'; f.document.runs[1].startedAt = '2026-10-01T05:01:00Z'; f.document.runs[1].plannedAt = '2026-10-01T05:00:00Z'; }],
  ['implementer execution', f => { f.document.runs[1].executor = f.document.implementer; }],
  ['changed native configuration', f => { f.document.runs[1].configurationFingerprint = 'e'.repeat(64); }],
  ['fake SDK', f => { f.document.runs[1].nativeSdk.mode = 'fake'; }],
  ['no artifact hash', f => { delete f.document.runs[1].nativeSdk.artifact.sha256; }],
  ['no configuration fingerprint', f => { delete f.document.runs[1].configurationFingerprint; }],
  ['real SDK metadata on a headless run', f => { f.document.runs[1].kind = 'godot-headless-e2e'; }],
  ['unverified native CI execution', f => { f.document.runs[1].executor = 'ci'; f.document.runs[1].ciRun={url:'https://github.com/seorilabs/example/actions/runs/1'}; }],
  ['wrong plan market', f => { f.ctx.plans[DESIGN].plan.platformValidation[0].target = 'app-store'; }],
  ['unknown feature', f => { f.ctx.plans[DESIGN].plan.platformValidation[0].featureId = 'missing'; }],
  ['duplicate alternative', f => { f.ctx.plans[DESIGN].plan.platformValidation.push(alternative()); }],
  ['non-native inventory', f => { f.ctx.featureInventory = inventory(); }],
]) test(`rejects ${name}`, () => {
  const f=fixture(); mutate(f); assert.equal(verify(f).ok, false, name);
});
test('every bound plan must approve the native alternative', () => {
  const f=fixture();
  f.document.designs.push({...f.document.designs[0], id:'D-2', document:'docs/design/second/design.md', testPlan:'docs/design/second/test-plan.json'});
  f.ctx.plans['D-2']={approved:true,plan:plan({level:'L3',changedFeatures:['ads']})};
  assert.ok(verify(f).errors.includes('TEST_LEVEL_BELOW_FLOOR platform-first ads android'));
});
test('checks from all approved plans must be satisfied', () => {
  const f=fixture();
  f.document.designs.push({...f.document.designs[0],id:'D-2',document:'docs/design/second/design.md',testPlan:'docs/design/second/test-plan.json'});
  const extra={...alternative(),checks:['relaunch-no-duplicate']};
  f.ctx.plans['D-2']={approved:true,plan:plan({level:'L3',changedFeatures:['ads'],platformValidation:[extra]})};
  assert.equal(verify(f).ok,false);
  f.document.runs[1].scenarios.push({id:'relaunch-no-duplicate',status:'passed',featureIds:['ads'],evidence:['https://example.com/relaunch']});
  assert.deepEqual(verify(f).errors,[]);
});
test('ordinary overrides still cannot waive a new platform feature', () => {
  const f=fixture();delete f.ctx.plans[DESIGN].plan.platformValidation;f.document.runs.pop();
  f.ctx.plans[DESIGN].plan.floorOverrides=[{rule:'platform',featureId:'ads',reason:'dev exists'}];
  assert.ok(verify(f).errors.includes('TEST_LEVEL_BELOW_FLOOR platform-first ads android'));
});
test('approved fingerprint is mandatory even when the release caller supplies no fingerprint', () => {
  const f=fixture();delete f.ctx.configurationFingerprint;
  assert.deepEqual(verify(f).errors,[]);
  f.document.runs[1].configurationFingerprint='e'.repeat(64);
  assert.ok(verify(f).errors.includes('TEST_LEVEL_BELOW_FLOOR platform-first ads android'));
});
test('bound designs with conflicting approved configurations cannot authorize the alternative', () => {
  const f=fixture();f.document.designs.push({...f.document.designs[0],id:'D-2',document:'docs/design/second/design.md',testPlan:'docs/design/second/test-plan.json'});
  f.ctx.plans['D-2']={approved:true,plan:plan({level:'L3',changedFeatures:['ads'],platformValidation:[{...alternative(),configurationFingerprint:'e'.repeat(64)}]})};
  assert.equal(verify(f).ok,false);
});
test('v1 foundation floors reject a physical run for another market', () => {
  const f=fixture();f.ctx.featureInventory=inventory();f.ctx.changes={'v1.0.0':['src/purchase/native/billing.gd']};
  delete f.ctx.plans[DESIGN].plan.platformValidation;
  f.document.runs[1]=run('phone','android-device',['purchase','ads'],{executor:'qa',target:'apps-in-toss'});
  assert.ok(verify(f).errors.includes('TEST_LEVEL_BELOW_FLOOR foundation purchase android'));
});
test('a physical run for another market cannot satisfy the platform floor', () => {
  const f=fixture();f.document.runs[1]=run('phone','android-device',['ads'],{executor:'qa',target:'apps-in-toss'});
  delete f.ctx.plans[DESIGN].plan.platformValidation;
  assert.ok(verify(f).errors.includes('TEST_LEVEL_BELOW_FLOOR platform-first ads android'));
});
