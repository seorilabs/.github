import { fail } from './errors.mjs';
import { isLogicalCredentialRef } from './validation.mjs';

const PROVIDER = /^[a-z0-9][a-z0-9-]*$/;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const ACCOUNT_KINDS = new Set(['dedicated_bot', 'human']);
const ACCOUNT_KEYS = ['accountId', 'credentialRefs', 'kind', 'provider'];

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function accountKey(provider, accountId) {
  return `${provider}\0${accountId}`;
}

export class CanonicalAccountRegistry {
  #accounts = new Map();

  constructor(accounts) {
    if (!Array.isArray(accounts) || accounts.length === 0) {
      fail('invalid_policy', 'canonical account registry must be a non-empty array');
    }
    for (const raw of accounts) {
      if (
        !exactKeys(raw, ACCOUNT_KEYS) || !PROVIDER.test(raw.provider ?? '') ||
        !PUBLIC_ID.test(raw.accountId ?? '') || !ACCOUNT_KINDS.has(raw.kind) ||
        !Array.isArray(raw.credentialRefs) || raw.credentialRefs.length === 0 ||
        new Set(raw.credentialRefs).size !== raw.credentialRefs.length ||
        raw.credentialRefs.some((credentialRef) => !isLogicalCredentialRef(credentialRef))
      ) {
        fail('invalid_policy', 'canonical account registration is invalid');
      }
      const key = accountKey(raw.provider, raw.accountId);
      if (this.#accounts.has(key)) fail('invalid_policy', 'canonical account registration is duplicated');
      this.#accounts.set(key, Object.freeze({
        provider: raw.provider,
        accountId: raw.accountId,
        kind: raw.kind,
        credentialRefs: Object.freeze([...raw.credentialRefs]),
      }));
    }
    Object.freeze(this);
  }

  require({ provider, accountId, credentialRefs = [] }) {
    if (
      !PROVIDER.test(provider ?? '') || !PUBLIC_ID.test(accountId ?? '') ||
      !Array.isArray(credentialRefs) || credentialRefs.some((value) => !isLogicalCredentialRef(value))
    ) {
      fail('account_binding_mismatch', 'account binding request is invalid');
    }
    const account = this.#accounts.get(accountKey(provider, accountId));
    if (!account || credentialRefs.some((credentialRef) => !account.credentialRefs.includes(credentialRef))) {
      fail('account_binding_mismatch', 'account is not registered for the requested credentials');
    }
    return account;
  }
}
