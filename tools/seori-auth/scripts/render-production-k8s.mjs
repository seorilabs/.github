#!/usr/bin/env node

import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const IMAGE = /^[a-z0-9][a-z0-9._\/-]*(?::[0-9]+)?\/[a-z0-9][a-z0-9._\/-]*@sha256:[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const WIF_AUDIENCE = /^\/\/iam\.googleapis\.com\/projects\/[1-9][0-9]*\/locations\/global\/workloadIdentityPools\/[A-Za-z0-9_-]+\/providers\/[A-Za-z0-9_-]+$/;
const GOOGLE_IDENTITY = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/;
const ROLES = Object.freeze(['broker', 'passwordLoader', 'totpSigner']);

function fail(message) {
  process.stderr.write(`${JSON.stringify({ valid: false, code: 'invalid_deployment_config', message })}\n`);
  process.exit(1);
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
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

function roleConfig(value, role) {
  if (!exactKeys(value, [
    'configMapName', 'egressTlsSecretName', 'googleServiceAccount', 'secretAccessConfigSha256',
    'tlsSecretName', 'wifAudience',
  ])) fail(`${role} binding fields are invalid`);
  if (
    !GOOGLE_IDENTITY.test(value.googleServiceAccount ?? '') ||
    !WIF_AUDIENCE.test(value.wifAudience ?? '') ||
    !SHA256.test(value.secretAccessConfigSha256 ?? '')
  ) {
    fail(`${role} workload identity is invalid`);
  }
  return Object.freeze({
    configMapName: dns(value.configMapName, `${role}.configMapName`),
    egressTlsSecretName: dns(value.egressTlsSecretName, `${role}.egressTlsSecretName`),
    googleServiceAccount: value.googleServiceAccount,
    secretAccessConfigSha256: value.secretAccessConfigSha256,
    tlsSecretName: dns(value.tlsSecretName, `${role}.tlsSecretName`),
    wifAudience: value.wifAudience,
  });
}

function validate(config) {
  if (!exactKeys(config, [
    'egressProxy', 'image', 'imagePullPolicy', 'namespace', 'nodeSelector', 'roles',
    'schemaVersion', 'stateClaimName', 'trustedWorkers',
  ]) || config.schemaVersion !== 1 || config.namespace !== 'auth-broker') {
    fail('top-level deployment fields are invalid');
  }
  if (!IMAGE.test(config.image ?? '') || config.image.includes('example.invalid')) fail('image must be one immutable registry digest');
  if (!['Always', 'IfNotPresent'].includes(config.imagePullPolicy)) fail('imagePullPolicy is invalid');
  if (!exactKeys(config.roles, ROLES)) fail('all three role bindings are required');
  if (!exactKeys(config.egressProxy, ['namespaceSelector', 'podSelector', 'port'])) fail('egress proxy binding is invalid');
  if (!exactKeys(config.trustedWorkers, ['namespaceSelector', 'podSelector'])) fail('trusted worker binding is invalid');
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
  return Object.freeze({
    ...config,
    nodeSelector: labels(config.nodeSelector, 'nodeSelector'),
    stateClaimName: dns(config.stateClaimName, 'stateClaimName'),
    trustedWorkers: Object.freeze({
      namespaceSelector: labels(config.trustedWorkers.namespaceSelector, 'trustedWorkers.namespaceSelector'),
      podSelector: labels(config.trustedWorkers.podSelector, 'trustedWorkers.podSelector'),
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
    runAsGroup: 65532,
    runAsNonRoot: true,
    runAsUser: 65532,
    seccompProfile: { type: 'RuntimeDefault' },
  };
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
  if (role === 'broker') volumes.push({ name: 'state', persistentVolumeClaim: { claimName: config.stateClaimName } });
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
      { name: 'config', mountPath: '/etc/seori-auth/policy.json', subPath: 'policy.json', readOnly: true },
      { name: 'config', mountPath: '/etc/seori-auth/run-attestation.pub', subPath: 'run-attestation.pub', readOnly: true },
      { name: 'state', mountPath: '/var/lib/seori-auth' },
    );
  }
  return mounts;
}

function probe(role) {
  return {
    exec: {
      command: [
        '/opt/seori-auth/bin/seori-auth-native', 'launch', '--', '/usr/local/bin/node',
        '/opt/seori-auth/runtime/entrypoint.mjs', 'healthcheck',
        `--readiness-file=/run/seori-auth/${runtimeRole(role)}.ready`,
      ],
    },
    periodSeconds: 10,
    timeoutSeconds: 3,
    failureThreshold: 3,
  };
}

function workload(role, config) {
  const binding = config.roles[role];
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
    ],
    ports: [{ name: 'mtls', containerPort: port(role), protocol: 'TCP' }],
    readinessProbe: probe(role),
    livenessProbe: probe(role),
    startupProbe: { ...probe(role), failureThreshold: 30 },
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
        'seorilabs.io/secret-access-sha256': binding.secretAccessConfigSha256,
      },
    },
    spec: {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostIPC: false,
      hostNetwork: false,
      hostPID: false,
      nodeSelector: config.nodeSelector,
      securityContext: podSecurityContext(),
      serviceAccountName: serviceAccountName(role),
      terminationGracePeriodSeconds: 30,
      containers: [container],
      volumes: roleVolumes(role, binding, config),
    },
  };
  const common = {
    apiVersion: 'apps/v1',
    kind: role === 'broker' ? 'StatefulSet' : 'Deployment',
    metadata: {
      ...metadata(appName(role)),
      annotations: { 'seorilabs.io/deployable': 'true', 'seorilabs.io/image': config.image },
    },
    spec: {
      replicas: 1,
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
          }],
          ports: [{ protocol: 'TCP', port: 8443 }],
        }],
        egress: [dns, proxy, {
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
const config = validate(await load(argument.slice('--config='.length)));
process.stdout.write(`${JSON.stringify(render(config), null, 2)}\n`);
