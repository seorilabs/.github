#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  StateEnvelopeError,
  validateStateVolumeReadbackAttestation,
  verifyExactStateVolumeReadback,
} from '../src/state-envelope.mjs';

const EXPECTED_PATH = '/etc/seori-auth-state-attestor/expected.json';
const TOKEN_PATH = '/var/run/seori-auth-state-token/token';
const CA_PATH = '/var/run/seori-auth-state-token/ca.crt';
const MARKER_PATH = '/run/seori-auth-state-attestor/verified.json';
const MAX_PUBLIC_BYTES = 2 * 1024 * 1024;
const MAX_CREDENTIAL_BYTES = 128 * 1024;
const TIMEOUT_MS = 15_000;

class StateAttestorFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function stop(code) {
  throw new StateAttestorFailure(code);
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).toSorted().join('\0') === [...expected].toSorted().join('\0');
}

async function secureBytes(path, { maxBytes, writableByOwner = false }) {
  try {
    const [entry, canonical] = await Promise.all([lstat(path), realpath(path)]);
    if (
      !entry.isFile() || entry.isSymbolicLink() || canonical !== path ||
      (entry.mode & (writableByOwner ? 0o022 : 0o222)) !== 0
    ) stop('STATE_ATTESTOR_FILE_INVALID');
    const bytes = await readFile(path);
    if (bytes.length === 0 || bytes.length > maxBytes) {
      bytes.fill(0);
      stop('STATE_ATTESTOR_FILE_INVALID');
    }
    return bytes;
  } catch (error) {
    if (error instanceof StateAttestorFailure) throw error;
    stop('STATE_ATTESTOR_FILE_INVALID');
  }
}

export function validateStateAttestorExpected(expected) {
  if (
    !exactKeys(expected, ['attestation', 'kubernetesApi', 'schemaVersion', 'state']) ||
    expected.schemaVersion !== 1 ||
    !exactKeys(expected.kubernetesApi, [
      'audience', 'caConfigMapName', 'egressCidr', 'port', 'server',
      'tokenExpirationSeconds',
    ]) ||
    expected.kubernetesApi.server !== 'https://kubernetes.default.svc' ||
    expected.kubernetesApi.egressCidr !== '10.152.183.1/32' ||
    expected.kubernetesApi.port !== 443 ||
    expected.kubernetesApi.audience !== 'https://kubernetes.default.svc' ||
    expected.kubernetesApi.caConfigMapName !== 'kube-root-ca.crt' ||
    expected.kubernetesApi.tokenExpirationSeconds !== 600
  ) stop('STATE_ATTESTOR_EXPECTED_INVALID');
  try {
    validateStateVolumeReadbackAttestation({
      state: expected.state,
      attestation: expected.attestation,
    });
  } catch (error) {
    if (error instanceof StateEnvelopeError) stop('STATE_ATTESTOR_EXPECTED_INVALID');
    throw error;
  }
  return expected;
}

async function publicExpected() {
  const bytes = await secureBytes(EXPECTED_PATH, { maxBytes: 512 * 1024 });
  try {
    return validateStateAttestorExpected(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (error instanceof StateAttestorFailure) throw error;
    stop('STATE_ATTESTOR_EXPECTED_INVALID');
  } finally {
    bytes.fill(0);
  }
}

function readApiResource({ apiServer, ca, token, path }) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, apiServer);
    const child = request(url, {
      ca,
      headers: { authorization: `Bearer ${token.toString('utf8').trim()}` },
      method: 'GET',
      rejectUnauthorized: true,
      servername: url.hostname,
      timeout: TIMEOUT_MS,
    });
    const chunks = [];
    let bytes = 0;
    child.on('response', (response) => {
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_PUBLIC_BYTES) response.destroy();
        else chunks.push(chunk);
      });
      response.once('end', () => {
        if (bytes > MAX_PUBLIC_BYTES) {
          reject(new StateAttestorFailure('STATE_VOLUME_LIVE_READBACK_FAILED'));
          return;
        }
        if (response.statusCode === 404) {
          resolve(undefined);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new StateAttestorFailure('STATE_VOLUME_LIVE_READBACK_FAILED'));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new StateAttestorFailure('STATE_VOLUME_LIVE_READBACK_INVALID'));
        }
      });
      response.once('error', () => reject(
        new StateAttestorFailure('STATE_VOLUME_LIVE_READBACK_FAILED'),
      ));
    });
    child.once('timeout', () => child.destroy());
    child.once('error', () => reject(
      new StateAttestorFailure('STATE_VOLUME_LIVE_READBACK_FAILED'),
    ));
    child.end();
  });
}

async function writeMarker(observedDigest) {
  if (!/^[a-f0-9]{64}$/.test(observedDigest ?? '')) stop('STATE_VOLUME_ATTESTATION_INVALID');
  try {
    await writeFile(
      MARKER_PATH,
      `${JSON.stringify({
        schemaVersion: 1,
        state: 'STATE_VOLUME_ATTESTATION_VERIFIED',
        observedDigest,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
  } catch {
    stop('STATE_ATTESTOR_MARKER_WRITE_FAILED');
  }
}

export async function verifyStateVolumeWithReader({ expected, readResource }) {
  validateStateAttestorExpected(expected);
  if (typeof readResource !== 'function') stop('STATE_ATTESTOR_READER_INVALID');
  const { volume } = expected.state;
  const [observedPv, observedPvc] = await Promise.all([
    readResource(`/api/v1/persistentvolumes/${encodeURIComponent(volume.volumeName)}`),
    readResource(
      `/api/v1/namespaces/${encodeURIComponent(volume.namespace)}` +
      `/persistentvolumeclaims/${encodeURIComponent(volume.claimName)}`,
    ),
  ]);
  return verifyExactStateVolumeReadback({
    state: expected.state,
    attestation: expected.attestation,
    observedPv,
    observedPvc,
  });
}

async function main() {
  let token;
  let ca;
  try {
    if (process.argv.length !== 2) stop('STATE_ATTESTOR_ARGUMENTS_INVALID');
    const expected = await publicExpected();
    [token, ca] = await Promise.all([
      secureBytes(TOKEN_PATH, { maxBytes: MAX_CREDENTIAL_BYTES, writableByOwner: true }),
      secureBytes(CA_PATH, { maxBytes: MAX_CREDENTIAL_BYTES }),
    ]);
    const verified = await verifyStateVolumeWithReader({
      expected,
      readResource: (path) => readApiResource({
        apiServer: expected.kubernetesApi.server,
        ca,
        token,
        path,
      }),
    });
    await writeMarker(verified.attestation.observedDigest);
    process.stdout.write(`${JSON.stringify({
      state: 'STATE_VOLUME_ATTESTATION_VERIFIED',
      observedDigest: verified.attestation.observedDigest,
    })}\n`);
  } catch (error) {
    const code = error instanceof StateAttestorFailure || error instanceof StateEnvelopeError
      ? error.code
      : 'STATE_ATTESTOR_FAILED';
    process.stderr.write(`${JSON.stringify({ state: 'FAILED', code })}\n`);
    process.exitCode = 1;
  } finally {
    token?.fill(0);
    ca?.fill(0);
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectExecution()) await main();
