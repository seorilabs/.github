import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open as fsOpen,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { normalizeExecutionBinding, normalizePublicIdentity } from './durable-state.mjs';
import { fail, SeoriAuthError } from './errors.mjs';
import { LEASE_TTL_MS } from './lease-store.mjs';

const ROLE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const ENVELOPE_KEYS = ['algorithm', 'ciphertext', 'iv', 'tag', 'version'];

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function assertRole(role) {
  if (typeof role !== 'string' || !ROLE.test(role)) {
    fail('invalid_browser_profile', 'browser profile role is invalid');
  }
  return role;
}

function normalizeCapabilityId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/.test(value)) {
    fail('invalid_browser_vault', 'browser capability id is invalid');
  }
  return value;
}

function assertPrivateDirectory(stat, label) {
  if (
    !stat.isDirectory() || stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()
  ) {
    fail('insecure_browser_vault', `${label} must be a private non-symlink directory`);
  }
}

async function secureDirectory(path, label) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(await lstat(path), label);
  const canonical = await realpath(path);
  assertPrivateDirectory(await lstat(canonical), label);
  return canonical;
}

function isNestedPath(parent, child) {
  const childRelative = relative(parent, child);
  return childRelative === '' || (!childRelative.startsWith(`..${sep}`) && childRelative !== '..');
}

function scopedDigest(key, scope, fields) {
  return createHmac('sha256', key)
    .update(scope, 'utf8')
    .update('\0', 'utf8')
    .update(fields.join('\0'), 'utf8')
    .digest('hex');
}

function profileDigest(key, identity, role) {
  return scopedDigest(key, 'seori-auth-browser-profile-v1', [
    identity.provider,
    identity.accountId,
    role,
  ]);
}

function accountDigest(key, identity) {
  return scopedDigest(key, 'seori-auth-browser-account-lock-v1', [
    identity.provider,
    identity.accountId,
  ]);
}

function safeProfilePath(path) {
  if (
    typeof path !== 'string' || path.length === 0 || path.includes('\0') || isAbsolute(path) ||
    path === '..' || path.startsWith(`..${sep}`) || resolve('/', path) === '/'
  ) {
    fail('invalid_browser_profile', 'encrypted browser profile contains an unsafe path');
  }
  const normalized = relative('/', resolve('/', path));
  if (normalized !== path) {
    fail('invalid_browser_profile', 'encrypted browser profile path is not normalized');
  }
  return path;
}

async function collectFiles(root, { maxFiles, maxBytes }) {
  assertPrivateDirectory(await lstat(root), 'browser profile source');
  const files = [];
  let totalBytes = 0;

  async function visit(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = prefix === '' ? entry.name : join(prefix, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        fail('invalid_browser_profile', 'browser profile must not contain symbolic links');
      }
      if (stat.isDirectory()) {
        await visit(absolute, path);
        continue;
      }
      if (!stat.isFile()) {
        fail('invalid_browser_profile', 'browser profile must contain only regular files');
      }
      totalBytes += stat.size;
      if (files.length + 1 > maxFiles || totalBytes > maxBytes) {
        fail('browser_profile_too_large', 'browser profile exceeds the configured size bound');
      }
      const handle = await fsOpen(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      let data;
      try {
        const openedStat = await handle.stat();
        if (!openedStat.isFile() || openedStat.size !== stat.size) {
          fail('invalid_browser_profile', 'browser profile changed while it was being sealed');
        }
        data = await handle.readFile();
        files.push({ path: safeProfilePath(path), data: data.toString('base64') });
      } finally {
        if (Buffer.isBuffer(data)) data.fill(0);
        await handle.close();
      }
    }
  }

  await visit(root);
  return files;
}

function decodeProfile(plaintext, expectedIdentity, expectedRole, { maxFiles, maxBytes }) {
  let profile;
  try {
    profile = JSON.parse(plaintext.toString('utf8'));
  } catch {
    fail('invalid_browser_profile', 'encrypted browser profile is malformed');
  }
  if (
    !exactKeys(profile, ['files', 'generation', 'publicIdentity', 'role', 'version']) ||
    profile.version !== 1 || profile.role !== expectedRole ||
    !Number.isSafeInteger(profile.generation) || profile.generation < 1 ||
    !Array.isArray(profile.files) || profile.files.length > maxFiles ||
    !isDeepStrictEqual(normalizePublicIdentity(profile.publicIdentity), expectedIdentity)
  ) {
    fail('invalid_browser_profile', 'encrypted browser profile binding is invalid');
  }
  const paths = new Set();
  let totalBytes = 0;
  const files = [];
  try {
    for (const file of profile.files) {
      if (!exactKeys(file, ['data', 'path']) || typeof file.data !== 'string') {
        fail('invalid_browser_profile', 'encrypted browser profile entry is invalid');
      }
      const path = safeProfilePath(file.path);
      if (paths.has(path)) fail('invalid_browser_profile', 'encrypted browser profile contains duplicate paths');
      paths.add(path);
      const data = Buffer.from(file.data, 'base64');
      if (data.toString('base64') !== file.data) {
        data.fill(0);
        fail('invalid_browser_profile', 'encrypted browser profile data is invalid');
      }
      totalBytes += data.length;
      if (totalBytes > maxBytes) {
        data.fill(0);
        fail('browser_profile_too_large', 'browser profile exceeds the configured size bound');
      }
      files.push({ path, data });
    }
    return { generation: profile.generation, files };
  } catch (error) {
    for (const file of files) file.data.fill(0);
    throw error;
  }
}

function encryptProfile(key, profileKey, payload) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`seori-auth-browser-vault-v1\0${profileKey}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const envelope = {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  iv.fill(0);
  ciphertext.fill(0);
  return Buffer.from(JSON.stringify(envelope), 'utf8');
}

function decryptProfile(key, profileKey, encoded) {
  let envelope;
  try {
    envelope = JSON.parse(encoded.toString('utf8'));
  } catch {
    fail('invalid_browser_profile', 'encrypted browser profile envelope is malformed');
  }
  if (
    !exactKeys(envelope, ENVELOPE_KEYS) || envelope.version !== 1 ||
    envelope.algorithm !== 'aes-256-gcm'
  ) {
    fail('invalid_browser_profile', 'encrypted browser profile envelope is invalid');
  }
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  if (iv.length !== 12 || tag.length !== 16) {
    iv.fill(0);
    tag.fill(0);
    ciphertext.fill(0);
    fail('invalid_browser_profile', 'encrypted browser profile envelope is invalid');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(`seori-auth-browser-vault-v1\0${profileKey}`, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    fail('invalid_browser_profile', 'encrypted browser profile could not be authenticated');
  } finally {
    iv.fill(0);
    tag.fill(0);
    ciphertext.fill(0);
  }
}

async function atomicPrivateWrite(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fsOpen(
    temporary,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    try {
      await handle.writeFile(value);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function materializeClone(directory, files) {
  try {
    for (const { path, data } of files) {
      const destination = join(directory, path);
      if (!isNestedPath(directory, destination)) {
        fail('invalid_browser_profile', 'browser profile path escapes its ephemeral clone');
      }
      await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 });
      const handle = await fsOpen(
        destination,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  } finally {
    for (const file of files) file.data.fill(0);
  }
}

async function readPrivateRegularFile(path, label) {
  const handle = await fsOpen(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
      fail('insecure_browser_vault', `${label} must be a private regular file`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export class EncryptedBrowserVault {
  #vaultDirectory;
  #runtimeDirectory;
  #lockDirectory;
  #key;
  #clock;
  #idFactory;
  #ttlMs;
  #maxFiles;
  #maxBytes;
  #checkouts = new Map();
  #closed = false;

  static async open({
    vaultDirectory,
    runtimeDirectory,
    encryptionKey,
    clock = () => Date.now(),
    idFactory = () => randomUUID(),
    ttlMs = LEASE_TTL_MS,
    maxFiles = 4_096,
    maxBytes = 128 * 1024 * 1024,
  }) {
    if (
      typeof vaultDirectory !== 'string' || typeof runtimeDirectory !== 'string' ||
      !isAbsolute(vaultDirectory) || !isAbsolute(runtimeDirectory)
    ) {
      fail('invalid_browser_vault', 'browser vault and runtime paths must be absolute');
    }
    if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) {
      fail('invalid_browser_vault', 'browser vault encryption key must be a 32-byte Buffer');
    }
    if (
      !Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > LEASE_TTL_MS ||
      !Number.isSafeInteger(maxFiles) || maxFiles < 1 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      typeof clock !== 'function' || typeof idFactory !== 'function'
    ) {
      fail('invalid_browser_vault', 'browser vault limits are invalid');
    }
    const vault = await secureDirectory(resolve(vaultDirectory), 'browser vault');
    const runtime = await secureDirectory(resolve(runtimeDirectory), 'browser runtime');
    if (isNestedPath(vault, runtime) || isNestedPath(runtime, vault)) {
      fail('invalid_browser_vault', 'persistent vault and ephemeral runtime must be separate paths');
    }
    const lockDirectory = await secureDirectory(join(runtime, '.locks'), 'browser account lock directory');
    return new EncryptedBrowserVault({
      vaultDirectory: vault,
      runtimeDirectory: runtime,
      lockDirectory,
      encryptionKey: Buffer.from(encryptionKey),
      clock,
      idFactory,
      ttlMs,
      maxFiles,
      maxBytes,
    });
  }

  constructor(options) {
    this.#vaultDirectory = options.vaultDirectory;
    this.#runtimeDirectory = options.runtimeDirectory;
    this.#lockDirectory = options.lockDirectory;
    this.#key = options.encryptionKey;
    this.#clock = options.clock;
    this.#idFactory = options.idFactory;
    this.#ttlMs = options.ttlMs;
    this.#maxFiles = options.maxFiles;
    this.#maxBytes = options.maxBytes;
  }

  #assertOpen() {
    if (this.#closed) fail('browser_vault_closed', 'browser vault is closed');
  }

  #now() {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      fail('invalid_browser_vault', 'trusted browser vault clock returned an invalid value');
    }
    return now;
  }

  #profilePath(identity, role) {
    return join(this.#vaultDirectory, `${profileDigest(this.#key, identity, role)}.vault`);
  }

  #lockPath(identity) {
    return join(this.#lockDirectory, `${accountDigest(this.#key, identity)}.lock`);
  }

  async #acquireAccountLock(identity, capabilityId, expiresAt) {
    const lockPath = this.#lockPath(identity);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fsOpen(
          lockPath,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
          0o600,
        );
        try {
          await handle.writeFile(JSON.stringify({ capabilityId, expiresAt }));
          await handle.sync();
          return lockPath;
        } catch (error) {
          await unlink(lockPath).catch(() => {});
          throw error;
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let lock;
        try {
          const stat = await lstat(lockPath);
          if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
            fail('insecure_browser_vault', 'browser account lock is not a private regular file');
          }
          const encodedLock = await readPrivateRegularFile(lockPath, 'browser account lock');
          lock = JSON.parse(encodedLock.toString('utf8'));
          encodedLock.fill(0);
        } catch (readError) {
          if (readError.code === 'ENOENT') continue;
          if (readError?.code === 'insecure_browser_vault') throw readError;
          fail('browser_account_in_use', 'browser account lock could not be validated');
        }
        if (!Number.isSafeInteger(lock.expiresAt) || lock.expiresAt > this.#now()) {
          fail('browser_account_in_use', 'provider account already has an active browser checkout');
        }
        await unlink(lockPath).catch((unlinkError) => {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        });
      }
    }
    fail('browser_account_in_use', 'provider account already has an active browser checkout');
  }

  async #releaseCheckout(checkout) {
    await rm(checkout.cloneDirectory, { recursive: true, force: true });
    await this.#releaseAccountLock(checkout.lockPath, checkout.capabilityId);
    this.#checkouts.delete(checkout.capabilityId);
  }

  async #releaseAccountLock(lockPath, capabilityId) {
    let lock;
    try {
      const lockStat = await lstat(lockPath);
      if (!lockStat.isFile() || lockStat.isSymbolicLink() || (lockStat.mode & 0o077) !== 0) {
        fail('insecure_browser_vault', 'browser account lock is not a private regular file');
      }
      const encodedLock = await readPrivateRegularFile(lockPath, 'browser account lock');
      lock = JSON.parse(encodedLock.toString('utf8'));
      encodedLock.fill(0);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      fail('insecure_browser_vault', 'browser account lock could not be verified before release');
    }
    if (lock.capabilityId !== capabilityId) return;
    await unlink(lockPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async #sealDirectory({ sourceDirectory, identity, role, generation }) {
    const files = await collectFiles(sourceDirectory, { maxFiles: this.#maxFiles, maxBytes: this.#maxBytes });
    const payload = Buffer.from(JSON.stringify({
      version: 1,
      generation,
      role,
      publicIdentity: identity,
      files,
    }), 'utf8');
    let encrypted;
    try {
      const key = profileDigest(this.#key, identity, role);
      encrypted = encryptProfile(this.#key, key, payload);
      await atomicPrivateWrite(this.#profilePath(identity, role), encrypted);
    } finally {
      payload.fill(0);
      if (Buffer.isBuffer(encrypted)) encrypted.fill(0);
    }
  }

  async registerProfile({ sourceDirectory, role, publicIdentity, generation = 1 }) {
    this.#assertOpen();
    if (typeof sourceDirectory !== 'string' || !isAbsolute(sourceDirectory)) {
      fail('invalid_browser_profile', 'browser profile source must be an absolute path');
    }
    const sourceStat = await lstat(sourceDirectory);
    assertPrivateDirectory(sourceStat, 'browser profile source');
    const canonicalSource = await realpath(sourceDirectory);
    const identity = normalizePublicIdentity(publicIdentity);
    const normalizedRole = assertRole(role);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      fail('invalid_browser_profile', 'browser profile generation is invalid');
    }
    const registeredCapabilityId = normalizeCapabilityId(this.#idFactory());
    const lockPath = await this.#acquireAccountLock(
      identity,
      registeredCapabilityId,
      this.#now() + this.#ttlMs,
    );
    try {
      await this.#sealDirectory({ sourceDirectory: canonicalSource, identity, role: normalizedRole, generation });
    } finally {
      await this.#releaseAccountLock(lockPath, registeredCapabilityId);
    }
    return Object.freeze({ publicIdentity: identity, generation });
  }

  async checkout({ role, expectedIdentity, expectedGeneration, executionBinding, sourceSha }) {
    this.#assertOpen();
    const identity = normalizePublicIdentity(expectedIdentity);
    const binding = normalizeExecutionBinding(executionBinding);
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1 || !SOURCE_SHA.test(sourceSha ?? '')) {
      fail('invalid_browser_profile', 'browser profile generation or source SHA is invalid');
    }
    const normalizedRole = assertRole(role);
    const checkoutCapabilityId = normalizeCapabilityId(this.#idFactory());
    if (this.#checkouts.has(checkoutCapabilityId)) {
      fail('invalid_browser_vault', 'browser capability id is not unique');
    }
    const now = this.#now();
    const expiresAt = now + this.#ttlMs;
    const lockPath = await this.#acquireAccountLock(identity, checkoutCapabilityId, expiresAt);
    let cloneDirectory;
    try {
      const profileKey = profileDigest(this.#key, identity, normalizedRole);
      const encrypted = await readPrivateRegularFile(
        this.#profilePath(identity, normalizedRole),
        'encrypted browser profile',
      );
      let plaintext;
      try {
        plaintext = decryptProfile(this.#key, profileKey, encrypted);
      } finally {
        encrypted.fill(0);
      }
      let decoded;
      try {
        decoded = decodeProfile(plaintext, identity, normalizedRole, {
          maxFiles: this.#maxFiles,
          maxBytes: this.#maxBytes,
        });
      } finally {
        plaintext.fill(0);
      }
      if (decoded.generation !== expectedGeneration) {
        for (const file of decoded.files) file.data.fill(0);
        fail('browser_profile_generation_mismatch', 'encrypted browser profile generation is stale');
      }
      cloneDirectory = await mkdtemp(join(this.#runtimeDirectory, 'checkout-'));
      await materializeClone(cloneDirectory, decoded.files);
      const checkout = {
        capabilityId: checkoutCapabilityId,
        publicIdentity: identity,
        executionBinding: binding,
        sourceSha,
        role: normalizedRole,
        generation: decoded.generation,
        expiresAt,
        cloneDirectory,
        lockPath,
      };
      this.#checkouts.set(checkoutCapabilityId, checkout);
      return Object.freeze({
        capabilityId: checkoutCapabilityId,
        publicIdentity: identity,
        generation: decoded.generation,
        expiresAt: new Date(expiresAt).toISOString(),
      });
    } catch (error) {
      if (cloneDirectory) await rm(cloneDirectory, { recursive: true, force: true }).catch(() => {});
      await this.#releaseAccountLock(lockPath, checkoutCapabilityId).catch(() => {});
      if (error?.code === 'ENOENT') fail('browser_profile_not_found', 'encrypted browser profile does not exist');
      throw error;
    }
  }

  async withClone({ capabilityId, executionBinding, sourceSha }, trustedOperation) {
    this.#assertOpen();
    const checkout = this.#checkouts.get(normalizeCapabilityId(capabilityId));
    if (!checkout) fail('browser_capability_invalid', 'browser capability is invalid');
    if (
      !SOURCE_SHA.test(sourceSha ?? '') || sourceSha !== checkout.sourceSha ||
      !isDeepStrictEqual(normalizeExecutionBinding(executionBinding), checkout.executionBinding)
    ) {
      fail('browser_session_binding_mismatch', 'browser capability execution binding does not exactly match');
    }
    if (this.#now() >= checkout.expiresAt) {
      await this.#releaseCheckout(checkout);
      fail('browser_capability_expired', 'browser capability has expired');
    }
    if (typeof trustedOperation !== 'function') {
      fail('browser_adapter_untrusted', 'trusted browser adapter operation is required');
    }
    try {
      await trustedOperation(checkout.cloneDirectory);
    } catch (error) {
      if (error instanceof SeoriAuthError) throw error;
      fail('browser_adapter_failed', 'trusted browser adapter operation failed');
    }
    return Object.freeze({ status: 'EXECUTED' });
  }

  async complete({ capabilityId, executionBinding, sourceSha, observedIdentity, persist = true }) {
    this.#assertOpen();
    const checkout = this.#checkouts.get(normalizeCapabilityId(capabilityId));
    if (!checkout) fail('browser_capability_invalid', 'browser capability is invalid or already used');
    if (typeof persist !== 'boolean') fail('invalid_browser_profile', 'browser persist flag is invalid');
    if (
      !SOURCE_SHA.test(sourceSha ?? '') || sourceSha !== checkout.sourceSha ||
      !isDeepStrictEqual(normalizeExecutionBinding(executionBinding), checkout.executionBinding)
    ) {
      fail('browser_session_binding_mismatch', 'browser capability execution binding does not exactly match');
    }
    try {
      if (this.#now() >= checkout.expiresAt) {
        fail('browser_capability_expired', 'browser capability has expired');
      }
      const identity = normalizePublicIdentity(observedIdentity);
      if (!isDeepStrictEqual(identity, checkout.publicIdentity)) {
        fail('identity_readback_mismatch', 'provider identity readback does not match the expected identity');
      }
      if (persist) {
        await this.#sealDirectory({
          sourceDirectory: checkout.cloneDirectory,
          identity: checkout.publicIdentity,
          role: checkout.role,
          generation: checkout.generation + 1,
        });
      }
      return Object.freeze({
        state: 'COMPLETED',
        publicIdentity: checkout.publicIdentity,
        generation: persist ? checkout.generation + 1 : checkout.generation,
      });
    } finally {
      await this.#releaseCheckout(checkout);
    }
  }

  async abort({ capabilityId, executionBinding, sourceSha }) {
    this.#assertOpen();
    const checkout = this.#checkouts.get(normalizeCapabilityId(capabilityId));
    if (!checkout) return Object.freeze({ state: 'ABSENT' });
    if (
      !SOURCE_SHA.test(sourceSha ?? '') || sourceSha !== checkout.sourceSha ||
      !isDeepStrictEqual(normalizeExecutionBinding(executionBinding), checkout.executionBinding)
    ) {
      fail('browser_session_binding_mismatch', 'browser capability execution binding does not exactly match');
    }
    await this.#releaseCheckout(checkout);
    return Object.freeze({ state: 'ABORTED' });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await Promise.all([...this.#checkouts.values()].map((checkout) => this.#releaseCheckout(checkout)));
    } finally {
      this.#key.fill(0);
    }
  }
}
