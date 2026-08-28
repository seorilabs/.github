#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DurableAuthState,
  EncryptedBrowserVault,
  FactorHttpApplication,
  LocalAuthDaemon,
  MtlsAuthDaemon,
  MtlsRunAttestor,
  NativeSecurityBoundary,
  NativeSecretManagerExecutionStore,
  SecretManagerPasswordLoader,
  SecretManagerTotpSigner,
  SeoriAuthBroker,
  TrustedAdapterRegistry,
  isLogicalCredentialRef,
} from '../src/index.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const ROLE = new Set(['broker', 'password-loader', 'totp-signer']);
const SPIFFE_ID = /^spiffe:\/\/seorilabs\.local\/ns\/[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?\/sa\/[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const SECRET_MANAGER_VERSION = /^projects\/[A-Za-z0-9._:-]+\/secrets\/[A-Za-z0-9_-]+\/versions\/[1-9][0-9]*$/;
const GOOGLE_IDENTITY = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/;
const WIF_AUDIENCE = /^\/\/iam\.googleapis\.com\/projects\/[1-9][0-9]*\/locations\/global\/workloadIdentityPools\/[A-Za-z0-9_-]+\/providers\/[A-Za-z0-9_-]+$/;
const SECRET_ACCESS_CONFIG = '/etc/seori-auth/secret-access.json';
const CANARY_COMMIT = '1'.repeat(40);
const CANARY_ARTIFACT = 'a'.repeat(64);

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function uniqueStrings(value, pattern, label) {
  if (
    !Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length ||
    value.some((item) => typeof item !== 'string' || !pattern.test(item))
  ) fail(`${label} is invalid`);
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail(`${label} must be absolute`);
}

function credentialKey({ credentialRef, credentialGeneration }) {
  return `${credentialRef}\0${credentialGeneration}`;
}

function validateCredentialBindings(bindings) {
  if (!Array.isArray(bindings) || bindings.length === 0) fail('credential bindings are required');
  const keys = new Set();
  const resources = new Set();
  for (const binding of bindings) {
    if (
      !exactKeys(binding, ['credentialGeneration', 'credentialRef', 'resourceName']) ||
      !isLogicalCredentialRef(binding.credentialRef) ||
      !Number.isSafeInteger(binding.credentialGeneration) || binding.credentialGeneration < 1 ||
      !SECRET_MANAGER_VERSION.test(binding.resourceName ?? '')
    ) fail('credential binding is invalid');
    const key = credentialKey(binding);
    if (keys.has(key) || resources.has(binding.resourceName)) fail('credential binding is duplicated');
    keys.add(key);
    resources.add(binding.resourceName);
  }
  return { keys, resources };
}

function validateAdapters(adapters) {
  if (!Array.isArray(adapters) || adapters.length === 0) fail('trusted adapters are required');
  const ids = new Set();
  for (const adapter of adapters) {
    if (!exactKeys(adapter, [
      'capabilities', 'executable', 'fixedArgs', 'id', 'maxOutputBytes', 'providers', 'timeoutMs',
    ])) fail('trusted adapter fields are invalid');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(adapter.id ?? '') || ids.has(adapter.id)) fail('trusted adapter id is invalid');
    ids.add(adapter.id);
    absolutePath(adapter.executable, 'trusted adapter executable');
    uniqueStrings(adapter.providers, /^[a-z0-9][a-z0-9-]*$/, 'trusted adapter providers');
    uniqueStrings(adapter.capabilities, /^[a-z0-9][a-z0-9.-]*$/, 'trusted adapter capabilities');
    if (
      !Array.isArray(adapter.fixedArgs) || adapter.fixedArgs.some((item) => typeof item !== 'string' || item.includes('\0')) ||
      !Number.isSafeInteger(adapter.timeoutMs) || adapter.timeoutMs < 1_000 || adapter.timeoutMs > 300_000 ||
      !Number.isSafeInteger(adapter.maxOutputBytes) || adapter.maxOutputBytes < 1_024 || adapter.maxOutputBytes > 1_048_576
    ) fail('trusted adapter execution boundary is invalid');
  }
}

function validateCommonRuntime(config) {
  if (config.schemaVersion !== 1 || !ROLE.has(config.role)) fail('runtime config role is invalid');
  if (config.nativeHelperPath !== '/opt/seori-auth/bin/seori-auth-native' || !SHA256.test(config.nativeHelperSha256 ?? '')) {
    fail('native helper binding is invalid');
  }
  const expectedReady = `/run/seori-auth/${config.role}.ready`;
  if (config.readinessFile !== expectedReady) fail('readiness file binding is invalid');
  if (
    !exactKeys(config.secretAccess, ['childSha256', 'configSha256', 'nodeSha256']) ||
    ![config.secretAccess.childSha256, config.secretAccess.configSha256, config.secretAccess.nodeSha256].every((value) => SHA256.test(value ?? ''))
  ) fail('Secret Manager child binding is invalid');
  if (
    !exactKeys(config.listen, ['host', 'port']) ||
    !['0.0.0.0', '::'].includes(config.listen.host) ||
    config.listen.port !== (config.role === 'broker' ? 8443 : 9443)
  ) fail('runtime listener binding is invalid');
  if (
    !exactKeys(config.tls, ['caPath', 'certificatePath', 'privateKeyPath']) ||
    config.tls.caPath !== '/etc/seori-auth/tls/ca.crt' ||
    config.tls.certificatePath !== '/etc/seori-auth/tls/tls.crt' ||
    config.tls.privateKeyPath !== '/etc/seori-auth/tls/tls.key'
  ) fail('runtime TLS binding is invalid');
  validateAdapters(config.adapters);
  return validateCredentialBindings(config.credentialBindings);
}

function validateFactorRuntime(config, credentials) {
  uniqueStrings(config.allowedBrokerSpiffeIds, SPIFFE_ID, 'allowed broker SPIFFE ids');
  const loadSecret = async () => fail('validation-only factor loader executed');
  if (config.role === 'password-loader') {
    new SecretManagerPasswordLoader({ bindings: config.factorBindings, loadSecret });
  } else {
    new SecretManagerTotpSigner({ bindings: config.factorBindings, loadSecret });
  }
  const factorKeys = new Set(config.factorBindings.map(credentialKey));
  if (
    factorKeys.size !== config.factorBindings.length || factorKeys.size !== credentials.keys.size ||
    [...factorKeys].some((key) => !credentials.keys.has(key))
  ) fail('factor and credential bindings must form one exact partition');
}

function validateBrokerRuntime(config, credentials) {
  if (!SHA256.test(config.expectedJournalHeadMac ?? '')) fail('expected journal head MAC is invalid');
  uniqueStrings(config.allowedClientSpiffeIds, SPIFFE_ID, 'allowed client SPIFFE ids');
  for (const [field, expected] of [
    ['stateDirectory', '/var/lib/seori-auth/state'],
    ['vaultDirectory', '/var/lib/seori-auth/browser-vault'],
    ['browserRuntimeDirectory', '/run/seori-auth/browser-runtime'],
    ['runAttestationPublicKeyPath', '/etc/seori-auth/run-attestation.pub'],
    ['policyPath', '/etc/seori-auth/policy.json'],
  ]) {
    if (config[field] !== expected) fail(`${field} binding is invalid`);
  }
  if (!exactKeys(config.bootstrapCredentials, ['browserVault', 'journalMac'])) fail('broker bootstrap bindings are invalid');
  const bootstrapKeys = new Set();
  for (const binding of Object.values(config.bootstrapCredentials)) {
    if (
      !exactKeys(binding, ['credentialGeneration', 'credentialRef']) ||
      !isLogicalCredentialRef(binding.credentialRef) ||
      !Number.isSafeInteger(binding.credentialGeneration) || binding.credentialGeneration < 1 ||
      !credentials.keys.has(credentialKey(binding))
    ) fail('broker bootstrap credential is not in the exact Secret Manager binding set');
    bootstrapKeys.add(credentialKey(binding));
  }
  if (bootstrapKeys.size !== 2) fail('broker bootstrap credentials must be distinct');
}

function validateRuntimeConfig(config) {
  const common = [
    'adapters', 'credentialBindings', 'listen', 'nativeHelperPath', 'nativeHelperSha256',
    'readinessFile', 'role', 'schemaVersion', 'secretAccess', 'tls',
  ];
  const roleFields = config?.role === 'broker'
    ? [
        'allowedClientSpiffeIds', 'bootstrapCredentials', 'browserRuntimeDirectory',
        'expectedJournalHeadMac', 'policyPath', 'runAttestationPublicKeyPath',
        'stateDirectory', 'vaultDirectory',
      ]
    : ['allowedBrokerSpiffeIds', 'factorBindings'];
  if (!exactKeys(config, [...common, ...roleFields])) fail('runtime config fields are invalid');
  const credentials = validateCommonRuntime(config);
  if (config.role === 'broker') validateBrokerRuntime(config, credentials);
  else validateFactorRuntime(config, credentials);
  return config;
}

function deploymentBinding(options) {
  const expected = ['config', 'expected-google-service-account', 'expected-secret-access-sha256', 'expected-wif-audience'];
  if (options.size !== expected.length || expected.some((key) => !options.has(key))) {
    fail('runtime deployment binding arguments are invalid');
  }
  const binding = {
    configPath: options.get('config'),
    googleServiceAccount: options.get('expected-google-service-account'),
    secretAccessSha256: options.get('expected-secret-access-sha256'),
    wifAudience: options.get('expected-wif-audience'),
  };
  if (
    !GOOGLE_IDENTITY.test(binding.googleServiceAccount ?? '') ||
    !SHA256.test(binding.secretAccessSha256 ?? '') ||
    !WIF_AUDIENCE.test(binding.wifAudience ?? '')
  ) fail('runtime deployment identity binding is invalid');
  return Object.freeze(binding);
}

async function validateMountedSecretAccess(config, binding) {
  if (config.secretAccess.configSha256 !== binding.secretAccessSha256) fail('Secret Manager config checksum binding is invalid');
  const [entry, canonical] = await Promise.all([lstat(SECRET_ACCESS_CONFIG), realpath(SECRET_ACCESS_CONFIG)]);
  if (
    !entry.isFile() || entry.isSymbolicLink() || canonical !== SECRET_ACCESS_CONFIG ||
    entry.uid !== 0 || (entry.mode & 0o022) !== 0
  ) fail('Secret Manager access config is not an immutable root-owned file');
  const bytes = await readFile(SECRET_ACCESS_CONFIG);
  try {
    if (bytes.length === 0 || bytes.length > 256 * 1024) fail('Secret Manager access config size is invalid');
    if (createHash('sha256').update(bytes).digest('hex') !== binding.secretAccessSha256) {
      fail('Secret Manager access config checksum does not match the rendered workload');
    }
    const mounted = JSON.parse(bytes.toString('utf8'));
    if (!exactKeys(mounted, ['allowedResources', 'egressProxy', 'schemaVersion', 'workloadIdentity']) || mounted.schemaVersion !== 1) {
      fail('Secret Manager access config fields are invalid');
    }
    if (!exactKeys(mounted.workloadIdentity, ['audience', 'impersonationUrl'])) fail('workload identity fields are invalid');
    const expectedImpersonation = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(binding.googleServiceAccount)}:generateAccessToken`;
    if (
      mounted.workloadIdentity.audience !== binding.wifAudience ||
      mounted.workloadIdentity.impersonationUrl !== expectedImpersonation
    ) fail('mounted workload identity does not match the rendered public identity');
    if (!exactKeys(mounted.egressProxy, ['caPath', 'certificatePath', 'privateKeyPath', 'serverName', 'uri'])) {
      fail('egress proxy fields are invalid');
    }
    if (
      mounted.egressProxy.caPath !== '/etc/seori-auth/egress/ca.crt' ||
      mounted.egressProxy.certificatePath !== '/etc/seori-auth/egress/tls.crt' ||
      mounted.egressProxy.privateKeyPath !== '/etc/seori-auth/egress/tls.key'
    ) fail('egress proxy TLS binding is invalid');
    const expectedResources = new Set(config.credentialBindings.map(({ resourceName }) => resourceName));
    if (
      !Array.isArray(mounted.allowedResources) || new Set(mounted.allowedResources).size !== mounted.allowedResources.length ||
      mounted.allowedResources.some((resource) => !SECRET_MANAGER_VERSION.test(resource)) ||
      mounted.allowedResources.length !== expectedResources.size ||
      mounted.allowedResources.some((resource) => !expectedResources.has(resource))
    ) fail('mounted Secret Manager resources do not match the runtime credential partition');
  } catch (error) {
    if (error instanceof SyntaxError) fail('Secret Manager access config JSON is invalid');
    throw error;
  } finally {
    bytes.fill(0);
  }
}

async function readConfig(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('config path must be absolute');
  const [stat, canonical] = await Promise.all([lstat(path), realpath(path)]);
  if (!stat.isFile() || stat.isSymbolicLink() || canonical !== path) fail('config file is invalid');
  const bytes = await readFile(path);
  if (bytes.length === 0 || bytes.length > 1024 * 1024) fail('config file size is invalid');
  try {
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    bytes.fill(0);
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = new Map();
  for (const argument of rest) {
    const match = argument.match(/^--([a-z0-9-]+)=(.+)$/);
    if (!match || options.has(match[1])) fail('runtime arguments are invalid');
    options.set(match[1], match[2]);
  }
  return { command, options };
}

function fixedAdapters(rawAdapters, launcher) {
  if (!Array.isArray(rawAdapters) || rawAdapters.length === 0) fail('runtime requires at least one trusted adapter');
  return rawAdapters.map((adapter) => {
    if (!exactKeys(adapter, [
      'capabilities', 'executable', 'fixedArgs', 'id', 'maxOutputBytes', 'providers', 'timeoutMs',
    ]) || !Array.isArray(adapter.fixedArgs) || adapter.fixedArgs.some((argument) => typeof argument !== 'string')) {
      fail('trusted adapter configuration is invalid');
    }
    return Object.freeze({
      id: adapter.id,
      executable: adapter.executable,
      providers: adapter.providers,
      capabilities: adapter.capabilities,
      credentialDelivery: 'fd3',
      timeoutMs: adapter.timeoutMs,
      maxOutputBytes: adapter.maxOutputBytes,
      launcher,
      buildArgs: () => [...adapter.fixedArgs],
    });
  });
}

async function workloadStore(config, nativeBoundary) {
  const accessor = await nativeBoundary.secretManagerAccessor(config.secretAccess);
  return new NativeSecretManagerExecutionStore({
    bindings: config.credentialBindings,
    accessor,
  });
}

async function readiness(path, role) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('readiness file path must be absolute');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await unlink(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await writeFile(path, `${JSON.stringify({ pid: process.pid, role })}\n`, { flag: 'wx', mode: 0o600 });
  await chmod(path, 0o600);
}

async function healthcheck(path) {
  const state = await readConfig(path);
  if (!exactKeys(state, ['pid', 'role']) || !Number.isSafeInteger(state.pid) || !ROLE.has(state.role)) fail('runtime is not ready');
  process.kill(state.pid, 0);
}

function tlsDaemon(application, config) {
  return new MtlsAuthDaemon({
    application,
    host: config.listen.host,
    port: config.listen.port,
    tls: config.tls,
  });
}

async function serveFactor(config, nativeBoundary) {
  const kind = config.role === 'password-loader' ? 'password' : 'totp';
  const store = await workloadStore(config, nativeBoundary);
  const factorBindings = config.factorBindings;
  const factor = kind === 'password'
    ? new SecretManagerPasswordLoader({
        bindings: factorBindings,
        loadSecret: (request) => store.loadSecret(request),
      })
    : new SecretManagerTotpSigner({
        bindings: factorBindings,
        loadSecret: (request) => store.loadSecret(request),
      });
  const registry = new TrustedAdapterRegistry(fixedAdapters(config.adapters, nativeBoundary.launcher()));
  const application = new FactorHttpApplication({
    kind,
    factor,
    registry,
    allowedBrokerSpiffeIds: config.allowedBrokerSpiffeIds,
  });
  const daemon = tlsDaemon(application, config);
  await daemon.start();
  return { daemon, close: async () => daemon.stop() };
}

async function serveBroker(config, nativeBoundary) {
  if (!SHA256.test(config.expectedJournalHeadMac ?? '')) fail('expected journal head MAC is invalid');
  const store = await workloadStore(config, nativeBoundary);
  let journalMacKey;
  let vaultKey;
  let state;
  let vault;
  let daemon;
  try {
    journalMacKey = await store.loadSecret(config.bootstrapCredentials.journalMac);
    vaultKey = await store.loadSecret(config.bootstrapCredentials.browserVault);
    if (
      !Buffer.isBuffer(journalMacKey) || journalMacKey.length !== 32 ||
      !Buffer.isBuffer(vaultKey) || vaultKey.length !== 32
    ) {
      fail('broker bootstrap keys must each be exactly 32 bytes');
    }
    state = await DurableAuthState.open({
      directory: config.stateDirectory,
      journalMacKey,
      requireIntegrity: true,
      expectedJournalHeadMac: config.expectedJournalHeadMac,
      writerLockProvider: nativeBoundary.lockProvider(),
    });
    vault = await EncryptedBrowserVault.open({
      vaultDirectory: config.vaultDirectory,
      runtimeDirectory: config.browserRuntimeDirectory,
      encryptionKey: vaultKey,
      lockProvider: nativeBoundary.lockProvider(),
    });
    const publicKey = await readFile(config.runAttestationPublicKeyPath);
    let attestor;
    try {
      attestor = new MtlsRunAttestor({
        publicKey,
        allowedClientSpiffeIds: config.allowedClientSpiffeIds,
      });
    } finally {
      publicKey.fill(0);
    }
    const policy = await readConfig(config.policyPath);
    const adapters = fixedAdapters(config.adapters, nativeBoundary.launcher());
    const application = new LocalAuthDaemon({
      socketPath: '/run/seori-auth/mtls-application-not-listening.sock',
      state,
      policy,
      adapters,
      loadSecret: (request) => store.loadSecret(request),
      getCredentialGeneration: ({ credentialRef }) => store.generation(credentialRef),
      readBrowserIdentity: async () => fail('browser adapter is not activated'),
      authenticatePrincipal: (socket, metadata) => attestor.authenticate(socket, metadata),
      browserVault: vault,
      browserAdapter: nativeBoundary.browserAdapter({
        execute: async () => fail('browser adapter is not activated'),
        terminate: async () => ({ terminated: true }),
      }),
      reconcileBrowserSession: async () => fail('browser adapter is not activated'),
    });
    daemon = tlsDaemon(application, config);
    await daemon.start();
    return {
      daemon,
      close: async () => {
        try {
          await daemon.stop();
        } finally {
          try {
            await vault.close();
          } finally {
            await state.close();
          }
        }
      },
    };
  } catch (error) {
    await daemon?.stop().catch(() => {});
    await vault?.close().catch(() => {});
    await state?.close().catch(() => {});
    throw error;
  } finally {
    if (Buffer.isBuffer(journalMacKey)) journalMacKey.fill(0);
    if (Buffer.isBuffer(vaultKey)) vaultKey.fill(0);
  }
}

async function serve(config, binding) {
  await validateMountedSecretAccess(config, binding);
  const nativeBoundary = await NativeSecurityBoundary.open({
    helperPath: config.nativeHelperPath,
    expectedSha256: config.nativeHelperSha256,
    resolvePrincipal: async () => fail('Unix principal resolution is disabled in Kubernetes mTLS mode'),
  });
  const runtime = config.role === 'broker'
    ? await serveBroker(config, nativeBoundary)
    : await serveFactor(config, nativeBoundary);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await unlink(config.readinessFile).catch(() => {});
    await runtime.close();
  };
  try {
    await readiness(config.readinessFile, config.role);
    process.stdout.write(`${JSON.stringify({ state: 'READY', role: config.role, transport: 'mtls' })}\n`);
    await new Promise((resolve) => {
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, resolve);
    });
  } finally {
    await stop();
  }
}

async function canary(nativeHelperPath) {
  if (typeof nativeHelperPath !== 'string' || !isAbsolute(nativeHelperPath)) fail('canary native helper path is invalid');
  const nativeBoundary = await NativeSecurityBoundary.open({
    helperPath: nativeHelperPath,
    resolvePrincipal: async () => ({ subject: 'canary', runId: 'canary', repository: 'seorilabs/.github', workerId: 'canary' }),
  });
  const sink = fileURLToPath(new URL('./canary-secret-sink.mjs', import.meta.url));
  const canarySecret = randomBytes(32);
  const request = {
    credentialRef: 'shared/canary/execution',
    credentialGeneration: 1,
    policyGeneration: 1,
    subject: 'k8s:canary:worker',
    runId: 'canary:1',
    repository: 'seorilabs/.github',
    commitSha: CANARY_COMMIT,
    provider: 'canary-provider',
    origin: 'https://canary.invalid',
    redirectOrigins: [],
    capability: 'canary.execute',
    resource: { kind: 'canary', id: 'fake-account', environment: 'private' },
    artifact: { sha256: CANARY_ARTIFACT, sizeBytes: 1 },
    adapterId: 'canary-sink',
    accountId: 'fake-account',
    authFactors: ['api_key'],
    approval: { id: 'canary-approval', mode: 'preapproved', expiresAt: '2099-01-01T00:00:00.000Z', maxUses: 1 },
  };
  const broker = new SeoriAuthBroker({
    policy: {
      schemaVersion: 1,
      generation: 1,
      accounts: [{ provider: 'canary-provider', accountId: 'fake-account', kind: 'dedicated_bot', credentialRefs: ['shared/canary/execution'] }],
      rules: [{
        id: 'canary', enabled: true, credentialRefs: ['shared/canary/execution'], subjects: [request.subject],
        repositories: [request.repository], runIds: [request.runId], commitShas: [request.commitSha],
        providers: [request.provider], origins: [request.origin], redirectOrigins: [], capabilities: [request.capability],
        resources: [request.resource], adapters: [request.adapterId], accountIds: [request.accountId],
        actionClass: 'internal_upload', authStrategies: [['api_key']], requiresArtifact: true,
        artifactSha256s: [request.artifact.sha256], allowTotp: false, approvals: [request.approval],
      }],
    },
    adapters: [{
      id: 'canary-sink', executable: process.execPath, providers: [request.provider], capabilities: [request.capability],
      credentialDelivery: 'fd3', launcher: nativeBoundary.launcher(), buildArgs: () => [sink], timeoutMs: 10_000,
    }],
    loadSecret: async () => canarySecret,
  });
  try {
    const lease = broker.issueLease(request, { idempotencyKey: 'canary-execution' });
    const result = await broker.execute({
      leaseId: lease.leaseId,
      context: request,
      currentCredentialGeneration: request.credentialGeneration,
    });
    if (result.exitCode !== 0 || result.signal !== null || !canarySecret.every((byte) => byte === 0)) {
      fail('runtime canary failed');
    }
  } finally {
    canarySecret.fill(0);
  }
  process.stdout.write(`${JSON.stringify({ state: 'CANARY_OK', secretExposed: false })}\n`);
}

try {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'serve') {
    const binding = deploymentBinding(options);
    const config = validateRuntimeConfig(await readConfig(binding.configPath));
    await serve(config, binding);
  } else if (command === 'validate-config') {
    const binding = deploymentBinding(options);
    const config = validateRuntimeConfig(await readConfig(binding.configPath));
    if (config.secretAccess.configSha256 !== binding.secretAccessSha256) fail('Secret Manager config checksum binding is invalid');
    process.stdout.write(`${JSON.stringify({ valid: true, schemaVersion: 1, role: config.role })}\n`);
  } else if (command === 'healthcheck' && options.size === 1 && options.has('readiness-file')) {
    await healthcheck(options.get('readiness-file'));
  } else if (command === 'canary' && options.size === 1 && options.has('native-helper')) {
    await canary(options.get('native-helper'));
  } else {
    fail('usage: entrypoint.mjs serve|validate-config with exact deployment binding, or healthcheck|canary with one required path option');
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ state: 'FAILED', code: error.code ?? 'runtime_error' })}\n`);
  process.exitCode = 1;
}
