#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

import {
  HostEncryptionProvisioningError,
  canonicalDigest,
  canonicalJson,
  sha256,
  validateTangFleetAttestations,
  validateTangBackupAttestation,
} from '../../tools/seori-auth/src/host-encryption-provisioning.mjs';
import {
  P2Stage1Error,
  attestorPublicDetails,
  encryptionPublicDetails,
  encryptTangBackup,
  isolatedRestoreInventory,
  readScopedTangInventory,
  tangBackupEnvelopePublic,
} from '../../tools/seori-auth/src/p2-stage1.mjs';
import { activateP2ProcessHardening } from './p2-process-hardening-boundary.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const stage1ContractPath = join(repositoryRoot, 'contracts/fleet-p2-stage1.yaml');
const stage1SchemaPath = join(repositoryRoot, 'contracts/fleet-p2-stage1.schema.json');
const hostContractPath = join(repositoryRoot, 'contracts/fleet-p2-host-encryption.yaml');
const hostSchemaPath = join(repositoryRoot, 'contracts/fleet-p2-host-encryption.schema.json');
const mode = process.argv[2] ?? 'plan';
const MAX_PUBLIC_INPUT = 1024 * 1024;
const MAX_PUBLIC_KEY = 16 * 1024;
const NSFS_MAGIC = 0x6e736673;

class Stage1HostError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Stage1HostError';
    this.code = code;
  }
}

function stop(code) {
  throw new Stage1HostError(code);
}

const fixtureEntrypoint = fileURLToPath(
  new URL('../../tests/fixtures/p2-stage1-tang-fixture-entrypoint.mjs', import.meta.url),
);
let invokedEntrypoint;
try {
  invokedEntrypoint = process.argv[1] === undefined ? undefined : realpathSync(process.argv[1]);
} catch {
  invokedEntrypoint = undefined;
}
const fixtureRequested = process.env.SEORILABS_P2_STAGE1_FIXTURE_ROOT !== undefined;
const fixtureInjectionForbidden = fixtureRequested && invokedEntrypoint !== fixtureEntrypoint;
const fixtureRoot = invokedEntrypoint === fixtureEntrypoint
  ? process.env.SEORILABS_P2_STAGE1_FIXTURE_ROOT
  : undefined;
let verifiedSourceBoundary;

function loadContract(path, schemaPath, code) {
  try {
    const contract = parse(readFileSync(path, 'utf8'));
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
    if (!validate(contract)) stop(code);
    return Object.freeze(contract);
  } catch (error) {
    if (error instanceof Stage1HostError) throw error;
    stop(code);
  }
}

const stage1 = loadContract(stage1ContractPath, stage1SchemaPath, 'P2_STAGE1_CONTRACT_INVALID');
const hostContract = loadContract(hostContractPath, hostSchemaPath, 'P2_TANG_CONTRACT_INVALID');

function parseOptions() {
  const parsed = new Map();
  for (const argument of process.argv.slice(3)) {
    if (!argument.startsWith('--') || !argument.includes('=')) stop('P2_STAGE1_COMMAND_INVALID');
    const separator = argument.indexOf('=');
    const key = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (value.length === 0 || parsed.has(key)) stop('P2_STAGE1_COMMAND_INVALID');
    parsed.set(key, value);
  }
  return parsed;
}

const options = parseOptions();

function option(name, required = true) {
  const value = options.get(name);
  if (required && value === undefined) stop('P2_STAGE1_COMMAND_INVALID');
  return value;
}

function allowedOptions(allowed) {
  for (const key of options.keys()) if (!allowed.includes(key)) stop('P2_STAGE1_COMMAND_INVALID');
}

function server() {
  const nodeName = option('server');
  const selected = hostContract.tang.servers.find((entry) => entry.nodeName === nodeName);
  const host = stage1.hosts.find((entry) => entry.nodeName === nodeName && entry.role === 'tang');
  if (selected === undefined || host === undefined) stop('P2_STAGE1_SERVER_INVALID');
  return { selected, host };
}

function mapped(path) {
  if (fixtureRoot === undefined) return path;
  if (!isAbsolute(fixtureRoot)) stop('P2_STAGE1_FIXTURE_INVALID');
  return join(fixtureRoot, path.slice(1));
}

function backupPaths(selected) {
  return Object.freeze({
    artifact: `${stage1.tangBackup.remoteRoot}/${selected.nodeName}.${stage1.tangBackup.archiveSuffix}`,
    liveEvidence: `${stage1.tangBackup.remoteRoot}/${selected.nodeName}.live-evidence.json`,
    hostAttestation: `${stage1.tangBackup.hostAttestationRoot}/${selected.nodeName}.json`,
    trustAnchor: stage1.tangBackup.trustAnchorPath,
  });
}

function rpi5Paths() {
  return Object.freeze({
    trustAnchor: stage1.tangBackup.trustAnchorPath,
    attestations: Object.fromEntries(hostContract.tang.servers.map(({ nodeName }) => [
      nodeName,
      `${stage1.tangBackup.hostAttestationRoot}/${nodeName}.json`,
    ])),
  });
}

function confirmations(selected) {
  const digest = canonicalDigest({ stage1, hostContract }).slice(0, 16);
  return Object.freeze({
    backup: `fleet-p2-stage1-backup-${selected.nodeName}-${digest}`,
    install: `fleet-p2-stage1-install-evidence-${selected.nodeName}-${digest}`,
    rpi5: `fleet-p2-stage1-install-rpi5-evidence-${digest}`,
  });
}

function assertRoot() {
  if (fixtureRoot === undefined && process.geteuid?.() !== 0) stop('P2_STAGE1_ROOT_REQUIRED');
}

function assertInitialMountNamespace() {
  if (fixtureRoot !== undefined) {
    const fixture = JSON.parse(readFileSync(join(fixtureRoot, 'mount-namespace.json'), 'utf8'));
    if (fixture.initial !== true || fixture.nsfs !== true) {
      stop('P2_STAGE1_INITIAL_MOUNT_NAMESPACE_REQUIRED');
    }
    return;
  }
  try {
    const initial = statSync('/proc/1/ns/mnt');
    const current = statSync('/proc/self/ns/mnt');
    const initialFs = statfsSync('/proc/1/ns/mnt');
    const currentFs = statfsSync('/proc/self/ns/mnt');
    if (
      initial.dev !== current.dev || initial.ino !== current.ino ||
      initialFs.type !== NSFS_MAGIC || currentFs.type !== NSFS_MAGIC
    ) stop('P2_STAGE1_INITIAL_MOUNT_NAMESPACE_REQUIRED');
  } catch (error) {
    if (error instanceof Stage1HostError) throw error;
    stop('P2_STAGE1_INITIAL_MOUNT_NAMESPACE_REQUIRED');
  }
}

function run(executable, args, code) {
  try {
    return execFileSync(executable, args, {
      encoding: 'utf8',
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    }).trim();
  } catch {
    stop(code);
  }
}

function assertHostIdentity(host) {
  if (fixtureRoot !== undefined) {
    const fixture = JSON.parse(readFileSync(join(fixtureRoot, 'host-identity.json'), 'utf8'));
    if (
      fixture.hostname !== host.hostname || fixture.ipv4 !== host.ipv4 ||
      fixture.architecture !== host.architecture
    ) stop('P2_STAGE1_HOST_IDENTITY_MISMATCH');
    return fixture;
  }
  const hostname = run('/usr/bin/hostname', ['--short'], 'P2_STAGE1_HOST_IDENTITY_READBACK_FAILED');
  const machine = run('/usr/bin/uname', ['--machine'], 'P2_STAGE1_HOST_IDENTITY_READBACK_FAILED');
  const addresses = JSON.parse(run(
    '/usr/sbin/ip', ['-json', 'address', 'show', 'scope', 'global'],
    'P2_STAGE1_HOST_IDENTITY_READBACK_FAILED',
  )).flatMap(({ addr_info: info = [] }) => info)
    .filter(({ family, scope }) => family === 'inet' && scope === 'global')
    .map(({ local }) => local);
  const runtime = stage1.nodeRuntime.architectures[host.architecture];
  if (hostname !== host.hostname || machine !== runtime.unameMachine || !addresses.includes(host.ipv4)) {
    stop('P2_STAGE1_HOST_IDENTITY_MISMATCH');
  }
  return Object.freeze({ hostname, ipv4: host.ipv4, architecture: host.architecture });
}

function assertInstalledRuntime(host) {
  if (fixtureRoot !== undefined) return;
  const runtime = stage1.nodeRuntime.architectures[host.architecture];
  const commands = {
    node: ['bin/node', `v${stage1.nodeRuntime.version}`],
    npm: ['bin/npm', stage1.nodeRuntime.npmVersion],
    npx: ['bin/npx', null],
    corepack: ['bin/corepack', null],
  };
  for (const [name, [relative, expectedVersion]] of Object.entries(commands)) {
    const link = stage1.nodeRuntime.symlinks[name];
    const target = `${runtime.installRoot}/${relative}`;
    try {
      const entry = lstatSync(link);
      if (!entry.isSymbolicLink() || realpathSync(link) !== target) stop('P2_STAGE1_NODE_RUNTIME_DRIFT');
    } catch (error) {
      if (error instanceof Stage1HostError) throw error;
      stop('P2_STAGE1_NODE_RUNTIME_DRIFT');
    }
    if (expectedVersion !== null) {
      const version = run(link, ['--version'], 'P2_STAGE1_NODE_RUNTIME_READBACK_FAILED');
      if (version !== expectedVersion) stop('P2_STAGE1_NODE_RUNTIME_DRIFT');
    }
  }
}

function readFd(fd, maximum, code) {
  try {
    const entry = fstatSync(fd);
    if (!entry.isFile() && !entry.isFIFO() && !entry.isSocket()) stop(code);
    const bytes = readFileSync(fd);
    if (bytes.length < 1 || bytes.length > maximum) stop(code);
    return bytes;
  } catch (error) {
    if (error instanceof Stage1HostError) throw error;
    stop(code);
  }
}

function expectedTangOwner(selected) {
  if (fixtureRoot !== undefined) {
    const entry = lstatSync(mapped(selected.keyDirectory));
    return Object.freeze({ ownerId: entry.uid, groupId: entry.gid });
  }
  const ownerId = Number.parseInt(
    run('/usr/bin/id', ['-u', stage1.tangBackup.keyOwner], 'P2_STAGE1_TANG_OWNER_INVALID'),
    10,
  );
  const groupId = Number.parseInt(
    run('/usr/bin/id', ['-g', stage1.tangBackup.keyGroup], 'P2_STAGE1_TANG_OWNER_INVALID'),
    10,
  );
  if (!Number.isSafeInteger(ownerId) || ownerId < 0 ||
      !Number.isSafeInteger(groupId) || groupId < 0) {
    stop('P2_STAGE1_TANG_OWNER_INVALID');
  }
  return Object.freeze({ ownerId, groupId });
}

function readRegular(path, { modes, maxBytes = 4 * 1024 * 1024, rootOwned = false } = {}) {
  let descriptor;
  try {
    const local = mapped(path);
    const entry = lstatSync(local);
    if (
      !entry.isFile() || entry.isSymbolicLink() || realpathSync(local) !== local ||
      entry.nlink !== 1 ||
      (modes !== undefined && !modes.includes(entry.mode & 0o777)) ||
      (rootOwned && fixtureRoot === undefined && (entry.uid !== 0 || entry.gid !== 0)) ||
      entry.size < 1 || entry.size > maxBytes
    ) stop('P2_STAGE1_FILE_INVALID');
    descriptor = openSync(local, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const held = fstatSync(descriptor);
    if (
      held.dev !== entry.dev || held.ino !== entry.ino || held.size !== entry.size ||
      held.mode !== entry.mode || held.uid !== entry.uid || held.gid !== entry.gid ||
      held.nlink !== entry.nlink
    ) {
      stop('P2_STAGE1_FILE_DRIFT');
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(local);
    if (
      after.dev !== held.dev || after.ino !== held.ino || after.size !== held.size ||
      after.mode !== held.mode || after.uid !== held.uid || after.gid !== held.gid ||
      after.nlink !== held.nlink || after.mtimeMs !== held.mtimeMs ||
      after.ctimeMs !== held.ctimeMs || pathAfter.dev !== held.dev ||
      pathAfter.ino !== held.ino || pathAfter.size !== held.size ||
      pathAfter.mtimeMs !== held.mtimeMs || pathAfter.ctimeMs !== held.ctimeMs
    ) {
      bytes.fill(0);
      stop('P2_STAGE1_FILE_DRIFT');
    }
    return bytes;
  } catch (error) {
    if (error instanceof Stage1HostError) throw error;
    stop('P2_STAGE1_FILE_INVALID');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function ensureFixtureDirectory(path, { privateDirectory = true } = {}) {
  if (fixtureRoot === undefined) stop('P2_STAGE1_NATIVE_RECORD_BOUNDARY_REQUIRED');
  const local = mapped(path);
  mkdirSync(local, { recursive: true, mode: 0o700 });
  const entry = lstatSync(local);
  if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(local) !== local ||
      (privateDirectory ? (entry.mode & 0o077) !== 0 : (entry.mode & 0o022) !== 0) ||
      (fixtureRoot === undefined && (entry.uid !== 0 || entry.gid !== 0))) {
    stop('P2_STAGE1_DIRECTORY_INVALID');
  }
}

function writeFixtureCreateOnlyOrExact(path, bytes, modeValue, { privateParent = true } = {}) {
  if (fixtureRoot === undefined) stop('P2_STAGE1_NATIVE_RECORD_BOUNDARY_REQUIRED');
  const local = mapped(path);
  ensureFixtureDirectory(dirname(path), { privateDirectory: privateParent });
  try {
    const existing = readRegular(path, { modes: [modeValue], maxBytes: Math.max(bytes.length, 1) });
    try {
      if (!existing.equals(bytes)) stop('P2_STAGE1_CREATE_ONLY_DRIFT');
      return 'EXACT_READBACK';
    } finally {
      existing.fill(0);
    }
  } catch (error) {
    if (error instanceof Stage1HostError && error.code !== 'P2_STAGE1_FILE_INVALID') throw error;
  }
  const temporary = `${local}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      modeValue,
    );
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, modeValue);
    fsyncSync(descriptor);
    linkSync(temporary, local);
    unlinkSync(temporary);
    const written = readRegular(path, { modes: [modeValue], maxBytes: Math.max(bytes.length, 1) });
    if (!written.equals(bytes)) stop('P2_STAGE1_CREATE_ONLY_READBACK_FAILED');
    return 'CREATED';
  } catch (error) {
    if (error instanceof Stage1HostError) throw error;
    stop('P2_STAGE1_CREATE_ONLY_FAILED');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') stop('P2_STAGE1_CREATE_ONLY_FAILED');
    }
  }
}

function sourceBoundary() {
  if (fixtureRoot !== undefined) return null;
  if (verifiedSourceBoundary !== undefined) return verifiedSourceBoundary;
  try {
    const canonicalRoot = realpathSync(repositoryRoot).replace(/\/$/u, '');
    const prefix = `${stage1.sourceBootstrap.installRoot}/`;
    if (!canonicalRoot.startsWith(prefix)) stop('P2_STAGE1_SOURCE_RECEIPT_INVALID');
    const sourceSha = canonicalRoot.slice(prefix.length);
    if (!/^[a-f0-9]{40}$/u.test(sourceSha)) stop('P2_STAGE1_SOURCE_RECEIPT_INVALID');
    const receiptPath = join(canonicalRoot, stage1.sourceBootstrap.receiptName);
    const receipt = JSON.parse(readRegular(receiptPath, {
      modes: [Number.parseInt(stage1.sourceBootstrap.receiptMode, 8)],
      maxBytes: 64 * 1024,
      rootOwned: true,
    }).toString('utf8'));
    const expectedReceiptKeys = [
      'archiveSha256', 'dependencyPolicy', 'nativeLauncherPath', 'nativeLauncherSha256',
      'nodeName', 'nodeVersion', 'npmVersion', 'packageLockSha256', 'processBoundaryPath',
      'processBoundarySha256', 'recordBoundaryPath', 'recordBoundarySha256', 'schemaVersion',
      'sourceNativeHelperPath', 'sourceNativeHelperSha256', 'sourceSha', 'state',
    ];
    const sourceNativeHelper = join(canonicalRoot, stage1.sourceBootstrap.nativeLauncherRelativePath);
    const packageLock = join(canonicalRoot, stage1.sourceBootstrap.packageLockPath);
    const nativeLauncher = stage1.hostProcessBoundary.launcherExecutable;
    const processBoundary = stage1.hostProcessBoundary.moduleExecutable;
    const recordBoundary = stage1.sourceBootstrap.filesystemBoundaryPath;
    const sourceNativeBytes = readRegular(sourceNativeHelper, { modes: [0o755], rootOwned: true });
    const packageLockBytes = readRegular(packageLock, { modes: [0o644, 0o444], rootOwned: true });
    const nativeBytes = readRegular(nativeLauncher, { modes: [0o755], rootOwned: true });
    const processBytes = readRegular(processBoundary, { modes: [0o755], rootOwned: true });
    const recordBytes = readRegular(recordBoundary, { modes: [0o755], rootOwned: true });
    if (
      Object.keys(receipt).toSorted().join('\0') !== expectedReceiptKeys.toSorted().join('\0') ||
      receipt.schemaVersion !== 1 || receipt.state !== 'P2_STAGE1_SOURCE_READY' ||
      receipt.sourceSha !== sourceSha || !/^[a-f0-9]{64}$/u.test(receipt.archiveSha256 ?? '') ||
      receipt.packageLockSha256 !== sha256(packageLockBytes) ||
      receipt.dependencyPolicy !== stage1.sourceBootstrap.dependencyPolicy ||
      receipt.nodeVersion !== stage1.nodeRuntime.version ||
      receipt.npmVersion !== stage1.nodeRuntime.npmVersion ||
      receipt.sourceNativeHelperPath !== sourceNativeHelper ||
      receipt.sourceNativeHelperSha256 !== sha256(sourceNativeBytes) ||
      receipt.nativeLauncherPath !== nativeLauncher ||
      receipt.processBoundaryPath !== processBoundary ||
      receipt.recordBoundaryPath !== recordBoundary ||
      receipt.nativeLauncherSha256 !== sha256(nativeBytes) ||
      receipt.processBoundarySha256 !== sha256(processBytes) ||
      receipt.recordBoundarySha256 !== sha256(recordBytes)
    ) stop('P2_STAGE1_SOURCE_RECEIPT_INVALID');
    activateP2ProcessHardening(stage1.hostProcessBoundary);
    sourceNativeBytes.fill(0);
    packageLockBytes.fill(0);
    nativeBytes.fill(0);
    processBytes.fill(0);
    recordBytes.fill(0);
    verifiedSourceBoundary = Object.freeze({
      sourceSha, nativeLauncher, processBoundary, recordBoundary, receipt,
    });
    return verifiedSourceBoundary;
  } catch (error) {
    if (error instanceof Stage1HostError) throw error;
    stop('P2_STAGE1_SOURCE_RECEIPT_INVALID');
  }
}

function recordId(path, selected) {
  const paths = backupPaths(selected);
  if (path === paths.artifact) return `backup-artifact-${selected.nodeName}`;
  if (path === paths.liveEvidence) return `live-evidence-${selected.nodeName}`;
  if (path === paths.trustAnchor) return 'trust-anchor';
  if (path === paths.hostAttestation) return `tang-attestation-${selected.nodeName}`;
  stop('P2_STAGE1_RECORD_ID_INVALID');
}

function writeHostRecord(path, bytes, modeValue, selected, options = {}) {
  if (fixtureRoot !== undefined) {
    assertInitialMountNamespace();
    return writeFixtureCreateOnlyOrExact(path, bytes, modeValue, options);
  }
  try {
    const existing = readRegular(path, {
      modes: [modeValue],
      maxBytes: Math.max(bytes.length, 1),
      rootOwned: true,
    });
    try {
      if (!existing.equals(bytes)) stop('P2_STAGE1_CREATE_ONLY_DRIFT');
      return 'EXACT_READBACK';
    } finally {
      existing.fill(0);
    }
  } catch (error) {
    if (error instanceof Stage1HostError && error.code !== 'P2_STAGE1_FILE_INVALID') throw error;
    try {
      lstatSync(mapped(path));
      stop('P2_STAGE1_CREATE_ONLY_DRIFT');
    } catch (nested) {
      if (nested instanceof Stage1HostError) throw nested;
      if (nested?.code !== 'ENOENT') stop('P2_STAGE1_CREATE_ONLY_DRIFT');
    }
  }
  assertInitialMountNamespace();
  const boundary = sourceBoundary();
  try {
    const selectedRecord = recordId(path, selected);
    const receipt = JSON.parse(execFileSync(
      boundary.recordBoundary,
      ['publish-record', selectedRecord],
      {
        input: bytes,
        encoding: 'utf8',
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
        maxBuffer: 64 * 1024,
      },
    ));
    if (
      receipt.operation !== 'publish-record' || receipt.record !== selectedRecord ||
      receipt.sizeBytes !== bytes.length ||
      Object.keys(receipt).toSorted().join('\0') !==
        ['operation', 'record', 'sizeBytes'].toSorted().join('\0')
    ) stop('P2_STAGE1_RECORD_MUTATION_OUTCOME_UNKNOWN');
  } catch {
    stop('P2_STAGE1_RECORD_MUTATION_OUTCOME_UNKNOWN');
  }
  const written = readRegular(path, {
    modes: [modeValue],
    maxBytes: Math.max(bytes.length, 1),
    rootOwned: true,
  });
  try {
    if (!written.equals(bytes)) stop('P2_STAGE1_CREATE_ONLY_READBACK_FAILED');
  } finally {
    written.fill(0);
  }
  return 'CREATED';
}

function plan() {
  allowedOptions(['server']);
  const { selected, host } = server();
  const paths = backupPaths(selected);
  return Object.freeze({
    schemaVersion: 1,
    state: 'DRY_RUN',
    contractDigest: canonicalDigest({ stage1, hostContract }),
    nodeName: selected.nodeName,
    host,
    logicalCredentialId: selected.backupLogicalId,
    paths,
    confirmations: confirmations(selected),
    recipientPublicKeyFd: 3,
    secretValuesReturned: false,
  });
}

function backupState() {
  allowedOptions(['server']);
  assertRoot();
  const { selected, host } = server();
  assertHostIdentity(host);
  assertInstalledRuntime(host);
  sourceBoundary();
  assertInitialMountNamespace();
  const paths = backupPaths(selected);
  const states = {};
  for (const name of ['artifact', 'liveEvidence']) {
    try {
      readRegular(paths[name], { modes: [0o600] });
      states[name] = 'PRESENT';
    } catch (error) {
      if (error instanceof Stage1HostError && error.code === 'P2_STAGE1_FILE_INVALID') {
        try {
          lstatSync(mapped(paths[name]));
          stop('P2_STAGE1_BACKUP_PARTIAL_OR_DRIFT');
        } catch (nested) {
          if (nested instanceof Stage1HostError) throw nested;
          if (nested?.code !== 'ENOENT') stop('P2_STAGE1_BACKUP_PARTIAL_OR_DRIFT');
          states[name] = 'ABSENT';
        }
      } else {
        throw error;
      }
    }
  }
  if (states.artifact === 'ABSENT' && states.liveEvidence === 'PRESENT') {
    stop('P2_STAGE1_BACKUP_PARTIAL_OR_DRIFT');
  }
  const state = states.artifact === 'PRESENT' && states.liveEvidence === 'ABSENT'
    ? 'BACKUP_ARTIFACT_PRESENT_EVIDENCE_RECOVERABLE'
    : states.artifact === 'PRESENT'
      ? 'BACKUP_PRESENT_VERIFY_FIRST'
      : 'BACKUP_ABSENT';
  return Object.freeze({
    schemaVersion: 1,
    state,
    nodeName: selected.nodeName,
    logicalCredentialId: selected.backupLogicalId,
    secretExposed: false,
  });
}

function backupVerify({ existingOnly = false } = {}) {
  allowedOptions(['server', 'confirmation']);
  assertRoot();
  const { selected, host } = server();
  if (option('confirmation') !== confirmations(selected).backup) {
    stop('P2_STAGE1_BACKUP_CONFIRMATION_REQUIRED');
  }
  assertHostIdentity(host);
  assertInstalledRuntime(host);
  sourceBoundary();
  assertInitialMountNamespace();
  const paths = backupPaths(selected);
  const owner = expectedTangOwner(selected);
  const liveBefore = readScopedTangInventory(mapped(stage1.tangBackup.keyDirectory), {
    expectedOwner: owner,
  });
  const rootRestored = isolatedRestoreInventory({
    payload: liveBefore.archivePayload,
    temporaryParent: mapped('/var/tmp'),
    applyOwnership: true,
  });
  if (canonicalJson(rootRestored) !== canonicalJson(liveBefore.privateInventory)) {
    stop('P2_STAGE1_ISOLATED_RESTORE_MISMATCH');
  }
  const recipientPublicKey = readFd(3, MAX_PUBLIC_KEY, 'P2_STAGE1_ENCRYPTION_KEY_INVALID');
  const recipient = encryptionPublicDetails(recipientPublicKey);
  let artifactBytes;
  let artifactState = 'EXACT_READBACK';
  try {
    if (existingOnly) {
      artifactBytes = readRegular(paths.artifact, { modes: [0o600] });
      const envelope = tangBackupEnvelopePublic({ contract: stage1, server: selected, artifactBytes });
      if (envelope.recipientPublicKeySha256 !== recipient.fingerprintSha256) {
        stop('P2_STAGE1_BACKUP_RECIPIENT_MISMATCH');
      }
    } else {
      try {
        readRegular(paths.artifact, { modes: [0o600] });
        stop('P2_STAGE1_BACKUP_READBACK_FIRST_REQUIRED');
      } catch (error) {
        if (error instanceof Stage1HostError && error.code !== 'P2_STAGE1_FILE_INVALID') throw error;
      }
      artifactBytes = encryptTangBackup({
        contract: stage1,
        server: selected,
        archivePayload: liveBefore.archivePayload,
        recipientPublicKeyBytes: recipientPublicKey,
      });
      artifactState = writeHostRecord(paths.artifact, artifactBytes, 0o600, selected);
    }
    const envelope = tangBackupEnvelopePublic({ contract: stage1, server: selected, artifactBytes });
    const liveEvidence = Object.freeze({
      schemaVersion: 1,
      nodeName: selected.nodeName,
      logicalCredentialId: selected.backupLogicalId,
      liveContentSha256: liveBefore.privateInventory.contentSha256,
      liveMetadataSha256: liveBefore.privateInventory.metadataSha256,
      inventoryEvidenceSha256: liveBefore.privateInventory.inventoryEvidenceSha256,
      rootRestoreContentSha256: rootRestored.contentSha256,
      rootRestoreMetadataSha256: rootRestored.metadataSha256,
      rootRestoreInventoryEvidenceSha256: rootRestored.inventoryEvidenceSha256,
      backupArtifactSha256: envelope.backupArtifactSha256,
      recipientPublicKeySha256: recipient.fingerprintSha256,
      backupGeneration: `tang-${selected.nodeName}-${envelope.backupArtifactSha256.slice(0, 16)}`,
    });
    const liveAfter = readScopedTangInventory(mapped(stage1.tangBackup.keyDirectory), {
      expectedOwner: owner,
    });
    if (
      canonicalJson(liveAfter.privateInventory) !== canonicalJson(liveBefore.privateInventory)
    ) stop('P2_STAGE1_TANG_INVENTORY_CHANGED');
    const evidenceBytes = Buffer.from(`${canonicalJson(liveEvidence)}\n`, 'utf8');
    const evidenceState = writeHostRecord(paths.liveEvidence, evidenceBytes, 0o600, selected);
    evidenceBytes.fill(0);
    return Object.freeze({
      schemaVersion: 1,
      state: 'TANG_SCOPED_ENCRYPTED_BACKUP_RECORDED',
      nodeName: selected.nodeName,
      logicalCredentialId: selected.backupLogicalId,
      backupArtifactSha256: liveEvidence.backupArtifactSha256,
      inventoryEvidenceSha256: liveEvidence.inventoryEvidenceSha256,
      recipientPublicKeySha256: liveEvidence.recipientPublicKeySha256,
      artifactState,
      evidenceState,
      secretExposed: false,
    });
  } finally {
    recipientPublicKey.fill(0);
    artifactBytes?.fill(0);
    for (const file of liveBefore.archivePayload.files) file.content = '';
  }
}

function installEvidence() {
  allowedOptions(['server', 'confirmation']);
  assertRoot();
  const { selected, host } = server();
  if (option('confirmation') !== confirmations(selected).install) {
    stop('P2_STAGE1_INSTALL_CONFIRMATION_REQUIRED');
  }
  assertHostIdentity(host);
  assertInstalledRuntime(host);
  sourceBoundary();
  assertInitialMountNamespace();
  const input = readFd(3, MAX_PUBLIC_INPUT, 'P2_STAGE1_INSTALL_PAYLOAD_INVALID');
  let payload;
  try {
    payload = JSON.parse(input.toString('utf8'));
  } catch {
    stop('P2_STAGE1_INSTALL_PAYLOAD_INVALID');
  } finally {
    input.fill(0);
  }
  if (
    payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
    Object.keys(payload).toSorted().join('\0') !== ['attestation', 'publicKeyPem'].join('\0') ||
    typeof payload.publicKeyPem !== 'string' || Buffer.byteLength(payload.publicKeyPem) > 16 * 1024
  ) stop('P2_STAGE1_INSTALL_PAYLOAD_INVALID');
  const publicKey = Buffer.from(payload.publicKeyPem, 'utf8');
  const live = readScopedTangInventory(mapped(stage1.tangBackup.keyDirectory), {
    expectedOwner: expectedTangOwner(selected),
  });
  const verified = validateTangBackupAttestation({
    contract: hostContract,
    server: selected,
    attestation: payload.attestation,
    authorityPublicKey: publicKey,
    liveInventory: live.privateInventory,
  });
  const paths = backupPaths(selected);
  const publicDetails = attestorPublicDetails(publicKey);
  const trustState = writeHostRecord(paths.trustAnchor, publicKey, 0o444, selected, {
    privateParent: false,
  });
  const attestationBytes = Buffer.from(`${canonicalJson(payload.attestation)}\n`, 'utf8');
  const attestationState = writeHostRecord(paths.hostAttestation, attestationBytes, 0o400, selected);
  attestationBytes.fill(0);
  publicKey.fill(0);
  return Object.freeze({
    schemaVersion: 1,
    state: 'TANG_BACKUP_EVIDENCE_INSTALLED',
    nodeName: selected.nodeName,
    signerPublicKeySha256: publicDetails.fingerprintSha256,
    backupArtifactSha256: verified.envelope.backupArtifactSha256,
    inventoryEvidenceSha256: verified.envelope.inventoryEvidenceSha256,
    trustState,
    attestationState,
    secretExposed: false,
  });
}

function planRpi5() {
  allowedOptions([]);
  const host = stage1.hosts.find(({ nodeName }) => nodeName === hostContract.target.nodeName);
  if (host === undefined) stop('P2_STAGE1_HOST_INVALID');
  return Object.freeze({
    schemaVersion: 1,
    state: 'DRY_RUN',
    contractDigest: canonicalDigest({ stage1, hostContract }),
    nodeName: host.nodeName,
    paths: rpi5Paths(),
    confirmation: confirmations(hostContract.tang.servers[0]).rpi5,
    inputFd: 3,
    secretValuesReturned: false,
  });
}

function installRpi5Evidence() {
  allowedOptions(['confirmation']);
  assertRoot();
  const host = stage1.hosts.find(({ nodeName }) => nodeName === hostContract.target.nodeName);
  if (host === undefined) stop('P2_STAGE1_HOST_INVALID');
  if (option('confirmation') !== confirmations(hostContract.tang.servers[0]).rpi5) {
    stop('P2_STAGE1_INSTALL_CONFIRMATION_REQUIRED');
  }
  assertHostIdentity(host);
  assertInstalledRuntime(host);
  sourceBoundary();
  assertInitialMountNamespace();
  const input = readFd(3, MAX_PUBLIC_INPUT, 'P2_STAGE1_INSTALL_PAYLOAD_INVALID');
  let payload;
  try {
    payload = JSON.parse(input.toString('utf8'));
  } catch {
    stop('P2_STAGE1_INSTALL_PAYLOAD_INVALID');
  } finally {
    input.fill(0);
  }
  if (
    payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
    Object.keys(payload).toSorted().join('\0') !== ['publicKeyPem', 'tangAttestations'].join('\0') ||
    typeof payload.publicKeyPem !== 'string' || Buffer.byteLength(payload.publicKeyPem) > 16 * 1024 ||
    !Array.isArray(payload.tangAttestations)
  ) stop('P2_STAGE1_INSTALL_PAYLOAD_INVALID');
  const publicKey = Buffer.from(payload.publicKeyPem, 'utf8');
  const publicDetails = attestorPublicDetails(publicKey);
  const attestations = validateTangFleetAttestations(
    hostContract,
    payload.tangAttestations,
    publicKey,
  );
  const paths = rpi5Paths();
  const trustState = writeHostRecord(
    paths.trustAnchor,
    publicKey,
    0o444,
    hostContract.tang.servers[0],
    {
    privateParent: false,
    },
  );
  const attestationStates = {};
  for (const attestation of attestations) {
    const bytes = Buffer.from(`${canonicalJson(attestation)}\n`, 'utf8');
    try {
      attestationStates[attestation.nodeName] = writeHostRecord(
        paths.attestations[attestation.nodeName],
        bytes,
        0o400,
        hostContract.tang.servers.find(({ nodeName }) => nodeName === attestation.nodeName),
      );
    } finally {
      bytes.fill(0);
    }
  }
  publicKey.fill(0);
  return Object.freeze({
    schemaVersion: 1,
    state: 'RPI5_TANG_TRUST_EVIDENCE_INSTALLED',
    nodeName: host.nodeName,
    signerPublicKeySha256: publicDetails.fingerprintSha256,
    tangAttestationDigests: attestations.map(({ observedDigest }) => observedDigest),
    trustState,
    attestationStates,
    secretExposed: false,
  });
}

const handlers = new Map([
  ['plan', plan],
  ['backup-state', backupState],
  ['backup-verify', () => backupVerify()],
  ['verify-existing', () => backupVerify({ existingOnly: true })],
  ['install-evidence', installEvidence],
  ['plan-rpi5', planRpi5],
  ['install-rpi5-evidence', installRpi5Evidence],
]);

try {
  if (fixtureInjectionForbidden) stop('P2_STAGE1_FIXTURE_INJECTION_FORBIDDEN');
  const handler = handlers.get(mode);
  if (handler === undefined) stop('P2_STAGE1_COMMAND_INVALID');
  process.stdout.write(`${JSON.stringify(handler())}\n`);
} catch (error) {
  const code = error instanceof Stage1HostError || error instanceof P2Stage1Error ||
    error instanceof HostEncryptionProvisioningError
    ? error.code
    : 'P2_STAGE1_FAILED';
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exitCode = 1;
}
