import { isDeepStrictEqual } from 'node:util';

import { executeSecretAdapter } from './executor.mjs';
import { SeoriAuthError, fail } from './errors.mjs';
import { requireExactMtlsPeer } from './mtls-identity.mjs';
import { normalizeExecutionBinding } from './durable-state.mjs';
import { isLogicalCredentialRef, normalizeHttpsOrigin } from './validation.mjs';

const MAX_BODY_BYTES = 32 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const ADAPTER = /^[a-z0-9][a-z0-9-]*$/;
const PROVIDER = /^[a-z0-9][a-z0-9-]*$/;
const CAPABILITIES = Object.freeze({
  password: 'browser.password.inject',
  totp: 'browser.totp.inject',
});

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'cache-control': 'no-store',
    connection: 'close',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

async function readJson(request) {
  if ((request.headers['content-type'] ?? '').split(';', 1)[0].trim() !== 'application/json') {
    fail('unsupported_media_type', 'request content type must be application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) fail('request_too_large', 'request body is too large');
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('invalid_request', 'request body must be valid JSON');
  }
}

function normalizeRequest(kind, body) {
  if (!exactKeys(body, ['adapterId', 'binding', 'executionBinding', 'invocationId'])) {
    fail('invalid_request', 'factor execution request fields are invalid');
  }
  if (!ADAPTER.test(body.adapterId ?? '') || !ID.test(body.invocationId ?? '')) {
    fail('invalid_request', 'factor adapter or invocation id is invalid');
  }
  const bindingKeys = kind === 'password'
    ? ['accountId', 'credentialGeneration', 'credentialRef', 'provider']
    : ['accountId', 'credentialGeneration', 'credentialRef', 'origin', 'provider'];
  if (
    !exactKeys(body.binding, bindingKeys) || !isLogicalCredentialRef(body.binding.credentialRef) ||
    !Number.isSafeInteger(body.binding.credentialGeneration) || body.binding.credentialGeneration < 1 ||
    !PROVIDER.test(body.binding.provider ?? '') || !ID.test(body.binding.accountId ?? '')
  ) {
    fail('invalid_request', 'factor credential binding is invalid');
  }
  return Object.freeze({
    adapterId: body.adapterId,
    invocationId: body.invocationId,
    executionBinding: normalizeExecutionBinding(body.executionBinding),
    binding: Object.freeze({
      ...body.binding,
      ...(kind === 'totp' ? { origin: normalizeHttpsOrigin(body.binding.origin) } : {}),
    }),
  });
}

export class FactorHttpApplication {
  #kind;
  #factor;
  #registry;
  #allowedBrokerSpiffeIds;
  #clock;
  #invocations = new Map();

  constructor({ kind, factor, registry, allowedBrokerSpiffeIds, clock = () => Date.now() }) {
    if (!['password', 'totp'].includes(kind)) throw new TypeError('factor kind must be password or totp');
    const method = kind === 'password' ? 'loadPassword' : 'signCode';
    if (!factor || typeof factor[method] !== 'function' || !registry || typeof registry.require !== 'function') {
      throw new TypeError('factor application requires a trusted factor boundary and adapter registry');
    }
    if (!Array.isArray(allowedBrokerSpiffeIds) || allowedBrokerSpiffeIds.length === 0 || typeof clock !== 'function') {
      throw new TypeError('factor application requires exact broker mTLS identities and a clock');
    }
    this.#kind = kind;
    this.#factor = factor;
    this.#registry = registry;
    this.#allowedBrokerSpiffeIds = Object.freeze([...allowedBrokerSpiffeIds]);
    this.#clock = clock;
  }

  async dispatch(request, response) {
    try {
      await this.#handle(request, response);
    } catch (error) {
      const code = error instanceof SeoriAuthError ? error.code : 'internal_error';
      if (!response.headersSent) sendJson(response, code.startsWith('invalid_') ? 400 : 409, { error: { code } });
      else response.destroy();
    }
  }

  async #handle(request, response) {
    requireExactMtlsPeer(request.socket, this.#allowedBrokerSpiffeIds);
    if (request.method !== 'POST' || typeof request.url !== 'string') {
      sendJson(response, 405, { error: { code: 'method_not_allowed' } });
      return;
    }
    const url = new URL(request.url, 'https://factor.invalid');
    if (url.search !== '' || url.pathname !== `/internal/factors/${this.#kind}/execute`) {
      sendJson(response, 404, { error: { code: 'route_not_found' } });
      return;
    }
    const input = normalizeRequest(this.#kind, await readJson(request));
    const now = this.#clock();
    if (!Number.isSafeInteger(now)) fail('invalid_factor_service', 'trusted factor clock is invalid');
    for (const [id, invocation] of this.#invocations) {
      if (invocation.expiresAt <= now) this.#invocations.delete(id);
    }
    const prior = this.#invocations.get(input.invocationId);
    if (prior) {
      if (!isDeepStrictEqual(prior.binding, input)) fail('idempotency_conflict', 'factor invocation binding changed');
      sendJson(response, 200, prior.response);
      return;
    }
    if (this.#invocations.size >= 10_000) fail('factor_busy', 'factor invocation replay cache is full');
    let secret;
    let expiresAt;
    if (this.#kind === 'password') {
      secret = await this.#factor.loadPassword(input.binding);
    } else {
      const signed = await this.#factor.signCode(input.binding);
      secret = signed.code;
      expiresAt = signed.expiresAt;
      const signedAt = this.#clock();
      if (!Number.isSafeInteger(signedAt) || expiresAt <= signedAt || expiresAt - signedAt > 30_000) {
        if (Buffer.isBuffer(secret)) secret.fill(0);
        fail('totp_sign_failed', 'TOTP code expiry is outside the one-step window');
      }
    }
    const result = await executeSecretAdapter({
      registry: this.#registry,
      adapterId: input.adapterId,
      binding: Object.freeze({
        provider: input.binding.provider,
        capability: CAPABILITIES[this.#kind],
        accountId: input.binding.accountId,
        executionBinding: input.executionBinding,
        invocationId: input.invocationId,
      }),
      secretBuffer: secret,
    });
    const responseBody = Object.freeze({
      execution: Object.freeze({
        outcome: result.exitCode === 0 ? 'SUCCESS' : 'ADAPTER_FAILED',
        exitCode: result.exitCode,
        signal: result.signal,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      }),
    });
    this.#invocations.set(input.invocationId, Object.freeze({
      binding: input,
      response: responseBody,
      expiresAt: now + 300_000,
    }));
    sendJson(response, 200, responseBody);
  }
}
