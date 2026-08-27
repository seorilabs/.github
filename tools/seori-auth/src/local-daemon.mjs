import { createServer } from 'node:http';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { TrustedAdapterRegistry } from './adapters.mjs';
import { normalizeExecutionBinding } from './durable-state.mjs';
import { SeoriAuthError, fail } from './errors.mjs';
import { executeConsumedLease } from './executor.mjs';
import { PolicyEngine } from './policy.mjs';
import { classifyReauth } from './reauth.mjs';
import { normalizeLeaseRequest } from './validation.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const IDENTITY_READBACK_TIMEOUT_MS = 10_000;
const PUBLIC_PATH_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;

function assertExactBody(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_request', 'request body must be an object');
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    fail('invalid_request', 'request body fields are invalid');
  }
}

function pathId(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    fail('invalid_request', 'path identifier is invalid');
  }
  if (!PUBLIC_PATH_ID.test(decoded)) {
    fail('invalid_request', 'path identifier is invalid');
  }
  return decoded;
}

function assertAttestedPrincipal(principal, claimedBinding) {
  const claim = normalizeExecutionBinding(claimedBinding);
  if (!isDeepStrictEqual(principal, claim)) {
    fail('principal_binding_mismatch', 'request binding does not match the attested principal');
  }
}

function errorStatus(code) {
  if (['lease_not_found', 'browser_session_not_found'].includes(code)) return 404;
  if (
    ['capability_forbidden', 'lease_binding_mismatch', 'browser_session_binding_mismatch',
      'identity_readback_mismatch', 'principal_unauthenticated', 'principal_binding_mismatch'].includes(code)
  ) return 403;
  if (['lease_expired', 'browser_capability_expired'].includes(code)) return 410;
  if (
    ['generation_conflict', 'lease_already_used', 'browser_capability_invalid', 'browser_account_in_use',
      'browser_session_exists', 'stale_credential_generation', 'stale_policy_generation'].includes(code)
  ) return 409;
  if (
    code.startsWith('invalid_') || code === 'unknown_reauth_classification' ||
    code === 'request_too_large' || code === 'unsupported_media_type'
  ) return 400;
  return 500;
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    connection: 'close',
  });
  response.end(body);
}

async function readJson(request) {
  if ((request.headers['content-type'] ?? '').split(';', 1)[0].trim() !== 'application/json') {
    fail('unsupported_media_type', 'request content type must be application/json');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) {
      fail('request_too_large', 'request body is too large');
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('invalid_request', 'request body must be valid JSON');
  }
}

async function withTimeout(operation, milliseconds) {
  let timeout;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('operation timed out')), milliseconds);
        timeout.unref();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function assertSocketPathAvailable(socketPath) {
  try {
    await lstat(socketPath);
    fail('socket_path_in_use', 'Unix socket path already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

export class LocalAuthDaemon {
  #socketPath;
  #state;
  #policy;
  #registry;
  #loadSecret;
  #getCredentialGeneration;
  #readBrowserIdentity;
  #authenticatePrincipal;
  #server;
  #socketIdentity;

  constructor({
    socketPath,
    state,
    policy,
    adapters,
    loadSecret,
    getCredentialGeneration,
    readBrowserIdentity,
    authenticatePrincipal,
  }) {
    if (typeof socketPath !== 'string' || !isAbsolute(socketPath)) {
      throw new TypeError('socketPath must be an absolute Unix domain socket path');
    }
    if (!state || typeof state.issueCredentialCheckout !== 'function') {
      throw new TypeError('state must be a DurableAuthState');
    }
    if (typeof loadSecret !== 'function') {
      throw new TypeError('loadSecret must be a trusted in-process function');
    }
    if (typeof getCredentialGeneration !== 'function') {
      throw new TypeError('getCredentialGeneration must be a trusted in-process function');
    }
    if (typeof readBrowserIdentity !== 'function') {
      throw new TypeError('readBrowserIdentity must be a trusted in-process function');
    }
    if (typeof authenticatePrincipal !== 'function') {
      throw new TypeError('authenticatePrincipal must attest the Unix peer outside the HTTP body');
    }
    this.#socketPath = socketPath;
    this.#state = state;
    this.#policy = new PolicyEngine(policy);
    this.#registry = new TrustedAdapterRegistry(adapters);
    this.#loadSecret = loadSecret;
    this.#getCredentialGeneration = getCredentialGeneration;
    this.#readBrowserIdentity = readBrowserIdentity;
    this.#authenticatePrincipal = authenticatePrincipal;
  }

  async start() {
    if (this.#server) {
      fail('daemon_already_started', 'local auth daemon is already started');
    }
    const socketDirectory = dirname(this.#socketPath);
    await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(socketDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) {
      fail('insecure_socket_directory', 'Unix socket directory must be private and must not be a symlink');
    }
    await assertSocketPathAvailable(this.#socketPath);

    const server = createServer((request, response) => {
      this.#handle(request, response).catch((error) => {
        const code = error instanceof SeoriAuthError ? error.code : 'internal_error';
        if (!response.headersSent) {
          sendJson(response, errorStatus(code), { error: { code } });
        } else {
          response.destroy();
        }
      });
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 1_000;
    server.maxHeadersCount = 32;
    server.maxRequestsPerSocket = 1;
    server.on('clientError', (_error, socket) => socket.destroy());

    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(this.#socketPath, () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });
    this.#server = server;
    try {
      await chmod(this.#socketPath, 0o600);
      const socketStat = await lstat(this.#socketPath);
      if (!socketStat.isSocket()) {
        fail('unsafe_socket_path', 'listener path is not a Unix socket');
      }
      this.#socketIdentity = { dev: socketStat.dev, ino: socketStat.ino };
    } catch (error) {
      await new Promise((resolveClose) => server.close(() => resolveClose()));
      this.#server = undefined;
      throw error;
    }
    return Object.freeze({ transport: 'unix', socketPath: this.#socketPath });
  }

  async stop() {
    const server = this.#server;
    const socketIdentity = this.#socketIdentity;
    this.#server = undefined;
    this.#socketIdentity = undefined;
    if (server) {
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    }
    try {
      const stat = await lstat(this.#socketPath);
      if (stat.isSocket() && stat.dev === socketIdentity?.dev && stat.ino === socketIdentity?.ino) {
        await unlink(this.#socketPath);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async #handle(request, response) {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: { code: 'method_not_allowed' } });
      return;
    }
    if (typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.startsWith('//')) {
      fail('invalid_request', 'request target must be an origin-form path');
    }
    const url = new URL(request.url, 'http://unix.invalid');
    if (url.search !== '') {
      fail('invalid_request', 'query parameters are not supported');
    }
    const principal = await this.#attestPrincipal(request.socket);
    const body = await readJson(request);

    if (url.pathname === '/auth/leases') {
      assertExactBody(body, ['workerId', 'request']);
      assertAttestedPrincipal(principal, {
        subject: body.request?.subject,
        runId: body.request?.runId,
        repository: body.request?.repository,
        workerId: body.workerId,
      });
      const authorized = this.#policy.authorize(body.request);
      const currentCredentialGeneration = await this.#currentCredentialGeneration(
        authorized.request.credentialRef,
      );
      const credentialCheckout = await this.#state.issueCredentialCheckout({
        authorized,
        workerId: principal.workerId,
        currentCredentialGeneration,
        currentPolicyGeneration: this.#policy.generation,
      });
      sendJson(response, 201, { credentialCheckout });
      return;
    }

    const executeMatch = url.pathname.match(/^\/auth\/leases\/([^/]+)\/execute$/);
    if (executeMatch) {
      assertExactBody(body, ['expectedGeneration', 'workerId', 'context']);
      assertAttestedPrincipal(principal, {
        subject: body.context?.subject,
        runId: body.context?.runId,
        repository: body.context?.repository,
        workerId: body.workerId,
      });
      const context = normalizeLeaseRequest(body.context);
      // Re-authorize before any generation-source lookup. This prevents an unapproved
      // caller from probing logical credential references through the trusted callback.
      this.#policy.authorize(context);
      const currentCredentialGeneration = await this.#currentCredentialGeneration(context.credentialRef);
      const consumed = await this.#state.consumeCredentialCheckout({
        id: pathId(executeMatch[1]),
        expectedGeneration: body.expectedGeneration,
        context,
        workerId: principal.workerId,
        currentCredentialGeneration,
        currentPolicyGeneration: this.#policy.generation,
      });

      try {
        const result = await executeConsumedLease({
          consumed,
          registry: this.#registry,
          loadSecret: this.#loadSecret,
        });
        const outcome = result.exitCode === 0 ? 'SUCCESS' : 'ADAPTER_FAILED';
        await this.#state.recordCredentialExecution({
          consumed,
          outcome,
          ...(Number.isInteger(result.exitCode) ? { exitCode: result.exitCode } : {}),
          signal: result.signal,
        });
        sendJson(response, 200, {
          execution: {
            generation: consumed.generation,
            outcome,
            exitCode: result.exitCode,
            signal: result.signal,
          },
        });
      } catch (error) {
        await this.#state.recordCredentialExecution({
          consumed,
          outcome: error instanceof SeoriAuthError ? error.code.toUpperCase() : 'ADAPTER_FAILED',
        });
        throw error;
      }
      return;
    }

    const checkoutMatch = url.pathname.match(/^\/auth\/browser-sessions\/([^/]+)\/checkout$/);
    if (checkoutMatch) {
      assertExactBody(body, ['expectedGeneration', 'executionBinding', 'expectedIdentity']);
      assertAttestedPrincipal(principal, body.executionBinding);
      const browserSession = await this.#state.checkoutBrowserSession({
        sessionId: pathId(checkoutMatch[1]),
        expectedGeneration: body.expectedGeneration,
        executionBinding: principal,
        expectedIdentity: body.expectedIdentity,
      });
      sendJson(response, 200, { browserSession });
      return;
    }

    const completeMatch = url.pathname.match(/^\/auth\/browser-sessions\/([^/]+)\/complete$/);
    if (completeMatch) {
      assertExactBody(body, ['capabilityId', 'expectedGeneration', 'executionBinding']);
      assertAttestedPrincipal(principal, body.executionBinding);
      const browserSession = await this.#state.completeBrowserSession({
        sessionId: pathId(completeMatch[1]),
        capabilityId: body.capabilityId,
        expectedGeneration: body.expectedGeneration,
        executionBinding: principal,
        readIdentity: (binding) => withTimeout(
          Promise.resolve().then(() => this.#readBrowserIdentity(binding)),
          IDENTITY_READBACK_TIMEOUT_MS,
        ),
      });
      sendJson(response, 200, { browserSession });
      return;
    }

    if (url.pathname === '/auth/reauth-requests') {
      assertExactBody(body, ['reason', 'executionBinding', 'publicIdentity']);
      assertAttestedPrincipal(principal, body.executionBinding);
      classifyReauth(body.reason);
      const reauthRequest = await this.#state.createReauthRequest({
        reason: body.reason,
        executionBinding: principal,
        publicIdentity: body.publicIdentity,
      });
      sendJson(response, 201, { reauthRequest });
      return;
    }

    sendJson(response, 404, { error: { code: 'route_not_found' } });
  }

  async #currentCredentialGeneration(credentialRef) {
    let generation;
    try {
      generation = await this.#getCredentialGeneration({ credentialRef });
    } catch {
      fail('credential_generation_unavailable', 'credential generation is unavailable');
    }
    if (!Number.isSafeInteger(generation) || generation < 1) {
      fail('credential_generation_unavailable', 'credential generation source returned an invalid value');
    }
    return generation;
  }

  async #attestPrincipal(socket) {
    let principal;
    try {
      // The attestor receives only the accepted Unix socket, never HTTP headers or body.
      // A production embedding must combine peer credentials with a scheduler-issued
      // connection capability or inherited descriptor outside agent-controlled input.
      principal = await this.#authenticatePrincipal(socket);
      return normalizeExecutionBinding(principal);
    } catch {
      fail('principal_unauthenticated', 'Unix peer principal could not be attested');
    }
  }
}
