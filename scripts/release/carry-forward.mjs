// 영향 없는 기반 기능은 실제로 통과한 기준 SHA의 근거를 이어받는다. 기준부터 후보까지 바뀐 파일이 그 기능의
// paths와 겹치거나, 비교할 수 없거나, 기능 정의가 달라졌거나, 실제 실행이 기한을 넘었으면 다시 실행해야 한다.
import { policy, touches } from './test-plan.mjs';

const MAX_CARRY_FORWARD_MS = policy.foundationFeatures.carryForwardMaxAgeDays * 24 * 60 * 60 * 1000;
const sameDefinition = (a, b) => a?.foundation === true && b?.foundation === true && Array.isArray(a.paths) && Array.isArray(b.paths)
  && JSON.stringify([...a.paths].sort()) === JSON.stringify([...b.paths].sort());

export function carriedForwardFeatures(document, context, inventoryFeatures, now, errors) {
  const carried = new Set();
  for (const item of document.carriedForward ?? []) {
    if (carried.has(item.featureId)) { errors.push('DUPLICATE carried-forward'); continue; }
    carried.add(item.featureId);
    const feature = inventoryFeatures.find(f => f.id === item.featureId);
    if (feature?.foundation !== true) { errors.push(`CARRY_FORWARD_NOT_FOUNDATION ${item.featureId}`); continue; }
    const verifiedAt = Date.parse(item.verifiedAt);
    if (!(verifiedAt <= now) || now - verifiedAt > MAX_CARRY_FORWARD_MS) errors.push(`CARRY_FORWARD_EXPIRED ${item.featureId}`);
    const baseline = context.baselines?.[item.baselineSha];
    if (!Array.isArray(baseline?.changedFiles)) { errors.push(`CARRY_FORWARD_DIFF_UNAVAILABLE ${item.featureId}`); continue; }
    if (!sameDefinition(feature, baseline.inventory?.features?.find(f => f.id === item.featureId))) errors.push(`CARRY_FORWARD_INVENTORY_CHANGED ${item.featureId}`);
    if (baseline.changedFiles.some(file => feature.paths.some(pattern => touches(file, pattern)))) errors.push(`CARRY_FORWARD_AFFECTED ${item.featureId}`);
  }
  return carried;
}
