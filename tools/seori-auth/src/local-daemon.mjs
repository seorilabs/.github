import { createServer } from 'node:http';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { TrustedAdapterRegistry } from './adapters.mjs';
import {
  computeAuthStrategyEvidenceKey,
  HUMAN_REAUTH_REQUIRED,
  normalizeExecutionBinding,
  normalizePublicIdentity,
} from './durable-state.mjs';
import { SeoriAuthError, fail } from './errors.mjs';
import { executeConsumedLease, executeConsumedProviderLease } from './executor.mjs';
import { NATIVE_BROWSER_ADAPTER_BRAND } from './native-browser-adapter-brand.mjs';
import { NATIVE_LAUNCHER_BRAND } from './native-launcher-brand.mjs';
import { PolicyEngine } from './policy.mjs';
import {
  normalizeProviderGrantExpectation,
  normalizeProviderGrantRegistration,
  providerGrantLeaseRequest,
  providerGrantRequiresPerRunApproval,
  PROVIDER_CONTROL_PLANE_ENDPOINT_SCOPE,
} from './provider-grants.mjs';
import { classifyReauth } from './reauth.mjs';
import { normalizeLeaseRequest } from './validation.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const IDENTITY_READBACK_TIMEOUT_MS = 10_000;
const PUBLIC_PATH_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const RECONCILIATION_OUTCOMES = new Set(['SUCCEEDED', 'NOT_APPLIED', 'UNKNOWN']);
const PROVIDER_ROUTE = new RegExp(`^${PROVIDER_CONTROL_PLANE_ENDPOINT_SCOPE.replaceAll('/', '\\/')}\/([^/]+)\/(verify|consume|result|observation)$`);

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

function publicIdentityForRequest(request) {
  return normalizePublicIdentity({
    provider: request.provider,
    accountId: request.accountId,
    teamId: null,
    workspaceId: null,
    appId: request.resource.id,
  });
}

function normalizeReconciliation(value) {
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'outcome,publicIdentity' ||
    !RECONCILIATION_OUTCOMES.has(value.outcome)
  ) {
    fail('browser_reconciliation_failed', 'trusted browser reconciliation returned an invalid result');
  }
  return Object.freeze({
    outcome: value.outcome,
    publicIdentity: normalizePublicIdentity(value.publicIdentity),
  });
}

function errorStatus(code) {
  if (['lease_not_found', 'browser_session_not_found', 'provider_grant_not_found'].includes(code)) return 404;
  if (
    ['capability_forbidden', 'per_run_approval_required', 'lease_binding_mismatch', 'browser_session_binding_mismatch',
      'identity_readback_mismatch', 'principal_unauthenticated', 'principal_binding_mismatch',
      'provider_grant_binding_mismatch', 'provider_observation_binding_mismatch'].includes(code)
  ) return 403;
  if (['lease_expired', 'browser_capability_expired', 'approval_expired'].includes(code)) return 410;
  if (code === 'HUMAN_REAUTH_REQUIRED') return 409;
  if (
    ['generation_conflict', 'lease_already_used', 'browser_capability_invalid', 'browser_account_in_use',
      'browser_session_exists', 'stale_credential_generation', 'stale_policy_generation',
      'approval_already_used', 'idempotency_conflict', 'browser_reconciliation_required',
      'browser_reconciliation_not_applied', 'lease_invalidated_by_reauth',
      'auth_strategy_evidence_required', 'provider_grant_exists', 'provider_grant_already_used'].includes(code)
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

function sendNoContent(response) {
  response.writeHead(204, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    connection: 'close',
  });
  response.end();
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

function validateNativeBrowserAdapter(adapter) {
  if (
    !adapter || typeof adapter !== 'object' || Array.isArray(adapter) ||
    adapter[NATIVE_BROWSER_ADAPTER_BRAND] !== true ||
    typeof adapter.execute !== 'function' || typeof adapter.terminate !== 'function' ||
    !Number.isSafeInteger(adapter.timeoutMs) || adapter.timeoutMs < 10 || adapter.timeoutMs > 300_000 ||
    !Number.isSafeInteger(adapter.terminationTimeoutMs) || adapter.terminationTimeoutMs < 10 ||
    adapter.terminationTimeoutMs > 30_000 ||
    !adapter.launcher || adapter.launcher[NATIVE_LAUNCHER_BRAND] !== true ||
    adapter.launcher.mode !== 'non-dumpable-v1' ||
    typeof adapter.launcher.executable !== 'string' || !isAbsolute(adapter.launcher.executable)
  ) {
    throw new TypeError('browserAdapter must use the native abortable and kill-confirmed launcher boundary');
  }
  return adapter;
}

async function executeAbortableBrowserAdapter(adapter, input) {
  const controller = new AbortController();
  const execution = Promise.resolve()
    .then(() => adapter.execute(Object.freeze({ ...input, signal: controller.signal })))
    .then(
      (value) => Object.freeze({ status: 'FULFILLED', value }),
      (reason) => Object.freeze({ status: 'REJECTED', reason }),
    );
  const timeoutMarker = Object.freeze({ status: 'TIMED_OUT' });
  const first = await Promise.race([
    execution,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(timeoutMarker), adapter.timeoutMs);
      timer.unref();
      execution.finally(() => clearTimeout(timer));
    }),
  ]);
  if (first.status === 'FULFILLED') return first.value;
  if (first.status === 'REJECTED') throw first.reason;

  controller.abort(new SeoriAuthError('browser_adapter_timeout', 'trusted browser adapter timed out'));
  let termination;
  try {
    termination = await withTimeout(
      Promise.resolve().then(() => adapter.terminate(Object.freeze({
        capabilityId: input.capabilityId,
        reason: 'timeout',
      }))),
      adapter.terminationTimeoutMs,
    );
  } catch {
    fail(
      'browser_adapter_termination_unconfirmed',
      'browser adapter termination could not be confirmed; its session remains claimed',
    );
  }
  if (
    !termination || typeof termination !== 'object' || Array.isArray(termination) ||
    Object.keys(termination).join(',') !== 'terminated' || termination.terminated !== true
  ) {
    fail(
      'browser_adapter_termination_unconfirmed',
      'browser adapter termination could not be confirmed; its session remains claimed',
    );
  }

  let settled;
  try {
    settled = await withTimeout(execution, adapter.terminationTimeoutMs);
  } catch {
    fail(
      'browser_adapter_termination_unconfirmed',
      'browser adapter did not fully exit after termination; its session remains claimed',
    );
  }
  if (!['FULFILLED', 'REJECTED'].includes(settled.status)) {
    fail(
      'browser_adapter_termination_unconfirmed',
      'browser adapter did not fully exit after termination; its session remains claimed',
    );
  }
  fail('browser_adapter_timeout', 'trusted browser adapter timed out after confirmed termination');
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
  #browserVault;
  #browserAdapter;
  #reconcileBrowserSession;
  #authorizeInternalPrincipal;
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
    browserVault,
    browserAdapter,
    reconcileBrowserSession,
    authorizeInternalPrincipal,
  }) {
    if (typeof socketPath !== 'string' || !isAbsolute(socketPath)) {
      throw new TypeError('socketPath must be an absolute Unix domain socket path');
    }
    if (
      !state || typeof state !== 'object' ||
      [
        'issueCredentialCheckout', 'consumeCredentialCheckout', 'recordCredentialExecution',
        'checkoutBrowserSession', 'claimBrowserSessionExecution', 'claimBrowserSessionRecovery',
        'completeBrowserSession',
        'abortBrowserSession', 'requireBrowserSessionReconciliation',
        'abortBrowserSessionAfterReconciliation', 'blockBrowserSessionForReauth',
        'createReauthRequest',
      ].some((method) => typeof state[method] !== 'function')
    ) {
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
    if (
      !browserVault || typeof browserVault !== 'object' ||
      typeof browserVault.checkout !== 'function' || typeof browserVault.withClone !== 'function' ||
      typeof browserVault.complete !== 'function' || typeof browserVault.abort !== 'function'
    ) {
      throw new TypeError('browserVault must provide the trusted isolated profile boundary');
    }
    this.#browserAdapter = validateNativeBrowserAdapter(browserAdapter);
    if (typeof reconcileBrowserSession !== 'function') {
      throw new TypeError('reconcileBrowserSession must be a trusted provider readback callback');
    }
    this.#socketPath = socketPath;
    this.#state = state;
    this.#policy = new PolicyEngine(policy);
    this.#registry = new TrustedAdapterRegistry(adapters);
    this.#loadSecret = loadSecret;
    this.#getCredentialGeneration = getCredentialGeneration;
    this.#readBrowserIdentity = readBrowserIdentity;
    this.#authenticatePrincipal = authenticatePrincipal;
    this.#browserVault = browserVault;
    this.#reconcileBrowserSession = reconcileBrowserSession;
    if (authorizeInternalPrincipal !== undefined && typeof authorizeInternalPrincipal !== 'function') {
      throw new TypeError('authorizeInternalPrincipal must enforce the exact Backoffice mTLS SPIFFE identity');
    }
    if (
      authorizeInternalPrincipal !== undefined &&
      [
        'registerProviderGrant', 'verifyProviderGrant', 'resolveProviderGrantCommand', 'consumeProviderGrant',
        'recordProviderGrantResult', 'readProviderGrantResult', 'readProviderGrantObservation',
      ].some((method) => typeof state[method] !== 'function')
    ) {
      throw new TypeError('state must provide the durable provider grant control-plane contract');
    }
    this.#authorizeInternalPrincipal = authorizeInternalPrincipal;
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

    const server = createServer((request, response) => this.dispatch(request, response));
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

  async dispatch(request, response) {
    try {
      await this.#handle(request, response);
    } catch (error) {
      const code = error instanceof SeoriAuthError ? error.code : 'internal_error';
      if (!response.headersSent) {
        sendJson(response, errorStatus(code), { error: { code } });
      } else {
        response.destroy();
      }
    }
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
    const providerRoute = url.pathname === PROVIDER_CONTROL_PLANE_ENDPOINT_SCOPE
      ? { action: 'register' }
      : (() => {
          const match = url.pathname.match(PROVIDER_ROUTE);
          return match ? { id: pathId(match[1]), action: match[2] } : null;
        })();
    if (providerRoute && this.#authorizeInternalPrincipal === undefined) {
      sendJson(response, 404, { error: { code: 'route_not_found' } });
      return;
    }
    const principal = await this.#attestPrincipal(request);
    const body = await readJson(request);

    if (providerRoute) {
      await this.#authorizeProviderControlPlanePeer(request.socket);
      if (providerRoute.action === 'register') {
        const registration = normalizeProviderGrantRegistration(body, { subject: principal.subject });
        assertAttestedPrincipal(principal, {
          subject: registration.subject,
          runId: registration.grant.command.executionId,
          repository: registration.grant.command.repository,
          workerId: registration.workerId,
        });
        // Registration is a usable capability check, not a passive metadata write.
        // Resolve only public bindings here and repeat every mutable CAS immediately
        // before consume; no credential value is loaded at registration time.
        await this.#prepareProviderExecution(registration.grant.command, principal);
        const policyGrant = await this.#state.registerProviderGrant({
          registration,
          executionBinding: principal,
        });
        sendJson(response, 201, { policyGrant });
        return;
      }
      if (providerRoute.action === 'verify') {
        const expectation = normalizeProviderGrantExpectation(body);
        assertAttestedPrincipal(principal, { ...principal, workerId: expectation.workerId });
        const policyGrant = await this.#state.verifyProviderGrant({
          id: providerRoute.id,
          expectation,
          executionBinding: principal,
        });
        sendJson(response, 200, { policyGrant });
        return;
      }
      const expectation = normalizeProviderGrantExpectation(body, {
        includeGeneration: true,
        includeIdempotencyKey: providerRoute.action === 'consume',
      });
      assertAttestedPrincipal(principal, { ...principal, workerId: expectation.workerId });
      if (providerRoute.action === 'consume') {
        const resolved = await this.#state.resolveProviderGrantCommand({
          id: providerRoute.id,
          expectation,
          executionBinding: principal,
        });
        if (resolved.replay) {
          const replay = await this.#state.readProviderGrantResult({
            id: providerRoute.id,
            expectation,
            executionBinding: principal,
          });
          sendJson(response, 200, replay);
          return;
        }
        const execution = await this.#executeProviderGrant({
          id: providerRoute.id,
          expectation,
          command: resolved.command,
          principal,
        });
        sendJson(response, 200, execution);
        return;
      }
      if (providerRoute.action === 'result') {
        const result = await this.#state.readProviderGrantResult({
          id: providerRoute.id,
          expectation,
          executionBinding: principal,
        });
        sendJson(response, 200, result);
        return;
      }
      const observed = await this.#state.readProviderGrantObservation({
        id: providerRoute.id,
        expectation,
        executionBinding: principal,
      });
      if (observed === null) sendNoContent(response);
      else sendJson(response, 200, observed);
      return;
    }

    if (url.pathname === '/auth/leases') {
      assertExactBody(body, ['idempotencyKey', 'workerId', 'request']);
      assertAttestedPrincipal(principal, {
        subject: body.request?.subject,
        runId: body.request?.runId,
        repository: body.request?.repository,
        workerId: body.workerId,
      });
      const normalizedRequest = normalizeLeaseRequest(body.request);
      let authorized;
      try {
        authorized = this.#policy.evaluateForDurableState(normalizedRequest);
      } catch (error) {
        if (error instanceof SeoriAuthError && error.code === HUMAN_REAUTH_REQUIRED) {
          await this.#state.createReauthRequest({
            reason: error.details?.reason ?? 'policy_blocked',
            executionBinding: principal,
            publicIdentity: publicIdentityForRequest(normalizedRequest),
          });
        }
        throw error;
      }
      const currentCredentialGeneration = await this.#currentCredentialGeneration(
        authorized.request.credentialRef,
      );
      const credentialCheckout = await this.#state.issueCredentialCheckout({
        authorized,
        workerId: principal.workerId,
        idempotencyKey: body.idempotencyKey,
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
      this.#policy.evaluateForDurableState(context);
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
      assertExactBody(body, [
        'context', 'executionBinding', 'expectedLeaseGeneration', 'expectedProfileGeneration',
        'expectedSessionGeneration', 'expectedIdentity', 'leaseId', 'role', 'workerId',
      ]);
      assertAttestedPrincipal(principal, {
        subject: body.context?.subject,
        runId: body.context?.runId,
        repository: body.context?.repository,
        workerId: body.workerId,
      });
      assertAttestedPrincipal(principal, body.executionBinding);
      const context = normalizeLeaseRequest(body.context);
      const authorized = this.#policy.evaluateForDurableState(context);
      const currentCredentialGeneration = await this.#currentCredentialGeneration(context.credentialRef);
      const consumed = await this.#state.consumeCredentialCheckout({
        id: pathId(body.leaseId),
        expectedGeneration: body.expectedLeaseGeneration,
        context,
        workerId: principal.workerId,
        currentCredentialGeneration,
        currentPolicyGeneration: this.#policy.generation,
      });
      if (authorized.ruleId !== consumed.ruleId) {
        fail('browser_session_binding_mismatch', 'browser lease rule no longer matches policy');
      }
      const authorization = Object.freeze({
        actionClass: consumed.actionClass,
        authStrategyIndex: consumed.authStrategyIndex,
        leaseId: consumed.id,
        ruleId: consumed.ruleId,
        profileGeneration: body.expectedProfileGeneration,
        role: body.role,
        request: consumed.binding,
        strategyEvidenceKey: consumed.strategyEvidenceKey,
      });
      const sessionId = pathId(checkoutMatch[1]);
      const browserSession = await this.#state.checkoutBrowserSession({
        sessionId,
        expectedGeneration: body.expectedSessionGeneration,
        executionBinding: principal,
        expectedIdentity: body.expectedIdentity,
        authorization,
      });
      try {
        await this.#browserVault.checkout({
          capabilityId: browserSession.capabilityId,
          role: body.role,
          expectedIdentity: body.expectedIdentity,
          expectedGeneration: body.expectedProfileGeneration,
          executionBinding: principal,
          sourceSha: context.commitSha,
        });
      } catch (error) {
        await this.#state.abortBrowserSession({
          sessionId,
          capabilityId: browserSession.capabilityId,
          expectedGeneration: body.expectedSessionGeneration + 1,
          executionBinding: principal,
          authorization,
        }).catch(() => {});
        throw error;
      }
      sendJson(response, 200, { browserSession });
      return;
    }

    const completeMatch = url.pathname.match(/^\/auth\/browser-sessions\/([^/]+)\/complete$/);
    if (completeMatch) {
      assertExactBody(body, [
        'capabilityId', 'context', 'executionBinding', 'expectedGeneration', 'leaseId',
        'profileGeneration', 'role', 'workerId',
      ]);
      assertAttestedPrincipal(principal, {
        subject: body.context?.subject,
        runId: body.context?.runId,
        repository: body.context?.repository,
        workerId: body.workerId,
      });
      assertAttestedPrincipal(principal, body.executionBinding);
      const context = normalizeLeaseRequest(body.context);
      const sessionId = pathId(completeMatch[1]);
      const leaseId = pathId(body.leaseId);
      const recoveredClaim = await this.#state.claimBrowserSessionRecovery({
        sessionId,
        capabilityId: body.capabilityId,
        expectedGeneration: body.expectedGeneration,
        executionBinding: principal,
        request: context,
        leaseId,
        profileGeneration: body.profileGeneration,
        role: body.role,
      });
      if (recoveredClaim !== null) {
        const browserSession = await this.#finishBrowserRecovery({
          sessionId,
          capabilityId: body.capabilityId,
          claim: recoveredClaim,
          executionBinding: principal,
          authorization: recoveredClaim.authorization,
          sourceSha: context.commitSha,
        });
        sendJson(response, 200, { browserSession });
        return;
      }
      const authorized = this.#policy.evaluateForDurableState(context);
      const currentCredentialGeneration = await this.#currentCredentialGeneration(context.credentialRef);
      if (currentCredentialGeneration !== context.credentialGeneration) {
        fail('stale_credential_generation', 'credential generation changed during browser execution');
      }
      const authorization = Object.freeze({
        actionClass: authorized.actionClass,
        authStrategyIndex: authorized.authStrategyIndex,
        leaseId,
        ruleId: authorized.ruleId,
        profileGeneration: body.profileGeneration,
        role: body.role,
        request: context,
        strategyEvidenceKey: computeAuthStrategyEvidenceKey({
          request: context,
          executionBinding: principal,
          ruleId: authorized.ruleId,
          strategyIndex: authorized.authStrategyIndex,
          authFactors: context.authFactors,
        }),
      });
      const claim = await this.#state.claimBrowserSessionExecution({
        sessionId,
        capabilityId: body.capabilityId,
        expectedGeneration: body.expectedGeneration,
        executionBinding: principal,
        authorization,
      });
      if (claim.mode === 'RECOVERY_READBACK_ONLY') {
        const browserSession = await this.#finishBrowserRecovery({
          sessionId,
          capabilityId: body.capabilityId,
          executionBinding: principal,
          claim,
          authorization,
          sourceSha: context.commitSha,
        });
        sendJson(response, 200, { browserSession });
        return;
      }
      let observedIdentity;
      try {
        await this.#browserVault.withClone({
          capabilityId: body.capabilityId,
          executionBinding: principal,
          sourceSha: context.commitSha,
        }, (cloneDirectory) => executeAbortableBrowserAdapter(this.#browserAdapter, Object.freeze({
            cloneDirectory,
            authorization,
            capabilityId: body.capabilityId,
          })));
        observedIdentity = await withTimeout(
          Promise.resolve().then(() => this.#readBrowserIdentity({
            sessionId,
            capabilityId: body.capabilityId,
          })),
          IDENTITY_READBACK_TIMEOUT_MS,
        );
        await this.#browserVault.complete({
          capabilityId: body.capabilityId,
          executionBinding: principal,
          sourceSha: context.commitSha,
          observedIdentity,
        });
        const browserSession = await this.#state.completeBrowserSession({
          sessionId,
          capabilityId: body.capabilityId,
          expectedGeneration: claim.generation,
          executionBinding: principal,
          authorization,
          readIdentity: async () => observedIdentity,
        });
        sendJson(response, 200, { browserSession });
      } catch (error) {
        const terminationUnconfirmed = error instanceof SeoriAuthError &&
          error.code === 'browser_adapter_termination_unconfirmed';
        if (!terminationUnconfirmed) {
          await this.#browserVault.abort({
            capabilityId: body.capabilityId,
            executionBinding: principal,
            sourceSha: context.commitSha,
          }).catch(() => {});
        }
        if (error instanceof SeoriAuthError && error.code === HUMAN_REAUTH_REQUIRED) {
          await this.#state.createReauthRequest({
            reason: error.details?.reason ?? 'mfa_required',
            executionBinding: principal,
            publicIdentity: claim.publicIdentity,
          });
          await this.#state.blockBrowserSessionForReauth({
            sessionId,
            capabilityId: body.capabilityId,
            expectedGeneration: claim.generation,
            executionBinding: principal,
            authorization,
          });
        } else if (!terminationUnconfirmed) {
          await this.#state.requireBrowserSessionReconciliation({
            sessionId,
            capabilityId: body.capabilityId,
            expectedGeneration: claim.generation,
            executionBinding: principal,
            authorization,
          });
        }
        throw error;
      }
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

  async #authorizeProviderControlPlanePeer(socket) {
    try {
      await this.#authorizeInternalPrincipal(socket);
    } catch {
      fail('principal_unauthenticated', 'internal control-plane mTLS peer is not the exact Backoffice identity');
    }
  }

  async #prepareProviderExecution(command, principal) {
    const request = providerGrantLeaseRequest(command, principal.subject);
    if (request.policyGeneration !== this.#policy.generation) {
      fail('stale_policy_generation', 'provider grant policy generation is stale');
    }
    if (Date.now() >= Date.parse(request.approval.expiresAt)) {
      fail('approval_expired', 'provider execution approval has expired');
    }
    if (providerGrantRequiresPerRunApproval(command) && request.approval.mode !== 'per_run') {
      fail('per_run_approval_required', 'protected provider actions require per-run approval');
    }
    if (request.authFactors.some((factor) => ['password', 'session', 'totp'].includes(factor))) {
      fail('capability_forbidden', 'browser and interactive factors must use the existing isolated browser/factor boundary');
    }
    const account = this.#policy.accounts.require({
      provider: request.provider,
      accountId: request.accountId,
      credentialRefs: [request.credentialRef],
    });
    // Registry lookup occurs before the one-use grant transition. The request can
    // select only an adapter already fixed in the root-owned runtime config.
    this.#registry.require(request.adapterId, request);
    const currentCredentialGeneration = await this.#currentCredentialGeneration(request.credentialRef);
    if (currentCredentialGeneration !== request.credentialGeneration) {
      fail('stale_credential_generation', 'provider credential generation is stale');
    }
    return Object.freeze({
      request,
      currentCredentialGeneration,
      authorized: Object.freeze({
        request,
        ruleId: command.bindingHash.slice(0, 63),
        account,
        actionClass: command.operation === 'READBACK'
          ? 'read_only'
          : command.operation === 'UPLOAD_INTERNAL' ? 'internal_upload' : 'other_mutation',
        authStrategyIndex: 0,
        authStrategies: Object.freeze([request.authFactors]),
      }),
    });
  }

  async #executeProviderGrant({ id, expectation, command, principal }) {
    const prepared = await this.#prepareProviderExecution(command, principal);
    const consumedGrant = await this.#state.consumeProviderGrant({
      id,
      expectation,
      executionBinding: principal,
    });
    if (!consumedGrant.shouldExecute) {
      return Object.freeze({
        policyGrant: consumedGrant.policyGrant,
        execution: consumedGrant.execution,
      });
    }

    let consumedLease;
    let credentialExecutionRecorded = false;
    try {
      const checkout = await this.#state.issueCredentialCheckout({
        authorized: prepared.authorized,
        workerId: principal.workerId,
        idempotencyKey: `provider-lease:${id}`,
        currentCredentialGeneration: prepared.currentCredentialGeneration,
        currentPolicyGeneration: this.#policy.generation,
      });
      consumedLease = await this.#state.consumeCredentialCheckout({
        id: checkout.id,
        expectedGeneration: checkout.generation,
        context: prepared.request,
        workerId: principal.workerId,
        currentCredentialGeneration: prepared.currentCredentialGeneration,
        currentPolicyGeneration: this.#policy.generation,
      });
      const executed = await executeConsumedProviderLease({
        consumed: consumedLease,
        registry: this.#registry,
        loadSecret: this.#loadSecret,
        command,
      });
      const credentialOutcome = executed.adapterResult.outcome === 'SUCCESS'
        ? 'SUCCESS'
        : executed.adapterResult.outcome === 'FAILED' ? 'ADAPTER_FAILED' : HUMAN_REAUTH_REQUIRED;
      await this.#state.recordCredentialExecution({
        consumed: consumedLease,
        outcome: credentialOutcome,
        ...(Number.isInteger(executed.exitCode) ? { exitCode: executed.exitCode } : {}),
        signal: executed.signal,
      });
      credentialExecutionRecorded = true;
      const recorded = await this.#state.recordProviderGrantResult({
        id,
        executionBinding: principal,
        result: executed.adapterResult,
      });
      if (executed.adapterResult.outcome === 'HUMAN_REAUTH_REQUIRED') {
        fail(HUMAN_REAUTH_REQUIRED, 'provider requires human reauthentication', { reason: 'mfa_required' });
      }
      return recorded;
    } catch (error) {
      const code = error instanceof SeoriAuthError ? error.code : 'adapter_failed';
      if (consumedLease && !credentialExecutionRecorded) {
        await this.#state.recordCredentialExecution({
          consumed: consumedLease,
          outcome: [
            'secret_load_failed', 'adapter_start_failed', 'adapter_timeout', 'adapter_output_limit',
            'invalid_adapter_result', 'adapter_result_secret_detected',
          ].includes(code) ? code.toUpperCase() : 'ADAPTER_FAILED',
        }).catch(() => {});
      }
      if (code === HUMAN_REAUTH_REQUIRED) {
        await this.#recordProviderReauth(command, principal).catch(() => {});
        throw error;
      }
      if (['secret_load_failed', 'adapter_start_failed'].includes(code)) {
        return this.#state.recordProviderGrantResult({
          id,
          executionBinding: principal,
          result: { schemaVersion: 1, outcome: 'FAILED', errorCode: code.toUpperCase() },
        });
      }
      // Once the grant has transitioned to CONSUMED, uncertain failures are never
      // retried. The result endpoint reports RESULT_UNKNOWN and the worker must use
      // a separately approved readback execution.
      return Object.freeze({
        policyGrant: consumedGrant.policyGrant,
        execution: {
          generation: command.generation,
          outcome: 'RESULT_UNKNOWN',
        },
      });
    }
  }

  async #recordProviderReauth(command, principal) {
    return this.#state.createReauthRequest({
      reason: 'mfa_required',
      executionBinding: principal,
      publicIdentity: normalizePublicIdentity({
        provider: command.provider,
        accountId: command.credential.publicAccountId,
        teamId: null,
        workspaceId: null,
        appId: command.resource.id,
      }),
    });
  }

  async #finishBrowserRecovery({
    sessionId,
    capabilityId,
    claim,
    executionBinding,
    authorization,
    sourceSha,
  }) {
    let reconciliation;
    try {
      reconciliation = normalizeReconciliation(await withTimeout(
        Promise.resolve().then(() => this.#reconcileBrowserSession(Object.freeze({
          sessionId,
          capabilityId,
          authorization,
        }))),
        IDENTITY_READBACK_TIMEOUT_MS,
      ));
    } catch (error) {
      if (error instanceof SeoriAuthError) throw error;
      fail('browser_reconciliation_failed', 'trusted browser reconciliation failed');
    }
    await this.#browserVault.abort({
      capabilityId,
      executionBinding,
      sourceSha,
    }).catch(() => {});
    if (reconciliation.outcome === 'UNKNOWN') {
      fail('browser_reconciliation_required', 'browser action outcome remains unknown');
    }
    if (reconciliation.outcome === 'NOT_APPLIED') {
      await this.#state.abortBrowserSessionAfterReconciliation({
        sessionId,
        capabilityId,
        expectedGeneration: claim.generation,
        executionBinding,
        authorization,
      });
      fail('browser_reconciliation_not_applied', 'browser action was verified as not applied');
    }
    return this.#state.completeBrowserSession({
      sessionId,
      capabilityId,
      expectedGeneration: claim.generation,
      executionBinding,
      authorization,
      recoveryMode: true,
      readIdentity: async () => reconciliation.publicIdentity,
    });
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

  async #attestPrincipal(request) {
    let principal;
    try {
      // Unix deployments attest the accepted socket. Kubernetes mTLS deployments may
      // additionally verify a scheduler-signed, short-lived run attestation header.
      // Neither mode trusts claims in the JSON body as the principal source.
      principal = await this.#authenticatePrincipal(request.socket, Object.freeze({
        runAttestation: request.headers['seori-run-attestation'],
      }));
      return normalizeExecutionBinding(principal);
    } catch {
      fail('principal_unauthenticated', 'transport peer principal could not be attested');
    }
  }
}
