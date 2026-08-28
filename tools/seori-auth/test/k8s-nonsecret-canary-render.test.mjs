import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  APPROVED_IMAGE_BINDING,
  EXPECTED_CANARY_OUTPUT,
  EXPECTED_CANARY_OUTPUT_SHA256,
} from '../scripts/public-image-binding.mjs';

const execFileAsync = promisify(execFile);
const renderer = fileURLToPath(new URL('../scripts/render-nonsecret-canary-k8s.mjs', import.meta.url));
const outputVerifier = fileURLToPath(
  new URL('../scripts/verify-nonsecret-canary-output.mjs', import.meta.url),
);
const sourceSha = APPROVED_IMAGE_BINDING.imageProvenance.sourceSha;

function canaryConfig(registry = { mode: 'PUBLIC', visibilityStatus: 'VERIFIED_PUBLIC' }) {
  return {
    schemaVersion: 1,
    namespace: 'auth-broker',
    image: APPROVED_IMAGE_BINDING.image,
    imageProvenance: { ...APPROVED_IMAGE_BINDING.imageProvenance },
    registry,
    canary: {
      contractVersion: 1,
      kind: 'NON_SECRET_BUILTIN',
      kubernetesContext: 'vzyx-cluster',
      serviceAccountName: 'seori-auth-canary',
      createPolicy: 'SERVER_DRY_RUN_THEN_CREATE_IF_ABSENT',
      publicPullBinding: 'NO_IMAGE_PULL_SECRETS',
      packagesReaderPullBinding: 'EXACT_CANONICAL_ONE',
      nodeSelector: { 'kubernetes.io/hostname': 'rpi5' },
      activeDeadlineSeconds: 300,
      expectedOutputSha256: EXPECTED_CANARY_OUTPUT_SHA256,
      idempotency: {
        markerKind: 'Job',
        key: 'image-source-contract-sha256',
        existingPolicy: 'READBACK_ONLY',
        unknownOutcomePolicy: 'READBACK_FIRST',
      },
    },
  };
}

async function render(config = canaryConfig()) {
  const root = await mkdtemp(join(tmpdir(), 'seori-auth-canary-render-'));
  const path = join(root, 'canary.json');
  try {
    await writeFile(path, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    const result = await execFileAsync(process.execPath, [renderer, `--config=${await realpath(path)}`]);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('PUBLIC non-secret canary is a deterministic RPI5 Job with no pull credential or network', async () => {
  const first = await render();
  const second = await render();
  const serialized = JSON.stringify(first);
  const policy = first.items.find(({ kind }) => kind === 'NetworkPolicy');
  const job = first.items.find(({ kind }) => kind === 'Job');
  const pod = job.spec.template.spec;
  const container = pod.containers[0];
  const serviceAccount = first.items.find(({ kind }) => kind === 'ServiceAccount');

  assert.deepEqual(first, second);
  assert.match(job.metadata.name, /^seori-auth-nonsecret-canary-[a-f0-9]{16}$/u);
  assert.equal(job.metadata.name.slice(-16), job.metadata.labels['seorilabs.io/canary-id']);
  assert.match(job.metadata.annotations['seorilabs.io/idempotency-key'], /^[a-f0-9]{64}$/u);
  assert.equal(job.metadata.annotations['seorilabs.io/idempotency-policy'], 'READBACK_ONLY');
  assert.equal(job.metadata.annotations['seorilabs.io/unknown-outcome-policy'], 'READBACK_FIRST');
  assert.equal(job.metadata.annotations['seorilabs.io/expected-output-sha256'], EXPECTED_CANARY_OUTPUT_SHA256);
  assert.equal(job.metadata.annotations['seorilabs.io/image-source-sha'], sourceSha);
  assert.equal(job.metadata.annotations['seorilabs.io/registry-mode'], 'PUBLIC');
  assert.equal(job.spec.activeDeadlineSeconds, 300);
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.completions, 1);
  assert.equal(job.spec.parallelism, 1);
  assert.equal(job.spec.podReplacementPolicy, 'Failed');
  assert.equal('ttlSecondsAfterFinished' in job.spec, false);

  assert.equal(policy.metadata.name.slice(-16), job.metadata.name.slice(-16));
  assert.deepEqual(policy.spec.policyTypes, ['Ingress', 'Egress']);
  assert.deepEqual(policy.spec.ingress, []);
  assert.deepEqual(policy.spec.egress, []);
  assert.deepEqual(policy.spec.podSelector.matchLabels, job.spec.template.metadata.labels);

  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.enableServiceLinks, false);
  assert.equal(pod.hostIPC, false);
  assert.equal(pod.hostNetwork, false);
  assert.equal(pod.hostPID, false);
  assert.equal(pod.restartPolicy, 'Never');
  assert.equal(pod.serviceAccountName, 'seori-auth-canary');
  assert.deepEqual(pod.nodeSelector, { 'kubernetes.io/hostname': 'rpi5' });
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.securityContext.runAsUser, 65532);
  assert.equal(pod.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal('imagePullSecrets' in pod, false);

  assert.equal(container.image, APPROVED_IMAGE_BINDING.image);
  assert.equal(container.imagePullPolicy, 'Always');
  assert.deepEqual(container.args, [
    'canary', '--native-helper=/opt/seori-auth/bin/seori-auth-native',
  ]);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.privileged, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  assert.ok(pod.volumes.every(({ emptyDir }) => emptyDir?.medium === 'Memory'));
  assert.equal(pod.serviceAccountName, 'seori-auth-canary');
  assert.equal(serviceAccount.automountServiceAccountToken, false);
  assert.deepEqual(serviceAccount.imagePullSecrets, []);
  assert.deepEqual(serviceAccount.secrets, []);

  assert.doesNotMatch(serialized, /(?:secretKeyRef|configMapKeyRef|projected|serviceAccountToken)/u);
  assert.doesNotMatch(serialized, /seori-auth-ghcr-pull|shared\/github\/packages-reader/u);
});

test('PACKAGES_READER canary requires the canonical verified execution-copy binding', async () => {
  const registry = {
    mode: 'PACKAGES_READER',
    imagePullSecretName: 'seori-auth-ghcr-pull',
    credentialId: 'shared/github/packages-reader',
    catalogStatus: 'ACTIVE',
    kubernetesStatus: 'VERIFIED',
  };
  const manifest = await render(canaryConfig(registry));
  const job = manifest.items.find(({ kind }) => kind === 'Job');
  assert.deepEqual(job.spec.template.spec.imagePullSecrets, [{ name: 'seori-auth-ghcr-pull' }]);
  assert.equal(
    job.metadata.annotations['seorilabs.io/registry-credential-id'],
    'shared/github/packages-reader',
  );

  const blocked = canaryConfig({ ...registry, catalogStatus: 'blocked_missing' });
  await assert.rejects(render(blocked), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /packages reader binding is not canonical and verified/u);
    return true;
  });
});

test('canary renderer rejects implicit pull mode, provenance drift, and relaxed one-shot policy', async () => {
  const implicit = canaryConfig({});
  await assert.rejects(render(implicit), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /registry mode must be explicit/u);
    return true;
  });

  const drifted = canaryConfig();
  drifted.imageProvenance.sourceSha = 'c'.repeat(40);
  await assert.rejects(render(drifted), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /code-approved immutable binding/u);
    return true;
  });

  const driftedRun = canaryConfig();
  driftedRun.imageProvenance.runId += 1;
  await assert.rejects(render(driftedRun), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /code-approved immutable binding/u);
    return true;
  });

  const retrying = canaryConfig();
  retrying.canary.idempotency.existingPolicy = 'RERUN';
  await assert.rejects(render(retrying), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /approved one-shot boundary/u);
    return true;
  });

  const publicWithCredential = canaryConfig({
    mode: 'PUBLIC',
    visibilityStatus: 'VERIFIED_PUBLIC',
    credentialId: 'shared/github/packages-reader',
  });
  await assert.rejects(render(publicWithCredential), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /registry mode must be explicit/u);
    return true;
  });
});

test('canary output verifier returns only the public allowlist digest', () => {
  const stdout = execFileSync(process.execPath, [outputVerifier], {
    input: EXPECTED_CANARY_OUTPUT,
    encoding: 'utf8',
  });

  assert.deepEqual(JSON.parse(stdout), {
    state: 'CANARY_OUTPUT_VERIFIED',
    sha256: EXPECTED_CANARY_OUTPUT_SHA256,
  });
});

test('canary output verifier rejects extra, empty, oversized, and argv input without reflection', () => {
  const hostileMarker = 'DO_NOT_REFLECT_CANARY_LOG';
  const attempts = [
    `${EXPECTED_CANARY_OUTPUT}extra\n`,
    '',
    `${hostileMarker}${'x'.repeat(256)}`,
  ];

  for (const input of attempts) {
    assert.throws(
      () => execFileSync(process.execPath, [outputVerifier], {
        input,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
      (error) => {
        assert.equal(error.status, 1);
        assert.equal(error.stdout, '');
        assert.deepEqual(JSON.parse(error.stderr), {
          valid: false,
          code: 'canary_output_not_allowlisted',
        });
        assert.doesNotMatch(`${error.stdout}${error.stderr}`, new RegExp(hostileMarker, 'u'));
        return true;
      },
    );
  }

  assert.throws(
    () => execFileSync(process.execPath, [outputVerifier, '--raw-log'], {
      input: EXPECTED_CANARY_OUTPUT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
    (error) => {
      assert.equal(error.status, 1);
      assert.equal(error.stdout, '');
      assert.deepEqual(JSON.parse(error.stderr), {
        valid: false,
        code: 'canary_output_not_allowlisted',
      });
      return true;
    },
  );
});
