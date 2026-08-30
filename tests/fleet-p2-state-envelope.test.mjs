import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
  validateStateVolumeReadbackAttestation,
  verifyApplicationEnvelopeContract,
  verifyExactStateVolumeReadback,
  verifyRetainVolumeReadback,
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
  const environmentLog = join(root, 'environment.jsonl');
  const kubeconfig = join(root, 'kubeconfig');
  const ambientHome = join(root, 'ambient-home');
  const ambientKubeconfig = join(root, 'ambient-kubeconfig');
  const sentinel = join(ambientHome, 'sentinel');
  try {
    await mkdir(ambientHome, { mode: 0o700 });
    await Promise.all([
      writeFile(kubeconfig, 'fixture-kubeconfig-not-read-by-mock\n', { mode: 0o600 }),
      writeFile(ambientKubeconfig, 'ambient-kubeconfig-must-not-be-used\n', { mode: 0o600 }),
      writeFile(sentinel, 'unchanged\n', { mode: 0o600 }),
    ]);
    const canonicalKubeconfig = await realpath(kubeconfig);
    const result = await execFileAsync(process.execPath, [
      verifier,
      mode,
      ...(mode === 'live-readback' ? [`--kubeconfig=${canonicalKubeconfig}`] : []),
    ], {
      env: {
        ...process.env,
        HOME: ambientHome,
        KUBECONFIG: ambientKubeconfig,
        SEORILABS_KUBECTL: commandMock,
        SEORILABS_STATE_FIXTURE_RUNTIME: process.execPath,
        SEORILABS_STATE_FIXTURE_SCENARIO: scenario,
        ...(withLog ? {
          SEORILABS_STATE_FIXTURE_ENV_LOG: environmentLog,
          SEORILABS_STATE_FIXTURE_LOG: log,
        } : {}),
        FAKE_STATE_SECRET_CANARY: fakeSecret,
      },
    });
    const rawCalls = withLog
      ? (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      : [];
    return {
      ...result,
      ambientSentinel: await readFile(sentinel, 'utf8'),
      calls: rawCalls.map((args) => args.slice(2)),
      rawCalls,
      environments: withLog
        ? (await readFile(environmentLog, 'utf8')).trim().split('\n')
            .map((line) => JSON.parse(line))
        : [],
      kubeconfig: canonicalKubeconfig,
      ambientHome,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertPublicOnly(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  assert.doesNotMatch(serialized, /FAKE_STATE_KEY|key.?material|password|totp.?seed|cookie/iu);
}

test('P2 runtime v3는 startup attestation과 application envelope를 actual implementation에 고정한다', () => {
  assert.equal(contract.schemaVersion, 3);
  const result = verifyApplicationEnvelopeContract(contract.authBroker.state);
  assert.deepEqual(result, {
    schemaVersion: 3,
    state: 'APPLICATION_ENVELOPE_CONTRACT_VERIFIED',
    rolloutStatus: 'blocked_unverified',
    mode: 'APPLICATION_ENVELOPE',
    secretPersistencePolicy: 'ENCRYPTED_ENVELOPE_ONLY',
    journal: {
      schemaVersion: 2,
      contentPolicy: 'SECRET_FREE_PUBLIC_CONTROL_AND_AUDIT_ONLY',
      integrity: 'HMAC_SHA256_CHAIN',
      writeValidation: 'FAIL_CLOSED_BEFORE_SERIALIZATION',
      checkpoint: {
        schemaVersion: 1,
        journalId: 'seori-auth-production',
        authoritySpiffeId: 'spiffe://seorilabs.local/ns/platform/sa/provider-execution-signer',
        mode: 'TRUSTED_CONTROL_PLANE_CAS',
        persistence: 'BACKOFFICE_DURABLE_CAS',
        commitOrder: 'JOURNAL_FSYNC_THEN_CHECKPOINT_CAS',
        unknownOutcomePolicy: 'READBACK_FIRST',
      },
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
    checkpoint: result.journal.checkpoint,
  });
  assert.deepEqual(contract.authBroker.state.protection.browserVault, {
    envelopeVersion: BROWSER_VAULT_ENVELOPE.version,
    algorithm: BROWSER_VAULT_ENVELOPE.algorithm,
    logicalCredentialId: 'shared/seori-auth/browser-vault',
    plaintextAtRestAllowed: false,
  });
  assert.deepEqual(contract.authBroker.state.volume.readbackAttestation, {
    schemaVersion: 1,
    digestAlgorithm: 'SHA256_CANONICAL_JSON',
    startupGate: 'INIT_CONTAINER_EXACT_READBACK',
    postStartGate: 'READINESS_MARKER_EXACT_DIGEST',
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
  assert.equal(output.schemaVersion, 3);
  assert.equal(output.state, 'LIVE_READBACK_VERIFIED');
  assert.equal(output.readOnly, true);
  assert.equal(output.retention, 'Retain');
  assert.deepEqual(output.attestation.pv, {
    name: 'seori-auth-state-rpi5',
    uid: 'fixture-pv-uid',
    resourceVersion: '19',
  });
  assert.deepEqual(output.attestation.pvc, {
    namespace: 'auth-broker',
    name: 'seori-auth-state',
    uid: 'fixture-pvc-uid',
    resourceVersion: '17',
  });
  assert.match(output.attestation.stateContractDigest, /^[a-f0-9]{64}$/u);
  assert.match(output.attestation.observedDigest, /^[a-f0-9]{64}$/u);
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
  assert.equal(result.ambientSentinel, 'unchanged\n');
  assert.ok(result.rawCalls.every((args) => args[0] === `--kubeconfig=${result.kubeconfig}`));
  assert.ok(result.rawCalls.every((args) => args[1].startsWith('--cache-dir=/')));
  for (const environment of result.environments) {
    assert.equal(environment.KUBECONFIG, result.kubeconfig);
    assert.notEqual(environment.HOME, result.ambientHome);
    assert.match(environment.HOME, /\/seori-kubectl-readback-[^/]+\/home$/u);
    assert.match(environment.XDG_CACHE_HOME, /\/seori-kubectl-readback-[^/]+\/cache$/u);
    assert.match(environment.TMPDIR, /\/seori-kubectl-readback-[^/]+\/tmp$/u);
  }
  assertPublicOnly({ output, calls: result.calls });
});

test('attestation은 UID/RV/digest substitution을 차단하고 protection status 주장과 분리된다', () => {
  const state = contract.authBroker.state;
  const desired = structuredClone(buildRetainVolumeList(state));
  const observedPv = desired.items.find(({ kind }) => kind === 'PersistentVolume');
  const observedPvc = desired.items.find(({ kind }) => kind === 'PersistentVolumeClaim');
  observedPvc.metadata.uid = 'fixture-pvc-uid';
  observedPvc.metadata.resourceVersion = '17';
  observedPvc.status = {
    phase: 'Bound',
    accessModes: [...observedPvc.spec.accessModes],
    capacity: { storage: observedPvc.spec.resources.requests.storage },
  };
  observedPv.metadata.uid = 'fixture-pv-uid';
  observedPv.metadata.resourceVersion = '19';
  observedPv.spec.claimRef.uid = observedPvc.metadata.uid;
  observedPv.spec.claimRef.resourceVersion = observedPvc.metadata.resourceVersion;
  observedPv.status = { phase: 'Bound' };
  const attestation = verifyRetainVolumeReadback({ state, observedPv, observedPvc }).attestation;

  const selfDeclaredVerified = structuredClone(state);
  selfDeclaredVerified.protection.status = 'verified';
  assert.deepEqual(
    validateStateVolumeReadbackAttestation({ state: selfDeclaredVerified, attestation }),
    attestation,
  );

  const substitutedPvc = structuredClone(observedPvc);
  substitutedPvc.metadata.resourceVersion = '18';
  assert.throws(
    () => verifyExactStateVolumeReadback({
      state,
      attestation,
      observedPv,
      observedPvc: substitutedPvc,
    }),
    (error) => error?.code === 'STATE_VOLUME_ATTESTATION_MISMATCH',
  );
  const tampered = structuredClone(attestation);
  tampered.pv.uid = 'substituted-pv-uid';
  assert.throws(
    () => validateStateVolumeReadbackAttestation({ state, attestation: tampered }),
    (error) => error?.code === 'STATE_VOLUME_ATTESTATION_INVALID',
  );
});

test('live readback은 ambient KUBECONFIG를 무시하고 canonical explicit kubeconfig를 요구한다', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [verifier, 'live-readback'], {
      env: { ...process.env, KUBECONFIG: '/tmp/ambient-must-not-be-used' },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.deepEqual(JSON.parse(error.stderr), {
        ok: false,
        code: 'STATE_ENVELOPE_COMMAND_INVALID',
      });
      return true;
    },
  );
});

test('live readback은 relative, symlink, writable kubeconfig를 거부한다', async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'p2-kubeconfig-boundary-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  const canonical = join(root, 'kubeconfig');
  const linked = join(root, 'linked-kubeconfig');
  await writeFile(canonical, 'fixture\n', { mode: 0o600 });
  await symlink(canonical, linked);
  for (const requested of ['relative-kubeconfig', linked]) {
    await assert.rejects(
      execFileAsync(process.execPath, [verifier, 'live-readback', `--kubeconfig=${requested}`]),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(JSON.parse(error.stderr).code, 'KUBECONFIG_PATH_INVALID');
        return true;
      },
    );
  }
  await chmod(canonical, 0o666);
  await assert.rejects(
    execFileAsync(process.execPath, [verifier, 'live-readback', `--kubeconfig=${canonical}`]),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stderr).code, 'KUBECONFIG_PATH_INVALID');
      return true;
    },
  );
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
