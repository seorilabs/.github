#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DurableAuthState,
  EncryptedBrowserVault,
  BrowserLoginBoundary,
  CanonicalAccountRegistry,
  FactorHttpApplication,
  HUMAN_REAUTH_REQUIRED,
  LocalAuthDaemon,
  MtlsAuthDaemon,
  MtlsRunAttestor,
  NativeSecurityBoundary,
  NativeSecretManagerExecutionStore,
  PROVIDER_CONTROL_PLANE_CLIENT_SPIFFE_ID,
  PROVIDER_CONTROL_PLANE_ENDPOINT_SCOPE,
  requireExactMtlsPeer,
  SecretManagerPasswordLoader,
  SecretManagerTotpSigner,
  SeoriAuthError,
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
const CANARY_SOURCE_SHA = '2'.repeat(40);

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
  if (
    !exactKeys(config.providerControlPlane, ['backofficeClientSpiffeId', 'endpointScope']) ||
    config.providerControlPlane.backofficeClientSpiffeId !== PROVIDER_CONTROL_PLANE_CLIENT_SPIFFE_ID ||
    config.providerControlPlane.endpointScope !== PROVIDER_CONTROL_PLANE_ENDPOINT_SCOPE ||
    !config.allowedClientSpiffeIds.includes(config.providerControlPlane.backofficeClientSpiffeId)
  ) fail('Backoffice provider control-plane binding is invalid');
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
        'stateDirectory', 'vaultDirectory', 'providerControlPlane',
      ]
    : ['allowedBrokerSpiffeIds', 'factorBindings'];
  if (!exactKeys(config, [...common, ...roleFields])) fail('runtime config fields are invalid');
  const credentials = validateCommonRuntime(config);
  if (config.role === 'broker') validateBrokerRuntime(config, credentials);
  else validateFactorRuntime(config, credentials);
  return config;
}

function deploymentBinding(options) {
  const expected = [
    'config', 'expected-backoffice-spiffe-id', 'expected-google-service-account',
    'expected-provider-endpoint-scope', 'expected-secret-access-sha256', 'expected-wif-audience',
  ];
  if (options.size !== expected.length || expected.some((key) => !options.has(key))) {
    fail('runtime deployment binding arguments are invalid');
  }
  const binding = {
    configPath: options.get('config'),
    googleServiceAccount: options.get('expected-google-service-account'),
    secretAccessSha256: options.get('expected-secret-access-sha256'),
    wifAudience: options.get('expected-wif-audience'),
    backofficeClientSpiffeId: options.get('expected-backoffice-spiffe-id'),
    providerEndpointScope: options.get('expected-provider-endpoint-scope'),
  };
  if (
    !GOOGLE_IDENTITY.test(binding.googleServiceAccount ?? '') ||
    !SHA256.test(binding.secretAccessSha256 ?? '') ||
    !WIF_AUDIENCE.test(binding.wifAudience ?? '') ||
    binding.backofficeClientSpiffeId !== PROVIDER_CONTROL_PLANE_CLIENT_SPIFFE_ID ||
    binding.providerEndpointScope !== PROVIDER_CONTROL_PLANE_ENDPOINT_SCOPE
  ) fail('runtime deployment identity binding is invalid');
  return Object.freeze(binding);
}

function validateRuntimeDeploymentBinding(config, binding) {
  if (
    config.role === 'broker' &&
    (
      config.providerControlPlane.backofficeClientSpiffeId !== binding.backofficeClientSpiffeId ||
      config.providerControlPlane.endpointScope !== binding.providerEndpointScope
    )
  ) fail('Backoffice provider control-plane deployment binding is invalid');
  if (config.secretAccess.configSha256 !== binding.secretAccessSha256) fail('Secret Manager config checksum binding is invalid');
}

async function validateMountedSecretAccess(config, binding) {
  validateRuntimeDeploymentBinding(config, binding);
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
        nonceStore: state,
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
      authorizeInternalPrincipal: (socket) => requireExactMtlsPeer(
        socket,
        [config.providerControlPlane.backofficeClientSpiffeId],
      ),
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
  await canaryBrowserBoundaries(nativeBoundary);
  process.stdout.write(`${JSON.stringify({ state: 'CANARY_OK', secretExposed: false })}\n`);
}

function base32NoPadding(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let accumulator = 0;
  let encoded = '';
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += alphabet[(accumulator >>> bits) & 31];
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0) encoded += alphabet[(accumulator << (5 - bits)) & 31];
  return encoded;
}

async function allFiles(directory) {
  const contents = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else contents.push(await readFile(child));
    }
  }
  await visit(directory);
  return Buffer.concat(contents);
}

function canaryIdentity() {
  return Object.freeze({
    provider: 'canary-provider',
    accountId: 'fake-browser-account',
    teamId: 'fake-team',
    workspaceId: 'fake-workspace',
    appId: 'fake-app',
  });
}

function canaryInspection(identity, overrides = {}) {
  return {
    origin: 'https://canary.invalid',
    redirectOrigins: ['https://login.canary.invalid'],
    publicIdentity: identity,
    authenticated: false,
    challenge: null,
    ...overrides,
  };
}

function canarySecurityControls() {
  return {
    allowedNetworkOrigins: ['https://canary.invalid', 'https://login.canary.invalid'],
    clipboard: false,
    downloads: false,
    extensions: false,
    har: false,
    profilePathExposed: false,
    screenshots: false,
    storageStateExport: false,
    traces: false,
    video: false,
  };
}

async function canaryBrowserVault(nativeBoundary, paths) {
  const sourceDirectory = join(paths.runtimeRoot, 'source');
  const runtimeDirectory = join(paths.runtimeRoot, 'browser-runtime');
  const vaultDirectory = join(paths.vaultRoot, 'browser-vault');
  const fakeProfile = randomBytes(24);
  const encryptionKey = randomBytes(32);
  const identity = canaryIdentity();
  const executionBinding = {
    subject: 'k8s:auth-broker:canary',
    runId: 'canary:browser-vault',
    repository: 'seorilabs/.github',
    workerId: 'canary',
  };
  let vault;
  let persisted;
  try {
    await mkdir(join(sourceDirectory, 'Default'), { recursive: true, mode: 0o700 });
    await writeFile(join(sourceDirectory, 'Default', 'Cookies'), fakeProfile, { mode: 0o600 });
    await mkdir(join(runtimeDirectory, `checkout-${'a'.repeat(64)}-crash`), { recursive: true, mode: 0o700 });
    vault = await EncryptedBrowserVault.open({
      vaultDirectory,
      runtimeDirectory,
      encryptionKey,
      lockProvider: nativeBoundary.lockProvider(),
    });
    if ((await readdir(runtimeDirectory)).some((entry) => entry.startsWith('checkout-'))) {
      fail('browser vault crash reconciliation failed');
    }
    await vault.registerProfile({ sourceDirectory, role: 'canary', publicIdentity: identity });
    const checkout = await vault.checkout({
      role: 'canary',
      expectedIdentity: identity,
      expectedGeneration: 1,
      executionBinding,
      sourceSha: CANARY_SOURCE_SHA,
    });
    if (JSON.stringify(checkout).includes(fakeProfile.toString('base64'))) fail('browser vault exposed profile bytes');
    await vault.withClone({
      capabilityId: checkout.capabilityId,
      executionBinding,
      sourceSha: CANARY_SOURCE_SHA,
    }, async (cloneDirectory) => {
      const observed = await readFile(join(cloneDirectory, 'Default', 'Cookies'));
      try {
        if (!observed.equals(fakeProfile)) fail('browser vault clone round-trip failed');
      } finally {
        observed.fill(0);
      }
    });
    const completed = await vault.complete({
      capabilityId: checkout.capabilityId,
      executionBinding,
      sourceSha: CANARY_SOURCE_SHA,
      observedIdentity: identity,
    });
    if (completed.state !== 'COMPLETED' || completed.generation !== 2) {
      fail('browser vault completion readback failed');
    }
    persisted = await allFiles(vaultDirectory);
    if (persisted.includes(fakeProfile) || persisted.includes(Buffer.from(fakeProfile.toString('base64')))) {
      fail('browser vault persisted plaintext profile bytes');
    }
  } finally {
    persisted?.fill(0);
    await vault?.close().catch(() => {});
    encryptionKey.fill(0);
    fakeProfile.fill(0);
  }
}

async function canaryBrowserLogin() {
  const identity = canaryIdentity();
  const passwordRef = 'shared/canary/browser-password';
  const totpRef = 'shared/canary/browser-totp';
  const now = 1_700_000_000_000;
  const rawSeed = randomBytes(20);
  const encodedSeed = Buffer.from(base32NoPadding(rawSeed), 'ascii');
  rawSeed.fill(0);
  let totpExecutionCopy;
  let passwordExecutionCopy;
  let passwordInjected = false;
  let totpInjected = false;
  try {
    const signer = new SecretManagerTotpSigner({
      bindings: [{
        credentialRef: totpRef,
        credentialGeneration: 1,
        provider: identity.provider,
        accountId: identity.accountId,
        factor: 'totp',
        algorithm: 'sha1',
        digits: 6,
        periodSeconds: 30,
        origins: ['https://canary.invalid'],
      }],
      loadSecret: async () => {
        totpExecutionCopy = Buffer.from(encodedSeed);
        return totpExecutionCopy;
      },
      clock: () => now,
    });
    const registry = new CanonicalAccountRegistry([{
      provider: identity.provider,
      accountId: identity.accountId,
      kind: 'dedicated_bot',
      credentialRefs: [passwordRef, totpRef],
    }]);
    const login = new BrowserLoginBoundary({
      accountRegistry: registry,
      passwordLoader: {
        async loadPassword() {
          passwordExecutionCopy = Buffer.from('fake-browser-password', 'utf8');
          return passwordExecutionCopy;
        },
      },
      totpSigner: signer,
      clock: () => now,
    });
    const stages = {
      before_password: canaryInspection(identity),
      after_password: canaryInspection(identity, { challenge: 'totp_required' }),
      after_totp: canaryInspection(identity, { authenticated: true }),
    };
    const result = await login.authenticate({
      browser: {
        async securityControls() { return canarySecurityControls(); },
        async inspect({ stage }) { return stages[stage]; },
        async injectPassword(value) { passwordInjected = Buffer.isBuffer(value) && value.length > 0; },
        async injectTotp(value) {
          totpInjected = Buffer.isBuffer(value) && value.length === 6 && value.every((byte) => byte >= 0x30 && byte <= 0x39);
        },
      },
      passwordRef,
      passwordGeneration: 1,
      totpRef,
      totpGeneration: 1,
      expectedOrigin: 'https://canary.invalid',
      expectedRedirectOrigins: ['https://login.canary.invalid'],
      expectedIdentity: identity,
      authFactors: ['password', 'totp'],
    });
    if (
      result.status !== 'AUTHENTICATED' || !passwordInjected || !totpInjected ||
      !passwordExecutionCopy.every((byte) => byte === 0) ||
      !totpExecutionCopy.every((byte) => byte === 0) ||
      JSON.stringify(result).includes('fake-browser-password')
    ) fail('browser factor non-return canary failed');

    let humanFactorLoads = 0;
    let humanInjections = 0;
    const humanLogin = new BrowserLoginBoundary({
      accountRegistry: new CanonicalAccountRegistry([{
        provider: identity.provider,
        accountId: identity.accountId,
        kind: 'human',
        credentialRefs: [passwordRef, totpRef],
      }]),
      passwordLoader: { async loadPassword() { humanFactorLoads += 1; return Buffer.from('unused'); } },
      totpSigner: { async signCode() { humanFactorLoads += 1; return { code: Buffer.from('000000'), expiresAt: now + 1_000 }; } },
      clock: () => now,
    });
    let stopped = false;
    try {
      await humanLogin.authenticate({
        browser: {
          async securityControls() { throw new Error('human controls must not be inspected'); },
          async inspect() { throw new Error('human browser must not be inspected'); },
          async injectPassword() { humanInjections += 1; },
          async injectTotp() { humanInjections += 1; },
        },
        passwordRef,
        passwordGeneration: 1,
        totpRef,
        totpGeneration: 1,
        expectedOrigin: 'https://canary.invalid',
        expectedRedirectOrigins: ['https://login.canary.invalid'],
        expectedIdentity: identity,
        authFactors: ['password', 'totp'],
      });
    } catch (error) {
      stopped = error instanceof SeoriAuthError && error.code === HUMAN_REAUTH_REQUIRED;
    }
    if (!stopped || humanFactorLoads !== 0 || humanInjections !== 0) {
      fail('human reauthentication stop gate canary failed');
    }
  } finally {
    encodedSeed.fill(0);
    passwordExecutionCopy?.fill(0);
    totpExecutionCopy?.fill(0);
  }
}

async function canaryBrowserBoundaries(nativeBoundary) {
  const suffix = randomBytes(8).toString('hex');
  let useProductionRoots = false;
  if (process.platform === 'linux') {
    try {
      const [runtime, vault] = await Promise.all([
        lstat('/run/seori-auth'),
        lstat('/var/lib/seori-auth'),
      ]);
      useProductionRoots = [runtime, vault].every((entry) =>
        entry.isDirectory() && !entry.isSymbolicLink() && entry.uid === process.getuid?.() && (entry.mode & 0o077) === 0,
      );
    } catch {
      useProductionRoots = false;
    }
  }
  const localRoot = useProductionRoots
    ? undefined
    : await mkdtemp(join(tmpdir(), 'seori-auth-runtime-canary-'));
  const paths = useProductionRoots
    ? {
        runtimeRoot: join('/run/seori-auth', `canary-${suffix}`),
        vaultRoot: join('/var/lib/seori-auth', `canary-${suffix}`),
      }
    : {
        runtimeRoot: join(localRoot, 'runtime'),
        vaultRoot: join(localRoot, 'vault'),
      };
  try {
    await mkdir(paths.runtimeRoot, { recursive: true, mode: 0o700 });
    await mkdir(paths.vaultRoot, { recursive: true, mode: 0o700 });
    await canaryBrowserVault(nativeBoundary, paths);
    await canaryBrowserLogin();
  } finally {
    await rm(paths.runtimeRoot, { recursive: true, force: true }).catch(() => {});
    await rm(paths.vaultRoot, { recursive: true, force: true }).catch(() => {});
    if (localRoot) await rm(localRoot, { recursive: true, force: true }).catch(() => {});
  }
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
    validateRuntimeDeploymentBinding(config, binding);
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
