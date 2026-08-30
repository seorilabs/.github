import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  assertJournalCheckpointClientIdentity,
  buildJournalCheckpointTransition,
  checkJournalCheckpointAuthorityIdentity,
  createBackofficeJournalCheckpointClient,
  JOURNAL_CHECKPOINT_AUTHORITY,
  JOURNAL_CHECKPOINT_GENESIS_MAC,
  SeoriAuthError,
} from '../src/index.mjs';
import { createRuntimeReadinessGate } from '../src/runtime-readiness.mjs';

const binding = Object.freeze({
  schemaVersion: 1,
  journalId: 'seori-auth-production',
  authoritySpiffeId: JOURNAL_CHECKPOINT_AUTHORITY.serverSpiffeId,
  mode: 'TRUSTED_CONTROL_PLANE_CAS',
  persistence: 'BACKOFFICE_DURABLE_CAS',
  commitOrder: 'JOURNAL_FSYNC_THEN_CHECKPOINT_CAS',
  unknownOutcomePolicy: 'READBACK_FIRST',
});

function authorityState({ generation = 0, digest = 'a'.repeat(64) } = {}) {
  return {
    journalId: binding.journalId,
    generation: String(generation),
    sequence: String(generation),
    checkpointDigest: digest,
    updatedAt: '2026-08-30T00:00:00.000Z',
  };
}

function fakeAuthority({ onGenesis, onRead, onAdvance } = {}) {
  let state = null;
  let closed = false;
  const calls = [];
  const transport = {
    authorityIdentity: {
      origin: JOURNAL_CHECKPOINT_AUTHORITY.origin,
      serverSpiffeId: JOURNAL_CHECKPOINT_AUTHORITY.serverSpiffeId,
    },
    async post(path, body) {
      calls.push(structuredClone({ path, body }));
      if (path === JOURNAL_CHECKPOINT_AUTHORITY.routes.genesis) {
        if (onGenesis) return onGenesis({ body, current: state, setCurrent: (value) => { state = value; } });
        const created = state === null;
        state ??= authorityState();
        return { status: 200, body: { checkpoint: state, created } };
      }
      if (path === JOURNAL_CHECKPOINT_AUTHORITY.routes.read) {
        if (onRead) return onRead({ body, current: state, setCurrent: (value) => { state = value; } });
        return { status: 200, body: { checkpoint: state } };
      }
      if (path === JOURNAL_CHECKPOINT_AUTHORITY.routes.advance) {
        if (onAdvance) return onAdvance({ body, current: state, setCurrent: (value) => { state = value; } });
        if (
          state === null || body.expectedGeneration !== state.generation ||
          body.expectedDigest !== state.checkpointDigest
        ) {
          return {
            status: 409,
            body: { error: { code: 'AUTH_BROKER_JOURNAL_CHECKPOINT_CAS_MISMATCH' } },
          };
        }
        state = authorityState({
          generation: Number(state.generation) + 1,
          digest: body.nextDigest,
        });
        return { status: 200, body: { outcome: 'ADVANCED', checkpoint: state } };
      }
      throw new Error('unexpected route');
    },
    close() { closed = true; },
  };
  return {
    transport,
    calls,
    current: () => state,
    setCurrent(value) { state = value; },
    closed: () => closed,
  };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

test('authority identity requires the exact origin DNS and signer SPIFFE SAN', () => {
  assert.equal(
    JOURNAL_CHECKPOINT_AUTHORITY.origin,
    'https://provider-execution-signer.platform.svc.cluster.local:9443',
  );
  assert.equal(JOURNAL_CHECKPOINT_AUTHORITY.port, 9443);
  assert.equal(
    JOURNAL_CHECKPOINT_AUTHORITY.serverSpiffeId,
    'spiffe://seorilabs.local/ns/platform/sa/provider-execution-signer',
  );
  assert.equal(
    JOURNAL_CHECKPOINT_AUTHORITY.clientSpiffeId,
    'spiffe://seorilabs.local/ns/auth-broker/sa/seori-auth-broker',
  );
  assert.deepEqual(JOURNAL_CHECKPOINT_AUTHORITY.routes, {
    genesis: '/v1/auth-broker/journal-checkpoints/genesis',
    read: '/v1/auth-broker/journal-checkpoints/read',
    advance: '/v1/auth-broker/journal-checkpoints/advance',
  });
  assert.equal(checkJournalCheckpointAuthorityIdentity(
    JOURNAL_CHECKPOINT_AUTHORITY.hostname,
    {
      subjectaltname: [
        `DNS:${JOURNAL_CHECKPOINT_AUTHORITY.hostname}`,
        `URI:${JOURNAL_CHECKPOINT_AUTHORITY.serverSpiffeId}`,
      ].join(', '),
    },
  ), undefined);
  for (const certificate of [{
    subjectaltname: `DNS:${JOURNAL_CHECKPOINT_AUTHORITY.hostname}`,
  }, {
    subjectaltname: [
      `DNS:${JOURNAL_CHECKPOINT_AUTHORITY.hostname}`,
      `URI:${JOURNAL_CHECKPOINT_AUTHORITY.serverSpiffeId}`,
      'DNS:lookalike.invalid',
    ].join(', '),
  }]) {
    assert.equal(
      checkJournalCheckpointAuthorityIdentity(
        JOURNAL_CHECKPOINT_AUTHORITY.hostname,
        certificate,
      )?.code,
      'JOURNAL_CHECKPOINT_AUTHORITY_IDENTITY_MISMATCH',
    );
  }
  assert.equal(
    checkJournalCheckpointAuthorityIdentity('lookalike.invalid', {
      subjectaltname: 'DNS:lookalike.invalid',
    })?.code,
    'JOURNAL_CHECKPOINT_AUTHORITY_ORIGIN_MISMATCH',
  );
});

test('client certificate accepts only the exact broker SPIFFE URI SAN', () => {
  assert.deepEqual(JOURNAL_CHECKPOINT_AUTHORITY.tls, {
    secretName: 'seori-auth-journal-checkpoint-client-tls',
    caPath: '/etc/seori-auth/journal-checkpoint-tls/ca.crt',
    certificatePath: '/etc/seori-auth/journal-checkpoint-tls/tls.crt',
    privateKeyPath: '/etc/seori-auth/journal-checkpoint-tls/tls.key',
  });
  assert.doesNotThrow(() => assertJournalCheckpointClientIdentity(
    `URI:${JOURNAL_CHECKPOINT_AUTHORITY.clientSpiffeId}`,
  ));
  for (const subjectAltName of [
    `DNS:seori-auth-broker.auth-broker.svc.cluster.local, URI:${JOURNAL_CHECKPOINT_AUTHORITY.clientSpiffeId}`,
    'URI:spiffe://seorilabs.local/ns/auth-broker/sa/lookalike',
  ]) {
    assert.throws(
      () => assertJournalCheckpointClientIdentity(subjectAltName),
      (error) => error instanceof SeoriAuthError &&
        error.code === 'state_checkpoint_mtls_identity_invalid',
    );
  }
});

test('client rejects a transport not bound to the exact authority response identity', () => {
  assert.throws(
    () => createBackofficeJournalCheckpointClient({
      binding,
      transport: {
        authorityIdentity: {
          origin: JOURNAL_CHECKPOINT_AUTHORITY.origin,
          serverSpiffeId: 'spiffe://seorilabs.local/ns/platform/sa/lookalike',
        },
        async post() { assert.fail('identity drift must fail before transport use'); },
        close() {},
      },
    }),
    (error) => error instanceof SeoriAuthError && error.code === 'invalid_state_checkpoint',
  );
});

test('genesis opaque digest is retained as expectedDigest for the first strict CAS', async () => {
  const authority = fakeAuthority();
  const client = createBackofficeJournalCheckpointClient({
    binding,
    transport: authority.transport,
  });
  try {
    const observed = await client.controlPlane.readCurrent({
      schemaVersion: 1,
      journalId: binding.journalId,
    });
    assert.deepEqual(observed, {
      schemaVersion: 1,
      journalId: binding.journalId,
      generation: 0,
      sequence: 0,
      headMac: JOURNAL_CHECKPOINT_GENESIS_MAC,
    });
    const transition = buildJournalCheckpointTransition({
      binding,
      expected: observed,
      headMac: 'b'.repeat(64),
    });
    assert.deepEqual(await client.controlPlane.compareAndSwap(transition), {
      outcome: 'COMMITTED',
    });
    const advance = authority.calls.find(({ path }) =>
      path === JOURNAL_CHECKPOINT_AUTHORITY.routes.advance);
    assert.deepEqual(advance.body, {
      journalId: binding.journalId,
      expectedGeneration: '0',
      expectedDigest: 'a'.repeat(64),
      nextDigest: 'b'.repeat(64),
    });
    assert.deepEqual(await client.controlPlane.readCurrent({
      schemaVersion: 1,
      journalId: binding.journalId,
    }), transition.next);
    assert.deepEqual(authority.calls.map(({ path }) => path), [
      JOURNAL_CHECKPOINT_AUTHORITY.routes.genesis,
      JOURNAL_CHECKPOINT_AUTHORITY.routes.read,
      JOURNAL_CHECKPOINT_AUTHORITY.routes.advance,
      JOURNAL_CHECKPOINT_AUTHORITY.routes.read,
    ]);
  } finally {
    client.close();
  }
  assert.equal(authority.closed(), true);
});

test('lost first response is recovered by exact readback before one distinct second CAS', async () => {
  let advanceCount = 0;
  const healthStates = [];
  const authority = fakeAuthority({
    onAdvance({ body, current, setCurrent }) {
      advanceCount += 1;
      assert.equal(body.expectedDigest, current.checkpointDigest);
      const next = authorityState({
        generation: Number(current.generation) + 1,
        digest: body.nextDigest,
      });
      setCurrent(next);
      if (advanceCount === 1) throw new Error('transport-secret-canary');
      return { status: 200, body: { outcome: 'ADVANCED', checkpoint: next } };
    },
  });
  const client = createBackofficeJournalCheckpointClient({
    binding,
    transport: authority.transport,
    onHealthStateChange: async ({ state }) => healthStates.push(state),
  });
  try {
    const expected = await client.controlPlane.readCurrent({
      schemaVersion: 1,
      journalId: binding.journalId,
    });
    const transition = buildJournalCheckpointTransition({
      binding,
      expected,
      headMac: 'c'.repeat(64),
    });
    assert.deepEqual(await client.controlPlane.compareAndSwap(transition), { outcome: 'UNKNOWN' });
    assert.equal(advanceCount, 1);
    assert.deepEqual(await client.controlPlane.readCurrent({
      schemaVersion: 1,
      journalId: binding.journalId,
    }), transition.next);
    assert.equal(advanceCount, 1);
    assert.equal(client.isHealthy(), true);

    const second = buildJournalCheckpointTransition({
      binding,
      expected: transition.next,
      headMac: 'd'.repeat(64),
    });
    assert.deepEqual(await client.controlPlane.compareAndSwap(second), { outcome: 'COMMITTED' });
    assert.equal(advanceCount, 2);
    assert.deepEqual(await client.controlPlane.readCurrent({
      schemaVersion: 1,
      journalId: binding.journalId,
    }), second.next);
    assert.deepEqual(
      authority.calls
        .filter(({ path }) => path === JOURNAL_CHECKPOINT_AUTHORITY.routes.advance)
        .map(({ body }) => body),
      [{
        journalId: binding.journalId,
        expectedGeneration: '0',
        expectedDigest: 'a'.repeat(64),
        nextDigest: 'c'.repeat(64),
      }, {
        journalId: binding.journalId,
        expectedGeneration: '1',
        expectedDigest: 'c'.repeat(64),
        nextDigest: 'd'.repeat(64),
      }],
    );
    assert.deepEqual(healthStates, ['HEALTHY', 'SEALED', 'HEALTHY']);
  } finally {
    client.close();
  }
});

test('unknown advance that readbacks the predecessor remains sealed until process restart', async () => {
  let advanceCount = 0;
  const healthStates = [];
  const root = await mkdtemp(join(tmpdir(), 'seori-auth-checkpoint-readiness-'));
  const readinessPath = join(root, 'broker.ready');
  const readinessGate = createRuntimeReadinessGate({ path: readinessPath, role: 'broker' });
  await readinessGate.setRuntimeReady();
  assert.equal(await exists(readinessPath), false);
  const authority = fakeAuthority({
    onAdvance() {
      advanceCount += 1;
      throw new Error('unknown-before-commit');
    },
  });
  const client = createBackofficeJournalCheckpointClient({
    binding,
    transport: authority.transport,
    onHealthStateChange: async ({ state }) => {
      healthStates.push(state);
      await readinessGate.setCheckpointHealth(state);
    },
  });
  try {
    const expected = await client.controlPlane.readCurrent({
      schemaVersion: 1,
      journalId: binding.journalId,
    });
    assert.equal(readinessGate.isHealthy(), true);
    assert.equal(await exists(readinessPath), true);
    const transition = buildJournalCheckpointTransition({
      binding,
      expected,
      headMac: 'd'.repeat(64),
    });
    assert.deepEqual(await client.controlPlane.compareAndSwap(transition), { outcome: 'UNKNOWN' });
    assert.equal(readinessGate.isHealthy(), false);
    assert.equal(await exists(readinessPath), false);
    assert.deepEqual(await client.controlPlane.readCurrent({
      schemaVersion: 1,
      journalId: binding.journalId,
    }), expected);
    const distinct = buildJournalCheckpointTransition({
      binding,
      expected,
      headMac: 'e'.repeat(64),
    });
    assert.deepEqual(await client.controlPlane.compareAndSwap(distinct), { outcome: 'UNKNOWN' });
    assert.equal(advanceCount, 1);
    assert.equal(client.isHealthy(), false);
    assert.equal(readinessGate.isHealthy(), false);
    assert.equal(await exists(readinessPath), false);
    assert.deepEqual(healthStates, ['HEALTHY', 'SEALED']);
  } finally {
    client.close();
    await readinessGate.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('unknown genesis uses one readback and never repeats the mutation in the same process', async () => {
  let genesisCount = 0;
  const authority = fakeAuthority({
    onGenesis({ setCurrent }) {
      genesisCount += 1;
      setCurrent(authorityState());
      throw new Error('genesis-secret-canary');
    },
  });
  const client = createBackofficeJournalCheckpointClient({ binding, transport: authority.transport });
  try {
    assert.equal((await client.controlPlane.readCurrent({
      schemaVersion: 1,
      journalId: binding.journalId,
    })).generation, 0);
    assert.equal(genesisCount, 1);
    await client.controlPlane.readCurrent({ schemaVersion: 1, journalId: binding.journalId });
    assert.equal(genesisCount, 1);
  } finally {
    client.close();
  }
});

test('malformed successful genesis is resolved only by exact readback without mutation replay', async () => {
  let genesisCount = 0;
  const authority = fakeAuthority({
    onGenesis({ setCurrent }) {
      genesisCount += 1;
      setCurrent(authorityState());
      return { status: 200, body: { malformed: true } };
    },
  });
  const client = createBackofficeJournalCheckpointClient({ binding, transport: authority.transport });
  try {
    assert.equal((await client.controlPlane.readCurrent({
      schemaVersion: 1,
      journalId: binding.journalId,
    })).generation, 0);
    await client.controlPlane.readCurrent({ schemaVersion: 1, journalId: binding.journalId });
    assert.equal(genesisCount, 1);
    assert.deepEqual(authority.calls.map(({ path }) => path), [
      JOURNAL_CHECKPOINT_AUTHORITY.routes.genesis,
      JOURNAL_CHECKPOINT_AUTHORITY.routes.read,
      JOURNAL_CHECKPOINT_AUTHORITY.routes.read,
    ]);
  } finally {
    client.close();
  }
});

test('transport failures expose only stable secret-free errors', async () => {
  const client = createBackofficeJournalCheckpointClient({
    binding,
    transport: {
      authorityIdentity: {
        origin: JOURNAL_CHECKPOINT_AUTHORITY.origin,
        serverSpiffeId: JOURNAL_CHECKPOINT_AUTHORITY.serverSpiffeId,
      },
      async post() { throw new Error('checkpoint-transport-secret-canary'); },
      close() {},
    },
  });
  try {
    await assert.rejects(
      client.controlPlane.readCurrent({ schemaVersion: 1, journalId: binding.journalId }),
      (error) => {
        assert.equal(error instanceof SeoriAuthError, true);
        assert.equal(error.code, 'state_checkpoint_transport_unavailable');
        assert.doesNotMatch(error.message, /secret-canary/);
        return true;
      },
    );
  } finally {
    client.close();
  }
});
