import { isDeepStrictEqual } from 'node:util';

import { CanonicalAccountRegistry } from './accounts.mjs';
import { fail } from './errors.mjs';
import { isLogicalCredentialRef, isSha256, normalizeHttpsOrigin, normalizeLeaseRequest } from './validation.mjs';

const POLICY_KEYS = new Set(['$schema', 'schemaVersion', 'generation', 'accounts', 'rules']);
const RULE_KEYS = new Set([
  'id',
  'enabled',
  'credentialRefs',
  'subjects',
  'repositories',
  'runIds',
  'commitShas',
  'providers',
  'origins',
  'redirectOrigins',
  'capabilities',
  'resources',
  'adapters',
  'accountIds',
  'actionClass',
  'authStrategies',
  'requiresArtifact',
  'artifactSha256s',
  'allowTotp',
  'approvals',
]);
const AUTH_FACTORS = new Set(['api_key', 'certificate', 'oidc', 'password', 'session', 'totp']);
const ACTION_CLASSES = new Set([
  'read_only', 'build_status', 'internal_upload', 'review_submit', 'review_cancel',
  'public_release', 'tester_change', 'role_change', 'permission_change',
  'credential_change', 'certificate_change', 'other_mutation',
]);
const PROTECTED_ACTION_CLASSES = new Set([
  'review_submit', 'review_cancel', 'public_release', 'tester_change', 'role_change',
  'permission_change', 'credential_change', 'certificate_change', 'other_mutation',
]);

function assertExactKeys(value, allowed, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_policy', `${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail('invalid_policy', `${label} contains unsupported field: ${key}`);
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      fail('invalid_policy', `${label} is missing field: ${key}`);
    }
  }
}

function stringList(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail('invalid_policy', `${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
  }
  if (new Set(value).size !== value.length || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail('invalid_policy', `${label} must contain unique non-empty strings`);
  }
  return Object.freeze([...value]);
}

function resourceList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('invalid_policy', `${label} must be a non-empty array`);
  }
  return Object.freeze(value.map((resource, index) => {
    assertExactKeys(resource, new Set(['kind', 'id', 'environment']), ['kind', 'id', 'environment'], `${label}[${index}]`);
    for (const key of ['kind', 'id', 'environment']) {
      if (typeof resource[key] !== 'string' || resource[key].length === 0) {
        fail('invalid_policy', `${label}[${index}].${key} must be a non-empty string`);
      }
    }
    return Object.freeze({ ...resource });
  }));
}

function approvalList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('invalid_policy', `${label} must be a non-empty array`);
  }
  return Object.freeze(value.map((approval, index) => {
    assertExactKeys(
      approval,
      new Set(['id', 'mode', 'expiresAt', 'maxUses']),
      ['id', 'mode', 'expiresAt', 'maxUses'],
      `${label}[${index}]`,
    );
    if (
      typeof approval.id !== 'string' || approval.id.length === 0 ||
      !['preapproved', 'per_run'].includes(approval.mode) ||
      typeof approval.expiresAt !== 'string' || !Number.isFinite(Date.parse(approval.expiresAt)) ||
      approval.expiresAt !== new Date(approval.expiresAt).toISOString() || approval.maxUses !== 1
    ) {
      fail('invalid_policy', `${label}[${index}] is invalid`);
    }
    return Object.freeze({
      id: approval.id,
      mode: approval.mode,
      expiresAt: approval.expiresAt,
      maxUses: 1,
    });
  }));
}

function authStrategyList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('invalid_policy', `${label} must be a non-empty array`);
  }
  const seen = new Set();
  return Object.freeze(value.map((strategy, index) => {
    if (
      !Array.isArray(strategy) || strategy.length === 0 ||
      new Set(strategy).size !== strategy.length ||
      strategy.some((factor) => !AUTH_FACTORS.has(factor))
    ) {
      fail('invalid_policy', `${label}[${index}] is invalid`);
    }
    const key = strategy.join('\0');
    if (seen.has(key)) fail('invalid_policy', `${label} contains a duplicate strategy`);
    seen.add(key);
    return Object.freeze([...strategy]);
  }));
}

function requiresPerRunApproval(request, rule) {
  return request.resource.environment === 'production' || PROTECTED_ACTION_CLASSES.has(rule.actionClass);
}

function normalizeRule(rule, index) {
  assertExactKeys(rule, RULE_KEYS, RULE_KEYS, `rules[${index}]`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(rule.id ?? '')) {
    fail('invalid_policy', `rules[${index}].id must be a lowercase identifier`);
  }
  if (typeof rule.enabled !== 'boolean' || typeof rule.requiresArtifact !== 'boolean' || typeof rule.allowTotp !== 'boolean') {
    fail('invalid_policy', `rules[${index}] boolean fields are invalid`);
  }
  if (!ACTION_CLASSES.has(rule.actionClass)) {
    fail('invalid_policy', `rules[${index}].actionClass is invalid`);
  }

  const commitShas = stringList(rule.commitShas, `rules[${index}].commitShas`);
  if (commitShas.some((sha) => !/^[0-9a-f]{40}$/.test(sha))) {
    fail('invalid_policy', `rules[${index}].commitShas contains an invalid Git SHA`);
  }
  const artifactSha256s = stringList(rule.artifactSha256s, `rules[${index}].artifactSha256s`, {
    allowEmpty: !rule.requiresArtifact,
  });
  if (artifactSha256s.some((sha) => !isSha256(sha))) {
    fail('invalid_policy', `rules[${index}].artifactSha256s contains an invalid SHA-256 digest`);
  }
  const credentialRefs = stringList(rule.credentialRefs, `rules[${index}].credentialRefs`);
  if (credentialRefs.some((credentialRef) => !isLogicalCredentialRef(credentialRef))) {
    fail('invalid_policy', `rules[${index}].credentialRefs contains an invalid logical reference`);
  }

  return Object.freeze({
    id: rule.id,
    enabled: rule.enabled,
    credentialRefs,
    subjects: stringList(rule.subjects, `rules[${index}].subjects`),
    repositories: stringList(rule.repositories, `rules[${index}].repositories`),
    runIds: stringList(rule.runIds, `rules[${index}].runIds`),
    commitShas,
    providers: stringList(rule.providers, `rules[${index}].providers`),
    origins: Object.freeze(stringList(rule.origins, `rules[${index}].origins`).map((origin) => normalizeHttpsOrigin(origin))),
    redirectOrigins: Object.freeze(
      stringList(rule.redirectOrigins, `rules[${index}].redirectOrigins`, { allowEmpty: true })
        .map((origin) => normalizeHttpsOrigin(origin)),
    ),
    capabilities: stringList(rule.capabilities, `rules[${index}].capabilities`),
    resources: resourceList(rule.resources, `rules[${index}].resources`),
    adapters: stringList(rule.adapters, `rules[${index}].adapters`),
    accountIds: stringList(rule.accountIds, `rules[${index}].accountIds`),
    actionClass: rule.actionClass,
    authStrategies: authStrategyList(rule.authStrategies, `rules[${index}].authStrategies`),
    requiresArtifact: rule.requiresArtifact,
    artifactSha256s,
    allowTotp: rule.allowTotp,
    approvals: approvalList(rule.approvals, `rules[${index}].approvals`),
  });
}

function includesResource(resources, requested) {
  return resources.some(
    (resource) =>
      resource.kind === requested.kind &&
      resource.id === requested.id &&
      resource.environment === requested.environment,
  );
}

function matchesRule(rule, request) {
  const artifactMatches = rule.requiresArtifact
    ? request.artifact !== undefined && rule.artifactSha256s.includes(request.artifact.sha256)
    : request.artifact === undefined || rule.artifactSha256s.includes(request.artifact.sha256);

  return (
    rule.enabled &&
    rule.credentialRefs.includes(request.credentialRef) &&
    rule.subjects.includes(request.subject) &&
    rule.repositories.includes(request.repository) &&
    rule.runIds.includes(request.runId) &&
    rule.commitShas.includes(request.commitSha) &&
    rule.providers.includes(request.provider) &&
    rule.origins.includes(request.origin) &&
    request.redirectOrigins.every((origin) => rule.redirectOrigins.includes(origin)) &&
    rule.capabilities.includes(request.capability) &&
    includesResource(rule.resources, request.resource) &&
    rule.adapters.includes(request.adapterId) &&
    rule.accountIds.includes(request.accountId) &&
    rule.authStrategies.some((strategy) => isDeepStrictEqual(strategy, request.authFactors)) &&
    artifactMatches &&
    rule.approvals.some(
      (approval) =>
        approval.id === request.approval.id &&
        approval.mode === request.approval.mode &&
        approval.expiresAt === request.approval.expiresAt &&
        approval.maxUses === request.approval.maxUses,
    )
  );
}

export class PolicyEngine {
  constructor(policy) {
    assertExactKeys(policy, POLICY_KEYS, ['schemaVersion', 'generation', 'accounts', 'rules'], 'policy');
    if (policy.schemaVersion !== 1) {
      fail('invalid_policy', 'only policy schemaVersion 1 is supported');
    }
    if (!Number.isSafeInteger(policy.generation) || policy.generation < 1) {
      fail('invalid_policy', 'policy.generation must be a positive integer');
    }
    if (!Array.isArray(policy.rules) || policy.rules.length === 0) {
      fail('invalid_policy', 'policy.rules must be a non-empty array');
    }

    this.generation = policy.generation;
    this.accounts = new CanonicalAccountRegistry(policy.accounts);
    this.rules = Object.freeze(policy.rules.map(normalizeRule));
    Object.freeze(this);
  }

  #evaluate(rawRequest) {
    const request = normalizeLeaseRequest(rawRequest);
    if (request.policyGeneration !== this.generation) {
      fail('stale_policy_generation', 'lease request policy generation is stale');
    }

    if (Date.now() >= Date.parse(request.approval.expiresAt)) {
      fail('approval_expired', 'approval has expired');
    }
    const matchingRules = this.rules.filter((candidate) => matchesRule(candidate, request));
    if (matchingRules.length === 0) {
      fail('capability_forbidden', 'no enabled policy rule exactly matches the requested capability binding');
    }
    const account = this.accounts.require({
      provider: request.provider,
      accountId: request.accountId,
      credentialRefs: [request.credentialRef],
    });
    if (
      request.authFactors.some((factor) => factor === 'password' || factor === 'totp') &&
      account.kind !== 'dedicated_bot'
    ) {
      fail(
        'HUMAN_REAUTH_REQUIRED',
        'personal account password or TOTP automation is forbidden',
        { reason: 'policy_blocked' },
      );
    }
    const rule = request.authFactors.includes('totp')
      ? matchingRules.find((candidate) => candidate.allowTotp)
      : matchingRules[0];
    if (!rule) {
      fail('capability_forbidden', 'no enabled policy rule allows TOTP for this capability binding');
    }
    if (requiresPerRunApproval(request, rule) && request.approval.mode !== 'per_run') {
      fail('per_run_approval_required', 'production resources and protected action classes require a per-run approval');
    }

    const authStrategyIndex = rule.authStrategies.findIndex(
      (strategy) => isDeepStrictEqual(strategy, request.authFactors),
    );
    return Object.freeze({
      request,
      ruleId: rule.id,
      account,
      actionClass: rule.actionClass,
      authStrategyIndex,
      authStrategies: rule.authStrategies,
    });
  }

  authorize(rawRequest) {
    const authorized = this.#evaluate(rawRequest);
    if (authorized.authStrategyIndex > 0) {
      fail(
        'durable_auth_strategy_evidence_required',
        'fallback authentication strategies require durable same-run failure evidence',
      );
    }
    return authorized;
  }

  evaluateForDurableState(rawRequest) {
    return this.#evaluate(rawRequest);
  }
}
