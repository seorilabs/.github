// 승인된 테스트 계획(docs/design/<id>/test-plan.json)과 바뀐 파일로 실행해야 할 범위를 계산한다.
// 같은 입력이면 항상 같은 결과를 낸다. 앱 소스를 실행하지 않고 경로 이름만 본다.
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

export const policy = parse(readFileSync(new URL('../../contracts/development-workflow.yaml', import.meta.url), 'utf8'));
const checkPlanSchema = new Ajv2020({ allErrors: true }).compile(JSON.parse(readFileSync(new URL('../../contracts/test-plan.schema.json', import.meta.url), 'utf8')));

const LEVELS = ['L1', 'L2', 'L3'];
const UNTIL = policy.release.until;
export const RELEASE_ONLY_TARGETS = ['web', 'service'];
export const DEVICE_ENVIRONMENTS = ['android', 'ios'];
export const highestLevel = levels => LEVELS[Math.max(0, ...levels.map(level => LEVELS.indexOf(level)))];
export const environmentOf = kind => Object.entries(policy.testLevels.environmentKinds).find(([, kinds]) => kinds.includes(kind))?.[0];
export const marketPlatforms = target => policy.testLevels.marketPlatforms[target] ?? [];

// glob의 **는 점으로 시작하는 파일을 건너뛴다. 양쪽의 선행 점을 지운 비교도 하여 놓치지 않는다(오탐은 재실행일 뿐이다).
const undotted = value => value.replace(/(^|\/)\./gu, '$1');
export const touches = (file, pattern) => posix.matchesGlob(file, pattern) || posix.matchesGlob(undotted(file), undotted(pattern));
const globs = value => Array.isArray(value) && value.length > 0 && value.every(p => typeof p === 'string' && p.trim());

// 기능 목록 schemaVersion 1: 모든 기능에 선택 paths, 기반 기능은 paths 필수, 최상위 선택 regressionPaths. 기반 기능 paths가 실기기 하한을 만든다.
// schemaVersion 2(headless E2E 틀이 있는 게임): 실기기 하한은 기능·최상위 platformPaths만 만들고, e2e.workflow가 필수다.
const E2E_WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/u;
const validFeature = (f, version) => typeof f?.id === 'string' && f.id.trim() && typeof f.core === 'boolean'
  && (f.foundation === undefined || typeof f.foundation === 'boolean')
  && (f.paths === undefined || globs(f.paths))
  && (f.foundation !== true || globs(f.paths))
  && (f.platformPaths === undefined || (version === 2 && globs(f.platformPaths)));
const validVersionFields = inventory => inventory.schemaVersion === 2
  ? E2E_WORKFLOW.test(inventory.e2e?.workflow ?? '') && (inventory.e2e.command === undefined || (typeof inventory.e2e.command === 'string' && inventory.e2e.command.trim()))
    && (inventory.platformPaths === undefined || globs(inventory.platformPaths))
  : inventory.e2e === undefined && inventory.platformPaths === undefined;
export const validInventory = inventory => [1, 2].includes(inventory?.schemaVersion) && Array.isArray(inventory.features) && inventory.features.length > 0
  && inventory.features.every(f => validFeature(f, inventory.schemaVersion)) && new Set(inventory.features.map(f => f.id)).size === inventory.features.length
  && (inventory.regressionPaths === undefined || globs(inventory.regressionPaths)) && validVersionFields(inventory);

export function testPlanProblems(plan, inventory) {
  if (!checkPlanSchema(plan)) return [...new Set(checkPlanSchema.errors.map(e => `schema ${e.instancePath || '/'} ${e.keyword}`))];
  const problems = [];
  const devices = plan.environments.filter(env => DEVICE_ENVIRONMENTS.includes(env));
  if (plan.level === 'L1' && (plan.environments.length !== 1 || plan.environments[0] !== 'dev')) problems.push('L1-runs-dev-only');
  if (plan.level === 'L2' && devices.length === 0) problems.push('L2-needs-device');
  if (plan.foundationRerun && plan.level !== 'L3') problems.push('foundationRerun-needs-L3');
  if (plan.redesign && plan.level !== 'L3') problems.push('redesign-needs-L3');
  if (plan.baseline === null && plan.level !== 'L3') problems.push('first-release-needs-L3');
  if (plan.baseline === null && plan.floorOverrides.some(o => o.rule === 'regression')) problems.push('first-release-regression-not-overridable');
  const features = new Map((inventory?.features ?? []).map(f => [f.id, f]));
  for (const id of plan.changedFeatures) if (!features.has(id)) problems.push(`unknown-feature ${id}`);
  const keys = plan.floorOverrides.map(o => `${o.rule}:${o.featureId ?? ''}`);
  if (new Set(keys).size !== keys.length) problems.push('duplicate-override');
  const platformInventory = inventory?.schemaVersion === 2;
  for (const o of plan.floorOverrides) {
    if (o.rule === 'foundation' && platformInventory) problems.push('foundation-override-needs-inventory-v1');
    else if (o.rule === 'foundation' && features.get(o.featureId)?.foundation !== true) problems.push(`override-not-foundation ${o.featureId}`);
    if (o.rule === 'platform' && !platformInventory) problems.push('platform-override-needs-inventory-v2');
    else if (o.rule === 'platform' && !features.has(o.featureId)) problems.push(`override-unknown-feature ${o.featureId}`);
  }
  return [...new Set(problems)];
}

// 한 후보에 묶인 승인 계획은 가장 높은 등급, 기능·환경·마켓 합집합, 가장 이른 끝 지점으로 합친다.
// 하한 낮춤은 묶인 모든 계획에 같은 항목이 있을 때만 남긴다. 한 설계의 사유가 다른 설계의 변경까지 덮지 않게 한다.
export function mergeTestPlans(plans) {
  const union = values => [...new Set(values)].sort();
  const everyPlan = predicate => plans.length > 0 && plans.every(predicate);
  const overriddenBy = rule => {
    const ids = union(plans.flatMap(p => p.floorOverrides.filter(o => o.rule === rule).map(o => o.featureId)));
    return ids.filter(id => everyPlan(p => p.floorOverrides.some(o => o.rule === rule && o.featureId === id)));
  };
  return {
    level: highestLevel(plans.map(p => p.level)),
    baselines: [...new Set(plans.map(p => p.baseline))].sort(),
    changedFeatures: union(plans.flatMap(p => p.changedFeatures)),
    environments: union(plans.flatMap(p => p.environments)),
    redesign: plans.some(p => p.redesign),
    foundationRerun: plans.some(p => p.foundationRerun),
    foundationOverrides: overriddenBy('foundation'),
    platformOverrides: overriddenBy('platform'),
    regressionOverride: everyPlan(p => p.floorOverrides.some(o => o.rule === 'regression')),
    markets: union(plans.flatMap(p => p.release.markets)),
    until: UNTIL[Math.min(...plans.map(p => UNTIL.indexOf(p.release.until ?? policy.release.defaultUntil)))],
    // Play 단계적 출시 비율. 생략은 완전 출시(1)이며 묶인 계획 중 가장 작은 비율까지만 승인된 것으로 본다.
    rollout: Math.min(...plans.map(p => p.release.rollout ?? 1)),
  };
}

// 바뀐 파일로 계획보다 높아야 하는 범위(하한)를 계산한다. changes[baseline]이 배열이 아니면 비교할 수 없다는 뜻이다.
// baselineInventories[baseline]은 기준 태그 시점의 기능 목록이다(v2에서만 쓴다). 없거나 읽을 수 없으면 모든 기능을 새 기능으로 본다.
// deviceFloor는 검증 중인 마켓 플랫폼 실기기에서 실행해야 하는 기능과 그 규칙(foundation·platform·platform-first)이다.
export function computeFloor({ merged, inventory, changes, baselineInventories, target }) {
  const files = [];
  let unknown = false;
  for (const baseline of merged.baselines) {
    if (baseline === null) continue;
    const changed = changes?.[baseline];
    if (Array.isArray(changed)) files.push(...changed); else unknown = true;
  }
  const firstRelease = merged.baselines.includes(null);
  const regressionPaths = Array.isArray(inventory.regressionPaths) ? inventory.regressionPaths : policy.floors.defaultRegressionPaths;
  const hits = paths => Array.isArray(paths) && files.some(file => paths.some(p => touches(file, p)));
  const touched = inventory.features.filter(f => hits(f.paths) || hits(f.platformPaths)).map(f => f.id);
  const regressionTriggered = firstRelease || unknown || files.some(file => regressionPaths.some(p => touches(file, p)));
  const regression = regressionTriggered && (firstRelease || !merged.regressionOverride);
  const platforms = marketPlatforms(target);
  const deviceFloor = platforms.length === 0 ? [] : inventory.schemaVersion === 2
    ? platformFloor({ merged, inventory, files, hits, firstRelease, baselineInventories })
    : foundationFloor({ merged, inventory, touched });
  return { touched, regression, deviceFloor, platforms, level: regression ? 'L3' : deviceFloor.length > 0 ? 'L2' : 'L1' };
}

function foundationFloor({ merged, inventory, touched }) {
  const foundation = new Set(inventory.features.filter(f => f.foundation === true).map(f => f.id));
  return [...new Set([...touched, ...merged.changedFeatures])].filter(id => foundation.has(id) && !merged.foundationOverrides.includes(id)).sort()
    .map(featureId => ({ featureId, rule: 'foundation' }));
}

// 첫 출시와 기준 태그에 없던 플랫폼 기능(결제·로그인을 처음 붙이는 경우 등)은 승인된 낮춤이 있어도 실기기에서 실행한다.
// 후보에서 플랫폼 경로를 지우거나 좁혀도 하한을 피하지 못하게, 바뀐 파일은 후보와 기준 태그의 플랫폼 경로를 합쳐 판정한다.
// 형식이 맞지 않거나 읽을 수 없는 기준 기능 목록은 없는 것으로 보고 중앙 기본 경로를 더한다.
function platformFloor({ merged, inventory, files, hits, firstRelease, baselineInventories }) {
  const bases = merged.baselines.filter(baseline => baseline !== null).map(baseline => baselineInventories?.[baseline]);
  const readable = bases.filter(validInventory);
  const unreadable = readable.length !== bases.length;
  const ownPaths = (source, id) => source.features.find(f => f.id === id)?.platformPaths ?? [];
  const platformPathsOf = id => [inventory, ...readable].flatMap(source => ownPaths(source, id));
  const commonOf = source => (source.schemaVersion === 2 && Array.isArray(source.platformPaths) ? source.platformPaths : policy.floors.defaultPlatformPaths);
  const commonPaths = [...new Set([...[inventory, ...readable].flatMap(commonOf), ...(unreadable ? policy.floors.defaultPlatformPaths : [])])];
  const platformFeatures = inventory.features.map(f => f.id).filter(id => platformPathsOf(id).length > 0);
  const raised = new Set(platformFeatures.filter(id => hits(platformPathsOf(id))));
  if (files.some(file => commonPaths.some(p => touches(file, p)))) {
    for (const id of platformFeatures.length > 0 ? platformFeatures : inventory.features.filter(f => f.core).map(f => f.id)) raised.add(id);
  }
  const isNew = id => firstRelease || unreadable || readable.some(base => !base.features.some(f => f.id === id));
  const first = new Set(platformFeatures.filter(isNew));
  const floor = [...first].map(featureId => ({ featureId, rule: 'platform-first' }));
  for (const featureId of raised) if (!first.has(featureId) && !merged.platformOverrides.includes(featureId)) floor.push({ featureId, rule: 'platform' });
  return floor.sort((a, b) => a.featureId.localeCompare(b.featureId));
}
