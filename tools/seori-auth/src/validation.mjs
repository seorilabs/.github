import { isDeepStrictEqual } from 'node:util';

import { fail } from './errors.mjs';

const CREDENTIAL_REF = /^(shared|app)\/[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)+$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SIMPLE_ID = /^[a-z0-9][a-z0-9-]*$/;
const CAPABILITY = /^[a-z0-9][a-z0-9.-]*$/;
const AUDIT_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const FACTORS = new Set(['api_key', 'certificate', 'oidc', 'password', 'session', 'totp']);

const REQUEST_KEYS = new Set([
  'credentialRef',
  'credentialGeneration',
  'policyGeneration',
  'subject',
  'runId',
  'repository',
  'commitSha',
  'provider',
  'origin',
  'redirectOrigins',
  'capability',
  'resource',
  'artifact',
  'adapterId',
  'accountId',
  'authFactors',
  'approval',
]);

function assertOnlyKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_request', `${label} must be an object`);
  }

  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail('invalid_request', `${label} contains unsupported field: ${key}`);
    }
  }
}

function requiredString(value, label, maxLength = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    fail('invalid_request', `${label} must be a non-empty string`);
  }
  return value;
}

function auditSafeId(value, label) {
  if (typeof value !== 'string' || !AUDIT_SAFE_ID.test(value)) {
    fail('invalid_request', `${label} must be a log-safe public identifier`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('invalid_request', `${label} must be a positive integer`);
  }
  return value;
}

export function normalizeHttpsOrigin(value, label = 'origin') {
  requiredString(value, label);

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('invalid_origin', `${label} must be a valid URL origin`);
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    value !== parsed.origin
  ) {
    fail('invalid_origin', `${label} must be an exact HTTPS origin without path, query, fragment, or credentials`);
  }

  return parsed.origin;
}

function normalizeResource(resource) {
  assertOnlyKeys(resource, new Set(['kind', 'id', 'environment']), 'resource');
  return Object.freeze({
    kind: auditSafeId(resource.kind, 'resource.kind'),
    id: auditSafeId(resource.id, 'resource.id'),
    environment: auditSafeId(resource.environment, 'resource.environment'),
  });
}

function normalizeArtifact(artifact) {
  if (artifact === undefined) {
    return undefined;
  }

  assertOnlyKeys(artifact, new Set(['sha256', 'sizeBytes']), 'artifact');
  if (!SHA256.test(artifact.sha256 ?? '')) {
    fail('invalid_request', 'artifact.sha256 must be a lowercase SHA-256 digest');
  }
  if (artifact.sizeBytes !== undefined && (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0)) {
    fail('invalid_request', 'artifact.sizeBytes must be a non-negative integer');
  }

  return Object.freeze({
    sha256: artifact.sha256,
    ...(artifact.sizeBytes === undefined ? {} : { sizeBytes: artifact.sizeBytes }),
  });
}

function normalizeApproval(approval) {
  assertOnlyKeys(approval, new Set(['id', 'mode', 'expiresAt', 'maxUses']), 'approval');
  const id = auditSafeId(approval.id, 'approval.id');
  if (!['preapproved', 'per_run'].includes(approval.mode)) {
    fail('invalid_request', 'approval.mode must be preapproved or per_run');
  }
  if (
    typeof approval.expiresAt !== 'string' || !Number.isFinite(Date.parse(approval.expiresAt)) ||
    approval.expiresAt !== new Date(approval.expiresAt).toISOString()
  ) {
    fail('invalid_request', 'approval.expiresAt must be a canonical ISO timestamp');
  }
  if (approval.maxUses !== 1) fail('invalid_request', 'approval.maxUses must be one');
  return Object.freeze({ id, mode: approval.mode, expiresAt: approval.expiresAt, maxUses: 1 });
}

export function normalizeLeaseRequest(request) {
  assertOnlyKeys(request, REQUEST_KEYS, 'lease request');

  if (!CREDENTIAL_REF.test(request.credentialRef ?? '')) {
    fail('invalid_credential_ref', 'credentialRef must be a logical shared/... or app/... reference');
  }
  if (!REPOSITORY.test(request.repository ?? '')) {
    fail('invalid_request', 'repository must be owner/name');
  }
  if (!SHA1.test(request.commitSha ?? '')) {
    fail('invalid_request', 'commitSha must be a lowercase 40-character Git SHA');
  }
  if (!SIMPLE_ID.test(request.provider ?? '')) {
    fail('invalid_request', 'provider must be a lowercase identifier');
  }
  if (!CAPABILITY.test(request.capability ?? '')) {
    fail('invalid_request', 'capability must be a lowercase dotted identifier');
  }
  if (!SIMPLE_ID.test(request.adapterId ?? '')) {
    fail('invalid_request', 'adapterId must be a lowercase identifier');
  }
  auditSafeId(request.accountId, 'accountId');
  if (
    !Array.isArray(request.redirectOrigins) ||
    request.redirectOrigins.length > 8 ||
    new Set(request.redirectOrigins).size !== request.redirectOrigins.length
  ) {
    fail('invalid_request', 'redirectOrigins must be a unique array with at most 8 entries');
  }
  if (!Array.isArray(request.authFactors) || new Set(request.authFactors).size !== request.authFactors.length) {
    fail('invalid_request', 'authFactors must be a unique array');
  }
  for (const factor of request.authFactors) {
    if (!FACTORS.has(factor)) {
      fail('invalid_request', `unsupported auth factor: ${factor}`);
    }
  }

  return Object.freeze({
    credentialRef: request.credentialRef,
    credentialGeneration: positiveInteger(request.credentialGeneration, 'credentialGeneration'),
    policyGeneration: positiveInteger(request.policyGeneration, 'policyGeneration'),
    subject: auditSafeId(request.subject, 'subject'),
    runId: auditSafeId(request.runId, 'runId'),
    repository: request.repository,
    commitSha: request.commitSha,
    provider: request.provider,
    origin: normalizeHttpsOrigin(request.origin),
    redirectOrigins: Object.freeze(
      request.redirectOrigins.map((origin, index) => normalizeHttpsOrigin(origin, `redirectOrigins[${index}]`)),
    ),
    capability: request.capability,
    resource: normalizeResource(request.resource),
    ...(request.artifact === undefined ? {} : { artifact: normalizeArtifact(request.artifact) }),
    adapterId: request.adapterId,
    accountId: request.accountId,
    authFactors: Object.freeze([...request.authFactors]),
    approval: normalizeApproval(request.approval),
  });
}

export function equalBinding(left, right) {
  return isDeepStrictEqual(left, right);
}

export function isSha256(value) {
  return SHA256.test(value);
}

export function isLogicalCredentialRef(value) {
  return typeof value === 'string' && CREDENTIAL_REF.test(value);
}
