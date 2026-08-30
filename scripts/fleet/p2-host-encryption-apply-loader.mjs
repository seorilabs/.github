#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import {
  canonicalDigest,
  confirmations,
  contractDigest,
} from '../../tools/seori-auth/src/host-encryption-provisioning.mjs';
import { activateP2ProcessHardening } from './p2-process-hardening-boundary.mjs';

const executable = realpathSync(fileURLToPath(import.meta.url));
const sourceRoot = dirname(dirname(dirname(executable)));
const sourceMatch = /^\/opt\/seorilabs\/fleet-p2\/([a-f0-9]{40})$/u.exec(sourceRoot);
const runtimeRoot = '/run/seorilabs-p2-host-encryption-apply';
const recoveryPath = `${runtimeRoot}/recovery-key.pending`;
const maximumRecoveryKeyBytes = 4096;

class LoaderError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function stop(code) {
  throw new LoaderError(code);
}

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).toSorted().join('\0') === [...expected].toSorted().join('\0');
}

function assertRootOwnedPath(path, leafType) {
  if (realpathSync(path) !== path) stop('P2_HOST_RECOVERY_LOADER_SOURCE_INVALID');
  const parts = path.split('/').filter(Boolean);
  let current = '';
  for (const [index, part] of parts.entries()) {
    current += `/${part}`;
    const entry = lstatSync(current);
    const leaf = index === parts.length - 1;
    if (
      entry.isSymbolicLink() || entry.uid !== 0 || (entry.mode & 0o022) !== 0 ||
      (leaf && leafType === 'file' && !entry.isFile()) ||
      (leaf && leafType === 'directory' && !entry.isDirectory()) ||
      (!leaf && !entry.isDirectory())
    ) stop('P2_HOST_RECOVERY_LOADER_SOURCE_INVALID');
  }
}

function loadContracts() {
  if (sourceMatch === null || process.argv.length !== 2 || process.geteuid?.() !== 0) {
    stop('P2_HOST_RECOVERY_LOADER_SOURCE_INVALID');
  }
  assertRootOwnedPath(executable, 'file');
  const receiptPath = join(sourceRoot, 'stage1-source.json');
  assertRootOwnedPath(receiptPath, 'file');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (
    receipt.schemaVersion !== 1 || receipt.state !== 'P2_STAGE1_SOURCE_READY' ||
    receipt.sourceSha !== sourceMatch[1]
  ) stop('P2_HOST_RECOVERY_LOADER_SOURCE_INVALID');
  const stage1 = parse(readFileSync(join(sourceRoot, 'contracts/fleet-p2-stage1.yaml'), 'utf8'));
  const host = parse(readFileSync(join(sourceRoot, 'contracts/fleet-p2-host-encryption.yaml'), 'utf8'));
  activateP2ProcessHardening(stage1.hostProcessBoundary);
  return { host };
}

function readRecoveryKey() {
  const input = fstatSync(0);
  if (input.isFile() || input.isDirectory() || input.isCharacterDevice()) {
    stop('P2_HOST_RECOVERY_LOADER_INPUT_INVALID');
  }
  const bytes = Buffer.alloc(maximumRecoveryKeyBytes + 1);
  let offset = 0;
  for (;;) {
    const count = readSync(0, bytes, offset, bytes.length - offset);
    if (count < 0) stop('P2_HOST_RECOVERY_LOADER_INPUT_INVALID');
    if (count === 0) break;
    offset += count;
    if (offset > maximumRecoveryKeyBytes || offset === bytes.length) {
      stop('P2_HOST_RECOVERY_LOADER_INPUT_INVALID');
    }
  }
  if (offset < 32) stop('P2_HOST_RECOVERY_LOADER_INPUT_INVALID');
  return bytes.subarray(0, offset);
}

function ensureRuntimeRoot() {
  try {
    mkdirSync(runtimeRoot, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') stop('P2_HOST_RECOVERY_LOADER_RUNTIME_INVALID');
  }
  const entry = lstatSync(runtimeRoot);
  if (
    !entry.isDirectory() || entry.isSymbolicLink() || realpathSync(runtimeRoot) !== runtimeRoot ||
    entry.uid !== 0 || entry.gid !== 0 || (entry.mode & 0o777) !== 0o700
  ) stop('P2_HOST_RECOVERY_LOADER_RUNTIME_INVALID');
}

function syncRuntimeRoot() {
  const descriptor = openSync(
    runtimeRoot,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeRecoveryKey(bytes) {
  let descriptor;
  try {
    descriptor = openSync(
      recoveryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    const entry = fstatSync(descriptor);
    if (
      !entry.isFile() || entry.uid !== 0 || entry.gid !== 0 ||
      (entry.mode & 0o777) !== 0o600 || entry.nlink !== 1 || entry.size !== bytes.length
    ) stop('P2_HOST_RECOVERY_LOADER_RUNTIME_INVALID');
  } catch (error) {
    if (error instanceof LoaderError) throw error;
    if (error?.code === 'EEXIST') stop('P2_HOST_RECOVERY_LOADER_STALE_KEY');
    stop('P2_HOST_RECOVERY_LOADER_RUNTIME_INVALID');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  syncRuntimeRoot();
}

function validateProvisioned(value, host) {
  const expected = [
    'bootId', 'configurationSha256', 'contractDigest', 'headerBackupSha256',
    'headerBackupIdentity', 'hostEncryption', 'luksUuid', 'mapperBacking', 'nodeName',
    'observedDigest', 'preBackupDigest', 'schemaVersion', 'sourceIdentity', 'state',
    'tangAttestationDigests',
  ];
  const core = { ...value };
  delete core.observedDigest;
  if (
    !exactKeys(value, expected) || value.schemaVersion !== 1 ||
    value.state !== 'HOST_PROVISIONED_REBOOT_READBACK_REQUIRED' ||
    value.nodeName !== host.target.nodeName || value.contractDigest !== contractDigest(host) ||
    !/^[a-f0-9]{64}$/u.test(value.observedDigest ?? '') ||
    canonicalDigest(core) !== value.observedDigest
  ) stop('P2_HOST_RECOVERY_LOADER_RESULT_INVALID');
  return {
    schemaVersion: 1,
    state: value.state,
    nodeName: value.nodeName,
    contractDigest: value.contractDigest,
    provisionedDigest: value.observedDigest,
    secretExposed: false,
  };
}

function runApply(host) {
  const script = join(sourceRoot, 'scripts/fleet/provision-p2-host-encryption.mjs');
  const result = spawnSync('/usr/local/libexec/seori-auth-native', [
    'launch', '--', '/usr/local/bin/node', script, 'apply',
    `--confirmation=${confirmations(host).apply}`,
    '--kubeconfig=/var/snap/microk8s/current/credentials/kubelet.config',
    `--recovery-key-file=${recoveryPath}`,
    '--tang-attestation=/var/lib/seorilabs/tang-backup-attestations/rpi4001.json',
    '--tang-attestation=/var/lib/seorilabs/tang-backup-attestations/seori-m6-01.json',
  ], {
    env: { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
  });
  if (result.status !== 0 || result.error !== undefined) {
    let code = 'P2_HOST_RECOVERY_LOADER_APPLY_OUTCOME_UNKNOWN';
    try {
      const failure = JSON.parse(result.stderr);
      if (exactKeys(failure, ['ok', 'code']) && failure.ok === false &&
          /^(?:P2_|KUBECONFIG_|KUBECTL_|STATE_)[A-Z0-9_]+$/u.test(failure.code ?? '')) {
        code = failure.code;
      }
    } catch {
      // Only the stable public code is returned; arbitrary child output is discarded.
    }
    stop(code);
  }
  try {
    return validateProvisioned(JSON.parse(result.stdout), host);
  } catch (error) {
    if (error instanceof LoaderError) throw error;
    stop('P2_HOST_RECOVERY_LOADER_RESULT_INVALID');
  }
}

let recoveryKey;
let created = false;
let outcome;
let failureCode;
try {
  const { host } = loadContracts();
  ensureRuntimeRoot();
  recoveryKey = readRecoveryKey();
  writeRecoveryKey(recoveryKey);
  created = true;
  outcome = runApply(host);
} catch (error) {
  failureCode = error instanceof LoaderError ? error.code : 'P2_HOST_RECOVERY_LOADER_FAILED';
} finally {
  recoveryKey?.fill(0);
  if (created) {
    try {
      unlinkSync(recoveryPath);
      syncRuntimeRoot();
    } catch {
      failureCode = 'P2_HOST_RECOVERY_LOADER_CLEANUP_REQUIRED';
      outcome = undefined;
    }
  }
}

if (failureCode === undefined) {
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
} else {
  process.stdout.write(`${JSON.stringify({ ok: false, code: failureCode })}\n`);
  process.exitCode = 1;
}
