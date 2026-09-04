import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { constants as fsConstants } from 'node:fs';
import { chmod, chown, lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { fail, SeoriAuthError } from './errors.mjs';

const REQUEST_LIMIT = 6 * 1024 * 1024;
const RESPONSE_LIMIT = 512 * 1024;
const MAX_CONNECTIONS = 4;
const MAX_IN_FLIGHT = 2;
const MACOS_UNIX_SOCKET_PATH_MAX_BYTES = 104;
const MACOS_ID_MAX = 2_147_483_647;
const MACOS_CANONICAL_FILE_PATH_MAX_BYTES = 1_023;
const MACOS_FILE_NAME_MAX_BYTES = 255;
const MACOS_CANONICAL_FILE_PATH = /^\/(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$))[\x20-\x2e\x30-\x7e]{1,255}(?:\/[\x20-\x2e\x30-\x7e]{1,255})*$/u;
const MACOS_UNIX_SOCKET_PATH = /^\/(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const UPSTREAM_TOTAL_TIMEOUT_MS = 30_000;
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const PUBLIC_CONTRACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,190}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const OPERATIONS = new Set([
  'CLAIM',
  'HEARTBEAT',
  'COMPLETE',
  'FAIL',
  'READBACK_REQUIRED',
  'READBACK_RESOLVE',
  'GITHUB_READY_PR',
  'GITHUB_READY_PR_READBACK',
]);
const OUTCOME_CODES = new Set([
  'NO_CHANGES',
  'PR_READY',
  'ISSUE_RESOLVED',
  'READBACK_CONFIRMED',
  'READBACK_PARTIAL_VERIFIED',
  'RESULT_UNKNOWN',
  'BLOCKED',
]);
const ACTION_CAPABILITIES = new Set([
  'github.issue.read',
  'github.pull_request.read',
  'provider.readback',
  'github.branch.write',
  'github.commit.write',
  'github.pull_request.create',
]);
const REQUIRED_CHECKS = new Set(['test:core', 'check:architecture', 'check:release', 'repo-contract']);
const WORKER_KINDS = new Set(['CODEX', 'CLAUDE']);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort((left, right) => left.localeCompare(right)).map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function exactObject(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function closedObject(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function validInteger(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validString(value, { pattern, minimum = 1, maximum = 2_048 } = {}) {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) &&
    (!pattern || pattern.test(value));
}

export function validMacOsUnixSocketPath(value) {
  return typeof value === 'string' && MACOS_UNIX_SOCKET_PATH.test(value) &&
    Buffer.byteLength(value, 'utf8') <= MACOS_UNIX_SOCKET_PATH_MAX_BYTES;
}

export function validMacOsId(value, { allowRoot = false } = {}) {
  return Number.isSafeInteger(value) && value >= (allowRoot ? 0 : 1) && value <= MACOS_ID_MAX;
}

export function validMacOsCanonicalFilePath(value) {
  return typeof value === 'string' && MACOS_CANONICAL_FILE_PATH.test(value) &&
    Buffer.byteLength(value, 'utf8') <= MACOS_CANONICAL_FILE_PATH_MAX_BYTES &&
    value.slice(1).split('/').every((component) =>
      Buffer.byteLength(component, 'utf8') <= MACOS_FILE_NAME_MAX_BYTES);
}

function validHttpsUrl(value) {
  if (!validString(value, { maximum: 2_048 })) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' &&
      url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

function validIsoDate(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function validArtifact(value) {
  if (value?.kind === 'TYPESCRIPT') {
    return exactObject(value, ['kind', 'version', 'digest', 'packageName']) &&
      validString(value.version, { pattern: VERSION, maximum: 64 }) &&
      SHA256.test(value.digest ?? '') &&
      /^@[a-z0-9-]+\/[a-z0-9-]+$/u.test(value.packageName ?? '');
  }
  if (value?.kind === 'GDSCRIPT') {
    return exactObject(value, ['kind', 'version', 'digest', 'releaseAssetUrl', 'treeChecksum']) &&
      validString(value.version, { pattern: VERSION, maximum: 64 }) &&
      SHA256.test(value.digest ?? '') && SHA256.test(value.treeChecksum ?? '') &&
      validHttpsUrl(value.releaseAssetUrl);
  }
  return false;
}

function validPlatformTask(value) {
  return exactObject(value, [
    'schemaVersion', 'kind', 'planId', 'repoId', 'repoFullName', 'sourceSha',
    'manifestDigest', 'releaseVersion', 'releaseSourceSha', 'contractRevision',
    'artifact', 'pullRequestMarker', 'requiredChecks',
  ]) && value.schemaVersion === 1 && value.kind === 'PLATFORM_SDK_UPDATE' &&
    validString(value.planId, { pattern: PUBLIC_CONTRACT_ID, maximum: 191 }) &&
    /^\d{1,30}$/u.test(value.repoId ?? '') && REPOSITORY.test(value.repoFullName ?? '') &&
    SHA1.test(value.sourceSha ?? '') && SHA256.test(value.manifestDigest ?? '') &&
    validString(value.releaseVersion, { pattern: VERSION, maximum: 64 }) &&
    SHA1.test(value.releaseSourceSha ?? '') && SHA256.test(value.contractRevision ?? '') &&
    validArtifact(value.artifact) &&
    /^<!-- seorilabs-platform-fleet:[0-9a-f]{64}:\d+ -->$/u.test(value.pullRequestMarker ?? '') &&
    Array.isArray(value.requiredChecks) && value.requiredChecks.length >= 1 &&
    value.requiredChecks.length <= REQUIRED_CHECKS.size &&
    new Set(value.requiredChecks).size === value.requiredChecks.length &&
    value.requiredChecks.every((entry) => REQUIRED_CHECKS.has(entry));
}

function validSourceRemediationTask(value) {
  return exactObject(value, ['kind', 'reasonCode', 'discoveryGeneration', 'sourceSha']) &&
    value.kind === 'SOURCE_REMEDIATION' &&
    ['NO_CANDIDATE', 'BUILD_TARGET_MISSING'].includes(value.reasonCode) &&
    validInteger(value.discoveryGeneration) && SHA1.test(value.sourceSha ?? '');
}

function validTaskInput(template, value) {
  if (template === 'repo-task-autopilot-v1') return value === null;
  if (template === 'platform-fleet-reconcile-v1') return validPlatformTask(value);
  if (template === 'repo-source-remediation-v1') return validSourceRemediationTask(value);
  return false;
}

function validAgentResult(value) {
  if (!closedObject(value, ['outcomeCode', 'summary', 'costMicros'], [
    'commitSha', 'pullRequestNumber', 'pullRequestUrl', 'model', 'inputTokens',
    'outputTokens', 'reauthRequestId', 'mutationExecutionId',
  ])) return false;
  if (!OUTCOME_CODES.has(value.outcomeCode) || !validString(value.summary, { maximum: 2_000 }) ||
      !validInteger(value.costMicros)) return false;
  if ('commitSha' in value && !SHA1.test(value.commitSha ?? '')) return false;
  if ('pullRequestNumber' in value && !validInteger(value.pullRequestNumber, 1)) return false;
  if ('pullRequestUrl' in value && !validHttpsUrl(value.pullRequestUrl)) return false;
  if ('model' in value && !validString(value.model, { pattern: PUBLIC_CONTRACT_ID, maximum: 191 })) return false;
  if ('inputTokens' in value && !validInteger(value.inputTokens)) return false;
  if ('outputTokens' in value && !validInteger(value.outputTokens)) return false;
  if ('reauthRequestId' in value && !validString(value.reauthRequestId, { pattern: PUBLIC_CONTRACT_ID, maximum: 191 })) return false;
  if ('mutationExecutionId' in value && !validString(value.mutationExecutionId, { pattern: PUBLIC_CONTRACT_ID, maximum: 191 })) return false;
  if (value.outcomeCode === 'PR_READY' && (!('pullRequestNumber' in value) || !('pullRequestUrl' in value) ||
      !('mutationExecutionId' in value))) return false;
  if (value.outcomeCode !== 'PR_READY' && ('pullRequestNumber' in value || 'pullRequestUrl' in value)) return false;
  if (value.reauthRequestId !== undefined && value.outcomeCode !== 'BLOCKED') return false;
  return true;
}

function validSessionBody(value, optional = []) {
  return closedObject(value, ['sessionId'], optional) &&
    validString(value.sessionId, { pattern: PUBLIC_CONTRACT_ID, maximum: 191 });
}

function validGithubReadyPrFile(value) {
  return closedObject(value, ['path', 'contentBase64'], ['mode']) &&
    validString(value.path, { maximum: 512 }) &&
    validString(value.contentBase64, { pattern: /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u, maximum: 1_398_108 }) &&
    (value.mode === undefined || ['100644', '100755'].includes(value.mode));
}

function validGithubReadyPrBody(value) {
  return exactObject(value, [
    'sessionId', 'repoId', 'repoFullName', 'issueNumber', 'sourceSha', 'title',
    'body', 'commitMessage', 'files',
  ]) && validString(value.sessionId, { pattern: PUBLIC_CONTRACT_ID, maximum: 191 }) &&
    /^[1-9]\d{0,15}$/u.test(value.repoId ?? '') && REPOSITORY.test(value.repoFullName ?? '') &&
    (value.issueNumber === null || validInteger(value.issueNumber, 1)) && SHA1.test(value.sourceSha ?? '') &&
    validString(value.title, { maximum: 180 }) && validString(value.body, { maximum: 20_000 }) &&
    validString(value.commitMessage, { maximum: 240 }) && Array.isArray(value.files) &&
    value.files.length >= 1 && value.files.length <= 100 && value.files.every(validGithubReadyPrFile);
}

function validRequestBody(operation, value) {
  if (operation === 'CLAIM') {
    return closedObject(value, [], ['leaseSeconds']) &&
      (value.leaseSeconds === undefined || validInteger(value.leaseSeconds, 30, 300));
  }
  if (operation === 'HEARTBEAT') {
    return validSessionBody(value, ['leaseSeconds']) &&
      (value.leaseSeconds === undefined || validInteger(value.leaseSeconds, 30, 300));
  }
  if (operation === 'COMPLETE' || operation === 'READBACK_REQUIRED') {
    return validSessionBody(value, ['result']) && Object.prototype.hasOwnProperty.call(value, 'result') &&
      validAgentResult(value.result);
  }
  if (operation === 'FAIL') {
    return validSessionBody(value, ['result', 'error']) &&
      Object.prototype.hasOwnProperty.call(value, 'result') &&
      Object.prototype.hasOwnProperty.call(value, 'error') && validAgentResult(value.result) &&
      validString(value.error, { pattern: /^[A-Z][A-Z0-9_.:-]{0,127}$/u, maximum: 128 });
  }
  if (operation === 'READBACK_RESOLVE') {
    return validSessionBody(value, ['resolution', 'result']) &&
      Object.prototype.hasOwnProperty.call(value, 'resolution') &&
      Object.prototype.hasOwnProperty.call(value, 'result') &&
      ['RESUME', 'COMPLETE', 'BLOCKED'].includes(value.resolution) && validAgentResult(value.result);
  }
  if (operation === 'GITHUB_READY_PR') return validGithubReadyPrBody(value);
  if (operation === 'GITHUB_READY_PR_READBACK') return validSessionBody(value);
  return false;
}

export function assertAgentRelayPublicRequest(value) {
  if (!exactObject(value, ['requestId', 'operation', 'body']) ||
      !validString(value.requestId, { pattern: REQUEST_ID, maximum: 191 }) ||
      !OPERATIONS.has(value.operation) || !validRequestBody(value.operation, value.body)) {
    fail('invalid_agent_relay_payload', 'agent relay request does not match the public operation schema');
  }
  return value;
}

function validClaim(value, expectedAgentKind) {
  if (value === null) return true;
  if (!exactObject(value, [
    'sessionId', 'runId', 'repoFullName', 'issueNumber', 'template', 'agentKind',
    'model', 'approvalPolicy', 'budgetCeilingMicros', 'spentMicros',
    'remainingBudgetMicros', 'taskInput', 'actionCapabilities', 'resumeMode',
    'generation', 'expiresAt', 'duplicate',
  ])) return false;
  return validString(value.sessionId, { pattern: PUBLIC_CONTRACT_ID, maximum: 191 }) &&
    validString(value.runId, { pattern: PUBLIC_CONTRACT_ID, maximum: 191 }) &&
    REPOSITORY.test(value.repoFullName ?? '') &&
    (value.issueNumber === null || validInteger(value.issueNumber, 1)) &&
    ['repo-task-autopilot-v1', 'platform-fleet-reconcile-v1', 'repo-source-remediation-v1'].includes(value.template) &&
    WORKER_KINDS.has(value.agentKind) &&
    (expectedAgentKind === undefined || value.agentKind === expectedAgentKind) &&
    (value.model === null || validString(value.model, { pattern: PUBLIC_CONTRACT_ID, maximum: 191 })) &&
    ['READY_PR', 'READ_ONLY'].includes(value.approvalPolicy) &&
    validInteger(value.budgetCeilingMicros, 1) && validInteger(value.spentMicros) &&
    validInteger(value.remainingBudgetMicros) && validTaskInput(value.template, value.taskInput) &&
    Array.isArray(value.actionCapabilities) &&
    new Set(value.actionCapabilities).size === value.actionCapabilities.length &&
    value.actionCapabilities.every((entry) => ACTION_CAPABILITIES.has(entry)) &&
    ['START', 'READBACK_FIRST'].includes(value.resumeMode) && validInteger(value.generation, 1) &&
    validIsoDate(value.expiresAt) && typeof value.duplicate === 'boolean';
}

function validQueueResponse(operation, value, expectedAgentKind) {
  if (operation === 'CLAIM') {
    return exactObject(value, ['ok', 'claim']) && value.ok === true &&
      validClaim(value.claim, expectedAgentKind);
  }
  if (operation === 'HEARTBEAT') {
    return exactObject(value, ['ok', 'sessionId', 'expiresAt', 'duplicate']) && value.ok === true &&
      validString(value.sessionId, { pattern: PUBLIC_CONTRACT_ID, maximum: 191 }) &&
      validIsoDate(value.expiresAt) && typeof value.duplicate === 'boolean';
  }
  if (['COMPLETE', 'FAIL', 'READBACK_REQUIRED'].includes(operation)) {
    return exactObject(value, ['ok', 'runId', 'status', 'retry', 'duplicate']) && value.ok === true &&
      validString(value.runId, { pattern: PUBLIC_CONTRACT_ID, maximum: 191 }) &&
      ['PENDING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER', 'UNKNOWN'].includes(value.status) &&
      typeof value.retry === 'boolean' && typeof value.duplicate === 'boolean';
  }
  if (operation === 'READBACK_RESOLVE') {
    return exactObject(value, ['ok', 'runId', 'status', 'duplicate']) && value.ok === true &&
      validString(value.runId, { pattern: PUBLIC_CONTRACT_ID, maximum: 191 }) &&
      ['PENDING', 'SUCCEEDED', 'DEAD_LETTER', 'UNKNOWN'].includes(value.status) &&
      typeof value.duplicate === 'boolean';
  }
  return false;
}

function validGithubReadyPrResponse(operation, value) {
  const readback = operation === 'GITHUB_READY_PR_READBACK';
  if (!closedObject(value, ['executionId', 'status', 'writeAttempted', ...(readback ? ['safeToResume'] : [])], [
    'pullRequestNumber', 'pullRequestUrl',
  ])) return false;
  return validString(value.executionId, { pattern: PUBLIC_CONTRACT_ID, maximum: 191 }) &&
    ['VERIFIED', 'NOT_APPLIED', 'RESULT_UNKNOWN'].includes(value.status) &&
    typeof value.writeAttempted === 'boolean' && (!readback || typeof value.safeToResume === 'boolean') &&
    (!('pullRequestNumber' in value) || validInteger(value.pullRequestNumber, 1)) &&
    (!('pullRequestUrl' in value) || validHttpsUrl(value.pullRequestUrl)) &&
    (('pullRequestNumber' in value) === ('pullRequestUrl' in value));
}

function validErrorResponse(value) {
  return exactObject(value, ['error']) && exactObject(value.error, ['code']) &&
    validString(value.error.code, { pattern: ERROR_CODE, maximum: 128 });
}

export function assertAgentRelayPublicResponse(value, operation, {
  expectedAgentKind,
  statusCode,
} = {}) {
  if (!OPERATIONS.has(operation)) {
    fail('invalid_agent_relay_request', 'agent relay response operation binding is invalid');
  }
  const errorEnvelope = validErrorResponse(value);
  if (
    statusCode !== undefined &&
    (!validInteger(statusCode, 100, 599) || ((statusCode >= 200 && statusCode < 300) === errorEnvelope))
  ) fail('agent_relay_upstream_rejected', 'agent relay response status does not match its envelope');
  if (errorEnvelope) return value;
  const validResult = ['GITHUB_READY_PR', 'GITHUB_READY_PR_READBACK'].includes(operation)
    ? validGithubReadyPrResponse(operation, value?.result)
    : validQueueResponse(operation, value?.result, expectedAgentKind);
  if (!exactObject(value, ['ok', 'result']) || value.ok !== true || !validResult) {
    fail('agent_relay_upstream_rejected', 'agent relay response does not match the public operation schema');
  }
  return value;
}

function validPublicId(value) {
  return typeof value === 'string' && PUBLIC_ID.test(value);
}

function relayProjectionPayload(config) {
  const { projectionDigest: _projectionDigest, ...controlPlane } = config.controlPlane;
  return {
    schemaVersion: config.schemaVersion,
    controlPlane,
    workerKind: config.workerKind,
    socketPath: config.socketPath,
    expectedPeer: config.expectedPeer,
    nativeHelper: config.nativeHelper,
    upstream: config.upstream,
  };
}

export function agentRelayProjectionDigest(config) {
  return createHash('sha256').update(canonicalJson(relayProjectionPayload(config)), 'utf8').digest('hex');
}

export function assertAgentRelayProjection(config) {
  const controlPlane = config?.controlPlane;
  if (
    !exactObject(controlPlane, [
      'contractVersion', 'projectionId', 'projectionDigest', 'configRevision',
      'discoveryObservation', 'providerObservation',
    ]) ||
    controlPlane.contractVersion !== 'agent-relay-projection/v1' ||
    !validPublicId(controlPlane.projectionId) || !SHA256.test(controlPlane.projectionDigest ?? '') ||
    !exactObject(controlPlane.configRevision, ['appId', 'id', 'revision', 'snapshotDigest']) ||
    !validPublicId(controlPlane.configRevision.appId) ||
    !validPublicId(controlPlane.configRevision.id) ||
    !Number.isSafeInteger(controlPlane.configRevision.revision) ||
    controlPlane.configRevision.revision < 1 ||
    !SHA256.test(controlPlane.configRevision.snapshotDigest ?? '') ||
    !exactObject(controlPlane.discoveryObservation, ['id', 'payloadHash', 'sourceSha']) ||
    !validPublicId(controlPlane.discoveryObservation.id) ||
    !SHA1.test(controlPlane.discoveryObservation.sourceSha ?? '') ||
    !SHA256.test(controlPlane.discoveryObservation.payloadHash ?? '') ||
    !exactObject(controlPlane.providerObservation, ['id', 'payloadHash']) ||
    !validPublicId(controlPlane.providerObservation.id) ||
    !SHA256.test(controlPlane.providerObservation.payloadHash ?? '')
  ) fail('invalid_agent_relay_projection', 'agent relay control-plane projection is invalid');
  const actual = agentRelayProjectionDigest(config);
  if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(controlPlane.projectionDigest, 'hex'))) {
    fail('agent_relay_projection_mismatch', 'agent relay config does not match its control-plane projection');
  }
  return Object.freeze({
    contractVersion: controlPlane.contractVersion,
    projectionId: controlPlane.projectionId,
    projectionDigest: controlPlane.projectionDigest,
    configRevision: Object.freeze({ ...controlPlane.configRevision }),
    discoveryObservation: Object.freeze({ ...controlPlane.discoveryObservation }),
    providerObservation: Object.freeze({ ...controlPlane.providerObservation }),
  });
}

function parseJsonBuffer(encoded, validate) {
  try {
    return validate(JSON.parse(encoded.toString('utf8')));
  } catch (error) {
    if (error instanceof SeoriAuthError) throw error;
    fail('invalid_agent_relay_payload', 'agent relay payload is not valid JSON');
  }
}

function normalizeHttpsOrigin(value) {
  let origin;
  try {
    origin = new URL(value);
  } catch {
    fail('invalid_agent_relay_upstream', 'agent relay upstream origin is invalid');
  }
  if (
    origin.protocol !== 'https:' || origin.username !== '' || origin.password !== '' ||
    origin.pathname !== '/' || origin.search !== '' || origin.hash !== ''
  ) fail('invalid_agent_relay_upstream', 'agent relay upstream must be an exact HTTPS origin');
  if (
    origin.port !== '' &&
    (!/^\d{1,5}$/.test(origin.port) || Number(origin.port) < 1 || Number(origin.port) > 65_535)
  ) {
    fail('invalid_agent_relay_upstream', 'agent relay upstream port is invalid');
  }
  const hostname = origin.hostname.startsWith('[') && origin.hostname.endsWith(']')
    ? origin.hostname.slice(1, -1)
    : origin.hostname;
  return Object.freeze({ hostname, port: origin.port ? Number(origin.port) : 443 });
}

async function readTlsFile(path, { privateMaterial = false } = {}) {
  if (!validMacOsCanonicalFilePath(path)) {
    fail('invalid_agent_relay_tls', 'agent relay TLS paths must be absolute');
  }
  const [entry, canonical] = await Promise.all([lstat(path), realpath(path)]);
  if (!entry.isFile() || entry.isSymbolicLink() || canonical !== path || entry.uid !== process.getuid?.()) {
    fail('invalid_agent_relay_tls', 'agent relay TLS material must be a canonical daemon-owned file');
  }
  if ((entry.mode & 0o022) !== 0) {
    fail('invalid_agent_relay_tls', 'agent relay TLS material must not be writable by group or world');
  }
  if (privateMaterial && (entry.mode & 0o077) !== 0) {
    fail('invalid_agent_relay_tls', 'agent relay private key must be owner-only');
  }
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== entry.dev || opened.ino !== entry.ino || opened.uid !== entry.uid ||
      opened.gid !== entry.gid || opened.mode !== entry.mode || opened.size !== entry.size
    ) fail('invalid_agent_relay_tls', 'agent relay TLS material changed while opening');
    const value = await handle.readFile();
    if (value.length === 0 || value.length > 1024 * 1024) {
      value.fill(0);
      fail('invalid_agent_relay_tls', 'agent relay TLS material size is invalid');
    }
    return value;
  } finally {
    await handle.close();
  }
}

async function assertTrustedAncestors(path, expectedOwnerUid, {
  code = 'insecure_agent_relay_config_ancestor',
  message = 'agent relay config ancestors must be trusted',
} = {}) {
  let current = dirname(path);
  while (true) {
    const [entry, canonical] = await Promise.all([lstat(current), realpath(current)]);
    if (
      !entry.isDirectory() || entry.isSymbolicLink() || canonical !== current ||
      (entry.uid !== 0 && entry.uid !== expectedOwnerUid) || (entry.mode & 0o022) !== 0
    ) fail(code, message);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function assertAgentRelayClientSocket(path, {
  expectedDirectoryUid = 0,
  expectedSocketUid = process.getuid?.(),
  expectedSocketGid = process.getgid?.(),
} = {}) {
  if (
    !validMacOsUnixSocketPath(path) ||
    !validMacOsId(expectedDirectoryUid, { allowRoot: true }) ||
    !validMacOsId(expectedSocketUid) || !validMacOsId(expectedSocketGid)
  ) fail('invalid_agent_relay_socket', 'agent relay client socket binding is invalid');
  await assertTrustedAncestors(path, expectedDirectoryUid);
  const parent = dirname(path);
  const [parentEntry, canonicalParent] = await Promise.all([lstat(parent), realpath(parent)]);
  if (
    !parentEntry.isDirectory() || parentEntry.isSymbolicLink() || canonicalParent !== parent ||
    parentEntry.uid !== expectedDirectoryUid || (parentEntry.mode & 0o777) !== 0o711
  ) fail('insecure_agent_relay_socket_directory', 'agent relay socket directory is not trusted');
  const [entry, canonical] = await Promise.all([lstat(path), realpath(path)]);
  if (
    !entry.isSocket() || entry.isSymbolicLink() || canonical !== path ||
    entry.uid !== expectedSocketUid || entry.gid !== expectedSocketGid ||
    (entry.mode & 0o777) !== 0o600
  ) fail('insecure_agent_relay_socket', 'agent relay client socket is not trusted');
}

export function executeAgentRelayClientRequest({
  socketPath,
  encoded,
  requestImpl = httpRequest,
  timeoutMs = 30_000,
}) {
  if (
    !validMacOsUnixSocketPath(socketPath) ||
    !Buffer.isBuffer(encoded) || encoded.length < 2 || encoded.length > REQUEST_LIMIT ||
    typeof requestImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
  ) fail('invalid_agent_relay_request', 'agent relay client request is invalid');
  const operation = parseJsonBuffer(encoded, assertAgentRelayPublicRequest).operation;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const clearChunks = () => chunks.forEach((entry) => entry.fill(0));
    const rejectStable = (code, message) => {
      if (settled) return;
      settled = true;
      clearChunks();
      reject(new SeoriAuthError(code, message));
    };
    const request = requestImpl({
      socketPath,
      path: '/v1/execute',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(encoded.length),
      },
      timeout: timeoutMs,
    }, (response) => {
      response.on('data', (chunk) => {
        if (settled) return;
        const copy = Buffer.from(chunk);
        bytes += copy.length;
        if (bytes > RESPONSE_LIMIT) {
          copy.fill(0);
          rejectStable('agent_relay_response_too_large', 'agent relay response exceeded its bound');
          response.destroy();
          return;
        }
        chunks.push(copy);
      });
      response.once('aborted', () => rejectStable(
        'agent_relay_response_rejected',
        'agent relay response was aborted',
      ));
      response.once('error', () => rejectStable(
        'agent_relay_response_rejected',
        'agent relay response failed',
      ));
      response.on('end', () => {
        if (settled) return;
        settled = true;
        const payload = Buffer.concat(chunks);
        try {
          const contentType = String(response.headers['content-type'] ?? '')
            .split(';', 1)[0].trim().toLowerCase();
          if (contentType !== 'application/json') {
            throw new SeoriAuthError(
              'agent_relay_response_rejected',
              'agent relay response content type is invalid',
            );
          }
          const statusCode = response.statusCode ?? 500;
          resolve({
            statusCode,
            body: parseJsonBuffer(payload, (value) => assertAgentRelayPublicResponse(
              value,
              operation,
              { statusCode },
            )),
          });
        } catch (error) {
          reject(error instanceof SeoriAuthError ? error : new SeoriAuthError(
            'agent_relay_response_rejected',
            'agent relay response is invalid',
          ));
        } finally {
          payload.fill(0);
          clearChunks();
        }
      });
    });
    request.once('timeout', () => request.destroy());
    request.once('error', () => rejectStable(
      'agent_relay_request_failed',
      'agent relay request failed',
    ));
    request.end(encoded);
  });
}

export async function readImmutableAgentRelayConfig(path, { expectedOwnerUid = 0 } = {}) {
  if (
    !validMacOsCanonicalFilePath(path) ||
    !validMacOsId(expectedOwnerUid, { allowRoot: true })
  ) fail('invalid_agent_relay_config', 'agent relay config path or owner is invalid');
  await assertTrustedAncestors(path, expectedOwnerUid);
  const [entry, canonical] = await Promise.all([lstat(path), realpath(path)]);
  if (
    !entry.isFile() || entry.isSymbolicLink() || canonical !== path ||
    entry.uid !== expectedOwnerUid || (entry.mode & 0o022) !== 0 ||
    entry.size < 2 || entry.size > 64 * 1024
  ) fail('invalid_agent_relay_config', 'agent relay config must be an immutable owned file');
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== entry.dev || opened.ino !== entry.ino || opened.uid !== entry.uid ||
      opened.gid !== entry.gid || opened.mode !== entry.mode || opened.size !== entry.size
    ) fail('invalid_agent_relay_config', 'agent relay config changed while opening');
    const encoded = await handle.readFile();
    try {
      if (encoded.length !== opened.size) {
        fail('invalid_agent_relay_config', 'agent relay config changed while reading');
      }
      return JSON.parse(encoded.toString('utf8'));
    } catch (error) {
      if (error instanceof SeoriAuthError) throw error;
      fail('invalid_agent_relay_config', 'agent relay config is not valid JSON');
    } finally {
      encoded.fill(0);
    }
  } finally {
    await handle.close();
  }
}

function validateServerName(value) {
  if (typeof value !== 'string' || value !== value.toLowerCase() || !DNS_NAME.test(value)) {
    fail('invalid_agent_relay_upstream', 'agent relay upstream server name is invalid');
  }
  return value;
}

export async function createAgentMtlsForwarder({
  origin,
  serverName,
  tls,
  workerKind,
  requestImpl = httpsRequest,
}) {
  if (
    !tls || typeof tls !== 'object' || Array.isArray(tls) ||
    !WORKER_KINDS.has(workerKind) || typeof requestImpl !== 'function'
  ) {
    throw new TypeError('agent relay requires a worker-bound mTLS forwarder configuration');
  }
  const target = normalizeHttpsOrigin(origin);
  const expectedServerName = validateServerName(serverName);
  const loaded = [];
  let ca;
  let certificate;
  let privateKey;
  try {
    ca = await readTlsFile(tls.caPath);
    loaded.push(ca);
    certificate = await readTlsFile(tls.certificatePath);
    loaded.push(certificate);
    privateKey = await readTlsFile(tls.privateKeyPath, { privateMaterial: true });
    loaded.push(privateKey);
  } catch (error) {
    loaded.forEach((entry) => entry.fill(0));
    throw error;
  }
  const agent = new HttpsAgent({ keepAlive: false, maxSockets: MAX_IN_FLIGHT });
  let closed = false;

  return Object.freeze({
    async forward(value) {
      if (closed) fail('agent_relay_closed', 'agent relay forwarder is closed');
      const publicRequest = assertAgentRelayPublicRequest(value);
      const encoded = Buffer.from(JSON.stringify(publicRequest), 'utf8');
      if (encoded.length > REQUEST_LIMIT) {
        encoded.fill(0);
        fail('agent_relay_request_too_large', 'agent relay request exceeded its bound');
      }
      try {
        return await new Promise((resolve, reject) => {
          let settled = false;
          let responseStream;
          let deadline;
          const chunks = [];
          const clearChunks = () => chunks.forEach((entry) => entry.fill(0));
          const rejectStable = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            clearChunks();
            reject(error instanceof SeoriAuthError ? error : new SeoriAuthError(
              'agent_relay_upstream_rejected',
              'agent relay upstream request failed',
            ));
          };
          const resolveStable = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            resolve(value);
          };
          const request = requestImpl({
            protocol: 'https:',
            hostname: target.hostname,
            port: target.port,
            servername: expectedServerName,
            method: 'POST',
            path: '/v1/execute',
            ca,
            cert: certificate,
            key: privateKey,
            agent,
            minVersion: 'TLSv1.3',
            maxVersion: 'TLSv1.3',
            headers: {
              'content-type': 'application/json',
              'content-length': String(encoded.length),
            },
            timeout: UPSTREAM_TOTAL_TIMEOUT_MS,
          }, (response) => {
            responseStream = response;
            let bytes = 0;
            response.on('data', (chunk) => {
              if (settled) return;
              const copy = Buffer.from(chunk);
              bytes += copy.length;
              if (bytes > RESPONSE_LIMIT) {
                copy.fill(0);
                rejectStable(new SeoriAuthError(
                  'agent_relay_upstream_rejected',
                  'agent relay upstream response exceeded its bound',
                ));
                request.destroy(new Error('agent relay upstream response exceeded its bound'));
                return;
              }
              chunks.push(copy);
            });
            response.once('aborted', () => rejectStable(new SeoriAuthError(
              'agent_relay_upstream_rejected',
              'agent relay upstream response was aborted',
            )));
            response.once('error', () => rejectStable(new SeoriAuthError(
              'agent_relay_upstream_rejected',
              'agent relay upstream response failed',
            )));
            response.on('end', () => {
              if (settled) return;
              const statusCode = response.statusCode ?? 500;
              const contentType = String(response.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
              const payload = Buffer.concat(chunks);
              try {
                if (
                  contentType !== 'application/json' || statusCode < 200 ||
                  (statusCode >= 300 && statusCode < 400)
                ) fail('agent_relay_upstream_rejected', 'agent relay upstream response is not public JSON');
                const publicResponse = parseJsonBuffer(
                  payload,
                  (value) => assertAgentRelayPublicResponse(
                    value,
                    publicRequest.operation,
                    { expectedAgentKind: workerKind, statusCode },
                  ),
                );
                const body = Buffer.from(`${JSON.stringify(publicResponse)}\n`, 'utf8');
                resolveStable(Object.freeze({ statusCode, body }));
              } catch (error) {
                rejectStable(error);
              } finally {
                payload.fill(0);
                chunks.forEach((entry) => entry.fill(0));
              }
            });
          });
          const abortUpstream = () => {
            responseStream?.destroy?.();
            request.destroy(new Error('agent relay upstream timed out'));
            rejectStable(new SeoriAuthError(
              'agent_relay_upstream_rejected',
              'agent relay upstream request failed',
            ));
          };
          deadline = setTimeout(abortUpstream, UPSTREAM_TOTAL_TIMEOUT_MS);
          deadline.unref?.();
          request.once('timeout', abortUpstream);
          request.once('error', () => rejectStable(new SeoriAuthError(
            'agent_relay_upstream_rejected',
            'agent relay upstream request failed',
          )));
          request.end(encoded);
        });
      } finally {
        encoded.fill(0);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      agent.destroy();
      ca.fill(0);
      certificate.fill(0);
      privateKey.fill(0);
    },
  });
}

async function preparePrivateSocketDirectory(path) {
  const [entry, canonical] = await Promise.all([lstat(path), realpath(path)]);
  const mode = entry.mode & 0o777;
  if (
    !entry.isDirectory() || entry.isSymbolicLink() || canonical !== path ||
    entry.uid !== process.getuid?.() || (mode !== 0o700 && mode !== 0o711)
  ) fail('insecure_agent_relay_directory', 'agent relay socket directory mode is invalid');
  if (mode === 0o700) return;
  await chmod(path, 0o700);
  const prepared = await lstat(path);
  if (
    !prepared.isDirectory() || prepared.isSymbolicLink() ||
    prepared.dev !== entry.dev || prepared.ino !== entry.ino ||
    prepared.uid !== entry.uid || (prepared.mode & 0o777) !== 0o700
  ) fail('insecure_agent_relay_directory', 'agent relay socket directory changed while preparing');
}

async function assertSocketPathAvailable(path) {
  try {
    await lstat(path);
    fail('agent_relay_socket_in_use', 'agent relay socket path already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function readRequestBody(request) {
  const declaredLength = request.headers['content-length'];
  if (
    request.headers['transfer-encoding'] !== undefined || typeof declaredLength !== 'string' ||
    !/^\d{1,8}$/.test(declaredLength) || Number(declaredLength) > REQUEST_LIMIT
  ) fail('invalid_agent_relay_payload', 'agent relay request length is invalid');
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of request) {
      const copy = Buffer.from(chunk);
      bytes += copy.length;
      if (bytes > REQUEST_LIMIT || bytes > Number(declaredLength)) {
        copy.fill(0);
        fail('agent_relay_request_too_large', 'agent relay request exceeded its bound');
      }
      chunks.push(copy);
    }
    if (bytes !== Number(declaredLength)) {
      fail('invalid_agent_relay_payload', 'agent relay request length does not match');
    }
    const encoded = Buffer.concat(chunks);
    try {
      return parseJsonBuffer(encoded, assertAgentRelayPublicRequest);
    } finally {
      encoded.fill(0);
    }
  } finally {
    chunks.forEach((entry) => entry.fill(0));
  }
}

function responseStatus(code) {
  if (code === 'method_not_allowed') return 405;
  if (code === 'route_not_found') return 404;
  if (code === 'peer_identity_mismatch' || code === 'peer_attestation_failed') return 403;
  if (code?.startsWith('invalid_') || code === 'agent_relay_secret_field_rejected') return 400;
  if (code?.startsWith('agent_relay_upstream')) return 502;
  return 500;
}

function sendJson(response, statusCode, value) {
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': String(encoded.length),
    'cache-control': 'no-store',
  });
  response.end(encoded, () => encoded.fill(0));
}

export class AgentRelayDaemon {
  #socketPath;
  #expectedPeerUid;
  #expectedPeerGid;
  #nativeBoundary;
  #forwarder;
  #server;
  #socketIdentity;
  #inFlight = 0;

  constructor({ socketPath, expectedPeerUid, expectedPeerGid, nativeBoundary, forwarder }) {
    if (!validMacOsUnixSocketPath(socketPath)) {
      throw new TypeError('agent relay socketPath must fit the macOS Unix socket path contract');
    }
    if (!validMacOsId(expectedPeerUid)) {
      throw new TypeError('agent relay expectedPeerUid must be a non-root OS UID');
    }
    if (!validMacOsId(expectedPeerGid)) {
      throw new TypeError('agent relay expectedPeerGid must be a non-root OS GID');
    }
    if (!nativeBoundary || typeof nativeBoundary.attest !== 'function') {
      throw new TypeError('agent relay requires the native peer attestation boundary');
    }
    if (!forwarder || typeof forwarder.forward !== 'function' || typeof forwarder.close !== 'function') {
      throw new TypeError('agent relay requires an mTLS forwarder');
    }
    this.#socketPath = socketPath;
    this.#expectedPeerUid = expectedPeerUid;
    this.#expectedPeerGid = expectedPeerGid;
    this.#nativeBoundary = nativeBoundary;
    this.#forwarder = forwarder;
  }

  async start() {
    if (this.#server) fail('daemon_already_started', 'agent relay is already started');
    const directory = dirname(this.#socketPath);
    await assertTrustedAncestors(directory, process.getuid?.(), {
      code: 'insecure_agent_relay_directory',
      message: 'agent relay socket directory ancestors must be trusted',
    });
    await preparePrivateSocketDirectory(directory);
    await assertSocketPathAvailable(this.#socketPath);
    const server = createServer((request, response) => {
      void this.#dispatchBounded(request, response).catch(() => response.destroy());
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 1_000;
    server.maxHeadersCount = 16;
    server.maxRequestsPerSocket = 1;
    server.maxConnections = MAX_CONNECTIONS;
    server.dropMaxConnection = true;
    server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.#socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.#server = server;
    try {
      const createdSocket = await lstat(this.#socketPath);
      if (createdSocket.uid !== this.#expectedPeerUid || createdSocket.gid !== this.#expectedPeerGid) {
        await chown(this.#socketPath, this.#expectedPeerUid, this.#expectedPeerGid);
      }
      await chmod(this.#socketPath, 0o600);
      const socket = await lstat(this.#socketPath);
      if (
        !socket.isSocket() || socket.uid !== this.#expectedPeerUid ||
        socket.gid !== this.#expectedPeerGid || (socket.mode & 0o777) !== 0o600
      ) fail('insecure_agent_relay_socket', 'agent relay socket ownership is invalid');
      this.#socketIdentity = Object.freeze({ dev: socket.dev, ino: socket.ino });
      await chmod(directory, 0o711);
    } catch (error) {
      await new Promise((resolve) => server.close(() => resolve()));
      this.#server = undefined;
      await unlink(this.#socketPath).catch(() => {});
      throw error;
    }
    return Object.freeze({ transport: 'unix', socketPath: this.#socketPath });
  }

  async #dispatchBounded(request, response) {
    if (this.#inFlight >= MAX_IN_FLIGHT) {
      sendJson(response, 503, { error: { code: 'agent_relay_busy' } });
      request.resume();
      return;
    }
    this.#inFlight += 1;
    try {
      await this.dispatch(request, response);
    } finally {
      this.#inFlight -= 1;
    }
  }

  async dispatch(request, response) {
    try {
      if (request.method !== 'POST') fail('method_not_allowed', 'agent relay accepts POST only');
      if (request.url !== '/v1/execute') fail('route_not_found', 'agent relay route does not exist');
      if (String(request.headers['content-type'] ?? '').toLowerCase() !== 'application/json') {
        fail('invalid_agent_relay_payload', 'agent relay requires application/json');
      }
      if (
        request.headers.authorization !== undefined || request.headers.cookie !== undefined ||
        request.headers['proxy-authorization'] !== undefined
      ) fail('agent_relay_secret_field_rejected', 'agent relay rejects credential headers');
      const peer = await this.#nativeBoundary.attest(request.socket);
      if (peer.uid !== this.#expectedPeerUid || peer.gid !== this.#expectedPeerGid) {
        fail('peer_identity_mismatch', 'agent relay peer does not match the configured worker');
      }
      const body = await readRequestBody(request);
      const upstream = await this.#forwarder.forward(body);
      response.writeHead(upstream.statusCode, {
        'content-type': 'application/json',
        'content-length': String(upstream.body.length),
        'cache-control': 'no-store',
      });
      response.end(upstream.body, () => upstream.body.fill(0));
    } catch (error) {
      const code = error instanceof SeoriAuthError ? error.code : 'agent_relay_internal_error';
      if (!response.headersSent) sendJson(response, responseStatus(code), { error: { code } });
      else response.destroy();
    }
  }

  async stop() {
    const server = this.#server;
    const identity = this.#socketIdentity;
    this.#server = undefined;
    this.#socketIdentity = undefined;
    const directory = dirname(this.#socketPath);
    await chmod(directory, 0o700).catch(() => {});
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    try {
      const socket = await lstat(this.#socketPath);
      if (socket.isSocket() && socket.dev === identity?.dev && socket.ino === identity?.ino) {
        await unlink(this.#socketPath);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    } finally {
      this.#forwarder.close();
    }
  }
}
