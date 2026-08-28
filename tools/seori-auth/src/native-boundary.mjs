import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { fail } from './errors.mjs';
import { normalizeExecutionBinding } from './durable-state.mjs';
import { NATIVE_LAUNCHER_BRAND } from './native-launcher-brand.mjs';
import { NATIVE_FILE_LOCK_BRAND } from './native-lock-brand.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ATTESTATION_BYTES = 1_024;
const LOCK_READY_TIMEOUT_MS = 5_000;

async function validateHelper(helperPath, expectedSha256) {
  if (typeof helperPath !== 'string' || !isAbsolute(helperPath)) {
    fail('invalid_native_helper', 'native helper path must be absolute');
  }
  const [stat, canonical] = await Promise.all([lstat(helperPath), realpath(helperPath)]);
  if (
    !stat.isFile() || stat.isSymbolicLink() || canonical !== helperPath ||
    (stat.mode & 0o022) !== 0 || ![0, process.getuid?.()].includes(stat.uid)
  ) {
    fail('invalid_native_helper', 'native helper must be a trusted regular file without group or world write access');
  }
  if (expectedSha256 !== undefined) {
    if (!SHA256.test(expectedSha256)) {
      fail('invalid_native_helper', 'native helper SHA-256 is invalid');
    }
    const digest = createHash('sha256').update(await readFile(helperPath)).digest('hex');
    if (digest !== expectedSha256) {
      fail('native_helper_mismatch', 'native helper checksum does not match');
    }
  }
}

function acceptedSocketFd(socket) {
  const fd = socket?._handle?.fd;
  if (!Number.isInteger(fd) || fd < 0) {
    fail('peer_attestation_unavailable', 'accepted Unix socket descriptor is unavailable');
  }
  return fd;
}

async function readBoundedJson(child) {
  const chunks = [];
  let size = 0;
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  try {
    for await (const chunk of child.stdout) {
      size += chunk.length;
      if (size > MAX_ATTESTATION_BYTES) {
        child.kill('SIGKILL');
        fail('peer_attestation_failed', 'native peer attestation exceeded its output bound');
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch {
    child.kill('SIGKILL');
    fail('peer_attestation_failed', 'native peer attestation output could not be read');
  }
  const result = await completion;
  if (result.code !== 0 || result.signal !== null) {
    fail('peer_attestation_failed', 'native peer attestation failed');
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('peer_attestation_failed', 'native peer attestation was malformed');
  }
  return value;
}

function normalizePeer(value) {
  const keys = Object.keys(value ?? {}).sort();
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    keys.join(',') !== 'gid,pid,uid' ||
    !Number.isSafeInteger(value.uid) || value.uid < 0 ||
    !Number.isSafeInteger(value.gid) || value.gid < 0 ||
    !Number.isSafeInteger(value.pid) || value.pid < 1
  ) {
    fail('peer_attestation_failed', 'native peer identity is invalid');
  }
  return Object.freeze({ uid: value.uid, gid: value.gid, pid: value.pid });
}

export class NativeSecurityBoundary {
  #helperPath;
  #expectedUid;
  #expectedGid;
  #resolvePrincipal;

  static async open({
    helperPath,
    expectedSha256,
    expectedUid = process.getuid?.(),
    expectedGid = process.getgid?.(),
    resolvePrincipal,
  }) {
    await validateHelper(helperPath, expectedSha256);
    if (!Number.isSafeInteger(expectedUid) || expectedUid < 0) {
      fail('invalid_native_helper', 'expected peer UID is invalid');
    }
    if (expectedGid !== undefined && (!Number.isSafeInteger(expectedGid) || expectedGid < 0)) {
      fail('invalid_native_helper', 'expected peer GID is invalid');
    }
    if (typeof resolvePrincipal !== 'function') {
      fail('invalid_native_helper', 'trusted peer-to-run principal resolver is required');
    }
    return new NativeSecurityBoundary({ helperPath, expectedUid, expectedGid, resolvePrincipal });
  }

  constructor({ helperPath, expectedUid, expectedGid, resolvePrincipal }) {
    this.#helperPath = helperPath;
    this.#expectedUid = expectedUid;
    this.#expectedGid = expectedGid;
    this.#resolvePrincipal = resolvePrincipal;
  }

  launcher() {
    return Object.freeze({
      executable: this.#helperPath,
      mode: 'non-dumpable-v1',
      [NATIVE_LAUNCHER_BRAND]: true,
    });
  }

  lockProvider() {
    const helperPath = this.#helperPath;
    return Object.freeze({
      [NATIVE_FILE_LOCK_BRAND]: true,
      async acquire(path) {
        if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
          fail('invalid_browser_vault', 'native lock path must be absolute');
        }
        const child = spawn(helperPath, ['hold-lock', path], {
          env: { LANG: 'C.UTF-8' },
          shell: false,
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
        });
        let released = false;
        let timer;
        const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
        try {
          const ready = await Promise.race([
            new Promise((resolve, reject) => {
              let encoded = '';
              child.once('error', reject);
              child.stdout.on('data', (chunk) => {
                encoded += chunk.toString('utf8');
                if (encoded.length > 128) {
                  reject(new Error('lock readiness output exceeded bound'));
                  return;
                }
                if (encoded.includes('\n')) resolve(encoded);
              });
              child.once('close', () => reject(new Error('lock helper exited before acquisition')));
            }),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('lock acquisition timed out')), LOCK_READY_TIMEOUT_MS);
              timer.unref();
            }),
          ]);
          if (JSON.parse(ready.trim()).locked !== true) throw new Error('invalid lock readiness');
        } catch {
          child.kill('SIGKILL');
          const result = await closed;
          if (result.code === 75 && result.signal === null) {
            fail('browser_account_in_use', 'provider account lock is already held');
          }
          fail('insecure_browser_vault', 'native account lock boundary failed');
        } finally {
          clearTimeout(timer);
        }
        return Object.freeze({
          async release() {
            if (released) return;
            released = true;
            child.stdin.end();
            const result = await closed;
            if (result.code !== 0 || result.signal !== null) {
              fail('insecure_browser_vault', 'native account lock exited unexpectedly');
            }
          },
        });
      },
    });
  }

  async attest(socket) {
    const fd = acceptedSocketFd(socket);
    const child = spawn(this.#helperPath, ['peer-credential'], {
      env: { LANG: 'C.UTF-8' },
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore', fd],
      windowsHide: true,
    });
    const peer = normalizePeer(await readBoundedJson(child));
    if (peer.uid !== this.#expectedUid || (this.#expectedGid !== undefined && peer.gid !== this.#expectedGid)) {
      fail('peer_identity_mismatch', 'Unix peer UID or GID is not approved');
    }
    return peer;
  }

  async authenticatePrincipal(socket) {
    const peer = await this.attest(socket);
    let principal;
    try {
      principal = await this.#resolvePrincipal(peer);
    } catch {
      fail('principal_unauthenticated', 'scheduler run capability could not be resolved for Unix peer');
    }
    return normalizeExecutionBinding(principal);
  }
}
