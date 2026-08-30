import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import { BROWSER_VAULT_ENVELOPE } from '../tools/seori-auth/src/browser-vault.mjs';
import {
  DURABLE_JOURNAL_ENVELOPE,
  serializeSecretFreeJournalEnvelope,
} from '../tools/seori-auth/src/durable-state.mjs';
import {
  buildRetainVolumeList,
  verifyApplicationEnvelopeContract,
} from '../tools/seori-auth/src/state-envelope.mjs';

const execFileAsync = promisify(execFile);
const verifier = fileURLToPath(
  new URL('../scripts/fleet/verify-p2-state-envelope.mjs', import.meta.url),
);
const commandMock = fileURLToPath(
  new URL('./fixtures/p2-state-envelope-command-mock.mjs', import.meta.url),
);
const contract = parse(await readFile('contracts/fleet-p3-runtime.yaml', 'utf8'));
const fakeSecret = 'FAKE_STATE_KEY_MATERIAL_MUST_NOT_APPEAR';

async function verify(mode, { scenario = 'exact', withLog = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'p2-state-envelope-')));
  const log = join(root, 'commands.jsonl');
  try {
    const result = await execFileAsync(process.execPath, [verifier, mode], {
      env: {
        ...process.env,
        SEORILABS_KUBECTL: commandMock,
        SEORILABS_STATE_FIXTURE_RUNTIME: process.execPath,
        SEORILABS_STATE_FIXTURE_SCENARIO: scenario,
        ...(withLog ? { SEORILABS_STATE_FIXTURE_LOG: log } : {}),
        FAKE_STATE_SECRET_CANARY: fakeSecret,
      },
    });
    return {
      ...result,
      calls: withLog
        ? (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
        : [],
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertPublicOnly(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  assert.doesNotMatch(serialized, /FAKE_STATE_KEY|key.?material|password|totp.?seed|cookie/iu);
}

test('P2 runtime v2는 application envelope와 secret-free journal을 actual implementation에 고정한다', () => {
  assert.equal(contract.schemaVersion, 2);
  const result = verifyApplicationEnvelopeContract(contract.authBroker.state);
  assert.deepEqual(result, {
    schemaVersion: 2,
    state: 'APPLICATION_ENVELOPE_CONTRACT_VERIFIED',
    rolloutStatus: 'blocked_unverified',
    mode: 'APPLICATION_ENVELOPE',
    secretPersistencePolicy: 'ENCRYPTED_ENVELOPE_ONLY',
    journal: {
      schemaVersion: 2,
      contentPolicy: 'SECRET_FREE_PUBLIC_CONTROL_AND_AUDIT_ONLY',
      integrity: 'HMAC_SHA256_CHAIN',
      writeValidation: 'FAIL_CLOSED_BEFORE_SERIALIZATION',
    },
    browserVault: {
      envelopeVersion: 1,
      algorithm: 'aes-256-gcm',
      plaintextAtRestAllowed: false,
    },
  });
  assert.deepEqual(contract.authBroker.state.protection.journal, {
    ...DURABLE_JOURNAL_ENVELOPE,
    logicalCredentialId: 'shared/seori-auth/journal-mac',
  });
  assert.deepEqual(contract.authBroker.state.protection.browserVault, {
    envelopeVersion: BROWSER_VAULT_ENVELOPE.version,
    algorithm: BROWSER_VAULT_ENVELOPE.algorithm,
    logicalCredentialId: 'shared/seori-auth/browser-vault',
    plaintextAtRestAllowed: false,
  });
  assertPublicOnly(result);
});

test('journal serializer는 허용된 공개 record만 쓰기 전에 검증한다', () => {
  const recordedAt = '2026-08-30T00:00:00.000Z';
  const envelope = {
    schemaVersion: 1,
    sequence: 1,
    recordedAt,
    mutation: null,
    audit: {
      id: 'audit-1',
      eventType: 'STATE_CONTRACT_VERIFIED',
      outcome: 'SUCCESS',
      entityType: 'AttestationNonce',
      entityId: 'attestation-1',
      generation: 1,
      recordedAt,
    },
  };
  const serialized = serializeSecretFreeJournalEnvelope({
    envelope,
    expectedSequence: 1,
  });
  assert.deepEqual(JSON.parse(serialized), envelope);

  for (const unsafe of [
    { ...envelope, password: fakeSecret },
    { ...envelope, audit: { ...envelope.audit, sessionCookie: fakeSecret } },
    { ...envelope, mutation: { entityType: 'AttestationNonce', entity: {}, extra: fakeSecret } },
  ]) {
    assert.throws(
      () => serializeSecretFreeJournalEnvelope({ envelope: unsafe, expectedSequence: 1 }),
      (error) => error?.code === 'invalid_state_journal',
    );
  }
  assertPublicOnly(serialized);
});

test('Retain PV/PVC plan은 app envelope metadata와 비파괴 운영 정책만 가진다', () => {
  const state = contract.authBroker.state;
  const desired = buildRetainVolumeList(state);
  assert.equal(desired.kind, 'List');
  assert.equal(desired.items.length, 2);
  const pv = desired.items.find(({ kind }) => kind === 'PersistentVolume');
  const pvc = desired.items.find(({ kind }) => kind === 'PersistentVolumeClaim');
  assert.equal(pv.spec.persistentVolumeReclaimPolicy, 'Retain');
  assert.equal(pv.spec.local.path, '/var/lib/seori-auth');
  assert.equal(pv.metadata.labels['seorilabs.io/protection-mode'], 'application-envelope');
  assert.equal(pvc.spec.volumeName, state.volume.volumeName);
  assert.equal(state.volume.mutationPolicy, 'SEPARATE_APPROVAL');
  assert.equal(state.volume.deletionPolicy, 'FORBIDDEN');
  assert.equal(state.volume.unknownOutcomePolicy, 'READBACK_FIRST');
  assertPublicOnly(desired);
});

test('contract 검증은 host와 cluster command 없이 공개 attestation만 반환한다', async () => {
  const result = await verify('contract');
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.state, 'APPLICATION_ENVELOPE_CONTRACT_VERIFIED');
  assert.equal(output.browserVault.algorithm, 'aes-256-gcm');
  assertPublicOnly(output);
});

test('live readback은 Bound PVC/PV와 Retain을 exact read-only로 검증한다', async () => {
  const result = await verify('live-readback', { withLog: true });
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output, {
    schemaVersion: 2,
    state: 'LIVE_READBACK_VERIFIED',
    readOnly: true,
    retention: 'Retain',
    pv: {
      name: 'seori-auth-state-rpi5',
      size: '10Gi',
      storageClassName: 'microk8s-hostpath',
      nodeName: 'rpi5',
      phase: 'Bound',
    },
    pvc: {
      namespace: 'auth-broker',
      name: 'seori-auth-state',
      volumeName: 'seori-auth-state-rpi5',
      size: '10Gi',
      phase: 'Bound',
    },
  });
  assert.deepEqual(result.calls, [
    ['config', 'current-context'],
    [
      '--context', 'vzyx-cluster', 'get', 'persistentvolume', 'seori-auth-state-rpi5',
      '--output=json', '--ignore-not-found=true',
    ],
    [
      '--context', 'vzyx-cluster', 'get', 'persistentvolumeclaim', 'seori-auth-state',
      '--namespace', 'auth-broker', '--output=json', '--ignore-not-found=true',
    ],
  ]);
  assert.ok(result.calls.every((args) =>
    !args.some((argument) => ['apply', 'create', 'delete', 'patch', 'replace'].includes(argument))));
  assertPublicOnly({ output, calls: result.calls });
});

test('missing, partial, destructive, unbound 또는 identity drift는 구분해 fail-closed한다', async () => {
  const scenarios = new Map([
    ['missing-both', 'STATE_VOLUME_LIVE_READBACK_MISSING'],
    ['missing-pv', 'STATE_VOLUME_LIVE_READBACK_PARTIAL'],
    ['missing-pvc', 'STATE_VOLUME_LIVE_READBACK_PARTIAL'],
    ['destructive-reclaim', 'STATE_VOLUME_LIVE_READBACK_DRIFT'],
    ['wrong-node', 'STATE_VOLUME_LIVE_READBACK_DRIFT'],
    ['wrong-storage-class', 'STATE_VOLUME_LIVE_READBACK_DRIFT'],
    ['claim-uid-mismatch', 'STATE_VOLUME_LIVE_READBACK_DRIFT'],
    ['volume-drift', 'STATE_VOLUME_LIVE_READBACK_DRIFT'],
    ['deleting', 'STATE_VOLUME_LIVE_READBACK_DRIFT'],
    ['unbound', 'STATE_VOLUME_LIVE_READBACK_DRIFT'],
  ]);
  for (const [scenario, expectedCode] of scenarios) {
    await assert.rejects(
      verify('live-readback', { scenario }),
      (error) => {
        assert.equal(error.code, 1);
        const result = JSON.parse(error.stderr);
        assert.equal(result.code, expectedCode);
        assertPublicOnly(error.stderr);
        return true;
      },
      scenario,
    );
  }
});

test('unknown kubectl outcome은 missing 또는 drift로 추측하지 않고 readback failure로 중단한다', async () => {
  await assert.rejects(
    verify('live-readback', { scenario: 'unknown-pv' }),
    (error) => {
      assert.equal(error.code, 1);
      assert.deepEqual(JSON.parse(error.stderr), {
        ok: false,
        code: 'STATE_VOLUME_LIVE_READBACK_FAILED',
      });
      assertPublicOnly(error.stderr);
      return true;
    },
  );
});

test('wrong cluster context는 PV/PVC readback 전에 중단한다', async () => {
  await assert.rejects(
    verify('live-readback', { scenario: 'wrong-context', withLog: true }),
    (error) => {
      assert.equal(error.code, 1);
      assert.deepEqual(JSON.parse(error.stderr), {
        ok: false,
        code: 'STATE_VOLUME_CONTEXT_MISMATCH',
      });
      return true;
    },
  );
});
