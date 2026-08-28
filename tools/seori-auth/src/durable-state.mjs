import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { fail, SeoriAuthError } from './errors.mjs';
import { LEASE_TTL_MS } from './lease-store.mjs';
import { NATIVE_FILE_LOCK_BRAND } from './native-lock-brand.mjs';
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
]);
const AUTH_STRATEGY_FAILURE_OUTCOMES = new Set(['ADAPTER_FAILED', 'ADAPTER_TIMEOUT']);
const ACTION_CLASS = /^[a-z][a-z_]{1,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

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
  if (!['CredentialCheckout', 'BrowserSessionBinding', 'ReauthRequest'].includes(entityType)) {
    fail('invalid_audit_event', 'auth audit entity type is invalid');
  }
  const binding = entity.executionBinding;
  const request = entity.request ?? entity.authorization?.request;
  return freezeRecord({
    id: opaqueId(idFactory(), 'audit id'),
    eventType: publicId(eventType, 'audit event type'),
    outcome: publicId(outcome, 'audit outcome'),
    entityType,
    entityId: opaqueId(entity.id, 'audit entity id'),
    generation: positiveInteger(entity.generation, 'audit generation'),
    recordedAt: iso(now),
    ...(binding ? { executionBinding: binding } : {}),
    ...((entity.credentialRef ?? request?.credentialRef) ? {
      credentialRef: entity.credentialRef ?? request.credentialRef,
    } : {}),
    ...(entity.publicIdentity ? { publicIdentity: entity.publicIdentity } : {}),
    ...(request ? {
      commitSha: request.commitSha,
      capability: request.capability,
    } : {}),
    ...(entity.capabilityId ? { capabilityId: entity.capabilityId } : {}),
    ...(entity.authorization ? {
      leaseId: entity.authorization.leaseId,
      ruleId: entity.authorization.ruleId,
    } : entity.ruleId ? { ruleId: entity.ruleId } : {}),
    ...((entity.authStrategyIndex ?? entity.authorization?.authStrategyIndex) !== undefined ? {
      actionClass: entity.actionClass ?? entity.authorization.actionClass,
      authStrategyIndex: entity.authStrategyIndex ?? entity.authorization.authStrategyIndex,
      strategyEvidenceKey: entity.strategyEvidenceKey ?? entity.authorization.strategyEvidenceKey,
    } : {}),
    ...(entity.idempotencyKey ? { idempotencyKey: entity.idempotencyKey } : {}),
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
    'actionClass', 'authStrategyIndex', 'strategyEvidenceKey',
  ];
  if (
    !Object.keys(audit).every((key) => allowed.includes(key)) ||
    !['CredentialCheckout', 'BrowserSessionBinding', 'ReauthRequest'].includes(audit.entityType) ||
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
      if (!['CredentialCheckout', 'BrowserSessionBinding', 'ReauthRequest'].includes(type) || !entity) {
        throw new Error('invalid mutation');
      }
      validateReplayedEntity(type, entity);
    }
  } catch {
    fail('invalid_state_journal', 'durable auth journal record is invalid');
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
    fail('invalid_state_journal', 'durable auth journal has an unknown entity type');
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
      schemaVersion: this.#journalMacKey ? 2 : 1,
      sequence: this.#sequence + 1,
      recordedAt: audit.recordedAt,
      ...(this.#journalMacKey ? { previousMac: this.#lastMac ?? JOURNAL_GENESIS_MAC } : {}),
      mutation: entityType === null ? null : { entityType, entity },
      audit,
    };
    if (this.#journalMacKey) {
      envelope.mac = envelopeMac(envelope, this.#journalMacKey);
    }
    try {
      await this.#journalHandle.appendFile(`${JSON.stringify(envelope)}\n`, 'utf8');
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

  snapshot() {
    return freezeRecord({
      credentialCheckouts: [...this.#credentialCheckouts.values()],
      browserSessionBindings: [...this.#browserSessionBindings.values()],
      reauthRequests: [...this.#reauthRequests.values()],
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
