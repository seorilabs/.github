import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { fail, SeoriAuthError } from './errors.mjs';
import { LEASE_TTL_MS } from './lease-store.mjs';
import { NATIVE_FILE_LOCK_BRAND } from './native-lock-brand.mjs';
import {
  assertProviderGrantExpectation,
  normalizeProviderAdapterResult,
  normalizeProviderGrantRegistration,
  providerGrantActionClass,
  publicJsonDigest,
} from './provider-grants.mjs';
import { classifyReauth } from './reauth.mjs';
import { normalizeLeaseRequest } from './validation.mjs';

const AUDIT_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const CAPABILITY = /^[a-z0-9][a-z0-9.-]*$/;
const PROVIDER = /^[a-z0-9][a-z0-9-]*$/;
const CREDENTIAL_REF = /^(shared|app)\/[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)+$/;
const BROWSER_ROLE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const JOURNAL_FILE = 'auth-journal.jsonl';
const JOURNAL_WRITER_LOCK_FILE = '.auth-journal.writer.lock';
const JOURNAL_GENESIS_MAC = '0'.repeat(64);
const JOURNAL_MAC = /^[0-9a-f]{64}$/;
export const DURABLE_JOURNAL_ENVELOPE = Object.freeze({
  schemaVersion: 2,
  contentPolicy: 'SECRET_FREE_PUBLIC_CONTROL_AND_AUDIT_ONLY',
  integrity: 'HMAC_SHA256_CHAIN',
  writeValidation: 'FAIL_CLOSED_BEFORE_SERIALIZATION',
});
const EXECUTION_OUTCOMES = new Set([
  'SUCCESS',
  'ADAPTER_FAILED',
  'ADAPTER_NOT_TRUSTED',
  'ADAPTER_SCOPE_MISMATCH',
  'INVALID_ADAPTER',
  'SECRET_LOAD_FAILED',
  'ADAPTER_TIMEOUT',
  'ADAPTER_START_FAILED',
  'ADAPTER_OUTPUT_LIMIT',
  'INVALID_ADAPTER_RESULT',
  'ADAPTER_RESULT_SECRET_DETECTED',
  'HUMAN_REAUTH_REQUIRED',
]);
const AUTH_STRATEGY_FAILURE_OUTCOMES = new Set(['ADAPTER_FAILED', 'ADAPTER_TIMEOUT']);
const ACTION_CLASS = /^[a-z][a-z_]{1,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PROVIDER_GRANT_STATES = new Set(['ACTIVE', 'CONSUMED', 'COMPLETED']);
const PROVIDER_EXECUTION_RESULTS = new Set(['SUCCESS', 'FAILED', 'HUMAN_REAUTH_REQUIRED']);
const AUTH_ENTITY_TYPES = new Set([
  'CredentialCheckout', 'BrowserSessionBinding', 'ReauthRequest', 'ProviderGrant', 'AttestationNonce',
]);
const RUN_ATTESTATION_MAX_TTL_MS = 5 * 60 * 1_000;
const RUN_ATTESTATION_ACTIVE_NONCE_LIMIT = 10_000;

const BINDING_KEYS = new Set(['subject', 'runId', 'repository', 'workerId']);
const IDENTITY_KEYS = new Set(['provider', 'accountId', 'teamId', 'workspaceId', 'appId']);

export const HUMAN_REAUTH_REQUIRED = 'HUMAN_REAUTH_REQUIRED';

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_request', `${label} must be an object`);
  }
}

function assertExactKeys(value, allowed, label) {
  assertObject(value, label);
  const keys = Object.keys(value);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    fail('invalid_request', `${label} fields are invalid`);
  }
}

function publicId(value, label) {
  if (typeof value !== 'string' || !AUDIT_SAFE_ID.test(value)) {
    fail('invalid_request', `${label} must be a log-safe public identifier`);
  }
  return value;
}

function opaqueId(value, label) {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    fail('invalid_request', `${label} must be an opaque public identifier`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('invalid_request', `${label} must be a positive integer`);
  }
  return value;
}

function nullablePublicId(value, label) {
  return value === null ? null : publicId(value, label);
}

export function normalizeExecutionBinding(value) {
  assertExactKeys(value, BINDING_KEYS, 'execution binding');
  if (!REPOSITORY.test(value.repository ?? '')) {
    fail('invalid_request', 'execution binding repository must be owner/name');
  }
  return Object.freeze({
    subject: publicId(value.subject, 'execution binding subject'),
    runId: publicId(value.runId, 'execution binding runId'),
    repository: value.repository,
    workerId: publicId(value.workerId, 'execution binding workerId'),
  });
}

export function normalizePublicIdentity(value) {
  assertExactKeys(value, IDENTITY_KEYS, 'public identity');
  if (!PROVIDER.test(value.provider ?? '')) {
    fail('invalid_request', 'public identity provider must be a lowercase identifier');
  }
  return Object.freeze({
    provider: value.provider,
    accountId: publicId(value.accountId, 'public identity accountId'),
    teamId: nullablePublicId(value.teamId, 'public identity teamId'),
    workspaceId: nullablePublicId(value.workspaceId, 'public identity workspaceId'),
    appId: nullablePublicId(value.appId, 'public identity appId'),
  });
}

function leaseBinding(request, workerId) {
  return normalizeExecutionBinding({
    subject: request.subject,
    runId: request.runId,
    repository: request.repository,
    workerId,
  });
}

function reauthMatches(candidate, executionBinding, request) {
  return (
    isDeepStrictEqual(candidate.executionBinding, executionBinding) &&
    candidate.publicIdentity.provider === request.provider &&
    candidate.publicIdentity.accountId === request.accountId &&
    (candidate.publicIdentity.appId === null || candidate.publicIdentity.appId === request.resource.id)
  );
}

function normalizeBrowserAuthorization(value) {
  const keys = new Set([
    'actionClass', 'authStrategyIndex', 'leaseId', 'profileGeneration', 'request', 'role',
    'ruleId', 'strategyEvidenceKey',
  ]);
  assertExactKeys(value, keys, 'browser authorization');
  const request = normalizeLeaseRequest(value.request);
  if (!BROWSER_ROLE.test(value.role ?? '')) fail('invalid_request', 'browser authorization role is invalid');
  if (!ACTION_CLASS.test(value.actionClass ?? '')) {
    fail('invalid_request', 'browser authorization action class is invalid');
  }
  return Object.freeze({
    leaseId: opaqueId(value.leaseId, 'browser authorization lease id'),
    ruleId: publicId(value.ruleId, 'browser authorization rule id'),
    actionClass: value.actionClass,
    authStrategyIndex: nonNegativeInteger(value.authStrategyIndex, 'browser authorization strategy index'),
    strategyEvidenceKey: sha256(value.strategyEvidenceKey, 'browser authorization strategy evidence key'),
    profileGeneration: positiveInteger(value.profileGeneration, 'browser profile generation'),
    role: value.role,
    request,
  });
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('invalid_request', `${label} must be a non-negative integer`);
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('invalid_request', `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function computeAuthStrategyEvidenceKey({ request, executionBinding, ruleId, strategyIndex, authFactors }) {
  return createHash('sha256').update(canonicalJson({
    version: 1,
    ruleId,
    strategyIndex,
    authFactors,
    operation: {
      subject: request.subject,
      runId: request.runId,
      repository: request.repository,
      commitSha: request.commitSha,
      policyGeneration: request.policyGeneration,
      provider: request.provider,
      origin: request.origin,
      redirectOrigins: request.redirectOrigins,
      capability: request.capability,
      resource: request.resource,
      artifact: request.artifact,
      accountId: request.accountId,
      workerId: executionBinding.workerId,
    },
  }), 'utf8').digest('hex');
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function freezeRecord(record) {
  return Object.freeze(structuredClone(record));
}

function auditFrom({ idFactory, now, eventType, outcome, entityType, entity, details = {} }) {
  if (!AUTH_ENTITY_TYPES.has(entityType)) {
    fail('invalid_audit_event', 'auth audit entity type is invalid');
  }
  const binding = entity.executionBinding;
  const request = entity.request ?? entity.authorization?.request;
  const providerCommand = entity.grant?.command;
  return freezeRecord({
    id: opaqueId(idFactory(), 'audit id'),
    eventType: publicId(eventType, 'audit event type'),
    outcome: publicId(outcome, 'audit outcome'),
    entityType,
    entityId: opaqueId(entity.id, 'audit entity id'),
    generation: positiveInteger(entity.generation, 'audit generation'),
    recordedAt: iso(now),
    ...(binding ? { executionBinding: binding } : {}),
    ...((entity.credentialRef ?? request?.credentialRef ?? providerCommand?.credential?.logicalId) ? {
      credentialRef: entity.credentialRef ?? request?.credentialRef ?? providerCommand.credential.logicalId,
    } : {}),
    ...(entity.publicIdentity ? { publicIdentity: entity.publicIdentity } : {}),
    ...((request ?? providerCommand) ? {
      commitSha: request?.commitSha ?? providerCommand.sourceSha,
      capability: request?.capability ?? providerCommand.credential.capability,
    } : {}),
    ...(entity.capabilityId ? { capabilityId: entity.capabilityId } : {}),
    ...(entity.authorization ? {
      leaseId: entity.authorization.leaseId,
      ruleId: entity.authorization.ruleId,
    } : entity.ruleId ? { ruleId: entity.ruleId } : entityType === 'ProviderGrant' ? { ruleId: entity.id } : {}),
    ...((entity.authStrategyIndex ?? entity.authorization?.authStrategyIndex) !== undefined ? {
      actionClass: entity.actionClass ?? entity.authorization.actionClass,
      authStrategyIndex: entity.authStrategyIndex ?? entity.authorization.authStrategyIndex,
      strategyEvidenceKey: entity.strategyEvidenceKey ?? entity.authorization.strategyEvidenceKey,
    } : {}),
    ...(entityType === 'ProviderGrant' ? { actionClass: providerGrantActionClass(providerCommand) } : {}),
    ...(entity.idempotencyKey ? { idempotencyKey: entity.idempotencyKey } : {}),
    ...(entityType === 'ProviderGrant' ? {
      provider: providerCommand.provider,
      resourceId: providerCommand.resource.id,
      bindingHash: entity.bindingHash,
      commandDigest: entity.commandDigest,
      approvalId: providerCommand.approval.id,
    } : {}),
    ...details,
  });
}

function exactRecordKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && value === new Date(value).toISOString();
}

function validateWriterLockProvider(lockProvider) {
  if (
    !lockProvider || typeof lockProvider !== 'object' ||
    lockProvider[NATIVE_FILE_LOCK_BRAND] !== true ||
    typeof lockProvider.acquire !== 'function'
  ) {
    fail('invalid_state_writer_lock', 'trusted native journal writer lock provider is required');
  }
  return lockProvider;
}

function validateReplayedEntity(type, entity) {
  opaqueId(entity.id, 'entity id');
  positiveInteger(entity.generation, 'entity generation');
  if (type === 'CredentialCheckout') {
    const keys = [
      'id', 'generation', 'state', 'issuedAt', 'expiresAt', 'maxUses', 'useCount', 'ruleId',
      'credentialRef', 'credentialGeneration', 'policyGeneration', 'executionBinding', 'request',
      'idempotencyKey', 'issuedSequence', 'actionClass', 'authStrategyIndex', 'strategyEvidenceKey',
      ...(entity.state === 'CONSUMED' ? ['consumedAt'] : []),
    ];
    if (
      !exactRecordKeys(entity, keys) || !['ISSUED', 'CONSUMED'].includes(entity.state) ||
      !validIso(entity.issuedAt) || !validIso(entity.expiresAt) ||
      (entity.consumedAt !== undefined && !validIso(entity.consumedAt)) ||
      entity.maxUses !== 1 || ![0, 1].includes(entity.useCount) ||
      entity.useCount !== (entity.state === 'CONSUMED' ? 1 : 0) ||
      !CREDENTIAL_REF.test(entity.credentialRef ?? '')
    ) throw new Error('invalid credential checkout');
    publicId(entity.ruleId, 'rule id');
    publicId(entity.idempotencyKey, 'idempotency key');
    if (!ACTION_CLASS.test(entity.actionClass ?? '')) throw new Error('invalid action class');
    nonNegativeInteger(entity.authStrategyIndex, 'auth strategy index');
    sha256(entity.strategyEvidenceKey, 'strategy evidence key');
    positiveInteger(entity.issuedSequence, 'issued sequence');
    positiveInteger(entity.credentialGeneration, 'credential generation');
    positiveInteger(entity.policyGeneration, 'policy generation');
    const request = normalizeLeaseRequest(entity.request);
    const binding = normalizeExecutionBinding(entity.executionBinding);
    if (
      request.credentialRef !== entity.credentialRef ||
      request.credentialGeneration !== entity.credentialGeneration ||
      request.policyGeneration !== entity.policyGeneration ||
      !isDeepStrictEqual(binding, leaseBinding(request, binding.workerId))
    ) throw new Error('invalid credential checkout binding');
    return;
  }
  if (type === 'ProviderGrant') {
    const transitionKeys = entity.state === 'ACTIVE'
      ? []
      : ['consumedAt', 'consumeIdempotencyKey'];
    const completedKeys = entity.state === 'COMPLETED' ? ['completedAt', 'result'] : [];
    const keys = [
      'id', 'generation', 'state', 'registeredAt', 'expiresAt', 'maxUses', 'useCount',
      'digest', 'bindingHash', 'commandDigest', 'policyGeneration', 'registrationIdempotencyKey',
      'executionBinding', 'grant', ...transitionKeys, ...completedKeys,
    ];
    if (
      !exactRecordKeys(entity, keys) || !PROVIDER_GRANT_STATES.has(entity.state) ||
      entity.generation !== (entity.state === 'ACTIVE' ? 1 : entity.state === 'CONSUMED' ? 2 : 3) ||
      !validIso(entity.registeredAt) || !validIso(entity.expiresAt) ||
      (entity.consumedAt !== undefined && !validIso(entity.consumedAt)) ||
      (entity.completedAt !== undefined && !validIso(entity.completedAt)) ||
      entity.maxUses !== 1 || entity.useCount !== (entity.state === 'ACTIVE' ? 0 : 1) ||
      !SHA256.test(entity.digest ?? '') || !SHA256.test(entity.bindingHash ?? '') ||
      !SHA256.test(entity.commandDigest ?? '') || !Number.isSafeInteger(entity.policyGeneration) ||
      entity.policyGeneration < 1
    ) throw new Error('invalid provider grant');
    const executionBinding = normalizeExecutionBinding(entity.executionBinding);
    const normalized = normalizeProviderGrantRegistration({
      idempotencyKey: entity.registrationIdempotencyKey,
      workerId: executionBinding.workerId,
      grant: entity.grant,
      digest: entity.digest,
    }, {
      subject: executionBinding.subject,
      now: Date.parse(entity.registeredAt),
    });
    if (
      entity.id !== normalized.grant.id || entity.expiresAt !== normalized.grant.expiresAt ||
      entity.bindingHash !== normalized.grant.bindingHash ||
      entity.commandDigest !== normalized.grant.commandDigest ||
      entity.policyGeneration !== normalized.grant.policyGeneration ||
      executionBinding.runId !== normalized.grant.command.executionId ||
      executionBinding.repository !== normalized.grant.command.repository
    ) throw new Error('invalid provider grant binding');
    if (entity.consumeIdempotencyKey !== undefined) publicId(entity.consumeIdempotencyKey, 'provider consume idempotency key');
    if (entity.result !== undefined) {
      const result = normalizeProviderAdapterResult(entity.result, normalized.grant.command);
      if (!PROVIDER_EXECUTION_RESULTS.has(result.outcome)) throw new Error('invalid provider result');
    }
    return;
  }
  if (type === 'AttestationNonce') {
    const keys = [
      'id', 'generation', 'state', 'consumedAt', 'expiresAt', 'maxUses', 'useCount',
      'nonceDigest', 'executionBinding',
    ];
    if (
      !exactRecordKeys(entity, keys) || entity.generation !== 1 || entity.state !== 'CONSUMED' ||
      !validIso(entity.consumedAt) || !validIso(entity.expiresAt) ||
      Date.parse(entity.expiresAt) <= Date.parse(entity.consumedAt) ||
      Date.parse(entity.expiresAt) - Date.parse(entity.consumedAt) > RUN_ATTESTATION_MAX_TTL_MS ||
      entity.maxUses !== 1 || entity.useCount !== 1
    ) throw new Error('invalid attestation nonce');
    const nonceDigest = sha256(entity.nonceDigest, 'attestation nonce digest');
    if (entity.id !== `run-attestation-${nonceDigest}`) throw new Error('invalid attestation nonce binding');
    normalizeExecutionBinding(entity.executionBinding);
    return;
  }
  if (type === 'BrowserSessionBinding') {
    const transitionKeys = entity.state === 'AVAILABLE'
      ? []
      : ['capabilityId', 'checkedOutAt', 'expiresAt', 'authorization'];
    const claimedKeys = ['CLAIMED', 'COMPLETED'].includes(entity.state) ? ['claimedAt'] : [];
    const completedKeys = entity.state === 'COMPLETED' ? ['completedAt'] : [];
    const keys = [
      'id', 'generation', 'state', 'registeredAt', 'executionBinding', 'publicIdentity',
      'maxUses', 'useCount', ...transitionKeys, ...claimedKeys, ...completedKeys,
    ];
    if (
      !exactRecordKeys(entity, keys) || !['AVAILABLE', 'CHECKED_OUT', 'CLAIMED', 'COMPLETED'].includes(entity.state) ||
      !validIso(entity.registeredAt) ||
      (entity.checkedOutAt !== undefined && !validIso(entity.checkedOutAt)) ||
      (entity.claimedAt !== undefined && !validIso(entity.claimedAt)) ||
      (entity.expiresAt !== undefined && !validIso(entity.expiresAt)) ||
      (entity.completedAt !== undefined && !validIso(entity.completedAt)) ||
      entity.maxUses !== 1 || ![0, 1].includes(entity.useCount) ||
      entity.useCount !== (entity.state === 'COMPLETED' ? 1 : 0)
    ) throw new Error('invalid browser session binding');
    if (entity.capabilityId !== undefined) opaqueId(entity.capabilityId, 'capability id');
    normalizeExecutionBinding(entity.executionBinding);
    normalizePublicIdentity(entity.publicIdentity);
    if (entity.authorization !== undefined) {
      const authorization = normalizeBrowserAuthorization(entity.authorization);
      if (
        !isDeepStrictEqual(
          normalizeExecutionBinding(entity.executionBinding),
          leaseBinding(authorization.request, entity.executionBinding.workerId),
        ) ||
        entity.publicIdentity.provider !== authorization.request.provider ||
        entity.publicIdentity.accountId !== authorization.request.accountId ||
        (
          entity.publicIdentity.appId !== null &&
          entity.publicIdentity.appId !== authorization.request.resource.id
        )
      ) {
        throw new Error('invalid browser authorization binding');
      }
    }
    return;
  }
  const reauthKeys = [
    'id', 'generation', 'state', 'reason', 'requestedAt', 'requestedSequence',
    'executionBinding', 'publicIdentity',
    ...(entity.state === 'RESOLVED' ? ['resolvedAt'] : []),
  ];
  if (
    type !== 'ReauthRequest' || !exactRecordKeys(entity, reauthKeys) ||
    ![HUMAN_REAUTH_REQUIRED, 'RESOLVED'].includes(entity.state) ||
    entity.generation !== (entity.state === 'RESOLVED' ? 2 : 1) ||
    !validIso(entity.requestedAt) ||
    (entity.resolvedAt !== undefined && !validIso(entity.resolvedAt))
  ) throw new Error('invalid reauth request');
  publicId(entity.reason, 'reauth reason');
  positiveInteger(entity.requestedSequence, 'requested sequence');
  classifyReauth(entity.reason);
  normalizeExecutionBinding(entity.executionBinding);
  normalizePublicIdentity(entity.publicIdentity);
}

function validateReplayedAudit(audit) {
  const allowed = [
    'id', 'eventType', 'outcome', 'entityType', 'entityId', 'generation', 'recordedAt',
    'executionBinding', 'credentialRef', 'publicIdentity', 'reason', 'exitCode', 'signal',
    'commitSha', 'capability', 'capabilityId', 'leaseId', 'ruleId', 'idempotencyKey',
    'actionClass', 'authStrategyIndex', 'strategyEvidenceKey', 'provider', 'resourceId',
    'bindingHash', 'commandDigest', 'approvalId', 'resultOutcome', 'observationDigest',
  ];
  if (
    !Object.keys(audit).every((key) => allowed.includes(key)) ||
    !AUTH_ENTITY_TYPES.has(audit.entityType) ||
    !validIso(audit.recordedAt)
  ) throw new Error('invalid audit event');
  publicId(audit.id, 'audit id');
  publicId(audit.eventType, 'audit event type');
  publicId(audit.outcome, 'audit outcome');
  opaqueId(audit.entityId, 'audit entity id');
  positiveInteger(audit.generation, 'audit generation');
  if (audit.executionBinding !== undefined) normalizeExecutionBinding(audit.executionBinding);
  if (audit.publicIdentity !== undefined) normalizePublicIdentity(audit.publicIdentity);
  if (audit.credentialRef !== undefined && !CREDENTIAL_REF.test(audit.credentialRef)) {
    throw new Error('invalid audit credential reference');
  }
  if (audit.reason !== undefined) publicId(audit.reason, 'audit reason');
  if (audit.exitCode !== undefined && !Number.isInteger(audit.exitCode)) throw new Error('invalid exit code');
  if (audit.signal !== undefined) publicId(audit.signal, 'audit signal');
  if (audit.commitSha !== undefined && !COMMIT_SHA.test(audit.commitSha)) throw new Error('invalid commit SHA');
  if (audit.capability !== undefined && !CAPABILITY.test(audit.capability)) throw new Error('invalid capability');
  if (audit.capabilityId !== undefined) opaqueId(audit.capabilityId, 'audit capability id');
  if (audit.leaseId !== undefined) opaqueId(audit.leaseId, 'audit lease id');
  if (audit.ruleId !== undefined) publicId(audit.ruleId, 'audit rule id');
  if (audit.idempotencyKey !== undefined) publicId(audit.idempotencyKey, 'audit idempotency key');
  if (audit.actionClass !== undefined && !ACTION_CLASS.test(audit.actionClass)) {
    throw new Error('invalid audit action class');
  }
  if (audit.authStrategyIndex !== undefined) nonNegativeInteger(audit.authStrategyIndex, 'audit auth strategy index');
  if (audit.strategyEvidenceKey !== undefined) sha256(audit.strategyEvidenceKey, 'audit strategy evidence key');
  if (audit.provider !== undefined && !PROVIDER.test(audit.provider)) throw new Error('invalid audit provider');
  if (audit.resourceId !== undefined) publicId(audit.resourceId, 'audit resource id');
  if (audit.bindingHash !== undefined) sha256(audit.bindingHash, 'audit binding hash');
  if (audit.commandDigest !== undefined) sha256(audit.commandDigest, 'audit command digest');
  if (audit.approvalId !== undefined) publicId(audit.approvalId, 'audit approval id');
  if (audit.resultOutcome !== undefined && !PROVIDER_EXECUTION_RESULTS.has(audit.resultOutcome)) {
    throw new Error('invalid audit provider result');
  }
  if (audit.observationDigest !== undefined) sha256(audit.observationDigest, 'audit observation digest');
  if (
    (
      audit.eventType === 'CREDENTIAL_EXECUTION_FINISHED' &&
      AUTH_STRATEGY_FAILURE_OUTCOMES.has(audit.outcome)
    ) ||
    (audit.eventType === 'BROWSER_SESSION_RECONCILED_NOT_APPLIED' && audit.outcome === 'NOT_APPLIED')
  ) {
    nonNegativeInteger(audit.authStrategyIndex, 'audit auth strategy index');
    sha256(audit.strategyEvidenceKey, 'audit strategy evidence key');
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function envelopeMac(envelope, journalMacKey) {
  const authenticated = { ...envelope };
  delete authenticated.mac;
  return createHmac('sha256', journalMacKey).update(canonicalJson(authenticated), 'utf8').digest('hex');
}

function validateEnvelope(envelope, expectedSequence, journalMacKey, previousMac) {
  const integrityEnabled = Buffer.isBuffer(journalMacKey);
  const expectedKeys = integrityEnabled
    ? ['schemaVersion', 'sequence', 'recordedAt', 'previousMac', 'mutation', 'audit', 'mac']
    : ['schemaVersion', 'sequence', 'recordedAt', 'mutation', 'audit'];
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    !exactRecordKeys(envelope, expectedKeys) ||
    envelope.schemaVersion !== (integrityEnabled ? 2 : 1) ||
    envelope.sequence !== expectedSequence ||
    typeof envelope.recordedAt !== 'string' ||
    !envelope.audit ||
    typeof envelope.audit !== 'object' ||
    envelope.recordedAt !== envelope.audit.recordedAt
  ) {
    fail('invalid_state_journal', 'durable auth journal is malformed');
  }
  if (integrityEnabled) {
    const expectedPreviousMac = previousMac ?? JOURNAL_GENESIS_MAC;
    if (
      envelope.previousMac !== expectedPreviousMac ||
      !JOURNAL_MAC.test(envelope.mac ?? '')
    ) {
      fail('invalid_state_journal', 'durable auth journal integrity check failed');
    }
    const expected = Buffer.from(envelopeMac(envelope, journalMacKey), 'hex');
    const actual = Buffer.from(envelope.mac, 'hex');
    if (!timingSafeEqual(expected, actual)) {
      fail('invalid_state_journal', 'durable auth journal integrity check failed');
    }
  }
  try {
    validateReplayedAudit(envelope.audit);
    if (envelope.mutation !== null) {
      const type = envelope.mutation?.entityType;
      const entity = envelope.mutation?.entity;
      if (
        !exactRecordKeys(envelope.mutation, ['entityType', 'entity']) ||
        !AUTH_ENTITY_TYPES.has(type) || !entity
      ) {
        throw new Error('invalid mutation');
      }
      validateReplayedEntity(type, entity);
    }
  } catch {
    fail('invalid_state_journal', 'durable auth journal record is invalid');
  }
}

function assertPlainJournalJson(value, seen = new Set()) {
  if (
    value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) return;
  if (!value || typeof value !== 'object' || seen.has(value)) {
    fail('invalid_state_journal', 'durable auth journal record is not plain JSON');
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) && prototype !== Object.prototype && prototype !== null
  ) {
    fail('invalid_state_journal', 'durable auth journal record is not plain JSON');
  }
  seen.add(value);
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    assertPlainJournalJson(nested, seen);
  }
  seen.delete(value);
}

export function serializeSecretFreeJournalEnvelope({
  envelope,
  expectedSequence,
  journalMacKey,
  previousMac,
}) {
  assertPlainJournalJson(envelope);
  validateEnvelope(envelope, expectedSequence, journalMacKey, previousMac);
  try {
    return JSON.stringify(envelope);
  } catch {
    fail('invalid_state_journal', 'durable auth journal record could not be serialized');
  }
}

async function openSecureJournal(directory) {
  const requestedDirectory = resolve(directory);
  await mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
  const requestedStat = await lstat(requestedDirectory);
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) {
    fail('insecure_state_directory', 'durable auth state directory must be a private non-symlink directory');
  }
  const absoluteDirectory = await realpath(requestedDirectory);
  const directoryStat = await lstat(absoluteDirectory);
  if (
    !directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
    (directoryStat.mode & 0o077) !== 0 || directoryStat.uid !== process.getuid?.()
  ) {
    fail('insecure_state_directory', 'durable auth state directory must be owned by the broker identity');
  }

  const journalPath = join(absoluteDirectory, JOURNAL_FILE);
  try {
    const journalStat = await lstat(journalPath);
    if (
      !journalStat.isFile() || journalStat.isSymbolicLink() ||
      (journalStat.mode & 0o077) !== 0 || journalStat.uid !== process.getuid?.()
    ) {
      fail('insecure_state_journal', 'durable auth journal must be a private regular file');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const flags = fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY |
    (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(journalPath, flags, 0o600);
  const handleStat = await handle.stat();
  if (!handleStat.isFile() || (handleStat.mode & 0o077) !== 0 || handleStat.uid !== process.getuid?.()) {
    await handle.close();
    fail('insecure_state_journal', 'durable auth journal must be a private regular file');
  }
  return { absoluteDirectory, journalPath, handle };
}

export class DurableAuthState {
  #clock;
  #idFactory;
  #journalPath;
  #journalHandle;
  #writerLock;
  #sequence = 0;
  #journalMacKey;
  #lastMac;
  #expectedJournalHeadMac;
  #queue = Promise.resolve();
  #closed = false;
  #credentialCheckouts = new Map();
  #browserSessionBindings = new Map();
  #reauthRequests = new Map();
  #providerGrants = new Map();
  #attestationNonces = new Map();
  #auditEvents = [];
  #recoveredBrowserClaims = new Set();
  #authStrategyFailures = new Set();

  static async open({
    directory,
    clock = () => Date.now(),
    idFactory = () => randomUUID(),
    journalMacKey,
    requireIntegrity = false,
    expectedJournalHeadMac,
    writerLockProvider,
  }) {
    if (typeof directory !== 'string' || !isAbsolute(directory)) {
      fail('invalid_state_directory', 'durable auth state directory must be an absolute path');
    }
    if (typeof requireIntegrity !== 'boolean') {
      fail('invalid_state_integrity', 'requireIntegrity must be a boolean');
    }
    if (journalMacKey !== undefined && (!Buffer.isBuffer(journalMacKey) || journalMacKey.length !== 32)) {
      fail('invalid_state_integrity', 'journal MAC key must be a 32-byte Buffer');
    }
    if (requireIntegrity && !Buffer.isBuffer(journalMacKey)) {
      fail('state_integrity_required', 'durable auth journal integrity key is required');
    }
    if (expectedJournalHeadMac !== undefined && !JOURNAL_MAC.test(expectedJournalHeadMac)) {
      fail('invalid_state_integrity', 'expected journal head MAC is invalid');
    }
    if (expectedJournalHeadMac !== undefined && !Buffer.isBuffer(journalMacKey)) {
      fail('invalid_state_integrity', 'expected journal head MAC requires journal integrity');
    }
    const lockProvider = validateWriterLockProvider(writerLockProvider);
    const opened = await openSecureJournal(directory);
    let writerLock;
    try {
      writerLock = await lockProvider.acquire(join(opened.absoluteDirectory, JOURNAL_WRITER_LOCK_FILE));
      if (!writerLock || typeof writerLock.assertHeld !== 'function' || typeof writerLock.release !== 'function') {
        fail('invalid_state_writer_lock', 'native journal writer lock handle is invalid');
      }
      writerLock.assertHeld();
    } catch (error) {
      await opened.handle.close().catch(() => {});
      if (writerLock && typeof writerLock.release === 'function') {
        await writerLock.release().catch(() => {});
      }
      if (error instanceof SeoriAuthError && error.code === 'browser_account_in_use') {
        fail('state_writer_in_use', 'another durable auth state writer already owns this journal');
      }
      throw error;
    }
    const state = new DurableAuthState({
      ...opened,
      clock,
      idFactory,
      journalMacKey: journalMacKey === undefined ? undefined : Buffer.from(journalMacKey),
      expectedJournalHeadMac,
      writerLock,
    });
    try {
      await state.#replay();
      state.#pruneExpiredRunAttestationNonces(state.#clock());
      await state.#reconcileBrowserSessionsAtStartup();
    } catch (error) {
      state.#closed = true;
      state.#zeroIntegrityKey();
      await opened.handle.close();
      await writerLock.release().catch(() => {});
      throw error;
    }
    return state;
  }

  constructor({ journalPath, handle, clock, idFactory, journalMacKey, expectedJournalHeadMac, writerLock }) {
    this.#journalPath = journalPath;
    this.#journalHandle = handle;
    this.#writerLock = writerLock;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#journalMacKey = journalMacKey;
    this.#lastMac = undefined;
    this.#expectedJournalHeadMac = expectedJournalHeadMac;
  }

  async #replay() {
    const contents = await readFile(this.#journalPath, 'utf8');
    if (contents.length === 0) {
      if (
        this.#expectedJournalHeadMac !== undefined &&
        this.#expectedJournalHeadMac !== JOURNAL_GENESIS_MAC
      ) {
        fail('invalid_state_journal', 'durable auth journal head does not match the trusted checkpoint');
      }
      return;
    }
    if (!contents.endsWith('\n')) {
      fail('invalid_state_journal', 'durable auth journal has an incomplete record');
    }
    const lines = contents.slice(0, -1).split('\n');
    for (const line of lines) {
      let envelope;
      try {
        envelope = JSON.parse(line);
      } catch {
        fail('invalid_state_journal', 'durable auth journal contains invalid JSON');
      }
      validateEnvelope(envelope, this.#sequence + 1, this.#journalMacKey, this.#lastMac);
      this.#applyEnvelope(envelope);
    }
    if (this.#expectedJournalHeadMac !== undefined && this.#lastMac !== this.#expectedJournalHeadMac) {
      fail('invalid_state_journal', 'durable auth journal head does not match the trusted checkpoint');
    }
  }

  async #reconcileBrowserSessionsAtStartup() {
    const now = this.#clock();
    for (const entity of [...this.#browserSessionBindings.values()]) {
      if (entity.state === 'CLAIMED') {
        this.#recoveredBrowserClaims.add(entity.id);
        continue;
      }
      if (entity.state !== 'CHECKED_OUT' || now < Date.parse(entity.expiresAt)) continue;
      const available = freezeRecord({
        id: entity.id,
        generation: entity.generation + 1,
        state: 'AVAILABLE',
        registeredAt: entity.registeredAt,
        executionBinding: entity.executionBinding,
        publicIdentity: entity.publicIdentity,
        maxUses: 1,
        useCount: 0,
      });
      const audit = auditFrom({
        idFactory: this.#idFactory,
        now,
        eventType: 'BROWSER_SESSION_EXPIRED_RECLAIMED',
        outcome: 'RECLAIMED',
        entityType: 'BrowserSessionBinding',
        entity,
      });
      await this.#append({ entityType: 'BrowserSessionBinding', entity: available, audit });
    }
  }

  #mapFor(entityType) {
    if (entityType === 'CredentialCheckout') return this.#credentialCheckouts;
    if (entityType === 'BrowserSessionBinding') return this.#browserSessionBindings;
    if (entityType === 'ReauthRequest') return this.#reauthRequests;
    if (entityType === 'ProviderGrant') return this.#providerGrants;
    if (entityType === 'AttestationNonce') return this.#attestationNonces;
    fail('invalid_state_journal', 'durable auth journal has an unknown entity type');
  }

  #pruneExpiredRunAttestationNonces(now) {
    for (const [id, entity] of this.#attestationNonces) {
      if (Date.parse(entity.expiresAt) <= now) this.#attestationNonces.delete(id);
    }
  }

  #applyEnvelope(envelope) {
    this.#sequence = envelope.sequence;
    this.#lastMac = envelope.mac;
    this.#auditEvents.push(freezeRecord(envelope.audit));
    if (
      (
        envelope.audit.eventType === 'CREDENTIAL_EXECUTION_FINISHED' &&
        AUTH_STRATEGY_FAILURE_OUTCOMES.has(envelope.audit.outcome)
      ) ||
      (
        envelope.audit.eventType === 'BROWSER_SESSION_RECONCILED_NOT_APPLIED' &&
        envelope.audit.outcome === 'NOT_APPLIED'
      )
    ) {
      this.#authStrategyFailures.add(envelope.audit.strategyEvidenceKey);
    }
    if (envelope.mutation !== null) {
      this.#mapFor(envelope.mutation.entityType).set(
        envelope.mutation.entity.id,
        freezeRecord(envelope.mutation.entity),
      );
    }
  }

  #serialize(operation) {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #append({ entityType, entity, audit }) {
    if (this.#closed) {
      fail('state_closed', 'durable auth state is closed');
    }
    try {
      this.#writerLock.assertHeld();
    } catch {
      this.#closed = true;
      await this.#journalHandle.close().catch(() => {});
      await this.#writerLock.release().catch(() => {});
      this.#zeroIntegrityKey();
      fail('state_writer_lock_lost', 'durable auth state writer lock was lost');
    }
    const envelope = {
      schemaVersion: this.#journalMacKey ? DURABLE_JOURNAL_ENVELOPE.schemaVersion : 1,
      sequence: this.#sequence + 1,
      recordedAt: audit.recordedAt,
      ...(this.#journalMacKey ? { previousMac: this.#lastMac ?? JOURNAL_GENESIS_MAC } : {}),
      mutation: entityType === null ? null : { entityType, entity },
      audit,
    };
    if (this.#journalMacKey) {
      envelope.mac = envelopeMac(envelope, this.#journalMacKey);
    }
    const serialized = serializeSecretFreeJournalEnvelope({
      envelope,
      expectedSequence: this.#sequence + 1,
      journalMacKey: this.#journalMacKey,
      previousMac: this.#lastMac,
    });
    try {
      await this.#journalHandle.appendFile(`${serialized}\n`, 'utf8');
      await this.#journalHandle.sync();
    } catch {
      // An uncertain append must stop all further mutations. Reusing the old
      // in-memory sequence could create a journal that cannot be replayed safely.
      this.#closed = true;
      await this.#journalHandle.close().catch(() => {});
      await this.#writerLock.release().catch(() => {});
      this.#zeroIntegrityKey();
      fail('state_persistence_failed', 'durable auth state could not be persisted');
    }
    this.#applyEnvelope(envelope);
  }

  async #recordFailure({ eventType, outcome, entityType, entity, details }) {
    const now = this.#clock();
    const audit = auditFrom({
      idFactory: this.#idFactory,
      now,
      eventType,
      outcome,
      entityType,
      entity,
      details,
    });
    await this.#append({ entityType: null, entity: null, audit });
  }

  consumeRunAttestationNonce({ nonceDigest, expiresAt, executionBinding }) {
    return this.#serialize(async () => {
      if (!this.#journalMacKey) {
        fail('state_integrity_required', 'run attestation nonce requires the durable HMAC audit journal');
      }
      const digest = sha256(nonceDigest, 'attestation nonce digest');
      const binding = normalizeExecutionBinding(executionBinding);
      const now = this.#clock();
      if (
        !Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt) ||
        expiresAt <= now || expiresAt - now > RUN_ATTESTATION_MAX_TTL_MS
      ) {
        fail('principal_unauthenticated', 'run attestation nonce expiry is invalid');
      }
      this.#pruneExpiredRunAttestationNonces(now);
      const id = `run-attestation-${digest}`;
      if (this.#attestationNonces.has(id)) {
        fail('principal_unauthenticated', 'scheduler run attestation was already used');
      }
      if (this.#attestationNonces.size >= RUN_ATTESTATION_ACTIVE_NONCE_LIMIT) {
        fail('principal_unauthenticated', 'scheduler run attestation replay cache is full');
      }
      const entity = freezeRecord({
        id,
        generation: 1,
        state: 'CONSUMED',
        consumedAt: iso(now),
        expiresAt: iso(expiresAt),
        maxUses: 1,
        useCount: 1,
        nonceDigest: digest,
        executionBinding: binding,
      });
      const audit = auditFrom({
        idFactory: this.#idFactory,
        now,
        eventType: 'RUN_ATTESTATION_CONSUMED',
        outcome: 'SUCCESS',
        entityType: 'AttestationNonce',
        entity,
      });
      await this.#append({ entityType: 'AttestationNonce', entity, audit });
      return freezeRecord({ consumed: true, expiresAt: entity.expiresAt });
    });
  }

  registerProviderGrant({ registration, executionBinding }) {
    return this.#serialize(async () => {
      if (!this.#journalMacKey) {
        fail('state_integrity_required', 'provider grants require the durable HMAC audit journal');
      }
      const binding = normalizeExecutionBinding(executionBinding);
      const command = registration?.grant?.command;
      if (
        !registration || binding.subject !== registration.subject ||
        binding.workerId !== registration.workerId || binding.runId !== command?.executionId ||
        binding.repository !== command?.repository
      ) {
        fail('principal_binding_mismatch', 'provider grant does not match the attested principal');
      }
      const replay = [...this.#providerGrants.values()].find(
        (candidate) => candidate.registrationIdempotencyKey === registration.idempotencyKey,
      );
      if (replay) {
        if (
          replay.id !== registration.grant.id || replay.digest !== registration.digest ||
          !isDeepStrictEqual(replay.executionBinding, binding)
        ) fail('idempotency_conflict', 'provider grant idempotency key is bound to another request');
        return this.providerGrantView(replay);
      }
      if (this.#providerGrants.has(registration.grant.id)) {
        fail('provider_grant_exists', 'provider grant id is already registered');
      }
      const now = this.#clock();
      if (
        now >= Date.parse(registration.grant.expiresAt) ||
        Date.parse(registration.grant.expiresAt) - now > 5 * 60 * 1_000
      ) fail('approval_expired', 'provider grant is expired or exceeds five minutes');
      const entity = freezeRecord({
        id: registration.grant.id,
        generation: 1,
        state: 'ACTIVE',
        registeredAt: iso(now),
        expiresAt: registration.grant.expiresAt,
        maxUses: 1,
        useCount: 0,
        digest: registration.digest,
        bindingHash: registration.grant.bindingHash,
        commandDigest: registration.grant.commandDigest,
        policyGeneration: registration.grant.policyGeneration,
        registrationIdempotencyKey: registration.idempotencyKey,
        executionBinding: binding,
        grant: registration.grant,
      });
      const audit = auditFrom({
        idFactory: this.#idFactory,
        now,
        eventType: 'PROVIDER_GRANT_REGISTERED',
        outcome: 'SUCCESS',
        entityType: 'ProviderGrant',
        entity,
        details: { idempotencyKey: registration.idempotencyKey },
      });
      await this.#append({ entityType: 'ProviderGrant', entity, audit });
      return this.providerGrantView(entity);
    });
  }

  verifyProviderGrant({ id, expectation, executionBinding }) {
    return this.#serialize(async () => {
      const entity = this.#providerGrants.get(opaqueId(id, 'provider grant id'));
      if (!entity) fail('provider_grant_not_found', 'provider grant does not exist');
      const binding = normalizeExecutionBinding(executionBinding);
      if (!isDeepStrictEqual(entity.executionBinding, binding) || expectation.workerId !== binding.workerId) {
        fail('principal_binding_mismatch', 'provider grant does not match the attested principal');
      }
      assertProviderGrantExpectation(entity, expectation);
      if (entity.state !== 'ACTIVE' || entity.useCount !== 0) {
        fail('provider_grant_already_used', 'provider grant is single-use and has already been consumed');
      }
      const now = this.#clock();
      if (now >= Date.parse(entity.expiresAt)) fail('approval_expired', 'provider grant is expired');
      const audit = auditFrom({
        idFactory: this.#idFactory,
        now,
        eventType: 'PROVIDER_GRANT_VERIFIED',
        outcome: 'SUCCESS',
        entityType: 'ProviderGrant',
        entity,
      });
      await this.#append({ entityType: null, entity: null, audit });
      return this.providerGrantView(entity);
    });
  }

  resolveProviderGrantCommand({ id, expectation, executionBinding }) {
    return this.#serialize(async () => {
      const entity = this.#providerGrants.get(opaqueId(id, 'provider grant id'));
      if (!entity) fail('provider_grant_not_found', 'provider grant does not exist');
      const binding = normalizeExecutionBinding(executionBinding);
      if (!isDeepStrictEqual(entity.executionBinding, binding) || expectation.workerId !== binding.workerId) {
        fail('principal_binding_mismatch', 'provider grant does not match the attested principal');
      }
      assertProviderGrantExpectation(entity, expectation);
      if (expectation.expectedGeneration !== entity.grant.command.generation) {
        fail('generation_conflict', 'provider execution generation does not match the grant');
      }
      if (entity.state !== 'ACTIVE' || entity.useCount !== 0) {
        if (entity.consumeIdempotencyKey === expectation.idempotencyKey) {
          return freezeRecord({ command: entity.grant.command, replay: true });
        }
        fail('provider_grant_already_used', 'provider grant is single-use and has already been consumed');
      }
      if (this.#clock() >= Date.parse(entity.expiresAt)) fail('approval_expired', 'provider grant is expired');
      return freezeRecord({ command: entity.grant.command, replay: false });
    });
  }

  consumeProviderGrant({ id, expectation, executionBinding }) {
    return this.#serialize(async () => {
      const entity = this.#providerGrants.get(opaqueId(id, 'provider grant id'));
      if (!entity) fail('provider_grant_not_found', 'provider grant does not exist');
      const binding = normalizeExecutionBinding(executionBinding);
      if (!isDeepStrictEqual(entity.executionBinding, binding) || expectation.workerId !== binding.workerId) {
        fail('principal_binding_mismatch', 'provider grant does not match the attested principal');
      }
      assertProviderGrantExpectation(entity, expectation);
      if (expectation.expectedGeneration !== entity.grant.command.generation) {
        fail('generation_conflict', 'provider execution generation does not match the grant');
      }
      if (entity.state !== 'ACTIVE' || entity.useCount !== 0) {
        if (entity.consumeIdempotencyKey === expectation.idempotencyKey) {
          return freezeRecord({
            replay: true,
            shouldExecute: false,
            command: entity.grant.command,
            policyGrant: this.providerGrantView(entity),
            execution: this.providerGrantExecutionView(entity),
          });
        }
        fail('provider_grant_already_used', 'provider grant is single-use and has already been consumed');
      }
      const now = this.#clock();
      if (now >= Date.parse(entity.expiresAt)) fail('approval_expired', 'provider grant is expired');
      const consumed = freezeRecord({
        ...entity,
        generation: 2,
        state: 'CONSUMED',
        useCount: 1,
        consumedAt: iso(now),
        consumeIdempotencyKey: expectation.idempotencyKey,
      });
      const audit = auditFrom({
        idFactory: this.#idFactory,
        now,
        eventType: 'PROVIDER_GRANT_CONSUMED',
        outcome: 'SUCCESS',
        entityType: 'ProviderGrant',
        entity: consumed,
        details: { idempotencyKey: expectation.idempotencyKey },
      });
      await this.#append({ entityType: 'ProviderGrant', entity: consumed, audit });
      return freezeRecord({
        replay: false,
        shouldExecute: true,
        command: consumed.grant.command,
        policyGrant: this.providerGrantView(consumed),
        execution: this.providerGrantExecutionView(consumed),
      });
    });
  }

  recordProviderGrantResult({ id, executionBinding, result }) {
    return this.#serialize(async () => {
      const entity = this.#providerGrants.get(opaqueId(id, 'provider grant id'));
      if (!entity) fail('provider_grant_not_found', 'provider grant does not exist');
      const binding = normalizeExecutionBinding(executionBinding);
      if (!isDeepStrictEqual(entity.executionBinding, binding)) {
        fail('principal_binding_mismatch', 'provider grant does not match the attested principal');
      }
      const normalized = normalizeProviderAdapterResult(result, entity.grant.command);
      if (entity.state === 'COMPLETED') {
        if (!isDeepStrictEqual(entity.result, normalized)) {
          fail('generation_conflict', 'provider grant already has a different final result');
        }
        return freezeRecord({
          policyGrant: this.providerGrantView(entity),
          execution: this.providerGrantExecutionView(entity),
        });
      }
      if (entity.state !== 'CONSUMED' || entity.generation !== 2 || entity.useCount !== 1) {
        fail('generation_conflict', 'provider grant is not in the consumed generation');
      }
      const now = this.#clock();
      const completed = freezeRecord({
        ...entity,
        generation: 3,
        state: 'COMPLETED',
        completedAt: iso(now),
        result: normalized,
      });
      const audit = auditFrom({
        idFactory: this.#idFactory,
        now,
        eventType: 'PROVIDER_EXECUTION_RECORDED',
        outcome: 'SUCCESS',
        entityType: 'ProviderGrant',
        entity: completed,
        details: {
          resultOutcome: normalized.outcome,
          ...(normalized.observation ? { observationDigest: publicJsonDigest(normalized.observation) } : {}),
        },
      });
      await this.#append({ entityType: 'ProviderGrant', entity: completed, audit });
      return freezeRecord({
        policyGrant: this.providerGrantView(completed),
        execution: this.providerGrantExecutionView(completed),
      });
    });
  }

  readProviderGrantResult({ id, expectation, executionBinding }) {
    return this.#serialize(async () => {
      const entity = this.#providerGrants.get(opaqueId(id, 'provider grant id'));
      if (!entity) fail('provider_grant_not_found', 'provider grant does not exist');
      const binding = normalizeExecutionBinding(executionBinding);
      if (!isDeepStrictEqual(entity.executionBinding, binding) || expectation.workerId !== binding.workerId) {
        fail('principal_binding_mismatch', 'provider grant does not match the attested principal');
      }
      assertProviderGrantExpectation(entity, expectation);
      if (expectation.expectedGeneration !== entity.grant.command.generation) {
        fail('generation_conflict', 'provider execution generation does not match the grant');
      }
      const now = this.#clock();
      const audit = auditFrom({
        idFactory: this.#idFactory,
        now,
        eventType: 'PROVIDER_RESULT_READ',
        outcome: 'SUCCESS',
        entityType: 'ProviderGrant',
        entity,
      });
      await this.#append({ entityType: null, entity: null, audit });
      return freezeRecord({
        policyGrant: this.providerGrantView(entity),
        execution: this.providerGrantExecutionView(entity),
      });
    });
  }

  readProviderGrantObservation({ id, expectation, executionBinding }) {
    return this.#serialize(async () => {
      const entity = this.#providerGrants.get(opaqueId(id, 'provider grant id'));
      if (!entity) fail('provider_grant_not_found', 'provider grant does not exist');
      const binding = normalizeExecutionBinding(executionBinding);
      if (!isDeepStrictEqual(entity.executionBinding, binding) || expectation.workerId !== binding.workerId) {
        fail('principal_binding_mismatch', 'provider grant does not match the attested principal');
      }
      assertProviderGrantExpectation(entity, expectation);
      if (expectation.expectedGeneration !== entity.grant.command.generation) {
        fail('generation_conflict', 'provider execution generation does not match the grant');
      }
      const observation = entity.result?.observation;
      const now = this.#clock();
      const audit = auditFrom({
        idFactory: this.#idFactory,
        now,
        eventType: 'PROVIDER_OBSERVATION_READ',
        outcome: observation === undefined ? 'ABSENT' : 'SUCCESS',
        entityType: 'ProviderGrant',
        entity,
        details: observation === undefined ? {} : { observationDigest: publicJsonDigest(observation) },
      });
      await this.#append({ entityType: null, entity: null, audit });
      if (observation === undefined) return null;
      return freezeRecord({
        policyGrant: this.providerGrantView(entity),
        observation,
      });
    });
  }

  issueCredentialCheckout({
    authorized,
    workerId,
    idempotencyKey,
    currentCredentialGeneration,
    currentPolicyGeneration,
  }) {
    return this.#serialize(async () => {
      const request = normalizeLeaseRequest(authorized?.request);
      const normalizedWorkerId = publicId(workerId, 'workerId');
      const normalizedIdempotencyKey = publicId(idempotencyKey, 'idempotencyKey');
      const executionBinding = leaseBinding(request, normalizedWorkerId);
      if (
        !Number.isSafeInteger(authorized?.authStrategyIndex) || authorized.authStrategyIndex < 0 ||
        !Array.isArray(authorized?.authStrategies) ||
        !Array.isArray(authorized.authStrategies[authorized.authStrategyIndex]) ||
        !isDeepStrictEqual(authorized.authStrategies[authorized.authStrategyIndex], request.authFactors) ||
        typeof authorized.actionClass !== 'string' || !ACTION_CLASS.test(authorized.actionClass)
      ) {
        fail('invalid_authorization', 'authorized authentication strategy metadata is invalid');
      }
      for (let index = 0; index < authorized.authStrategyIndex; index += 1) {
        const evidenceKey = computeAuthStrategyEvidenceKey({
          request,
          executionBinding,
          ruleId: authorized.ruleId,
          strategyIndex: index,
          authFactors: authorized.authStrategies[index],
        });
        if (!this.#authStrategyFailures.has(evidenceKey)) {
          fail(
            'auth_strategy_evidence_required',
            'fallback authentication strategy requires durable same-run failure evidence for every earlier strategy',
          );
        }
      }
      const strategyEvidenceKey = computeAuthStrategyEvidenceKey({
        request,
        executionBinding,
        ruleId: authorized.ruleId,
        strategyIndex: authorized.authStrategyIndex,
        authFactors: request.authFactors,
      });
      if (currentPolicyGeneration !== request.policyGeneration) {
        fail('stale_policy_generation', 'policy generation changed before lease issuance');
      }
      if (currentCredentialGeneration !== request.credentialGeneration) {
        fail('stale_credential_generation', 'credential generation changed before lease issuance');
      }
      const relatedReauth = [...this.#reauthRequests.values()].filter(
        (candidate) => reauthMatches(candidate, executionBinding, request),
      );
      if (relatedReauth.some((candidate) => candidate.state === HUMAN_REAUTH_REQUIRED)) {
        fail(
          HUMAN_REAUTH_REQUIRED,
          'an unresolved human reauthentication request blocks new credential checkouts',
          { reason: 'policy_blocked' },
        );
      }
      const sameIdempotencyKey = [...this.#credentialCheckouts.values()].find(
        (candidate) => candidate.idempotencyKey === normalizedIdempotencyKey,
      );
      if (sameIdempotencyKey) {
        if (
          sameIdempotencyKey.request.approval.id !== request.approval.id ||
          !isDeepStrictEqual(sameIdempotencyKey.request, request) ||
          !isDeepStrictEqual(sameIdempotencyKey.executionBinding, executionBinding)
        ) {
          fail('idempotency_conflict', 'idempotency key is already bound to another approval request');
        }
        if (relatedReauth.some(
          (candidate) => candidate.requestedSequence > sameIdempotencyKey.issuedSequence,
        )) {
          fail('lease_invalidated_by_reauth', 'credential checkout predates a reauthentication gate');
        }
        return this.credentialCheckoutView(sameIdempotencyKey);
      }
      if ([...this.#credentialCheckouts.values()].some(
        (candidate) => candidate.request.approval.id === request.approval.id,
      )) {
        fail('approval_already_used', 'approval maximum use count has already been reserved');
      }
      const now = this.#clock();
      const entity = freezeRecord({
        id: opaqueId(this.#idFactory(), 'lease id'),
        generation: 1,
        state: 'ISSUED',
        issuedAt: iso(now),
        expiresAt: iso(now + LEASE_TTL_MS),
        maxUses: 1,
        useCount: 0,
        ruleId: publicId(authorized.ruleId, 'ruleId'),
        credentialRef: request.credentialRef,
        credentialGeneration: request.credentialGeneration,
        policyGeneration: request.policyGeneration,
        executionBinding,
        idempotencyKey: normalizedIdempotencyKey,
        issuedSequence: this.#sequence + 1,
        actionClass: authorized.actionClass,
        authStrategyIndex: authorized.authStrategyIndex,
        strategyEvidenceKey,
        request,
      });
      const audit = auditFrom({
        idFactory: this.#idFactory,
        now,
        eventType: 'CREDENTIAL_CHECKOUT_ISSUED',
        outcome: 'SUCCESS',
        entityType: 'CredentialCheckout',
        entity,
      });
      await this.#append({ entityType: 'CredentialCheckout', entity, audit });
      return this.credentialCheckoutView(entity);
    });
  }

  consumeCredentialCheckout({
    id,
    expectedGeneration,
    context,
    workerId,
    currentCredentialGeneration,
    currentPolicyGeneration,
  }) {
    return this.#serialize(async () => {
      const entity = this.#credentialCheckouts.get(opaqueId(id, 'lease id'));
      if (!entity) {
        fail('lease_not_found', 'lease does not exist');
      }
      positiveInteger(expectedGeneration, 'expectedGeneration');
      if (entity.generation !== expectedGeneration) {
        await this.#recordFailure({
          eventType: 'CREDENTIAL_CHECKOUT_CONSUME', outcome: 'GENERATION_CONFLICT',
          entityType: 'CredentialCheckout', entity,
        });
        fail('generation_conflict', 'credential checkout generation does not match');
      }
      const now = this.#clock();
      if (now >= Date.parse(entity.expiresAt)) {
        await this.#recordFailure({
          eventType: 'CREDENTIAL_CHECKOUT_CONSUME', outcome: 'EXPIRED',
          entityType: 'CredentialCheckout', entity,
        });
        fail('lease_expired', 'lease has expired');
      }
      if (entity.state !== 'ISSUED' || entity.useCount !== 0) {
        await this.#recordFailure({
          eventType: 'CREDENTIAL_CHECKOUT_CONSUME', outcome: 'ALREADY_USED',
          entityType: 'CredentialCheckout', entity,
        });
        fail('lease_already_used', 'lease is single-use and has already been consumed');
      }

      const normalizedContext = normalizeLeaseRequest(context);
      const normalizedBinding = leaseBinding(normalizedContext, publicId(workerId, 'workerId'));
      if (
        !isDeepStrictEqual(entity.request, normalizedContext) ||
        !isDeepStrictEqual(entity.executionBinding, normalizedBinding)
      ) {
        await this.#recordFailure({
          eventType: 'CREDENTIAL_CHECKOUT_CONSUME', outcome: 'BINDING_MISMATCH',
          entityType: 'CredentialCheckout', entity,
        });
        fail('lease_binding_mismatch', 'execution context does not exactly match the issued lease');
      }
      const invalidatingReauth = [...this.#reauthRequests.values()].filter((candidate) =>
        reauthMatches(candidate, normalizedBinding, normalizedContext) &&
        candidate.requestedSequence > entity.issuedSequence,
      );
      if (invalidatingReauth.some((candidate) => candidate.state === HUMAN_REAUTH_REQUIRED)) {
        await this.#recordFailure({
          eventType: 'CREDENTIAL_CHECKOUT_CONSUME', outcome: HUMAN_REAUTH_REQUIRED,
          entityType: 'CredentialCheckout', entity,
        });
        fail(
          HUMAN_REAUTH_REQUIRED,
          'an unresolved human reauthentication request blocks credential execution',
          { reason: 'policy_blocked' },
        );
      }
      if (invalidatingReauth.length > 0) {
        await this.#recordFailure({
          eventType: 'CREDENTIAL_CHECKOUT_CONSUME', outcome: 'INVALIDATED_BY_REAUTH',
          entityType: 'CredentialCheckout', entity,
        });
        fail('lease_invalidated_by_reauth', 'credential checkout predates a reauthentication gate');
      }
      if (currentPolicyGeneration !== entity.policyGeneration) {
        fail('stale_policy_generation', 'policy generation changed after lease issuance');
      }
      if (currentCredentialGeneration !== entity.credentialGeneration) {
        fail('stale_credential_generation', 'credential generation changed after lease issuance');
      }

      const consumed = freezeRecord({
        ...entity,
        generation: entity.generation + 1,
        state: 'CONSUMED',
        useCount: 1,
        consumedAt: iso(now),
      });
      const audit = auditFrom({
        idFactory: this.#idFactory,
        now,
        eventType: 'CREDENTIAL_CHECKOUT_CONSUMED',
        outcome: 'SUCCESS',
        entityType: 'CredentialCheckout',
        entity: consumed,
      });
      await this.#append({ entityType: 'CredentialCheckout', entity: consumed, audit });
      return freezeRecord({
        id: consumed.id,
        ruleId: consumed.ruleId,
        binding: consumed.request,
        consumedAt: Date.parse(consumed.consumedAt),
        generation: consumed.generation,
        actionClass: consumed.actionClass,
        authStrategyIndex: consumed.authStrategyIndex,
        strategyEvidenceKey: consumed.strategyEvidenceKey,
      });
    });
  }

  recordCredentialExecution({ consumed, outcome, exitCode, signal }) {
    return this.#serialize(async () => {
      if (!EXECUTION_OUTCOMES.has(outcome)) {
        fail('invalid_audit_outcome', 'credential execution outcome is invalid');
      }
      if (exitCode !== undefined && !Number.isInteger(exitCode)) {
        fail('invalid_audit_outcome', 'credential execution exit code is invalid');
      }
      if (signal !== undefined && signal !== null && !/^SIG[A-Z0-9]+$/.test(signal)) {
        fail('invalid_audit_outcome', 'credential execution signal is invalid');
      }
      const entity = this.#credentialCheckouts.get(consumed.id);
      if (!entity || entity.state !== 'CONSUMED') {
        fail('lease_not_found', 'consumed credential checkout does not exist');
      }
      const now = this.#clock();
      const audit = auditFrom({
        idFactory: this.#idFactory,
        now,
        eventType: 'CREDENTIAL_EXECUTION_FINISHED',
        outcome,
        entityType: 'CredentialCheckout',
        entity,
        details: {
          ...(Number.isInteger(exitCode) ? { exitCode } : {}),
          ...(typeof signal === 'string' ? { signal } : {}),
        },
      });
      await this.#append({ entityType: null, entity: null, audit });
    });
  }

  registerBrowserSession({ sessionId, generation, executionBinding, publicIdentity }) {
    return this.#serialize(async () => {
      const id = opaqueId(sessionId, 'browser session id');
      if (this.#browserSessionBindings.has(id)) {
        fail('browser_session_exists', 'browser session binding already exists');
      }
      const now = this.#clock();
      const entity = freezeRecord({
        id,
        generation: positiveInteger(generation, 'generation'),
        state: 'AVAILABLE',
        registeredAt: iso(now),
        executionBinding: normalizeExecutionBinding(executionBinding),
        publicIdentity: normalizePublicIdentity(publicIdentity),
        maxUses: 1,
        useCount: 0,
      });
      const audit = auditFrom({
        idFactory: this.#idFactory,
        now,
        eventType: 'BROWSER_SESSION_REGISTERED',
        outcome: 'SUCCESS',
        entityType: 'BrowserSessionBinding',
        entity,
      });
      await this.#append({ entityType: 'BrowserSessionBinding', entity, audit });
      return this.browserSessionView(entity);
    });
  }

  checkoutBrowserSession({
    sessionId,
    expectedGeneration,
    executionBinding,
    expectedIdentity,
    authorization,
  }) {
    return this.#serialize(async () => {
      const entity = this.#browserSessionBindings.get(opaqueId(sessionId, 'browser session id'));
      if (!entity) {
        fail('browser_session_not_found', 'browser session binding does not exist');
      }
      positiveInteger(expectedGeneration, 'expectedGeneration');
      const binding = normalizeExecutionBinding(executionBinding);
      const identity = normalizePublicIdentity(expectedIdentity);
      const authorized = normalizeBrowserAuthorization(authorization);
      if (entity.generation !== expectedGeneration) {
        fail('generation_conflict', 'browser session generation does not match');
      }
      if (
        entity.state !== 'AVAILABLE' || entity.useCount !== 0 ||
        !isDeepStrictEqual(entity.executionBinding, binding) ||
        !isDeepStrictEqual(entity.publicIdentity, identity) ||
        !isDeepStrictEqual(binding, leaseBinding(authorized.request, binding.workerId)) ||
        identity.provider !== authorized.request.provider ||
        identity.accountId !== authorized.request.accountId ||
        (identity.appId !== null && identity.appId !== authorized.request.resource.id)
      ) {
        fail('browser_session_binding_mismatch', 'browser session binding does not exactly match');
      }

      const now = this.#clock();
      const accountBusy = [...this.#browserSessionBindings.values()].some((candidate) =>
        candidate.id !== entity.id &&
        ['CHECKED_OUT', 'CLAIMED'].includes(candidate.state) &&
        (candidate.state === 'CLAIMED' || Date.parse(candidate.expiresAt) > now) &&
        candidate.publicIdentity.provider === identity.provider &&
        candidate.publicIdentity.accountId === identity.accountId,
      );
      if (accountBusy) {
        fail('browser_account_in_use', 'provider account already has an active browser checkout');
      }

      const checkedOut = freezeRecord({
        ...entity,
        generation: entity.generation + 1,
        state: 'CHECKED_OUT',
        capabilityId: opaqueId(this.#idFactory(), 'capability id'),
        checkedOutAt: iso(now),
        expiresAt: iso(now + LEASE_TTL_MS),
        authorization: authorized,
      });
      const audit = auditFrom({
        idFactory: this.#idFactory,
        now,
        eventType: 'BROWSER_SESSION_CHECKED_OUT',
        outcome: 'SUCCESS',
        entityType: 'BrowserSessionBinding',
        entity: checkedOut,
      });
      await this.#append({ entityType: 'BrowserSessionBinding', entity: checkedOut, audit });
      return this.browserCheckoutView(checkedOut);
    });
  }

  claimBrowserSessionExecution({
    sessionId,
    capabilityId,
    expectedGeneration,
    executionBinding,
    authorization,
  }) {
    return this.#serialize(async () => {
      const entity = this.#browserSessionBindings.get(opaqueId(sessionId, 'browser session id'));
      if (!entity) fail('browser_session_not_found', 'browser session binding does not exist');
      positiveInteger(expectedGeneration, 'expectedGeneration');
      const binding = normalizeExecutionBinding(executionBinding);
      const authorized = normalizeBrowserAuthorization(authorization);
      const capability = opaqueId(capabilityId, 'capability id');
      const recoveredClaim = entity.state === 'CLAIMED' && this.#recoveredBrowserClaims.has(entity.id);
      if (recoveredClaim) {
        if (
          ![entity.generation - 1, entity.generation].includes(expectedGeneration) ||
          entity.capabilityId !== capability ||
          !isDeepStrictEqual(entity.executionBinding, binding) ||
          !isDeepStrictEqual(entity.authorization, authorized)
        ) {
          fail('browser_session_binding_mismatch', 'recovered browser claim binding does not exactly match');
        }
        return freezeRecord({
          mode: 'RECOVERY_READBACK_ONLY',
          generation: entity.generation,
          publicIdentity: entity.publicIdentity,
        });
      }
      if (entity.generation !== expectedGeneration) {
        fail('generation_conflict', 'browser session generation does not match');
      }
      if (
        entity.state !== 'CHECKED_OUT' ||
        entity.capabilityId !== capability
      ) {
        fail('browser_capability_invalid', 'browser capability is invalid or already used');
      }
      if (this.#clock() >= Date.parse(entity.expiresAt)) {
        const reclaimedAt = this.#clock();
        const available = freezeRecord({
          id: entity.id,
          generation: entity.generation + 1,
          state: 'AVAILABLE',
          registeredAt: entity.registeredAt,
          executionBinding: entity.executionBinding,
          publicIdentity: entity.publicIdentity,
          maxUses: 1,
          useCount: 0,
        });
        const audit = auditFrom({
          idFactory: this.#idFactory,
          now: reclaimedAt,
          eventType: 'BROWSER_SESSION_EXPIRED_RECLAIMED',
          outcome: 'RECLAIMED',
          entityType: 'BrowserSessionBinding',
          entity,
        });
        await this.#append({ entityType: 'BrowserSessionBinding', entity: available, audit });
        fail('browser_capability_expired', 'browser capability has expired');
      }
      if (
        !isDeepStrictEqual(entity.executionBinding, binding) ||
        !isDeepStrictEqual(entity.authorization, authorized)
      ) {
        fail('browser_session_binding_mismatch', 'browser authorization does not exactly match checkout');
      }
      const now = this.#clock();
      const claimed = freezeRecord({
        ...entity,
        generation: entity.generation + 1,
        state: 'CLAIMED',
        claimedAt: iso(now),
      });
      const audit = auditFrom({
        idFactory: this.#idFactory,
        now,
        eventType: 'BROWSER_SESSION_EXECUTION_CLAIMED',
        outcome: 'SUCCESS',
        entityType: 'BrowserSessionBinding',
        entity: claimed,
      });
      await this.#append({ entityType: 'BrowserSessionBinding', entity: claimed, audit });
      return freezeRecord({
        mode: 'EXECUTE',
        generation: claimed.generation,
        publicIdentity: claimed.publicIdentity,
      });
    });
  }

  claimBrowserSessionRecovery({
    sessionId,
    capabilityId,
    expectedGeneration,
    executionBinding,
    request,
    leaseId,
    profileGeneration,
    role,
  }) {
    return this.#serialize(async () => {
      const entity = this.#browserSessionBindings.get(opaqueId(sessionId, 'browser session id'));
      if (!entity) fail('browser_session_not_found', 'browser session binding does not exist');
      positiveInteger(expectedGeneration, 'expectedGeneration');
      if (entity.state !== 'CLAIMED') return null;
      if (!this.#recoveredBrowserClaims.has(entity.id)) {
        fail('generation_conflict', 'browser execution is already claimed by an active operation');
      }
      const authorization = normalizeBrowserAuthorization({
        actionClass: entity.authorization.actionClass,
        authStrategyIndex: entity.authorization.authStrategyIndex,
        leaseId,
        profileGeneration,
        request,
        role,
        ruleId: entity.authorization.ruleId,
        strategyEvidenceKey: entity.authorization.strategyEvidenceKey,
      });
      if (
        ![entity.generation - 1, entity.generation].includes(expectedGeneration) ||
        entity.capabilityId !== opaqueId(capabilityId, 'capability id') ||
        !isDeepStrictEqual(entity.executionBinding, normalizeExecutionBinding(executionBinding)) ||
        !isDeepStrictEqual(entity.authorization, authorization)
      ) {
        fail('browser_session_binding_mismatch', 'browser recovery binding does not exactly match the claim');
      }
      return freezeRecord({
        mode: 'RECOVERY_READBACK_ONLY',
        generation: entity.generation,
        publicIdentity: entity.publicIdentity,
        authorization: entity.authorization,
      });
    });
  }

  requireBrowserSessionReconciliation({
    sessionId,
    capabilityId,
    expectedGeneration,
    executionBinding,
    authorization,
  }) {
    return this.#serialize(async () => {
      const entity = this.#browserSessionBindings.get(opaqueId(sessionId, 'browser session id'));
      if (!entity) fail('browser_session_not_found', 'browser session binding does not exist');
      positiveInteger(expectedGeneration, 'expectedGeneration');
      if (
        entity.generation !== expectedGeneration || entity.state !== 'CLAIMED' ||
        entity.capabilityId !== opaqueId(capabilityId, 'capability id') ||
        !isDeepStrictEqual(entity.executionBinding, normalizeExecutionBinding(executionBinding)) ||
        !isDeepStrictEqual(entity.authorization, normalizeBrowserAuthorization(authorization))
      ) {
        fail('browser_session_binding_mismatch', 'browser reconciliation binding does not exactly match the claim');
      }
      this.#recoveredBrowserClaims.add(entity.id);
      return freezeRecord({ state: 'RECONCILIATION_REQUIRED', generation: entity.generation });
    });
  }

  abortBrowserSessionAfterReconciliation({
    sessionId,
    capabilityId,
    expectedGeneration,
    executionBinding,
    authorization,
  }) {
    return this.#serialize(async () => {
      const entity = this.#browserSessionBindings.get(opaqueId(sessionId, 'browser session id'));
      if (!entity) fail('browser_session_not_found', 'browser session binding does not exist');
      positiveInteger(expectedGeneration, 'expectedGeneration');
      if (
        !this.#recoveredBrowserClaims.has(entity.id) || entity.generation !== expectedGeneration ||
        entity.state !== 'CLAIMED' || entity.capabilityId !== opaqueId(capabilityId, 'capability id') ||
        !isDeepStrictEqual(entity.executionBinding, normalizeExecutionBinding(executionBinding)) ||
        !isDeepStrictEqual(entity.authorization, normalizeBrowserAuthorization(authorization))
      ) {
        fail('browser_session_binding_mismatch', 'browser reconciliation abort does not exactly match the claim');
      }
      const now = this.#clock();
      const available = freezeRecord({
        id: entity.id,
        generation: entity.generation + 1,
        state: 'AVAILABLE',
        registeredAt: entity.registeredAt,
        executionBinding: entity.executionBinding,
        publicIdentity: entity.publicIdentity,
        maxUses: 1,
        useCount: 0,
      });
      const audit = auditFrom({
        idFactory: this.#idFactory,
        now,
        eventType: 'BROWSER_SESSION_RECONCILED_NOT_APPLIED',
        outcome: 'NOT_APPLIED',
        entityType: 'BrowserSessionBinding',
        entity,
      });
      await this.#append({ entityType: 'BrowserSessionBinding', entity: available, audit });
      this.#recoveredBrowserClaims.delete(entity.id);
      return this.browserSessionView(available);
    });
  }

  completeBrowserSession({
    sessionId,
    capabilityId,
    expectedGeneration,
    executionBinding,
    authorization,
    readIdentity,
    recoveryMode = false,
  }) {
    return this.#serialize(async () => {
      const entity = this.#browserSessionBindings.get(opaqueId(sessionId, 'browser session id'));
      if (!entity) {
        fail('browser_session_not_found', 'browser session binding does not exist');
      }
      positiveInteger(expectedGeneration, 'expectedGeneration');
      const binding = normalizeExecutionBinding(executionBinding);
      const authorized = normalizeBrowserAuthorization(authorization);
      if (typeof recoveryMode !== 'boolean') fail('invalid_request', 'browser recovery mode is invalid');
      if (typeof readIdentity !== 'function') {
        fail('identity_readback_unavailable', 'trusted provider identity readback is required');
      }
      if (entity.generation !== expectedGeneration) {
        fail('generation_conflict', 'browser session generation does not match');
      }
      const now = this.#clock();
      if (entity.state !== 'CLAIMED' || entity.capabilityId !== opaqueId(capabilityId, 'capability id')) {
        fail('browser_capability_invalid', 'browser capability is invalid or already used');
      }
      const reconciliationRequired = this.#recoveredBrowserClaims.has(entity.id);
      if (recoveryMode !== reconciliationRequired) {
        fail(
          'browser_reconciliation_required',
          'browser claim recovery mode does not match its durable execution state',
        );
      }
      if (!recoveryMode && now >= Date.parse(entity.expiresAt)) {
        this.#recoveredBrowserClaims.add(entity.id);
        fail('browser_capability_expired', 'browser capability has expired');
      }
      if (!isDeepStrictEqual(entity.executionBinding, binding)) {
        await this.#recordFailure({
          eventType: 'BROWSER_SESSION_COMPLETE', outcome: 'BINDING_MISMATCH',
          entityType: 'BrowserSessionBinding', entity,
        });
        fail('browser_session_binding_mismatch', 'browser session binding does not exactly match');
      }
      if (!isDeepStrictEqual(entity.authorization, authorized)) {
        await this.#recordFailure({
          eventType: 'BROWSER_SESSION_COMPLETE', outcome: 'AUTHORIZATION_MISMATCH',
          entityType: 'BrowserSessionBinding', entity,
        });
        fail('browser_session_binding_mismatch', 'browser authorization does not exactly match checkout');
      }
      let readback;
      try {
        readback = normalizePublicIdentity(await readIdentity({
          sessionId: entity.id,
          capabilityId: entity.capabilityId,
        }));
      } catch {
        this.#recoveredBrowserClaims.add(entity.id);
        await this.#recordFailure({
          eventType: 'BROWSER_SESSION_COMPLETE', outcome: 'IDENTITY_READBACK_FAILED',
          entityType: 'BrowserSessionBinding', entity,
        });
        fail('identity_readback_unavailable', 'trusted provider identity readback failed');
      }
      const completedAt = this.#clock();
      if (!recoveryMode && completedAt >= Date.parse(entity.expiresAt)) {
        this.#recoveredBrowserClaims.add(entity.id);
        await this.#recordFailure({
          eventType: 'BROWSER_SESSION_COMPLETE', outcome: 'EXPIRED',
          entityType: 'BrowserSessionBinding', entity,
        });
        fail('browser_capability_expired', 'browser capability expired during identity readback');
      }
      if (!isDeepStrictEqual(entity.publicIdentity, readback)) {
        this.#recoveredBrowserClaims.add(entity.id);
        await this.#recordFailure({
          eventType: 'BROWSER_SESSION_COMPLETE', outcome: 'IDENTITY_MISMATCH',
          entityType: 'BrowserSessionBinding', entity,
        });
        fail('identity_readback_mismatch', 'provider identity readback does not match the expected identity');
      }

      const completed = freezeRecord({
        ...entity,
        generation: entity.generation + 1,
        state: 'COMPLETED',
        useCount: 1,
        completedAt: iso(completedAt),
      });
      const audit = auditFrom({
        idFactory: this.#idFactory,
        now: completedAt,
        eventType: recoveryMode ? 'BROWSER_SESSION_RECOVERED' : 'BROWSER_SESSION_COMPLETED',
        outcome: 'SUCCESS',
        entityType: 'BrowserSessionBinding',
        entity: completed,
      });
      await this.#append({ entityType: 'BrowserSessionBinding', entity: completed, audit });
      this.#recoveredBrowserClaims.delete(entity.id);
      return this.browserSessionView(completed);
    });
  }

  abortBrowserSession({ sessionId, capabilityId, expectedGeneration, executionBinding, authorization }) {
    return this.#serialize(async () => {
      const entity = this.#browserSessionBindings.get(opaqueId(sessionId, 'browser session id'));
      if (!entity) fail('browser_session_not_found', 'browser session binding does not exist');
      positiveInteger(expectedGeneration, 'expectedGeneration');
      const binding = normalizeExecutionBinding(executionBinding);
      const authorized = normalizeBrowserAuthorization(authorization);
      if (
        entity.generation !== expectedGeneration || entity.state !== 'CHECKED_OUT' ||
        entity.capabilityId !== opaqueId(capabilityId, 'capability id') ||
        !isDeepStrictEqual(entity.executionBinding, binding) ||
        !isDeepStrictEqual(entity.authorization, authorized)
      ) {
        fail('browser_session_binding_mismatch', 'browser abort binding does not exactly match checkout');
      }
      const now = this.#clock();
      const available = freezeRecord({
        id: entity.id,
        generation: entity.generation + 1,
        state: 'AVAILABLE',
        registeredAt: entity.registeredAt,
        executionBinding: entity.executionBinding,
        publicIdentity: entity.publicIdentity,
        maxUses: 1,
        useCount: 0,
      });
      const audit = auditFrom({
        idFactory: this.#idFactory,
        now,
        eventType: 'BROWSER_SESSION_ABORTED',
        outcome: 'ABORTED',
        entityType: 'BrowserSessionBinding',
        entity,
      });
      await this.#append({ entityType: 'BrowserSessionBinding', entity: available, audit });
      return this.browserSessionView(available);
    });
  }

  blockBrowserSessionForReauth({
    sessionId,
    capabilityId,
    expectedGeneration,
    executionBinding,
    authorization,
  }) {
    return this.#serialize(async () => {
      const entity = this.#browserSessionBindings.get(opaqueId(sessionId, 'browser session id'));
      if (!entity) fail('browser_session_not_found', 'browser session binding does not exist');
      positiveInteger(expectedGeneration, 'expectedGeneration');
      const binding = normalizeExecutionBinding(executionBinding);
      const authorized = normalizeBrowserAuthorization(authorization);
      if (
        entity.generation !== expectedGeneration || entity.state !== 'CLAIMED' ||
        entity.capabilityId !== opaqueId(capabilityId, 'capability id') ||
        !isDeepStrictEqual(entity.executionBinding, binding) ||
        !isDeepStrictEqual(entity.authorization, authorized)
      ) {
        fail('browser_session_binding_mismatch', 'browser reauth block does not exactly match the claim');
      }
      const now = this.#clock();
      const available = freezeRecord({
        id: entity.id,
        generation: entity.generation + 1,
        state: 'AVAILABLE',
        registeredAt: entity.registeredAt,
        executionBinding: entity.executionBinding,
        publicIdentity: entity.publicIdentity,
        maxUses: 1,
        useCount: 0,
      });
      const audit = auditFrom({
        idFactory: this.#idFactory,
        now,
        eventType: 'BROWSER_SESSION_BLOCKED_FOR_REAUTH',
        outcome: HUMAN_REAUTH_REQUIRED,
        entityType: 'BrowserSessionBinding',
        entity,
      });
      await this.#append({ entityType: 'BrowserSessionBinding', entity: available, audit });
      this.#recoveredBrowserClaims.delete(entity.id);
      return this.browserSessionView(available);
    });
  }

  createReauthRequest({ reason, executionBinding, publicIdentity }) {
    return this.#serialize(async () => {
      const classification = classifyReauth(reason);
      const binding = normalizeExecutionBinding(executionBinding);
      const identity = normalizePublicIdentity(publicIdentity);
      const existing = [...this.#reauthRequests.values()].find((candidate) =>
        candidate.state === HUMAN_REAUTH_REQUIRED &&
        candidate.reason === classification.code &&
        isDeepStrictEqual(candidate.executionBinding, binding) &&
        isDeepStrictEqual(candidate.publicIdentity, identity),
      );
      if (existing) return this.reauthRequestView(existing);
      const now = this.#clock();
      const entity = freezeRecord({
        id: opaqueId(this.#idFactory(), 'reauth request id'),
        generation: 1,
        state: HUMAN_REAUTH_REQUIRED,
        reason: classification.code,
        requestedAt: iso(now),
        requestedSequence: this.#sequence + 1,
        executionBinding: binding,
        publicIdentity: identity,
      });
      const audit = auditFrom({
        idFactory: this.#idFactory,
        now,
        eventType: 'REAUTH_REQUESTED',
        outcome: HUMAN_REAUTH_REQUIRED,
        entityType: 'ReauthRequest',
        entity,
        details: { reason: entity.reason },
      });
      await this.#append({ entityType: 'ReauthRequest', entity, audit });
      return this.reauthRequestView(entity);
    });
  }

  resolveReauthRequest({ id, expectedGeneration, executionBinding, publicIdentity }) {
    return this.#serialize(async () => {
      const entity = this.#reauthRequests.get(opaqueId(id, 'reauth request id'));
      if (!entity) fail('reauth_request_not_found', 'reauth request does not exist');
      positiveInteger(expectedGeneration, 'expectedGeneration');
      const binding = normalizeExecutionBinding(executionBinding);
      const identity = normalizePublicIdentity(publicIdentity);
      if (
        entity.generation !== expectedGeneration || entity.state !== HUMAN_REAUTH_REQUIRED ||
        !isDeepStrictEqual(entity.executionBinding, binding) ||
        !isDeepStrictEqual(entity.publicIdentity, identity)
      ) {
        fail('reauth_request_binding_mismatch', 'reauth resolution does not exactly match');
      }
      const now = this.#clock();
      const resolved = freezeRecord({
        ...entity,
        generation: entity.generation + 1,
        state: 'RESOLVED',
        resolvedAt: iso(now),
      });
      const audit = auditFrom({
        idFactory: this.#idFactory,
        now,
        eventType: 'REAUTH_RESOLVED',
        outcome: 'SUCCESS',
        entityType: 'ReauthRequest',
        entity: resolved,
      });
      await this.#append({ entityType: 'ReauthRequest', entity: resolved, audit });
      return this.reauthRequestView(resolved);
    });
  }

  credentialCheckoutView(entity) {
    return freezeRecord({
      id: entity.id,
      generation: entity.generation,
      state: entity.state,
      issuedAt: entity.issuedAt,
      expiresAt: entity.expiresAt,
      maxUses: entity.maxUses,
      useCount: entity.useCount,
      ruleId: entity.ruleId,
      executionBinding: entity.executionBinding,
      provider: entity.request.provider,
      capability: entity.request.capability,
      secretExportable: false,
    });
  }

  browserCheckoutView(entity) {
    return freezeRecord({
      capabilityId: entity.capabilityId,
      publicIdentity: entity.publicIdentity,
    });
  }

  browserSessionView(entity) {
    return freezeRecord({
      id: entity.id,
      generation: entity.generation,
      state: entity.state,
      maxUses: entity.maxUses,
      useCount: entity.useCount,
      publicIdentity: entity.publicIdentity,
    });
  }

  reauthRequestView(entity) {
    return freezeRecord({
      id: entity.id,
      generation: entity.generation,
      state: entity.state,
      reason: entity.reason,
      requestedAt: entity.requestedAt,
      ...(entity.resolvedAt ? { resolvedAt: entity.resolvedAt } : {}),
      executionBinding: entity.executionBinding,
      publicIdentity: entity.publicIdentity,
    });
  }

  providerGrantView(entity) {
    return freezeRecord({
      id: entity.id,
      digest: entity.digest,
      bindingHash: entity.bindingHash,
      commandDigest: entity.commandDigest,
      policyGeneration: entity.policyGeneration,
      // The grant policy remains registered until expiry. One-use consumption is
      // represented by the separate execution result and enforced in durable state.
      state: 'ACTIVE',
    });
  }

  providerGrantExecutionView(entity) {
    if (entity.state !== 'COMPLETED') {
      return freezeRecord({
        generation: entity.grant.command.generation,
        outcome: 'RESULT_UNKNOWN',
      });
    }
    const outcome = entity.result.outcome === 'SUCCESS'
      ? 'SUCCESS'
      : entity.result.outcome === 'FAILED' ? 'ADAPTER_FAILED' : HUMAN_REAUTH_REQUIRED;
    return freezeRecord({
      generation: entity.grant.command.generation,
      outcome,
      ...(entity.result.errorCode ? { errorCode: entity.result.errorCode } : {}),
    });
  }

  snapshot() {
    return freezeRecord({
      credentialCheckouts: [...this.#credentialCheckouts.values()],
      browserSessionBindings: [...this.#browserSessionBindings.values()],
      reauthRequests: [...this.#reauthRequests.values()],
      providerGrants: [...this.#providerGrants.values()],
      attestationNonces: [...this.#attestationNonces.values()],
      auditEvents: this.#auditEvents,
    });
  }

  integrityCheckpoint() {
    if (!this.#journalMacKey) {
      fail('state_integrity_disabled', 'durable auth journal integrity is not enabled');
    }
    return freezeRecord({ sequence: this.#sequence, headMac: this.#lastMac ?? JOURNAL_GENESIS_MAC });
  }

  #zeroIntegrityKey() {
    if (Buffer.isBuffer(this.#journalMacKey)) {
      this.#journalMacKey.fill(0);
      this.#journalMacKey = undefined;
    }
  }

  async close() {
    await this.#queue;
    if (!this.#closed) {
      this.#closed = true;
      try {
        await this.#journalHandle.close();
      } finally {
        await this.#writerLock.release();
      }
    }
    this.#zeroIntegrityKey();
  }
}
