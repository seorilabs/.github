import { readFileSync } from 'node:fs';

// Only approvals reviewed into the central repository are trusted. No CLI/env override.
const registry = JSON.parse(readFileSync(new URL('../../contracts/release-verification-exceptions.json', import.meta.url), 'utf8'));
const keys = ['id','repository','tag','sourceSha','targets','phases','approvedAt','expiresAt','approverKind','approvalEvidence','objective','reason','removeAfter'];
const unique = values => Array.isArray(values) && values.length > 0 && new Set(values).size === values.length;
if (registry.schemaVersion !== 1 || !Array.isArray(registry.exceptions) || new Set(registry.exceptions.map(e => e?.id)).size !== registry.exceptions.length
  || registry.exceptions.some(e => !e || Object.keys(e).some(k => !keys.includes(k)) || keys.some(k => !(k in e))
    || !/^[a-z0-9.-]+$/u.test(e.id) || !/^seorilabs\/[a-z0-9._-]+$/u.test(e.repository)
    || !/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(e.tag) || !/^[a-f0-9]{40}$/u.test(e.sourceSha)
    || !unique(e.targets) || e.targets.some(t => !['google-play','app-store'].includes(t))
    || !unique(e.phases) || e.phases.some(t => !['before-build','before-deploy'].includes(t))
    || e.approverKind !== 'human' || e.objective !== 'submitted'
    || typeof e.reason !== 'string' || !e.reason.trim() || typeof e.removeAfter !== 'string' || !e.removeAfter.trim()
    || !/^https:\/\/github\.com\/seorilabs\/[a-z0-9._-]+\/issues\/[1-9][0-9]*$/u.test(e.approvalEvidence)
    || !Number.isFinite(Date.parse(e.approvedAt)) || !Number.isFinite(Date.parse(e.expiresAt))
    || Date.parse(e.expiresAt) <= Date.parse(e.approvedAt) || Date.parse(e.expiresAt) - Date.parse(e.approvedAt) > 168 * 3600000)) {
  throw new Error('INVALID_RELEASE_EXCEPTION_REGISTRY');
}

export function findHumanReleaseException(context) {
  const now = Date.parse(context.now ?? new Date().toISOString());
  return registry.exceptions.find(e => e.repository === context.repository && e.tag === context.tag
    && e.sourceSha === context.sourceSha && e.targets.includes(context.target) && e.phases.includes(context.phase)
    && Date.parse(e.approvedAt) <= now && now < Date.parse(e.expiresAt)) ?? null;
}
