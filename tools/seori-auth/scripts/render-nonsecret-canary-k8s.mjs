#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_CANARY_OUTPUT_SHA256,
  canonicalSha256,
  exactKeys,
  imagePullSecrets,
  validateImageProvenance,
  validateRegistry,
} from './public-image-binding.mjs';

export const CANARY_SERVICE_ACCOUNT_NAME = 'seori-auth-canary';

export class InvalidCanaryConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidCanaryConfigError';
    this.code = 'invalid_canary_config';
  }
}

function fail(message) {
  throw new InvalidCanaryConfigError(message);
}

export async function loadCanaryConfig(path) {
  if (!isAbsolute(path)) fail('config path must be absolute');
  let entry;
  let canonicalPath;
  try {
    [entry, canonicalPath] = await Promise.all([lstat(path), realpath(path)]);
  } catch {
    fail('config path is unavailable');
  }
  if (!entry.isFile() || entry.isSymbolicLink() || canonicalPath !== path) {
    fail('config path must be canonical and regular');
  }
  const bytes = await readFile(path);
  if (bytes.length === 0 || bytes.length > 64 * 1024) {
    bytes.fill(0);
    fail('config size is invalid');
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('config JSON is invalid');
  } finally {
    bytes.fill(0);
  }
}

function validateCanary(value) {
  if (!exactKeys(value, [
    'activeDeadlineSeconds', 'contractVersion', 'createPolicy', 'expectedOutputSha256',
    'idempotency', 'kind', 'kubernetesContext', 'nodeSelector', 'packagesReaderPullBinding',
    'publicPullBinding', 'serviceAccountName',
  ])) fail('canary contract fields are invalid');
  if (
    value.contractVersion !== 1 ||
    value.kind !== 'NON_SECRET_BUILTIN' ||
    value.kubernetesContext !== 'vzyx-cluster' ||
    value.serviceAccountName !== CANARY_SERVICE_ACCOUNT_NAME ||
    value.createPolicy !== 'SERVER_DRY_RUN_THEN_CREATE_IF_ABSENT' ||
    value.publicPullBinding !== 'NO_IMAGE_PULL_SECRETS' ||
    value.packagesReaderPullBinding !== 'EXACT_CANONICAL_ONE' ||
    value.activeDeadlineSeconds !== 300 ||
    value.expectedOutputSha256 !== EXPECTED_CANARY_OUTPUT_SHA256 ||
    !exactKeys(value.nodeSelector, ['kubernetes.io/hostname']) ||
    value.nodeSelector['kubernetes.io/hostname'] !== 'rpi5' ||
    !exactKeys(value.idempotency, [
      'existingPolicy', 'key', 'markerKind', 'unknownOutcomePolicy',
    ]) ||
    value.idempotency.markerKind !== 'Job' ||
    value.idempotency.key !== 'image-source-contract-sha256' ||
    value.idempotency.existingPolicy !== 'READBACK_ONLY' ||
    value.idempotency.unknownOutcomePolicy !== 'READBACK_FIRST'
  ) fail('canary contract is not the approved one-shot boundary');
  return Object.freeze({
    ...value,
    idempotency: Object.freeze({ ...value.idempotency }),
    nodeSelector: Object.freeze({ ...value.nodeSelector }),
  });
}

export function validateCanaryConfig(config) {
  if (!exactKeys(config, [
    'canary', 'image', 'imageProvenance', 'namespace', 'registry', 'schemaVersion',
  ]) || config.schemaVersion !== 1 || config.namespace !== 'auth-broker') {
    fail('top-level canary fields are invalid');
  }
  return Object.freeze({
    ...config,
    imageProvenance: validateImageProvenance(config.image, config.imageProvenance, fail),
    registry: validateRegistry(config.registry, fail),
    canary: validateCanary(config.canary),
  });
}

export function canaryOccurrence(config) {
  const idempotencyKey = canonicalSha256({
    canaryContractVersion: config.canary.contractVersion,
    image: config.image,
    imageProvenance: config.imageProvenance,
    registry: config.registry,
  });
  const suffix = idempotencyKey.slice(0, 16);
  return Object.freeze({
    idempotencyKey,
    jobName: `seori-auth-nonsecret-canary-${suffix}`,
    networkPolicyName: `seori-auth-canary-deny-${suffix}`,
    selector: Object.freeze({
      'app.kubernetes.io/name': 'seori-auth-nonsecret-canary',
      'seorilabs.io/canary-id': suffix,
    }),
  });
}

function annotations(config, occurrence) {
  return {
    'seorilabs.io/canary-contract-version': String(config.canary.contractVersion),
    'seorilabs.io/expected-output-sha256': config.canary.expectedOutputSha256,
    'seorilabs.io/idempotency-key': occurrence.idempotencyKey,
    'seorilabs.io/idempotency-policy': config.canary.idempotency.existingPolicy,
    'seorilabs.io/image-digest': config.imageProvenance.imageDigest,
    'seorilabs.io/image-source-sha': config.imageProvenance.sourceSha,
    'seorilabs.io/image-workflow-run': String(config.imageProvenance.runId),
    'seorilabs.io/registry-mode': config.registry.mode,
    'seorilabs.io/unknown-outcome-policy': config.canary.idempotency.unknownOutcomePolicy,
    ...(config.registry.mode === 'PACKAGES_READER'
      ? { 'seorilabs.io/registry-credential-id': config.registry.credentialId }
      : {}),
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

function containerSecurityContext() {
  return {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ['ALL'] },
    privileged: false,
    readOnlyRootFilesystem: true,
  };
}

export function renderCanaryManifest(config) {
  const occurrence = canaryOccurrence(config);
  const pullSecrets = imagePullSecrets(config.registry);
  const publicAnnotations = annotations(config, occurrence);
  const podSpec = {
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    hostIPC: false,
    hostNetwork: false,
    hostPID: false,
    ...(pullSecrets === undefined ? {} : { imagePullSecrets: pullSecrets }),
    nodeSelector: config.canary.nodeSelector,
    restartPolicy: 'Never',
    securityContext: podSecurityContext(),
    serviceAccountName: config.canary.serviceAccountName,
    terminationGracePeriodSeconds: 5,
    containers: [{
      name: 'canary',
      image: config.image,
      imagePullPolicy: 'Always',
      args: ['canary', '--native-helper=/opt/seori-auth/bin/seori-auth-native'],
      resources: {
        requests: { cpu: '25m', memory: '64Mi' },
        limits: { cpu: '250m', memory: '192Mi' },
      },
      securityContext: containerSecurityContext(),
      volumeMounts: [
        { name: 'runtime', mountPath: '/run/seori-auth' },
        { name: 'state', mountPath: '/var/lib/seori-auth' },
      ],
    }],
    volumes: [
      { name: 'runtime', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } },
      { name: 'state', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } },
    ],
  };
  return {
    apiVersion: 'v1',
    kind: 'List',
    items: [
      {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: {
          name: CANARY_SERVICE_ACCOUNT_NAME,
          namespace: config.namespace,
          labels: { 'app.kubernetes.io/name': 'seori-auth-nonsecret-canary' },
          annotations: { 'seorilabs.io/purpose': 'nonsecret-image-canary' },
        },
        automountServiceAccountToken: false,
        imagePullSecrets: [],
        secrets: [],
      },
      {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: {
          name: occurrence.networkPolicyName,
          namespace: config.namespace,
          labels: occurrence.selector,
          annotations: publicAnnotations,
        },
        spec: {
          podSelector: { matchLabels: occurrence.selector },
          policyTypes: ['Ingress', 'Egress'],
          ingress: [],
          egress: [],
        },
      },
      {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          name: occurrence.jobName,
          namespace: config.namespace,
          labels: occurrence.selector,
          annotations: publicAnnotations,
        },
        spec: {
          activeDeadlineSeconds: config.canary.activeDeadlineSeconds,
          backoffLimit: 0,
          completions: 1,
          parallelism: 1,
          podReplacementPolicy: 'Failed',
          template: {
            metadata: {
              labels: occurrence.selector,
              annotations: publicAnnotations,
            },
            spec: podSpec,
          },
        },
      },
    ],
  };
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  try {
    const argument = process.argv[2];
    if (process.argv.length !== 3 || !argument?.startsWith('--config=')) {
      fail('usage: render-nonsecret-canary-k8s.mjs --config=/absolute/path.json');
    }
    const config = validateCanaryConfig(
      await loadCanaryConfig(argument.slice('--config='.length)),
    );
    process.stdout.write(`${JSON.stringify(renderCanaryManifest(config), null, 2)}\n`);
  } catch (error) {
    const message = error instanceof InvalidCanaryConfigError
      ? error.message
      : 'canary config could not be loaded';
    process.stderr.write(`${JSON.stringify({
      valid: false,
      code: 'invalid_canary_config',
      message,
    })}\n`);
    process.exitCode = 1;
  }
}
