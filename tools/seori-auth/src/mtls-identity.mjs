import { createHash, createPublicKey, verify } from 'node:crypto';

import { normalizeExecutionBinding } from './durable-state.mjs';
import { fail } from './errors.mjs';

const SPIFFE_ID = /^spiffe:\/\/seorilabs\.local\/ns\/[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?\/sa\/[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_ATTESTATION_BYTES = 8 * 1024;
const DOMAIN = 'seori-run-attestation-v1\n';

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function decodeBase64Url(segment, label, maxBytes) {
  if (typeof segment !== 'string' || segment.length === 0 || segment.includes('=')) {
    fail('principal_unauthenticated', `${label} is not canonical base64url`);
  }
  let decoded;
  try {
    decoded = Buffer.from(segment, 'base64url');
  } catch {
    fail('principal_unauthenticated', `${label} is not canonical base64url`);
  }
  if (decoded.length === 0 || decoded.length > maxBytes || decoded.toString('base64url') !== segment) {
    decoded.fill(0);
    fail('principal_unauthenticated', `${label} is not canonical base64url`);
  }
  return decoded;
}

function exactPeerSpiffeId(socket, allowedIds) {
  if (!socket?.encrypted || socket.authorized !== true || typeof socket.getPeerCertificate !== 'function') {
    fail('principal_unauthenticated', 'a verified mTLS client certificate is required');
  }
  const certificate = socket.getPeerCertificate(true);
  const subjectAltName = certificate?.subjectaltname;
  if (typeof subjectAltName !== 'string' || !subjectAltName.startsWith('URI:')) {
    fail('principal_unauthenticated', 'mTLS client certificate requires one URI SAN');
  }
  // Multiple SANs and escaped/comma-containing values are rejected. The configured
  // SPIFFE identity is therefore compared as one exact string, not suffix-matched.
  const spiffeId = subjectAltName.slice(4);
  if (!SPIFFE_ID.test(spiffeId) || subjectAltName !== `URI:${spiffeId}` || !allowedIds.has(spiffeId)) {
    fail('principal_unauthenticated', 'mTLS client SPIFFE identity is not allowed');
  }
  return spiffeId;
}

export class MtlsRunAttestor {
  #publicKey;
  #allowedClientSpiffeIds;
  #clock;
  #maxLifetimeMs;
  #clockSkewMs;
  #nonceStore;

  constructor({
    publicKey,
    allowedClientSpiffeIds,
    nonceStore,
    clock = () => Date.now(),
    maxLifetimeMs = 300_000,
    clockSkewMs = 5_000,
  }) {
    if (!Array.isArray(allowedClientSpiffeIds) || allowedClientSpiffeIds.length === 0) {
      throw new TypeError('allowedClientSpiffeIds must be a non-empty exact allowlist');
    }
    const normalizedIds = new Set(allowedClientSpiffeIds);
    if (normalizedIds.size !== allowedClientSpiffeIds.length || [...normalizedIds].some((id) => !SPIFFE_ID.test(id))) {
      throw new TypeError('allowedClientSpiffeIds contains an invalid or duplicate SPIFFE id');
    }
    if (typeof clock !== 'function' || !Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1_000 || maxLifetimeMs > 300_000) {
      throw new TypeError('mTLS attestation timing configuration is invalid');
    }
    if (!Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0 || clockSkewMs > 30_000) {
      throw new TypeError('mTLS attestation clock skew is invalid');
    }
    if (!nonceStore || typeof nonceStore.consumeRunAttestationNonce !== 'function') {
      throw new TypeError('mTLS attestation requires a durable nonce store');
    }
    try {
      this.#publicKey = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey);
    } catch {
      throw new TypeError('run attestation public key is invalid');
    }
    if (this.#publicKey.asymmetricKeyType !== 'ed25519') {
      throw new TypeError('run attestation public key must be Ed25519');
    }
    this.#allowedClientSpiffeIds = normalizedIds;
    this.#clock = clock;
    this.#maxLifetimeMs = maxLifetimeMs;
    this.#clockSkewMs = clockSkewMs;
    this.#nonceStore = nonceStore;
  }

  async authenticate(socket, { runAttestation } = {}) {
    const clientSpiffeId = exactPeerSpiffeId(socket, this.#allowedClientSpiffeIds);
    if (typeof runAttestation !== 'string' || Buffer.byteLength(runAttestation) > MAX_ATTESTATION_BYTES) {
      fail('principal_unauthenticated', 'scheduler run attestation is required');
    }
    const segments = runAttestation.split('.');
    if (segments.length !== 2) {
      fail('principal_unauthenticated', 'scheduler run attestation is malformed');
    }
    const payloadBytes = decodeBase64Url(segments[0], 'attestation payload', MAX_ATTESTATION_BYTES);
    const signature = decodeBase64Url(segments[1], 'attestation signature', 128);
    let payload;
    try {
      if (!verify(null, Buffer.from(`${DOMAIN}${segments[0]}`, 'utf8'), this.#publicKey, signature)) {
        fail('principal_unauthenticated', 'scheduler run attestation signature is invalid');
      }
      payload = JSON.parse(payloadBytes.toString('utf8'));
    } catch (error) {
      if (error?.code === 'principal_unauthenticated') throw error;
      fail('principal_unauthenticated', 'scheduler run attestation payload is invalid');
    } finally {
      payloadBytes.fill(0);
      signature.fill(0);
    }
    if (!exactKeys(payload, [
      'clientSpiffeId', 'expiresAt', 'issuedAt', 'nonce', 'repository', 'runId', 'subject', 'version', 'workerId',
    ]) || payload.version !== 1 || payload.clientSpiffeId !== clientSpiffeId || !NONCE.test(payload.nonce ?? '')) {
      fail('principal_unauthenticated', 'scheduler run attestation binding is invalid');
    }
    if (!Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)) {
      fail('principal_unauthenticated', 'scheduler run attestation time is invalid');
    }
    const now = this.#clock();
    if (
      !Number.isSafeInteger(now) || payload.issuedAt > now + this.#clockSkewMs ||
      payload.expiresAt <= now || payload.expiresAt <= payload.issuedAt ||
      payload.expiresAt - payload.issuedAt > this.#maxLifetimeMs
    ) {
      fail('principal_unauthenticated', 'scheduler run attestation is expired or out of range');
    }
    const principal = normalizeExecutionBinding({
      subject: payload.subject,
      runId: payload.runId,
      repository: payload.repository,
      workerId: payload.workerId,
    });
    const nonceDigest = createHash('sha256').update(payload.nonce, 'utf8').digest('hex');
    await this.#nonceStore.consumeRunAttestationNonce({
      nonceDigest,
      expiresAt: payload.expiresAt,
      executionBinding: principal,
    });
    return principal;
  }
}

export function requireExactMtlsPeer(socket, allowedClientSpiffeIds) {
  if (!Array.isArray(allowedClientSpiffeIds) || allowedClientSpiffeIds.length === 0) {
    throw new TypeError('allowedClientSpiffeIds must be a non-empty exact allowlist');
  }
  const allowed = new Set(allowedClientSpiffeIds);
  if (allowed.size !== allowedClientSpiffeIds.length || [...allowed].some((id) => !SPIFFE_ID.test(id))) {
    throw new TypeError('allowedClientSpiffeIds contains an invalid or duplicate SPIFFE id');
  }
  return exactPeerSpiffeId(socket, allowed);
}
