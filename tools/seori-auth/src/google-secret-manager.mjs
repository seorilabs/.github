import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { ProxyAgent } from 'undici';

import { fail } from './errors.mjs';
import { isLogicalCredentialRef } from './validation.mjs';

const WIF_AUDIENCE = /^\/\/iam\.googleapis\.com\/projects\/[1-9][0-9]*\/locations\/global\/workloadIdentityPools\/[A-Za-z0-9_-]+\/providers\/[A-Za-z0-9_-]+$/;
const SECRET_MANAGER_VERSION = /^projects\/[A-Za-z0-9._:-]+\/secrets\/[A-Za-z0-9_-]+\/versions\/[1-9][0-9]*$/;
const IMPERSONATION_URL = /^https:\/\/iamcredentials\.googleapis\.com\/v1\/projects\/-\/serviceAccounts\/[A-Za-z0-9._%+-]+%40[A-Za-z0-9.-]+:generateAccessToken$/;
const ACCESS_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const PROXY_SERVER_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

function crc32c(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
    }
  }
  return BigInt((crc ^ 0xffffffff) >>> 0);
}

async function readProjectedToken(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    fail('workload_identity_unavailable', 'projected workload token path must be absolute');
  }
  const [entry, canonical] = await Promise.all([lstat(path), realpath(path)]);
  const target = await stat(canonical);
  if (
    !entry.isFile() || entry.isSymbolicLink() || canonical !== path || !target.isFile() ||
    target.size < 32 || target.size > 32 * 1024 || (target.mode & 0o007) !== 0
  ) {
    fail('workload_identity_unavailable', 'projected workload token file is not private and canonical');
  }
  const bytes = await readFile(path);
  try {
    const token = bytes.toString('utf8').trim();
    if (token.length < 32 || token.length > 32 * 1024 || /\s/.test(token)) {
      fail('workload_identity_unavailable', 'projected workload token is invalid');
    }
    return token;
  } finally {
    bytes.fill(0);
  }
}

async function readProxyTlsFile(path, { privateMaterial = false } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    fail('invalid_egress_proxy', 'egress proxy TLS paths must be absolute');
  }
  const [entry, canonical] = await Promise.all([lstat(path), realpath(path)]);
  const target = await stat(canonical);
  if (!entry.isFile() || entry.isSymbolicLink() || canonical !== path || !target.isFile()) {
    fail('invalid_egress_proxy', 'egress proxy TLS material must be a canonical regular file');
  }
  if (privateMaterial && ((target.mode & 0o007) !== 0 || (target.mode & 0o022) !== 0)) {
    fail('invalid_egress_proxy', 'egress proxy private key permissions are unsafe');
  }
  return readFile(path);
}

export async function createMtlsEgressProxy({ uri, caPath, certificatePath, privateKeyPath, serverName }) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    fail('invalid_egress_proxy', 'egress proxy URL is invalid');
  }
  if (
    parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' ||
    parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '' ||
    !PROXY_SERVER_NAME.test(serverName ?? '') || parsed.hostname !== serverName
  ) {
    fail('invalid_egress_proxy', 'egress proxy must be one exact HTTPS origin');
  }
  const [ca, cert, key] = await Promise.all([
    readProxyTlsFile(caPath),
    readProxyTlsFile(certificatePath),
    readProxyTlsFile(privateKeyPath, { privateMaterial: true }),
  ]);
  let dispatcher;
  try {
    dispatcher = new ProxyAgent({
      uri: parsed.origin,
      proxyTls: {
        ca,
        cert,
        key,
        servername: serverName,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        rejectUnauthorized: true,
      },
      requestTls: {
        minVersion: 'TLSv1.3',
        rejectUnauthorized: true,
      },
    });
  } catch {
    ca.fill(0);
    cert.fill(0);
    key.fill(0);
    fail('invalid_egress_proxy', 'egress proxy dispatcher could not be created');
  }
  let closed = false;
  return Object.freeze({
    fetch(url, options = {}) {
      if (closed) fail('invalid_egress_proxy', 'egress proxy dispatcher is closed');
      return globalThis.fetch(url, { ...options, dispatcher });
    },
    async close() {
      if (closed) return;
      closed = true;
      await dispatcher.close();
      ca.fill(0);
      cert.fill(0);
      key.fill(0);
    },
  });
}

async function publicJsonResponse(response, errorCode) {
  if (!response?.ok) fail(errorCode, 'trusted Google API request failed');
  try {
    return await response.json();
  } catch {
    fail(errorCode, 'trusted Google API returned invalid JSON');
  }
}

export class GoogleWorkloadIdentityTokenProvider {
  #subjectTokenFile;
  #readSubjectToken;
  #audience;
  #impersonationUrl;
  #fetch;
  #clock;
  #cached;

  constructor({ subjectTokenFile, readSubjectToken, audience, impersonationUrl, fetchImpl = globalThis.fetch, clock = () => Date.now() }) {
    if (
      !WIF_AUDIENCE.test(audience ?? '') || typeof fetchImpl !== 'function' || typeof clock !== 'function' ||
      ((subjectTokenFile === undefined) === (readSubjectToken === undefined)) ||
      (readSubjectToken !== undefined && typeof readSubjectToken !== 'function')
    ) {
      throw new TypeError('Google workload identity configuration is invalid');
    }
    if (impersonationUrl !== undefined && !IMPERSONATION_URL.test(impersonationUrl)) {
      throw new TypeError('Google service account impersonation URL is invalid');
    }
    this.#subjectTokenFile = subjectTokenFile;
    this.#readSubjectToken = readSubjectToken;
    this.#audience = audience;
    this.#impersonationUrl = impersonationUrl;
    this.#fetch = fetchImpl;
    this.#clock = clock;
  }

  async accessToken() {
    const now = this.#clock();
    if (!Number.isSafeInteger(now)) fail('workload_identity_unavailable', 'trusted workload identity clock is invalid');
    if (this.#cached && this.#cached.expiresAt - now > 60_000) return this.#cached.token;
    let subjectToken;
    try {
      subjectToken = this.#readSubjectToken
        ? await this.#readSubjectToken()
        : await readProjectedToken(this.#subjectTokenFile);
    } catch {
      fail('workload_identity_unavailable', 'projected workload token could not be read');
    }
    if (typeof subjectToken !== 'string' || subjectToken.length < 32 || subjectToken.length > 32 * 1024 || /\s/.test(subjectToken)) {
      fail('workload_identity_unavailable', 'projected workload token is invalid');
    }
    const sts = await publicJsonResponse(await this.#fetch('https://sts.googleapis.com/v1/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        audience: this.#audience,
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        scope: ACCESS_SCOPE,
        subject_token: subjectToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      }),
      redirect: 'error',
    }), 'workload_identity_unavailable');
    if (
      typeof sts.access_token !== 'string' || sts.access_token.length < 16 ||
      !Number.isSafeInteger(sts.expires_in) || sts.expires_in < 60 || sts.expires_in > 3_600
    ) {
      fail('workload_identity_unavailable', 'Google STS response is invalid');
    }
    let token = sts.access_token;
    let expiresAt = now + sts.expires_in * 1_000;
    if (this.#impersonationUrl) {
      const impersonated = await publicJsonResponse(await this.#fetch(this.#impersonationUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ delegates: [], lifetime: '900s', scope: [ACCESS_SCOPE] }),
        redirect: 'error',
      }), 'workload_identity_unavailable');
      const parsedExpiry = Date.parse(impersonated.expireTime);
      if (typeof impersonated.accessToken !== 'string' || impersonated.accessToken.length < 16 || !Number.isFinite(parsedExpiry)) {
        fail('workload_identity_unavailable', 'Google impersonation response is invalid');
      }
      token = impersonated.accessToken;
      expiresAt = parsedExpiry;
    }
    this.#cached = Object.freeze({ token, expiresAt });
    return token;
  }
}

export class GoogleSecretManagerExecutionStore {
  #bindings = new Map();
  #resources = new Set();
  #tokens;
  #fetch;

  constructor({ bindings, tokenProvider, fetchImpl = globalThis.fetch }) {
    if (!Array.isArray(bindings) || bindings.length === 0 || typeof tokenProvider?.accessToken !== 'function' || typeof fetchImpl !== 'function') {
      fail('invalid_factor_service', 'Secret Manager store requires trusted bindings and workload identity');
    }
    for (const binding of bindings) {
      if (
        !binding || typeof binding !== 'object' || Array.isArray(binding) ||
        Object.keys(binding).sort().join(',') !== 'credentialGeneration,credentialRef,resourceName' ||
        !isLogicalCredentialRef(binding.credentialRef) || !Number.isSafeInteger(binding.credentialGeneration) ||
        binding.credentialGeneration < 1 || !SECRET_MANAGER_VERSION.test(binding.resourceName ?? '')
      ) {
        fail('invalid_factor_binding', 'Secret Manager execution binding is invalid');
      }
      const key = `${binding.credentialRef}\0${binding.credentialGeneration}`;
      if (this.#bindings.has(key) || this.#resources.has(binding.resourceName)) {
        fail('invalid_factor_binding', 'Secret Manager execution binding is duplicated');
      }
      this.#bindings.set(key, binding.resourceName);
      this.#resources.add(binding.resourceName);
    }
    this.#tokens = tokenProvider;
    this.#fetch = fetchImpl;
  }

  generation(credentialRef) {
    const prefix = `${credentialRef}\0`;
    const matches = [...this.#bindings.keys()].filter((key) => key.startsWith(prefix));
    if (matches.length !== 1) fail('credential_generation_unavailable', 'logical credential generation is unavailable');
    return Number(matches[0].slice(prefix.length));
  }

  async loadSecret({ credentialRef, credentialGeneration }) {
    const resourceName = this.#bindings.get(`${credentialRef}\0${credentialGeneration}`);
    if (!resourceName) fail('secret_load_failed', 'logical credential has no exact Secret Manager binding');
    return this.accessVersion({ resourceName });
  }

  async accessVersion({ resourceName }) {
    if (!this.#resources.has(resourceName)) fail('secret_load_failed', 'Secret Manager resource is outside the trusted binding set');
    const token = await this.#tokens.accessToken();
    const response = await publicJsonResponse(await this.#fetch(
      `https://secretmanager.googleapis.com/v1/${resourceName}:access`,
      { headers: { authorization: `Bearer ${token}` }, redirect: 'error' },
    ), 'secret_load_failed');
    if (
      !response.payload || typeof response.payload.data !== 'string' ||
      typeof response.payload.dataCrc32c !== 'string' || !/^[0-9]+$/.test(response.payload.dataCrc32c)
    ) {
      fail('secret_load_failed', 'Secret Manager payload is invalid');
    }
    const secret = Buffer.from(response.payload.data, 'base64');
    if (secret.length === 0 || secret.toString('base64').replace(/=+$/, '') !== response.payload.data.replace(/=+$/, '')) {
      secret.fill(0);
      fail('secret_load_failed', 'Secret Manager payload encoding is invalid');
    }
    if (crc32c(secret) !== BigInt(response.payload.dataCrc32c)) {
      secret.fill(0);
      fail('secret_load_failed', 'Secret Manager payload checksum mismatch');
    }
    return secret;
  }
}

export class NativeSecretManagerExecutionStore {
  #bindings = new Map();
  #resources = new Set();
  #accessor;

  constructor({ bindings, accessor }) {
    if (!Array.isArray(bindings) || bindings.length === 0 || typeof accessor?.accessVersion !== 'function') {
      fail('invalid_factor_service', 'native Secret Manager store requires trusted bindings and accessor');
    }
    for (const binding of bindings) {
      if (
        !binding || typeof binding !== 'object' || Array.isArray(binding) ||
        Object.keys(binding).sort().join(',') !== 'credentialGeneration,credentialRef,resourceName' ||
        !isLogicalCredentialRef(binding.credentialRef) || !Number.isSafeInteger(binding.credentialGeneration) ||
        binding.credentialGeneration < 1 || !SECRET_MANAGER_VERSION.test(binding.resourceName ?? '')
      ) {
        fail('invalid_factor_binding', 'native Secret Manager execution binding is invalid');
      }
      const key = `${binding.credentialRef}\0${binding.credentialGeneration}`;
      if (this.#bindings.has(key) || this.#resources.has(binding.resourceName)) {
        fail('invalid_factor_binding', 'native Secret Manager execution binding is duplicated');
      }
      this.#bindings.set(key, binding.resourceName);
      this.#resources.add(binding.resourceName);
    }
    this.#accessor = accessor;
  }

  generation(credentialRef) {
    const prefix = `${credentialRef}\0`;
    const matches = [...this.#bindings.keys()].filter((key) => key.startsWith(prefix));
    if (matches.length !== 1) fail('credential_generation_unavailable', 'logical credential generation is unavailable');
    return Number(matches[0].slice(prefix.length));
  }

  loadSecret({ credentialRef, credentialGeneration }) {
    const resourceName = this.#bindings.get(`${credentialRef}\0${credentialGeneration}`);
    if (!resourceName) fail('secret_load_failed', 'logical credential has no exact Secret Manager binding');
    return this.accessVersion({ resourceName });
  }

  accessVersion({ resourceName }) {
    if (!this.#resources.has(resourceName)) fail('secret_load_failed', 'Secret Manager resource is outside the trusted binding set');
    return this.#accessor.accessVersion({ resourceName });
  }
}
