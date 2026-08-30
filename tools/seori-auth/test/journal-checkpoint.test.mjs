import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DurableAuthState, PolicyEngine, SeoriAuthError } from '../src/index.mjs';
import {
  makeJournalCheckpointFixture,
  makeNativeLockProvider,
  makePolicy,
  makeRequest,
  openDurableAuthState,
} from '../fixtures/helpers.mjs';

function authorized() {
  return new PolicyEngine(makePolicy()).authorize(makeRequest());
}

async function issue(state, idempotencyKey) {
  return state.issueCredentialCheckout({
    authorized: authorized(),
    workerId: 'worker-a',
    idempotencyKey,
    currentCredentialGeneration: 3,
    currentPolicyGeneration: 7,
  });
}

test('durable append fsyncs before deterministic checkpoint CAS and exact readback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seori-auth-checkpoint-order-'));
  const journalMacKey = Buffer.alloc(32, 0x31);
  const fixture = makeJournalCheckpointFixture();
  let state;
  try {
    state = await openDurableAuthState({
      directory,
      journalMacKey,
      requireIntegrity: true,
      journalCheckpointBinding: fixture.binding,
      journalCheckpointControlPlane: fixture.controlPlane,
    });
    assert.deepEqual(fixture.operations.map(({ operation }) => operation), ['READ']);

    await issue(state, 'checkpoint-order');
    assert.deepEqual(fixture.operations.map(({ operation }) => operation), ['READ', 'CAS', 'READ']);
    const envelope = JSON.parse((await readFile(join(directory, 'auth-journal.jsonl'), 'utf8')).trimEnd());
    const transition = fixture.operations[1].request;
    assert.deepEqual(transition.expected, {
      schemaVersion: 1,
      journalId: 'test-journal',
      generation: 0,
      sequence: 0,
      headMac: '0'.repeat(64),
    });
    assert.equal(transition.next.sequence, 1);
    assert.equal(transition.next.generation, 1);
    assert.equal(transition.next.headMac, envelope.mac);
    assert.match(transition.idempotencyKey, /^[0-9a-f]{64}$/);
    assert.deepEqual(fixture.current(), transition.next);
  } finally {
    await state?.close();
    journalMacKey.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});

test('unknown checkpoint outcome closes issuance and restart recovers only by readback-first exact CAS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seori-auth-checkpoint-recovery-'));
  const journalMacKey = Buffer.alloc(32, 0x32);
  let commit = false;
  const fixture = makeJournalCheckpointFixture({
    onCompareAndSwap({ request, current, fixture: authority }) {
      if (!commit) return { outcome: 'UNKNOWN' };
      if (
        current.generation !== request.expected.generation ||
        current.sequence !== request.expected.sequence ||
        current.headMac !== request.expected.headMac
      ) return { outcome: 'CONFLICT' };
      authority.setCurrent(request.next);
      return { outcome: 'COMMITTED' };
    },
  });
  let state;
  try {
    state = await openDurableAuthState({
      directory,
      journalMacKey,
      requireIntegrity: true,
      journalCheckpointBinding: fixture.binding,
      journalCheckpointControlPlane: fixture.controlPlane,
    });
    await assert.rejects(
      issue(state, 'checkpoint-unknown'),
      (error) => error instanceof SeoriAuthError && error.code === 'state_checkpoint_commit_unknown',
    );
    await assert.rejects(
      issue(state, 'checkpoint-after-unknown'),
      (error) => error instanceof SeoriAuthError && error.code === 'state_closed',
    );
    assert.equal((await readFile(join(directory, 'auth-journal.jsonl'), 'utf8')).trimEnd().split('\n').length, 1);
    await state.close();
    state = undefined;

    commit = true;
    state = await openDurableAuthState({
      directory,
      journalMacKey,
      requireIntegrity: true,
      journalCheckpointBinding: fixture.binding,
      journalCheckpointControlPlane: fixture.controlPlane,
    });
    assert.equal(state.snapshot().credentialCheckouts.length, 1);
    const transitions = fixture.operations
      .filter(({ operation }) => operation === 'CAS')
      .map(({ request }) => request);
    assert.equal(transitions.length, 2);
    assert.equal(transitions[0].idempotencyKey, transitions[1].idempotencyKey);
    assert.deepEqual(
      fixture.operations.map(({ operation }) => operation),
      ['READ', 'CAS', 'READ', 'READ', 'CAS', 'READ'],
    );
  } finally {
    await state?.close();
    journalMacKey.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});

test('CAS transport error is successful only when exact readback proves the next checkpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seori-auth-checkpoint-readback-'));
  const journalMacKey = Buffer.alloc(32, 0x33);
  const fixture = makeJournalCheckpointFixture({
    onCompareAndSwap({ request, fixture: authority }) {
      authority.setCurrent(request.next);
      throw new Error('transport-secret-canary');
    },
  });
  let state;
  try {
    state = await openDurableAuthState({
      directory,
      journalMacKey,
      requireIntegrity: true,
      journalCheckpointBinding: fixture.binding,
      journalCheckpointControlPlane: fixture.controlPlane,
    });
    const checkout = await issue(state, 'checkpoint-readback-proven');
    assert.equal(checkout.generation, 1);
    assert.equal(state.integrityCheckpoint().headMac, fixture.current().headMac);
  } finally {
    await state?.close();
    journalMacKey.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});

test('trusted checkpoint rollback and same-sequence drift fail closed before issuance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seori-auth-checkpoint-drift-'));
  const journalMacKey = Buffer.alloc(32, 0x34);
  const fixture = makeJournalCheckpointFixture();
  let state;
  try {
    state = await openDurableAuthState({
      directory,
      journalMacKey,
      requireIntegrity: true,
      journalCheckpointBinding: fixture.binding,
      journalCheckpointControlPlane: fixture.controlPlane,
    });
    await issue(state, 'checkpoint-drift-source');
    const original = await readFile(join(directory, 'auth-journal.jsonl'), 'utf8');
    await state.close();
    state = undefined;

    await writeFile(join(directory, 'auth-journal.jsonl'), '');
    await assert.rejects(
      openDurableAuthState({
        directory,
        journalMacKey,
        requireIntegrity: true,
        journalCheckpointBinding: fixture.binding,
        journalCheckpointControlPlane: fixture.controlPlane,
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'state_checkpoint_rollback',
    );

    await writeFile(join(directory, 'auth-journal.jsonl'), original);
    fixture.setCurrent({ ...fixture.current(), headMac: 'f'.repeat(64) });
    await assert.rejects(
      openDurableAuthState({
        directory,
        journalMacKey,
        requireIntegrity: true,
        journalCheckpointBinding: fixture.binding,
        journalCheckpointControlPlane: fixture.controlPlane,
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'state_checkpoint_conflict',
    );
  } finally {
    await state?.close();
    journalMacKey.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});

test('integrity state cannot open without the branded trusted checkpoint adapter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seori-auth-checkpoint-required-'));
  const journalMacKey = Buffer.alloc(32, 0x35);
  const fixture = makeJournalCheckpointFixture();
  try {
    await assert.rejects(
      DurableAuthState.open({
        directory,
        journalMacKey,
        requireIntegrity: true,
        journalCheckpointBinding: fixture.binding,
        writerLockProvider: await makeNativeLockProvider(),
      }),
      (error) =>
        error instanceof SeoriAuthError &&
        error.code === 'state_checkpoint_control_plane_required',
    );
  } finally {
    journalMacKey.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});

test('checkpoint transport failures expose only a stable public readback error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seori-auth-checkpoint-safe-error-'));
  const journalMacKey = Buffer.alloc(32, 0x36);
  const fixture = makeJournalCheckpointFixture({
    onRead() {
      throw new Error('checkpoint-transport-secret-canary');
    },
  });
  try {
    await assert.rejects(
      openDurableAuthState({
        directory,
        journalMacKey,
        requireIntegrity: true,
        journalCheckpointBinding: fixture.binding,
        journalCheckpointControlPlane: fixture.controlPlane,
      }),
      (error) => {
        assert.equal(error instanceof SeoriAuthError, true);
        assert.equal(error.code, 'state_checkpoint_readback_required');
        assert.doesNotMatch(error.message, /secret-canary/);
        return true;
      },
    );
  } finally {
    journalMacKey.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});
