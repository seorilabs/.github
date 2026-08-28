import { createHash, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { fail } from './errors.mjs';
import { isLogicalCredentialRef, normalizeHttpsOrigin, normalizeLeaseRequest } from './validation.mjs';

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ADAPTER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CAPABILITY = /^[a-z0-9][a-z0-9.-]{0,190}$/;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const RESOURCE_TYPE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,63}$/;
const AUTH_FACTORS = new Set(['api_key', 'certificate', 'oidc', 'password', 'session', 'totp']);
const OPERATIONS = new Set(['READBACK', 'APPLY', 'UPLOAD_INTERNAL']);
const RESULT_OUTCOMES = new Set(['SUCCESS', 'FAILED', 'HUMAN_REAUTH_REQUIRED']);
const PROVIDER_GRANT_TTL_MS = 5 * 60 * 1_000;
const MAX_PUBLIC_COMMAND_BYTES = 48 * 1024;
const MAX_PUBLIC_VALUE_DEPTH = 16;
const SENSITIVE_PUBLIC_FIELD = /(?:authorization|client[_-]?secret|cookie|credential|password|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|session[_-]?cookie|token|totp[_-]?seed)/i;
const PRIVATE_MATERIAL = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\bAIza[0-9A-Za-z_-]{35}\b|\bgh[opusr]_[A-Za-z0-9_]{20,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/i;

const COMMAND_KEYS = new Set([
  'schemaVersion', 'executionId', 'generation', 'resumeMode', 'adapterId', 'operation',
  'provider', 'origin', 'repository', 'repoId', 'sourceSha', 'configRevision', 'desiredHash',
  'desired', 'resource', 'artifactChecksum', 'credential', 'approval', 'bindingHash',
]);
const RESOURCE_KEYS = new Set(['type', 'id', 'environment', 'expectedPublicIdentity']);
const CREDENTIAL_KEYS = new Set([
  'logicalId', 'generation', 'policyGeneration', 'capability', 'publicAccountId',
  'publicIdentity', 'authFactors',
]);
const APPROVAL_KEYS = new Set(['id', 'mode', 'expiresAt', 'maxUses']);
const GRANT_KEYS = new Set([
  'schemaVersion', 'id', 'policyGeneration', 'bindingHash', 'commandDigest', 'expiresAt',
  'maxUses', 'rule', 'command',
]);
const RULE_KEYS = new Set([
  'id', 'enabled', 'credentialRefs', 'subjects', 'repositories', 'runIds', 'commitShas',
  'providers', 'origins', 'redirectOrigins', 'capabilities', 'resources', 'adapters',
  'accountIds', 'actionClass', 'authStrategies', 'requiresArtifact', 'artifactSha256s',
  'allowTotp', 'approvals',
]);

function exactObject(value, keys, label, code = 'invalid_provider_grant') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.size || actual.some((key) => !keys.has(key))) {
    fail(code, `${label} fields are invalid`);
  }
}

function exactObjectWithOptional(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_provider_observation', `${label} must be an object`);
  }
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  if (
    required.some((key) => !(key in value)) || actual.some((key) => !allowed.has(key)) ||
    actual.length < required.length || actual.length > allowed.size
  ) fail('invalid_provider_observation', `${label} fields are invalid`);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('invalid_provider_grant', `${label} must be a positive integer`);
  }
  return value;
}

function publicId(value, label) {
  if (typeof value !== 'string' || !PUBLIC_ID.test(value)) {
    fail('invalid_provider_grant', `${label} must be a log-safe public identifier`);
  }
  return value;
}

function publicString(value, label, maximum = 512) {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value) || PRIVATE_MATERIAL.test(value)
  ) {
    fail('invalid_provider_grant', `${label} must contain public non-sensitive text`);
  }
  return value;
}

function canonicalIso(value, label) {
  if (
    typeof value !== 'string' || !Number.isFinite(Date.parse(value)) ||
    value !== new Date(value).toISOString()
  ) {
    fail('invalid_provider_grant', `${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function normalizePublicJson(value, label, depth = 0) {
  if (depth > MAX_PUBLIC_VALUE_DEPTH) {
    fail('invalid_provider_grant', `${label} exceeds the public JSON depth limit`);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string') publicString(value, label, 2_048);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid_provider_grant', `${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) fail('invalid_provider_grant', `${label} contains too many items`);
    return Object.freeze(value.map((nested, index) => normalizePublicJson(nested, `${label}[${index}]`, depth + 1)));
  }
  if (!value || typeof value !== 'object') {
    fail('invalid_provider_grant', `${label} must be JSON data`);
  }
  const entries = Object.entries(value);
  if (entries.length > 256) fail('invalid_provider_grant', `${label} contains too many fields`);
  // Public provider payloads are untrusted JSON. A null prototype keeps keys
  // such as `__proto__` and `constructor` as inert data during normalization.
  const normalized = Object.create(null);
  for (const [key, nested] of entries) {
    if (
      key.length === 0 || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key) ||
      SENSITIVE_PUBLIC_FIELD.test(key)
    ) {
      fail('invalid_provider_grant', `${label} contains a forbidden field`);
    }
    normalized[key] = normalizePublicJson(nested, `${label}.${key}`, depth + 1);
  }
  return deepFreeze(normalized);
}

export function canonicalPublicJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalPublicJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort((left, right) => left.localeCompare(right)).map((key) =>
      `${JSON.stringify(key)}:${canonicalPublicJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function publicJsonDigest(value) {
  return createHash('sha256').update(canonicalPublicJson(value), 'utf8').digest('hex');
}

function exactDigest(actual, expected, label) {
  if (!SHA256.test(actual ?? '') || !SHA256.test(expected ?? '')) {
    fail('invalid_provider_grant', `${label} must be a lowercase SHA-256 digest`);
  }
  if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))) {
    fail('provider_grant_binding_mismatch', `${label} does not match the exact provider grant binding`);
  }
}

function normalizeApproval(value) {
  exactObject(value, APPROVAL_KEYS, 'provider approval');
  if (!['preapproved', 'per_run'].includes(value.mode) || value.maxUses !== 1) {
    fail('invalid_provider_grant', 'provider approval policy is invalid');
  }
  return Object.freeze({
    id: publicId(value.id, 'provider approval id'),
    mode: value.mode,
    expiresAt: canonicalIso(value.expiresAt, 'provider approval expiry'),
    maxUses: 1,
  });
}

export function normalizeProviderCommandEnvelope(value) {
  exactObject(value, COMMAND_KEYS, 'provider command');
  if (value.schemaVersion !== 1 || !OPERATIONS.has(value.operation)) {
    fail('invalid_provider_grant', 'provider command version or operation is invalid');
  }
  if (!['START', 'READBACK_FIRST'].includes(value.resumeMode)) {
    fail('invalid_provider_grant', 'provider command resume mode is invalid');
  }
  if (value.resumeMode === 'READBACK_FIRST' && value.operation !== 'READBACK') {
    fail('invalid_provider_grant', 'readback-first provider command may only perform READBACK');
  }
  if (!ADAPTER.test(value.adapterId ?? '') || !PROVIDER.test(value.provider ?? '')) {
    fail('invalid_provider_grant', 'provider command adapter or provider is invalid');
  }
  if (!REPOSITORY.test(value.repository ?? '') || !/^\d{1,30}$/.test(value.repoId ?? '')) {
    fail('invalid_provider_grant', 'provider command repository binding is invalid');
  }
  if (!SHA1.test(value.sourceSha ?? '') || !SHA256.test(value.desiredHash ?? '') || !SHA256.test(value.bindingHash ?? '')) {
    fail('invalid_provider_grant', 'provider command source or digest binding is invalid');
  }
  exactObject(value.resource, RESOURCE_KEYS, 'provider resource');
  if (!RESOURCE_TYPE.test(value.resource.type ?? '')) {
    fail('invalid_provider_grant', 'provider resource type is invalid');
  }
  exactObject(value.credential, CREDENTIAL_KEYS, 'provider credential metadata');
  if (!isLogicalCredentialRef(value.credential.logicalId) || !CAPABILITY.test(value.credential.capability ?? '')) {
    fail('invalid_provider_grant', 'provider logical credential metadata is invalid');
  }
  if (
    !Array.isArray(value.credential.authFactors) || value.credential.authFactors.length < 1 ||
    value.credential.authFactors.length > 3 ||
    new Set(value.credential.authFactors).size !== value.credential.authFactors.length ||
    value.credential.authFactors.some((factor) => !AUTH_FACTORS.has(factor))
  ) {
    fail('invalid_provider_grant', 'provider authentication factors are invalid');
  }
  const desired = normalizePublicJson(value.desired, 'provider desired state');
  const desiredEncoded = canonicalPublicJson(desired);
  if (Buffer.byteLength(desiredEncoded) > MAX_PUBLIC_COMMAND_BYTES) {
    fail('invalid_provider_grant', 'provider desired state exceeds the public command limit');
  }
  exactDigest(publicJsonDigest(desired), value.desiredHash, 'provider desired state digest');
  const approval = normalizeApproval(value.approval);
  const command = {
    schemaVersion: 1,
    executionId: publicId(value.executionId, 'provider execution id'),
    generation: positiveInteger(value.generation, 'provider execution generation'),
    resumeMode: value.resumeMode,
    adapterId: value.adapterId,
    operation: value.operation,
    provider: value.provider,
    origin: normalizeHttpsOrigin(value.origin, 'provider origin'),
    repository: value.repository,
    repoId: value.repoId,
    sourceSha: value.sourceSha,
    configRevision: positiveInteger(value.configRevision, 'config revision'),
    desiredHash: value.desiredHash,
    desired,
    resource: Object.freeze({
      type: value.resource.type,
      id: publicId(value.resource.id, 'provider resource id'),
      environment: publicId(value.resource.environment, 'provider resource environment'),
      expectedPublicIdentity: value.resource.expectedPublicIdentity === null
        ? null
        : publicString(value.resource.expectedPublicIdentity, 'expected provider public identity'),
    }),
    artifactChecksum: value.artifactChecksum === null
      ? null
      : (() => {
          if (!SHA256.test(value.artifactChecksum ?? '')) {
            fail('invalid_provider_grant', 'provider artifact checksum is invalid');
          }
          return value.artifactChecksum;
        })(),
    credential: Object.freeze({
      logicalId: value.credential.logicalId,
      generation: positiveInteger(value.credential.generation, 'credential generation'),
      policyGeneration: positiveInteger(value.credential.policyGeneration, 'policy generation'),
      capability: value.credential.capability,
      publicAccountId: publicString(value.credential.publicAccountId, 'provider public account id', 191),
      publicIdentity: publicString(value.credential.publicIdentity, 'credential public identity'),
      authFactors: Object.freeze([...value.credential.authFactors]),
    }),
    approval,
    bindingHash: value.bindingHash,
  };
  if (Buffer.byteLength(canonicalPublicJson(command)) > MAX_PUBLIC_COMMAND_BYTES) {
    fail('invalid_provider_grant', 'provider command exceeds the public command limit');
  }
  return deepFreeze(command);
}

function actionClass(command) {
  if (command.operation === 'READBACK') return 'read_only';
  if (command.operation === 'UPLOAD_INTERNAL') return 'internal_upload';
  return 'other_mutation';
}

export function providerGrantRequiresPerRunApproval(command) {
  const classified = actionClass(command);
  // Production readback uses the separately bound fleet inventory identity and is
  // the recovery gate after an uncertain mutation. Requiring a per-run approval
  // here would prevent READBACK_FIRST from resolving the uncertainty at all.
  return classified === 'other_mutation' ||
    (command.resource.environment === 'production' && classified !== 'read_only');
}

function singleton(value, expected, label) {
  if (!Array.isArray(value) || value.length !== 1 || !isDeepStrictEqual(value[0], expected)) {
    fail('provider_grant_binding_mismatch', `${label} is not the exact singleton binding`);
  }
}

function validateGrantRule(rule, grant, command, subject) {
  exactObject(rule, RULE_KEYS, 'provider grant rule');
  if (rule.id !== grant.id || rule.enabled !== true || rule.actionClass !== actionClass(command)) {
    fail('provider_grant_binding_mismatch', 'provider grant rule identity is not exact');
  }
  singleton(rule.credentialRefs, command.credential.logicalId, 'credential reference');
  singleton(rule.subjects, subject, 'subject');
  singleton(rule.repositories, command.repository, 'repository');
  singleton(rule.runIds, command.executionId, 'run id');
  singleton(rule.commitShas, command.sourceSha, 'source SHA');
  singleton(rule.providers, command.provider, 'provider');
  singleton(rule.origins, command.origin, 'origin');
  if (!Array.isArray(rule.redirectOrigins) || rule.redirectOrigins.length !== 0) {
    fail('provider_grant_binding_mismatch', 'redirect origins must be empty for a provider command');
  }
  singleton(rule.capabilities, command.credential.capability, 'capability');
  singleton(rule.resources, {
    kind: `${command.provider}.${command.resource.type}`,
    id: `binding:${command.bindingHash}`,
    environment: command.resource.environment,
  }, 'resource');
  singleton(rule.adapters, command.adapterId, 'adapter');
  singleton(rule.accountIds, command.credential.publicAccountId, 'public account');
  singleton(rule.authStrategies, command.credential.authFactors, 'authentication strategy');
  singleton(rule.approvals, command.approval, 'approval');
  const hasArtifact = command.artifactChecksum !== null;
  if (
    rule.requiresArtifact !== hasArtifact ||
    !Array.isArray(rule.artifactSha256s) ||
    !isDeepStrictEqual(rule.artifactSha256s, hasArtifact ? [command.artifactChecksum] : []) ||
    rule.allowTotp !== command.credential.authFactors.includes('totp')
  ) {
    fail('provider_grant_binding_mismatch', 'provider grant artifact or factor policy is not exact');
  }
}

export function normalizeProviderGrantRegistration(value, { subject, now = Date.now() } = {}) {
  exactObject(value, new Set(['idempotencyKey', 'workerId', 'grant', 'digest']), 'provider grant registration');
  const normalizedSubject = publicId(subject, 'attested provider subject');
  const workerId = publicId(value.workerId, 'provider worker id');
  const idempotencyKey = publicId(value.idempotencyKey, 'provider grant idempotency key');
  exactObject(value.grant, GRANT_KEYS, 'provider grant');
  const command = normalizeProviderCommandEnvelope(value.grant.command);
  const expectedId = `provider-grant-${command.bindingHash.slice(0, 40)}-${command.generation}`;
  if (
    value.grant.schemaVersion !== 1 || value.grant.id !== expectedId ||
    value.grant.policyGeneration !== command.credential.policyGeneration ||
    value.grant.bindingHash !== command.bindingHash || value.grant.maxUses !== 1
  ) {
    fail('provider_grant_binding_mismatch', 'provider grant top-level binding is not exact');
  }
  const expiresAt = canonicalIso(value.grant.expiresAt, 'provider grant expiry');
  if (
    !Number.isSafeInteger(now) || Date.parse(expiresAt) <= now ||
    Date.parse(expiresAt) > now + PROVIDER_GRANT_TTL_MS ||
    Date.parse(expiresAt) > Date.parse(command.approval.expiresAt)
  ) {
    fail('approval_expired', 'provider grant must be unexpired and no longer than five minutes');
  }
  if (providerGrantRequiresPerRunApproval(command) && command.approval.mode !== 'per_run') {
    fail('per_run_approval_required', 'protected provider actions require per-run approval');
  }
  exactDigest(publicJsonDigest(command), value.grant.commandDigest, 'provider command digest');
  validateGrantRule(value.grant.rule, value.grant, command, normalizedSubject);
  const grant = deepFreeze({
    schemaVersion: 1,
    id: value.grant.id,
    policyGeneration: value.grant.policyGeneration,
    bindingHash: value.grant.bindingHash,
    commandDigest: value.grant.commandDigest,
    expiresAt,
    maxUses: 1,
    rule: structuredClone(value.grant.rule),
    command,
  });
  exactDigest(publicJsonDigest(grant), value.digest, 'provider grant digest');
  return Object.freeze({ idempotencyKey, workerId, subject: normalizedSubject, digest: value.digest, grant });
}

export function normalizeProviderGrantExpectation(value, { includeGeneration = false, includeIdempotencyKey = false } = {}) {
  const keys = [
    'workerId', 'expectedDigest', 'expectedBindingHash', 'expectedCommandDigest',
    'expectedPolicyGeneration',
    ...(includeGeneration ? ['expectedExecutionGeneration'] : []),
    ...(includeIdempotencyKey ? ['idempotencyKey'] : []),
  ];
  exactObject(value, new Set(keys), 'provider grant expectation');
  return Object.freeze({
    workerId: publicId(value.workerId, 'provider worker id'),
    expectedDigest: (() => {
      if (!SHA256.test(value.expectedDigest ?? '')) fail('invalid_provider_grant', 'expected grant digest is invalid');
      return value.expectedDigest;
    })(),
    expectedBindingHash: (() => {
      if (!SHA256.test(value.expectedBindingHash ?? '')) fail('invalid_provider_grant', 'expected binding hash is invalid');
      return value.expectedBindingHash;
    })(),
    expectedCommandDigest: (() => {
      if (!SHA256.test(value.expectedCommandDigest ?? '')) fail('invalid_provider_grant', 'expected command digest is invalid');
      return value.expectedCommandDigest;
    })(),
    expectedPolicyGeneration: positiveInteger(value.expectedPolicyGeneration, 'expected policy generation'),
    ...(includeGeneration ? {
      expectedGeneration: positiveInteger(value.expectedExecutionGeneration, 'expected provider execution generation'),
    } : {}),
    ...(includeIdempotencyKey ? { idempotencyKey: publicId(value.idempotencyKey, 'provider consume idempotency key') } : {}),
  });
}

export function assertProviderGrantExpectation(entity, expectation) {
  for (const [actual, expected, label] of [
    [entity.digest, expectation.expectedDigest, 'provider grant digest'],
    [entity.bindingHash, expectation.expectedBindingHash, 'provider binding hash'],
    [entity.commandDigest, expectation.expectedCommandDigest, 'provider command digest'],
  ]) exactDigest(actual, expected, label);
  if (entity.policyGeneration !== expectation.expectedPolicyGeneration) {
    fail('stale_policy_generation', 'provider grant policy generation is stale');
  }
}

export function providerGrantLeaseRequest(command, subject) {
  return normalizeLeaseRequest({
    credentialRef: command.credential.logicalId,
    credentialGeneration: command.credential.generation,
    policyGeneration: command.credential.policyGeneration,
    subject,
    runId: command.executionId,
    repository: command.repository,
    commitSha: command.sourceSha,
    provider: command.provider,
    origin: command.origin,
    redirectOrigins: [],
    capability: command.credential.capability,
    resource: {
      kind: `${command.provider}.${command.resource.type}`,
      id: `binding:${command.bindingHash}`,
      environment: command.resource.environment,
    },
    ...(command.artifactChecksum === null ? {} : { artifact: { sha256: command.artifactChecksum } }),
    adapterId: command.adapterId,
    accountId: command.credential.publicAccountId,
    authFactors: command.credential.authFactors,
    approval: command.approval,
  });
}

function normalizeBlueprintObservation(value) {
  exactObject(
    value,
    new Set(['kind', 'observedAt', 'payload']),
    'blueprint provider observation',
    'invalid_provider_observation',
  );
  if (value.kind !== 'BLUEPRINT') fail('invalid_provider_observation', 'provider observation kind is invalid');
  exactObjectWithOptional(
    value.payload,
    ['schemaVersion', 'visibility', 'state', 'attributes'],
    ['publicIdentity'],
    'blueprint readback',
  );
  if (
    value.payload.schemaVersion !== 1 || !['VISIBLE', 'FORBIDDEN', 'ERROR'].includes(value.payload.visibility) ||
    !['PRESENT', 'ABSENT', 'UNKNOWN'].includes(value.payload.state) ||
    (value.payload.visibility !== 'VISIBLE' && value.payload.state !== 'UNKNOWN')
  ) fail('invalid_provider_observation', 'blueprint readback state is invalid');
  return deepFreeze({
    kind: 'BLUEPRINT',
    observedAt: canonicalIso(value.observedAt, 'provider observation time'),
    payload: {
      schemaVersion: 1,
      visibility: value.payload.visibility,
      state: value.payload.state,
      ...(value.payload.publicIdentity === undefined ? {} : {
        publicIdentity: publicString(value.payload.publicIdentity, 'observed provider public identity'),
      }),
      attributes: normalizePublicJson(value.payload.attributes, 'provider observation attributes'),
    },
  });
}

function normalizeMarketObservation(value) {
  exactObject(value, new Set(['kind', 'payload']), 'market provider observation', 'invalid_provider_observation');
  if (value.kind !== 'MARKET') fail('invalid_provider_observation', 'provider observation kind is invalid');
  const required = [
    'schemaVersion', 'market', 'publicAccountId', 'publicAppId', 'gate', 'state', 'sourceSha',
    'configRevision', 'artifactChecksum', 'observedAt',
  ];
  exactObjectWithOptional(value.payload, required, ['providerReference'], 'market readback');
  if (
    value.payload.schemaVersion !== 1 ||
    !['google-play', 'app-store', 'apps-in-toss'].includes(value.payload.market) ||
    !['UPLOAD', 'PROCESSING', 'DEVICE_QA', 'REVIEW', 'APPROVAL', 'DEPLOYMENT', 'PUBLIC'].includes(value.payload.gate) ||
    !['QUEUED', 'IN_PROGRESS', 'SUCCEEDED', 'APPROVED', 'LIVE', 'FAILED', 'REJECTED', 'HUMAN_REQUIRED'].includes(value.payload.state) ||
    !SHA1.test(value.payload.sourceSha ?? '') || !SHA256.test(value.payload.artifactChecksum ?? '')
  ) fail('invalid_provider_observation', 'market readback binding is invalid');
  return deepFreeze({
    kind: 'MARKET',
    payload: {
      schemaVersion: 1,
      market: value.payload.market,
      publicAccountId: publicString(value.payload.publicAccountId, 'market public account id', 191),
      publicAppId: publicString(value.payload.publicAppId, 'market public app id', 255),
      gate: value.payload.gate,
      state: value.payload.state,
      sourceSha: value.payload.sourceSha,
      configRevision: positiveInteger(value.payload.configRevision, 'market config revision'),
      artifactChecksum: value.payload.artifactChecksum,
      ...(value.payload.providerReference === undefined ? {} : {
        providerReference: publicString(value.payload.providerReference, 'market provider reference'),
      }),
      observedAt: canonicalIso(value.payload.observedAt, 'market observation time'),
    },
  });
}

export function normalizeProviderObservation(value) {
  if (value?.kind === 'BLUEPRINT') return normalizeBlueprintObservation(value);
  if (value?.kind === 'MARKET') return normalizeMarketObservation(value);
  fail('invalid_provider_observation', 'provider observation kind is invalid');
}

function assertObservationBinding(observation, command) {
  const marketProvider = ['google-play', 'app-store', 'apps-in-toss'].includes(command.provider);
  if (marketProvider !== (observation.kind === 'MARKET')) {
    fail('provider_observation_binding_mismatch', 'provider observation kind does not match the command provider');
  }
  if (observation.kind === 'BLUEPRINT') {
    if (
      observation.payload.visibility === 'VISIBLE' && observation.payload.state === 'PRESENT' &&
      command.resource.expectedPublicIdentity !== null &&
      observation.payload.publicIdentity !== command.resource.expectedPublicIdentity
    ) {
      fail('provider_observation_binding_mismatch', 'provider observation public identity does not match');
    }
    return;
  }
  const payload = observation.payload;
  if (
    payload.market !== command.provider || payload.publicAccountId !== command.credential.publicAccountId ||
    payload.publicAppId !== command.resource.id || payload.sourceSha !== command.sourceSha ||
    payload.configRevision !== command.configRevision || payload.artifactChecksum !== command.artifactChecksum
  ) {
    fail('provider_observation_binding_mismatch', 'market observation does not match the exact command binding');
  }
}

export function normalizeProviderAdapterResult(value, command) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 || !RESULT_OUTCOMES.has(value.outcome)) {
    fail('invalid_adapter_result', 'trusted provider adapter returned an invalid result');
  }
  if (value.outcome === 'SUCCESS') {
    const keys = new Set(['schemaVersion', 'outcome', ...(value.observation === undefined ? [] : ['observation'])]);
    exactObject(value, keys, 'provider adapter success', 'invalid_adapter_result');
    if (command.operation === 'READBACK' && value.observation === undefined) {
      fail('invalid_adapter_result', 'provider READBACK requires a separate public observation');
    }
    const normalized = deepFreeze({
      schemaVersion: 1,
      outcome: 'SUCCESS',
      ...(value.observation === undefined ? {} : { observation: normalizeProviderObservation(value.observation) }),
    });
    if (normalized.observation) assertObservationBinding(normalized.observation, command);
    return normalized;
  }
  exactObject(
    value,
    new Set(['schemaVersion', 'outcome', 'errorCode']),
    'provider adapter failure',
    'invalid_adapter_result',
  );
  const errorCode = publicId(value.errorCode, 'provider adapter error code');
  if (value.outcome === 'HUMAN_REAUTH_REQUIRED' && errorCode !== 'HUMAN_REAUTH_REQUIRED') {
    fail('invalid_adapter_result', 'human reauthentication result code is not exact');
  }
  return Object.freeze({ schemaVersion: 1, outcome: value.outcome, errorCode });
}

export function providerGrantActionClass(command) {
  return actionClass(command);
}

export const PROVIDER_CONTROL_PLANE_ENDPOINT_SCOPE = '/internal/control-plane/provider-grants';
export const PROVIDER_CONTROL_PLANE_CLIENT_SPIFFE_ID =
  'spiffe://seorilabs.local/ns/platform/sa/provider-execution-signer';
export const PROVIDER_GRANT_MAX_TTL_MS = PROVIDER_GRANT_TTL_MS;
