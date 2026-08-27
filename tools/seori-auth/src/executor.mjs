import { spawn } from 'node:child_process';

import { fail, SeoriAuthError } from './errors.mjs';
import { redactOutput } from './redaction.mjs';

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

async function runChild({ adapter, secretBuffer }) {
  const child = spawn(adapter.executable, adapter.args, {
    cwd: adapter.cwd,
    env: safeEnvironment(adapter),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const stdoutChunks = [];
  const stderrChunks = [];
  let outputBytes = 0;
  let exceeded = false;

  const capture = (chunks) => (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > adapter.maxOutputBytes) {
      exceeded = true;
      child.kill('SIGKILL');
      return;
    }
    chunks.push(Buffer.from(chunk));
  };

  child.stdout.on('data', capture(stdoutChunks));
  child.stderr.on('data', capture(stderrChunks));
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

  const secret = secretBuffer.toString('utf8');
  return Object.freeze({
    ...result,
    stdout: redactOutput(Buffer.concat(stdoutChunks).toString('utf8'), secret),
    stderr: redactOutput(Buffer.concat(stderrChunks).toString('utf8'), secret),
  });
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
    secretBuffer.fill(0);
  }
}
