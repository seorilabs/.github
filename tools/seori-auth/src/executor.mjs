import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

import { fail, SeoriAuthError } from './errors.mjs';
import {
  canonicalPublicJson,
  normalizeProviderAdapterResult,
  providerGrantLeaseRequest,
} from './provider-grants.mjs';

function auditSafely(onAudit, event) {
  try {
    onAudit(Object.freeze(event));
  } catch {
    // Audit sinks must not alter authorization or disclose execution data through errors.
  }
}

function safeEnvironment(adapter) {
  return {
    LANG: 'C.UTF-8',
    ...adapter.environment,
    SEORI_AUTH_SECRET_FD: '3',
  };
}

function providerEnvironment(adapter) {
  return {
    ...safeEnvironment(adapter),
    SEORI_AUTH_COMMAND_FD: '4',
    SEORI_AUTH_RESULT_FD: '5',
  };
}

const BASE64_ALPHABET = Buffer.from(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  'ascii',
);
const HEX_ALPHABET = Buffer.from('0123456789abcdef', 'ascii');

function base64Marker(secretBuffer) {
  const output = Buffer.alloc(Math.ceil(secretBuffer.length / 3) * 4, 0x3d);
  let read = 0;
  let write = 0;
  while (read < secretBuffer.length) {
    const first = secretBuffer[read++];
    const hasSecond = read < secretBuffer.length;
    const second = hasSecond ? secretBuffer[read++] : 0;
    const hasThird = read < secretBuffer.length;
    const third = hasThird ? secretBuffer[read++] : 0;
    output[write++] = BASE64_ALPHABET[first >> 2];
    output[write++] = BASE64_ALPHABET[((first & 0x03) << 4) | (second >> 4)];
    if (hasSecond) output[write++] = BASE64_ALPHABET[((second & 0x0f) << 2) | (third >> 6)];
    else write += 1;
    if (hasThird) output[write] = BASE64_ALPHABET[third & 0x3f];
    write += 1;
  }
  return output;
}

function hexMarker(secretBuffer) {
  const output = Buffer.alloc(secretBuffer.length * 2);
  for (let index = 0; index < secretBuffer.length; index += 1) {
    output[index * 2] = HEX_ALPHABET[secretBuffer[index] >> 4];
    output[(index * 2) + 1] = HEX_ALPHABET[secretBuffer[index] & 0x0f];
  }
  return output;
}

async function runChild({ adapter, secretBuffer }) {
  const executable = adapter.launcher?.executable ?? adapter.executable;
  const args = adapter.launcher
    ? ['launch', '--', adapter.executable, ...adapter.args]
    : adapter.args;
  const child = spawn(executable, args, {
    cwd: adapter.cwd,
    env: safeEnvironment(adapter),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let outputBytes = 0;
  let exceeded = false;

  const discardBounded = (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > adapter.maxOutputBytes) {
      exceeded = true;
      child.kill('SIGKILL');
    }
    if (Buffer.isBuffer(chunk)) {
      chunk.fill(0);
    }
  };

  // Adapter output is untrusted and may contain transformed credential data.
  // Count it for a hard bound, but never retain or return either channel.
  child.stdout.on('data', discardBounded);
  child.stderr.on('data', discardBounded);
  child.stdio[3].on('error', () => {
    // Early child exit can close fd3 before the write completes; process exit remains authoritative.
  });
  child.stdio[3].end(secretBuffer);

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new SeoriAuthError('adapter_timeout', 'trusted adapter exceeded its execution timeout'));
    }, adapter.timeoutMs);
    timeout.unref();

    child.once('error', () => {
      clearTimeout(timeout);
      reject(new SeoriAuthError('adapter_start_failed', 'trusted adapter could not be started'));
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode, signal });
    });
  });

  if (exceeded) {
    fail('adapter_output_limit', 'trusted adapter exceeded its output limit');
  }

  return Object.freeze(result);
}

async function runProviderChild({ adapter, secretBuffer, command }) {
  const executable = adapter.launcher?.executable ?? adapter.executable;
  const args = adapter.launcher
    ? ['launch', '--', adapter.executable, ...adapter.args]
    : adapter.args;
  const commandBuffer = Buffer.from(canonicalPublicJson(command), 'utf8');
  const resultChunks = [];
  const child = spawn(executable, args, {
    cwd: adapter.cwd,
    env: providerEnvironment(adapter),
    shell: false,
    // fd3 is credential-only, fd4 is the strict public command, and fd5 is the
    // bounded strict public result. No request controls executable/argv/env.
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let outputBytes = 0;
  let resultBytes = 0;
  let exceeded = false;
  const terminateForLimit = () => {
    exceeded = true;
    child.kill('SIGKILL');
  };
  const discardBounded = (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > adapter.maxOutputBytes) terminateForLimit();
    if (Buffer.isBuffer(chunk)) chunk.fill(0);
  };
  const collectResult = (chunk) => {
    resultBytes += chunk.length;
    if (resultBytes > adapter.maxOutputBytes) {
      if (Buffer.isBuffer(chunk)) chunk.fill(0);
      terminateForLimit();
      return;
    }
    resultChunks.push(Buffer.from(chunk));
    if (Buffer.isBuffer(chunk)) chunk.fill(0);
  };
  child.stdout.on('data', discardBounded);
  child.stderr.on('data', discardBounded);
  child.stdio[5].on('data', collectResult);
  for (const stream of [child.stdio[3], child.stdio[4]]) {
    stream.on('error', () => {
      // Early child exit is represented by the process result and strict result fd.
    });
  }
  child.stdio[3].end(secretBuffer);
  child.stdio[4].end(commandBuffer);

  let processResult;
  try {
    processResult = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new SeoriAuthError('adapter_timeout', 'trusted provider adapter exceeded its execution timeout'));
      }, adapter.timeoutMs);
      timeout.unref();
      child.once('error', () => {
        clearTimeout(timeout);
        reject(new SeoriAuthError('adapter_start_failed', 'trusted provider adapter could not be started'));
      });
      child.once('close', (exitCode, signal) => {
        clearTimeout(timeout);
        resolve({ exitCode, signal });
      });
    });
    if (exceeded) fail('adapter_output_limit', 'trusted provider adapter exceeded its output limit');
    const encodedResult = Buffer.concat(resultChunks);
    const markers = secretBuffer.length >= 8
      ? [secretBuffer, base64Marker(secretBuffer), hexMarker(secretBuffer)]
      : [];
    try {
      if (markers.some((candidate) => encodedResult.includes(candidate))) {
        fail('adapter_result_secret_detected', 'trusted provider adapter result contained credential material');
      }
      const publicOutput = encodedResult.toString('utf8');
      let parsed;
      try {
        parsed = JSON.parse(publicOutput);
      } catch {
        fail('invalid_adapter_result', 'trusted provider adapter result must be strict JSON');
      }
      const adapterResult = normalizeProviderAdapterResult(parsed, command);
      if (processResult.exitCode !== 0 && adapterResult.outcome === 'SUCCESS') {
        fail('invalid_adapter_result', 'provider adapter process failure cannot report success');
      }
      return Object.freeze({ ...processResult, adapterResult });
    } finally {
      for (const marker of markers.slice(1)) marker.fill(0);
      encodedResult.fill(0);
    }
  } finally {
    commandBuffer.fill(0);
    for (const chunk of resultChunks) chunk.fill(0);
  }
}

export async function executeSecretAdapter({ registry, adapterId, binding, secretBuffer }) {
  if (!registry || typeof registry.require !== 'function') {
    throw new TypeError('registry must be a trusted adapter registry');
  }
  if (!Buffer.isBuffer(secretBuffer) || secretBuffer.length === 0) {
    fail('secret_load_failed', 'factor execution copy must be a non-empty Buffer');
  }
  try {
    const adapter = registry.require(adapterId, binding);
    return await runChild({ adapter, secretBuffer });
  } catch (error) {
    if (error instanceof SeoriAuthError) throw error;
    fail('adapter_failed', 'trusted factor adapter execution failed');
  } finally {
    secretBuffer.fill(0);
  }
}

export async function executeLease({
  leaseStore,
  registry,
  leaseId,
  context,
  currentCredentialGeneration,
  currentPolicyGeneration,
  loadSecret,
  onAudit = () => {},
}) {
  const consumed = leaseStore.consume({
    leaseId,
    context,
    currentCredentialGeneration,
    currentPolicyGeneration,
  });
  return executeConsumedLease({ consumed, registry, loadSecret, onAudit });
}

export async function executeConsumedLease({
  consumed,
  registry,
  loadSecret,
  onAudit = () => {},
}) {
  const adapter = registry.require(consumed.binding.adapterId, consumed.binding);
  const auditBase = {
    event: 'lease_execution',
    leaseId: consumed.id,
    ruleId: consumed.ruleId,
    credentialRef: consumed.binding.credentialRef,
    subject: consumed.binding.subject,
    runId: consumed.binding.runId,
    repository: consumed.binding.repository,
    commitSha: consumed.binding.commitSha,
    provider: consumed.binding.provider,
    capability: consumed.binding.capability,
    resource: consumed.binding.resource,
    artifactSha256: consumed.binding.artifact?.sha256,
    adapterId: consumed.binding.adapterId,
  };

  let secretBuffer;
  try {
    secretBuffer = await loadSecret({
      credentialRef: consumed.binding.credentialRef,
      credentialGeneration: consumed.binding.credentialGeneration,
    });
  } catch {
    auditSafely(onAudit, { ...auditBase, outcome: 'secret_load_failed' });
    fail('secret_load_failed', 'credential execution copy could not be loaded');
  }

  if (!Buffer.isBuffer(secretBuffer) || secretBuffer.length === 0) {
    auditSafely(onAudit, { ...auditBase, outcome: 'secret_load_failed' });
    fail('secret_load_failed', 'credential loader must return a non-empty Buffer');
  }

  try {
    const result = await runChild({ adapter, secretBuffer });
    auditSafely(onAudit, {
      ...auditBase,
      outcome: result.exitCode === 0 ? 'success' : 'adapter_failed',
      exitCode: result.exitCode,
      signal: result.signal,
    });
    return result;
  } catch (error) {
    auditSafely(onAudit, {
      ...auditBase,
      outcome: error instanceof SeoriAuthError ? error.code : 'adapter_failed',
    });
    if (error instanceof SeoriAuthError) {
      throw error;
    }
    fail('adapter_failed', 'trusted adapter execution failed');
  } finally {
    if (Buffer.isBuffer(secretBuffer)) {
      secretBuffer.fill(0);
    }
  }
}

export async function executeConsumedProviderLease({
  consumed,
  registry,
  loadSecret,
  command,
}) {
  const expectedBinding = providerGrantLeaseRequest(command, consumed?.binding?.subject);
  if (!isDeepStrictEqual(consumed?.binding, expectedBinding)) {
    fail('provider_grant_binding_mismatch', 'provider command does not match the consumed credential lease');
  }
  const adapter = registry.require(consumed.binding.adapterId, consumed.binding);
  let secretBuffer;
  try {
    secretBuffer = await loadSecret({
      credentialRef: consumed.binding.credentialRef,
      credentialGeneration: consumed.binding.credentialGeneration,
    });
  } catch {
    fail('secret_load_failed', 'provider credential execution copy could not be loaded');
  }
  if (!Buffer.isBuffer(secretBuffer) || secretBuffer.length === 0) {
    if (Buffer.isBuffer(secretBuffer)) secretBuffer.fill(0);
    fail('secret_load_failed', 'provider credential loader must return a non-empty Buffer');
  }
  try {
    return await runProviderChild({ adapter, secretBuffer, command });
  } catch (error) {
    if (error instanceof SeoriAuthError) throw error;
    fail('adapter_failed', 'trusted provider adapter execution failed');
  } finally {
    secretBuffer.fill(0);
  }
}
