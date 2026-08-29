#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const KUBECTL = '/usr/local/bin/kubectl';
const RENDERER = fileURLToPath(new URL('../../../scripts/fleet/render-p3-runtime.mjs', import.meta.url));
const CREDENTIAL_ANNOTATION = /(?:credential|secret|image[-_.]?pull|registry[-_.]?auth|gcp-service-account|role-arn|client-id)/iu;
const RESOURCE_NAMES = Object.freeze({
  Namespace: 'namespace',
  ConfigMap: 'configmap',
  Issuer: 'issuer',
  Certificate: 'certificate',
  ServiceAccount: 'serviceaccount',
  Service: 'service',
  Role: 'role',
  RoleBinding: 'rolebinding',
  NetworkPolicy: 'networkpolicy',
});

export class FoundationReadinessError extends Error {
  constructor(code) {
    super(code);
    this.name = 'FoundationReadinessError';
    this.code = code;
  }
}

function stop(code) {
  throw new FoundationReadinessError(code);
}

function childJson(executable, args, { allowEmpty = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: process.env.HOME,
        KUBECONFIG: process.env.KUBECONFIG,
        PATH: process.env.PATH,
      },
    });
    const stdout = [];
    let bytes = 0;
    let stderrBytes = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) child.kill('SIGKILL');
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) child.kill('SIGKILL');
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new FoundationReadinessError('READBACK_CHILD_FAILED'));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal !== null || bytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES) {
        reject(new FoundationReadinessError('READBACK_CHILD_FAILED'));
        return;
      }
      const text = Buffer.concat(stdout).toString('utf8').trim();
      if (allowEmpty && text === '') {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new FoundationReadinessError('READBACK_JSON_INVALID'));
      }
    });
  });
}

function kubectlReader(context) {
  const base = ['--context', context, 'get'];
  return Object.freeze({
    get: (kind, name, namespace) => childJson(KUBECTL, [
      ...base,
      RESOURCE_NAMES[kind],
      name,
      ...(namespace ? ['--namespace', namespace] : []),
      '--output=json',
      '--ignore-not-found=true',
    ], { allowEmpty: true }),
    list: (resources, namespace) => childJson(KUBECTL, [
      ...base,
      resources.join(','),
      '--namespace', namespace,
      '--output=json',
    ]),
  });
}

function containsExpected(actual, expected) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length &&
      expected.every((value, index) => containsExpected(actual[index], value));
  }
  if (expected && typeof expected === 'object') {
    return actual && typeof actual === 'object' && !Array.isArray(actual) &&
      Object.entries(expected).every(([key, value]) => containsExpected(actual[key], value));
  }
  return isDeepStrictEqual(actual, expected);
}

function metadataMatches(actual, expected, kind) {
  if (
    actual?.name !== expected.name || actual?.namespace !== expected.namespace ||
    typeof actual.uid !== 'string' || actual.uid.length === 0 ||
    typeof actual.resourceVersion !== 'string' || actual.resourceVersion.length === 0 ||
    actual.deletionTimestamp !== undefined
  ) return false;
  const labels = actual.labels ?? {};
  const annotations = actual.annotations ?? {};
  if (!containsExpected(labels, expected.labels ?? {}) || !containsExpected(annotations, expected.annotations ?? {})) {
    return false;
  }
  for (const key of Object.keys(annotations)) {
    if (!(key in (expected.annotations ?? {})) && CREDENTIAL_ANNOTATION.test(key)) return false;
  }
  if (kind === 'Namespace') {
    const allowed = new Set([...Object.keys(expected.labels ?? {}), 'kubernetes.io/metadata.name']);
    if (Object.keys(labels).some((key) => !allowed.has(key))) return false;
  }
  return true;
}

function readyCondition(resource) {
  return resource?.status?.conditions?.some(({ type, status }) => type === 'Ready' && status === 'True') === true;
}

function resourceMatches(actual, expected) {
  if (
    actual?.apiVersion !== expected.apiVersion || actual?.kind !== expected.kind ||
    !metadataMatches(actual.metadata ?? {}, expected.metadata ?? {}, expected.kind)
  ) return false;
  for (const [key, value] of Object.entries(expected)) {
    if (['apiVersion', 'kind', 'metadata'].includes(key)) continue;
    const actualValue = expected.kind === 'Role' && key === 'rules' && actual[key] == null
      ? []
      : actual[key];
    if (!containsExpected(actualValue, value)) return false;
  }
  if (expected.kind === 'ServiceAccount') {
    if (
      actual.automountServiceAccountToken !== false ||
      (actual.imagePullSecrets ?? []).length !== 0 ||
      (actual.secrets ?? []).length !== 0
    ) return false;
  }
  if (['Certificate', 'Issuer'].includes(expected.kind) && !readyCondition(actual)) return false;
  return true;
}

function publicBinding(desired) {
  const configMap = desired.items.find(({ kind }) => kind === 'ConfigMap');
  try {
    return JSON.parse(configMap.data['bindings.json']);
  } catch {
    stop('CURRENT_CONTRACT_BINDING_INVALID');
  }
}

function contractDiagnostics(desired) {
  const binding = publicBinding(desired);
  const diagnostics = [];
  if (
    binding.registry?.catalogStatus !== 'ready' ||
    binding.registry?.kubernetesStatus !== 'ready'
  ) diagnostics.push({ code: 'REGISTRY_GATE_BLOCKED' });
  if (
    binding.secretManager?.state !== 'ready' ||
    binding.secretManager?.provisioning?.state !== 'ready'
  ) diagnostics.push({ code: 'SECRET_MANAGER_GATE_BLOCKED' });
  if (binding.state?.encryptionStatus !== 'ready') diagnostics.push({ code: 'STATE_ENCRYPTION_GATE_BLOCKED' });
  return diagnostics;
}

function listItems(value) {
  if (!value || value.kind !== 'List' || !Array.isArray(value.items)) stop('READBACK_LIST_INVALID');
  return value.items;
}

export async function auditFoundationReadiness({ desired, reader, context }) {
  if (
    !desired || desired.kind !== 'List' || !Array.isArray(desired.items) ||
    desired.items.length === 0 || typeof context !== 'string' || context.length === 0 ||
    !reader || typeof reader.get !== 'function' || typeof reader.list !== 'function'
  ) stop('READINESS_INPUT_INVALID');
  const namespace = publicBinding(desired).namespace;
  const diagnostics = contractDiagnostics(desired);
  for (const expected of desired.items) {
    const resourceName = RESOURCE_NAMES[expected.kind];
    if (!resourceName) stop('CURRENT_CONTRACT_KIND_UNSUPPORTED');
    const actual = await reader.get(
      expected.kind,
      expected.metadata.name,
      expected.kind === 'Namespace' ? undefined : namespace,
    );
    if (!actual) {
      diagnostics.push({ code: 'FOUNDATION_RESOURCE_MISSING', kind: expected.kind, name: expected.metadata.name });
    } else if (!resourceMatches(actual, expected)) {
      diagnostics.push({ code: 'FOUNDATION_RESOURCE_DRIFT', kind: expected.kind, name: expected.metadata.name });
    }
  }

  const expectedConfigMap = desired.items.find(({ kind }) => kind === 'ConfigMap').metadata.name;
  const configMaps = listItems(await reader.list(['configmaps'], namespace));
  for (const item of configMaps) {
    if (
      (item?.metadata?.name === 'auth-broker-public-bindings' ||
        item?.metadata?.name?.startsWith('auth-broker-public-bindings-')) &&
      item.metadata.name !== expectedConfigMap
    ) diagnostics.push({ code: 'STALE_PUBLIC_BINDING_PRESENT', kind: 'ConfigMap', name: item.metadata.name });
  }
  const runtime = listItems(await reader.list(
    ['deployments', 'statefulsets', 'daemonsets', 'jobs', 'pods', 'persistentvolumeclaims'],
    namespace,
  ));
  for (const item of runtime) {
    diagnostics.push({
      code: 'UNDECLARED_RUNTIME_RESOURCE_PRESENT',
      kind: item?.kind ?? 'Unknown',
      name: item?.metadata?.name ?? 'unknown',
    });
  }
  diagnostics.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return Object.freeze({
    state: diagnostics.length === 0 ? 'READY' : 'BLOCKED',
    context,
    namespace,
    diagnostics,
  });
}

async function main() {
  if (process.argv.length !== 2) stop('READINESS_ARGUMENTS_INVALID');
  const desired = await childJson(process.execPath, [RENDERER, 'auth-broker-foundation']);
  const binding = publicBinding(desired);
  const context = binding.canary?.kubernetesContext;
  if (typeof context !== 'string' || context.length === 0) stop('CURRENT_CONTRACT_CONTEXT_INVALID');
  const result = await auditFoundationReadiness({ desired, reader: kubectlReader(context), context });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.state !== 'READY') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ state: 'FAILED', code: error?.code ?? 'READINESS_AUDIT_FAILED' })}\n`);
    process.exitCode = 1;
  });
}
