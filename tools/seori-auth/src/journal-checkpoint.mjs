import { createHash } from 'node:crypto';

import { fail } from './errors.mjs';
import { PROVIDER_CONTROL_PLANE_CLIENT_SPIFFE_ID } from './provider-grants.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const JOURNAL_ID = /^[a-z0-9][a-z0-9.-]{0,127}$/;
const CONTROL_PLANE_BRAND = Symbol('seori-auth-journal-checkpoint-control-plane');
const CHECKPOINT_KEYS = ['generation', 'headMac', 'journalId', 'schemaVersion', 'sequence'];
const BINDING_KEYS = [
  'authoritySpiffeId', 'commitOrder', 'journalId', 'mode', 'persistence',
  'schemaVersion', 'unknownOutcomePolicy',
];
const READ_KEYS = ['journalId', 'schemaVersion'];
const CAS_KEYS = ['expected', 'idempotencyKey', 'journalId', 'next', 'schemaVersion'];

export const JOURNAL_CHECKPOINT_GENESIS_MAC = '0'.repeat(64);
export const JOURNAL_CHECKPOINT_CONTRACT = Object.freeze({
  schemaVersion: 1,
  mode: 'TRUSTED_CONTROL_PLANE_CAS',
  persistence: 'BACKOFFICE_DURABLE_CAS',
  commitOrder: 'JOURNAL_FSYNC_THEN_CHECKPOINT_CAS',
  unknownOutcomePolicy: 'READBACK_FIRST',
});

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).toSorted().join('\0') === [...expected].toSorted().join('\0');
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('invalid_state_checkpoint', `${label} must be a non-negative integer`);
  }
  return value;
}

function journalId(value) {
  if (typeof value !== 'string' || !JOURNAL_ID.test(value)) {
    fail('invalid_state_checkpoint', 'journal checkpoint id is invalid');
  }
  return value;
}

export function normalizeJournalCheckpoint(value, expectedJournalId) {
  if (
    !exactKeys(value, CHECKPOINT_KEYS) || value.schemaVersion !== 1 ||
    journalId(value.journalId) !== journalId(expectedJournalId) ||
    !SHA256.test(value.headMac ?? '')
  ) {
    fail('invalid_state_checkpoint', 'journal checkpoint is invalid');
  }
  const generation = nonNegativeInteger(value.generation, 'checkpoint generation');
  const sequence = nonNegativeInteger(value.sequence, 'checkpoint sequence');
  if (
    generation !== sequence ||
    (sequence === 0) !== (value.headMac === JOURNAL_CHECKPOINT_GENESIS_MAC)
  ) {
    fail('invalid_state_checkpoint', 'journal checkpoint lineage is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    journalId: value.journalId,
    generation,
    sequence,
    headMac: value.headMac,
  });
}

export function normalizeJournalCheckpointBinding(value) {
  if (
    !exactKeys(value, BINDING_KEYS) ||
    value.schemaVersion !== JOURNAL_CHECKPOINT_CONTRACT.schemaVersion ||
    value.mode !== JOURNAL_CHECKPOINT_CONTRACT.mode ||
    value.persistence !== JOURNAL_CHECKPOINT_CONTRACT.persistence ||
    value.commitOrder !== JOURNAL_CHECKPOINT_CONTRACT.commitOrder ||
    value.unknownOutcomePolicy !== JOURNAL_CHECKPOINT_CONTRACT.unknownOutcomePolicy ||
    value.authoritySpiffeId !== PROVIDER_CONTROL_PLANE_CLIENT_SPIFFE_ID
  ) {
    fail('invalid_state_checkpoint', 'journal checkpoint control-plane binding is invalid');
  }
  return Object.freeze({
    ...JOURNAL_CHECKPOINT_CONTRACT,
    journalId: journalId(value.journalId),
    authoritySpiffeId: value.authoritySpiffeId,
  });
}

function normalizeReadRequest(value, binding) {
  if (
    !exactKeys(value, READ_KEYS) || value.schemaVersion !== 1 ||
    value.journalId !== binding.journalId
  ) fail('invalid_state_checkpoint', 'journal checkpoint read request is invalid');
  return Object.freeze({ schemaVersion: 1, journalId: binding.journalId });
}

function checkpointTransitionId(binding, expected, next) {
  return createHash('sha256')
    .update('seori-auth-journal-checkpoint-cas-v1\n', 'utf8')
    .update(`${binding.journalId}\n`, 'utf8')
    .update(`${expected.generation}\n${expected.sequence}\n${expected.headMac}\n`, 'utf8')
    .update(`${next.generation}\n${next.sequence}\n${next.headMac}\n`, 'utf8')
    .digest('hex');
}

export function buildJournalCheckpointTransition({ binding, expected, headMac }) {
  const normalizedBinding = normalizeJournalCheckpointBinding(binding);
  const current = normalizeJournalCheckpoint(expected, normalizedBinding.journalId);
  if (!SHA256.test(headMac ?? '')) {
    fail('invalid_state_checkpoint', 'next journal checkpoint head is invalid');
  }
  const next = Object.freeze({
    schemaVersion: 1,
    journalId: normalizedBinding.journalId,
    generation: current.generation + 1,
    sequence: current.sequence + 1,
    headMac,
  });
  return Object.freeze({
    schemaVersion: 1,
    journalId: normalizedBinding.journalId,
    expected: current,
    next,
    idempotencyKey: checkpointTransitionId(normalizedBinding, current, next),
  });
}

function normalizeCasRequest(value, binding) {
  if (
    !exactKeys(value, CAS_KEYS) || value.schemaVersion !== 1 ||
    value.journalId !== binding.journalId || !SHA256.test(value.idempotencyKey ?? '')
  ) fail('invalid_state_checkpoint', 'journal checkpoint CAS request is invalid');
  const expected = normalizeJournalCheckpoint(value.expected, binding.journalId);
  const next = normalizeJournalCheckpoint(value.next, binding.journalId);
  if (
    next.generation !== expected.generation + 1 ||
    next.sequence !== expected.sequence + 1 ||
    value.idempotencyKey !== checkpointTransitionId(binding, expected, next)
  ) fail('invalid_state_checkpoint', 'journal checkpoint CAS transition is invalid');
  return Object.freeze({
    schemaVersion: 1,
    journalId: binding.journalId,
    expected,
    next,
    idempotencyKey: value.idempotencyKey,
  });
}

export function createTrustedJournalCheckpointControlPlane({
  binding,
  readCurrent,
  compareAndSwap,
}) {
  const normalizedBinding = normalizeJournalCheckpointBinding(binding);
  if (typeof readCurrent !== 'function' || typeof compareAndSwap !== 'function') {
    fail('invalid_state_checkpoint', 'journal checkpoint control-plane adapter is invalid');
  }
  return Object.freeze({
    binding: normalizedBinding,
    [CONTROL_PLANE_BRAND]: true,
    async readCurrent(request) {
      const normalizedRequest = normalizeReadRequest(request, normalizedBinding);
      const result = await readCurrent(normalizedRequest);
      return normalizeJournalCheckpoint(result, normalizedBinding.journalId);
    },
    async compareAndSwap(request) {
      const normalizedRequest = normalizeCasRequest(request, normalizedBinding);
      const result = await compareAndSwap(normalizedRequest);
      if (
        !exactKeys(result, ['outcome']) ||
        !['COMMITTED', 'CONFLICT', 'UNKNOWN'].includes(result.outcome)
      ) fail('invalid_state_checkpoint', 'journal checkpoint CAS result is invalid');
      return Object.freeze({ outcome: result.outcome });
    },
  });
}

export function requireTrustedJournalCheckpointControlPlane(value, binding) {
  const normalizedBinding = normalizeJournalCheckpointBinding(binding);
  if (
    !value || value[CONTROL_PLANE_BRAND] !== true ||
    typeof value.readCurrent !== 'function' || typeof value.compareAndSwap !== 'function' ||
    value.binding?.journalId !== normalizedBinding.journalId ||
    value.binding?.authoritySpiffeId !== normalizedBinding.authoritySpiffeId ||
    Object.entries(JOURNAL_CHECKPOINT_CONTRACT).some(
      ([key, expected]) => value.binding?.[key] !== expected,
    )
  ) fail('state_checkpoint_control_plane_required', 'trusted journal checkpoint control plane is required');
  return value;
}
