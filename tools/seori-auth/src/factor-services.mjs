import { fail } from './errors.mjs';
import { isLogicalCredentialRef, normalizeHttpsOrigin } from './validation.mjs';

const PROVIDER = /^[a-z0-9][a-z0-9-]*$/;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function publicId(value, label) {
  if (typeof value !== 'string' || !PUBLIC_ID.test(value)) {
    fail('invalid_factor_binding', `${label} is invalid`);
  }
  return value;
}

function generation(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('invalid_factor_binding', 'credential generation is invalid');
  }
  return value;
}

function baseBinding(value, extraKeys) {
  if (!exactKeys(value, ['accountId', 'credentialGeneration', 'credentialRef', 'factor', 'provider', ...extraKeys])) {
    fail('invalid_factor_binding', 'factor service binding fields are invalid');
  }
  if (value.factor !== 'password') {
    fail('invalid_factor_binding', 'password loader accepts password bindings only');
  }
  if (!isLogicalCredentialRef(value.credentialRef)) {
    fail('invalid_factor_binding', 'factor binding requires a logical credential id');
  }
  if (!PROVIDER.test(value.provider ?? '')) {
    fail('invalid_factor_binding', 'factor binding provider is invalid');
  }
  return {
    credentialRef: value.credentialRef,
    credentialGeneration: generation(value.credentialGeneration),
    provider: value.provider,
    accountId: publicId(value.accountId, 'factor binding accountId'),
  };
}

function bindingKey({ credentialRef, credentialGeneration, provider, accountId }) {
  return [credentialRef, credentialGeneration, provider, accountId].join('\0');
}

function requestKey(value) {
  if (!exactKeys(value, ['accountId', 'credentialGeneration', 'credentialRef', 'provider'])) {
    fail('password_binding_mismatch', 'password request fields are invalid');
  }
  if (!isLogicalCredentialRef(value.credentialRef) || !PROVIDER.test(value.provider ?? '')) {
    fail('password_binding_mismatch', 'password request binding is invalid');
  }
  return bindingKey({
    credentialRef: value.credentialRef,
    credentialGeneration: generation(value.credentialGeneration),
    provider: value.provider,
    accountId: publicId(value.accountId, 'password request accountId'),
  });
}

function trustedFunction(value, message) {
  if (typeof value !== 'function') fail('invalid_factor_service', message);
  return value;
}

class BoundPasswordLoader {
  #bindings = new Map();
  #load;

  constructor(bindings, normalizeBinding, load) {
    if (!Array.isArray(bindings) || bindings.length === 0 || typeof load !== 'function') {
      fail('invalid_factor_service', 'password loader requires trusted bindings and reader');
    }
    for (const raw of bindings) {
      const binding = Object.freeze(normalizeBinding(raw));
      const key = bindingKey(binding);
      if (this.#bindings.has(key)) fail('invalid_factor_binding', 'password binding is duplicated');
      this.#bindings.set(key, binding);
    }
    this.#load = load;
  }

  async loadPassword(request) {
    const binding = this.#bindings.get(requestKey(request));
    if (!binding) fail('password_binding_mismatch', 'password request has no exact trusted binding');
    let executionCopy;
    try {
      executionCopy = await this.#load(binding);
    } catch {
      fail('password_load_failed', 'password execution copy could not be loaded');
    }
    if (!Buffer.isBuffer(executionCopy) || executionCopy.length === 0) {
      if (Buffer.isBuffer(executionCopy)) executionCopy.fill(0);
      fail('password_load_failed', 'password reader returned an invalid execution copy');
    }
    const isolated = Buffer.from(executionCopy);
    executionCopy.fill(0);
    return isolated;
  }
}

export class SecretManagerPasswordLoader extends BoundPasswordLoader {
  constructor({ bindings, loadSecret }) {
    const trustedLoadSecret = trustedFunction(loadSecret, 'trusted logical Secret Manager loader is required');
    super(bindings, (raw) => {
      return baseBinding(raw, []);
    }, async (binding) => {
      return trustedLoadSecret(Object.freeze({
        credentialRef: binding.credentialRef,
        credentialGeneration: binding.credentialGeneration,
      }));
    });
  }
}

export class MacOSKeychainPasswordLoader extends BoundPasswordLoader {
  constructor({ bindings, readGenericPassword }) {
    const trustedReadGenericPassword = trustedFunction(
      readGenericPassword,
      'trusted macOS Keychain reader is required',
    );
    super(bindings, (raw) => {
      const binding = baseBinding(raw, ['account', 'service']);
      return {
        ...binding,
        service: publicId(raw.service, 'Keychain service'),
        account: publicId(raw.account, 'Keychain account'),
      };
    }, async (binding) => {
      return trustedReadGenericPassword(Object.freeze({ service: binding.service, account: binding.account }));
    });
  }
}

export class RemoteTotpSignerClient {
  #bindings = new Map();
  #requestCode;

  constructor({ bindings, requestCode }) {
    if (!Array.isArray(bindings) || bindings.length === 0 || typeof requestCode !== 'function') {
      fail('invalid_factor_service', 'TOTP signer client requires trusted bindings and transport');
    }
    for (const raw of bindings) {
      if (!exactKeys(raw, [
        'accountId', 'credentialGeneration', 'credentialRef', 'factor', 'origins', 'provider',
      ])) {
        fail('invalid_factor_binding', 'TOTP signer binding fields are invalid');
      }
      if (
        raw.factor !== 'totp' || !isLogicalCredentialRef(raw.credentialRef) ||
        !PROVIDER.test(raw.provider ?? '') || !Array.isArray(raw.origins) || raw.origins.length === 0
      ) {
        fail('invalid_factor_binding', 'TOTP signer binding is invalid');
      }
      const binding = Object.freeze({
        credentialRef: raw.credentialRef,
        credentialGeneration: generation(raw.credentialGeneration),
        provider: raw.provider,
        accountId: publicId(raw.accountId, 'TOTP binding accountId'),
        origins: Object.freeze(raw.origins.map((origin) => normalizeHttpsOrigin(origin))),
      });
      const key = bindingKey(binding);
      if (this.#bindings.has(key)) fail('invalid_factor_binding', 'TOTP signer binding is duplicated');
      this.#bindings.set(key, binding);
    }
    this.#requestCode = requestCode;
  }

  async signCode(request) {
    if (!exactKeys(request, ['accountId', 'credentialGeneration', 'credentialRef', 'origin', 'provider'])) {
      fail('totp_binding_mismatch', 'TOTP signer request fields are invalid');
    }
    if (!isLogicalCredentialRef(request.credentialRef) || !PROVIDER.test(request.provider ?? '')) {
      fail('totp_binding_mismatch', 'TOTP signer request binding is invalid');
    }
    const origin = normalizeHttpsOrigin(request.origin);
    const key = bindingKey({
      credentialRef: request.credentialRef,
      credentialGeneration: generation(request.credentialGeneration),
      provider: request.provider,
      accountId: publicId(request.accountId, 'TOTP request accountId'),
    });
    const binding = this.#bindings.get(key);
    if (!binding || !binding.origins.includes(origin)) {
      fail('totp_binding_mismatch', 'TOTP request has no exact trusted binding');
    }
    let signed;
    try {
      signed = await this.#requestCode(Object.freeze({
        credentialRef: binding.credentialRef,
        credentialGeneration: binding.credentialGeneration,
        provider: binding.provider,
        accountId: binding.accountId,
        origin,
      }));
    } catch {
      fail('totp_sign_failed', 'TOTP signer service could not create a code');
    }
    if (!exactKeys(signed, ['code', 'expiresAt']) || !Buffer.isBuffer(signed.code)) {
      if (Buffer.isBuffer(signed?.code)) signed.code.fill(0);
      fail('totp_sign_failed', 'TOTP signer service returned an invalid response');
    }
    const code = Buffer.from(signed.code);
    signed.code.fill(0);
    return Object.freeze({ code, expiresAt: signed.expiresAt });
  }
}
