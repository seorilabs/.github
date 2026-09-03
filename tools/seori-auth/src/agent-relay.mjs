import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { constants as fsConstants } from 'node:fs';
import { chmod, chown, lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

import { fail, SeoriAuthError } from './errors.mjs';

const REQUEST_LIMIT = 6 * 1024 * 1024;
const RESPONSE_LIMIT = 512 * 1024;
const MAX_CONNECTIONS = 4;
const MAX_IN_FLIGHT = 2;
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FORBIDDEN_KEY_PARTS = Object.freeze([
  'apikey',
  'authorization',
  'bearer',
  'certificate',
  'clientkey',
  'cookie',
  'credential',
  'password',
  'passwd',
  'privatekey',
  'recoverycode',
  'secret',
  'signingkey',
  'token',
  'totp',
]);
const FORBIDDEN_KEY_ALIASES = new Set([
  'accesskey',
  'clientcert',
  'jwt',
  'keypem',
  'mnemonic',
  'mtlscert',
  'mtlskey',
  'onetimepassword',
  'otp',
  'passcode',
  'passphrase',
  'pem',
  'pfx',
  'pin',
  'pincode',
  'pkcs8',
  'privatepem',
  'recoveryphrase',
  'secretkey',
  'seedphrase',
  'sessionkey',
  'signingpem',
  'tlscert',
  'tlskey',
]);
function normalizeJsonKey(value) {
  return value.replace(/[^a-z0-9]/giu, '').toLowerCase();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort((left, right) => left.localeCompare(right)).map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function exactObject(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function validPublicId(value) {
  return typeof value === 'string' && PUBLIC_ID.test(value);
}

function relayProjectionPayload(config) {
  const { projectionDigest: _projectionDigest, ...controlPlane } = config.controlPlane;
  return {
    schemaVersion: config.schemaVersion,
    controlPlane,
    workerKind: config.workerKind,
    socketPath: config.socketPath,
    expectedPeer: config.expectedPeer,
    nativeHelper: config.nativeHelper,
    upstream: config.upstream,
  };
}

export function agentRelayProjectionDigest(config) {
  return createHash('sha256').update(canonicalJson(relayProjectionPayload(config)), 'utf8').digest('hex');
}

export function assertAgentRelayProjection(config) {
  const controlPlane = config?.controlPlane;
  if (
    !exactObject(controlPlane, [
      'contractVersion', 'projectionId', 'projectionDigest', 'configRevision',
      'discoveryObservation', 'providerObservation',
    ]) ||
    controlPlane.contractVersion !== 'agent-relay-projection/v1' ||
    !validPublicId(controlPlane.projectionId) || !SHA256.test(controlPlane.projectionDigest ?? '') ||
    !exactObject(controlPlane.configRevision, ['appId', 'id', 'revision', 'snapshotDigest']) ||
    !validPublicId(controlPlane.configRevision.appId) ||
    !validPublicId(controlPlane.configRevision.id) ||
    !Number.isSafeInteger(controlPlane.configRevision.revision) ||
    controlPlane.configRevision.revision < 1 ||
    !SHA256.test(controlPlane.configRevision.snapshotDigest ?? '') ||
    !exactObject(controlPlane.discoveryObservation, ['id', 'payloadHash', 'sourceSha']) ||
    !validPublicId(controlPlane.discoveryObservation.id) ||
    !SHA1.test(controlPlane.discoveryObservation.sourceSha ?? '') ||
    !SHA256.test(controlPlane.discoveryObservation.payloadHash ?? '') ||
    !exactObject(controlPlane.providerObservation, ['id', 'payloadHash']) ||
    !validPublicId(controlPlane.providerObservation.id) ||
    !SHA256.test(controlPlane.providerObservation.payloadHash ?? '')
  ) fail('invalid_agent_relay_projection', 'agent relay control-plane projection is invalid');
  const actual = agentRelayProjectionDigest(config);
  if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(controlPlane.projectionDigest, 'hex'))) {
    fail('agent_relay_projection_mismatch', 'agent relay config does not match its control-plane projection');
  }
  return Object.freeze({
    contractVersion: controlPlane.contractVersion,
    projectionId: controlPlane.projectionId,
    projectionDigest: controlPlane.projectionDigest,
    configRevision: Object.freeze({ ...controlPlane.configRevision }),
    discoveryObservation: Object.freeze({ ...controlPlane.discoveryObservation }),
    providerObservation: Object.freeze({ ...controlPlane.providerObservation }),
  });
}

function isCredentialJsonKey(value) {
  const normalized = normalizeJsonKey(value);
  return FORBIDDEN_KEY_ALIASES.has(normalized) ||
    FORBIDDEN_KEY_PARTS.some((part) => normalized.includes(part));
}

function isValidPublicTokenMetadata(key, value) {
  const normalized = normalizeJsonKey(key);
  if (normalized === 'nextpagetokenpresent') return typeof value === 'boolean';
  if (normalized !== 'tokenpagination' || !value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return entries.length === 1 && normalizeJsonKey(entries[0][0]) === 'nextpagetokenpresent' &&
    typeof entries[0][1] === 'boolean';
}

export function assertAgentRelayPublicJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_agent_relay_payload', 'agent relay payload must be a JSON object');
  }
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, entry] of Object.entries(current)) {
      if (isCredentialJsonKey(key)) {
        if (!isValidPublicTokenMetadata(key, entry)) {
          fail('agent_relay_secret_field_rejected', 'agent relay payload contains a forbidden credential field');
        }
      }
      stack.push(entry);
    }
  }
  return value;
}

function parseJsonBuffer(encoded) {
  try {
    return assertAgentRelayPublicJson(JSON.parse(encoded.toString('utf8')));
  } catch (error) {
    if (error instanceof SeoriAuthError) throw error;
    fail('invalid_agent_relay_payload', 'agent relay payload is not valid JSON');
  }
}

function normalizeHttpsOrigin(value) {
  let origin;
  try {
    origin = new URL(value);
  } catch {
    fail('invalid_agent_relay_upstream', 'agent relay upstream origin is invalid');
  }
  if (
    origin.protocol !== 'https:' || origin.username !== '' || origin.password !== '' ||
    origin.pathname !== '/' || origin.search !== '' || origin.hash !== ''
  ) fail('invalid_agent_relay_upstream', 'agent relay upstream must be an exact HTTPS origin');
  if (
    origin.port !== '' &&
    (!/^\d{1,5}$/.test(origin.port) || Number(origin.port) < 1 || Number(origin.port) > 65_535)
  ) {
    fail('invalid_agent_relay_upstream', 'agent relay upstream port is invalid');
  }
  const hostname = origin.hostname.startsWith('[') && origin.hostname.endsWith(']')
    ? origin.hostname.slice(1, -1)
    : origin.hostname;
  return Object.freeze({ hostname, port: origin.port ? Number(origin.port) : 443 });
}

async function readTlsFile(path, { privateMaterial = false } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    fail('invalid_agent_relay_tls', 'agent relay TLS paths must be absolute');
  }
  const [entry, canonical] = await Promise.all([lstat(path), realpath(path)]);
  if (!entry.isFile() || entry.isSymbolicLink() || canonical !== path || entry.uid !== process.getuid?.()) {
    fail('invalid_agent_relay_tls', 'agent relay TLS material must be a canonical daemon-owned file');
  }
  if ((entry.mode & 0o022) !== 0) {
    fail('invalid_agent_relay_tls', 'agent relay TLS material must not be writable by group or world');
  }
  if (privateMaterial && (entry.mode & 0o077) !== 0) {
    fail('invalid_agent_relay_tls', 'agent relay private key must be owner-only');
  }
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== entry.dev || opened.ino !== entry.ino || opened.uid !== entry.uid ||
      opened.gid !== entry.gid || opened.mode !== entry.mode || opened.size !== entry.size
    ) fail('invalid_agent_relay_tls', 'agent relay TLS material changed while opening');
    const value = await handle.readFile();
    if (value.length === 0 || value.length > 1024 * 1024) {
      value.fill(0);
      fail('invalid_agent_relay_tls', 'agent relay TLS material size is invalid');
    }
    return value;
  } finally {
    await handle.close();
  }
}

async function assertTrustedAncestors(path, expectedOwnerUid, {
  code = 'insecure_agent_relay_config_ancestor',
  message = 'agent relay config ancestors must be trusted',
} = {}) {
  let current = dirname(path);
  while (true) {
    const [entry, canonical] = await Promise.all([lstat(current), realpath(current)]);
    if (
      !entry.isDirectory() || entry.isSymbolicLink() || canonical !== current ||
      (entry.uid !== 0 && entry.uid !== expectedOwnerUid) || (entry.mode & 0o022) !== 0
    ) fail(code, message);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function assertAgentRelayClientSocket(path, {
  expectedDirectoryUid = 0,
  expectedSocketUid = process.getuid?.(),
  expectedSocketGid = process.getgid?.(),
} = {}) {
  if (
    typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') ||
    !Number.isSafeInteger(expectedDirectoryUid) || expectedDirectoryUid < 0 ||
    !Number.isSafeInteger(expectedSocketUid) || expectedSocketUid < 1 ||
    !Number.isSafeInteger(expectedSocketGid) || expectedSocketGid < 1
  ) fail('invalid_agent_relay_socket', 'agent relay client socket binding is invalid');
  await assertTrustedAncestors(path, expectedDirectoryUid);
  const parent = dirname(path);
  const [parentEntry, canonicalParent] = await Promise.all([lstat(parent), realpath(parent)]);
  if (
    !parentEntry.isDirectory() || parentEntry.isSymbolicLink() || canonicalParent !== parent ||
    parentEntry.uid !== expectedDirectoryUid || (parentEntry.mode & 0o777) !== 0o711
  ) fail('insecure_agent_relay_socket_directory', 'agent relay socket directory is not trusted');
  const [entry, canonical] = await Promise.all([lstat(path), realpath(path)]);
  if (
    !entry.isSocket() || entry.isSymbolicLink() || canonical !== path ||
    entry.uid !== expectedSocketUid || entry.gid !== expectedSocketGid ||
    (entry.mode & 0o777) !== 0o600
  ) fail('insecure_agent_relay_socket', 'agent relay client socket is not trusted');
}

export function executeAgentRelayClientRequest({
  socketPath,
  encoded,
  requestImpl = httpRequest,
  timeoutMs = 30_000,
}) {
  if (
    typeof socketPath !== 'string' || !isAbsolute(socketPath) || socketPath.includes('\0') ||
    !Buffer.isBuffer(encoded) || encoded.length < 2 || encoded.length > REQUEST_LIMIT ||
    typeof requestImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
  ) fail('invalid_agent_relay_request', 'agent relay client request is invalid');
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const clearChunks = () => chunks.forEach((entry) => entry.fill(0));
    const rejectStable = (code, message) => {
      if (settled) return;
      settled = true;
      clearChunks();
      reject(new SeoriAuthError(code, message));
    };
    const request = requestImpl({
      socketPath,
      path: '/v1/execute',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(encoded.length),
      },
      timeout: timeoutMs,
    }, (response) => {
      response.on('data', (chunk) => {
        if (settled) return;
        const copy = Buffer.from(chunk);
        bytes += copy.length;
        if (bytes > RESPONSE_LIMIT) {
          copy.fill(0);
          rejectStable('agent_relay_response_too_large', 'agent relay response exceeded its bound');
          response.destroy();
          return;
        }
        chunks.push(copy);
      });
      response.once('aborted', () => rejectStable(
        'agent_relay_response_rejected',
        'agent relay response was aborted',
      ));
      response.once('error', () => rejectStable(
        'agent_relay_response_rejected',
        'agent relay response failed',
      ));
      response.on('end', () => {
        if (settled) return;
        settled = true;
        const payload = Buffer.concat(chunks);
        try {
          const contentType = String(response.headers['content-type'] ?? '')
            .split(';', 1)[0].trim().toLowerCase();
          if (contentType !== 'application/json') {
            throw new SeoriAuthError(
              'agent_relay_response_rejected',
              'agent relay response content type is invalid',
            );
          }
          resolve({
            statusCode: response.statusCode ?? 500,
            body: parseJsonBuffer(payload),
          });
        } catch (error) {
          reject(error instanceof SeoriAuthError ? error : new SeoriAuthError(
            'agent_relay_response_rejected',
            'agent relay response is invalid',
          ));
        } finally {
          payload.fill(0);
          clearChunks();
        }
      });
    });
    request.once('timeout', () => request.destroy());
    request.once('error', () => rejectStable(
      'agent_relay_request_failed',
      'agent relay request failed',
    ));
    request.end(encoded);
  });
}

export async function readImmutableAgentRelayConfig(path, { expectedOwnerUid = 0 } = {}) {
  if (
    typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') ||
    !Number.isSafeInteger(expectedOwnerUid) || expectedOwnerUid < 0
  ) fail('invalid_agent_relay_config', 'agent relay config path or owner is invalid');
  await assertTrustedAncestors(path, expectedOwnerUid);
  const [entry, canonical] = await Promise.all([lstat(path), realpath(path)]);
  if (
    !entry.isFile() || entry.isSymbolicLink() || canonical !== path ||
    entry.uid !== expectedOwnerUid || (entry.mode & 0o022) !== 0 ||
    entry.size < 2 || entry.size > 64 * 1024
  ) fail('invalid_agent_relay_config', 'agent relay config must be an immutable owned file');
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== entry.dev || opened.ino !== entry.ino || opened.uid !== entry.uid ||
      opened.gid !== entry.gid || opened.mode !== entry.mode || opened.size !== entry.size
    ) fail('invalid_agent_relay_config', 'agent relay config changed while opening');
    const encoded = await handle.readFile();
    try {
      if (encoded.length !== opened.size) {
        fail('invalid_agent_relay_config', 'agent relay config changed while reading');
      }
      return JSON.parse(encoded.toString('utf8'));
    } catch (error) {
      if (error instanceof SeoriAuthError) throw error;
      fail('invalid_agent_relay_config', 'agent relay config is not valid JSON');
    } finally {
      encoded.fill(0);
    }
  } finally {
    await handle.close();
  }
}

function validateServerName(value) {
  if (typeof value !== 'string' || value !== value.toLowerCase() || !DNS_NAME.test(value)) {
    fail('invalid_agent_relay_upstream', 'agent relay upstream server name is invalid');
  }
  return value;
}

export async function createAgentMtlsForwarder({
  origin,
  serverName,
  tls,
  requestImpl = httpsRequest,
}) {
  if (!tls || typeof tls !== 'object' || Array.isArray(tls) || typeof requestImpl !== 'function') {
    throw new TypeError('agent relay requires TLS paths and an HTTPS request implementation');
  }
  const target = normalizeHttpsOrigin(origin);
  const expectedServerName = validateServerName(serverName);
  const loaded = [];
  let ca;
  let certificate;
  let privateKey;
  try {
    ca = await readTlsFile(tls.caPath);
    loaded.push(ca);
    certificate = await readTlsFile(tls.certificatePath);
    loaded.push(certificate);
    privateKey = await readTlsFile(tls.privateKeyPath, { privateMaterial: true });
    loaded.push(privateKey);
  } catch (error) {
    loaded.forEach((entry) => entry.fill(0));
    throw error;
  }
  const agent = new HttpsAgent({ keepAlive: false, maxSockets: MAX_IN_FLIGHT });
  let closed = false;

  return Object.freeze({
    async forward(value) {
      if (closed) fail('agent_relay_closed', 'agent relay forwarder is closed');
      const encoded = Buffer.from(JSON.stringify(assertAgentRelayPublicJson(value)), 'utf8');
      if (encoded.length > REQUEST_LIMIT) {
        encoded.fill(0);
        fail('agent_relay_request_too_large', 'agent relay request exceeded its bound');
      }
      try {
        return await new Promise((resolve, reject) => {
          const request = requestImpl({
            protocol: 'https:',
            hostname: target.hostname,
            port: target.port,
            servername: expectedServerName,
            method: 'POST',
            path: '/v1/execute',
            ca,
            cert: certificate,
            key: privateKey,
            agent,
            minVersion: 'TLSv1.3',
            maxVersion: 'TLSv1.3',
            headers: {
              'content-type': 'application/json',
              'content-length': String(encoded.length),
            },
            timeout: 30_000,
          }, (response) => {
            const chunks = [];
            let bytes = 0;
            let rejected = false;
            const rejectResponse = (error) => {
              if (rejected) return;
              rejected = true;
              chunks.forEach((entry) => entry.fill(0));
              reject(error instanceof SeoriAuthError ? error : new SeoriAuthError(
                'agent_relay_upstream_rejected',
                'agent relay upstream response failed',
              ));
            };
            response.on('data', (chunk) => {
              if (rejected) return;
              const copy = Buffer.from(chunk);
              bytes += copy.length;
              if (bytes > RESPONSE_LIMIT) {
                copy.fill(0);
                rejectResponse(new SeoriAuthError(
                  'agent_relay_upstream_rejected',
                  'agent relay upstream response exceeded its bound',
                ));
                request.destroy(new Error('agent relay upstream response exceeded its bound'));
                return;
              }
              chunks.push(copy);
            });
            response.once('aborted', () => rejectResponse(new SeoriAuthError(
              'agent_relay_upstream_rejected',
              'agent relay upstream response was aborted',
            )));
            response.once('error', () => rejectResponse(new SeoriAuthError(
              'agent_relay_upstream_rejected',
              'agent relay upstream response failed',
            )));
            response.on('end', () => {
              if (rejected) return;
              const statusCode = response.statusCode ?? 500;
              const contentType = String(response.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
              const payload = Buffer.concat(chunks);
              try {
                if (
                  contentType !== 'application/json' || statusCode < 200 || statusCode >= 500 ||
                  (statusCode >= 300 && statusCode < 400)
                ) fail('agent_relay_upstream_rejected', 'agent relay upstream response is not public JSON');
                const body = Buffer.from(`${JSON.stringify(parseJsonBuffer(payload))}\n`, 'utf8');
                resolve(Object.freeze({ statusCode, body }));
              } catch (error) {
                reject(error);
              } finally {
                payload.fill(0);
                chunks.forEach((entry) => entry.fill(0));
              }
            });
          });
          request.once('timeout', () => request.destroy(new Error('agent relay upstream timed out')));
          request.once('error', () => reject(new SeoriAuthError(
            'agent_relay_upstream_rejected',
            'agent relay upstream request failed',
          )));
          request.end(encoded);
        });
      } finally {
        encoded.fill(0);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      agent.destroy();
      ca.fill(0);
      certificate.fill(0);
      privateKey.fill(0);
    },
  });
}

async function preparePrivateSocketDirectory(path) {
  const [entry, canonical] = await Promise.all([lstat(path), realpath(path)]);
  const mode = entry.mode & 0o777;
  if (
    !entry.isDirectory() || entry.isSymbolicLink() || canonical !== path ||
    entry.uid !== process.getuid?.() || (mode !== 0o700 && mode !== 0o711)
  ) fail('insecure_agent_relay_directory', 'agent relay socket directory mode is invalid');
  if (mode === 0o700) return;
  await chmod(path, 0o700);
  const prepared = await lstat(path);
  if (
    !prepared.isDirectory() || prepared.isSymbolicLink() ||
    prepared.dev !== entry.dev || prepared.ino !== entry.ino ||
    prepared.uid !== entry.uid || (prepared.mode & 0o777) !== 0o700
  ) fail('insecure_agent_relay_directory', 'agent relay socket directory changed while preparing');
}

async function assertSocketPathAvailable(path) {
  try {
    await lstat(path);
    fail('agent_relay_socket_in_use', 'agent relay socket path already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function readRequestBody(request) {
  const declaredLength = request.headers['content-length'];
  if (
    request.headers['transfer-encoding'] !== undefined || typeof declaredLength !== 'string' ||
    !/^\d{1,8}$/.test(declaredLength) || Number(declaredLength) > REQUEST_LIMIT
  ) fail('invalid_agent_relay_payload', 'agent relay request length is invalid');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const copy = Buffer.from(chunk);
    bytes += copy.length;
    if (bytes > REQUEST_LIMIT || bytes > Number(declaredLength)) {
      copy.fill(0);
      chunks.forEach((entry) => entry.fill(0));
      fail('agent_relay_request_too_large', 'agent relay request exceeded its bound');
    }
    chunks.push(copy);
  }
  if (bytes !== Number(declaredLength)) {
    chunks.forEach((entry) => entry.fill(0));
    fail('invalid_agent_relay_payload', 'agent relay request length does not match');
  }
  const encoded = Buffer.concat(chunks);
  try {
    return parseJsonBuffer(encoded);
  } finally {
    encoded.fill(0);
    chunks.forEach((entry) => entry.fill(0));
  }
}

function responseStatus(code) {
  if (code === 'method_not_allowed') return 405;
  if (code === 'route_not_found') return 404;
  if (code === 'peer_identity_mismatch' || code === 'peer_attestation_failed') return 403;
  if (code?.startsWith('invalid_') || code === 'agent_relay_secret_field_rejected') return 400;
  if (code?.startsWith('agent_relay_upstream')) return 502;
  return 500;
}

function sendJson(response, statusCode, value) {
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': String(encoded.length),
    'cache-control': 'no-store',
  });
  response.end(encoded, () => encoded.fill(0));
}

export class AgentRelayDaemon {
  #socketPath;
  #expectedPeerUid;
  #expectedPeerGid;
  #nativeBoundary;
  #forwarder;
  #server;
  #socketIdentity;
  #inFlight = 0;

  constructor({ socketPath, expectedPeerUid, expectedPeerGid, nativeBoundary, forwarder }) {
    if (typeof socketPath !== 'string' || !isAbsolute(socketPath)) {
      throw new TypeError('agent relay socketPath must be absolute');
    }
    if (!Number.isSafeInteger(expectedPeerUid) || expectedPeerUid < 1) {
      throw new TypeError('agent relay expectedPeerUid must be a non-root OS UID');
    }
    if (!Number.isSafeInteger(expectedPeerGid) || expectedPeerGid < 1) {
      throw new TypeError('agent relay expectedPeerGid must be a non-root OS GID');
    }
    if (!nativeBoundary || typeof nativeBoundary.attest !== 'function') {
      throw new TypeError('agent relay requires the native peer attestation boundary');
    }
    if (!forwarder || typeof forwarder.forward !== 'function' || typeof forwarder.close !== 'function') {
      throw new TypeError('agent relay requires an mTLS forwarder');
    }
    this.#socketPath = socketPath;
    this.#expectedPeerUid = expectedPeerUid;
    this.#expectedPeerGid = expectedPeerGid;
    this.#nativeBoundary = nativeBoundary;
    this.#forwarder = forwarder;
  }

  async start() {
    if (this.#server) fail('daemon_already_started', 'agent relay is already started');
    const directory = dirname(this.#socketPath);
    await assertTrustedAncestors(directory, process.getuid?.(), {
      code: 'insecure_agent_relay_directory',
      message: 'agent relay socket directory ancestors must be trusted',
    });
    await preparePrivateSocketDirectory(directory);
    await assertSocketPathAvailable(this.#socketPath);
    const server = createServer((request, response) => {
      void this.#dispatchBounded(request, response).catch(() => response.destroy());
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 1_000;
    server.maxHeadersCount = 16;
    server.maxRequestsPerSocket = 1;
    server.maxConnections = MAX_CONNECTIONS;
    server.dropMaxConnection = true;
    server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.#socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.#server = server;
    try {
      const createdSocket = await lstat(this.#socketPath);
      if (createdSocket.uid !== this.#expectedPeerUid || createdSocket.gid !== this.#expectedPeerGid) {
        await chown(this.#socketPath, this.#expectedPeerUid, this.#expectedPeerGid);
      }
      await chmod(this.#socketPath, 0o600);
      const socket = await lstat(this.#socketPath);
      if (
        !socket.isSocket() || socket.uid !== this.#expectedPeerUid ||
        socket.gid !== this.#expectedPeerGid || (socket.mode & 0o777) !== 0o600
      ) fail('insecure_agent_relay_socket', 'agent relay socket ownership is invalid');
      this.#socketIdentity = Object.freeze({ dev: socket.dev, ino: socket.ino });
      await chmod(directory, 0o711);
    } catch (error) {
      await new Promise((resolve) => server.close(() => resolve()));
      this.#server = undefined;
      await unlink(this.#socketPath).catch(() => {});
      throw error;
    }
    return Object.freeze({ transport: 'unix', socketPath: this.#socketPath });
  }

  async #dispatchBounded(request, response) {
    if (this.#inFlight >= MAX_IN_FLIGHT) {
      sendJson(response, 503, { error: { code: 'agent_relay_busy' } });
      request.resume();
      return;
    }
    this.#inFlight += 1;
    try {
      await this.dispatch(request, response);
    } finally {
      this.#inFlight -= 1;
    }
  }

  async dispatch(request, response) {
    try {
      if (request.method !== 'POST') fail('method_not_allowed', 'agent relay accepts POST only');
      if (request.url !== '/v1/execute') fail('route_not_found', 'agent relay route does not exist');
      if (String(request.headers['content-type'] ?? '').toLowerCase() !== 'application/json') {
        fail('invalid_agent_relay_payload', 'agent relay requires application/json');
      }
      if (
        request.headers.authorization !== undefined || request.headers.cookie !== undefined ||
        request.headers['proxy-authorization'] !== undefined
      ) fail('agent_relay_secret_field_rejected', 'agent relay rejects credential headers');
      const peer = await this.#nativeBoundary.attest(request.socket);
      if (peer.uid !== this.#expectedPeerUid || peer.gid !== this.#expectedPeerGid) {
        fail('peer_identity_mismatch', 'agent relay peer does not match the configured worker');
      }
      const body = await readRequestBody(request);
      const upstream = await this.#forwarder.forward(body);
      response.writeHead(upstream.statusCode, {
        'content-type': 'application/json',
        'content-length': String(upstream.body.length),
        'cache-control': 'no-store',
      });
      response.end(upstream.body, () => upstream.body.fill(0));
    } catch (error) {
      const code = error instanceof SeoriAuthError ? error.code : 'agent_relay_internal_error';
      if (!response.headersSent) sendJson(response, responseStatus(code), { error: { code } });
      else response.destroy();
    }
  }

  async stop() {
    const server = this.#server;
    const identity = this.#socketIdentity;
    this.#server = undefined;
    this.#socketIdentity = undefined;
    const directory = dirname(this.#socketPath);
    await chmod(directory, 0o700).catch(() => {});
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    try {
      const socket = await lstat(this.#socketPath);
      if (socket.isSocket() && socket.dev === identity?.dev && socket.ino === identity?.ino) {
        await unlink(this.#socketPath);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    } finally {
      this.#forwarder.close();
    }
  }
}
