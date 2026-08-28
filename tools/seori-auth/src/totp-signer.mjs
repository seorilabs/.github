import { createHmac } from 'node:crypto';

import { fail } from './errors.mjs';
import { isLogicalCredentialRef, normalizeHttpsOrigin } from './validation.mjs';

const PROVIDER = /^[a-z0-9][a-z0-9-]*$/;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const SECRET_MANAGER_VERSION = /^projects\/[A-Za-z0-9._:-]+\/secrets\/[A-Za-z0-9_-]+\/versions\/[1-9][0-9]*$/;
const BASE32 = /^[A-Z2-7]{16,128}$/;

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail('invalid_factor_binding', `${label} is invalid`);
  return value;
}

function bindingKey({ credentialRef, credentialGeneration, provider, accountId }) {
  return [credentialRef, credentialGeneration, provider, accountId].join('\0');
}

function decodeBase32(value) {
  if (!BASE32.test(value)) fail('totp_sign_failed', 'TOTP seed execution copy is invalid');
  let bits = 0;
  let accumulator = 0;
  const bytes = [];
  for (const character of value) {
    const code = character.charCodeAt(0);
    const digit = code >= 65 && code <= 90 ? code - 65 : code - 50 + 26;
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0 && accumulator !== 0) fail('totp_sign_failed', 'TOTP seed has non-canonical trailing bits');
  return Buffer.from(bytes);
}

export class SecretManagerTotpSigner {
  #bindings = new Map();
  #accessVersion;
  #clock;

  constructor({ bindings, accessVersion, clock = () => Date.now() }) {
    if (!Array.isArray(bindings) || bindings.length === 0 || typeof accessVersion !== 'function' || typeof clock !== 'function') {
      fail('invalid_factor_service', 'TOTP signer requires trusted bindings, Secret Manager access, and clock');
    }
    for (const raw of bindings) {
      if (!exactKeys(raw, [
        'accountId', 'algorithm', 'credentialGeneration', 'credentialRef', 'digits', 'factor',
        'origins', 'periodSeconds', 'provider', 'resourceName',
      ])) {
        fail('invalid_factor_binding', 'TOTP signer binding fields are invalid');
      }
      if (
        raw.factor !== 'totp' || raw.algorithm !== 'sha1' || ![6, 8].includes(raw.digits) ||
        raw.periodSeconds !== 30 || !isLogicalCredentialRef(raw.credentialRef) ||
        !PROVIDER.test(raw.provider ?? '') || !PUBLIC_ID.test(raw.accountId ?? '') ||
        !SECRET_MANAGER_VERSION.test(raw.resourceName ?? '') || !Array.isArray(raw.origins) ||
        raw.origins.length === 0 || new Set(raw.origins).size !== raw.origins.length
      ) {
        fail('invalid_factor_binding', 'TOTP signer binding is invalid');
      }
      const binding = Object.freeze({
        credentialRef: raw.credentialRef,
        credentialGeneration: positiveInteger(raw.credentialGeneration, 'credential generation'),
        provider: raw.provider,
        accountId: raw.accountId,
        resourceName: raw.resourceName,
        algorithm: raw.algorithm,
        digits: raw.digits,
        periodSeconds: raw.periodSeconds,
        origins: Object.freeze(raw.origins.map((origin) => normalizeHttpsOrigin(origin))),
      });
      const key = bindingKey(binding);
      if (this.#bindings.has(key)) fail('invalid_factor_binding', 'TOTP signer binding is duplicated');
      this.#bindings.set(key, binding);
    }
    this.#accessVersion = accessVersion;
    this.#clock = clock;
  }

  async signCode(request) {
    if (!exactKeys(request, ['accountId', 'credentialGeneration', 'credentialRef', 'origin', 'provider'])) {
      fail('totp_binding_mismatch', 'TOTP signer request fields are invalid');
    }
    const origin = normalizeHttpsOrigin(request.origin);
    const key = bindingKey({
      credentialRef: request.credentialRef,
      credentialGeneration: positiveInteger(request.credentialGeneration, 'credential generation'),
      provider: request.provider,
      accountId: request.accountId,
    });
    const binding = this.#bindings.get(key);
    if (!binding || !binding.origins.includes(origin)) {
      fail('totp_binding_mismatch', 'TOTP request has no exact trusted binding');
    }
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) fail('totp_sign_failed', 'trusted TOTP clock is invalid');
    let executionCopy;
    let seed;
    try {
      executionCopy = await this.#accessVersion(Object.freeze({ resourceName: binding.resourceName }));
      if (!Buffer.isBuffer(executionCopy) || executionCopy.length === 0 || executionCopy.length > 256) {
        fail('totp_sign_failed', 'TOTP seed execution copy is invalid');
      }
      const seedText = executionCopy.toString('ascii');
      seed = decodeBase32(seedText);
      const counter = Math.floor(now / (binding.periodSeconds * 1_000));
      const counterBytes = Buffer.alloc(8);
      counterBytes.writeBigUInt64BE(BigInt(counter));
      const digest = createHmac(binding.algorithm, seed).update(counterBytes).digest();
      counterBytes.fill(0);
      const offset = digest[digest.length - 1] & 0x0f;
      const binary = digest.readUInt32BE(offset) & 0x7fffffff;
      digest.fill(0);
      const code = Buffer.from(String(binary % (10 ** binding.digits)).padStart(binding.digits, '0'), 'ascii');
      const expiresAt = (counter + 1) * binding.periodSeconds * 1_000;
      return Object.freeze({ code, expiresAt });
    } catch (error) {
      if (error?.code === 'totp_binding_mismatch' || error?.code === 'totp_sign_failed') throw error;
      fail('totp_sign_failed', 'TOTP signer could not create a code');
    } finally {
      if (Buffer.isBuffer(executionCopy)) executionCopy.fill(0);
      if (Buffer.isBuffer(seed)) seed.fill(0);
    }
  }
}
