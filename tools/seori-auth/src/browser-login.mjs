import { isDeepStrictEqual } from 'node:util';

import { CanonicalAccountRegistry } from './accounts.mjs';
import { HUMAN_REAUTH_REQUIRED, normalizePublicIdentity } from './durable-state.mjs';
import { fail } from './errors.mjs';
import { classifyReauth } from './reauth.mjs';
import { isLogicalCredentialRef, normalizeHttpsOrigin } from './validation.mjs';

const INSPECTION_KEYS = ['authenticated', 'challenge', 'origin', 'publicIdentity', 'redirectOrigins'];
const SECURITY_CONTROL_KEYS = [
  'allowedNetworkOrigins',
  'clipboard',
  'downloads',
  'extensions',
  'har',
  'profilePathExposed',
  'screenshots',
  'storageStateExport',
  'traces',
  'video',
];

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail('invalid_browser_login', `${label} is invalid`);
  return value;
}

function credentialReference(value, label) {
  if (!isLogicalCredentialRef(value)) fail('invalid_browser_login', `${label} must be a logical credential id`);
  return value;
}

function normalizeRedirects(value) {
  if (!Array.isArray(value) || value.length > 8 || new Set(value).size !== value.length) {
    fail('invalid_browser_login', 'browser redirect chain is invalid');
  }
  return Object.freeze(value.map((origin, index) => normalizeHttpsOrigin(origin, `redirectOrigins[${index}]`)));
}

function humanReauth(challenge) {
  const classification = challenge === 'totp_required' ? 'mfa_required' : challenge;
  try {
    classifyReauth(classification);
  } catch {
    fail('unsupported_auth_challenge', 'browser login returned an unsupported challenge');
  }
  fail(HUMAN_REAUTH_REQUIRED, 'browser login requires trusted human reauthentication');
}

function normalizeInspection(value) {
  if (
    !exactKeys(value, INSPECTION_KEYS) || typeof value.authenticated !== 'boolean' ||
    (value.challenge !== null && typeof value.challenge !== 'string')
  ) {
    fail('browser_inspection_failed', 'trusted browser inspection returned an invalid result');
  }
  return Object.freeze({
    origin: normalizeHttpsOrigin(value.origin, 'observed origin'),
    redirectOrigins: normalizeRedirects(value.redirectOrigins),
    publicIdentity: normalizePublicIdentity(value.publicIdentity),
    authenticated: value.authenticated,
    challenge: value.challenge,
  });
}

function validTotpBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || ![6, 8].includes(buffer.length)) return false;
  return buffer.every((byte) => byte >= 0x30 && byte <= 0x39);
}

export class BrowserLoginBoundary {
  #passwordLoader;
  #totpSigner;
  #accounts;
  #clock;

  constructor({ passwordLoader, totpSigner, accountRegistry, clock = () => Date.now() }) {
    if (
      !passwordLoader || typeof passwordLoader !== 'object' ||
      typeof passwordLoader.loadPassword !== 'function'
    ) {
      fail('invalid_factor_service', 'dedicated password loader service is required');
    }
    if (
      !totpSigner || typeof totpSigner !== 'object' ||
      typeof totpSigner.signCode !== 'function'
    ) {
      fail('invalid_factor_service', 'dedicated TOTP signer service is required');
    }
    if (passwordLoader === totpSigner) {
      fail('invalid_factor_service', 'password loader and TOTP signer must be separate service boundaries');
    }
    if (!(accountRegistry instanceof CanonicalAccountRegistry)) {
      fail('invalid_factor_service', 'canonical account registry is required');
    }
    if (typeof clock !== 'function') fail('invalid_factor_service', 'trusted clock is required');
    this.#passwordLoader = passwordLoader;
    this.#totpSigner = totpSigner;
    this.#accounts = accountRegistry;
    this.#clock = clock;
  }

  async #inspect(browser, stage, binding) {
    let inspected;
    try {
      inspected = await browser.inspect({ stage });
    } catch {
      fail('browser_inspection_failed', 'trusted browser inspection failed');
    }
    inspected = normalizeInspection(inspected);
    if (
      inspected.origin !== binding.origin ||
      !isDeepStrictEqual(inspected.redirectOrigins, binding.redirectOrigins)
    ) {
      fail('browser_origin_mismatch', 'browser origin or redirect chain does not exactly match');
    }
    if (!isDeepStrictEqual(inspected.publicIdentity, binding.publicIdentity)) {
      fail('identity_readback_mismatch', 'browser public identity does not exactly match');
    }
    return inspected;
  }

  async authenticate({
    browser,
    passwordRef,
    passwordGeneration,
    totpRef,
    totpGeneration,
    expectedOrigin,
    expectedRedirectOrigins,
    expectedIdentity,
    authFactors,
  }) {
    if (
      !browser || typeof browser !== 'object' ||
      typeof browser.securityControls !== 'function' ||
      typeof browser.inspect !== 'function' ||
      typeof browser.injectPassword !== 'function' ||
      typeof browser.injectTotp !== 'function'
    ) {
      fail('browser_adapter_untrusted', 'trusted browser login adapter is required');
    }
    if (
      !Array.isArray(authFactors) || authFactors.length === 0 ||
      new Set(authFactors).size !== authFactors.length ||
      authFactors.some((factor) => !['password', 'totp'].includes(factor)) ||
      !authFactors.includes('password')
    ) {
      fail('invalid_browser_login', 'browser login factors are invalid');
    }
    const useTotp = authFactors.includes('totp');
    const binding = Object.freeze({
      origin: normalizeHttpsOrigin(expectedOrigin, 'expected origin'),
      redirectOrigins: normalizeRedirects(expectedRedirectOrigins),
      publicIdentity: normalizePublicIdentity(expectedIdentity),
    });
    const normalizedPasswordRef = credentialReference(passwordRef, 'passwordRef');
    const normalizedPasswordGeneration = positiveInteger(passwordGeneration, 'passwordGeneration');
    const normalizedTotpRef = useTotp ? credentialReference(totpRef, 'totpRef') : undefined;
    const normalizedTotpGeneration = useTotp ? positiveInteger(totpGeneration, 'totpGeneration') : undefined;
    if (useTotp && normalizedTotpRef === normalizedPasswordRef) {
      fail('invalid_factor_service', 'password and TOTP must use different logical credentials');
    }
    const account = this.#accounts.require({
      provider: binding.publicIdentity.provider,
      accountId: binding.publicIdentity.accountId,
      credentialRefs: [
        normalizedPasswordRef,
        ...(normalizedTotpRef === undefined ? [] : [normalizedTotpRef]),
      ],
    });
    if (account.kind !== 'dedicated_bot') {
      fail(HUMAN_REAUTH_REQUIRED, 'personal account password or TOTP automation is forbidden');
    }
    let controls;
    try {
      controls = await browser.securityControls();
    } catch {
      fail('browser_security_controls_failed', 'trusted browser security controls could not be verified');
    }
    const expectedNetworkOrigins = [...new Set([binding.origin, ...binding.redirectOrigins])];
    if (
      !exactKeys(controls, SECURITY_CONTROL_KEYS) ||
      !isDeepStrictEqual(controls.allowedNetworkOrigins, expectedNetworkOrigins) ||
      SECURITY_CONTROL_KEYS.filter((key) => key !== 'allowedNetworkOrigins')
        .some((key) => controls[key] !== false)
    ) {
      fail('browser_security_controls_failed', 'browser capture, export, or network controls are not fail-closed');
    }
    const initial = await this.#inspect(browser, 'before_password', binding);
    if (initial.challenge !== null) humanReauth(initial.challenge);
    if (initial.authenticated) fail('browser_session_state_invalid', 'browser session was already authenticated');

    let password;
    try {
      password = await this.#passwordLoader.loadPassword({
        credentialRef: normalizedPasswordRef,
        credentialGeneration: normalizedPasswordGeneration,
        provider: binding.publicIdentity.provider,
        accountId: binding.publicIdentity.accountId,
      });
    } catch {
      fail('password_load_failed', 'password execution copy could not be loaded');
    }
    if (!Buffer.isBuffer(password) || password.length === 0) {
      if (Buffer.isBuffer(password)) password.fill(0);
      fail('password_load_failed', 'password loader returned an invalid execution copy');
    }
    try {
      await browser.injectPassword(password);
    } catch {
      fail('password_injection_failed', 'trusted browser password injection failed');
    } finally {
      password.fill(0);
    }

    const afterPassword = await this.#inspect(browser, 'after_password', binding);
    if (!useTotp) {
      if (afterPassword.challenge !== null) humanReauth(afterPassword.challenge);
      if (!afterPassword.authenticated) fail('browser_authentication_failed', 'browser login did not authenticate');
      return Object.freeze({ status: 'AUTHENTICATED', publicIdentity: binding.publicIdentity });
    }
    if (afterPassword.challenge !== 'totp_required' || afterPassword.authenticated) {
      if (afterPassword.challenge !== null) humanReauth(afterPassword.challenge);
      fail('totp_challenge_missing', 'dedicated bot TOTP challenge was not observed');
    }

    let signed;
    try {
      signed = await this.#totpSigner.signCode({
        credentialRef: normalizedTotpRef,
        credentialGeneration: normalizedTotpGeneration,
        provider: binding.publicIdentity.provider,
        accountId: binding.publicIdentity.accountId,
        origin: binding.origin,
      });
    } catch {
      fail('totp_sign_failed', 'TOTP signer could not create a login code');
    }
    const now = this.#clock();
    const code = signed?.code;
    const expiresAt = signed?.expiresAt;
    if (
      !exactKeys(signed, ['code', 'expiresAt']) || !validTotpBytes(code) ||
      !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt - now > 30_000
    ) {
      if (Buffer.isBuffer(code)) code.fill(0);
      fail('totp_sign_failed', 'TOTP signer returned an invalid short-lived code');
    }
    try {
      await browser.injectTotp(code);
    } catch {
      fail('totp_injection_failed', 'trusted browser TOTP injection failed');
    } finally {
      code.fill(0);
    }

    const completed = await this.#inspect(browser, 'after_totp', binding);
    if (completed.challenge !== null) humanReauth(completed.challenge);
    if (!completed.authenticated) fail('browser_authentication_failed', 'browser login did not authenticate');
    return Object.freeze({ status: 'AUTHENTICATED', publicIdentity: binding.publicIdentity });
  }
}
