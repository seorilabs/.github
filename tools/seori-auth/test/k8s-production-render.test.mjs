import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const renderer = fileURLToPath(new URL('../scripts/render-production-k8s.mjs', import.meta.url));
const digest = 'a'.repeat(64);

function deploymentConfig() {
  const audience = '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/seori-auth/providers/microk8s';
  return {
    schemaVersion: 1,
    namespace: 'auth-broker',
    image: `ghcr.io/seorilabs/seori-auth@sha256:${digest}`,
    imagePullPolicy: 'IfNotPresent',
    nodeSelector: { 'seorilabs.io/node-role': 'auth' },
    stateClaimName: 'seori-auth-state',
    trustedWorkers: {
      namespaceSelector: { 'kubernetes.io/metadata.name': 'release-workers' },
      podSelector: { 'seorilabs.io/auth-client': 'true' },
    },
    egressProxy: {
      namespaceSelector: { 'kubernetes.io/metadata.name': 'auth-egress' },
      podSelector: { 'app.kubernetes.io/name': 'seori-auth-egress-proxy' },
      port: 8443,
    },
    roles: {
      broker: {
        configMapName: 'seori-auth-broker-config',
        tlsSecretName: 'seori-auth-broker-tls',
        egressTlsSecretName: 'seori-auth-broker-egress-tls',
        googleServiceAccount: 'seori-auth-broker@example-project.iam.gserviceaccount.com',
        wifAudience: audience,
      },
      passwordLoader: {
        configMapName: 'seori-auth-password-config',
        tlsSecretName: 'seori-auth-password-tls',
        egressTlsSecretName: 'seori-auth-password-egress-tls',
        googleServiceAccount: 'seori-auth-password@example-project.iam.gserviceaccount.com',
        wifAudience: audience,
      },
      totpSigner: {
        configMapName: 'seori-auth-totp-config',
        tlsSecretName: 'seori-auth-totp-tls',
        egressTlsSecretName: 'seori-auth-totp-egress-tls',
        googleServiceAccount: 'seori-auth-totp@example-project.iam.gserviceaccount.com',
        wifAudience: audience,
      },
    },
  };
}

async function render(config = deploymentConfig()) {
  const root = await mkdtemp(join(tmpdir(), 'seori-auth-render-'));
  const path = join(root, 'deployment.json');
  try {
    await writeFile(path, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    const result = await execFileAsync(process.execPath, [renderer, `--config=${await realpath(path)}`]);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function workloadItems(manifest) {
  return manifest.items.filter((item) => ['Deployment', 'StatefulSet'].includes(item.kind));
}

test('production renderer emits immutable separated workloads without Kubernetes Secret values or API grants', async () => {
  const manifest = await render();
  const serialized = JSON.stringify(manifest);
  const workloads = workloadItems(manifest);
  const serviceAccounts = manifest.items.filter((item) => item.kind === 'ServiceAccount');
  const role = manifest.items.find((item) => item.kind === 'Role');
  const policies = manifest.items.filter((item) => item.kind === 'NetworkPolicy');
  const stalePlaceholder = new RegExp(['REPLACE', ''].join('_'));

  assert.equal(manifest.kind, 'List');
  assert.equal(serviceAccounts.length, 3);
  assert.equal(new Set(serviceAccounts.map((item) => item.metadata.annotations['seorilabs.io/google-service-account'])).size, 3);
  assert.deepEqual(role.rules, []);
  assert.doesNotMatch(serialized, /"(?:data|stringData|secretKeyRef)"/);
  assert.doesNotMatch(serialized, stalePlaceholder);
  assert.doesNotMatch(serialized, /example\.invalid|0\.0\.0\.0\/0|"ipBlock"/);
  assert.equal(workloads.length, 3);

  for (const item of workloads) {
    const pod = item.spec.template.spec;
    const container = pod.containers[0];
    const projected = pod.volumes.find((volume) => volume.name === 'projected-identity');
    const tokenProjection = projected.projected.sources[0].serviceAccountToken;
    const tokenMount = container.volumeMounts.find((mount) => mount.name === 'projected-identity');
    assert.equal(container.image, `ghcr.io/seorilabs/seori-auth@sha256:${digest}`);
    assert.equal(pod.automountServiceAccountToken, false);
    assert.equal(tokenProjection.path, 'token');
    assert.equal(tokenProjection.expirationSeconds, 600);
    assert.equal(tokenMount.mountPath, '/var/run/seori-auth/projected-identity');
    assert.equal(tokenMount.readOnly, true);
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.equal(container.securityContext.allowPrivilegeEscalation, false);
    assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
    assert.equal(pod.securityContext.runAsNonRoot, true);
    assert.equal(pod.securityContext.seccompProfile.type, 'RuntimeDefault');
    assert.equal(container.startupProbe.failureThreshold, 30);

    for (const mount of container.volumeMounts.filter((value) => ['config', 'service-tls', 'egress-tls'].includes(value.name))) {
      assert.equal(typeof mount.subPath, 'string');
      assert.equal(mount.readOnly, true);
    }
  }

  const broker = workloads.find((item) => item.kind === 'StatefulSet');
  const factors = workloads.filter((item) => item.kind === 'Deployment');
  assert.ok(broker.spec.template.spec.volumes.some((volume) => volume.name === 'state' && volume.persistentVolumeClaim));
  assert.ok(factors.every((item) => !item.spec.template.spec.volumes.some((volume) => volume.name === 'state')));
  assert.ok(policies.some((item) => item.metadata.name === 'default-deny' && item.spec.ingress.length === 0 && item.spec.egress.length === 0));
  assert.ok(policies.every((item) => !JSON.stringify(item).includes('ipBlock')));
  const dnsEgress = policies.flatMap((item) => item.spec.egress ?? []).find((rule) =>
    rule.ports?.some((entry) => entry.port === 53));
  assert.deepEqual(dnsEgress.to[0].podSelector.matchLabels, { 'k8s-app': 'kube-dns' });
});

test('production renderer rejects mutable images and shared factor identities', async () => {
  const mutable = deploymentConfig();
  mutable.image = 'ghcr.io/seorilabs/seori-auth:latest';
  await assert.rejects(render(mutable), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /invalid_deployment_config/);
    return true;
  });

  const shared = deploymentConfig();
  shared.roles.totpSigner.googleServiceAccount = shared.roles.passwordLoader.googleServiceAccount;
  await assert.rejects(render(shared), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /must be distinct/);
    return true;
  });
});
