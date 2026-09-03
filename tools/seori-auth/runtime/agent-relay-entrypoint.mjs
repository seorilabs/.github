#!/usr/bin/env node

import { isAbsolute } from 'node:path';

import {
  AgentRelayDaemon,
  createAgentMtlsForwarder,
  NativeSecurityBoundary,
  readImmutableAgentRelayConfig,
} from '../src/index.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const WORKER_KIND = new Set(['CODEX', 'CLAUDE']);

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function fail(message) {
  throw new Error(message);
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    fail(`${label} must be an absolute path`);
  }
  return value;
}

function validateConfig(config) {
  if (!exactKeys(config, [
    'expectedPeer', 'nativeHelper', 'schemaVersion', 'socketPath', 'upstream', 'workerKind',
  ]) || config.schemaVersion !== 1 || !WORKER_KIND.has(config.workerKind)) {
    fail('agent relay config fields are invalid');
  }
  if (
    !exactKeys(config.expectedPeer, ['gid', 'uid']) ||
    !Number.isSafeInteger(config.expectedPeer.uid) || config.expectedPeer.uid < 1 ||
    !Number.isSafeInteger(config.expectedPeer.gid) || config.expectedPeer.gid < 1
  ) fail('agent relay peer binding is invalid');
  if (
    !exactKeys(config.nativeHelper, ['path', 'sha256']) ||
    !SHA256.test(config.nativeHelper.sha256 ?? '')
  ) fail('agent relay native helper binding is invalid');
  if (
    !exactKeys(config.upstream, ['origin', 'serverName', 'tls']) ||
    typeof config.upstream.origin !== 'string' || typeof config.upstream.serverName !== 'string' ||
    !exactKeys(config.upstream.tls, ['caPath', 'certificatePath', 'privateKeyPath'])
  ) fail('agent relay upstream binding is invalid');
  return Object.freeze({
    schemaVersion: 1,
    workerKind: config.workerKind,
    socketPath: absolutePath(config.socketPath, 'socketPath'),
    expectedPeer: Object.freeze({ ...config.expectedPeer }),
    nativeHelper: Object.freeze({
      path: absolutePath(config.nativeHelper.path, 'nativeHelper.path'),
      sha256: config.nativeHelper.sha256,
    }),
    upstream: Object.freeze({
      origin: config.upstream.origin,
      serverName: config.upstream.serverName,
      tls: Object.freeze({
        caPath: absolutePath(config.upstream.tls.caPath, 'upstream.tls.caPath'),
        certificatePath: absolutePath(config.upstream.tls.certificatePath, 'upstream.tls.certificatePath'),
        privateKeyPath: absolutePath(config.upstream.tls.privateKeyPath, 'upstream.tls.privateKeyPath'),
      }),
    }),
  });
}

async function readRootConfig(path) {
  if (process.getuid?.() !== 0) fail('agent relay entrypoint must run as root');
  absolutePath(path, 'config');
  return validateConfig(await readImmutableAgentRelayConfig(path));
}

function configArgument(argv) {
  if (argv.length !== 1 || !argv[0].startsWith('--config=')) {
    fail('usage: agent-relay-entrypoint.mjs --config=/absolute/path.json');
  }
  return argv[0].slice('--config='.length);
}

async function main() {
  const config = await readRootConfig(configArgument(process.argv.slice(2)));
  const nativeBoundary = await NativeSecurityBoundary.open({
    helperPath: config.nativeHelper.path,
    expectedSha256: config.nativeHelper.sha256,
    expectedUid: config.expectedPeer.uid,
    expectedGid: config.expectedPeer.gid,
    resolvePrincipal: async () => fail('agent relay does not resolve request body principals'),
  });
  const forwarder = await createAgentMtlsForwarder(config.upstream);
  const daemon = new AgentRelayDaemon({
    socketPath: config.socketPath,
    expectedPeerUid: config.expectedPeer.uid,
    expectedPeerGid: config.expectedPeer.gid,
    nativeBoundary,
    forwarder,
  });

  let stopping = false;
  async function stop(signal) {
    if (stopping) return;
    stopping = true;
    await daemon.stop();
    process.stdout.write(`${JSON.stringify({ state: 'STOPPED', signal, workerKind: config.workerKind })}\n`);
  }
  process.once('SIGTERM', () => stop('SIGTERM').then(() => process.exit(0), () => process.exit(1)));
  process.once('SIGINT', () => stop('SIGINT').then(() => process.exit(0), () => process.exit(1)));

  await daemon.start();
  process.stdout.write(`${JSON.stringify({ state: 'READY', transport: 'unix', workerKind: config.workerKind })}\n`);
}

main().catch(() => {
  process.stderr.write('seori-auth agent relay failed code=STARTUP_REJECTED\n');
  process.exitCode = 1;
});
