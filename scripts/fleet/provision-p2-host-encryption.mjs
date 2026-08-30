#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

import {
  HostEncryptionProvisioningError,
  buildClevisPolicy,
  buildPreProvisionBackupAttestation,
  buildProvisionedHostAttestation,
  buildRebootVerifiedHostAttestation,
  buildSystemdConfiguration,
  canonicalDigest,
  canonicalJson,
  confirmations,
  contractDigest,
  publicPlan,
  sha256,
  validateAllocatedFile,
  validateMountedFilesystem,
  validateMapperBackingAttestation,
  validatePreProvisionBackupAttestation,
  validateProvisionedHostAttestation,
  validateTangFleetAttestations,
} from '../../tools/seori-auth/src/host-encryption-provisioning.mjs';
import {
  buildHostEncryptedMountAttestation,
  validateHostEncryptedMountAttestation,
} from '../../tools/seori-auth/src/host-encrypted-mount.mjs';
import {
  StateEnvelopeError,
  verifyRetainVolumeReadback,
} from '../../tools/seori-auth/src/state-envelope.mjs';
import {
  KubectlReadbackBoundaryError,
  openSecureMicrok8sKubectlReadbackBoundary,
  openSecureKubectlReadbackBoundary,
} from '../../tools/seori-auth/src/kubectl-readback-boundary.mjs';
import { activateP2ProcessHardening } from './p2-process-hardening-boundary.mjs';

const contractPath = fileURLToPath(
  new URL('../../contracts/fleet-p2-host-encryption.yaml', import.meta.url),
);
const schemaPath = fileURLToPath(
  new URL('../../contracts/fleet-p2-host-encryption.schema.json', import.meta.url),
);
const fleetPath = fileURLToPath(
  new URL('../../contracts/fleet-p3-runtime.yaml', import.meta.url),
);
const kubectl = '/usr/bin/snap';
const kubectlPrefix = ['run', 'microk8s.kubectl'];
const MICROK8S_KUBECONFIG = '/var/snap/microk8s/current/credentials/client.config';
const MICROK8S_STATE_ROOT = '/var/snap/microk8s';
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const mode = process.argv[2] ?? 'plan';

class HostCommandError extends Error {
  constructor(code) {
    super(code);
    this.name = 'HostCommandError';
    this.code = code;
  }
}

function stop(code) {
  throw new HostCommandError(code);
}

const fixtureEntrypoint = fileURLToPath(
  new URL('../../tests/fixtures/p2-host-provision-fixture-entrypoint.mjs', import.meta.url),
);
const fixtureRequested = process.env.SEORILABS_HOST_FIXTURE_RUNTIME !== undefined ||
  process.env.SEORILABS_HOST_FIXTURE_ROOT !== undefined;
let invokedEntrypoint;
try {
  invokedEntrypoint = process.argv[1] === undefined ? undefined : realpathSync(process.argv[1]);
} catch {
  invokedEntrypoint = undefined;
}
const fixtureInjectionForbidden = fixtureRequested && invokedEntrypoint !== fixtureEntrypoint;
const kubectlOverrideForbidden = process.env.SEORILABS_KUBECTL !== undefined &&
  invokedEntrypoint !== fixtureEntrypoint;
const fixtureRuntime = invokedEntrypoint === fixtureEntrypoint
  ? process.env.SEORILABS_HOST_FIXTURE_RUNTIME
  : undefined;
const fixtureRoot = invokedEntrypoint === fixtureEntrypoint
  ? process.env.SEORILABS_HOST_FIXTURE_ROOT
  : undefined;
const openRecoveryKeys = new Set();

function loadContract() {
  try {
    const raw = readFileSync(contractPath, 'utf8');
    const contract = parse(raw);
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
    if (!validate(contract)) stop('P2_HOST_CONTRACT_INVALID');
    return contract;
  } catch (error) {
    if (error instanceof HostCommandError) throw error;
    stop('P2_HOST_CONTRACT_INVALID');
  }
}

function loadFleetState() {
  try {
    return parse(readFileSync(fleetPath, 'utf8'))?.authBroker?.state;
  } catch {
    stop('P2_HOST_RUNTIME_CONTRACT_INVALID');
  }
}

const contract = loadContract();
const state = loadFleetState();
const systemdConfiguration = buildSystemdConfiguration(contract);
const confirmationSet = confirmations(contract);

function parseOptions() {
  const options = new Map();
  for (const argument of process.argv.slice(3)) {
    if (!argument.startsWith('--') || !argument.includes('=')) {
      stop('P2_HOST_COMMAND_INVALID');
    }
    const separator = argument.indexOf('=');
    const key = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (value.length === 0 || (options.has(key) && key !== 'tang-attestation')) {
      stop('P2_HOST_COMMAND_INVALID');
    }
    const values = options.get(key) ?? [];
    values.push(value);
    options.set(key, values);
  }
  return options;
}

const options = parseOptions();
const publicErrorChannel = options.get('public-error-channel');
const publicErrorsOnStdout = publicErrorChannel?.length === 1 && publicErrorChannel[0] === 'stdout';

function option(name, required = true) {
  const values = options.get(name) ?? [];
  if (values.length !== 1) {
    if (!required && values.length === 0) return undefined;
    stop('P2_HOST_COMMAND_INVALID');
  }
  return values[0];
}

function repeatedOption(name, count) {
  const values = options.get(name) ?? [];
  if (values.length !== count) stop('P2_HOST_COMMAND_INVALID');
  return values;
}

function assertAllowedOptions(allowed) {
  for (const key of options.keys()) {
    if (!allowed.includes(key) && key !== 'public-error-channel') stop('P2_HOST_COMMAND_INVALID');
  }
  if (publicErrorChannel !== undefined && !publicErrorsOnStdout) stop('P2_HOST_COMMAND_INVALID');
}

function mappedPath(path) {
  if (fixtureRuntime === undefined) return path;
  if (!isAbsolute(fixtureRoot ?? '')) stop('P2_HOST_FIXTURE_BOUNDARY_INVALID');
  return join(fixtureRoot, path.slice(1));
}

function openHostKubectlReadbackBoundary(requestedPath) {
  if (requestedPath !== MICROK8S_KUBECONFIG) {
    return openSecureKubectlReadbackBoundary(requestedPath);
  }
  return openSecureMicrok8sKubectlReadbackBoundary({
    requestedPath: mappedPath(requestedPath),
    stateRoot: mappedPath(MICROK8S_STATE_ROOT),
    expectedOwner: fixtureRuntime === undefined ? 0 : process.geteuid?.(),
  });
}

function commandEnvironment() {
  const environment = {
    PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
    DEBIAN_FRONTEND: 'noninteractive',
    LANG: 'C',
    LC_ALL: 'C',
  };
  for (const key of [
    'SEORILABS_HOST_FIXTURE_SCENARIO',
    'SEORILABS_HOST_FIXTURE_LOG',
    'SEORILABS_HOST_FIXTURE_NODE',
    'SEORILABS_HOST_FIXTURE_STATE',
    'SEORILABS_HOST_FIXTURE_ROOT',
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

function canonicalExecutable(path) {
  if (fixtureRuntime !== undefined) return path;
  try {
    const entry = lstatSync(path);
    if (
      !isAbsolute(path) || !entry.isFile() || entry.isSymbolicLink() ||
      realpathSync(path) !== path || (entry.mode & 0o111) === 0 ||
      ([
        contract.filesystemBoundary.executable,
        contract.processBoundary.launcherExecutable,
        kubectl,
      ].includes(path) &&
        (entry.uid !== 0 || entry.gid !== 0 || (entry.mode & 0o022) !== 0))
    ) stop('P2_HOST_EXECUTABLE_INVALID');
    return path;
  } catch (error) {
    if (error instanceof HostCommandError) throw error;
    stop('P2_HOST_EXECUTABLE_INVALID');
  }
}

function run(
  executable,
  args,
  code,
  { mutation = false, allowedStatuses = [], recoveryKey, inputDescriptors = [], input } = {},
) {
  if (input !== undefined && (recoveryKey !== undefined || inputDescriptors.length > 0)) {
    stop('P2_HOST_COMMAND_INPUT_BOUNDARY_INVALID');
  }
  const commandPath = canonicalExecutable(executable);
  const runtime = fixtureRuntime === undefined ? commandPath : process.execPath;
  const runtimeArgs = fixtureRuntime === undefined
    ? args
    : [fixtureRuntime, commandPath, ...args];
  try {
    if (recoveryKey !== undefined) assertRecoveryKeyIdentity(recoveryKey);
    return {
      status: 0,
      stdout: execFileSync(runtime, runtimeArgs, {
        encoding: 'utf8',
        env: commandEnvironment(),
        maxBuffer: MAX_OUTPUT_BYTES,
        stdio: [
          input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe',
          ...(recoveryKey === undefined ? inputDescriptors : [recoveryKey.descriptor]),
        ],
        ...(input === undefined ? {} : { input }),
        timeout: mutation ? 120_000 : 15_000,
      }),
    };
  } catch (error) {
    if (error instanceof HostCommandError) throw error;
    if (allowedStatuses.includes(error?.status)) {
      return { status: error.status, stdout: error.stdout ?? '' };
    }
    stop(mutation ? 'P2_HOST_MUTATION_OUTCOME_UNKNOWN' : code);
  }
}

function read(executable, args, code, runOptions = {}) {
  return run(executable, args, code, runOptions).stdout.trim();
}

function mutate(executable, args) {
  run(executable, args, 'P2_HOST_MUTATION_FAILED', { mutation: true });
}

function mutateWithRecoveryKey(executable, args, recoveryKey) {
  run(executable, args, 'P2_HOST_MUTATION_FAILED', {
    mutation: true,
    recoveryKey,
  });
}

function mutateFilesystemBoundary(operation, args = [], inputDescriptors = [], input) {
  if (!contract.filesystemBoundary.operations.includes(operation)) {
    stop('P2_HOST_FILESYSTEM_BOUNDARY_OPERATION_INVALID');
  }
  const result = run(
    contract.filesystemBoundary.executable,
    [operation, ...args],
    'P2_HOST_FILESYSTEM_BOUNDARY_FAILED',
    { mutation: true, inputDescriptors, input },
  );
  const receipt = publicJson(result.stdout, 'P2_HOST_FILESYSTEM_BOUNDARY_RECEIPT_INVALID');
  if (receipt.operation !== operation) stop('P2_HOST_FILESYSTEM_BOUNDARY_RECEIPT_INVALID');
  return receipt;
}

function verifyNativeHostMountNamespace() {
  if (!contract.filesystemBoundary.operations.includes('verify-namespace')) {
    stop('P2_HOST_FILESYSTEM_BOUNDARY_OPERATION_INVALID');
  }
  const receipt = publicJson(
    run(
      contract.filesystemBoundary.executable,
      ['verify-namespace'],
      'P2_HOST_MOUNT_NAMESPACE_NATIVE_READBACK_FAILED',
    ).stdout,
    'P2_HOST_FILESYSTEM_BOUNDARY_RECEIPT_INVALID',
  );
  if (
    receipt.operation !== 'verify-namespace' || receipt.verified !== true ||
    Object.keys(receipt).toSorted().join('\0') !== ['operation', 'verified'].join('\0')
  ) stop('P2_HOST_FILESYSTEM_BOUNDARY_RECEIPT_INVALID');
}

function assertNativeProcessHardening() {
  let receipt;
  try {
    receipt = fixtureRuntime === undefined
      ? activateP2ProcessHardening(contract.processBoundary)
      : publicJson(
        run(
          contract.processBoundary.launcherExecutable,
          ['fixture-process-hardening-readback'],
          'P2_HOST_PROCESS_HARDENING_READBACK_FAILED',
        ).stdout,
        'P2_HOST_PROCESS_HARDENING_RECEIPT_INVALID',
      );
  } catch (error) {
    if (error instanceof HostCommandError) throw error;
    stop('P2_HOST_PROCESS_HARDENING_READBACK_FAILED');
  }
  const expected = {
    state: 'PROCESS_HARDENING_OK',
    coreSoft: 0,
    coreHard: 0,
    dumpable: 0,
    noNewPrivileges: 1,
  };
  if (
    Object.keys(receipt).toSorted().join('\0') !== Object.keys(expected).toSorted().join('\0') ||
    Object.entries(expected).some(([key, value]) => receipt[key] !== value)
  ) stop('P2_HOST_PROCESS_HARDENING_RECEIPT_INVALID');
}

function assertNativeLaunchMarker() {
  if (process.env[contract.processBoundary.launchMarker] !== '1') {
    stop('P2_HOST_NATIVE_LAUNCH_REQUIRED');
  }
  canonicalExecutable(contract.processBoundary.launcherExecutable);
}

function publicJson(text, code) {
  try {
    return JSON.parse(text);
  } catch {
    stop(code);
  }
}

function readCanonicalJson(path, code) {
  try {
    const canonical = realpathSync(path);
    const entry = lstatSync(canonical);
    if (!isAbsolute(path) || canonical !== path || !entry.isFile() || entry.isSymbolicLink()) {
      stop(code);
    }
    const bytes = readFileSync(canonical);
    if (bytes.length === 0 || bytes.length > 512 * 1024) stop(code);
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof HostCommandError) throw error;
    stop(code);
  }
}

function assertRoot() {
  if (fixtureRuntime === undefined && process.geteuid?.() !== 0) {
    stop('P2_HOST_ROOT_REQUIRED');
  }
}

function assertInitialHostMountNamespace() {
  if (fixtureRuntime !== undefined) {
    if (process.env.SEORILABS_HOST_FIXTURE_SCENARIO === 'alternate-mount-namespace') {
      stop('P2_HOST_MOUNT_NAMESPACE_MISMATCH');
    }
    return Object.freeze({ device: 'fixture-nsfs', inode: '1' });
  }
  if (process.platform !== 'linux') stop('P2_HOST_LINUX_REQUIRED');
  try {
    const initial = statSync('/proc/1/ns/mnt', { bigint: true });
    const current = statSync('/proc/self/ns/mnt', { bigint: true });
    if (initial.dev !== current.dev || initial.ino !== current.ino) {
      stop('P2_HOST_MOUNT_NAMESPACE_MISMATCH');
    }
    return Object.freeze({ device: String(current.dev), inode: String(current.ino) });
  } catch (error) {
    if (error instanceof HostCommandError) throw error;
    stop('P2_HOST_MOUNT_NAMESPACE_READBACK_FAILED');
  }
}

function exists(path) {
  const result = run('/usr/bin/test', ['-e', path], 'P2_HOST_EXISTENCE_READBACK_FAILED', {
    allowedStatuses: [1],
  });
  return result.status === 0;
}

function directoryEmpty(path) {
  if (!exists(path)) return true;
  return read(
    '/usr/bin/find',
    [path, '-mindepth', '1', '-maxdepth', '1', '-print', '-quit'],
    'P2_HOST_STATE_DIRECTORY_READBACK_FAILED',
  ) === '';
}

function localLstat(path, code) {
  try {
    return lstatSync(mappedPath(path));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    stop(code);
  }
}

function assertCanonicalExistingComponents(path, code) {
  const segments = path.split('/').filter(Boolean);
  let current = '/';
  for (const segment of segments) {
    current = current === '/' ? `/${segment}` : `${current}/${segment}`;
    const entry = localLstat(current, code);
    if (entry === null) return;
    const local = mappedPath(current);
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(local) !== local) stop(code);
    } catch (error) {
      if (error instanceof HostCommandError) throw error;
      stop(code);
    }
  }
}

function publicPathIdentity(path, entry, type) {
  return Object.freeze({
    path,
    type,
    device: String(entry.dev),
    inode: String(entry.ino),
    ownerId: entry.uid,
    groupId: entry.gid,
    mode: (entry.mode & 0o7777).toString(8).padStart(4, '0'),
    ...(type === 'file' ? { sizeBytes: entry.size } : {}),
  });
}

function readDirectoryIdentity(path) {
  assertCanonicalExistingComponents(path, 'P2_HOST_PATH_BOUNDARY_INVALID');
  const entry = localLstat(path, 'P2_HOST_PATH_BOUNDARY_INVALID');
  const local = mappedPath(path);
  try {
    if (
      entry === null || !entry.isDirectory() || entry.isSymbolicLink() ||
      realpathSync(local) !== local
    ) stop('P2_HOST_PATH_BOUNDARY_INVALID');
  } catch (error) {
    if (error instanceof HostCommandError) throw error;
    stop('P2_HOST_PATH_BOUNDARY_INVALID');
  }
  return publicPathIdentity(path, entry, 'directory');
}

function readRegularFileIdentity(path, code = 'P2_HOST_FILE_IDENTITY_INVALID') {
  const entry = localLstat(path, code);
  const local = mappedPath(path);
  try {
    if (
      entry === null || !entry.isFile() || entry.isSymbolicLink() ||
      realpathSync(local) !== local
    ) stop(code);
  } catch (error) {
    if (error instanceof HostCommandError) throw error;
    stop(code);
  }
  return publicPathIdentity(path, entry, 'file');
}

function samePathIdentity(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function assertPathIdentity(expected, code = 'P2_HOST_PATH_IDENTITY_DRIFT') {
  const actual = expected.type === 'directory'
    ? readDirectoryIdentity(expected.path)
    : readRegularFileIdentity(expected.path, code);
  if (!samePathIdentity(actual, expected)) stop(code);
  return actual;
}

function assertMissingLeaf(path, code = 'P2_HOST_PATH_MUST_BE_MISSING') {
  assertCanonicalExistingComponents(dirname(path), 'P2_HOST_PATH_BOUNDARY_INVALID');
  if (localLstat(path, code) !== null) stop(code);
}

function managedDirectorySpecs() {
  return [
    { path: dirname(contract.target.sourcePath), ownerId: 0, groupId: 0, mode: '0700' },
    { path: dirname(contract.target.rollbackSourcePath), ownerId: 0, groupId: 0, mode: '0700' },
    {
      path: contract.target.mountPath,
      ownerId: 0,
      groupId: contract.target.markerGroupId,
      mode: '0750',
    },
    { path: contract.target.backupRoot, ownerId: 0, groupId: 0, mode: '0700' },
  ];
}

function ensureManagedDirectories() {
  return managedDirectorySpecs().map((expected) => {
    assertCanonicalExistingComponents(expected.path, 'P2_HOST_PATH_BOUNDARY_INVALID');
    const existing = localLstat(expected.path, 'P2_HOST_PATH_BOUNDARY_INVALID');
    if (existing !== null && (!existing.isDirectory() || existing.isSymbolicLink())) {
      stop('P2_HOST_PATH_BOUNDARY_INVALID');
    }
    mutate('/usr/bin/install', [
      '--directory', `--owner=${expected.ownerId}`, `--group=${expected.groupId}`,
      `--mode=${expected.mode}`, expected.path,
    ]);
    const identity = readDirectoryIdentity(expected.path);
    if (
      fixtureRuntime === undefined &&
      (identity.ownerId !== expected.ownerId || identity.groupId !== expected.groupId ||
        identity.mode !== expected.mode)
    ) stop('P2_HOST_PATH_METADATA_DRIFT');
    return identity;
  });
}

function assertManagedPathIdentities(preBackupAttestation, { mounted = false } = {}) {
  for (const identity of preBackupAttestation.pathIdentities) {
    if (mounted && identity.path === contract.target.mountPath) continue;
    assertPathIdentity(identity);
  }
}

function readHostIdentity(expected) {
  const hostname = read('/usr/bin/hostname', ['--short'], 'P2_HOST_IDENTITY_READBACK_FAILED');
  const addresses = publicJson(
    read('/usr/bin/ip', ['-json', 'address', 'show', 'scope', 'global'], 'P2_HOST_IDENTITY_READBACK_FAILED'),
    'P2_HOST_IDENTITY_READBACK_INVALID',
  ).flatMap(({ addr_info: entries = [] }) => entries)
    .filter(({ family, scope }) => family === 'inet' && scope === 'global')
    .map(({ local }) => local);
  if (hostname !== expected.expectedHostname || !addresses.includes(expected.ipv4)) {
    stop('P2_HOST_IDENTITY_MISMATCH');
  }
  return { hostname, ipv4: expected.ipv4 };
}

function fileBytes(path) {
  try {
    return existsSync(mappedPath(path)) ? readFileSync(mappedPath(path)) : Buffer.alloc(0);
  } catch {
    stop('P2_HOST_CONFIGURATION_READBACK_FAILED');
  }
}

function readConfigurationMetadata(path) {
  const entry = localLstat(path, 'P2_HOST_CONFIGURATION_METADATA_READBACK_FAILED');
  if (entry === null) return null;
  const local = mappedPath(path);
  try {
    if (!entry.isFile() || entry.isSymbolicLink() || realpathSync(local) !== local) {
      stop('P2_HOST_CONFIGURATION_PATH_INVALID');
    }
  } catch (error) {
    if (error instanceof HostCommandError) throw error;
    stop('P2_HOST_CONFIGURATION_PATH_INVALID');
  }
  return Object.freeze({
    ownerId: entry.uid,
    groupId: entry.gid,
    mode: (entry.mode & 0o7777).toString(8).padStart(4, '0'),
  });
}

function configurationMetadataMatches(path, expected) {
  return canonicalJson(readConfigurationMetadata(path)) === canonicalJson(expected);
}

function normalizedLines(bytes) {
  return bytes.toString('utf8').split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

function lineCount(path, expected) {
  return normalizedLines(fileBytes(path)).filter((line) => line === expected).length;
}

function conflictingManagedLine(path, expected, identityIndexes) {
  const expectedFields = expected.split(/\s+/u);
  return normalizedLines(fileBytes(path)).some((line) => {
    const fields = line.split(/\s+/u);
    return line !== expected && identityIndexes.some((index) => fields[index] === expectedFields[index]);
  });
}

function sourceAllocation() {
  const raw = read(
    '/usr/bin/stat',
    ['--format=%s:%b:%B', contract.target.sourcePath],
    'P2_HOST_SOURCE_READBACK_FAILED',
  );
  const match = /^(\d+):(\d+):(\d+)$/u.exec(raw);
  if (match === null) stop('P2_HOST_SOURCE_READBACK_INVALID');
  return validateAllocatedFile({
    sizeBytes: Number(match[1]),
    allocatedBytes: Number(match[2]) * Number(match[3]),
    contract,
  });
}

function readLuksUuid(path = contract.target.sourcePath) {
  const uuid = read(
    '/usr/sbin/cryptsetup',
    ['luksUUID', path],
    'P2_HOST_LUKS_READBACK_FAILED',
  );
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(uuid)) {
    stop('P2_HOST_LUKS_READBACK_INVALID');
  }
  return uuid;
}

function readMount() {
  const result = run(
    '/usr/bin/findmnt',
    ['--json', '--mountpoint', contract.target.mountPath, '--output', 'SOURCE,FSTYPE,TARGET'],
    'P2_HOST_MOUNT_READBACK_FAILED',
    { allowedStatuses: [1] },
  );
  if (result.status === 1) return null;
  const filesystems = publicJson(result.stdout, 'P2_HOST_MOUNT_READBACK_INVALID').filesystems;
  if (!Array.isArray(filesystems) || filesystems.length !== 1) {
    stop('P2_HOST_MOUNT_READBACK_INVALID');
  }
  const [mount] = filesystems;
  return validateMountedFilesystem({
    source: mount.source,
    filesystemType: mount.fstype,
    target: mount.target,
    contract,
  });
}

function parseClevisList(raw, expectedPolicy) {
  const bindings = raw.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (bindings.length !== 1) stop('P2_HOST_CLEVIS_BINDING_DRIFT');
  const match = /^\d+:\s+sss\s+(.+)$/u.exec(bindings[0]);
  if (match === null) stop('P2_HOST_CLEVIS_BINDING_DRIFT');
  const actual = publicJson(match[1], 'P2_HOST_CLEVIS_BINDING_DRIFT');
  if (canonicalJson(actual) !== canonicalJson(expectedPolicy)) {
    stop('P2_HOST_CLEVIS_BINDING_DRIFT');
  }
  return { pin: 'sss', policyDigest: canonicalDigest(actual) };
}

function loadTangAttestations() {
  const paths = repeatedOption('tang-attestation', contract.tang.requiredServers);
  const authorityPublicKey = readBackupAuthorityPublicKey();
  const tangAttestations = validateTangFleetAttestations(
    contract,
    paths.map((path) => readCanonicalJson(path, 'P2_TANG_SERVER_ATTESTATION_INVALID')),
    authorityPublicKey,
  );
  return { authorityPublicKey, tangAttestations };
}

function readBackupAuthorityPublicKey() {
  const path = contract.tang.backupAuthority.publicKeyPath;
  const local = mappedPath(path);
  let descriptor;
  try {
    if (!isAbsolute(path) || realpathSync(dirname(local)) !== dirname(local)) {
      stop('P2_TANG_BACKUP_TRUST_ANCHOR_INVALID');
    }
    const entry = lstatSync(local);
    if (
      !entry.isFile() || entry.isSymbolicLink() || realpathSync(local) !== local ||
      ![0o400, 0o444].includes(entry.mode & 0o777) ||
      (fixtureRuntime === undefined && (entry.uid !== 0 || entry.gid !== 0))
    ) stop('P2_TANG_BACKUP_TRUST_ANCHOR_INVALID');
    descriptor = openSync(local, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const descriptorEntry = fstatSync(descriptor);
    if (
      entry.dev !== descriptorEntry.dev || entry.ino !== descriptorEntry.ino ||
      entry.uid !== descriptorEntry.uid || entry.gid !== descriptorEntry.gid ||
      entry.mode !== descriptorEntry.mode || entry.size !== descriptorEntry.size
    ) stop('P2_TANG_BACKUP_TRUST_ANCHOR_INVALID');
    const bytes = readFileSync(descriptor);
    if (bytes.length === 0 || bytes.length > 16 * 1024) {
      stop('P2_TANG_BACKUP_TRUST_ANCHOR_INVALID');
    }
    return bytes;
  } catch (error) {
    if (error instanceof HostCommandError) throw error;
    stop('P2_TANG_BACKUP_TRUST_ANCHOR_INVALID');
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        stop('P2_TANG_BACKUP_TRUST_ANCHOR_INVALID');
      }
    }
  }
}

function optionalPublicJson(text, code) {
  if (text.trim() === '') return null;
  return publicJson(text, code);
}

function workloadResource(kind) {
  return kind === 'StatefulSet' ? 'statefulset' : kind === 'Deployment' ? 'deployment' : undefined;
}

function canonicalHostPath(path) {
  if (
    typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 ||
    normalize(path) !== path || path.includes('\0')
  ) stop('P2_HOST_CONSUMER_READBACK_INVALID');
  return path;
}

function pathsOverlap(left, right) {
  const canonicalLeft = canonicalHostPath(left);
  const canonicalRight = canonicalHostPath(right);
  const within = (child, parent) => parent === '/' || child === parent ||
    child.startsWith(`${parent}/`);
  return within(canonicalLeft, canonicalRight) || within(canonicalRight, canonicalLeft);
}

function readConsumerQuiescence(prefix, inputDescriptors) {
  const gate = contract.kubernetes.consumerGate;
  for (const expected of gate.workloads) {
    const resource = workloadResource(expected.kind);
    if (resource === undefined) stop('P2_HOST_CONSUMER_GATE_CONTRACT_INVALID');
    const observed = optionalPublicJson(read(kubectl, [
      ...prefix,
      '--context', contract.kubernetes.context,
      'get', resource, expected.name,
      '--namespace', contract.kubernetes.namespace,
      '--output=json', '--ignore-not-found=true',
    ], 'P2_HOST_CONSUMER_READBACK_FAILED', { inputDescriptors }),
    'P2_HOST_CONSUMER_READBACK_INVALID');
    if (observed === null) continue;
    if (
      observed.kind !== expected.kind || observed.metadata?.name !== expected.name ||
      observed.metadata?.namespace !== contract.kubernetes.namespace ||
      observed.spec?.replicas !== gate.requiredReplicas ||
      ['replicas', 'readyReplicas', 'currentReplicas', 'availableReplicas', 'updatedReplicas']
        .some((field) => ![undefined, 0].includes(observed.status?.[field]))
    ) stop('P2_HOST_LIVE_REPLICAS_NOT_ZERO');
  }
  const pods = publicJson(read(kubectl, [
    ...prefix,
    '--context', contract.kubernetes.context,
    'get', 'pods', '--all-namespaces', '--output=json',
  ], 'P2_HOST_CONSUMER_READBACK_FAILED', { inputDescriptors }),
  'P2_HOST_CONSUMER_READBACK_INVALID');
  if (!Array.isArray(pods?.items)) stop('P2_HOST_CONSUMER_READBACK_INVALID');
  const managedNames = new Set(gate.workloads.map(({ name }) => name));
  const protectedPaths = [
    contract.target.mountPath,
    contract.target.sourcePath,
    dirname(contract.target.sourcePath),
    contract.target.mapperPath,
  ];
  for (const pod of pods.items) {
    if (['Succeeded', 'Failed'].includes(pod.status?.phase)) continue;
    const podName = pod.metadata?.labels?.['app.kubernetes.io/name'];
    const volumes = Array.isArray(pod.spec?.volumes) ? pod.spec.volumes : [];
    const consumesPvc = pod.metadata?.namespace === contract.kubernetes.namespace &&
      volumes.some(({ persistentVolumeClaim }) =>
        persistentVolumeClaim?.claimName === contract.kubernetes.persistentVolumeClaim);
    const consumesHostPath = volumes.some(({ hostPath }) =>
      hostPath?.path !== undefined && protectedPaths.some((protectedPath) =>
        pathsOverlap(hostPath.path, protectedPath)));
    if (managedNames.has(podName) || consumesPvc || consumesHostPath) {
      stop('P2_HOST_LIVE_CONSUMER_PRESENT');
    }
  }
  return { workloadsAtZero: true, liveConsumers: 0 };
}

function readStateVolume(kubeconfigPath) {
  let boundary;
  try {
    boundary = openHostKubectlReadbackBoundary(kubeconfigPath);
    const prefix = [
      ...kubectlPrefix,
      `--kubeconfig=${boundary.kubeconfig}`,
      `--cache-dir=${boundary.cacheDirectory}`,
    ];
    const currentContext = read(
      kubectl,
      [...prefix, 'config', 'current-context'],
      'P2_HOST_KUBERNETES_READBACK_FAILED',
      { inputDescriptors: boundary.inputDescriptors },
    );
    if (currentContext !== contract.kubernetes.context) {
      stop('P2_HOST_KUBERNETES_CONTEXT_MISMATCH');
    }
    readConsumerQuiescence(prefix, boundary.inputDescriptors);
    const observedPv = publicJson(read(kubectl, [
      ...prefix,
      '--context', contract.kubernetes.context,
      'get', 'persistentvolume', contract.kubernetes.persistentVolume,
      '--output=json',
    ], 'P2_HOST_KUBERNETES_READBACK_FAILED', {
      inputDescriptors: boundary.inputDescriptors,
    }), 'P2_HOST_KUBERNETES_READBACK_INVALID');
    const observedPvc = publicJson(read(kubectl, [
      ...prefix,
      '--context', contract.kubernetes.context,
      'get', 'persistentvolumeclaim', contract.kubernetes.persistentVolumeClaim,
      '--namespace', contract.kubernetes.namespace,
      '--output=json',
    ], 'P2_HOST_KUBERNETES_READBACK_FAILED', {
      inputDescriptors: boundary.inputDescriptors,
    }), 'P2_HOST_KUBERNETES_READBACK_INVALID');
    return verifyRetainVolumeReadback({ state, observedPv, observedPvc }).attestation;
  } catch (error) {
    if (
      error instanceof HostCommandError || error instanceof StateEnvelopeError ||
      error instanceof KubectlReadbackBoundaryError
    ) throw error;
    stop('P2_HOST_KUBERNETES_READBACK_FAILED');
  } finally {
    try {
      boundary?.close();
    } catch {
      stop('P2_HOST_KUBERNETES_BOUNDARY_INVALID');
    }
  }
}

function readMarker(stateVolumeAttestation, luksUuid) {
  let marker;
  try {
    marker = JSON.parse(readFileSync(mappedPath(contract.target.markerPath), 'utf8'));
  } catch {
    stop('P2_HOST_MARKER_READBACK_INVALID');
  }
  const metadata = read(
    '/usr/bin/stat',
    ['--format=%u:%g:%a', contract.target.markerPath],
    'P2_HOST_MARKER_READBACK_FAILED',
  );
  if (metadata !== `0:${contract.target.markerGroupId}:${contract.target.markerMode.slice(1)}`) {
    stop('P2_HOST_MARKER_METADATA_DRIFT');
  }
  const validated = validateHostEncryptedMountAttestation({
    state,
    stateVolumeAttestation,
    attestation: marker,
  });
  if (validated.luksUuid !== luksUuid) stop('P2_HOST_MARKER_LUKS_UUID_DRIFT');
  return validated;
}

function readBootId() {
  const bootId = read('/usr/bin/cat', ['/proc/sys/kernel/random/boot_id'], 'P2_HOST_BOOT_ID_READ_FAILED');
  if (!/^[a-f0-9-]{36}$/u.test(bootId)) stop('P2_HOST_BOOT_ID_INVALID');
  return bootId;
}

function classifyReadback() {
  const source = exists(contract.target.sourcePath);
  const mapper = exists(contract.target.mapperPath);
  const mount = readMount();
  const marker = exists(contract.target.markerPath);
  const crypttab = lineCount(systemdConfiguration.crypttabPath, systemdConfiguration.crypttabLine);
  const fstab = lineCount(systemdConfiguration.fstabPath, systemdConfiguration.fstabLine);
  const targetEmpty = directoryEmpty(contract.target.mountPath);
  if (!source && !mapper && mount === null && !marker && crypttab === 0 && fstab === 0) {
    if (!targetEmpty) stop('P2_HOST_STATE_DIRECTORY_NONEMPTY');
    return { state: 'MISSING', targetEmpty: true };
  }
  if (
    !source || !mapper || mount === null || crypttab !== 1 || fstab !== 1 ||
    (!marker && mode !== 'apply' && mode !== 'restore')
  ) stop('P2_HOST_READBACK_PARTIAL');
  return { state: marker ? 'COMPLETE' : 'PRE_MARKER', targetEmpty: false };
}

function uniqueStatusField(text, name) {
  const matches = [...text.matchAll(new RegExp(`^\\s*${name}:\\s*(\\S(?:.*\\S)?)\\s*$`, 'gmu'))];
  if (matches.length !== 1) stop('P2_HOST_MAPPER_BACKING_READBACK_INVALID');
  return matches[0][1];
}

function readMapperBacking(luksUuid, sourceIdentity) {
  let descriptor;
  try {
    assertPathIdentity(sourceIdentity, 'P2_HOST_SOURCE_IDENTITY_DRIFT');
    descriptor = openSync(
      mappedPath(contract.target.sourcePath),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const heldIdentity = publicPathIdentity(
      contract.target.sourcePath,
      fstatSync(descriptor),
      'file',
    );
    if (!samePathIdentity(heldIdentity, sourceIdentity)) stop('P2_HOST_SOURCE_IDENTITY_DRIFT');
    const status = run(
      '/usr/sbin/cryptsetup',
      ['status', contract.target.mapperName],
      'P2_HOST_MAPPER_BACKING_READBACK_FAILED',
    ).stdout;
    const type = uniqueStatusField(status, 'type');
    const backingDevice = uniqueStatusField(status, 'device');
    const sourcePath = uniqueStatusField(status, 'loop');
    if (
      type !== contract.target.luksType || sourcePath !== contract.target.sourcePath ||
      !/^\/dev\/loop(?:0|[1-9][0-9]*)$/u.test(backingDevice)
    ) stop('P2_HOST_MAPPER_BACKING_DRIFT');
    if (fixtureRuntime === undefined) {
      const backingEntry = lstatSync(backingDevice);
      if (
        !backingEntry.isBlockDevice() || backingEntry.isSymbolicLink() ||
        realpathSync(backingDevice) !== backingDevice
      ) stop('P2_HOST_MAPPER_BACKING_DRIFT');
    }

    const dmFields = read(
      '/usr/sbin/dmsetup',
      [
        'info', '--noheadings', '--columns', '--separator=|',
        '--options=name,uuid,major,minor', contract.target.mapperPath,
      ],
      'P2_HOST_MAPPER_BACKING_READBACK_FAILED',
    ).split('|').map((value) => value.trim());
    if (dmFields.length !== 4) stop('P2_HOST_MAPPER_BACKING_READBACK_INVALID');
    const [mapperName, dmUuid, dmMajor, dmMinor] = dmFields;

    const loop = publicJson(read(
      '/usr/sbin/losetup',
      ['--json', '--output', 'NAME,BACK-FILE,MAJ:MIN', backingDevice],
      'P2_HOST_MAPPER_BACKING_READBACK_FAILED',
    ), 'P2_HOST_MAPPER_BACKING_READBACK_INVALID');
    if (!Array.isArray(loop?.loopdevices) || loop.loopdevices.length !== 1) {
      stop('P2_HOST_MAPPER_BACKING_READBACK_INVALID');
    }
    const [loopDevice] = loop.loopdevices;
    if (
      Object.keys(loopDevice).toSorted().join('\0') !== ['back-file', 'maj:min', 'name'].join('\0') ||
      loopDevice.name !== backingDevice || loopDevice['back-file'] !== sourcePath
    ) stop('P2_HOST_MAPPER_BACKING_DRIFT');

    const observed = {
      mapperName,
      mapperPath: contract.target.mapperPath,
      dmUuid,
      dmDeviceId: `${dmMajor}:${dmMinor}`,
      backingDevice,
      backingDeviceId: loopDevice['maj:min'],
      sourcePath,
      sourceIdentityDigest: canonicalDigest(sourceIdentity),
    };
    assertPathIdentity(sourceIdentity, 'P2_HOST_SOURCE_IDENTITY_DRIFT');
    if (!samePathIdentity(
      publicPathIdentity(contract.target.sourcePath, fstatSync(descriptor), 'file'),
      sourceIdentity,
    )) stop('P2_HOST_SOURCE_IDENTITY_DRIFT');
    return validateMapperBackingAttestation({
      contract,
      luksUuid,
      sourceIdentity,
      mapperBacking: observed,
    });
  } catch (error) {
    if (error instanceof HostCommandError) throw error;
    stop('P2_HOST_MAPPER_BACKING_READBACK_FAILED');
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        stop('P2_HOST_MAPPER_BACKING_READBACK_FAILED');
      }
    }
  }
}

function fullReadback({
  kubeconfigPath,
  tangAttestations,
  authorityPublicKey,
  markerRequired = true,
}) {
  const identity = readHostIdentity(contract.target);
  const classification = classifyReadback();
  if (classification.state === 'MISSING') {
    return {
      schemaVersion: 1,
      state: 'HOST_ENCRYPTED_MOUNT_MISSING',
      nodeName: contract.target.nodeName,
      contractDigest: contractDigest(contract),
      targetEmpty: true,
    };
  }
  readRequiredPackages();
  if (markerRequired && classification.state !== 'COMPLETE') stop('P2_HOST_MARKER_MISSING');
  sourceAllocation();
  const sourceIdentity = readRegularFileIdentity(contract.target.sourcePath);
  run(
    '/usr/sbin/cryptsetup',
    ['isLuks', '--type', 'luks2', contract.target.sourcePath],
    'P2_HOST_LUKS_READBACK_FAILED',
  );
  const luksUuid = readLuksUuid();
  const mapperBacking = readMapperBacking(luksUuid, sourceIdentity);
  const filesystemType = read(
    '/usr/sbin/blkid',
    ['--output', 'value', '--match-tag', 'TYPE', contract.target.mapperPath],
    'P2_HOST_FILESYSTEM_READBACK_FAILED',
  );
  if (filesystemType !== contract.target.filesystemType) stop('P2_HOST_FILESYSTEM_DRIFT');
  const mount = readMount();
  const clevis = parseClevisList(
    read('/usr/bin/clevis', ['luks', 'list', '-d', contract.target.sourcePath], 'P2_HOST_CLEVIS_READBACK_FAILED'),
    buildClevisPolicy(contract, tangAttestations, authorityPublicKey),
  );
  const unlockerState = readUnlockerState();
  if (
    !unlockerState.enabled || !unlockerState.active ||
    read('/usr/bin/systemctl', ['is-active', systemdConfiguration.mountUnit], 'P2_HOST_SYSTEMD_READBACK_FAILED') !== 'active'
  ) stop('P2_HOST_SYSTEMD_PERSISTENCE_DRIFT');
  const stateVolumeAttestation = readStateVolume(kubeconfigPath);
  const hostEncryption = markerRequired ? readMarker(stateVolumeAttestation, luksUuid) : undefined;
  return {
    schemaVersion: 1,
    state: markerRequired ? 'HOST_ENCRYPTED_MOUNT_VERIFIED' : 'HOST_ENCRYPTED_MOUNT_PRE_MARKER_VERIFIED',
    nodeName: contract.target.nodeName,
    contractDigest: contractDigest(contract),
    identity,
    luksUuid,
    sourceIdentity,
    mapperBacking,
    mount,
    clevis,
    stateVolumeAttestation,
    ...(hostEncryption === undefined ? {} : { hostEncryption }),
  };
}

function recoveryKeyIdentity(entry) {
  return {
    device: String(entry.dev),
    inode: String(entry.ino),
    ownerId: entry.uid,
    groupId: entry.gid,
    mode: entry.mode & 0o777,
    size: entry.size,
  };
}

function sameRecoveryKeyIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode &&
    left.ownerId === right.ownerId && left.groupId === right.groupId &&
    left.mode === right.mode && left.size === right.size;
}

function assertRecoveryKeyIdentity(recoveryKey) {
  try {
    const pathEntry = lstatSync(recoveryKey.path);
    const descriptorEntry = fstatSync(recoveryKey.descriptor);
    if (
      !pathEntry.isFile() || pathEntry.isSymbolicLink() ||
      realpathSync(recoveryKey.path) !== recoveryKey.path ||
      !sameRecoveryKeyIdentity(recoveryKey.identity, recoveryKeyIdentity(pathEntry)) ||
      !sameRecoveryKeyIdentity(recoveryKey.identity, recoveryKeyIdentity(descriptorEntry))
    ) stop('P2_HOST_RECOVERY_KEY_FILE_CHANGED');
  } catch (error) {
    if (error instanceof HostCommandError) throw error;
    stop('P2_HOST_RECOVERY_KEY_FILE_CHANGED');
  }
}

function openRecoveryKey(path) {
  let descriptor;
  try {
    if (!isAbsolute(path) || realpathSync(dirname(path)) !== dirname(path)) {
      stop('P2_HOST_RECOVERY_KEY_FILE_INVALID');
    }
    const pathEntry = lstatSync(path);
    if (
      !pathEntry.isFile() || pathEntry.isSymbolicLink() || realpathSync(path) !== path ||
      pathEntry.size < 32 || pathEntry.size > 4096 ||
      ![0o400, 0o600].includes(pathEntry.mode & 0o777) ||
      (fixtureRuntime === undefined && pathEntry.uid !== 0)
    ) stop('P2_HOST_RECOVERY_KEY_FILE_INVALID');
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const descriptorEntry = fstatSync(descriptor);
    const identity = recoveryKeyIdentity(pathEntry);
    if (!sameRecoveryKeyIdentity(identity, recoveryKeyIdentity(descriptorEntry))) {
      stop('P2_HOST_RECOVERY_KEY_FILE_CHANGED');
    }
    const recoveryKey = Object.freeze({ path, descriptor, identity: Object.freeze(identity) });
    openRecoveryKeys.add(recoveryKey);
    return recoveryKey;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The stable public failure below is sufficient; no secret material is surfaced.
      }
    }
    if (error instanceof HostCommandError) throw error;
    stop('P2_HOST_RECOVERY_KEY_FILE_INVALID');
  }
}

function closeRecoveryKey(recoveryKey) {
  if (!openRecoveryKeys.delete(recoveryKey)) return;
  try {
    closeSync(recoveryKey.descriptor);
  } catch {
    stop('P2_HOST_RECOVERY_KEY_CLOSE_FAILED');
  }
}

function readRequiredPackages({ installMissing = false } = {}) {
  const observed = contract.target.requiredPackages.map((packageName) => {
    const result = run(
      '/usr/bin/dpkg-query',
      ['--show', '--showformat=${Status}\t${Version}', packageName],
      'P2_HOST_PACKAGE_READBACK_FAILED',
      { allowedStatuses: [1] },
    );
    if (result.status === 1) return { packageName, version: null };
    const match = /^install ok installed\t([^\s]+)$/u.exec(result.stdout.trim());
    if (match === null) stop('P2_HOST_PACKAGE_READBACK_INVALID');
    return { packageName, version: match[1] };
  });
  const missing = observed.filter(({ version }) => version === null).map(({ packageName }) => packageName);
  if (missing.length > 0 && !installMissing) stop('P2_HOST_REQUIRED_PACKAGE_MISSING');
  if (missing.length > 0) {
    mutate('/usr/bin/apt-get', ['update']);
    mutate('/usr/bin/apt-get', ['install', '--yes', ...missing]);
    return readRequiredPackages();
  }
  return observed;
}

function backupPaths() {
  const root = mappedPath(contract.target.backupRoot);
  return {
    root,
    manifest: join(root, 'pre-provision.json'),
    crypttab: join(root, 'crypttab.before'),
    fstab: join(root, 'fstab.before'),
    header: mappedPath(`${contract.target.backupRoot}/luks-header.bin`),
    provision: join(root, 'provision.json'),
    restoredProvision: join(root, 'provision.restored.json'),
    reboot: join(root, 'reboot.json'),
    restoredReboot: join(root, 'reboot.restored.json'),
    rollback: join(root, 'rollback.json'),
  };
}

const managedRecordIdentifiers = new Set([
  'crypttab-before',
  'fstab-before',
  'pre-provision',
  'crypttab-managed',
  'fstab-managed',
  'marker',
  'provision',
  'reboot',
  'rollback',
  'provision-restored',
  'reboot-restored',
]);

function publishManagedRecord(identifier, bytes) {
  if (!managedRecordIdentifiers.has(identifier)) stop('P2_HOST_RECORD_IDENTIFIER_INVALID');
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (content.length > 512 * 1024) stop('P2_HOST_RECORD_INPUT_TOO_LARGE');
  const receipt = mutateFilesystemBoundary('publish-record', [identifier], [], content);
  if (
    receipt.record !== identifier || receipt.sizeBytes !== content.length ||
    Object.keys(receipt).toSorted().join('\0') !==
      ['operation', 'record', 'sizeBytes'].toSorted().join('\0')
  ) stop('P2_HOST_FILESYSTEM_BOUNDARY_RECEIPT_INVALID');
  return receipt;
}

function assertPristine({ allowRollbackSource = false } = {}) {
  readHostIdentity(contract.target);
  const classification = classifyReadback();
  if (classification.state !== 'MISSING' || !classification.targetEmpty) {
    stop('P2_HOST_PRE_PROVISION_STATE_INVALID');
  }
  if (
    conflictingManagedLine(systemdConfiguration.crypttabPath, systemdConfiguration.crypttabLine, [0, 1]) ||
    conflictingManagedLine(systemdConfiguration.fstabPath, systemdConfiguration.fstabLine, [0, 1])
  ) stop('P2_HOST_SYSTEMD_CONFIGURATION_CONFLICT');
  assertMissingLeaf(contract.target.sourcePath, 'P2_HOST_SOURCE_PATH_NOT_MISSING');
  if (!allowRollbackSource) {
    assertMissingLeaf(contract.target.rollbackSourcePath, 'P2_HOST_ROLLBACK_PATH_NOT_MISSING');
  }
  assertMissingLeaf(contract.target.markerPath, 'P2_HOST_PLAINTEXT_MARKER_PRESENT');
}

function readUnlockerState() {
  const enabledResult = run(
    '/usr/bin/systemctl',
    ['is-enabled', systemdConfiguration.unlockerUnit],
    'P2_HOST_SYSTEMD_READBACK_FAILED',
    { allowedStatuses: [1] },
  );
  const enabledOutput = enabledResult.stdout.trim();
  let enabled;
  if (enabledResult.status === 0 && enabledOutput === 'enabled') enabled = true;
  else if (enabledResult.status === 1 && enabledOutput === 'disabled') enabled = false;
  else stop('P2_HOST_SYSTEMD_ENABLED_STATE_INVALID');

  const activeResult = run(
    '/usr/bin/systemctl',
    ['is-active', systemdConfiguration.unlockerUnit],
    'P2_HOST_SYSTEMD_READBACK_FAILED',
    { allowedStatuses: [3] },
  );
  const activeOutput = activeResult.stdout.trim();
  let active;
  if (activeResult.status === 0 && activeOutput === 'active') active = true;
  else if (activeResult.status === 3 && activeOutput === 'inactive') active = false;
  else stop('P2_HOST_SYSTEMD_ACTIVE_STATE_INVALID');
  return Object.freeze({ enabled, active });
}

function backup() {
  assertAllowedOptions(['confirmation', 'kubeconfig']);
  assertRoot();
  if (option('confirmation') !== confirmationSet.backup) stop('P2_HOST_BACKUP_CONFIRMATION_REQUIRED');
  assertPristine();
  readStateVolume(option('kubeconfig'));
  const unlockerState = readUnlockerState();
  const pathIdentities = ensureManagedDirectories();
  const paths = backupPaths();
  if (
    existsSync(paths.manifest) || existsSync(paths.provision) ||
    existsSync(paths.restoredProvision) || existsSync(paths.restoredReboot) ||
    existsSync(paths.header)
  ) {
    stop('P2_HOST_BACKUP_ALREADY_EXISTS');
  }
  const sources = [
    [systemdConfiguration.crypttabPath, paths.crypttab, 'crypttab-before'],
    [systemdConfiguration.fstabPath, paths.fstab, 'fstab-before'],
  ];
  const configuration = sources.map(([source, destination, recordIdentifier]) => {
    const existed = existsSync(mappedPath(source));
    const metadata = readConfigurationMetadata(source);
    if (existed !== (metadata !== null)) stop('P2_HOST_CONFIGURATION_PATH_INVALID');
    const bytes = fileBytes(source);
    publishManagedRecord(recordIdentifier, bytes);
    const restored = readFileSync(destination);
    if (!restored.equals(bytes)) stop('P2_HOST_PRE_BACKUP_RESTORE_REHEARSAL_FAILED');
    return { path: source, existed, sha256: sha256(bytes), metadata };
  });
  const attestation = buildPreProvisionBackupAttestation({
    contract,
    configuration,
    pathIdentities,
    unlockerState,
  });
  publishManagedRecord('pre-provision', `${canonicalJson(attestation)}\n`);
  validatePreProvisionBackupAttestation(contract, readCanonicalJson(paths.manifest, 'P2_HOST_PRE_BACKUP_INVALID'));
  return attestation;
}

function backupState() {
  assertAllowedOptions(['kubeconfig']);
  assertRoot();
  assertPristine();
  readStateVolume(option('kubeconfig'));
  const paths = backupPaths();
  const required = [paths.manifest, paths.crypttab, paths.fstab];
  const forbidden = [
    paths.header, paths.provision, paths.restoredProvision, paths.reboot,
    paths.restoredReboot, paths.rollback,
  ];
  const requiredPresent = required.filter((path) => existsSync(path)).length;
  const forbiddenPresent = forbidden.some((path) => existsSync(path));
  if (requiredPresent === 0 && !forbiddenPresent) {
    return {
      schemaVersion: 1,
      state: 'HOST_PRE_BACKUP_MISSING',
      nodeName: contract.target.nodeName,
      contractDigest: contractDigest(contract),
      targetEmpty: true,
    };
  }
  if (requiredPresent !== required.length || forbiddenPresent) {
    stop('P2_HOST_PRE_BACKUP_PARTIAL_OR_DRIFT');
  }
  return loadPreBackup();
}

function loadPreBackup({ currentMustMatch = true, mounted = false } = {}) {
  const paths = backupPaths();
  const attestation = validatePreProvisionBackupAttestation(
    contract,
    readCanonicalJson(paths.manifest, 'P2_HOST_PRE_BACKUP_INVALID'),
  );
  for (const entry of attestation.configuration) {
    const destination = entry.path === systemdConfiguration.crypttabPath ? paths.crypttab : paths.fstab;
    if (sha256(readFileSync(destination)) !== entry.sha256) stop('P2_HOST_PRE_BACKUP_DRIFT');
    if (currentMustMatch && sha256(fileBytes(entry.path)) !== entry.sha256) {
      stop('P2_HOST_CONFIGURATION_CHANGED_AFTER_BACKUP');
    }
    if (currentMustMatch && !configurationMetadataMatches(entry.path, entry.metadata)) {
      stop('P2_HOST_CONFIGURATION_METADATA_CHANGED_AFTER_BACKUP');
    }
  }
  if (
    currentMustMatch &&
    canonicalJson(readUnlockerState()) !== canonicalJson(attestation.unlockerState)
  ) {
    stop('P2_HOST_UNLOCKER_STATE_CHANGED_AFTER_BACKUP');
  }
  assertManagedPathIdentities(attestation, { mounted });
  return attestation;
}

function managedConfigurationBytes(bytes, line) {
  const text = bytes.toString('utf8');
  const prefix = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
  return Buffer.from(`${prefix}${line}\n`, 'utf8');
}

function installManagedConfigurations(preBackupAttestation) {
  const paths = backupPaths();
  for (const entry of preBackupAttestation.configuration) {
    const originalPath = entry.path === systemdConfiguration.crypttabPath
      ? paths.crypttab
      : paths.fstab;
    const line = entry.path === systemdConfiguration.crypttabPath
      ? systemdConfiguration.crypttabLine
      : systemdConfiguration.fstabLine;
    const original = readFileSync(originalPath);
    if (sha256(original) !== entry.sha256) stop('P2_HOST_PRE_BACKUP_DRIFT');
    const managedPath = `${originalPath}.managed`;
    publishManagedRecord(
      entry.path === systemdConfiguration.crypttabPath ? 'crypttab-managed' : 'fstab-managed',
      managedConfigurationBytes(original, line),
    );
    transitionConfiguration('apply-config', entry, originalPath, managedPath);
    if (lineCount(entry.path, line) !== 1) stop('P2_HOST_SYSTEMD_CONFIGURATION_APPLY_FAILED');
  }
}

function verifyTangAdvertisements(attestations) {
  for (const attestation of attestations) {
    const advertisement = run(
      '/usr/bin/curl',
      ['--fail', '--silent', '--show-error', '--max-time', '10', `${attestation.url}/adv`],
      'P2_TANG_ADVERTISEMENT_READBACK_FAILED',
    ).stdout;
    if (sha256(advertisement) !== attestation.advertisementSha256) {
      stop('P2_TANG_ADVERTISEMENT_DRIFT');
    }
  }
}

function headerBackupSha256() {
  const paths = backupPaths();
  const canonicalHeader = `${contract.target.backupRoot}/luks-header.bin`;
  const output = read('/usr/bin/sha256sum', [canonicalHeader], 'P2_HOST_HEADER_BACKUP_READBACK_FAILED');
  const digest = output.split(/\s+/u)[0];
  if (!/^[a-f0-9]{64}$/u.test(digest)) stop('P2_HOST_HEADER_BACKUP_READBACK_INVALID');
  if (!existsSync(paths.header) && fixtureRuntime === undefined) stop('P2_HOST_HEADER_BACKUP_READBACK_FAILED');
  return digest;
}

function rehearseHeaderRecovery(
  recoveryKey,
  sourcePath = contract.target.sourcePath,
  headerBackupIdentity,
) {
  assertPathIdentity(headerBackupIdentity, 'P2_HOST_HEADER_BACKUP_IDENTITY_DRIFT');
  run('/usr/sbin/cryptsetup', [
    'open', '--test-passphrase', '--type', 'luks2',
    '--header', `${contract.target.backupRoot}/luks-header.bin`,
    '--key-file', '/proc/self/fd/3', sourcePath,
  ], 'P2_HOST_RECOVERY_RESTORE_REHEARSAL_FAILED', { recoveryKey });
  return headerBackupSha256();
}

function configurationDigest() {
  return canonicalDigest({
    crypttab: sha256(fileBytes(systemdConfiguration.crypttabPath)),
    fstab: sha256(fileBytes(systemdConfiguration.fstabPath)),
    unlockerState: readUnlockerState(),
  });
}

function withBackupDescriptors(paths, callback) {
  const opened = [];
  try {
    for (const path of paths) {
      const entry = lstatSync(path);
      if (
        !entry.isFile() || entry.isSymbolicLink() || realpathSync(path) !== path ||
        (fixtureRuntime === undefined && (entry.uid !== 0 || (entry.mode & 0o077) !== 0))
      ) stop('P2_HOST_CONFIGURATION_BACKUP_IDENTITY_INVALID');
      const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const descriptorEntry = fstatSync(descriptor);
      if (
        descriptorEntry.dev !== entry.dev || descriptorEntry.ino !== entry.ino ||
        descriptorEntry.mode !== entry.mode || descriptorEntry.size !== entry.size
      ) stop('P2_HOST_CONFIGURATION_BACKUP_IDENTITY_CHANGED');
      opened.push({ descriptor, entry, path });
    }
    const result = callback(opened.map(({ descriptor }) => descriptor));
    for (const { descriptor, entry, path } of opened) {
      const current = lstatSync(path);
      const held = fstatSync(descriptor);
      if (
        current.dev !== entry.dev || current.ino !== entry.ino ||
        held.dev !== entry.dev || held.ino !== entry.ino ||
        current.size !== entry.size || held.size !== entry.size
      ) stop('P2_HOST_CONFIGURATION_BACKUP_IDENTITY_CHANGED');
    }
    return result;
  } catch (error) {
    if (error instanceof HostCommandError) throw error;
    stop('P2_HOST_CONFIGURATION_BACKUP_IDENTITY_INVALID');
  } finally {
    for (const { descriptor } of opened) {
      try {
        closeSync(descriptor);
      } catch {
        stop('P2_HOST_CONFIGURATION_BACKUP_CLOSE_FAILED');
      }
    }
  }
}

function transitionConfiguration(operation, entry, originalPath, managedPath) {
  const identifier = entry.path === systemdConfiguration.crypttabPath ? 'crypttab' : 'fstab';
  const metadata = entry.metadata ?? { ownerId: 0, groupId: 0, mode: '0644' };
  withBackupDescriptors([originalPath, managedPath], (descriptors) =>
    mutateFilesystemBoundary(operation, [
      identifier,
      entry.existed ? '1' : '0',
      String(metadata.ownerId),
      String(metadata.groupId),
      metadata.mode,
    ], descriptors));
}

function writeMarker(attestation) {
  if (exists(contract.target.markerPath)) stop('P2_HOST_MARKER_ALREADY_EXISTS');
  publishManagedRecord('marker', `${canonicalJson(attestation)}\n`);
}

function relocatedFileIdentity(identity, path) {
  return Object.freeze({ ...identity, path });
}

function recoverableRename({ source, destination, sourceIdentity, preBackupAttestation }) {
  const destinationParent = preBackupAttestation.pathIdentities.find(
    ({ path, type }) => path === dirname(destination) && type === 'directory',
  );
  if (destinationParent === undefined) stop('P2_HOST_RENAME_PARENT_UNATTESTED');
  assertManagedPathIdentities(preBackupAttestation);
  assertPathIdentity(sourceIdentity, 'P2_HOST_RENAME_SOURCE_DRIFT');
  assertMissingLeaf(destination, 'P2_HOST_RENAME_DESTINATION_NOT_EMPTY');
  if (sourceIdentity.device !== destinationParent.device) {
    stop('P2_HOST_RENAME_CROSS_FILESYSTEM_FORBIDDEN');
  }
  let descriptor;
  try {
    descriptor = openSync(mappedPath(source), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const descriptorIdentity = publicPathIdentity(source, fstatSync(descriptor), 'file');
    if (!samePathIdentity(descriptorIdentity, sourceIdentity)) {
      stop('P2_HOST_RENAME_SOURCE_DRIFT');
    }
    assertPathIdentity(sourceIdentity, 'P2_HOST_RENAME_SOURCE_DRIFT');
    assertPathIdentity(destinationParent, 'P2_HOST_RENAME_PARENT_DRIFT');
    assertMissingLeaf(destination, 'P2_HOST_RENAME_DESTINATION_NOT_EMPTY');
    const operation = source === contract.target.sourcePath
      ? 'rollback-source'
      : 'restore-source';
    mutateFilesystemBoundary(operation);
    assertMissingLeaf(source, 'P2_HOST_RENAME_SOURCE_STILL_PRESENT');
    const destinationIdentity = readRegularFileIdentity(
      destination,
      'P2_HOST_RENAME_DESTINATION_IDENTITY_INVALID',
    );
    const expectedDestination = relocatedFileIdentity(sourceIdentity, destination);
    if (!samePathIdentity(destinationIdentity, expectedDestination)) {
      stop('P2_HOST_RENAME_DESTINATION_IDENTITY_INVALID');
    }
    return destinationIdentity;
  } catch (error) {
    if (error instanceof HostCommandError) throw error;
    stop('P2_HOST_MUTATION_OUTCOME_UNKNOWN');
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        stop('P2_HOST_MUTATION_OUTCOME_UNKNOWN');
      }
    }
  }
}

function apply() {
  assertAllowedOptions(['confirmation', 'kubeconfig', 'recovery-key-file', 'tang-attestation']);
  assertRoot();
  if (option('confirmation') !== confirmationSet.apply) stop('P2_HOST_APPLY_CONFIRMATION_REQUIRED');
  const recoveryKey = openRecoveryKey(option('recovery-key-file'));
  const kubeconfigPath = option('kubeconfig');
  const { authorityPublicKey, tangAttestations } = loadTangAttestations();
  assertPristine();
  const preBackupAttestation = loadPreBackup();
  for (const path of [
    `${contract.target.backupRoot}/provision.json`,
    `${contract.target.backupRoot}/provision.restored.json`,
    `${contract.target.backupRoot}/reboot.json`,
    `${contract.target.backupRoot}/reboot.restored.json`,
    `${contract.target.backupRoot}/rollback.json`,
  ]) assertMissingLeaf(path, 'P2_HOST_APPLY_ARTIFACT_ALREADY_EXISTS');
  const preflightStateVolumeAttestation = readStateVolume(kubeconfigPath);
  verifyTangAdvertisements(tangAttestations);
  readRequiredPackages({ installMissing: true });
  loadPreBackup();
  const clevisPolicy = buildClevisPolicy(contract, tangAttestations, authorityPublicKey);

  mutate('/usr/bin/install', ['--directory', '--mode=0700', '/data/seori-auth']);
  assertManagedPathIdentities(preBackupAttestation);
  mutateFilesystemBoundary('create-source');
  sourceAllocation();
  const sourceIdentity = readRegularFileIdentity(contract.target.sourcePath);
  assertPathIdentity(sourceIdentity, 'P2_HOST_SOURCE_IDENTITY_DRIFT');
  mutateWithRecoveryKey('/usr/sbin/cryptsetup', [
    'luksFormat', '--batch-mode', '--type', 'luks2', '--key-file', '/proc/self/fd/3',
    contract.target.sourcePath,
  ], recoveryKey);
  assertPathIdentity(sourceIdentity, 'P2_HOST_SOURCE_IDENTITY_DRIFT');
  const luksUuid = readLuksUuid();
  mutateWithRecoveryKey('/usr/bin/clevis', [
    'luks', 'bind', '-y', '-d', contract.target.sourcePath, '-k', '/proc/self/fd/3',
    contract.tang.pin, canonicalJson(clevisPolicy),
  ], recoveryKey);
  assertPathIdentity(sourceIdentity, 'P2_HOST_SOURCE_IDENTITY_DRIFT');
  parseClevisList(
    read('/usr/bin/clevis', ['luks', 'list', '-d', contract.target.sourcePath], 'P2_HOST_CLEVIS_READBACK_FAILED'),
    clevisPolicy,
  );
  mutateWithRecoveryKey('/usr/sbin/cryptsetup', [
    'open', '--type', 'luks2', '--key-file', '/proc/self/fd/3',
    contract.target.sourcePath, contract.target.mapperName,
  ], recoveryKey);
  assertPathIdentity(sourceIdentity, 'P2_HOST_SOURCE_IDENTITY_DRIFT');
  mutate('/usr/sbin/mkfs.ext4', [
    '-F', '-L', contract.target.filesystemLabel, contract.target.mapperPath,
  ]);
  mutate('/usr/bin/install', [
    '--directory', '--owner=0', `--group=${contract.target.markerGroupId}`,
    '--mode=0750', contract.target.mountPath,
  ]);
  installManagedConfigurations(preBackupAttestation);
  mutate('/usr/bin/systemctl', ['daemon-reload']);
  mutate('/usr/bin/systemctl', ['enable', '--now', systemdConfiguration.unlockerUnit]);
  mutate('/usr/bin/mount', [contract.target.mountPath]);
  const beforeMarker = fullReadback({
    kubeconfigPath,
    tangAttestations,
    authorityPublicKey,
    markerRequired: false,
  });
  if (
    beforeMarker.luksUuid !== luksUuid ||
    !samePathIdentity(beforeMarker.sourceIdentity, sourceIdentity)
  ) stop('P2_HOST_SOURCE_IDENTITY_DRIFT');
  if (
    beforeMarker.stateVolumeAttestation.observedDigest !==
    preflightStateVolumeAttestation.observedDigest
  ) stop('P2_HOST_KUBERNETES_IDENTITY_CHANGED_DURING_APPLY');

  const canonicalHeaderPath = `${contract.target.backupRoot}/luks-header.bin`;
  assertManagedPathIdentities(preBackupAttestation);
  assertPathIdentity(sourceIdentity, 'P2_HOST_SOURCE_IDENTITY_DRIFT');
  mutateFilesystemBoundary('backup-header');
  const headerBackupIdentity = readRegularFileIdentity(canonicalHeaderPath);
  assertManagedPathIdentities(preBackupAttestation);
  if (
    fixtureRuntime === undefined &&
    (headerBackupIdentity.ownerId !== 0 || headerBackupIdentity.groupId !== 0 ||
      headerBackupIdentity.mode !== '0400')
  ) stop('P2_HOST_HEADER_BACKUP_METADATA_DRIFT');
  const headerDigest = rehearseHeaderRecovery(
    recoveryKey,
    contract.target.sourcePath,
    headerBackupIdentity,
  );
  const hostEncryption = buildHostEncryptedMountAttestation({
    state,
    stateVolumeAttestation: beforeMarker.stateVolumeAttestation,
    luksUuid,
  });
  writeMarker(hostEncryption);
  const provisioned = buildProvisionedHostAttestation({
    contract,
    state,
    stateVolumeAttestation: beforeMarker.stateVolumeAttestation,
    luksUuid,
    tangAttestations,
    authorityPublicKey,
    preBackupAttestation,
    headerBackupSha256: headerDigest,
    headerBackupIdentity,
    sourceIdentity,
    mapperBacking: beforeMarker.mapperBacking,
    bootId: readBootId(),
    configurationSha256: configurationDigest(),
  });
  publishManagedRecord('provision', `${canonicalJson(provisioned)}\n`);
  const verified = fullReadback({ kubeconfigPath, tangAttestations, authorityPublicKey });
  if (verified.hostEncryption.observedDigest !== hostEncryption.observedDigest) {
    stop('P2_HOST_MARKER_READBACK_INVALID');
  }
  return provisioned;
}

function readback() {
  assertAllowedOptions(['kubeconfig', 'tang-attestation']);
  const { authorityPublicKey, tangAttestations } = loadTangAttestations();
  return fullReadback({
    kubeconfigPath: option('kubeconfig'),
    tangAttestations,
    authorityPublicKey,
  });
}

function rebootReadback() {
  assertAllowedOptions(['kubeconfig', 'tang-attestation']);
  const { authorityPublicKey, tangAttestations } = loadTangAttestations();
  const kubeconfigPath = option('kubeconfig');
  const current = fullReadback({ kubeconfigPath, tangAttestations, authorityPublicKey });
  const preBackupAttestation = loadPreBackup({ currentMustMatch: false, mounted: true });
  const headerBackupIdentity = readRegularFileIdentity(`${contract.target.backupRoot}/luks-header.bin`);
  const paths = backupPaths();
  const currentProvisionPath = existsSync(paths.restoredProvision)
    ? paths.restoredProvision
    : paths.provision;
  const provisioned = validateProvisionedHostAttestation({
    contract,
    provisioned: readCanonicalJson(currentProvisionPath, 'P2_HOST_PROVISION_ATTESTATION_INVALID'),
    state,
    stateVolumeAttestation: current.stateVolumeAttestation,
    tangAttestations,
    authorityPublicKey,
    preBackupAttestation,
    headerBackupIdentity,
    sourceIdentity: current.sourceIdentity,
    mapperBacking: current.mapperBacking,
  });
  if (
    provisioned.luksUuid !== current.luksUuid ||
    provisioned.configurationSha256 !== configurationDigest() ||
    provisioned.headerBackupSha256 !== headerBackupSha256()
  ) stop('P2_HOST_REBOOT_READBACK_DRIFT');
  const rebootVerified = buildRebootVerifiedHostAttestation({
    contract,
    provisioned,
    currentBootId: readBootId(),
    readback: current,
  });
  const rebootReceiptPath = currentProvisionPath === paths.restoredProvision
    ? paths.restoredReboot
    : paths.reboot;
  publishManagedRecord(
    rebootReceiptPath === paths.restoredReboot ? 'reboot-restored' : 'reboot',
    `${canonicalJson(rebootVerified)}\n`,
  );
  return rebootVerified;
}

function validateDigestRecord(record, expectedKeys, code) {
  if (
    !record || typeof record !== 'object' || Array.isArray(record) ||
    Object.keys(record).toSorted().join('\0') !== [...expectedKeys, 'observedDigest'].toSorted().join('\0') ||
    !/^[a-f0-9]{64}$/u.test(record.observedDigest ?? '')
  ) stop(code);
  const core = { ...record };
  delete core.observedDigest;
  if (canonicalDigest(core) !== record.observedDigest) stop(code);
  return record;
}

function loadRebootReceipt(provisioned) {
  const receipt = validateDigestRecord(
    readCanonicalJson(backupPaths().reboot, 'P2_HOST_REBOOT_ATTESTATION_INVALID'),
    [
      'schemaVersion', 'state', 'nodeName', 'contractDigest', 'previousBootId',
      'currentBootId', 'provisionedDigest', 'hostEncryptionDigest',
    ],
    'P2_HOST_REBOOT_ATTESTATION_INVALID',
  );
  if (
    receipt.schemaVersion !== 1 || receipt.state !== 'HOST_ENCRYPTED_MOUNT_REBOOT_VERIFIED' ||
    receipt.nodeName !== contract.target.nodeName || receipt.contractDigest !== contractDigest(contract) ||
    receipt.provisionedDigest !== provisioned.observedDigest ||
    receipt.hostEncryptionDigest !== provisioned.hostEncryption.observedDigest
  ) stop('P2_HOST_REBOOT_ATTESTATION_MISMATCH');
  return receipt;
}

function preserveAndRestoreOriginalConfigurations(preBackupAttestation, provisioned) {
  if (configurationDigest() !== provisioned.configurationSha256) {
    stop('P2_HOST_CONFIGURATION_CHANGED_AFTER_PROVISION');
  }
  const paths = backupPaths();
  for (const entry of preBackupAttestation.configuration) {
    const backup = entry.path === systemdConfiguration.crypttabPath ? paths.crypttab : paths.fstab;
    const original = readFileSync(backup);
    if (sha256(original) !== entry.sha256) stop('P2_HOST_PRE_BACKUP_DRIFT');
    transitionConfiguration('rollback-config', entry, backup, `${backup}.managed`);
  }
}

function restoreManagedConfigurations(preBackupAttestation) {
  const paths = backupPaths();
  for (const entry of preBackupAttestation.configuration) {
    const backup = entry.path === systemdConfiguration.crypttabPath ? paths.crypttab : paths.fstab;
    const original = readFileSync(backup);
    if (sha256(original) !== entry.sha256 || sha256(fileBytes(entry.path)) !== entry.sha256) {
      stop('P2_HOST_ROLLBACK_CONFIGURATION_DRIFT');
    }
    if (!configurationMetadataMatches(entry.path, entry.metadata)) {
      stop('P2_HOST_ROLLBACK_CONFIGURATION_METADATA_DRIFT');
    }
    transitionConfiguration('restore-config', entry, backup, `${backup}.managed`);
  }
}

function restoreUnlockerState(preBackupAttestation) {
  const expected = preBackupAttestation.unlockerState;
  mutate('/usr/bin/systemctl', [
    expected.enabled ? 'enable' : 'disable',
    systemdConfiguration.unlockerUnit,
  ]);
  mutate('/usr/bin/systemctl', [
    expected.active ? 'start' : 'stop',
    systemdConfiguration.unlockerUnit,
  ]);
  if (canonicalJson(readUnlockerState()) !== canonicalJson(expected)) {
    stop('P2_HOST_ROLLBACK_UNLOCKER_STATE_DRIFT');
  }
}

function rollback() {
  assertAllowedOptions(['confirmation', 'kubeconfig', 'recovery-key-file', 'tang-attestation']);
  assertRoot();
  if (option('confirmation') !== confirmationSet.rollback) {
    stop('P2_HOST_ROLLBACK_CONFIRMATION_REQUIRED');
  }
  const recoveryKey = openRecoveryKey(option('recovery-key-file'));
  const kubeconfigPath = option('kubeconfig');
  const { authorityPublicKey, tangAttestations } = loadTangAttestations();
  assertMissingLeaf(
    contract.target.rollbackSourcePath,
    'P2_HOST_ROLLBACK_TARGET_ALREADY_EXISTS',
  );
  assertMissingLeaf(
    `${contract.target.backupRoot}/rollback.json`,
    'P2_HOST_ROLLBACK_RECEIPT_ALREADY_EXISTS',
  );
  const current = fullReadback({ kubeconfigPath, tangAttestations, authorityPublicKey });
  const preBackupAttestation = loadPreBackup({ currentMustMatch: false, mounted: true });
  const headerBackupIdentity = readRegularFileIdentity(`${contract.target.backupRoot}/luks-header.bin`);
  const provisioned = validateProvisionedHostAttestation({
    contract,
    provisioned: readCanonicalJson(backupPaths().provision, 'P2_HOST_PROVISION_ATTESTATION_INVALID'),
    state,
    stateVolumeAttestation: current.stateVolumeAttestation,
    tangAttestations,
    authorityPublicKey,
    preBackupAttestation,
    headerBackupIdentity,
    sourceIdentity: current.sourceIdentity,
    mapperBacking: current.mapperBacking,
  });
  const rebootReceipt = loadRebootReceipt(provisioned);
  if (
    current.luksUuid !== provisioned.luksUuid ||
    current.hostEncryption.observedDigest !== provisioned.hostEncryption.observedDigest
  ) stop('P2_HOST_ENCRYPTED_MARKER_IDENTITY_DRIFT');
  const headerDigest = rehearseHeaderRecovery(
    recoveryKey,
    contract.target.sourcePath,
    headerBackupIdentity,
  );
  if (headerDigest !== provisioned.headerBackupSha256) stop('P2_HOST_HEADER_BACKUP_DRIFT');

  mutate('/usr/bin/umount', [contract.target.mountPath]);
  mutate('/usr/sbin/cryptsetup', ['close', contract.target.mapperName]);
  preserveAndRestoreOriginalConfigurations(preBackupAttestation, provisioned);
  mutate('/usr/bin/systemctl', ['daemon-reload']);
  restoreUnlockerState(preBackupAttestation);
  mutate('/usr/bin/install', ['--directory', '--mode=0700', dirname(contract.target.rollbackSourcePath)]);
  const rollbackSourceIdentity = recoverableRename({
    source: contract.target.sourcePath,
    destination: contract.target.rollbackSourcePath,
    sourceIdentity: current.sourceIdentity,
    preBackupAttestation,
  });
  const missing = classifyReadback();
  if (missing.state !== 'MISSING' || exists(contract.target.markerPath)) {
    stop('P2_HOST_ROLLBACK_READBACK_FAILED');
  }
  const core = {
    schemaVersion: 1,
    state: 'HOST_ENCRYPTED_MOUNT_ROLLED_BACK_RECOVERABLE',
    nodeName: contract.target.nodeName,
    contractDigest: contractDigest(contract),
    luksUuid: provisioned.luksUuid,
    headerBackupSha256: headerDigest,
    provisionedDigest: provisioned.observedDigest,
    rebootVerifiedDigest: rebootReceipt.observedDigest,
    preBackupDigest: preBackupAttestation.observedDigest,
    encryptedMarkerDigest: current.hostEncryption.observedDigest,
    rollbackSourcePath: contract.target.rollbackSourcePath,
    rollbackSourceIdentity,
    plaintextMarkerPresent: false,
  };
  const receipt = { ...core, observedDigest: canonicalDigest(core) };
  publishManagedRecord('rollback', `${canonicalJson(receipt)}\n`);
  return receipt;
}

function loadRollbackReceipt(provisioned, preBackupAttestation, rebootReceipt) {
  const receipt = validateDigestRecord(
    readCanonicalJson(backupPaths().rollback, 'P2_HOST_ROLLBACK_ATTESTATION_INVALID'),
    [
      'schemaVersion', 'state', 'nodeName', 'contractDigest', 'luksUuid',
      'headerBackupSha256', 'provisionedDigest', 'rebootVerifiedDigest',
      'preBackupDigest', 'encryptedMarkerDigest', 'rollbackSourcePath',
      'rollbackSourceIdentity', 'plaintextMarkerPresent',
    ],
    'P2_HOST_ROLLBACK_ATTESTATION_INVALID',
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.state !== 'HOST_ENCRYPTED_MOUNT_ROLLED_BACK_RECOVERABLE' ||
    receipt.nodeName !== contract.target.nodeName ||
    receipt.contractDigest !== contractDigest(contract) ||
    receipt.luksUuid !== provisioned.luksUuid ||
    receipt.headerBackupSha256 !== provisioned.headerBackupSha256 ||
    receipt.provisionedDigest !== provisioned.observedDigest ||
    receipt.rebootVerifiedDigest !== rebootReceipt.observedDigest ||
    receipt.preBackupDigest !== preBackupAttestation.observedDigest ||
    receipt.encryptedMarkerDigest !== provisioned.hostEncryption.observedDigest ||
    receipt.rollbackSourcePath !== contract.target.rollbackSourcePath ||
    !samePathIdentity(
      receipt.rollbackSourceIdentity,
      relocatedFileIdentity(provisioned.sourceIdentity, contract.target.rollbackSourcePath),
    ) ||
    receipt.plaintextMarkerPresent !== false
  ) stop('P2_HOST_ROLLBACK_ATTESTATION_MISMATCH');
  return receipt;
}

function restore() {
  assertAllowedOptions(['confirmation', 'kubeconfig', 'recovery-key-file', 'tang-attestation']);
  assertRoot();
  if (option('confirmation') !== confirmationSet.restore) {
    stop('P2_HOST_RESTORE_CONFIRMATION_REQUIRED');
  }
  const recoveryKey = openRecoveryKey(option('recovery-key-file'));
  const kubeconfigPath = option('kubeconfig');
  const { authorityPublicKey, tangAttestations } = loadTangAttestations();
  assertPristine({ allowRollbackSource: true });
  if (!exists(contract.target.rollbackSourcePath)) stop('P2_HOST_ROLLBACK_SOURCE_MISSING');
  const preBackupAttestation = loadPreBackup();
  const stateVolumeAttestation = readStateVolume(kubeconfigPath);
  const provisionedRecord = readCanonicalJson(
    backupPaths().provision,
    'P2_HOST_PROVISION_ATTESTATION_INVALID',
  );
  const headerBackupIdentity = readRegularFileIdentity(`${contract.target.backupRoot}/luks-header.bin`);
  const previousProvisioned = validateProvisionedHostAttestation({
    contract,
    provisioned: provisionedRecord,
    state,
    stateVolumeAttestation,
    tangAttestations,
    authorityPublicKey,
    preBackupAttestation,
    headerBackupIdentity,
    sourceIdentity: provisionedRecord.sourceIdentity,
    mapperBacking: provisionedRecord.mapperBacking,
  });
  const rebootReceipt = loadRebootReceipt(previousProvisioned);
  const rollbackReceipt = loadRollbackReceipt(
    previousProvisioned,
    preBackupAttestation,
    rebootReceipt,
  );
  const rollbackSourceIdentity = assertPathIdentity(
    rollbackReceipt.rollbackSourceIdentity,
    'P2_HOST_ROLLBACK_SOURCE_IDENTITY_DRIFT',
  );
  const headerDigest = rehearseHeaderRecovery(
    recoveryKey,
    contract.target.rollbackSourcePath,
    headerBackupIdentity,
  );
  if (headerDigest !== rollbackReceipt.headerBackupSha256) stop('P2_HOST_HEADER_BACKUP_DRIFT');
  const rollbackUuid = readLuksUuid(contract.target.rollbackSourcePath);
  if (rollbackUuid !== rollbackReceipt.luksUuid) stop('P2_HOST_LUKS_UUID_DRIFT');
  verifyTangAdvertisements(tangAttestations);

  const restoredSourceIdentity = recoverableRename({
    source: contract.target.rollbackSourcePath,
    destination: contract.target.sourcePath,
    sourceIdentity: rollbackSourceIdentity,
    preBackupAttestation,
  });
  restoreManagedConfigurations(preBackupAttestation);
  mutate('/usr/bin/systemctl', ['daemon-reload']);
  mutate('/usr/bin/systemctl', ['enable', '--now', systemdConfiguration.unlockerUnit]);
  mutateWithRecoveryKey('/usr/sbin/cryptsetup', [
    'open', '--type', 'luks2', '--key-file', '/proc/self/fd/3',
    contract.target.sourcePath, contract.target.mapperName,
  ], recoveryKey);
  mutate('/usr/bin/mount', [contract.target.mountPath]);
  const restoredReadback = fullReadback({
    kubeconfigPath,
    tangAttestations,
    authorityPublicKey,
  });
  if (
    restoredReadback.luksUuid !== rollbackUuid ||
    restoredReadback.hostEncryption.observedDigest !== rollbackReceipt.encryptedMarkerDigest
  ) stop('P2_HOST_RESTORE_MARKER_IDENTITY_DRIFT');
  const restored = buildProvisionedHostAttestation({
    contract,
    state,
    stateVolumeAttestation: restoredReadback.stateVolumeAttestation,
    luksUuid: rollbackUuid,
    tangAttestations,
    authorityPublicKey,
    preBackupAttestation,
    headerBackupSha256: headerDigest,
    headerBackupIdentity,
    sourceIdentity: restoredSourceIdentity,
    mapperBacking: restoredReadback.mapperBacking,
    bootId: readBootId(),
    configurationSha256: configurationDigest(),
  });
  if (restored.hostEncryption.observedDigest !== rollbackReceipt.encryptedMarkerDigest) {
    stop('P2_HOST_RESTORE_MARKER_IDENTITY_DRIFT');
  }
  publishManagedRecord('provision-restored', `${canonicalJson(restored)}\n`);
  const verified = fullReadback({ kubeconfigPath, tangAttestations, authorityPublicKey });
  if (verified.hostEncryption.observedDigest !== rollbackReceipt.encryptedMarkerDigest) {
    stop('P2_HOST_RESTORE_READBACK_FAILED');
  }
  return restored;
}

function plan() {
  assertAllowedOptions([]);
  return publicPlan(contract);
}

const handlers = new Map([
  ['plan', plan],
  ['backup-state', backupState],
  ['backup', backup],
  ['readback', readback],
  ['apply', apply],
  ['reboot-readback', rebootReadback],
  ['rollback', rollback],
  ['restore', restore],
]);

try {
  if (fixtureInjectionForbidden) stop('P2_HOST_FIXTURE_INJECTION_FORBIDDEN');
  if (kubectlOverrideForbidden) stop('P2_HOST_KUBECTL_OVERRIDE_FORBIDDEN');
  const handler = handlers.get(mode);
  if (handler === undefined) stop('P2_HOST_COMMAND_INVALID');
  if (mode !== 'plan') {
    assertNativeLaunchMarker();
    assertInitialHostMountNamespace();
    assertNativeProcessHardening();
    verifyNativeHostMountNamespace();
  }
  const result = handler();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const code = error instanceof HostCommandError ||
    error instanceof HostEncryptionProvisioningError ||
    error instanceof StateEnvelopeError ||
    error instanceof KubectlReadbackBoundaryError
    ? error.code
    : 'P2_HOST_PROVISIONING_FAILED';
  const output = `${JSON.stringify({ ok: false, code })}\n`;
  if (publicErrorsOnStdout) {
    process.stdout.write(output);
  } else {
    process.stderr.write(output);
    process.exitCode = 1;
  }
} finally {
  for (const recoveryKey of [...openRecoveryKeys]) {
    try {
      closeRecoveryKey(recoveryKey);
    } catch {
      process.stderr.write(`${JSON.stringify({ ok: false, code: 'P2_HOST_RECOVERY_KEY_CLOSE_FAILED' })}\n`);
      process.exitCode = 1;
    }
  }
}
