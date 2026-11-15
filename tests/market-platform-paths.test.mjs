// 가상 기능 목록이다. 실제 제품의 SDK 실행 근거가 아니다.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {computeFloor, mergeTestPlans, testPlanProblems, validInventory} from '../scripts/release/test-plan.mjs';
import {plan} from './helpers/test-levels-fixture.mjs';

const map = (android = [], ios = [], ait = []) => ({'google-play': android, 'app-store': ios, 'apps-in-toss': ait});
const mapped = (android = [], ios = [], ait = []) => ({
  platformPaths: [...new Set([...android, ...ios, ...ait])], platformPathsByMarket: map(android, ios, ait),
});
const inventory = () => ({
  schemaVersion: 2, e2e: {workflow: '.github/workflows/godot-checks.yml'},
  regressionPaths: ['engine/**'], ...mapped(['exports/android/**'], ['exports/ios/**']),
  features: [
    {id: 'create', core: true, paths: ['src/create/**']},
    ...['account', 'purchase', 'refund', 'restore'].map(id => ({id, core: true, paths: [`src/${id}/**`], ...mapped([], [`native/ios/${id}/**`])})),
    {id: 'ads', core: true, paths: ['src/ads/**'], ...mapped(['native/android/ads/**'])},
    {id: 'widget', core: true, paths: ['src/widget/**'], ...mapped(['native/android/widget/**'], ['native/ios/widget/**'])},
  ],
});
function floor(current = inventory(), target = 'google-play', options = {}) {
  const first = options.first ?? false;
  return computeFloor({inventory: current, target,
    merged: mergeTestPlans([plan({level: 'L3', changedFeatures: ['create'], baseline: first ? null : 'v1.0.0', ...options.plan})]),
    changes: {'v1.0.0': options.files ?? []},
    baselineInventories: {'v1.0.0': 'baseline' in options ? options.baseline : inventory()},
  });
}
const ids = result => result.deviceFloor.map(value => value.featureId);

test('C2 first Google Play release requires only actual Android ads and widget', () => {
  assert.equal(validInventory(inventory()), true);
  assert.deepEqual(ids(floor(inventory(), 'google-play', {first: true})), ['ads', 'widget']);
  assert.deepEqual(ids(floor(inventory(), 'app-store', {first: true})), ['account', 'purchase', 'refund', 'restore', 'widget']);
  assert.deepEqual(ids(floor(inventory(), 'apps-in-toss', {first: true})), []);
});
test('C1 unmapped v2 retains the conservative union for every native market', () => {
  const legacy = inventory();
  delete legacy.platformPathsByMarket;
  for (const feature of legacy.features) delete feature.platformPathsByMarket;
  assert.equal(validInventory(legacy), true);
  assert.deepEqual(ids(floor(legacy, 'google-play', {first: true})), ['account', 'ads', 'purchase', 'refund', 'restore', 'widget']);
});
test('C2 native changes join dev scope only for their target market', () => {
  const options = {files: ['native/ios/account/link.mm']};
  assert.deepEqual(floor(inventory(), 'google-play', options).touched, []);
  assert.deepEqual(floor(inventory(), 'app-store', options).touched, ['account']);
  assert.deepEqual(ids(floor(inventory(), 'app-store', options)), ['account']);
});
test('C2 common paths use the same market selection as feature paths', () => {
  const options = {files: ['exports/ios/Info.plist']};
  assert.deepEqual(ids(floor(inventory(), 'google-play', options)), []);
  assert.deepEqual(ids(floor(inventory(), 'app-store', options)), ['account', 'purchase', 'refund', 'restore', 'widget']);
});
test('C3 removing or narrowing a feature map preserves baseline target paths', () => {
  for (const remove of [false, true]) {
    const current = inventory();
    const ads = current.features.find(value => value.id === 'ads');
    Object.assign(ads, mapped());
    if (remove) { delete ads.platformPathsByMarket; delete ads.platformPaths; }
    assert.equal(validInventory(current), true);
    assert.deepEqual(floor(current, 'google-play', {files: ['native/android/ads/Bridge.kt']}).deviceFloor,
      [{featureId: 'ads', rule: 'platform'}]);
  }
});
test('C3 removing or narrowing the common map preserves baseline common paths', () => {
  for (const remove of [false, true]) {
    const current = inventory();
    Object.assign(current, mapped([], ['exports/ios/**']));
    if (remove) { delete current.platformPathsByMarket; delete current.platformPaths; }
    assert.deepEqual(ids(floor(current, 'google-play', {files: ['exports/android/AndroidManifest.xml']})), ['ads', 'widget']);
  }
});
test('C3 first adoption in another market remains non-waivable for an existing feature ID', () => {
  const baseline = inventory();
  Object.assign(baseline.features.find(value => value.id === 'ads'), mapped([], ['native/ios/ads/**']));
  const result = floor(inventory(), 'google-play', {baseline, files: ['native/android/ads/Bridge.kt'],
    plan: {floorOverrides: [{rule: 'platform', featureId: 'ads', reason: '가상 입력의 일반 낮춤'}]}});
  assert.deepEqual(result.deviceFloor, [{featureId: 'ads', rule: 'platform-first'}]);
});
test('C3 unreadable baseline retains conservative defaults and first-adoption requirements', () => {
  const result = floor(inventory(), 'google-play', {baseline: null, files: ['godot/export_presets.cfg']});
  assert.deepEqual(result.deviceFloor, [{featureId: 'ads', rule: 'platform-first'}, {featureId: 'widget', rule: 'platform-first'}]);
});
test('C2 native-development alternatives are checked against their declared market', () => {
  const alternative = {featureId: 'account', target: 'google-play', kind: 'native-development', reason: '가상 SDK 검수', checks: ['sdk'], configurationFingerprint: 'c'.repeat(64)};
  assert.ok(testPlanProblems(plan({changedFeatures: ['create'], platformValidation: [alternative]}), inventory()).includes('platform-validation-not-native account'));
  assert.deepEqual(testPlanProblems(plan({changedFeatures: ['create'], release: {markets: ['app-store']}, platformValidation: [{...alternative, target: 'app-store'}]}), inventory()), []);
});

for (const [name, mutate] of [
  ['missing market', value => { delete value['app-store']; }],
  ['unknown market', value => { value.web = []; }],
  ['blank glob', value => { value['google-play'] = [' ']; }],
  ['non-string glob', value => { value['google-play'] = [7]; }],
  ['non-array paths', value => { value['google-play'] = 'native/**'; }],
]) test(`C4 rejects ${name} in feature and common maps`, () => {
  for (const common of [false, true]) {
    const current = inventory();
    mutate((common ? current : current.features.find(value => value.id === 'ads')).platformPathsByMarket);
    assert.equal(validInventory(current), false);
  }
});
test('C4 rejects null maps, empty maps, missing union and union mismatch', () => {
  for (const common of [false, true]) for (const invalid of ['null', 'empty', 'missing-union', 'different-union']) {
    const current = inventory();
    const value = common ? current : current.features.find(feature => feature.id === 'ads');
    if (invalid === 'null') value.platformPathsByMarket = null;
    if (invalid === 'empty') value.platformPathsByMarket = {};
    if (invalid === 'missing-union') delete value.platformPaths;
    if (invalid === 'different-union') value.platformPaths = ['other/**'];
    assert.equal(validInventory(current), false, `${common}:${invalid}`);
  }
});
test('C1 maps are rejected on v1 even when no legacy platform field is present', () => {
  const base = {schemaVersion: 1, features: [{id: 'create', core: true}]};
  assert.equal(validInventory(base), true);
  assert.equal(validInventory({...base, platformPathsByMarket: map()}), false);
  assert.equal(validInventory({...base, features: [{...base.features[0], platformPathsByMarket: map()}]}), false);
});
test('C4 an explicit all-empty map is valid only with its empty union', () => {
  const current = inventory();
  Object.assign(current.features.find(value => value.id === 'ads'), mapped());
  assert.equal(validInventory(current), true);
});
test('the market-path inventory example satisfies the same contract', () => {
  const sample = JSON.parse(readFileSync(new URL('../docs/agent-governance/templates/feature-inventory-market-paths.example.json', import.meta.url), 'utf8'));
  assert.equal(validInventory(sample), true);
  assert.deepEqual(ids(floor(sample, 'google-play', {first: true})), ['ads']);
  assert.deepEqual(ids(floor(sample, 'app-store', {first: true})), ['account']);
});
