import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

import { fail } from './errors.mjs';

const ROLES = new Set(['broker', 'password-loader', 'totp-signer']);
const CHECKPOINT_HEALTH = new Set(['HEALTHY', 'INITIALIZING', 'SEALED']);

/**
 * Runtime readiness marker를 process 상태와 broker checkpoint 상태의 교집합으로 관리한다.
 * broker가 unknown CAS에 봉인되면 marker를 제거하고, exact pending-next readback으로 복구된
 * 경우에만 같은 process가 marker를 다시 게시할 수 있다.
 */
export function createRuntimeReadinessGate({ path, role }) {
  if (typeof path !== 'string' || !isAbsolute(path) || !ROLES.has(role)) {
    fail('invalid_runtime_readiness', 'runtime readiness binding is invalid');
  }
  let runtimeReady = false;
  let checkpointHealth = role === 'broker' ? 'INITIALIZING' : 'HEALTHY';
  let published = false;
  let closed = false;
  let queue = Promise.resolve();

  async function reconcile() {
    const shouldPublish = !closed && runtimeReady && checkpointHealth === 'HEALTHY';
    if (!shouldPublish) {
      await unlink(path).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      published = false;
      return;
    }
    if (published) return;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await unlink(path).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await writeFile(path, `${JSON.stringify({ pid: process.pid, role })}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await chmod(path, 0o600);
    published = true;
  }

  function serialize(operation) {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  }

  return Object.freeze({
    setRuntimeReady() {
      return serialize(async () => {
        if (closed) fail('runtime_not_ready', 'runtime readiness gate is closed');
        runtimeReady = true;
        await reconcile();
      });
    },
    setCheckpointHealth(state) {
      return serialize(async () => {
        if (closed || role !== 'broker' || !CHECKPOINT_HEALTH.has(state)) {
          fail('invalid_runtime_readiness', 'checkpoint readiness transition is invalid');
        }
        checkpointHealth = state;
        await reconcile();
      });
    },
    isHealthy() {
      return !closed && runtimeReady && checkpointHealth === 'HEALTHY' && published;
    },
    close() {
      return serialize(async () => {
        closed = true;
        runtimeReady = false;
        await reconcile();
      });
    },
  });
}
