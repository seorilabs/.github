import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, open as fsOpen, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

import { fail } from './errors.mjs';
import { normalizeExecutionBinding } from './durable-state.mjs';
import { NATIVE_LAUNCHER_BRAND } from './native-launcher-brand.mjs';
import { NATIVE_FILE_LOCK_BRAND } from './native-lock-brand.mjs';
import { NATIVE_BROWSER_ADAPTER_BRAND } from './native-browser-adapter-brand.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ATTESTATION_BYTES = 1_024;
const LOCK_READY_TIMEOUT_MS = 5_000;
const MAX_EXECUTION_COPY_BYTES = 1024 * 1024;
const MAX_SECRET_MANAGER_WRITE_RESULT_BYTES = 4 * 1024;
const SECRET_MANAGER_RESOURCE = /^projects\/[A-Za-z0-9._:-]+\/secrets\/[A-Za-z0-9_-]+\/versions\/[1-9][0-9]*$/;
const SECRET_MANAGER_SECRET = /^projects\/[A-Za-z0-9._:-]+\/secrets\/[A-Za-z0-9_-]+$/;
const SECRET_MANAGER_NODE = '/usr/local/bin/node';
const SECRET_MANAGER_CHILD = '/opt/seori-auth/runtime/secret-manager-child.mjs';
const SECRET_MANAGER_CONFIG = '/etc/seori-auth/secret-access.json';
const ACTIVE_SECRET_MANAGER_RESOURCES = new Set();

async function validateTrustedAncestors(path, trustedOwners, label) {
  let current = dirname(path);
  while (true) {
    const stat = await lstat(current);
    if (
      !stat.isDirectory() || stat.isSymbolicLink() ||
      !trustedOwners.includes(stat.uid) || (stat.mode & 0o022) !== 0
    ) {
      fail('invalid_native_helper', `${label} has an untrusted writable ancestor`);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

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
  await validateTrustedAncestors(
    helperPath,
    [0, process.getuid?.()].filter((value) => Number.isSafeInteger(value)),
    'native helper',
  );
  if (expectedSha256 !== undefined) {
    if (!SHA256.test(expectedSha256)) {
      fail('invalid_native_helper', 'native helper SHA-256 is invalid');
    }
    const digest = createHash('sha256').update(await readFile(helperPath)).digest('hex');
    if (digest !== expectedSha256) {
      fail('native_helper_mismatch', 'native helper checksum does not match');
    }
  }
  return stat.uid;
}

async function validateTrustedImageFile(path, expectedSha256, label, helperOwnerUid = 0) {
  let handle;
  try {
    handle = await openTrustedImageFile(path, expectedSha256, label, helperOwnerUid);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function openTrustedImageFile(path, expectedSha256, label, helperOwnerUid = 0) {
  if (typeof path !== 'string' || !isAbsolute(path) || !SHA256.test(expectedSha256 ?? '')) {
    fail('invalid_native_helper', `${label} path or checksum is invalid`);
  }
  let handle;
  try {
    handle = await fsOpen(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    const trustedOwners = helperOwnerUid === 0 ? [0] : [0, helperOwnerUid];
    const canonical = await realpath(path);
    if (
      !stat.isFile() || canonical !== path ||
      !trustedOwners.includes(stat.uid) || (stat.mode & 0o022) !== 0
    ) {
      fail('invalid_native_helper', `${label} must be an immutable trusted-owner image file`);
    }
    await validateTrustedAncestors(path, trustedOwners, label);
    const digest = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    try {
      while (true) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        digest.update(chunk.subarray(0, bytesRead));
        chunk.fill(0, 0, bytesRead);
        position += bytesRead;
      }
    } finally {
      chunk.fill(0);
    }
    if (digest.digest('hex') !== expectedSha256) {
      fail('native_helper_mismatch', `${label} checksum does not match`);
    }
    return handle;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === 'native_helper_mismatch') throw error;
    if (error?.code === 'invalid_native_helper') throw error;
    fail('invalid_native_helper', `${label} checksum could not be read`);
  }
}

function crc32c(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
    }
  }
  return String((crc ^ 0xffffffff) >>> 0);
}

function normalizeSecretManagerWriteResult(
  value,
  resourceName,
  expectedVersion,
  expectedDataCrc32c,
) {
  const keys = Object.keys(value ?? {}).sort();
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    keys.join(',') !== [
      'backupRestoreVerified',
      'dataCrc32c',
      'operation',
      'resourceName',
      'schemaVersion',
      'secretExposed',
      'versionResourceName',
    ].join(',') ||
    value.schemaVersion !== 1 || value.operation !== 'secret-version-write' ||
    value.resourceName !== resourceName ||
    value.versionResourceName !== `${resourceName}/versions/${expectedVersion}` ||
    !SECRET_MANAGER_RESOURCE.test(value.versionResourceName) ||
    typeof value.dataCrc32c !== 'string' ||
    !/^(?:0|[1-9][0-9]{0,9})$/.test(value.dataCrc32c) ||
    Number(value.dataCrc32c) > 0xffffffff ||
    value.dataCrc32c !== expectedDataCrc32c ||
    value.backupRestoreVerified !== true || value.secretExposed !== false
  ) {
    fail('secret_write_failed', 'trusted Secret Manager writer returned an invalid public result');
  }
  return Object.freeze({ ...value });
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
  #helperOwnerUid;
  #helperSha256;
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
    const helperOwnerUid = await validateHelper(helperPath, expectedSha256);
    if (!Number.isSafeInteger(expectedUid) || expectedUid < 0) {
      fail('invalid_native_helper', 'expected peer UID is invalid');
    }
    if (expectedGid !== undefined && (!Number.isSafeInteger(expectedGid) || expectedGid < 0)) {
      fail('invalid_native_helper', 'expected peer GID is invalid');
    }
    if (typeof resolvePrincipal !== 'function') {
      fail('invalid_native_helper', 'trusted peer-to-run principal resolver is required');
    }
    return new NativeSecurityBoundary({
      helperPath,
      helperOwnerUid,
      helperSha256: expectedSha256,
      expectedUid,
      expectedGid,
      resolvePrincipal,
    });
  }

  constructor({ helperPath, helperOwnerUid, helperSha256, expectedUid, expectedGid, resolvePrincipal }) {
    this.#helperPath = helperPath;
    this.#helperOwnerUid = helperOwnerUid;
    this.#helperSha256 = helperSha256;
    this.#expectedUid = expectedUid;
    this.#expectedGid = expectedGid;
    this.#resolvePrincipal = resolvePrincipal;
  }

  async secretManagerWriter({
    executablePath,
    executableSha256,
    childPath,
    childSha256,
    timeoutMs = 30_000,
  }) {
    if (
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000 ||
      executablePath === childPath
    ) {
      fail('invalid_native_helper', 'Secret Manager writer contract is invalid');
    }
    if (this.#helperOwnerUid !== 0 || !SHA256.test(this.#helperSha256 ?? '')) {
      fail(
        'invalid_native_helper',
        'Secret Manager writer requires an SHA-256 pinned root-owned native helper',
      );
    }
    await Promise.all([
      validateTrustedImageFile(
        this.#helperPath,
        this.#helperSha256,
        'Secret Manager writer native helper',
      ),
      validateTrustedImageFile(
        executablePath,
        executableSha256,
        'Secret Manager writer executable',
      ),
      validateTrustedImageFile(
        childPath,
        childSha256,
        'Secret Manager writer child',
      ),
    ]);
    const helperPath = this.#helperPath;
    const helperSha256 = this.#helperSha256;
    const identity = Object.freeze({
      mode: 'native-secret-manager-writer-v1',
      executablePath,
      executableSha256,
      childPath,
      childSha256,
    });
    return Object.freeze({
      identity,
      async writeVersion({ resourceName, expectedVersion, material }) {
        const ownedMaterial = material;
        let resourceLocked = false;
        let helperImage;
        let executableImage;
        let childImage;
        let child;
        let completion;
        let timer;
        const resultChunks = [];
        try {
          if (!Buffer.isBuffer(ownedMaterial) || ownedMaterial.length < 16 || ownedMaterial.length > 4_096) {
            fail('secret_write_failed', 'Secret Manager write material is invalid');
          }
          if (!SECRET_MANAGER_SECRET.test(resourceName ?? '')) {
            fail('secret_write_failed', 'Secret Manager write resource binding is invalid');
          }
          if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
            fail('secret_write_failed', 'Secret Manager expected version is invalid');
          }
          const expectedDataCrc32c = crc32c(ownedMaterial);
          if (ACTIVE_SECRET_MANAGER_RESOURCES.has(resourceName)) {
            fail('secret_write_failed', 'duplicate concurrent Secret Manager write is forbidden');
          }
          ACTIVE_SECRET_MANAGER_RESOURCES.add(resourceName);
          resourceLocked = true;
          helperImage = await openTrustedImageFile(
            helperPath,
            helperSha256,
            'Secret Manager writer native helper',
          );
          executableImage = await openTrustedImageFile(
            executablePath,
            executableSha256,
            'Secret Manager writer executable',
          );
          childImage = await openTrustedImageFile(
            childPath,
            childSha256,
            'Secret Manager writer child',
          );
          const [helperPathStat, executablePathStat, childPathStat] = await Promise.all([
            lstat(helperPath),
            lstat(executablePath),
            lstat(childPath),
          ]);
          const [helperImageStat, executableImageStat, childImageStat] = await Promise.all([
            helperImage.stat(),
            executableImage.stat(),
            childImage.stat(),
          ]);
          if (
            helperPathStat.isSymbolicLink() || executablePathStat.isSymbolicLink() ||
            childPathStat.isSymbolicLink() ||
            helperPathStat.dev !== helperImageStat.dev ||
            helperPathStat.ino !== helperImageStat.ino ||
            executablePathStat.dev !== executableImageStat.dev ||
            executablePathStat.ino !== executableImageStat.ino ||
            childPathStat.dev !== childImageStat.dev || childPathStat.ino !== childImageStat.ino
          ) {
            fail('native_helper_mismatch', 'trusted Secret Manager writer image changed before launch');
          }
          child = spawn(process.platform === 'linux' ? '/proc/self/fd/7' : helperPath, [
            'launch-verified-writer', '--', executablePath, childPath,
            `--resource=${resourceName}`, `--expected-version=${expectedVersion}`,
          ], {
            env: {
              LANG: 'C.UTF-8',
              SEORI_AUTH_SECRET_FD: '3',
              SEORI_AUTH_RESULT_FD: '5',
            },
            shell: false,
            stdio: [
              childImage.fd,
              'ignore',
              'ignore',
              'pipe',
              'ignore',
              'pipe',
              executableImage.fd,
              helperImage.fd,
            ],
            windowsHide: true,
          });
          completion = new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({ code, signal }));
          });
          await Promise.all([helperImage.close(), executableImage.close(), childImage.close()]);
          helperImage = undefined;
          executableImage = undefined;
          childImage = undefined;
          timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
          timer.unref();
          const writeComplete = new Promise((resolve, reject) => {
            let settled = false;
            const settle = (callback, value) => {
              if (settled) return;
              settled = true;
              callback(value);
            };
            child.stdio[3].once('error', (error) => settle(reject, error));
            child.stdio[3].end(ownedMaterial, () => settle(resolve));
          });
          const publicResult = (async () => {
            let size = 0;
            for await (const chunk of child.stdio[5]) {
              size += chunk.length;
              if (size > MAX_SECRET_MANAGER_WRITE_RESULT_BYTES) {
                child.kill('SIGKILL');
                fail('secret_write_failed', 'Secret Manager writer public result exceeded its bound');
              }
              resultChunks.push(Buffer.from(chunk));
              if (Buffer.isBuffer(chunk)) chunk.fill(0);
            }
            try {
              return JSON.parse(Buffer.concat(resultChunks).toString('utf8'));
            } catch {
              fail('secret_write_failed', 'Secret Manager writer public result was malformed');
            }
          })();
          const [, result, processResult] = await Promise.all([
            writeComplete,
            publicResult,
            completion,
          ]);
          if (processResult.code !== 0 || processResult.signal !== null) {
            fail('secret_write_failed', 'trusted Secret Manager writer failed');
          }
          return normalizeSecretManagerWriteResult(
            result,
            resourceName,
            expectedVersion,
            expectedDataCrc32c,
          );
        } catch (error) {
          child?.kill('SIGKILL');
          await completion?.catch(() => {});
          if (error?.code === 'secret_write_failed') throw error;
          fail('secret_write_failed', 'trusted Secret Manager writer failed');
        } finally {
          clearTimeout(timer);
          await Promise.all([
            helperImage?.close().catch(() => {}),
            executableImage?.close().catch(() => {}),
            childImage?.close().catch(() => {}),
          ]);
          if (resourceLocked) ACTIVE_SECRET_MANAGER_RESOURCES.delete(resourceName);
          for (const chunk of resultChunks) chunk.fill(0);
          if (Buffer.isBuffer(ownedMaterial)) ownedMaterial.fill(0);
        }
      },
    });
  }

  launcher() {
    return Object.freeze({
      executable: this.#helperPath,
      mode: 'non-dumpable-v1',
      [NATIVE_LAUNCHER_BRAND]: true,
    });
  }

  async secretManagerAccessor({
    nodeSha256,
    childSha256,
    configSha256,
    nodePath = SECRET_MANAGER_NODE,
    childPath = SECRET_MANAGER_CHILD,
    configPath = SECRET_MANAGER_CONFIG,
    timeoutMs = 30_000,
  }) {
    if (
      nodePath !== SECRET_MANAGER_NODE || childPath !== SECRET_MANAGER_CHILD ||
      configPath !== SECRET_MANAGER_CONFIG || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1_000 || timeoutMs > 60_000
    ) {
      fail('invalid_native_helper', 'Secret Manager child contract is not the fixed image contract');
    }
    await Promise.all([
      validateTrustedImageFile(nodePath, nodeSha256, 'Secret Manager Node executable'),
      validateTrustedImageFile(childPath, childSha256, 'Secret Manager child'),
      validateTrustedImageFile(configPath, configSha256, 'Secret Manager access config'),
    ]);
    const helperPath = this.#helperPath;
    const activeResources = new Set();
    return Object.freeze({
      async accessVersion({ resourceName }) {
        if (!SECRET_MANAGER_RESOURCE.test(resourceName ?? '')) {
          fail('secret_load_failed', 'Secret Manager resource binding is invalid');
        }
        if (activeResources.has(resourceName)) {
          fail('secret_load_failed', 'duplicate concurrent Secret Manager execution is forbidden');
        }
        activeResources.add(resourceName);
        const chunks = [];
        let size = 0;
        let timer;
        let child;
        let completion;
        try {
          child = spawn(helperPath, [
            'launch-with-projected-token', '--', nodePath, childPath,
            `--config=${configPath}`, `--resource=${resourceName}`,
          ], {
            env: { LANG: 'C.UTF-8' },
            shell: false,
            stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
            windowsHide: true,
          });
          completion = new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({ code, signal }));
          });
          timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
          timer.unref();
          for await (const chunk of child.stdio[3]) {
            size += chunk.length;
            if (size > MAX_EXECUTION_COPY_BYTES) {
              child.kill('SIGKILL');
              fail('secret_load_failed', 'Secret Manager execution copy exceeded its bound');
            }
            chunks.push(Buffer.from(chunk));
            if (Buffer.isBuffer(chunk)) chunk.fill(0);
          }
          const result = await completion;
          if (result.code !== 0 || result.signal !== null || size === 0) {
            fail('secret_load_failed', 'trusted Secret Manager child failed');
          }
          const secret = Buffer.concat(chunks);
          for (const chunk of chunks) chunk.fill(0);
          return secret;
        } catch (error) {
          child?.kill('SIGKILL');
          await completion?.catch(() => {});
          for (const chunk of chunks) chunk.fill(0);
          if (error?.code === 'secret_load_failed') throw error;
          fail('secret_load_failed', 'trusted Secret Manager child failed');
        } finally {
          clearTimeout(timer);
          activeResources.delete(resourceName);
        }
      },
    });
  }

  browserAdapter({
    execute,
    terminate,
    timeoutMs = 120_000,
    terminationTimeoutMs = 10_000,
  }) {
    if (typeof execute !== 'function' || typeof terminate !== 'function') {
      fail('invalid_browser_adapter', 'native browser adapter requires execute and terminate callbacks');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 300_000) {
      fail('invalid_browser_adapter', 'browser adapter timeout must be between 10 and 300000 milliseconds');
    }
    if (
      !Number.isSafeInteger(terminationTimeoutMs) || terminationTimeoutMs < 10 ||
      terminationTimeoutMs > 30_000
    ) {
      fail(
        'invalid_browser_adapter',
        'browser adapter termination timeout must be between 10 and 30000 milliseconds',
      );
    }
    return Object.freeze({
      execute,
      terminate,
      timeoutMs,
      terminationTimeoutMs,
      launcher: this.launcher(),
      [NATIVE_BROWSER_ADAPTER_BRAND]: true,
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
        const flags = fsConstants.O_RDWR | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0);
        let lockHandle;
        try {
          lockHandle = await fsOpen(path, flags, 0o600);
          const lockStat = await lockHandle.stat();
          if (
            !lockStat.isFile() || (lockStat.mode & 0o077) !== 0 ||
            lockStat.uid !== process.getuid?.()
          ) {
            fail('insecure_native_lock', 'native lock file must be a private owned regular file');
          }
        } catch (error) {
          if (lockHandle) await lockHandle.close().catch(() => {});
          if (error instanceof Error && 'code' in error && error.code === 'ELOOP') {
            fail('insecure_native_lock', 'native lock path must not be a symbolic link');
          }
          throw error;
        }
        const child = spawn(helperPath, ['acquire-lock-fd'], {
          env: { LANG: 'C.UTF-8' },
          shell: false,
          stdio: ['ignore', 'pipe', 'ignore', lockHandle.fd],
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
              child.once('close', () => {
                if (!encoded.includes('\n')) reject(new Error('lock helper exited before acquisition'));
              });
            }),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('lock acquisition timed out')), LOCK_READY_TIMEOUT_MS);
              timer.unref();
            }),
          ]);
          const result = await closed;
          if (
            JSON.parse(ready.trim()).locked !== true ||
            result.code !== 0 || result.signal !== null
          ) throw new Error('invalid lock readiness');
        } catch {
          child.kill('SIGKILL');
          const result = await closed;
          await lockHandle.close().catch(() => {});
          if (result.code === 75 && result.signal === null) {
            fail('browser_account_in_use', 'provider account lock is already held');
          }
          fail('insecure_browser_vault', 'native account lock boundary failed');
        } finally {
          clearTimeout(timer);
        }
        return Object.freeze({
          assertHeld() {
            if (released) {
              fail('native_lock_lost', 'native advisory lock is no longer held');
            }
          },
          async release() {
            if (released) return;
            released = true;
            await lockHandle.close();
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
