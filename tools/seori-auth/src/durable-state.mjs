import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readFile, lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { fail } from './errors.mjs';
import { LEASE_TTL_MS } from './lease-store.mjs';
import { classifyReauth } from './reauth.mjs';
import { normalizeLeaseRequest } from './validation.mjs';

const AUDIT_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PROVIDER = /^[a-z0-9][a-z0-9-]*$/;
const CREDENTIAL_REF = /^(shared|app)\/[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)+$/;
const JOURNAL_FILE = 'auth-journal.jsonl';
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
  return freezeRecord({
    id: publicId(idFactory(), 'audit id'),
    eventType: publicId(eventType, 'audit event type'),
    outcome: publicId(outcome, 'audit outcome'),
    entityType,
    entityId: opaqueId(entity.id, 'audit entity id'),
    generation: positiveInteger(entity.generation, 'audit generation'),
    recordedAt: iso(now),
    ...(binding ? { executionBinding: binding } : {}),
    ...(entity.credentialRef ? { credentialRef: entity.credentialRef } : {}),
    ...(entity.publicIdentity ? { publicIdentity: entity.publicIdentity } : {}),
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

function validateReplayedEntity(type, entity) {
  opaqueId(entity.id, 'entity id');
  positiveInteger(entity.generation, 'entity generation');
  if (type === 'CredentialCheckout') {
    const keys = [
      'id', 'generation', 'state', 'issuedAt', 'expiresAt', 'maxUses', 'useCount', 'ruleId',
      'credentialRef', 'credentialGeneration', 'policyGeneration', 'executionBinding', 'request',
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
    const transitionKeys = entity.state === 'AVAILABLE' ? [] : ['capabilityId', 'checkedOutAt', 'expiresAt'];
    const completedKeys = entity.state === 'COMPLETED' ? ['completedAt'] : [];
    const keys = [
      'id', 'generation', 'state', 'registeredAt', 'executionBinding', 'publicIdentity',
      'maxUses', 'useCount', ...transitionKeys, ...completedKeys,
    ];
    if (
      !exactRecordKeys(entity, keys) || !['AVAILABLE', 'CHECKED_OUT', 'COMPLETED'].includes(entity.state) ||
      !validIso(entity.registeredAt) ||
      (entity.checkedOutAt !== undefined && !validIso(entity.checkedOutAt)) ||
      (entity.expiresAt !== undefined && !validIso(entity.expiresAt)) ||
      (entity.completedAt !== undefined && !validIso(entity.completedAt)) ||
      entity.maxUses !== 1 || ![0, 1].includes(entity.useCount) ||
      entity.useCount !== (entity.state === 'COMPLETED' ? 1 : 0)
    ) throw new Error('invalid browser session binding');
    if (entity.capabilityId !== undefined) opaqueId(entity.capabilityId, 'capability id');
    normalizeExecutionBinding(entity.executionBinding);
    normalizePublicIdentity(entity.publicIdentity);
    return;
  }
  const reauthKeys = [
    'id', 'generation', 'state', 'reason', 'requestedAt', 'executionBinding', 'publicIdentity',
  ];
  if (
    type !== 'ReauthRequest' || !exactRecordKeys(entity, reauthKeys) || entity.generation !== 1 ||
    entity.state !== HUMAN_REAUTH_REQUIRED || !validIso(entity.requestedAt)
  ) throw new Error('invalid reauth request');
  publicId(entity.reason, 'reauth reason');
  classifyReauth(entity.reason);
  normalizeExecutionBinding(entity.executionBinding);
  normalizePublicIdentity(entity.publicIdentity);
}

function validateReplayedAudit(audit) {
  const allowed = [
    'id', 'eventType', 'outcome', 'entityType', 'entityId', 'generation', 'recordedAt',
    'executionBinding', 'credentialRef', 'publicIdentity', 'reason', 'exitCode', 'signal',
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
}

function validateEnvelope(envelope, expectedSequence) {
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    envelope.schemaVersion !== 1 ||
    envelope.sequence !== expectedSequence ||
    typeof envelope.recordedAt !== 'string' ||
    !envelope.audit ||
    typeof envelope.audit !== 'object'
  ) {
    fail('invalid_state_journal', 'durable auth journal is malformed');
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
  const absoluteDirectory = resolve(directory);
  await mkdir(absoluteDirectory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(absoluteDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) {
    fail('insecure_state_directory', 'durable auth state directory must be a private non-symlink directory');
  }

  const journalPath = join(absoluteDirectory, JOURNAL_FILE);
  try {
    const journalStat = await lstat(journalPath);
    if (!journalStat.isFile() || journalStat.isSymbolicLink() || (journalStat.mode & 0o077) !== 0) {
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
  if (!handleStat.isFile() || (handleStat.mode & 0o077) !== 0) {
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
  #sequence = 0;
  #queue = Promise.resolve();
  #closed = false;
  #credentialCheckouts = new Map();
  #browserSessionBindings = new Map();
  #reauthRequests = new Map();
  #auditEvents = [];

  static async open({ directory, clock = () => Date.now(), idFactory = () => randomUUID() }) {
    if (typeof directory !== 'string' || !isAbsolute(directory)) {
      fail('invalid_state_directory', 'durable auth state directory must be an absolute path');
    }
    const opened = await openSecureJournal(directory);
    const state = new DurableAuthState({ ...opened, clock, idFactory });
    try {
      await state.#replay();
    } catch (error) {
      state.#closed = true;
      await opened.handle.close();
      throw error;
    }
    return state;
  }

  constructor({ journalPath, handle, clock, idFactory }) {
    this.#journalPath = journalPath;
    this.#journalHandle = handle;
    this.#clock = clock;
    this.#idFactory = idFactory;
  }

  async #replay() {
    const contents = await readFile(this.#journalPath, 'utf8');
    if (contents.length === 0) {
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
      validateEnvelope(envelope, this.#sequence + 1);
      this.#applyEnvelope(envelope);
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
    this.#auditEvents.push(freezeRecord(envelope.audit));
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
    const envelope = {
      schemaVersion: 1,
      sequence: this.#sequence + 1,
      recordedAt: audit.recordedAt,
      mutation: entityType === null ? null : { entityType, entity },
      audit,
    };
    try {
      await this.#journalHandle.appendFile(`${JSON.stringify(envelope)}\n`, 'utf8');
      await this.#journalHandle.sync();
    } catch {
      // An uncertain append must stop all further mutations. Reusing the old
      // in-memory sequence could create a journal that cannot be replayed safely.
      this.#closed = true;
      await this.#journalHandle.close().catch(() => {});
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

  issueCredentialCheckout({ authorized, workerId, currentCredentialGeneration, currentPolicyGeneration }) {
    return this.#serialize(async () => {
      const request = normalizeLeaseRequest(authorized?.request);
      const normalizedWorkerId = publicId(workerId, 'workerId');
      if (currentPolicyGeneration !== request.policyGeneration) {
        fail('stale_policy_generation', 'policy generation changed before lease issuance');
      }
      if (currentCredentialGeneration !== request.credentialGeneration) {
        fail('stale_credential_generation', 'credential generation changed before lease issuance');
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
        executionBinding: leaseBinding(request, normalizedWorkerId),
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

  checkoutBrowserSession({ sessionId, expectedGeneration, executionBinding, expectedIdentity }) {
    return this.#serialize(async () => {
      const entity = this.#browserSessionBindings.get(opaqueId(sessionId, 'browser session id'));
      if (!entity) {
        fail('browser_session_not_found', 'browser session binding does not exist');
      }
      positiveInteger(expectedGeneration, 'expectedGeneration');
      const binding = normalizeExecutionBinding(executionBinding);
      const identity = normalizePublicIdentity(expectedIdentity);
      if (entity.generation !== expectedGeneration) {
        fail('generation_conflict', 'browser session generation does not match');
      }
      if (
        entity.state !== 'AVAILABLE' || entity.useCount !== 0 ||
        !isDeepStrictEqual(entity.executionBinding, binding) ||
        !isDeepStrictEqual(entity.publicIdentity, identity)
      ) {
        fail('browser_session_binding_mismatch', 'browser session binding does not exactly match');
      }

      const now = this.#clock();
      const accountBusy = [...this.#browserSessionBindings.values()].some((candidate) =>
        candidate.id !== entity.id &&
        candidate.state === 'CHECKED_OUT' &&
        Date.parse(candidate.expiresAt) > now &&
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

  completeBrowserSession({
    sessionId,
    capabilityId,
    expectedGeneration,
    executionBinding,
    readIdentity,
  }) {
    return this.#serialize(async () => {
      const entity = this.#browserSessionBindings.get(opaqueId(sessionId, 'browser session id'));
      if (!entity) {
        fail('browser_session_not_found', 'browser session binding does not exist');
      }
      positiveInteger(expectedGeneration, 'expectedGeneration');
      const binding = normalizeExecutionBinding(executionBinding);
      if (typeof readIdentity !== 'function') {
        fail('identity_readback_unavailable', 'trusted provider identity readback is required');
      }
      if (entity.generation !== expectedGeneration) {
        fail('generation_conflict', 'browser session generation does not match');
      }
      const now = this.#clock();
      if (entity.state !== 'CHECKED_OUT' || entity.capabilityId !== opaqueId(capabilityId, 'capability id')) {
        fail('browser_capability_invalid', 'browser capability is invalid or already used');
      }
      if (now >= Date.parse(entity.expiresAt)) {
        fail('browser_capability_expired', 'browser capability has expired');
      }
      if (!isDeepStrictEqual(entity.executionBinding, binding)) {
        await this.#recordFailure({
          eventType: 'BROWSER_SESSION_COMPLETE', outcome: 'BINDING_MISMATCH',
          entityType: 'BrowserSessionBinding', entity,
        });
        fail('browser_session_binding_mismatch', 'browser session binding does not exactly match');
      }
      let readback;
      try {
        readback = normalizePublicIdentity(await readIdentity({
          sessionId: entity.id,
          capabilityId: entity.capabilityId,
        }));
      } catch {
        await this.#recordFailure({
          eventType: 'BROWSER_SESSION_COMPLETE', outcome: 'IDENTITY_READBACK_FAILED',
          entityType: 'BrowserSessionBinding', entity,
        });
        fail('identity_readback_unavailable', 'trusted provider identity readback failed');
      }
      const completedAt = this.#clock();
      if (completedAt >= Date.parse(entity.expiresAt)) {
        await this.#recordFailure({
          eventType: 'BROWSER_SESSION_COMPLETE', outcome: 'EXPIRED',
          entityType: 'BrowserSessionBinding', entity,
        });
        fail('browser_capability_expired', 'browser capability expired during identity readback');
      }
      if (!isDeepStrictEqual(entity.publicIdentity, readback)) {
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
        eventType: 'BROWSER_SESSION_COMPLETED',
        outcome: 'SUCCESS',
        entityType: 'BrowserSessionBinding',
        entity: completed,
      });
      await this.#append({ entityType: 'BrowserSessionBinding', entity: completed, audit });
      return this.browserSessionView(completed);
    });
  }

  createReauthRequest({ reason, executionBinding, publicIdentity }) {
    return this.#serialize(async () => {
      const classification = classifyReauth(reason);
      const now = this.#clock();
      const entity = freezeRecord({
        id: opaqueId(this.#idFactory(), 'reauth request id'),
        generation: 1,
        state: HUMAN_REAUTH_REQUIRED,
        reason: classification.code,
        requestedAt: iso(now),
        executionBinding: normalizeExecutionBinding(executionBinding),
        publicIdentity: normalizePublicIdentity(publicIdentity),
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

  async close() {
    await this.#queue;
    if (!this.#closed) {
      this.#closed = true;
      await this.#journalHandle.close();
    }
  }
}
