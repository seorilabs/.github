#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import {
  PROVIDER_CONTROL_PLANE_CLIENT_SPIFFE_ID,
  PROVIDER_CONTROL_PLANE_ENDPOINT_SCOPE,
} from '../src/provider-grants.mjs';
import {
  exactKeys,
  imagePullSecrets,
  validateImageProvenance,
  validateRegistry,
} from './public-image-binding.mjs';
import {
  StateEnvelopeError,
  validateStateVolumeReadbackAttestation,
} from '../src/state-envelope.mjs';
import {
  buildRuntimeStateAttestationMarker,
  HOST_ENCRYPTION_MARKER_PATH,
  HostEncryptedMountError,
  validateHostEncryptedMountAttestation,
} from '../src/host-encrypted-mount.mjs';

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const WIF_AUDIENCE = /^\/\/iam\.googleapis\.com\/projects\/[1-9][0-9]*\/locations\/global\/workloadIdentityPools\/[A-Za-z0-9_-]+\/providers\/[A-Za-z0-9_-]+$/;
const GOOGLE_IDENTITY = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/;
const ROLES = Object.freeze(['broker', 'passwordLoader', 'totpSigner']);
const SECRET_MANAGER_RESOURCES = Object.freeze({
  broker: Object.freeze([
    'projects/seorilabs-ci/secrets/seori-auth-browser-vault/versions/1',
    'projects/seorilabs-ci/secrets/seori-auth-journal-mac/versions/1',
  ]),
  passwordLoader: Object.freeze([
    'projects/seorilabs-ci/secrets/seori-auth-canary-password/versions/1',
  ]),
  totpSigner: Object.freeze([
    'projects/seorilabs-ci/secrets/seori-auth-canary-totp-seed/versions/1',
  ]),
});
const PROVIDER_NAMESPACE_SELECTOR = Object.freeze({
  'kubernetes.io/metadata.name': 'platform',
});
const PROVIDER_POD_SELECTOR = Object.freeze({
  'app.kubernetes.io/component': 'provider-execution-signer',
});
const AUTH_BROKER_NODE_SELECTOR = Object.freeze({
  'kubernetes.io/hostname': 'rpi5',
});
const FLEET_RUNTIME_CONTRACT = fileURLToPath(
  new URL('../../../contracts/fleet-p3-runtime.yaml', import.meta.url),
);
const STATE_ATTESTOR_EXPECTED_PATH = '/etc/seori-auth-state-attestor/expected.json';
const STATE_ATTESTOR_MARKER_PATH = '/run/seori-auth-state-attestor/verified.json';

function fail(message) {
  process.stderr.write(`${JSON.stringify({ valid: false, code: 'invalid_deployment_config', message })}\n`);
  process.exit(1);
}

function dns(value, label) {
  if (typeof value !== 'string' || !DNS_LABEL.test(value)) fail(`${label} is invalid`);
  return value;
}

function labels(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) {
    fail(`${label} must contain exactly one label`);
  }
  const [[key, content]] = Object.entries(value);
  if (!/^[A-Za-z0-9./_-]+$/.test(key) || content.length > 63 || !DNS_LABEL.test(content)) fail(`${label} is invalid`);
  return Object.freeze({ [key]: content });
}

function sameLabels(actual, expected) {
  return Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => actual[key] === value);
}

async function load(path) {
  if (!isAbsolute(path)) fail('config path must be absolute');
  const [entry, canonical] = await Promise.all([lstat(path), realpath(path)]);
  if (!entry.isFile() || entry.isSymbolicLink() || canonical !== path) fail('config path must be canonical and regular');
  const bytes = await readFile(path);
  try {
    if (bytes.length === 0 || bytes.length > 256 * 1024) fail('config size is invalid');
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('config JSON is invalid');
  } finally {
    bytes.fill(0);
  }
}

async function loadFleetRuntimeContract() {
  const bytes = await readFile(FLEET_RUNTIME_CONTRACT);
  try {
    if (bytes.length === 0 || bytes.length > 512 * 1024) fail('fleet runtime contract size is invalid');
    const contract = parse(bytes.toString('utf8'));
    if (contract?.schemaVersion !== 3 || !contract.authBroker?.state || !contract.authBroker?.kubernetesApi) {
      fail('fleet runtime state attestation contract is invalid');
    }
    return contract.authBroker;
  } catch {
    fail('fleet runtime contract is invalid');
  } finally {
    bytes.fill(0);
  }
}

function roleConfig(value, role) {
  const fields = [
    'allowedSecretManagerResources', 'configMapName', 'egressTlsSecretName', 'googleServiceAccount',
    'secretAccessConfigSha256', 'tlsSecretName', 'wifAudience',
    ...(role === 'broker' ? ['journalCheckpointTlsSecretName'] : []),
  ];
  if (!exactKeys(value, fields)) fail(`${role} binding fields are invalid`);
  if (
    !GOOGLE_IDENTITY.test(value.googleServiceAccount ?? '') ||
    !WIF_AUDIENCE.test(value.wifAudience ?? '') ||
    !SHA256.test(value.secretAccessConfigSha256 ?? '')
  ) {
    fail(`${role} workload identity is invalid`);
  }
  if (
    !Array.isArray(value.allowedSecretManagerResources) ||
    value.allowedSecretManagerResources.toSorted().join('\0') !==
      SECRET_MANAGER_RESOURCES[role].join('\0')
  ) fail(`${role} Secret Manager partition is invalid`);
  if (
    role === 'broker' &&
    value.journalCheckpointTlsSecretName !== 'seori-auth-journal-checkpoint-client-tls'
  ) fail('broker journal checkpoint mTLS binding is invalid');
  return Object.freeze({
    allowedSecretManagerResources: Object.freeze([
      ...value.allowedSecretManagerResources,
    ]),
    configMapName: dns(value.configMapName, `${role}.configMapName`),
    egressTlsSecretName: dns(value.egressTlsSecretName, `${role}.egressTlsSecretName`),
    googleServiceAccount: value.googleServiceAccount,
    ...(role === 'broker' ? {
      journalCheckpointTlsSecretName: value.journalCheckpointTlsSecretName,
    } : {}),
    secretAccessConfigSha256: value.secretAccessConfigSha256,
    tlsSecretName: dns(value.tlsSecretName, `${role}.tlsSecretName`),
    wifAudience: value.wifAudience,
  });
}

function validate(config, fleetBroker) {
  if (!exactKeys(config, [
    'egressProxy', 'image', 'imageProvenance', 'imagePullPolicy', 'namespace', 'nodeSelector', 'registry',
    'roles', 'providerControlPlane', 'schemaVersion', 'stateReadbackAttestation',
    'hostEncryptionAttestation', 'trustedWorkers',
  ]) || config.schemaVersion !== 2 || config.namespace !== 'auth-broker') {
    fail('top-level deployment fields are invalid');
  }
  if (fleetBroker.namespace !== config.namespace) fail('fleet runtime namespace binding is invalid');
  if (
    !exactKeys(fleetBroker.kubernetesApi, [
      'audience', 'caConfigMapName', 'egressCidr', 'port', 'server',
      'tokenExpirationSeconds',
    ]) ||
    fleetBroker.kubernetesApi.server !== 'https://kubernetes.default.svc' ||
    fleetBroker.kubernetesApi.egressCidr !== '10.152.183.1/32' ||
    fleetBroker.kubernetesApi.port !== 443 ||
    fleetBroker.kubernetesApi.audience !== 'https://kubernetes.default.svc' ||
    fleetBroker.kubernetesApi.caConfigMapName !== 'kube-root-ca.crt' ||
    fleetBroker.kubernetesApi.tokenExpirationSeconds !== 600
  ) fail('Kubernetes API startup attestor binding is invalid');
  let hostEncryptionAttestation;
  let stateReadbackAttestation;
  try {
    stateReadbackAttestation = validateStateVolumeReadbackAttestation({
      state: fleetBroker.state,
      attestation: config.stateReadbackAttestation,
    });
    hostEncryptionAttestation = validateHostEncryptedMountAttestation({
      state: fleetBroker.state,
      stateVolumeAttestation: stateReadbackAttestation,
      attestation: config.hostEncryptionAttestation,
    });
  } catch (error) {
    if (error instanceof StateEnvelopeError) fail('state readback attestation is invalid');
    if (error instanceof HostEncryptedMountError) fail('host encryption attestation is invalid');
    throw error;
  }
  const imageProvenance = validateImageProvenance(config.image, config.imageProvenance, fail);
  const registry = validateRegistry(config.registry, fail);
  if (!['Always', 'IfNotPresent'].includes(config.imagePullPolicy)) fail('imagePullPolicy is invalid');
  if (!exactKeys(config.roles, ROLES)) fail('all three role bindings are required');
  if (!exactKeys(config.egressProxy, ['namespaceSelector', 'podSelector', 'port'])) fail('egress proxy binding is invalid');
  if (!exactKeys(config.trustedWorkers, ['namespaceSelector', 'podSelector'])) fail('trusted worker binding is invalid');
  if (
    !exactKeys(config.providerControlPlane, [
      'backofficeClientSpiffeId', 'endpointScope', 'namespaceSelector', 'podSelector',
    ]) ||
    config.providerControlPlane.backofficeClientSpiffeId !== PROVIDER_CONTROL_PLANE_CLIENT_SPIFFE_ID ||
    config.providerControlPlane.endpointScope !== PROVIDER_CONTROL_PLANE_ENDPOINT_SCOPE
  ) fail('provider control-plane binding is invalid');
  if (!Number.isSafeInteger(config.egressProxy.port) || config.egressProxy.port < 1_024 || config.egressProxy.port > 65_535) {
    fail('egress proxy port is invalid');
  }
  const normalizedRoles = Object.freeze(Object.fromEntries(
    ROLES.map((role) => [role, roleConfig(config.roles[role], role)]),
  ));
  for (const field of [
    'configMapName', 'egressTlsSecretName', 'googleServiceAccount', 'secretAccessConfigSha256', 'tlsSecretName',
  ]) {
    if (new Set(ROLES.map((role) => normalizedRoles[role][field])).size !== ROLES.length) {
      fail(`${field} must be distinct for every workload role`);
    }
  }
  const providerNamespaceSelector = labels(
    config.providerControlPlane.namespaceSelector,
    'providerControlPlane.namespaceSelector',
  );
  const providerPodSelector = labels(
    config.providerControlPlane.podSelector,
    'providerControlPlane.podSelector',
  );
  if (
    !sameLabels(providerNamespaceSelector, PROVIDER_NAMESPACE_SELECTOR) ||
    !sameLabels(providerPodSelector, PROVIDER_POD_SELECTOR)
  ) fail('provider control-plane network identity is invalid');
  const nodeSelector = labels(config.nodeSelector, 'nodeSelector');
  if (!sameLabels(nodeSelector, AUTH_BROKER_NODE_SELECTOR)) {
    fail('nodeSelector must select rpi5 exactly');
  }
  return Object.freeze({
    ...config,
    imageProvenance,
    registry,
    nodeSelector,
    state: fleetBroker.state,
    kubernetesApi: fleetBroker.kubernetesApi,
    hostEncryptionAttestation,
    stateReadbackAttestation,
    trustedWorkers: Object.freeze({
      namespaceSelector: labels(config.trustedWorkers.namespaceSelector, 'trustedWorkers.namespaceSelector'),
      podSelector: labels(config.trustedWorkers.podSelector, 'trustedWorkers.podSelector'),
    }),
    providerControlPlane: Object.freeze({
      backofficeClientSpiffeId: config.providerControlPlane.backofficeClientSpiffeId,
      endpointScope: config.providerControlPlane.endpointScope,
      namespaceSelector: providerNamespaceSelector,
      podSelector: providerPodSelector,
    }),
    egressProxy: Object.freeze({
      namespaceSelector: labels(config.egressProxy.namespaceSelector, 'egressProxy.namespaceSelector'),
      podSelector: labels(config.egressProxy.podSelector, 'egressProxy.podSelector'),
      port: config.egressProxy.port,
    }),
    roles: normalizedRoles,
  });
}

function metadata(name, namespace = 'auth-broker') {
  return { name, namespace };
}

function serviceAccountName(role) {
  return role === 'broker' ? 'auth-broker' : role === 'passwordLoader' ? 'password-loader' : 'totp-signer';
}

function appName(role) {
  return role === 'broker' ? 'seori-auth-broker' : role === 'passwordLoader' ? 'seori-password-loader' : 'seori-totp-signer';
}

function runtimeRole(role) {
  return role === 'broker' ? 'broker' : role === 'passwordLoader' ? 'password-loader' : 'totp-signer';
}

function port(role) {
  return role === 'broker' ? 8443 : 9443;
}

function securityContext() {
  return {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ['ALL'] },
    privileged: false,
    readOnlyRootFilesystem: true,
  };
}

function podSecurityContext() {
  return {
    fsGroup: 65532,
    fsGroupChangePolicy: 'OnRootMismatch',
    runAsGroup: 65532,
    runAsNonRoot: true,
    runAsUser: 65532,
    seccompProfile: { type: 'RuntimeDefault' },
  };
}

function stateAttestorExpected(config) {
  return {
    schemaVersion: 1,
    state: config.state,
    kubernetesApi: config.kubernetesApi,
    attestation: config.stateReadbackAttestation,
    hostEncryptionAttestation: config.hostEncryptionAttestation,
  };
}

function runtimeStateMarker(config) {
  return buildRuntimeStateAttestationMarker({
    stateVolumeAttestation: config.stateReadbackAttestation,
    hostEncryptionAttestation: config.hostEncryptionAttestation,
  });
}

function stateAttestorExpectedDigest(config) {
  return createHash('sha256')
    .update(JSON.stringify(stateAttestorExpected(config)))
    .digest('hex');
}

function stateAttestorConfigName(config) {
  return `seori-auth-state-attestor-${stateAttestorExpectedDigest(config).slice(0, 12)}`;
}

function roleVolumes(role, binding, config) {
  const volumes = [
    { name: 'runtime', emptyDir: { medium: 'Memory', sizeLimit: role === 'broker' ? '512Mi' : '16Mi' } },
    { name: 'config', configMap: { name: binding.configMapName, defaultMode: 0o440 } },
    { name: 'service-tls', secret: { secretName: binding.tlsSecretName, defaultMode: 0o440 } },
    { name: 'egress-tls', secret: { secretName: binding.egressTlsSecretName, defaultMode: 0o440 } },
    {
      name: 'projected-identity',
      projected: {
        defaultMode: 0o440,
        sources: [{ serviceAccountToken: { audience: binding.wifAudience, expirationSeconds: 600, path: 'token' } }],
      },
    },
  ];
  if (role === 'broker') {
    volumes.push(
      {
        name: 'journal-checkpoint-tls',
        secret: { secretName: binding.journalCheckpointTlsSecretName, defaultMode: 0o440 },
      },
      { name: 'state', persistentVolumeClaim: { claimName: config.state.volume.claimName } },
      {
        name: 'state-attestor-config',
        configMap: { name: stateAttestorConfigName(config), defaultMode: 0o440 },
      },
      { name: 'state-attestor-result', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } },
      {
        name: 'state-api-token',
        projected: {
          defaultMode: 0o440,
          sources: [{
            serviceAccountToken: {
              audience: config.kubernetesApi.audience,
              expirationSeconds: config.kubernetesApi.tokenExpirationSeconds,
              path: 'token',
            },
          }, {
            configMap: {
              name: config.kubernetesApi.caConfigMapName,
              items: [{ key: 'ca.crt', path: 'ca.crt' }],
            },
          }],
        },
      },
    );
  }
  return volumes;
}

function configMounts(role) {
  const mounts = [
    { name: 'config', mountPath: '/etc/seori-auth/runtime.json', subPath: 'runtime.json', readOnly: true },
    { name: 'config', mountPath: '/etc/seori-auth/secret-access.json', subPath: 'secret-access.json', readOnly: true },
    { name: 'service-tls', mountPath: '/etc/seori-auth/tls/ca.crt', subPath: 'ca.crt', readOnly: true },
    { name: 'service-tls', mountPath: '/etc/seori-auth/tls/tls.crt', subPath: 'tls.crt', readOnly: true },
    { name: 'service-tls', mountPath: '/etc/seori-auth/tls/tls.key', subPath: 'tls.key', readOnly: true },
    { name: 'egress-tls', mountPath: '/etc/seori-auth/egress/ca.crt', subPath: 'ca.crt', readOnly: true },
    { name: 'egress-tls', mountPath: '/etc/seori-auth/egress/tls.crt', subPath: 'tls.crt', readOnly: true },
    { name: 'egress-tls', mountPath: '/etc/seori-auth/egress/tls.key', subPath: 'tls.key', readOnly: true },
    { name: 'projected-identity', mountPath: '/var/run/seori-auth/projected-identity', readOnly: true },
    { name: 'runtime', mountPath: '/run/seori-auth' },
  ];
  if (role === 'broker') {
    mounts.push(
      {
        name: 'journal-checkpoint-tls',
        mountPath: '/etc/seori-auth/journal-checkpoint-tls/ca.crt',
        subPath: 'ca.crt',
        readOnly: true,
      },
      {
        name: 'journal-checkpoint-tls',
        mountPath: '/etc/seori-auth/journal-checkpoint-tls/tls.crt',
        subPath: 'tls.crt',
        readOnly: true,
      },
      {
        name: 'journal-checkpoint-tls',
        mountPath: '/etc/seori-auth/journal-checkpoint-tls/tls.key',
        subPath: 'tls.key',
        readOnly: true,
      },
      { name: 'config', mountPath: '/etc/seori-auth/policy.json', subPath: 'policy.json', readOnly: true },
      { name: 'config', mountPath: '/etc/seori-auth/run-attestation.pub', subPath: 'run-attestation.pub', readOnly: true },
      { name: 'state', mountPath: '/var/lib/seori-auth' },
      {
        name: 'state-attestor-result',
        mountPath: '/run/seori-auth-state-attestor',
        readOnly: true,
      },
    );
  }
  return mounts;
}

function probe(role, config) {
  const stateOptions = role === 'broker'
    ? [
        `--state-attestation-file=${STATE_ATTESTOR_MARKER_PATH}`,
        `--expected-state-attestation-sha256=${runtimeStateMarker(config).observedDigest}`,
        `--host-encryption-marker-file=${HOST_ENCRYPTION_MARKER_PATH}`,
        `--expected-host-encryption-sha256=${config.hostEncryptionAttestation.observedDigest}`,
      ]
    : [];
  return {
    exec: {
      command: [
        '/opt/seori-auth/bin/seori-auth-native', 'launch', '--', '/usr/local/bin/node',
        '/opt/seori-auth/runtime/entrypoint.mjs', 'healthcheck',
        `--readiness-file=/run/seori-auth/${runtimeRole(role)}.ready`,
        ...stateOptions,
      ],
    },
    periodSeconds: 10,
    timeoutSeconds: 3,
    failureThreshold: 3,
  };
}

function stateAttestorInitContainer(config) {
  return {
    name: 'state-volume-attestor',
    image: config.image,
    imagePullPolicy: config.imagePullPolicy,
    command: [
      '/opt/seori-auth/bin/seori-auth-native', 'launch', '--', '/usr/local/bin/node',
      '/opt/seori-auth/runtime/state-volume-attestor.mjs',
    ],
    args: [],
    securityContext: securityContext(),
    resources: {
      requests: { cpu: '10m', memory: '32Mi' },
      limits: { cpu: '100m', memory: '96Mi' },
    },
    volumeMounts: [
      { name: 'state', mountPath: '/var/lib/seori-auth', readOnly: true },
      {
        name: 'state-attestor-config',
        mountPath: STATE_ATTESTOR_EXPECTED_PATH,
        subPath: 'expected.json',
        readOnly: true,
      },
      { name: 'state-attestor-result', mountPath: '/run/seori-auth-state-attestor' },
      { name: 'state-api-token', mountPath: '/var/run/seori-auth-state-token', readOnly: true },
    ],
  };
}

function workload(role, config) {
  const binding = config.roles[role];
  const pullSecrets = imagePullSecrets(config.registry);
  const resourcePartitionSha256 = createHash('sha256')
    .update(JSON.stringify(binding.allowedSecretManagerResources.toSorted()))
    .digest('hex');
  const labels = { 'app.kubernetes.io/name': appName(role) };
  const container = {
    name: runtimeRole(role),
    image: config.image,
    imagePullPolicy: config.imagePullPolicy,
    args: [
      'serve',
      '--config=/etc/seori-auth/runtime.json',
      `--expected-secret-access-sha256=${binding.secretAccessConfigSha256}`,
      `--expected-google-service-account=${binding.googleServiceAccount}`,
      `--expected-wif-audience=${binding.wifAudience}`,
      `--expected-backoffice-spiffe-id=${config.providerControlPlane.backofficeClientSpiffeId}`,
      `--expected-provider-endpoint-scope=${config.providerControlPlane.endpointScope}`,
      ...(role === 'broker' ? [
        `--state-attestation-file=${STATE_ATTESTOR_MARKER_PATH}`,
        `--expected-state-attestation-sha256=${runtimeStateMarker(config).observedDigest}`,
        `--host-encryption-marker-file=${HOST_ENCRYPTION_MARKER_PATH}`,
        `--expected-host-encryption-sha256=${config.hostEncryptionAttestation.observedDigest}`,
      ] : []),
    ],
    ports: [{ name: 'mtls', containerPort: port(role), protocol: 'TCP' }],
    readinessProbe: probe(role, config),
    livenessProbe: probe(role, config),
    startupProbe: { ...probe(role, config), failureThreshold: 30 },
    securityContext: securityContext(),
    resources: role === 'broker'
      ? { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '1Gi' } }
      : { requests: { cpu: '25m', memory: '64Mi' }, limits: { cpu: '250m', memory: '192Mi' } },
    volumeMounts: configMounts(role),
  };
  const pod = {
    metadata: {
      labels,
      annotations: {
        'seorilabs.io/google-service-account': binding.googleServiceAccount,
        'seorilabs.io/image-digest': config.imageProvenance.imageDigest,
        'seorilabs.io/image-source-sha': config.imageProvenance.sourceSha,
        'seorilabs.io/image-workflow-run': String(config.imageProvenance.runId),
        'seorilabs.io/registry-mode': config.registry.mode,
        'seorilabs.io/secret-access-sha256': binding.secretAccessConfigSha256,
        'seorilabs.io/secret-resource-partition-sha256': resourcePartitionSha256,
        'seorilabs.io/provider-control-plane-spiffe': config.providerControlPlane.backofficeClientSpiffeId,
        'seorilabs.io/provider-endpoint-scope': config.providerControlPlane.endpointScope,
        ...(role === 'broker' ? {
          'seorilabs.io/state-attestor-expected-sha256': stateAttestorExpectedDigest(config),
          'seorilabs.io/state-observed-digest': config.stateReadbackAttestation.observedDigest,
          'seorilabs.io/host-encryption-observed-digest':
            config.hostEncryptionAttestation.observedDigest,
          'seorilabs.io/runtime-state-observed-digest': runtimeStateMarker(config).observedDigest,
          'seorilabs.io/state-pv-uid': config.stateReadbackAttestation.pv.uid,
          'seorilabs.io/state-pv-resource-version': config.stateReadbackAttestation.pv.resourceVersion,
          'seorilabs.io/state-pvc-uid': config.stateReadbackAttestation.pvc.uid,
          'seorilabs.io/state-pvc-resource-version': config.stateReadbackAttestation.pvc.resourceVersion,
        } : {}),
        ...(config.registry.mode === 'PACKAGES_READER'
          ? { 'seorilabs.io/registry-credential-id': config.registry.credentialId }
          : {}),
      },
    },
    spec: {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostIPC: false,
      hostNetwork: false,
      hostPID: false,
      ...(pullSecrets === undefined ? {} : { imagePullSecrets: pullSecrets }),
      nodeSelector: config.nodeSelector,
      securityContext: podSecurityContext(),
      serviceAccountName: serviceAccountName(role),
      terminationGracePeriodSeconds: 30,
      ...(role === 'broker' ? { initContainers: [stateAttestorInitContainer(config)] } : {}),
      containers: [container],
      volumes: roleVolumes(role, binding, config),
    },
  };
  const common = {
    apiVersion: 'apps/v1',
    kind: role === 'broker' ? 'StatefulSet' : 'Deployment',
    metadata: {
      ...metadata(appName(role)),
      annotations: {
        'seorilabs.io/deployable': 'true',
        'seorilabs.io/image': config.image,
        'seorilabs.io/image-source-sha': config.imageProvenance.sourceSha,
        'seorilabs.io/registry-mode': config.registry.mode,
      },
    },
    spec: {
      replicas: 0,
      selector: { matchLabels: labels },
      template: pod,
    },
  };
  if (role === 'broker') common.spec.serviceName = 'auth-broker';
  return common;
}

function networkPolicies(config) {
  const dns = {
    to: [{
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
      podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
    }],
    ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }],
  };
  const proxy = {
    to: [{
      namespaceSelector: { matchLabels: config.egressProxy.namespaceSelector },
      podSelector: { matchLabels: config.egressProxy.podSelector },
    }],
    ports: [{ protocol: 'TCP', port: config.egressProxy.port }],
  };
  const kubernetesApi = {
    to: [{ ipBlock: { cidr: config.kubernetesApi.egressCidr } }],
    ports: [{ protocol: 'TCP', port: config.kubernetesApi.port }],
  };
  const journalCheckpointAuthority = {
    to: [{
      namespaceSelector: { matchLabels: config.providerControlPlane.namespaceSelector },
      podSelector: { matchLabels: config.providerControlPlane.podSelector },
    }],
    ports: [{ protocol: 'TCP', port: 9443 }],
  };
  return [
    {
      apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: metadata('default-deny'),
      spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] },
    },
    {
      apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: metadata('broker-allowed-traffic'),
      spec: {
        podSelector: { matchLabels: { 'app.kubernetes.io/name': 'seori-auth-broker' } },
        policyTypes: ['Ingress', 'Egress'],
        ingress: [{
          from: [{
            namespaceSelector: { matchLabels: config.trustedWorkers.namespaceSelector },
            podSelector: { matchLabels: config.trustedWorkers.podSelector },
          }, {
            namespaceSelector: { matchLabels: config.providerControlPlane.namespaceSelector },
            podSelector: { matchLabels: config.providerControlPlane.podSelector },
          }],
          ports: [{ protocol: 'TCP', port: 8443 }],
        }],
        egress: [dns, proxy, kubernetesApi, journalCheckpointAuthority, {
          to: [{ podSelector: { matchExpressions: [{
            key: 'app.kubernetes.io/name', operator: 'In', values: ['seori-password-loader', 'seori-totp-signer'],
          }] } }],
          ports: [{ protocol: 'TCP', port: 9443 }],
        }],
      },
    },
    {
      apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: metadata('factor-allowed-traffic'),
      spec: {
        podSelector: { matchExpressions: [{
          key: 'app.kubernetes.io/name', operator: 'In', values: ['seori-password-loader', 'seori-totp-signer'],
        }] },
        policyTypes: ['Ingress', 'Egress'],
        ingress: [{
          from: [{ podSelector: { matchLabels: { 'app.kubernetes.io/name': 'seori-auth-broker' } } }],
          ports: [{ protocol: 'TCP', port: 9443 }],
        }],
        egress: [dns, proxy],
      },
    },
  ];
}

function stateAttestorConfigMap(config) {
  const expectedDigest = stateAttestorExpectedDigest(config);
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      ...metadata(stateAttestorConfigName(config)),
      annotations: { 'seorilabs.io/state-attestor-expected-sha256': expectedDigest },
    },
    immutable: true,
    data: {
      'expected.json': `${JSON.stringify(stateAttestorExpected(config))}\n`,
    },
  };
}

function stateReadbackRbac(config) {
  const name = 'seori-auth-state-readback';
  return [{
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: { name },
    rules: [{
      apiGroups: [''],
      resources: ['persistentvolumes'],
      resourceNames: [config.state.volume.volumeName],
      verbs: ['get'],
    }],
  }, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRoleBinding',
    metadata: { name },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name },
    subjects: [{ kind: 'ServiceAccount', name: 'auth-broker', namespace: config.namespace }],
  }, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: metadata(name),
    rules: [{
      apiGroups: [''],
      resources: ['persistentvolumeclaims'],
      resourceNames: [config.state.volume.claimName],
      verbs: ['get'],
    }],
  }, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: metadata(name),
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name },
    subjects: [{ kind: 'ServiceAccount', name: 'auth-broker', namespace: config.namespace }],
  }];
}

function render(config) {
  const items = [{
    apiVersion: 'v1', kind: 'Namespace', metadata: {
      name: config.namespace,
      labels: {
        'pod-security.kubernetes.io/enforce': 'restricted',
        'pod-security.kubernetes.io/enforce-version': 'latest',
        'pod-security.kubernetes.io/audit': 'restricted',
        'pod-security.kubernetes.io/warn': 'restricted',
      },
    },
  }];
  items.push(stateAttestorConfigMap(config), ...stateReadbackRbac(config));
  for (const role of ROLES) {
    const name = serviceAccountName(role);
    items.push({
      apiVersion: 'v1', kind: 'ServiceAccount', metadata: {
        ...metadata(name),
        annotations: {
          'seorilabs.io/google-service-account': config.roles[role].googleServiceAccount,
          'seorilabs.io/secret-access-sha256': config.roles[role].secretAccessConfigSha256,
          'seorilabs.io/workload-role': runtimeRole(role),
        },
      }, automountServiceAccountToken: false,
    });
  }
  items.push(
    {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: metadata('auth-broker-no-kubernetes-api'), rules: [],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: metadata('auth-broker-no-kubernetes-api'),
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'auth-broker-no-kubernetes-api' },
      subjects: ROLES.map((role) => ({ kind: 'ServiceAccount', name: serviceAccountName(role), namespace: config.namespace })),
    },
  );
  for (const role of ROLES) {
    items.push({
      apiVersion: 'v1', kind: 'Service', metadata: metadata(serviceAccountName(role)),
      spec: {
        selector: { 'app.kubernetes.io/name': appName(role) },
        ports: [{ name: 'mtls', port: port(role), targetPort: 'mtls', protocol: 'TCP' }],
      },
    });
  }
  items.push(...ROLES.map((role) => workload(role, config)), ...networkPolicies(config));
  return { apiVersion: 'v1', kind: 'List', items };
}

const argument = process.argv[2];
if (process.argv.length !== 3 || !argument?.startsWith('--config=')) fail('usage: render-production-k8s.mjs --config=/absolute/path.json');
const fleetBroker = await loadFleetRuntimeContract();
const config = validate(await load(argument.slice('--config='.length)), fleetBroker);
process.stdout.write(`${JSON.stringify(render(config), null, 2)}\n`);
