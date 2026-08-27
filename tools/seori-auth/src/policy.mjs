import { fail } from './errors.mjs';
import { isSha256, normalizeHttpsOrigin, normalizeLeaseRequest } from './validation.mjs';

const POLICY_KEYS = new Set(['$schema', 'schemaVersion', 'generation', 'rules']);
const RULE_KEYS = new Set([
  'id',
  'enabled',
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
  'accountKinds',
  'requiresArtifact',
  'artifactSha256s',
  'allowTotp',
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

function normalizeRule(rule, index) {
  assertExactKeys(rule, RULE_KEYS, RULE_KEYS, `rules[${index}]`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(rule.id ?? '')) {
    fail('invalid_policy', `rules[${index}].id must be a lowercase identifier`);
  }
  if (typeof rule.enabled !== 'boolean' || typeof rule.requiresArtifact !== 'boolean' || typeof rule.allowTotp !== 'boolean') {
    fail('invalid_policy', `rules[${index}] boolean fields are invalid`);
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

  return Object.freeze({
    id: rule.id,
    enabled: rule.enabled,
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
    accountKinds: stringList(rule.accountKinds, `rules[${index}].accountKinds`),
    requiresArtifact: rule.requiresArtifact,
    artifactSha256s,
    allowTotp: rule.allowTotp,
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
    rule.accountKinds.includes(request.accountKind) &&
    artifactMatches &&
    (!request.authFactors.includes('totp') || (rule.allowTotp && request.accountKind === 'dedicated_bot'))
  );
}

export class PolicyEngine {
  constructor(policy) {
    assertExactKeys(policy, POLICY_KEYS, ['schemaVersion', 'generation', 'rules'], 'policy');
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
    this.rules = Object.freeze(policy.rules.map(normalizeRule));
    Object.freeze(this);
  }

  authorize(rawRequest) {
    const request = normalizeLeaseRequest(rawRequest);
    if (request.policyGeneration !== this.generation) {
      fail('stale_policy_generation', 'lease request policy generation is stale');
    }

    const rule = this.rules.find((candidate) => matchesRule(candidate, request));
    if (!rule) {
      fail('capability_forbidden', 'no enabled policy rule exactly matches the requested capability binding');
    }

    return Object.freeze({ request, ruleId: rule.id });
  }
}
