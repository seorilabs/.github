#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
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
} from '../src/index.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const ROLE = new Set(['broker', 'password-loader', 'totp-signer']);
const CANARY_COMMIT = '1'.repeat(40);
const CANARY_ARTIFACT = 'a'.repeat(64);

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
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
    const match = argument.match(/^--([a-z-]+)=(.+)$/);
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
        accessVersion: (request) => store.accessVersion(request),
      })
    : new SecretManagerTotpSigner({
        bindings: factorBindings,
        accessVersion: (request) => store.accessVersion(request),
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

async function serve(config) {
  if (!config || config.schemaVersion !== 1 || !ROLE.has(config.role)) fail('runtime config role is invalid');
  if (!SHA256.test(config.nativeHelperSha256 ?? '')) fail('native helper checksum is invalid');
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

const { command, options } = parseArgs(process.argv.slice(2));
try {
  if (command === 'serve' && options.size === 1 && options.has('config')) {
    await serve(await readConfig(options.get('config')));
  } else if (command === 'validate-config' && options.size === 1 && options.has('config')) {
    const config = await readConfig(options.get('config'));
    if (!config || config.schemaVersion !== 1 || !ROLE.has(config.role)) fail('runtime config role is invalid');
    process.stdout.write(`${JSON.stringify({ valid: true, schemaVersion: 1, role: config.role })}\n`);
  } else if (command === 'healthcheck' && options.size === 1 && options.has('readiness-file')) {
    await healthcheck(options.get('readiness-file'));
  } else if (command === 'canary' && options.size === 1 && options.has('native-helper')) {
    await canary(options.get('native-helper'));
  } else {
    fail('usage: entrypoint.mjs serve|validate-config|healthcheck|canary with one required path option');
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ state: 'FAILED', code: error.code ?? 'runtime_error' })}\n`);
  process.exitCode = 1;
}
