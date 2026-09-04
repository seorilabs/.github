import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SECRET_RESOURCE = /^projects\/[A-Za-z0-9._:-]+\/secrets\/[A-Za-z0-9_-]+$/;
const VERSION_RESOURCE = /^projects\/[A-Za-z0-9._:-]+\/secrets\/[A-Za-z0-9_-]+\/versions\/[1-9][0-9]*$/;
const TOKEN = /^[A-Za-z0-9._~+/=-]{32,8192}$/;
const MAX_RESPONSE_BYTES = 16 * 1024;

function fail() {
  process.exitCode = 65;
}

function crc32c(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
    }
  }
  return String((crc ^ 0xffffffff) >>> 0);
}

function exposedOnPublicProcessSurface(material) {
  const surface = JSON.stringify({ argv: process.argv, env: process.env });
  return [
    material.toString('utf8'),
    material.toString('base64'),
    material.toString('hex'),
  ].some((candidate) => candidate.length > 0 && surface.includes(candidate));
}

function validateGcloudWrapper(path) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path ||
    stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0
  ) {
    throw new Error('invalid gcloud wrapper');
  }
}

async function mintAccessToken(wrapperPath) {
  validateGcloudWrapper(wrapperPath);
  const child = spawn(wrapperPath, ['--quiet', 'auth', 'print-access-token'], {
    env: {
      LANG: 'C.UTF-8',
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    },
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const completionPromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const chunks = [];
  let size = 0;
  for await (const chunk of child.stdout) {
    size += chunk.length;
    if (size > 8_193) {
      child.kill('SIGKILL');
      throw new Error('access token exceeded its bound');
    }
    chunks.push(Buffer.from(chunk));
    if (Buffer.isBuffer(chunk)) chunk.fill(0);
  }
  const completion = await completionPromise;
  const tokenBuffer = Buffer.concat(chunks);
  for (const chunk of chunks) chunk.fill(0);
  try {
    const token = tokenBuffer.toString('utf8').trim();
    if (completion.code !== 0 || completion.signal !== null || !TOKEN.test(token)) {
      throw new Error('access token response is invalid');
    }
    return token;
  } finally {
    tokenBuffer.fill(0);
  }
}

function runtimeConfiguration() {
  const directTestMode =
    process.argv[1] !== '-' && process.env.SEORI_AUTH_WRITER_TEST_MODE === '1';
  if (directTestMode) {
    const wrapperPath = process.env.SEORI_AUTH_WRITER_TEST_GCLOUD_WRAPPER;
    const endpoint = process.env.SEORI_AUTH_WRITER_TEST_ENDPOINT;
    if (!wrapperPath?.startsWith('/') || !endpoint?.startsWith('http://127.0.0.1:')) {
      throw new Error('invalid test configuration');
    }
    return { wrapperPath, endpoint };
  }
  return {
    wrapperPath: join(homedir(), '.config', 'seorilabs', 'scripts', 'gcloud-cli.sh'),
    endpoint: 'https://secretmanager.googleapis.com',
  };
}

async function readBoundedResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('response body is missing');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('response exceeded its bound');
      chunks.push(Buffer.from(value));
    }
    const combined = Buffer.concat(chunks);
    try {
      return JSON.parse(combined.toString('utf8'));
    } finally {
      combined.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    await reader.cancel().catch(() => {});
  }
}

const secretDescriptor = Number(process.env.SEORI_AUTH_SECRET_FD);
const resultDescriptor = Number(process.env.SEORI_AUTH_RESULT_FD);
const operationArgument = process.argv[2];
const resourceArgument = process.argv[3];
const versionArgument = process.argv[4];
const operation = operationArgument?.startsWith('--operation=')
  ? operationArgument.slice('--operation='.length)
  : undefined;
const resourceName = resourceArgument?.startsWith('--resource=')
  ? resourceArgument.slice('--resource='.length)
  : undefined;
const expectedVersion = versionArgument?.startsWith('--expected-version=')
  ? Number(versionArgument.slice('--expected-version='.length))
  : undefined;

let material;
let activeCopy;
let backupCopy;
let remoteMaterial;
let payloadData = '';
let remotePayloadData = '';
let accessToken = '';
try {
  if (
    process.argv.length !== 5 || !new Set(['write', 'verify']).has(operation) ||
    secretDescriptor !== 3 || resultDescriptor !== 5 ||
    !SECRET_RESOURCE.test(resourceName ?? '') ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion !== 1
  ) {
    fail();
  } else {
    const { wrapperPath, endpoint } = runtimeConfiguration();
    // The catalog-backed wrapper exits before fd3 is read and inherits only stdio 0-2.
    accessToken = await mintAccessToken(wrapperPath);
    material = readFileSync(secretDescriptor);
    if (material.length < 16 || material.length > 4_096) {
      fail();
    } else {
      const secretExposed = exposedOnPublicProcessSurface(material);
      const expectedCrc32c = crc32c(material);
      activeCopy = Buffer.from(material);
      backupCopy = Buffer.from(activeCopy);
      activeCopy.fill(0);
      backupCopy.copy(activeCopy);
      const backupRestoreVerified =
        timingSafeEqual(activeCopy, backupCopy) && crc32c(activeCopy) === expectedCrc32c;
      if (operation === 'write') payloadData = activeCopy.toString('base64');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      timer.unref();
      let response;
      try {
        const url = operation === 'write'
          ? `${endpoint}/v1/${resourceName}:addVersion`
          : `${endpoint}/v1/${resourceName}/versions/${expectedVersion}:access`;
        response = await fetch(url, {
          method: operation === 'write' ? 'POST' : 'GET',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          body: operation === 'write'
            ? JSON.stringify({ payload: { data: payloadData, dataCrc32c: expectedCrc32c } })
            : undefined,
          redirect: 'error',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
        accessToken = '';
      }
      if (!response.ok) throw new Error('Secret Manager rejected the write');
      const value = await readBoundedResponse(response);
      const expectedVersionResource = `${resourceName}/versions/${expectedVersion}`;
      if (value === null || typeof value !== 'object' || Array.isArray(value) ||
          value.name !== expectedVersionResource || !VERSION_RESOURCE.test(value.name)) {
        throw new Error('Secret Manager response identity is invalid');
      }
      if (operation === 'write') {
        if (JSON.stringify(value).includes(payloadData)) {
          throw new Error('Secret Manager write response is invalid');
        }
      } else {
        remotePayloadData = value.payload?.data;
        const remoteCrc32c = value.payload?.dataCrc32c;
        if (
          typeof remotePayloadData !== 'string' || remotePayloadData.length > 5_464 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(remotePayloadData) ||
          remoteCrc32c !== expectedCrc32c
        ) {
          throw new Error('Secret Manager access response is invalid');
        }
        remoteMaterial = Buffer.from(remotePayloadData, 'base64');
        if (
          remoteMaterial.length !== material.length ||
          remoteMaterial.toString('base64') !== remotePayloadData ||
          crc32c(remoteMaterial) !== expectedCrc32c ||
          !timingSafeEqual(remoteMaterial, material)
        ) {
          throw new Error('Secret Manager version does not match local material');
        }
        value.payload.data = '';
      }
      const result = {
        schemaVersion: 1,
        operation: `secret-version-${operation}`,
        resourceName,
        versionResourceName: value.name,
        dataCrc32c: expectedCrc32c,
        backupRestoreVerified,
        secretExposed,
      };
      writeFileSync(resultDescriptor, JSON.stringify(result));
      if (!backupRestoreVerified || secretExposed) fail();
    }
  }
} catch (error) {
  if (process.argv[1] !== '-' && process.env.SEORI_AUTH_WRITER_TEST_MODE === '1') {
    process.stderr.write(`${error instanceof Error ? error.message : 'writer failed'}\n`);
  }
  fail();
} finally {
  accessToken = '';
  payloadData = '';
  remotePayloadData = '';
  if (Buffer.isBuffer(material)) material.fill(0);
  if (Buffer.isBuffer(activeCopy)) activeCopy.fill(0);
  if (Buffer.isBuffer(backupCopy)) backupCopy.fill(0);
  if (Buffer.isBuffer(remoteMaterial)) remoteMaterial.fill(0);
}
