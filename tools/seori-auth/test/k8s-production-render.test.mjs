import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import { APPROVED_IMAGE_BINDING } from '../scripts/public-image-binding.mjs';
import {
  buildRetainVolumeList,
  verifyRetainVolumeReadback,
} from '../src/state-envelope.mjs';

const execFileAsync = promisify(execFile);
const renderer = fileURLToPath(new URL('../scripts/render-production-k8s.mjs', import.meta.url));
const digest = APPROVED_IMAGE_BINDING.imageProvenance.imageDigest.slice('sha256:'.length);
const fleetContract = parse(await readFile('contracts/fleet-p3-runtime.yaml', 'utf8'));
const state = fleetContract.authBroker.state;

function exactStateAttestation() {
  const desired = structuredClone(buildRetainVolumeList(state));
  const pv = desired.items.find(({ kind }) => kind === 'PersistentVolume');
  const pvc = desired.items.find(({ kind }) => kind === 'PersistentVolumeClaim');
  pvc.metadata.uid = 'fixture-pvc-uid';
  pvc.metadata.resourceVersion = '17';
  pvc.status = {
    phase: 'Bound',
    accessModes: [...pvc.spec.accessModes],
    capacity: { storage: pvc.spec.resources.requests.storage },
  };
  pv.metadata.uid = 'fixture-pv-uid';
  pv.metadata.resourceVersion = '19';
  pv.spec.claimRef.uid = pvc.metadata.uid;
  pv.spec.claimRef.resourceVersion = pvc.metadata.resourceVersion;
  pv.status = { phase: 'Bound' };
  return structuredClone(
    verifyRetainVolumeReadback({ state, observedPv: pv, observedPvc: pvc }).attestation,
  );
}

function deploymentConfig() {
  const audience = '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/seori-auth/providers/microk8s';
  return {
    schemaVersion: 2,
    namespace: 'auth-broker',
    image: APPROVED_IMAGE_BINDING.image,
    imageProvenance: { ...APPROVED_IMAGE_BINDING.imageProvenance },
    imagePullPolicy: 'IfNotPresent',
    registry: {
      mode: 'PACKAGES_READER',
      imagePullSecretName: 'seori-auth-ghcr-pull',
      credentialId: 'shared/github/packages-reader',
      catalogStatus: 'ACTIVE',
      kubernetesStatus: 'VERIFIED',
    },
    nodeSelector: { 'kubernetes.io/hostname': 'rpi5' },
    stateReadbackAttestation: exactStateAttestation(),
    trustedWorkers: {
      namespaceSelector: { 'kubernetes.io/metadata.name': 'release-workers' },
      podSelector: { 'seorilabs.io/auth-client': 'true' },
    },
    providerControlPlane: {
      backofficeClientSpiffeId: 'spiffe://seorilabs.local/ns/platform/sa/provider-execution-signer',
      endpointScope: '/internal/control-plane/provider-grants',
      namespaceSelector: { 'kubernetes.io/metadata.name': 'platform' },
      podSelector: { 'app.kubernetes.io/component': 'provider-execution-signer' },
    },
    egressProxy: {
      namespaceSelector: { 'kubernetes.io/metadata.name': 'auth-egress' },
      podSelector: { 'app.kubernetes.io/name': 'seori-auth-egress-proxy' },
      port: 8443,
    },
    roles: {
      broker: {
        allowedSecretManagerResources: [
          'projects/seorilabs-ci/secrets/seori-auth-browser-vault/versions/1',
          'projects/seorilabs-ci/secrets/seori-auth-journal-mac/versions/1',
        ],
        configMapName: 'seori-auth-broker-config',
        tlsSecretName: 'seori-auth-broker-tls',
        egressTlsSecretName: 'seori-auth-broker-egress-tls',
        googleServiceAccount: 'seori-auth-broker@example-project.iam.gserviceaccount.com',
        secretAccessConfigSha256: 'b'.repeat(64),
        wifAudience: audience,
      },
      passwordLoader: {
        allowedSecretManagerResources: [
          'projects/seorilabs-ci/secrets/seori-auth-canary-password/versions/1',
        ],
        configMapName: 'seori-auth-password-config',
        tlsSecretName: 'seori-auth-password-tls',
        egressTlsSecretName: 'seori-auth-password-egress-tls',
        googleServiceAccount: 'seori-auth-password@example-project.iam.gserviceaccount.com',
        secretAccessConfigSha256: 'c'.repeat(64),
        wifAudience: audience,
      },
      totpSigner: {
        allowedSecretManagerResources: [
          'projects/seorilabs-ci/secrets/seori-auth-canary-totp-seed/versions/1',
        ],
        configMapName: 'seori-auth-totp-config',
        tlsSecretName: 'seori-auth-totp-tls',
        egressTlsSecretName: 'seori-auth-totp-egress-tls',
        googleServiceAccount: 'seori-auth-totp@example-project.iam.gserviceaccount.com',
        secretAccessConfigSha256: 'd'.repeat(64),
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

function labelsMatch(selector, labels) {
  return Object.entries(selector?.matchLabels ?? {}).every(([key, value]) => labels[key] === value);
}

function ingressAllows(policy, namespaceLabels, podLabels, port) {
  return (policy.spec.ingress ?? []).some((rule) =>
    rule.ports?.some((entry) => entry.protocol === 'TCP' && entry.port === port) &&
    rule.from?.some((peer) =>
      labelsMatch(peer.namespaceSelector, namespaceLabels) && labelsMatch(peer.podSelector, podLabels)));
}

test('production renderer exact-binds startup readback without Secret access or broad Kubernetes API grants', async () => {
  const manifest = await render();
  const serialized = JSON.stringify(manifest);
  const workloads = workloadItems(manifest);
  const serviceAccounts = manifest.items.filter((item) => item.kind === 'ServiceAccount');
  const rbac = manifest.items.filter((item) =>
    ['Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding'].includes(item.kind));
  const policies = manifest.items.filter((item) => item.kind === 'NetworkPolicy');
  const stalePlaceholder = new RegExp(['REPLACE', ''].join('_'));

  assert.equal(manifest.kind, 'List');
  assert.equal(serviceAccounts.length, 3);
  assert.equal(new Set(serviceAccounts.map((item) => item.metadata.annotations['seorilabs.io/google-service-account'])).size, 3);
  assert.doesNotMatch(serialized, /"kind":"Secret"|"stringData"|"secretKeyRef"/u);
  assert.doesNotMatch(serialized, stalePlaceholder);
  assert.doesNotMatch(serialized, /example\.invalid|0\.0\.0\.0\/0/u);
  assert.equal(workloads.length, 3);

  const stateRole = rbac.find((item) =>
    item.kind === 'Role' && item.metadata.name === 'seori-auth-state-readback');
  const stateClusterRole = rbac.find((item) =>
    item.kind === 'ClusterRole' && item.metadata.name === 'seori-auth-state-readback');
  assert.deepEqual(stateRole.rules, [{
    apiGroups: [''],
    resources: ['persistentvolumeclaims'],
    resourceNames: ['seori-auth-state'],
    verbs: ['get'],
  }]);
  assert.deepEqual(stateClusterRole.rules, [{
    apiGroups: [''],
    resources: ['persistentvolumes'],
    resourceNames: ['seori-auth-state-rpi5'],
    verbs: ['get'],
  }]);
  for (const item of rbac.filter(({ rules }) => Array.isArray(rules))) {
    for (const rule of item.rules) {
      assert.deepEqual(rule.verbs, ['get']);
      assert.ok(rule.resources.every((resource) =>
        ['persistentvolumes', 'persistentvolumeclaims'].includes(resource)));
      assert.equal(rule.resources.includes('secrets'), false);
      assert.equal(rule.verbs.some((verb) => ['list', 'watch'].includes(verb)), false);
      assert.equal(rule.resourceNames.length, 1);
    }
  }
  for (const binding of rbac.filter(({ kind }) => kind.endsWith('Binding'))) {
    if (binding.metadata.name !== 'seori-auth-state-readback') continue;
    assert.deepEqual(binding.subjects, [{
      kind: 'ServiceAccount',
      name: 'auth-broker',
      namespace: 'auth-broker',
    }]);
  }

  for (const item of workloads) {
    const pod = item.spec.template.spec;
    const container = pod.containers[0];
    const projected = pod.volumes.find((volume) => volume.name === 'projected-identity');
    const tokenProjection = projected.projected.sources[0].serviceAccountToken;
    const tokenMount = container.volumeMounts.find((mount) => mount.name === 'projected-identity');
    assert.equal(container.image, APPROVED_IMAGE_BINDING.image);
    assert.deepEqual(pod.imagePullSecrets, [{ name: 'seori-auth-ghcr-pull' }]);
    assert.deepEqual(pod.nodeSelector, { 'kubernetes.io/hostname': 'rpi5' });
    const role = item.metadata.name === 'seori-auth-broker'
      ? 'broker'
      : item.metadata.name === 'seori-password-loader' ? 'passwordLoader' : 'totpSigner';
    const binding = deploymentConfig().roles[role];
    assert.ok(container.args.includes(`--expected-secret-access-sha256=${binding.secretAccessConfigSha256}`));
    assert.ok(container.args.includes(`--expected-google-service-account=${binding.googleServiceAccount}`));
    assert.ok(container.args.includes(`--expected-wif-audience=${binding.wifAudience}`));
    assert.ok(container.args.includes(
      '--expected-backoffice-spiffe-id=spiffe://seorilabs.local/ns/platform/sa/provider-execution-signer',
    ));
    assert.ok(container.args.includes(
      '--expected-provider-endpoint-scope=/internal/control-plane/provider-grants',
    ));
    assert.equal(item.spec.template.metadata.annotations['seorilabs.io/secret-access-sha256'], binding.secretAccessConfigSha256);
    assert.equal(item.spec.template.metadata.annotations['seorilabs.io/image-digest'], `sha256:${digest}`);
    assert.equal(
      item.spec.template.metadata.annotations['seorilabs.io/image-source-sha'],
      APPROVED_IMAGE_BINDING.imageProvenance.sourceSha,
    );
    assert.equal(item.spec.template.metadata.annotations['seorilabs.io/registry-mode'], 'PACKAGES_READER');
    assert.equal(
      item.spec.template.metadata.annotations['seorilabs.io/registry-credential-id'],
      'shared/github/packages-reader',
    );
    assert.match(
      item.spec.template.metadata.annotations['seorilabs.io/secret-resource-partition-sha256'],
      /^[a-f0-9]{64}$/,
    );
    assert.equal(
      item.spec.template.metadata.annotations['seorilabs.io/provider-control-plane-spiffe'],
      'spiffe://seorilabs.local/ns/platform/sa/provider-execution-signer',
    );
    assert.equal(
      item.spec.template.metadata.annotations['seorilabs.io/provider-endpoint-scope'],
      '/internal/control-plane/provider-grants',
    );
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
  const brokerPod = broker.spec.template.spec;
  const brokerContainer = brokerPod.containers[0];
  const init = brokerPod.initContainers[0];
  const expectedAttestation = deploymentConfig().stateReadbackAttestation;
  assert.ok(broker.spec.template.spec.volumes.some((volume) => volume.name === 'state' && volume.persistentVolumeClaim));
  assert.ok(factors.every((item) => !item.spec.template.spec.volumes.some((volume) => volume.name === 'state')));
  assert.equal(brokerPod.initContainers.length, 1);
  assert.equal(init.name, 'state-volume-attestor');
  assert.ok(init.command.includes('/opt/seori-auth/runtime/state-volume-attestor.mjs'));
  assert.equal(init.volumeMounts.find(({ name }) => name === 'state').readOnly, true);
  assert.equal(init.volumeMounts.find(({ name }) => name === 'state-api-token').readOnly, true);
  assert.equal(brokerContainer.volumeMounts.some(({ name }) => name === 'state-api-token'), false);
  assert.ok(brokerPod.volumes.some(({ name, projected }) =>
    name === 'state-api-token' &&
    projected.sources[0].serviceAccountToken.audience === 'https://kubernetes.default.svc' &&
    projected.sources[0].serviceAccountToken.expirationSeconds === 600));
  for (const factor of factors) {
    assert.equal('initContainers' in factor.spec.template.spec, false);
    assert.equal(factor.spec.template.spec.volumes.some(({ name }) => name === 'state-api-token'), false);
    assert.equal(factor.spec.template.spec.containers[0].volumeMounts.some(
      ({ name }) => name === 'state-api-token'), false);
  }
  assert.ok(brokerContainer.args.includes(
    `--expected-state-attestation-sha256=${expectedAttestation.observedDigest}`));
  for (const probeName of ['startupProbe', 'readinessProbe', 'livenessProbe']) {
    assert.ok(brokerContainer[probeName].exec.command.includes(
      `--expected-state-attestation-sha256=${expectedAttestation.observedDigest}`));
  }
  assert.equal(
    broker.spec.template.metadata.annotations['seorilabs.io/state-pv-uid'],
    expectedAttestation.pv.uid,
  );
  assert.equal(
    broker.spec.template.metadata.annotations['seorilabs.io/state-pvc-resource-version'],
    expectedAttestation.pvc.resourceVersion,
  );
  const stateAttestorConfig = manifest.items.find(({ kind, metadata }) =>
    kind === 'ConfigMap' && metadata.name.startsWith('seori-auth-state-attestor-'));
  assert.equal(stateAttestorConfig.immutable, true);
  const expectedDocumentDigest = stateAttestorConfig.metadata.annotations[
    'seorilabs.io/state-attestor-expected-sha256'
  ];
  assert.match(expectedDocumentDigest, /^[a-f0-9]{64}$/u);
  assert.ok(stateAttestorConfig.metadata.name.endsWith(expectedDocumentDigest.slice(0, 12)));
  assert.equal(
    broker.spec.template.metadata.annotations['seorilabs.io/state-attestor-expected-sha256'],
    expectedDocumentDigest,
  );
  const expectedDocument = JSON.parse(stateAttestorConfig.data['expected.json']);
  assert.deepEqual(expectedDocument.attestation, expectedAttestation);
  assert.deepEqual(expectedDocument.kubernetesApi, fleetContract.authBroker.kubernetesApi);
  assert.ok(policies.some((item) => item.metadata.name === 'default-deny' && item.spec.ingress.length === 0 && item.spec.egress.length === 0));
  const dnsEgress = policies.flatMap((item) => item.spec.egress ?? []).find((rule) =>
    rule.ports?.some((entry) => entry.port === 53));
  assert.deepEqual(dnsEgress.to[0].podSelector.matchLabels, { 'k8s-app': 'kube-dns' });

  const brokerTraffic = policies.find((item) => item.metadata.name === 'broker-allowed-traffic');
  const apiRules = brokerTraffic.spec.egress.filter((rule) => rule.to?.[0]?.ipBlock);
  assert.deepEqual(apiRules, [{
    to: [{ ipBlock: { cidr: '10.152.183.1/32' } }],
    ports: [{ protocol: 'TCP', port: 443 }],
  }]);
  const factorTraffic = policies.find((item) => item.metadata.name === 'factor-allowed-traffic');
  assert.equal(JSON.stringify(factorTraffic).includes('ipBlock'), false);
  assert.equal(ingressAllows(
    brokerTraffic,
    { 'kubernetes.io/metadata.name': 'release-workers' },
    { 'seorilabs.io/auth-client': 'true' },
    8443,
  ), true);
  assert.equal(ingressAllows(
    brokerTraffic,
    { 'kubernetes.io/metadata.name': 'platform' },
    { 'app.kubernetes.io/component': 'provider-execution-signer' },
    8443,
  ), true);
  for (const [namespaceLabels, podLabels] of [
    [
      { 'kubernetes.io/metadata.name': 'platform-lookalike' },
      { 'app.kubernetes.io/component': 'provider-execution-signer' },
    ],
    [
      { 'kubernetes.io/metadata.name': 'platform' },
      { 'app.kubernetes.io/component': 'provider-execution-signer-lookalike' },
    ],
    [
      { 'kubernetes.io/metadata.name': 'release-workers' },
      { 'app.kubernetes.io/component': 'provider-execution-signer' },
    ],
  ]) {
    assert.equal(ingressAllows(brokerTraffic, namespaceLabels, podLabels, 8443), false);
  }
});

test('PUBLIC registry mode removes imagePullSecrets and credential identifiers from every workload', async () => {
  const config = deploymentConfig();
  config.registry = { mode: 'PUBLIC', visibilityStatus: 'VERIFIED_PUBLIC' };
  const manifest = await render(config);
  const workloads = workloadItems(manifest);
  const serialized = JSON.stringify(manifest);

  assert.equal(workloads.length, 3);
  for (const item of workloads) {
    assert.equal('imagePullSecrets' in item.spec.template.spec, false);
    assert.equal(item.spec.template.metadata.annotations['seorilabs.io/registry-mode'], 'PUBLIC');
    assert.equal('seorilabs.io/registry-credential-id' in item.spec.template.metadata.annotations, false);
  }
  assert.doesNotMatch(serialized, /seori-auth-ghcr-pull|shared\/github\/packages-reader/u);
});

test('production renderer rejects mutable images and shared factor identities', async () => {
  const legacy = deploymentConfig();
  legacy.schemaVersion = 1;
  await assert.rejects(render(legacy), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /top-level deployment fields are invalid/);
    return true;
  });

  for (const mutate of [
    (config) => { delete config.stateReadbackAttestation; },
    (config) => { config.stateReadbackAttestation.pv.uid = 'substituted-pv-uid'; },
    (config) => { config.stateReadbackAttestation.observedDigest = 'f'.repeat(64); },
  ]) {
    const invalidStateReadback = deploymentConfig();
    mutate(invalidStateReadback);
    await assert.rejects(render(invalidStateReadback), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /(?:top-level deployment fields|state readback attestation) .*invalid/u);
      return true;
    });
  }

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

  const missingImagePullIdentity = deploymentConfig();
  delete missingImagePullIdentity.registry;
  await assert.rejects(render(missingImagePullIdentity), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /top-level deployment fields are invalid/);
    return true;
  });

  const crossRoleSecret = deploymentConfig();
  crossRoleSecret.roles.passwordLoader.allowedSecretManagerResources =
    crossRoleSecret.roles.totpSigner.allowedSecretManagerResources;
  await assert.rejects(render(crossRoleSecret), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /passwordLoader Secret Manager partition is invalid/);
    return true;
  });

  const invalidImagePullIdentity = deploymentConfig();
  invalidImagePullIdentity.registry.imagePullSecretName = 'registry-pull-cred';
  await assert.rejects(render(invalidImagePullIdentity), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /packages reader binding is not canonical and verified/);
    return true;
  });

  const driftedProvenance = deploymentConfig();
  driftedProvenance.imageProvenance.sourceSha = 'e'.repeat(40);
  await assert.rejects(render(driftedProvenance), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /code-approved immutable binding/);
    return true;
  });

  const implicitRegistry = deploymentConfig();
  implicitRegistry.registry = {};
  await assert.rejects(render(implicitRegistry), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /registry mode must be explicit/);
    return true;
  });

  const longLabel = deploymentConfig();
  longLabel.nodeSelector = { 'seorilabs.io/node-role': 'a'.repeat(64) };
  await assert.rejects(render(longLabel), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /nodeSelector is invalid/);
    return true;
  });

  for (const nodeSelector of [
    { 'kubernetes.io/hostname': 'rpi4001' },
    { 'seorilabs.io/node-role': 'auth' },
  ]) {
    const wrongNode = deploymentConfig();
    wrongNode.nodeSelector = nodeSelector;
    await assert.rejects(render(wrongNode), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /nodeSelector must select rpi5 exactly/);
      return true;
    });
  }

  const driftedProviderScope = deploymentConfig();
  driftedProviderScope.providerControlPlane.endpointScope = '/auth/policy-grants';
  await assert.rejects(render(driftedProviderScope), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /provider control-plane binding is invalid/);
    return true;
  });

  const workerSpiffe = deploymentConfig();
  workerSpiffe.providerControlPlane.backofficeClientSpiffeId =
    'spiffe://seorilabs.local/ns/platform/sa/provider-execution-worker';
  await assert.rejects(render(workerSpiffe), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /provider control-plane binding is invalid/);
    return true;
  });

  const workerPod = deploymentConfig();
  workerPod.providerControlPlane.podSelector = {
    'app.kubernetes.io/component': 'provider-execution-worker',
  };
  await assert.rejects(render(workerPod), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /provider control-plane network identity is invalid/);
    return true;
  });

  const missingProviderNetworkIdentity = deploymentConfig();
  delete missingProviderNetworkIdentity.providerControlPlane.podSelector;
  await assert.rejects(render(missingProviderNetworkIdentity), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /provider control-plane binding is invalid/);
    return true;
  });

  const broadProviderNetworkIdentity = deploymentConfig();
  broadProviderNetworkIdentity.providerControlPlane.namespaceSelector = {};
  await assert.rejects(render(broadProviderNetworkIdentity), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /providerControlPlane\.namespaceSelector must contain exactly one label/);
    return true;
  });
});
