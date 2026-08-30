import { createPrivateKey, X509Certificate } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { checkServerIdentity as checkTlsServerIdentity } from 'node:tls';

import { fail } from './errors.mjs';
import {
  createTrustedJournalCheckpointControlPlane,
  JOURNAL_CHECKPOINT_GENESIS_MAC,
  normalizeJournalCheckpoint,
  normalizeJournalCheckpointBinding,
} from './journal-checkpoint.mjs';
import { PROVIDER_CONTROL_PLANE_CLIENT_SPIFFE_ID } from './provider-grants.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const NUMERIC_ID = /^(?:0|[1-9][0-9]*)$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export const JOURNAL_CHECKPOINT_AUTHORITY = Object.freeze({
  origin: 'https://provider-execution-signer.platform.svc.cluster.local:9443',
  hostname: 'provider-execution-signer.platform.svc.cluster.local',
  port: 9443,
  serverSpiffeId: PROVIDER_CONTROL_PLANE_CLIENT_SPIFFE_ID,
  clientSpiffeId: 'spiffe://seorilabs.local/ns/auth-broker/sa/seori-auth-broker',
  tls: Object.freeze({
    secretName: 'seori-auth-journal-checkpoint-client-tls',
    caPath: '/etc/seori-auth/journal-checkpoint-tls/ca.crt',
    certificatePath: '/etc/seori-auth/journal-checkpoint-tls/tls.crt',
    privateKeyPath: '/etc/seori-auth/journal-checkpoint-tls/tls.key',
  }),
  routes: Object.freeze({
    genesis: '/v1/auth-broker/journal-checkpoints/genesis',
    read: '/v1/auth-broker/journal-checkpoints/read',
    advance: '/v1/auth-broker/journal-checkpoints/advance',
  }),
});

const AUTHORITY_ROUTES = new Set(Object.values(JOURNAL_CHECKPOINT_AUTHORITY.routes));
const AUTHORITY_STATE_KEYS = [
  'checkpointDigest', 'generation', 'journalId', 'sequence', 'updatedAt',
];
const AUTHORITY_IDENTITY_KEYS = ['origin', 'serverSpiffeId'];
const CHECKPOINT_HEALTH = Object.freeze({
  healthy: 'HEALTHY',
  initializing: 'INITIALIZING',
  sealed: 'SEALED',
});

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).toSorted().join('\0') === [...expected].toSorted().join('\0');
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactSubjectAlternativeNames(value, expected) {
  if (typeof value !== 'string') return false;
  const names = value.split(', ');
  return names.length === expected.length &&
    new Set(names).size === names.length &&
    expected.every((name) => names.includes(name));
}

/** Node의 DNS 검증에 더해 signer certificate의 exact DNS+SPIFFE SAN만 허용한다. */
export function checkJournalCheckpointAuthorityIdentity(hostname, certificate) {
  if (hostname !== JOURNAL_CHECKPOINT_AUTHORITY.hostname) {
    return stableError('JOURNAL_CHECKPOINT_AUTHORITY_ORIGIN_MISMATCH');
  }
  const hostnameError = checkTlsServerIdentity(hostname, certificate);
  if (hostnameError) return stableError('JOURNAL_CHECKPOINT_AUTHORITY_IDENTITY_MISMATCH');
  if (!exactSubjectAlternativeNames(certificate?.subjectaltname, [
    `DNS:${JOURNAL_CHECKPOINT_AUTHORITY.hostname}`,
    `URI:${JOURNAL_CHECKPOINT_AUTHORITY.serverSpiffeId}`,
  ])) return stableError('JOURNAL_CHECKPOINT_AUTHORITY_IDENTITY_MISMATCH');
  return undefined;
}

export function assertJournalCheckpointClientIdentity(subjectAltName) {
  if (subjectAltName !== `URI:${JOURNAL_CHECKPOINT_AUTHORITY.clientSpiffeId}`) {
    fail(
      'state_checkpoint_mtls_identity_invalid',
      'journal checkpoint client certificate identity is invalid',
    );
  }
}

function numericId(value) {
  if (typeof value !== 'string' || !NUMERIC_ID.test(value)) {
    fail('invalid_state_checkpoint', 'journal checkpoint authority returned an invalid numeric id');
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('invalid_state_checkpoint', 'journal checkpoint authority numeric id is out of range');
  }
  return Number(parsed);
}

function normalizeAuthorityState(value, expectedJournalId) {
  if (
    !exactKeys(value, AUTHORITY_STATE_KEYS) || value.journalId !== expectedJournalId ||
    !SHA256.test(value.checkpointDigest ?? '') || typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    new Date(value.updatedAt).toISOString() !== value.updatedAt
  ) fail('invalid_state_checkpoint', 'journal checkpoint authority state is invalid');
  const generation = numericId(value.generation);
  const sequence = numericId(value.sequence);
  if (generation !== sequence) {
    fail('invalid_state_checkpoint', 'journal checkpoint authority lineage is invalid');
  }
  const local = normalizeJournalCheckpoint({
    schemaVersion: 1,
    journalId: value.journalId,
    generation,
    sequence,
    // Backoffice genesis has its own opaque digest. It is the expectedDigest for
    // the first authority CAS, while the local empty HMAC journal keeps its fixed
    // zero head. From generation 1 onward the authority digest is the HMAC head.
    headMac: generation === 0 ? JOURNAL_CHECKPOINT_GENESIS_MAC : value.checkpointDigest,
  }, expectedJournalId);
  return Object.freeze({
    local,
    expectedDigest: value.checkpointDigest,
  });
}

function normalizeGenesisResponse(value, journalId) {
  if (!exactKeys(value, ['checkpoint', 'created']) || typeof value.created !== 'boolean') {
    fail('invalid_state_checkpoint', 'journal checkpoint genesis response is invalid');
  }
  return normalizeAuthorityState(value.checkpoint, journalId);
}

function normalizeReadResponse(value, journalId) {
  if (!exactKeys(value, ['checkpoint'])) {
    fail('invalid_state_checkpoint', 'journal checkpoint read response is invalid');
  }
  return value.checkpoint === null ? null : normalizeAuthorityState(value.checkpoint, journalId);
}

function normalizeAdvanceResponse(value, journalId) {
  if (
    !exactKeys(value, ['checkpoint', 'outcome']) ||
    !['ADVANCED', 'REPLAYED'].includes(value.outcome)
  ) fail('invalid_state_checkpoint', 'journal checkpoint advance response is invalid');
  return normalizeAuthorityState(value.checkpoint, journalId);
}

function authorityErrorCode(value) {
  return exactKeys(value, ['error']) && exactKeys(value.error, ['code']) &&
    typeof value.error.code === 'string' ? value.error.code : undefined;
}

function sameLocalCheckpoint(left, right) {
  return left.generation === right.generation && left.sequence === right.sequence &&
    left.headMac === right.headMac && left.journalId === right.journalId;
}

function normalizeAuthorityResponseIdentity(value) {
  if (
    !exactKeys(value, AUTHORITY_IDENTITY_KEYS) ||
    value.origin !== JOURNAL_CHECKPOINT_AUTHORITY.origin ||
    value.serverSpiffeId !== JOURNAL_CHECKPOINT_AUTHORITY.serverSpiffeId
  ) fail('invalid_state_checkpoint', 'journal checkpoint authority response identity is invalid');
  return Object.freeze({
    origin: value.origin,
    serverSpiffeId: value.serverSpiffeId,
  });
}

function sameAuthorityResponseIdentity(left, right) {
  return left.origin === right.origin && left.serverSpiffeId === right.serverSpiffeId;
}

async function readTlsFile(path) {
  const [entry, canonical] = await Promise.all([lstat(path), realpath(path)]);
  if (
    !entry.isFile() || entry.isSymbolicLink() || canonical !== path ||
    // Renderer의 exact 0440 execution copy와 같은 경계만 허용한다. cert/CA도 임의로
    // 더 넓은 mode를 허용하지 않아 deployment contract drift를 startup에서 차단한다.
    (entry.mode & 0o777) !== 0o440
  ) fail('state_checkpoint_mtls_unavailable', 'journal checkpoint mTLS material is invalid');
  const value = await readFile(path);
  if (value.length === 0 || value.length > 64 * 1024) {
    value.fill(0);
    fail('state_checkpoint_mtls_unavailable', 'journal checkpoint mTLS material is invalid');
  }
  return value;
}

function createHttpsPost({ ca, certificate, privateKey, requestImpl = httpsRequest }) {
  if (typeof requestImpl !== 'function') {
    fail('state_checkpoint_transport_unavailable', 'journal checkpoint HTTPS transport is invalid');
  }
  let closed = false;
  return Object.freeze({
    authorityIdentity: Object.freeze({
      origin: JOURNAL_CHECKPOINT_AUTHORITY.origin,
      serverSpiffeId: JOURNAL_CHECKPOINT_AUTHORITY.serverSpiffeId,
    }),
    async post(path, body) {
      if (closed) fail('state_checkpoint_transport_closed', 'journal checkpoint transport is closed');
      if (!AUTHORITY_ROUTES.has(path)) {
        fail('invalid_state_checkpoint', 'journal checkpoint route is not allowlisted');
      }
      const encoded = Buffer.from(JSON.stringify(body), 'utf8');
      try {
        return await new Promise((resolve, reject) => {
          const request = requestImpl({
            protocol: 'https:',
            hostname: JOURNAL_CHECKPOINT_AUTHORITY.hostname,
            port: JOURNAL_CHECKPOINT_AUTHORITY.port,
            method: 'POST',
            path,
            ca,
            cert: certificate,
            key: privateKey,
            servername: JOURNAL_CHECKPOINT_AUTHORITY.hostname,
            minVersion: 'TLSv1.3',
            maxVersion: 'TLSv1.3',
            rejectUnauthorized: true,
            checkServerIdentity: checkJournalCheckpointAuthorityIdentity,
            agent: false,
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              'content-length': String(encoded.length),
            },
            timeout: REQUEST_TIMEOUT_MS,
          }, (response) => {
            const chunks = [];
            let bytes = 0;
            let cleared = false;
            const clearChunks = () => {
              if (cleared) return;
              cleared = true;
              for (const chunk of chunks) chunk.fill(0);
            };
            response.on('data', (chunk) => {
              const copy = Buffer.from(chunk);
              bytes += copy.length;
              if (bytes > MAX_RESPONSE_BYTES) {
                copy.fill(0);
                request.destroy(stableError('JOURNAL_CHECKPOINT_AUTHORITY_RESPONSE_LIMIT'));
                return;
              }
              chunks.push(copy);
            });
            response.on('end', () => {
              const payload = Buffer.concat(chunks);
              try {
                const contentType = response.headers?.['content-type'];
                if (typeof contentType !== 'string' || contentType.split(';', 1)[0] !== 'application/json') {
                  reject(stableError('JOURNAL_CHECKPOINT_AUTHORITY_RESPONSE_INVALID'));
                  return;
                }
                resolve({
                  status: response.statusCode ?? 0,
                  body: JSON.parse(payload.toString('utf8')),
                });
              } catch {
                reject(stableError('JOURNAL_CHECKPOINT_AUTHORITY_RESPONSE_INVALID'));
              } finally {
                payload.fill(0);
                clearChunks();
              }
            });
            const rejectResponse = () => {
              clearChunks();
              reject(stableError('JOURNAL_CHECKPOINT_AUTHORITY_UNAVAILABLE'));
            };
            response.once('aborted', rejectResponse);
            response.once('error', rejectResponse);
          });
          request.once('timeout', () => request.destroy(stableError('JOURNAL_CHECKPOINT_AUTHORITY_TIMEOUT')));
          request.once('error', () => reject(stableError('JOURNAL_CHECKPOINT_AUTHORITY_UNAVAILABLE')));
          request.end(encoded);
        });
      } finally {
        encoded.fill(0);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      ca.fill(0);
      certificate.fill(0);
      privateKey.fill(0);
    },
  });
}

export async function createJournalCheckpointMtlsTransport({ requestImpl } = {}) {
  let ca;
  let certificate;
  let privateKey;
  try {
    // Promise.all 일부 성공 뒤 다른 read가 실패하면 이미 읽힌 buffer를 되찾아 zeroize할
    // 수 없다. 세 실행 복제본은 순차로 읽어 catch가 항상 소유한 buffer를 지우게 한다.
    ca = await readTlsFile(JOURNAL_CHECKPOINT_AUTHORITY.tls.caPath);
    certificate = await readTlsFile(JOURNAL_CHECKPOINT_AUTHORITY.tls.certificatePath);
    privateKey = await readTlsFile(JOURNAL_CHECKPOINT_AUTHORITY.tls.privateKeyPath);
    const parsedCertificate = new X509Certificate(certificate);
    assertJournalCheckpointClientIdentity(parsedCertificate.subjectAltName);
    const parsedPrivateKey = createPrivateKey(privateKey);
    if (!parsedCertificate.checkPrivateKey(parsedPrivateKey)) {
      fail('state_checkpoint_mtls_identity_invalid', 'journal checkpoint client key does not match its certificate');
    }
    return createHttpsPost({ ca, certificate, privateKey, requestImpl });
  } catch (error) {
    ca?.fill(0);
    certificate?.fill(0);
    privateKey?.fill(0);
    if (error?.code?.startsWith?.('state_checkpoint_')) throw error;
    fail('state_checkpoint_mtls_unavailable', 'journal checkpoint mTLS material could not be loaded');
  }
}

/**
 * Backoffice durable authority를 기존 trusted checkpoint adapter에 연결한다. transport는
 * public checkpoint JSON만 주고받으며 bearer/header secret 인터페이스가 없다.
 */
export function createBackofficeJournalCheckpointClient({
  binding,
  transport,
  onHealthStateChange = async () => {},
}) {
  const normalizedBinding = normalizeJournalCheckpointBinding(binding);
  if (normalizedBinding.authoritySpiffeId !== JOURNAL_CHECKPOINT_AUTHORITY.serverSpiffeId) {
    fail('invalid_state_checkpoint', 'journal checkpoint authority identity is invalid');
  }
  if (
    !transport || typeof transport.post !== 'function' || typeof transport.close !== 'function' ||
    typeof onHealthStateChange !== 'function'
  ) {
    fail('state_checkpoint_control_plane_required', 'journal checkpoint authority transport is required');
  }
  const authorityResponseIdentity = normalizeAuthorityResponseIdentity(transport.authorityIdentity);
  let initialized = false;
  let current;
  let pendingAdvance;
  let healthState = CHECKPOINT_HEALTH.initializing;

  async function setHealthState(next) {
    if (healthState === next) return;
    healthState = next;
    try {
      await onHealthStateChange(Object.freeze({ state: next }));
    } catch {
      fail('state_checkpoint_health_update_failed', 'journal checkpoint health state could not be updated');
    }
  }

  function bindPendingAdvance(request, expectedDigest) {
    return Object.freeze({
      authorityIdentity: authorityResponseIdentity,
      journalId: normalizedBinding.journalId,
      idempotencyKey: request.idempotencyKey,
      expected: request.expected,
      expectedDigest,
      next: request.next,
    });
  }

  function exactPendingReadback(observed) {
    return pendingAdvance !== undefined &&
      sameAuthorityResponseIdentity(
        pendingAdvance.authorityIdentity,
        authorityResponseIdentity,
      ) &&
      pendingAdvance.journalId === normalizedBinding.journalId &&
      pendingAdvance.expected.journalId === pendingAdvance.journalId &&
      pendingAdvance.next.journalId === pendingAdvance.journalId &&
      pendingAdvance.expected.generation === pendingAdvance.expected.sequence &&
      SHA256.test(pendingAdvance.expectedDigest) &&
      SHA256.test(pendingAdvance.idempotencyKey) &&
      pendingAdvance.next.generation === pendingAdvance.expected.generation + 1 &&
      pendingAdvance.next.sequence === pendingAdvance.expected.sequence + 1 &&
      sameLocalCheckpoint(observed.local, pendingAdvance.next) &&
      observed.expectedDigest === pendingAdvance.next.headMac;
  }

  async function sealPendingAdvance() {
    current = undefined;
    await setHealthState(CHECKPOINT_HEALTH.sealed);
  }

  async function post(path, body) {
    let response;
    try {
      response = await transport.post(path, body);
    } catch {
      fail('state_checkpoint_transport_unavailable', 'journal checkpoint authority is unavailable');
    }
    if (!exactKeys(response, ['body', 'status']) || !Number.isSafeInteger(response.status)) {
      fail('invalid_state_checkpoint', 'journal checkpoint transport response is invalid');
    }
    return response;
  }

  async function readAuthority() {
    try {
      const response = await post(JOURNAL_CHECKPOINT_AUTHORITY.routes.read, {
        journalId: normalizedBinding.journalId,
      });
      if (response.status !== 200) {
        fail('state_checkpoint_readback_required', 'journal checkpoint authority readback failed');
      }
      const observed = normalizeReadResponse(response.body, normalizedBinding.journalId);
      if (!observed) {
        fail('state_checkpoint_readback_required', 'journal checkpoint authority state is absent');
      }
      if (pendingAdvance) {
        if (!exactPendingReadback(observed)) {
          await sealPendingAdvance();
          return observed;
        }
        // readiness 게시까지 성공해야 pending을 해제한다. health marker 갱신이 실패하면
        // 같은 process에서 mutation 권한을 다시 열지 않는다.
        await setHealthState(CHECKPOINT_HEALTH.healthy);
        pendingAdvance = undefined;
      }
      current = observed;
      await setHealthState(CHECKPOINT_HEALTH.healthy);
      return observed;
    } catch (error) {
      await setHealthState(CHECKPOINT_HEALTH.sealed);
      throw error;
    }
  }

  async function ensureGenesis() {
    if (initialized) return;
    let genesis;
    let response;
    try {
      response = await post(JOURNAL_CHECKPOINT_AUTHORITY.routes.genesis, {
        journalId: normalizedBinding.journalId,
      });
    } catch {
      // Genesis 결과가 불명이면 같은 mutation을 재전송하지 않는다. 아래 exact read가
      // 생성 여부를 판정하며, absent면 이번 process는 fail-closed한다.
    }
    if (response?.status === 200) {
      try {
        genesis = normalizeGenesisResponse(response.body, normalizedBinding.journalId);
      } catch {
        // DB commit 뒤 response schema만 유실·변조될 수도 있다. 같은 genesis를 다시 보내지
        // 않고 아래 exact readback만 authority로 삼는다.
      }
    } else if (response && response.status >= 400 && response.status < 500) {
      fail('state_checkpoint_authority_rejected', 'journal checkpoint genesis was rejected');
    }
    const observed = await readAuthority();
    if (genesis && observed.local.generation < genesis.local.generation) {
      fail('state_checkpoint_readback_required', 'journal checkpoint genesis readback regressed');
    }
    initialized = true;
  }

  const controlPlane = createTrustedJournalCheckpointControlPlane({
    binding: normalizedBinding,
    async readCurrent() {
      const initializing = !initialized;
      await ensureGenesis();
      return initializing ? current.local : (await readAuthority()).local;
    },
    async compareAndSwap(request) {
      // Unknown 결과가 exact readback으로 해소되기 전에는 같은 mutation은 물론 다른 CAS도
      // authority에 보내지 않는다. pending에는 public transition identity 전체가 고정된다.
      if (pendingAdvance) return { outcome: 'UNKNOWN' };
      try {
        await ensureGenesis();
        if (!current || !sameLocalCheckpoint(current.local, request.expected)) {
          const observed = await readAuthority();
          if (!sameLocalCheckpoint(observed.local, request.expected)) return { outcome: 'CONFLICT' };
        }
        const expectedDigest = current.expectedDigest;
        pendingAdvance = bindPendingAdvance(request, expectedDigest);
        const response = await post(JOURNAL_CHECKPOINT_AUTHORITY.routes.advance, {
          journalId: normalizedBinding.journalId,
          expectedGeneration: String(request.expected.generation),
          expectedDigest,
          nextDigest: request.next.headMac,
        });
        if (
          response.status === 409 &&
          authorityErrorCode(response.body) === 'AUTH_BROKER_JOURNAL_CHECKPOINT_CAS_MISMATCH'
        ) {
          pendingAdvance = undefined;
          current = undefined;
          return { outcome: 'CONFLICT' };
        }
        if (response.status !== 200) {
          await sealPendingAdvance();
          return { outcome: 'UNKNOWN' };
        }
        const advanced = normalizeAdvanceResponse(response.body, normalizedBinding.journalId);
        if (
          !sameLocalCheckpoint(advanced.local, request.next) ||
          advanced.expectedDigest !== request.next.headMac
        ) {
          await sealPendingAdvance();
          return { outcome: 'UNKNOWN' };
        }
        pendingAdvance = undefined;
        current = advanced;
        await setHealthState(CHECKPOINT_HEALTH.healthy);
        return { outcome: 'COMMITTED' };
      } catch {
        // advance가 server에 반영된 뒤 응답만 유실될 수 있다. mutation은 절대 재전송하지
        // 않고 DurableAuthState의 mandatory readCurrent가 결과를 판정하도록 UNKNOWN만 준다.
        await sealPendingAdvance();
        return { outcome: 'UNKNOWN' };
      }
    },
  });

  return Object.freeze({
    controlPlane,
    isHealthy() {
      return healthState === CHECKPOINT_HEALTH.healthy && pendingAdvance === undefined;
    },
    close() {
      initialized = false;
      current = undefined;
      pendingAdvance = undefined;
      healthState = CHECKPOINT_HEALTH.sealed;
      transport.close();
    },
  });
}

export async function createProductionJournalCheckpointClient(binding, { onHealthStateChange } = {}) {
  if (typeof onHealthStateChange !== 'function') {
    fail('state_checkpoint_health_update_required', 'journal checkpoint health callback is required');
  }
  const transport = await createJournalCheckpointMtlsTransport();
  try {
    return createBackofficeJournalCheckpointClient({ binding, transport, onHealthStateChange });
  } catch (error) {
    transport.close();
    throw error;
  }
}
