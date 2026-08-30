#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

import {
  HostEncryptionProvisioningError,
  buildTangServerAttestation,
  canonicalDigest,
  canonicalJson,
  confirmations,
  contractDigest,
  sha256,
  validateTangBackupAttestation,
} from '../../tools/seori-auth/src/host-encryption-provisioning.mjs';
import { activateP2ProcessHardening } from './p2-process-hardening-boundary.mjs';

const contractPath = fileURLToPath(
  new URL('../../contracts/fleet-p2-host-encryption.yaml', import.meta.url),
);
const schemaPath = fileURLToPath(
  new URL('../../contracts/fleet-p2-host-encryption.schema.json', import.meta.url),
);
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const mode = process.argv[2] ?? 'plan';
const OVERRIDE_PATH = '/etc/systemd/system/tangd.socket.d/seorilabs.conf';

class TangCommandError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TangCommandError';
    this.code = code;
  }
}

function stop(code) {
  throw new TangCommandError(code);
}

const fixtureEntrypoint = fileURLToPath(
  new URL('../../tests/fixtures/p2-tang-provision-fixture-entrypoint.mjs', import.meta.url),
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
const fixtureRuntime = invokedEntrypoint === fixtureEntrypoint
  ? process.env.SEORILABS_HOST_FIXTURE_RUNTIME
  : undefined;
const fixtureRoot = invokedEntrypoint === fixtureEntrypoint
  ? process.env.SEORILABS_HOST_FIXTURE_ROOT
  : undefined;

function loadContract() {
  try {
    const contract = parse(readFileSync(contractPath, 'utf8'));
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
    if (!validate(contract)) stop('P2_TANG_CONTRACT_INVALID');
    return contract;
  } catch (error) {
    if (error instanceof TangCommandError) throw error;
    stop('P2_TANG_CONTRACT_INVALID');
  }
}

const contract = loadContract();
const confirmationSet = confirmations(contract);

function parseOptions() {
  const parsed = new Map();
  for (const argument of process.argv.slice(3)) {
    if (!argument.startsWith('--') || !argument.includes('=')) stop('P2_TANG_COMMAND_INVALID');
    const separator = argument.indexOf('=');
    const key = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (value.length === 0 || parsed.has(key)) stop('P2_TANG_COMMAND_INVALID');
    parsed.set(key, value);
  }
  return parsed;
}

const options = parseOptions();

function option(name, required = true) {
  const value = options.get(name);
  if (required && value === undefined) stop('P2_TANG_COMMAND_INVALID');
  return value;
}

function assertAllowedOptions(allowed) {
  for (const key of options.keys()) {
    if (!allowed.includes(key)) stop('P2_TANG_COMMAND_INVALID');
  }
}

function server() {
  const nodeName = option('server');
  const selected = contract.tang.servers.find((entry) => entry.nodeName === nodeName);
  if (selected === undefined) stop('P2_TANG_SERVER_INVALID');
  return selected;
}

function mappedPath(path) {
  if (fixtureRuntime === undefined) return path;
  if (!isAbsolute(fixtureRoot ?? '')) stop('P2_TANG_FIXTURE_BOUNDARY_INVALID');
  return join(fixtureRoot, path.slice(1));
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
      ].includes(path) &&
        (entry.uid !== 0 || entry.gid !== 0 || (entry.mode & 0o022) !== 0))
    ) stop('P2_TANG_EXECUTABLE_INVALID');
    return path;
  } catch (error) {
    if (error instanceof TangCommandError) throw error;
    stop('P2_TANG_EXECUTABLE_INVALID');
  }
}

function run(executable, args, code, { mutation = false, allowedStatuses = [], input } = {}) {
  const commandPath = canonicalExecutable(executable);
  const runtime = fixtureRuntime === undefined ? commandPath : process.execPath;
  const runtimeArgs = fixtureRuntime === undefined ? args : [fixtureRuntime, commandPath, ...args];
  try {
    return {
      status: 0,
      stdout: execFileSync(runtime, runtimeArgs, {
        encoding: 'utf8',
        env: commandEnvironment(),
        maxBuffer: MAX_OUTPUT_BYTES,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        ...(input === undefined ? {} : { input }),
        timeout: mutation ? 120_000 : 15_000,
      }),
    };
  } catch (error) {
    if (allowedStatuses.includes(error?.status)) return { status: error.status, stdout: '' };
    stop(mutation ? 'P2_TANG_MUTATION_OUTCOME_UNKNOWN' : code);
  }
}

function read(executable, args, code) {
  return run(executable, args, code).stdout.trim();
}

function mutate(executable, args) {
  run(executable, args, 'P2_TANG_MUTATION_FAILED', { mutation: true });
}

function verifyNativeHostMountNamespace() {
  if (!contract.filesystemBoundary.operations.includes('verify-namespace')) {
    stop('P2_TANG_FILESYSTEM_BOUNDARY_OPERATION_INVALID');
  }
  const receipt = publicJson(
    run(
      contract.filesystemBoundary.executable,
      ['verify-namespace'],
      'P2_TANG_MOUNT_NAMESPACE_NATIVE_READBACK_FAILED',
    ).stdout,
    'P2_TANG_FILESYSTEM_BOUNDARY_RECEIPT_INVALID',
  );
  if (
    receipt.operation !== 'verify-namespace' || receipt.verified !== true ||
    Object.keys(receipt).toSorted().join('\0') !== ['operation', 'verified'].join('\0')
  ) stop('P2_TANG_FILESYSTEM_BOUNDARY_RECEIPT_INVALID');
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
          'P2_TANG_PROCESS_HARDENING_READBACK_FAILED',
        ).stdout,
        'P2_TANG_PROCESS_HARDENING_RECEIPT_INVALID',
      );
  } catch (error) {
    if (error instanceof TangCommandError) throw error;
    stop('P2_TANG_PROCESS_HARDENING_READBACK_FAILED');
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
  ) stop('P2_TANG_PROCESS_HARDENING_RECEIPT_INVALID');
}

function assertNativeLaunchMarker() {
  if (process.env[contract.processBoundary.launchMarker] !== '1') {
    stop('P2_TANG_NATIVE_LAUNCH_REQUIRED');
  }
  canonicalExecutable(contract.processBoundary.launcherExecutable);
}

function assertInitialHostMountNamespace() {
  if (fixtureRuntime !== undefined) {
    if (process.env.SEORILABS_HOST_FIXTURE_SCENARIO === 'alternate-mount-namespace') {
      stop('P2_TANG_MOUNT_NAMESPACE_MISMATCH');
    }
    return;
  }
  if (process.platform !== 'linux') stop('P2_TANG_LINUX_REQUIRED');
  try {
    const initial = statSync('/proc/1/ns/mnt', { bigint: true });
    const current = statSync('/proc/self/ns/mnt', { bigint: true });
    if (initial.dev !== current.dev || initial.ino !== current.ino) {
      stop('P2_TANG_MOUNT_NAMESPACE_MISMATCH');
    }
  } catch (error) {
    if (error instanceof TangCommandError) throw error;
    stop('P2_TANG_MOUNT_NAMESPACE_READBACK_FAILED');
  }
}

function publicJson(text, code) {
  try {
    return JSON.parse(text);
  } catch {
    stop(code);
  }
}

function sameStatIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
    left.gid === right.gid && left.mode === right.mode && left.size === right.size;
}

function readNoFollowFile(
  path,
  code,
  { map = false, rootOwned = false, modes = [0o400, 0o600], maxBytes = 512 * 1024 } = {},
) {
  let descriptor;
  try {
    const local = map ? mappedPath(path) : path;
    if (
      !isAbsolute(path) || realpathSync(dirname(local)) !== dirname(local)
    ) stop(code);
    const entry = lstatSync(local);
    if (
      !entry.isFile() || entry.isSymbolicLink() || realpathSync(local) !== local ||
      (rootOwned && fixtureRuntime === undefined && (entry.uid !== 0 || entry.gid !== 0)) ||
      !modes.includes(entry.mode & 0o777)
    ) stop(code);
    descriptor = openSync(local, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const descriptorEntry = fstatSync(descriptor);
    if (!sameStatIdentity(entry, descriptorEntry)) stop(code);
    const bytes = readFileSync(descriptor);
    if (bytes.length === 0 || bytes.length > maxBytes) stop(code);
    return bytes;
  } catch (error) {
    if (error instanceof TangCommandError) throw error;
    stop(code);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        stop(code);
      }
    }
  }
}

function readCanonicalJson(path, code) {
  try {
    return JSON.parse(readNoFollowFile(path, code, { rootOwned: true }).toString('utf8'));
  } catch (error) {
    if (error instanceof TangCommandError) throw error;
    stop(code);
  }
}

function readBackupAuthorityPublicKey() {
  return readNoFollowFile(
    contract.tang.backupAuthority.publicKeyPath,
    'P2_TANG_BACKUP_TRUST_ANCHOR_INVALID',
    { map: true, rootOwned: true, modes: [0o400, 0o444], maxBytes: 16 * 1024 },
  );
}

function assertRoot() {
  if (fixtureRuntime === undefined && process.geteuid?.() !== 0) stop('P2_TANG_ROOT_REQUIRED');
}

function readHostIdentity(expected) {
  const hostname = read('/usr/bin/hostname', ['--short'], 'P2_TANG_HOST_IDENTITY_READBACK_FAILED');
  const addresses = publicJson(
    read('/usr/sbin/ip', ['-json', 'address', 'show', 'scope', 'global'], 'P2_TANG_HOST_IDENTITY_READBACK_FAILED'),
    'P2_TANG_HOST_IDENTITY_READBACK_INVALID',
  ).flatMap(({ addr_info: entries = [] }) => entries)
    .filter(({ family, scope }) => family === 'inet' && scope === 'global')
    .map(({ local }) => local);
  if (hostname !== expected.expectedHostname || !addresses.includes(expected.ipv4)) {
    stop('P2_TANG_HOST_IDENTITY_MISMATCH');
  }
  return { hostname, ipv4: expected.ipv4 };
}

function readPackageVersion({ missingAllowed = false } = {}) {
  const result = run(
    '/usr/bin/dpkg-query',
    ['--show', '--showformat=${Status}\t${Version}', 'tang'],
    'P2_TANG_PACKAGE_READBACK_FAILED',
    { allowedStatuses: missingAllowed ? [1] : [] },
  );
  if (result.status === 1) return null;
  const match = /^install ok installed\t([^\s]+)$/u.exec(result.stdout.trim());
  if (match === null) stop('P2_TANG_PACKAGE_READBACK_INVALID');
  return match[1];
}

function overrideBytes(selected) {
  return Buffer.from(`[Socket]\nListenStream=\nListenStream=${selected.port}\n`, 'utf8');
}

function readOverride(selected, { missingAllowed = false } = {}) {
  try {
    const target = mappedPath(OVERRIDE_PATH);
    const entry = lstatSync(target);
    if (
      !entry.isFile() || entry.isSymbolicLink() || realpathSync(target) !== target ||
      (fixtureRuntime === undefined && (entry.uid !== 0 || entry.gid !== 0)) ||
      (entry.mode & 0o777) !== 0o644
    ) stop('P2_TANG_SOCKET_OVERRIDE_INVALID');
    const actual = readFileSync(target);
    if (!actual.equals(overrideBytes(selected))) stop('P2_TANG_SOCKET_OVERRIDE_DRIFT');
    return true;
  } catch (error) {
    if (error instanceof TangCommandError) throw error;
    if (missingAllowed && error?.code === 'ENOENT') return false;
    stop('P2_TANG_SOCKET_OVERRIDE_MISSING');
  }
}

function readInventory(selected) {
  const localDirectory = mappedPath(selected.keyDirectory);
  let directoryEntry;
  try {
    directoryEntry = lstatSync(localDirectory);
    if (
      !directoryEntry.isDirectory() || directoryEntry.isSymbolicLink() ||
      realpathSync(localDirectory) !== localDirectory ||
      (directoryEntry.mode & 0o022) !== 0
    ) stop('P2_TANG_KEY_INVENTORY_READBACK_INVALID');
  } catch (error) {
    if (error instanceof TangCommandError) throw error;
    stop('P2_TANG_KEY_INVENTORY_READBACK_INVALID');
  }
  const records = read(
    '/usr/bin/find',
    [selected.keyDirectory, '-mindepth', '1', '-maxdepth', '1', '-printf', '%f\t%y\n'],
    'P2_TANG_KEY_INVENTORY_READBACK_FAILED',
  ).split(/\r?\n/u).filter(Boolean).toSorted();
  const names = records.map((record) => {
    const match = /^([^\t]+)\tf$/u.exec(record);
    if (match === null) stop('P2_TANG_KEY_INVENTORY_READBACK_INVALID');
    return match[1];
  });
  if (
    names.length < 2 || new Set(names).size !== names.length ||
    names.some((name) => !/^[A-Za-z0-9._-]+\.jwk$/u.test(name))
  ) stop('P2_TANG_KEY_INVENTORY_PARTIAL');
  const content = [];
  const metadata = [];
  for (const name of names) {
    const logicalPath = `${selected.keyDirectory}/${name}`;
    const localPath = mappedPath(logicalPath);
    let descriptor;
    try {
      const entry = lstatSync(localPath);
      if (
        !entry.isFile() || entry.isSymbolicLink() || realpathSync(localPath) !== localPath ||
        entry.uid !== directoryEntry.uid || entry.gid !== directoryEntry.gid ||
        (entry.mode & 0o7777).toString(8).padStart(4, '0') !==
          contract.tang.keyInventoryPolicy.fileMode
      ) stop('P2_TANG_KEY_INVENTORY_READBACK_INVALID');
      descriptor = openSync(localPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const descriptorEntry = fstatSync(descriptor);
      if (!sameStatIdentity(entry, descriptorEntry)) {
        stop('P2_TANG_KEY_INVENTORY_READBACK_INVALID');
      }
      const bytes = readFileSync(descriptor);
      if (bytes.length === 0 || bytes.length > 128 * 1024) {
        stop('P2_TANG_KEY_INVENTORY_READBACK_INVALID');
      }
      content.push({ name, sha256: sha256(bytes) });
      metadata.push({
        name,
        ownerId: entry.uid,
        groupId: entry.gid,
        mode: (entry.mode & 0o7777).toString(8).padStart(4, '0'),
        sizeBytes: entry.size,
      });
    } catch (error) {
      if (error instanceof TangCommandError) throw error;
      stop('P2_TANG_KEY_INVENTORY_READBACK_INVALID');
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          stop('P2_TANG_KEY_INVENTORY_READBACK_INVALID');
        }
      }
    }
  }
  const contentSha256 = canonicalDigest(content);
  const metadataSha256 = canonicalDigest({
    directory: {
      ownerId: directoryEntry.uid,
      groupId: directoryEntry.gid,
      mode: (directoryEntry.mode & 0o7777).toString(8).padStart(4, '0'),
    },
    files: metadata,
  });
  const inventoryEvidenceSha256 = canonicalDigest({ contentSha256, metadataSha256 });
  return {
    publicInventory: {
      directory: selected.keyDirectory,
      fileCount: names.length,
      inventoryEvidenceSha256,
      backupLogicalId: selected.backupLogicalId,
    },
    privateInventory: { contentSha256, metadataSha256, inventoryEvidenceSha256 },
  };
}

function readPublicServer(selected) {
  const identity = readHostIdentity(selected);
  const packageVersion = readPackageVersion();
  readOverride(selected);
  if (
    read('/usr/bin/systemctl', ['is-enabled', selected.socketUnit], 'P2_TANG_SOCKET_READBACK_FAILED') !== 'enabled' ||
    read('/usr/bin/systemctl', ['is-active', selected.socketUnit], 'P2_TANG_SOCKET_READBACK_FAILED') !== 'active'
  ) stop('P2_TANG_SOCKET_NOT_READY');
  const listen = read(
    '/usr/bin/systemctl',
    ['show', selected.socketUnit, '--property=Listen', '--value'],
    'P2_TANG_SOCKET_READBACK_FAILED',
  ).split(/\r?\n/u).filter(Boolean);
  if (listen.length !== 1 || !new RegExp(`(?:^|:)${selected.port}\\s+\\(Stream\\)$`, 'u').test(listen[0])) {
    stop('P2_TANG_SOCKET_PORT_DRIFT');
  }
  const signingKeyThumbprints = read(
    '/usr/bin/tang-show-keys',
    [String(selected.port)],
    'P2_TANG_ADVERTISEMENT_READBACK_FAILED',
  ).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).toSorted();
  if (
    signingKeyThumbprints.length !== 1 ||
    !/^[A-Za-z0-9_-]{43}$/u.test(signingKeyThumbprints[0])
  ) stop('P2_TANG_SIGNING_KEY_READBACK_INVALID');
  const advertisement = run(
    '/usr/bin/curl',
    ['--fail', '--silent', '--show-error', '--max-time', '10', `http://127.0.0.1:${selected.port}/adv`],
    'P2_TANG_ADVERTISEMENT_READBACK_FAILED',
  ).stdout;
  return {
    identity,
    packageVersion,
    signingKeyThumbprints,
    advertisementSha256: sha256(advertisement),
    keyInventory: readInventory(selected),
  };
}

function publishTangOverride(bytes) {
  if (!contract.filesystemBoundary.operations.includes('publish-record')) {
    stop('P2_TANG_FILESYSTEM_BOUNDARY_OPERATION_INVALID');
  }
  const receipt = publicJson(
    run(
      contract.filesystemBoundary.executable,
      ['publish-record', 'tang-socket-override'],
      'P2_TANG_FILESYSTEM_BOUNDARY_FAILED',
      { mutation: true, input: bytes },
    ).stdout,
    'P2_TANG_FILESYSTEM_BOUNDARY_RECEIPT_INVALID',
  );
  if (
    receipt.operation !== 'publish-record' || receipt.record !== 'tang-socket-override' ||
    receipt.sizeBytes !== bytes.length ||
    Object.keys(receipt).toSorted().join('\0') !==
      ['operation', 'record', 'sizeBytes'].toSorted().join('\0')
  ) stop('P2_TANG_FILESYSTEM_BOUNDARY_RECEIPT_INVALID');
}

function plan() {
  assertAllowedOptions(['server']);
  const selected = server();
  return {
    schemaVersion: 1,
    state: 'DRY_RUN',
    contractDigest: contractDigest(contract),
    server: selected,
    confirmation: confirmationSet.tang[selected.nodeName],
    overridePath: OVERRIDE_PATH,
    packageMutation: 'apt-get install tang',
    backupGate: {
      logicalCredentialId: selected.backupLogicalId,
      state: 'BACKUP_RESTORE_ATTESTATION_REQUIRED',
      secretValuesReturned: false,
    },
  };
}

function apply() {
  assertAllowedOptions(['server', 'confirmation']);
  assertRoot();
  const selected = server();
  if (option('confirmation') !== confirmationSet.tang[selected.nodeName]) {
    stop('P2_TANG_APPLY_CONFIRMATION_REQUIRED');
  }
  readHostIdentity(selected);
  const osRelease = readFileSync(mappedPath('/etc/os-release'), 'utf8');
  if (!/^ID=(?:ubuntu|debian)$/mu.test(osRelease)) stop('P2_TANG_OPERATING_SYSTEM_UNSUPPORTED');
  const installed = readPackageVersion({ missingAllowed: true });
  const overrideExists = readOverride(selected, { missingAllowed: true });
  if (installed !== null && !overrideExists) {
    stop('P2_TANG_READBACK_PARTIAL');
  }
  if (installed === null) {
    const collision = run(
      '/usr/bin/ss',
      ['--no-header', '--listening', '--tcp', '--numeric', `sport = :${selected.port}`],
      'P2_TANG_PORT_READBACK_FAILED',
    ).stdout.trim();
    if (collision !== '') stop('P2_TANG_PORT_ALREADY_IN_USE');
    if (!overrideExists) publishTangOverride(overrideBytes(selected));
    mutate('/usr/bin/apt-get', ['update']);
    mutate('/usr/bin/apt-get', ['install', '--yes', 'tang']);
  }
  mutate('/usr/bin/systemctl', ['daemon-reload']);
  mutate('/usr/bin/systemctl', ['enable', '--now', selected.socketUnit]);
  const observed = readPublicServer(selected);
  return {
    schemaVersion: 1,
    state: 'TANG_SERVER_KEYS_BACKUP_REQUIRED',
    contractDigest: contractDigest(contract),
    nodeName: selected.nodeName,
    hostname: observed.identity.hostname,
    ipv4: observed.identity.ipv4,
    port: selected.port,
    url: selected.url,
    packageVersion: observed.packageVersion,
    signingKeyThumbprints: observed.signingKeyThumbprints,
    advertisementSha256: observed.advertisementSha256,
    keyInventory: observed.keyInventory.publicInventory,
    requiredBackupLogicalId: selected.backupLogicalId,
    secretValuesReturned: false,
  };
}

function readback() {
  assertAllowedOptions(['server', 'backup-attestation']);
  assertRoot();
  const selected = server();
  const observed = readPublicServer(selected);
  const backupAttestation = readCanonicalJson(
    option('backup-attestation'),
    'P2_TANG_BACKUP_ATTESTATION_INVALID',
  );
  const authorityPublicKey = readBackupAuthorityPublicKey();
  const verifiedBackupAttestation = validateTangBackupAttestation({
    contract,
    server: selected,
    attestation: backupAttestation,
    authorityPublicKey,
    liveInventory: observed.keyInventory.privateInventory,
  });
  return buildTangServerAttestation({
    contract,
    server: selected,
    hostname: observed.identity.hostname,
    ipv4: observed.identity.ipv4,
    packageVersion: observed.packageVersion,
    signingKeyThumbprints: observed.signingKeyThumbprints,
    advertisementSha256: observed.advertisementSha256,
    keyInventory: observed.keyInventory.publicInventory,
    backupAttestation: verifiedBackupAttestation,
    authorityPublicKey,
  });
}

const handlers = new Map([
  ['plan', plan],
  ['apply', apply],
  ['readback', readback],
]);

try {
  if (fixtureInjectionForbidden) stop('P2_TANG_FIXTURE_INJECTION_FORBIDDEN');
  const handler = handlers.get(mode);
  if (handler === undefined) stop('P2_TANG_COMMAND_INVALID');
  if (mode !== 'plan') {
    assertNativeLaunchMarker();
    assertInitialHostMountNamespace();
    assertNativeProcessHardening();
    verifyNativeHostMountNamespace();
  }
  process.stdout.write(`${JSON.stringify(handler())}\n`);
} catch (error) {
  const code = error instanceof TangCommandError || error instanceof HostEncryptionProvisioningError
    ? error.code
    : 'P2_TANG_PROVISIONING_FAILED';
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exitCode = 1;
}
