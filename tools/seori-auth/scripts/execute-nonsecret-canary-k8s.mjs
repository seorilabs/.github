#!/usr/bin/env node

import { constants as fsConstants, realpathSync } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { canonicalSha256, exactKeys } from './public-image-binding.mjs';
import {
  CANARY_SERVICE_ACCOUNT_NAME,
  InvalidCanaryConfigError,
  canaryOccurrence,
  loadCanaryConfig,
  renderCanaryManifest,
  validateCanaryConfig,
} from './render-nonsecret-canary-k8s.mjs';

const DEFAULT_KUBECTL = '/usr/local/bin/kubectl';
const VERIFIER = fileURLToPath(new URL('./verify-nonsecret-canary-output.mjs', import.meta.url));
const CHILD_TIMEOUT_MS = 15_000;
const MAX_KUBECTL_OUTPUT = 512 * 1024;
const SYSTEM_JOB_LABELS = new Set([
  'batch.kubernetes.io/controller-uid',
  'batch.kubernetes.io/job-name',
  'controller-uid',
  'job-name',
]);
const ALLOWED_JOB_SPEC_KEYS = new Set([
  'activeDeadlineSeconds',
  'backoffLimit',
  'completionMode',
  'completions',
  'manualSelector',
  'parallelism',
  'podReplacementPolicy',
  'selector',
  'suspend',
  'template',
]);
const ALLOWED_POD_SPEC_KEYS = new Set([
  'automountServiceAccountToken',
  'containers',
  'dnsPolicy',
  'enableServiceLinks',
  'hostIPC',
  'hostNetwork',
  'hostPID',
  'imagePullSecrets',
  'nodeName',
  'nodeSelector',
  'preemptionPolicy',
  'priority',
  'restartPolicy',
  'schedulerName',
  'securityContext',
  'serviceAccount',
  'serviceAccountName',
  'terminationGracePeriodSeconds',
  'tolerations',
  'volumes',
]);
const ALLOWED_CONTAINER_KEYS = new Set([
  'args',
  'image',
  'imagePullPolicy',
  'name',
  'resources',
  'securityContext',
  'terminationMessagePath',
  'terminationMessagePolicy',
  'volumeMounts',
]);
const ALLOWED_JOB_STATUS_KEYS = new Set([
  'active',
  'completedIndexes',
  'completionTime',
  'conditions',
  'failed',
  'failedIndexes',
  'ready',
  'startTime',
  'succeeded',
  'terminating',
  'uncountedTerminatedPods',
]);
const ALLOWED_JOB_CONDITION_KEYS = new Set([
  'lastProbeTime',
  'lastTransitionTime',
  'message',
  'reason',
  'status',
  'type',
]);
const DEFAULT_POD_TOLERATIONS = Object.freeze([
  Object.freeze({
    effect: 'NoExecute',
    key: 'node.kubernetes.io/not-ready',
    operator: 'Exists',
    tolerationSeconds: 300,
  }),
  Object.freeze({
    effect: 'NoExecute',
    key: 'node.kubernetes.io/unreachable',
    operator: 'Exists',
    tolerationSeconds: 300,
  }),
]);
const CREDENTIAL_ANNOTATION = /(?:credential|secret|image[-_.]?pull|registry[-_.]?auth|gcp-service-account|role-arn|client-id)/iu;

export class CanaryExecutionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CanaryExecutionError';
    this.code = code;
  }
}

function stop(code) {
  throw new CanaryExecutionError(code);
}

function same(left, right) {
  return canonicalSha256(left) === canonicalSha256(right);
}

function publicMetadata(resource) {
  return {
    name: resource?.metadata?.name,
    namespace: resource?.metadata?.namespace,
    labels: resource?.metadata?.labels ?? {},
    annotations: resource?.metadata?.annotations ?? {},
  };
}

function assertBaseIdentity(actual, expected, code, { live = true } = {}) {
  if (
    actual?.apiVersion !== expected.apiVersion ||
    actual?.kind !== expected.kind ||
    publicMetadata(actual).name !== expected.metadata.name ||
    publicMetadata(actual).namespace !== expected.metadata.namespace ||
    (live && (
      typeof actual.metadata.uid !== 'string' ||
      actual.metadata.uid.length === 0 ||
      typeof actual.metadata.resourceVersion !== 'string' ||
      actual.metadata.resourceVersion.length === 0 ||
      actual.metadata.deletionTimestamp !== undefined ||
      (actual.metadata.ownerReferences ?? []).length !== 0
    ))
  ) stop(code);
}

function assertExactMetadata(actual, expected, code, options = {}) {
  const actualMetadata = publicMetadata(actual);
  const expectedMetadata = publicMetadata(expected);
  if (!same(actualMetadata.annotations, expectedMetadata.annotations)) stop(code);
  const allowedExtraLabels = options.allowedExtraLabels ?? new Set();
  for (const [key, value] of Object.entries(expectedMetadata.labels)) {
    if (actualMetadata.labels[key] !== value) stop(code);
  }
  for (const key of Object.keys(actualMetadata.labels)) {
    if (!(key in expectedMetadata.labels) && !allowedExtraLabels.has(key)) stop(code);
  }
}

function assertServiceAccount(actual, expected, options) {
  const code = 'CANARY_SERVICE_ACCOUNT_DRIFT';
  assertBaseIdentity(actual, expected, code, options);
  assertExactMetadata(actual, expected, code);
  if (
    actual.automountServiceAccountToken !== false ||
    (actual.imagePullSecrets ?? []).length !== 0 ||
    (actual.secrets ?? []).length !== 0
  ) stop(code);
}

function assertNetworkPolicy(actual, expected, options) {
  const code = 'CANARY_NETWORK_POLICY_DRIFT';
  assertBaseIdentity(actual, expected, code, options);
  assertExactMetadata(actual, expected, code);
  assertAllowedKeys(actual.spec, new Set(['egress', 'ingress', 'podSelector', 'policyTypes']), code);
  const normalized = {
    ...actual.spec,
    ingress: actual.spec.ingress ?? [],
    egress: actual.spec.egress ?? [],
  };
  if (!same(normalized, expected.spec)) stop(code);
}

function assertAllowedKeys(value, allowed, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) stop(code);
  if (Object.keys(value).some((key) => !allowed.has(key))) stop(code);
}

function normalizedPullSecrets(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) stop('CANARY_POD_SPEC_DRIFT');
  return value.map((entry) => ({ name: entry?.name }));
}

function normalizedTolerations(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) stop('CANARY_POD_SPEC_DRIFT');
  return value
    .map((entry) => ({ ...entry }))
    .toSorted(({ key: left = '' }, { key: right = '' }) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
}

function assertPodSpec(actual, expected, registryMode) {
  const code = 'CANARY_POD_SPEC_DRIFT';
  assertAllowedKeys(actual, ALLOWED_POD_SPEC_KEYS, code);
  if (
    actual.automountServiceAccountToken !== false ||
    actual.enableServiceLinks !== false ||
    (actual.hostIPC ?? false) !== false ||
    (actual.hostNetwork ?? false) !== false ||
    (actual.hostPID ?? false) !== false ||
    actual.restartPolicy !== 'Never' ||
    actual.serviceAccountName !== CANARY_SERVICE_ACCOUNT_NAME ||
    (actual.serviceAccount !== undefined && actual.serviceAccount !== CANARY_SERVICE_ACCOUNT_NAME) ||
    actual.terminationGracePeriodSeconds !== 5 ||
    (actual.dnsPolicy !== undefined && actual.dnsPolicy !== 'ClusterFirst') ||
    (actual.schedulerName !== undefined && actual.schedulerName !== 'default-scheduler') ||
    (actual.nodeName !== undefined &&
      actual.nodeName !== expected.nodeSelector['kubernetes.io/hostname']) ||
    (actual.preemptionPolicy !== undefined &&
      actual.preemptionPolicy !== 'PreemptLowerPriority') ||
    (actual.priority !== undefined && actual.priority !== 0) ||
    (actual.tolerations !== undefined &&
      !same(normalizedTolerations(actual.tolerations), DEFAULT_POD_TOLERATIONS)) ||
    !same(actual.nodeSelector, expected.nodeSelector) ||
    !same(actual.securityContext, expected.securityContext) ||
    !same(actual.volumes, expected.volumes)
  ) stop(code);

  const actualPullSecrets = normalizedPullSecrets(actual.imagePullSecrets);
  const expectedPullSecrets = normalizedPullSecrets(expected.imagePullSecrets);
  if (!same(actualPullSecrets, expectedPullSecrets)) stop('CANARY_IMAGE_PULL_BINDING_DRIFT');
  if (registryMode === 'PUBLIC' && actualPullSecrets.length !== 0) {
    stop('CANARY_PUBLIC_PULL_CREDENTIAL_INJECTED');
  }
  if (
    registryMode === 'PACKAGES_READER' &&
    !same(actualPullSecrets, [{ name: 'seori-auth-ghcr-pull' }])
  ) stop('CANARY_PACKAGES_READER_BINDING_DRIFT');

  if (!Array.isArray(actual.containers) || actual.containers.length !== 1) stop(code);
  const [container] = actual.containers;
  const [expectedContainer] = expected.containers;
  assertAllowedKeys(container, ALLOWED_CONTAINER_KEYS, code);
  if (
    container.name !== expectedContainer.name ||
    container.image !== expectedContainer.image ||
    container.imagePullPolicy !== expectedContainer.imagePullPolicy ||
    !same(container.args, expectedContainer.args) ||
    !same(container.resources, expectedContainer.resources) ||
    !same(container.securityContext, expectedContainer.securityContext) ||
    !same(container.volumeMounts, expectedContainer.volumeMounts) ||
    (container.terminationMessagePath !== undefined &&
      container.terminationMessagePath !== '/dev/termination-log') ||
    (container.terminationMessagePolicy !== undefined &&
      container.terminationMessagePolicy !== 'File')
  ) stop(code);
}

function assertTemplateMetadata(actual, expected, registryMode) {
  const code = 'CANARY_POD_METADATA_DRIFT';
  const actualAnnotations = actual?.annotations ?? {};
  const expectedAnnotations = expected?.annotations ?? {};
  for (const [key, value] of Object.entries(expectedAnnotations)) {
    if (actualAnnotations[key] !== value) stop(code);
  }
  for (const [key] of Object.entries(actualAnnotations)) {
    if (key.startsWith('seorilabs.io/') && !(key in expectedAnnotations)) stop(code);
    if (!(key in expectedAnnotations) && CREDENTIAL_ANNOTATION.test(key)) {
      stop('CANARY_CREDENTIAL_ANNOTATION_INJECTED');
    }
  }
  if (
    registryMode === 'PUBLIC' &&
    'seorilabs.io/registry-credential-id' in actualAnnotations
  ) stop('CANARY_PUBLIC_PULL_CREDENTIAL_INJECTED');
  for (const [key, value] of Object.entries(expected?.labels ?? {})) {
    if (actual?.labels?.[key] !== value) stop(code);
  }
  for (const key of Object.keys(actual?.labels ?? {})) {
    if (!(key in (expected?.labels ?? {})) && !SYSTEM_JOB_LABELS.has(key)) stop(code);
  }
}

function assertJob(actual, expected, config, options) {
  const code = 'CANARY_JOB_DRIFT';
  assertBaseIdentity(actual, expected, code, options);
  assertExactMetadata(actual, expected, code);
  assertAllowedKeys(actual.spec, ALLOWED_JOB_SPEC_KEYS, code);
  if (
    actual.spec.activeDeadlineSeconds !== expected.spec.activeDeadlineSeconds ||
    actual.spec.backoffLimit !== 0 ||
    actual.spec.completions !== 1 ||
    actual.spec.parallelism !== 1 ||
    actual.spec.podReplacementPolicy !== 'Failed' ||
    (actual.spec.completionMode !== undefined && actual.spec.completionMode !== 'NonIndexed') ||
    (actual.spec.manualSelector !== undefined && actual.spec.manualSelector !== false) ||
    (actual.spec.suspend !== undefined && actual.spec.suspend !== false)
  ) stop(code);
  assertTemplateMetadata(
    actual.spec.template?.metadata,
    expected.spec.template.metadata,
    config.registry.mode,
  );
  const uid = actual.metadata.uid;
  const name = actual.metadata.name;
  if (
    typeof uid !== 'string' || uid.length === 0 ||
    !same(actual.spec.selector, {
      matchLabels: { 'batch.kubernetes.io/controller-uid': uid },
    }) ||
    actual.spec.template.metadata.labels['batch.kubernetes.io/controller-uid'] !== uid ||
    actual.spec.template.metadata.labels['controller-uid'] !== uid ||
    actual.spec.template.metadata.labels['batch.kubernetes.io/job-name'] !== name ||
    actual.spec.template.metadata.labels['job-name'] !== name
  ) stop(code);
  assertPodSpec(actual.spec.template?.spec, expected.spec.template.spec, config.registry.mode);
}

function assertPod(actual, expectedJob, job, config) {
  const code = 'CANARY_POD_IDENTITY_DRIFT';
  if (
    actual?.apiVersion !== 'v1' ||
    actual?.kind !== 'Pod' ||
    actual?.metadata?.namespace !== config.namespace ||
    typeof actual?.metadata?.uid !== 'string' ||
    actual.metadata.uid.length === 0
  ) stop(code);
  const owners = actual.metadata.ownerReferences ?? [];
  if (
    owners.length !== 1 ||
    owners[0].apiVersion !== 'batch/v1' ||
    owners[0].kind !== 'Job' ||
    owners[0].name !== job.metadata.name ||
    owners[0].uid !== job.metadata.uid ||
    owners[0].controller !== true
  ) stop(code);
  if (
    actual.metadata.labels?.['batch.kubernetes.io/controller-uid'] !== job.metadata.uid ||
    actual.metadata.labels?.['controller-uid'] !== job.metadata.uid ||
    actual.metadata.labels?.['batch.kubernetes.io/job-name'] !== job.metadata.name ||
    actual.metadata.labels?.['job-name'] !== job.metadata.name
  ) stop(code);
  assertTemplateMetadata(
    actual.metadata,
    expectedJob.spec.template.metadata,
    config.registry.mode,
  );
  assertPodSpec(actual.spec, expectedJob.spec.template.spec, config.registry.mode);
}

function jobState(job) {
  const status = job.status ?? {};
  assertAllowedKeys(status, ALLOWED_JOB_STATUS_KEYS, 'CANARY_JOB_STATUS_INVALID');
  for (const field of ['active', 'failed', 'ready', 'succeeded', 'terminating']) {
    if (status[field] !== undefined &&
      (!Number.isSafeInteger(status[field]) || status[field] < 0)) {
      stop('CANARY_JOB_STATUS_INVALID');
    }
  }
  if (['active', 'failed', 'ready', 'succeeded', 'terminating'].some(
    (field) => (status[field] ?? 0) > 1,
  )) stop('CANARY_JOB_STATUS_INVALID');
  if (Array.isArray(status.conditions) === false && status.conditions !== undefined) {
    stop('CANARY_JOB_STATUS_INVALID');
  }
  for (const condition of status.conditions ?? []) {
    assertAllowedKeys(condition, ALLOWED_JOB_CONDITION_KEYS, 'CANARY_JOB_STATUS_INVALID');
    if (
      !['Complete', 'Failed', 'FailureTarget', 'SuccessCriteriaMet', 'Suspended']
        .includes(condition.type) ||
      !['False', 'True', 'Unknown'].includes(condition.status)
    ) stop('CANARY_JOB_STATUS_INVALID');
  }
  if (
    (status.completedIndexes !== undefined && status.completedIndexes !== '') ||
    (status.failedIndexes !== undefined && status.failedIndexes !== '') ||
    Object.values(status.uncountedTerminatedPods ?? {}).some(
      (value) => Array.isArray(value) && value.length > 0,
    )
  ) stop('CANARY_RESULT_UNKNOWN');
  const trueConditions = new Set(
    (status.conditions ?? [])
      .filter((condition) => condition?.status === 'True')
      .map((condition) => condition.type),
  );
  const complete = trueConditions.has('Complete');
  const failed = trueConditions.has('Failed') || trueConditions.has('FailureTarget');
  if (complete && failed) stop('CANARY_JOB_STATUS_INVALID');
  if (complete) {
    if (status.succeeded !== 1 || (status.active ?? 0) !== 0 || (status.failed ?? 0) !== 0) {
      stop('CANARY_JOB_STATUS_INVALID');
    }
    return 'SUCCEEDED';
  }
  if (failed || (status.failed ?? 0) > 0) return 'FAILED';
  if ((status.succeeded ?? 0) > 0) stop('CANARY_RESULT_UNKNOWN');
  return 'PENDING';
}

function assertSuccessfulPodStatus(pod, config) {
  const statuses = pod.status?.containerStatuses;
  if (!Array.isArray(statuses) || statuses.length !== 1) stop('CANARY_POD_STATUS_INVALID');
  const [status] = statuses;
  const terminated = status.state?.terminated;
  if (
    status.name !== 'canary' ||
    terminated?.exitCode !== 0 ||
    typeof status.imageID !== 'string' ||
    !status.imageID.endsWith(`@${config.imageProvenance.imageDigest}`)
  ) stop('CANARY_POD_STATUS_INVALID');
}

function expectedResources(config) {
  const manifest = renderCanaryManifest(config);
  const serviceAccount = manifest.items.find(({ kind }) => kind === 'ServiceAccount');
  const networkPolicy = manifest.items.find(({ kind }) => kind === 'NetworkPolicy');
  const job = manifest.items.find(({ kind }) => kind === 'Job');
  if (!serviceAccount || !networkPolicy || !job || manifest.items.length !== 3) {
    stop('CANARY_RENDER_INVALID');
  }
  return { serviceAccount, networkPolicy, job };
}

async function createOnce(adapter, expected, assertResource) {
  let dryRun;
  try {
    dryRun = await adapter.serverDryRun(expected);
  } catch {
    stop('CANARY_SERVER_DRY_RUN_FAILED');
  }
  assertResource(dryRun, expected, { live: false });
  let source = 'CREATED';
  try {
    await adapter.create(expected);
  } catch {
    // Any create error can be an AlreadyExists or an unknown committed result.
    // Never retry: exact readback below is the only allowed recovery path.
    source = 'READBACK_FIRST';
  }
  const live = await adapter.get(expected.kind, expected.metadata.name, expected.metadata.namespace);
  if (!live) stop('CANARY_CREATE_RESULT_UNKNOWN');
  assertResource(live, expected, { live: true });
  return { resource: live, source };
}

async function readResult(adapter, expectedJob, job, config, source) {
  const state = jobState(job);
  const occurrence = canaryOccurrence(config);
  const pods = await adapter.listPods(config.namespace, occurrence.selector);
  if (!Array.isArray(pods) || pods.length > 1) stop('CANARY_POD_COUNT_INVALID');
  if (pods.length === 1) assertPod(pods[0], expectedJob, job, config);
  if (state === 'FAILED') stop('CANARY_JOB_FAILED');
  if (state === 'SUCCEEDED') {
    if (pods.length !== 1) stop('CANARY_RESULT_UNKNOWN');
    assertSuccessfulPodStatus(pods[0], config);
    const verified = await adapter.verifyCanaryLog(
      config.namespace,
      pods[0].metadata.name,
      'canary',
    );
    if (!exactKeys(verified, ['sha256', 'state']) ||
      verified.state !== 'CANARY_OUTPUT_VERIFIED' ||
      verified.sha256 !== config.canary.expectedOutputSha256) {
      stop('CANARY_OUTPUT_NOT_VERIFIED');
    }
    return Object.freeze({
      state: verified.state,
      source,
      jobName: job.metadata.name,
      idempotencyKey: occurrence.idempotencyKey,
      imageDigest: config.imageProvenance.imageDigest,
      outputSha256: verified.sha256,
    });
  }
  return Object.freeze({
    state: 'CANARY_PENDING',
    source,
    jobName: job.metadata.name,
    idempotencyKey: occurrence.idempotencyKey,
    imageDigest: config.imageProvenance.imageDigest,
  });
}

export async function executeNonsecretCanary(config, adapter) {
  config = validateCanaryConfig(config);
  if (await adapter.currentContext() !== config.canary.kubernetesContext) {
    stop('CANARY_KUBE_CONTEXT_INVALID');
  }
  const expected = expectedResources(config);
  let [serviceAccount, networkPolicy, job] = await Promise.all([
    adapter.get('ServiceAccount', expected.serviceAccount.metadata.name, config.namespace),
    adapter.get('NetworkPolicy', expected.networkPolicy.metadata.name, config.namespace),
    adapter.get('Job', expected.job.metadata.name, config.namespace),
  ]);

  if (serviceAccount) {
    assertServiceAccount(serviceAccount, expected.serviceAccount, { live: true });
  }
  if (networkPolicy) {
    assertNetworkPolicy(networkPolicy, expected.networkPolicy, { live: true });
  }

  if (job) {
    if (!serviceAccount || !networkPolicy) stop('CANARY_SUPPORT_STATE_MISSING');
    assertJob(job, expected.job, config, { live: true });
    return readResult(adapter, expected.job, job, config, 'READBACK_ONLY');
  }

  if (!serviceAccount) {
    serviceAccount = (await createOnce(
      adapter,
      expected.serviceAccount,
      assertServiceAccount,
    )).resource;
  }
  if (!networkPolicy) {
    networkPolicy = (await createOnce(
      adapter,
      expected.networkPolicy,
      assertNetworkPolicy,
    )).resource;
  }

  const jobCreation = await createOnce(
    adapter,
    expected.job,
    (actual, wanted, options) => assertJob(actual, wanted, config, options),
  );
  job = jobCreation.resource;
  return readResult(adapter, expected.job, job, config, jobCreation.source);
}

function minimalChildEnv() {
  const env = {
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  };
  for (const name of ['HOME', 'KUBECONFIG', 'SSL_CERT_DIR', 'SSL_CERT_FILE']) {
    if (typeof process.env[name] === 'string' && process.env[name].length > 0) {
      env[name] = process.env[name];
    }
  }
  return env;
}

function runCaptured(executable, args, {
  environment = minimalChildEnv(),
  input,
  maxOutput = MAX_KUBECTL_OUTPUT,
} = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      env: environment,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let overflow = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CHILD_TIMEOUT_MS);
    const collect = (chunks, stream, sizeName) => {
      stream.on('data', (chunk) => {
        const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (sizeName === 'stdout') stdoutSize += next.length;
        else stderrSize += next.length;
        if ((sizeName === 'stdout' ? stdoutSize : stderrSize) > maxOutput) {
          overflow = true;
          next.fill(0);
          child.kill('SIGKILL');
          return;
        }
        chunks.push(next);
      });
    };
    collect(stdout, child.stdout, 'stdout');
    collect(stderr, child.stderr, 'stderr');
    child.once('error', () => {
      clearTimeout(timer);
      reject(new CanaryExecutionError('CANARY_KUBECTL_EXEC_FAILED'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      for (const chunk of [...stdout, ...stderr]) chunk.fill(0);
      resolvePromise({
        code,
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        failed: overflow || timedOut,
      });
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

function parsedJson(result, code) {
  try {
    if (result.failed || result.code !== 0 || result.stdout.length === 0) stop(code);
    return JSON.parse(result.stdout.toString('utf8'));
  } catch (error) {
    if (error instanceof CanaryExecutionError) throw error;
    stop(code);
  } finally {
    result.stdout.fill(0);
    result.stderr.fill(0);
  }
}

async function resolveKubectlPath() {
  const configured = process.env.SEORILABS_KUBECTL ?? DEFAULT_KUBECTL;
  if (!isAbsolute(configured)) stop('CANARY_KUBECTL_PATH_INVALID');
  let entry;
  let canonical;
  try {
    [entry, canonical] = await Promise.all([lstat(configured), realpath(configured)]);
    await access(configured, fsConstants.X_OK);
  } catch {
    stop('CANARY_KUBECTL_PATH_INVALID');
  }
  if (!entry.isFile() || entry.isSymbolicLink() || canonical !== configured) {
    stop('CANARY_KUBECTL_PATH_INVALID');
  }
  return configured;
}

export class KubectlCanaryAdapter {
  constructor(executable) {
    this.executable = executable;
  }

  static async create() {
    return new KubectlCanaryAdapter(await resolveKubectlPath());
  }

  async currentContext() {
    const result = await runCaptured(this.executable, ['config', 'current-context'], {
      maxOutput: 4 * 1024,
    });
    try {
      if (result.failed || result.code !== 0) stop('CANARY_KUBE_CONTEXT_INVALID');
      return result.stdout.toString('utf8').trim();
    } finally {
      result.stdout.fill(0);
      result.stderr.fill(0);
    }
  }

  async get(kind, name, namespace) {
    const result = await runCaptured(this.executable, [
      'get', kind, name, '--namespace', namespace, '--output=json', '--ignore-not-found=true',
    ]);
    try {
      if (result.failed || result.code !== 0) stop('CANARY_READBACK_FAILED');
      if (result.stdout.length === 0) return null;
      return JSON.parse(result.stdout.toString('utf8'));
    } catch (error) {
      if (error instanceof CanaryExecutionError) throw error;
      stop('CANARY_READBACK_FAILED');
    } finally {
      result.stdout.fill(0);
      result.stderr.fill(0);
    }
  }

  async serverDryRun(resource) {
    const result = await runCaptured(
      this.executable,
      ['create', '--dry-run=server', '--filename=-', '--output=json'],
      { input: `${JSON.stringify(resource)}\n` },
    );
    return parsedJson(result, 'CANARY_SERVER_DRY_RUN_FAILED');
  }

  async create(resource) {
    const result = await runCaptured(
      this.executable,
      ['create', '--filename=-', '--output=json'],
      { input: `${JSON.stringify(resource)}\n` },
    );
    return parsedJson(result, 'CANARY_CREATE_FAILED');
  }

  async listPods(namespace, selector) {
    const labelSelector = Object.entries(selector)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    const result = await runCaptured(this.executable, [
      'get', 'Pod', '--namespace', namespace, '--selector', labelSelector, '--output=json',
    ]);
    const list = parsedJson(result, 'CANARY_POD_READBACK_FAILED');
    if (list?.apiVersion !== 'v1' || list?.kind !== 'List' || !Array.isArray(list.items)) {
      stop('CANARY_POD_READBACK_FAILED');
    }
    return list.items;
  }

  async verifyCanaryLog(namespace, podName, containerName) {
    const log = await runCaptured(this.executable, [
      'logs', `Pod/${podName}`, '--namespace', namespace, '--container', containerName,
    ], { maxOutput: 128 });
    try {
      if (log.failed || log.code !== 0) stop('CANARY_LOG_READBACK_FAILED');
      const verified = await runCaptured(
        process.execPath,
        [VERIFIER],
        {
          environment: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NODE_ENV: 'production' },
          input: log.stdout,
          maxOutput: 4 * 1024,
        },
      );
      return parsedJson(verified, 'CANARY_OUTPUT_NOT_VERIFIED');
    } finally {
      log.stdout.fill(0);
      log.stderr.fill(0);
    }
  }
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
      stop('CANARY_EXECUTOR_USAGE_INVALID');
    }
    const config = validateCanaryConfig(
      await loadCanaryConfig(argument.slice('--config='.length)),
    );
    const result = await executeNonsecretCanary(config, await KubectlCanaryAdapter.create());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof InvalidCanaryConfigError
      ? error.code
      : error instanceof CanaryExecutionError
        ? error.code
        : 'CANARY_EXECUTION_FAILED';
    process.stderr.write(`${JSON.stringify({ valid: false, code })}\n`);
    process.exitCode = 1;
  }
}
