import { closeSync, readFileSync, writeFileSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';

import {
  GoogleSecretManagerExecutionStore,
  GoogleWorkloadIdentityTokenProvider,
  createMtlsEgressProxy,
} from '../src/index.mjs';

const CONFIG_PATH = '/etc/seori-auth/secret-access.json';
const RESOURCE = /^projects\/[A-Za-z0-9._:-]+\/secrets\/[A-Za-z0-9_-]+\/versions\/[1-9][0-9]*$/;

function fail() {
  throw new Error('secret access child failed');
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

async function readConfig() {
  const [entry, canonical] = await Promise.all([lstat(CONFIG_PATH), realpath(CONFIG_PATH)]);
  if (!entry.isFile() || entry.isSymbolicLink() || canonical !== CONFIG_PATH) fail();
  const bytes = await readFile(CONFIG_PATH);
  try {
    if (bytes.length === 0 || bytes.length > 256 * 1024) fail();
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    bytes.fill(0);
  }
}

function parseResource() {
  if (
    process.argv.length !== 4 || process.argv[2] !== `--config=${CONFIG_PATH}` ||
    !process.argv[3].startsWith('--resource=')
  ) fail();
  const resourceName = process.argv[3].slice('--resource='.length);
  if (!RESOURCE.test(resourceName)) fail();
  return resourceName;
}

function oneTimeSubjectTokenReader() {
  if (process.env.SEORI_AUTH_SUBJECT_TOKEN_FD !== '4') fail();
  let used = false;
  return async () => {
    if (used) fail();
    used = true;
    let bytes;
    let descriptorOpen = true;
    try {
      bytes = readFileSync(4);
      closeSync(4);
      descriptorOpen = false;
      delete process.env.SEORI_AUTH_SUBJECT_TOKEN_FD;
      const token = bytes.toString('utf8').trim();
      if (token.length < 32 || token.length > 32 * 1024 || /\s/.test(token)) fail();
      return token;
    } finally {
      if (descriptorOpen) {
        try { closeSync(4); } catch {}
      }
      delete process.env.SEORI_AUTH_SUBJECT_TOKEN_FD;
      if (Buffer.isBuffer(bytes)) bytes.fill(0);
    }
  };
}

let proxy;
let secret;
try {
  const resourceName = parseResource();
  const config = await readConfig();
  if (
    !exactKeys(config, ['allowedResources', 'egressProxy', 'schemaVersion', 'workloadIdentity']) ||
    config.schemaVersion !== 1 ||
    !exactKeys(config.workloadIdentity, ['audience', 'impersonationUrl']) ||
    !exactKeys(config.egressProxy, ['caPath', 'certificatePath', 'privateKeyPath', 'serverName', 'uri']) ||
    !Array.isArray(config.allowedResources) ||
    !config.allowedResources.includes(resourceName) || new Set(config.allowedResources).size !== config.allowedResources.length ||
    config.allowedResources.some((resource) => !RESOURCE.test(resource))
  ) fail();
  proxy = await createMtlsEgressProxy(config.egressProxy);
  const tokenProvider = new GoogleWorkloadIdentityTokenProvider({
    readSubjectToken: oneTimeSubjectTokenReader(),
    audience: config.workloadIdentity.audience,
    impersonationUrl: config.workloadIdentity.impersonationUrl,
    fetchImpl: (url, options) => proxy.fetch(url, options),
  });
  const store = new GoogleSecretManagerExecutionStore({
    bindings: [{
      credentialRef: 'shared/runtime/secret-access',
      credentialGeneration: 1,
      resourceName,
    }],
    tokenProvider,
    fetchImpl: (url, options) => proxy.fetch(url, options),
  });
  secret = await store.accessVersion({ resourceName });
  writeFileSync(3, secret);
} catch {
  process.exitCode = 1;
} finally {
  if (Buffer.isBuffer(secret)) secret.fill(0);
  if (proxy) await proxy.close().catch(() => {});
}
