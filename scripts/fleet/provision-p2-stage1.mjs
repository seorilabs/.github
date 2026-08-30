#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  linkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

import {
  canonicalDigest,
  canonicalJson,
  confirmations as hostProvisioningConfirmations,
  contractDigest,
  sha256,
  validatePreProvisionBackupAttestation,
  validateTangFleetAttestations,
  validateTangServerAttestation,
} from '../../tools/seori-auth/src/host-encryption-provisioning.mjs';
import {
  P2Stage1Error,
  attestorPublicDetails,
  buildVerifiedPrivateEvidence,
  decryptTangBackup,
  encryptionPublicDetails,
  expectedAttestorCatalogEntry,
  expectedEncryptionCatalogEntry,
  expectedTangCatalogEntry,
  isolatedRestoreInventory,
  parseCanonicalCredentialBackupOutput,
  parseCanonicalCredentialRestoreOutput,
  signTangPrivateEvidence,
  verifyAttestorPair,
  verifyEncryptionPair,
} from '../../tools/seori-auth/src/p2-stage1.mjs';
import { activateP2ProcessHardening } from './p2-process-hardening-boundary.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const stage1ContractPath = join(repositoryRoot, 'contracts/fleet-p2-stage1.yaml');
const stage1SchemaPath = join(repositoryRoot, 'contracts/fleet-p2-stage1.schema.json');
const hostContractPath = join(repositoryRoot, 'contracts/fleet-p2-host-encryption.yaml');
const hostSchemaPath = join(repositoryRoot, 'contracts/fleet-p2-host-encryption.schema.json');
const fixtureEntrypoint = fileURLToPath(
  new URL('../../tests/fixtures/p2-stage1-controller-fixture-entrypoint.mjs', import.meta.url),
);
const fixtureCommand = fileURLToPath(
  new URL('../../tests/fixtures/p2-stage1-controller-command-mock.mjs', import.meta.url),
);
const relayPayloadReadbackScript = fileURLToPath(
  new URL('./readback-p2-stage1-relay-payload.sh', import.meta.url),
);
const mode = process.argv[2] ?? 'plan';
const MAX_PUBLIC_OUTPUT = 2 * 1024 * 1024;
const SHA40 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const HOST_KUBECONFIG = '/var/snap/microk8s/current/credentials/client.config';
const LUKS_RECOVERY_LOGICAL_ID = 'shared/seori-auth/luks-recovery';

class Stage1ControllerError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Stage1ControllerError';
    this.code = code;
  }
}

function stop(code) {
  throw new Stage1ControllerError(code);
}

let invokedEntrypoint;
try {
  invokedEntrypoint = process.argv[1] === undefined ? undefined : realpathSync(process.argv[1]);
} catch {
  invokedEntrypoint = undefined;
}
const fixtureRequested = [
  'SEORILABS_P2_STAGE1_FIXTURE_CREDENTIAL_ROOT',
  'SEORILABS_P2_STAGE1_FIXTURE_REMOTE_ROOT',
  'SEORILABS_P2_STAGE1_FIXTURE_LOG',
  'SEORILABS_P2_STAGE1_FIXTURE_SCENARIO',
].some((name) => process.env[name] !== undefined);
const fixtureInjectionForbidden = fixtureRequested && invokedEntrypoint !== fixtureEntrypoint;
const fixtureCredentialRoot = invokedEntrypoint === fixtureEntrypoint
  ? process.env.SEORILABS_P2_STAGE1_FIXTURE_CREDENTIAL_ROOT
  : undefined;
const fixtureRemoteRoot = invokedEntrypoint === fixtureEntrypoint
  ? process.env.SEORILABS_P2_STAGE1_FIXTURE_REMOTE_ROOT
  : undefined;
const fixtureLog = invokedEntrypoint === fixtureEntrypoint
  ? process.env.SEORILABS_P2_STAGE1_FIXTURE_LOG
  : undefined;
const fixtureScenario = invokedEntrypoint === fixtureEntrypoint
  ? process.env.SEORILABS_P2_STAGE1_FIXTURE_SCENARIO
  : undefined;
let localProcessContext;

function loadContract(path, schemaPath, code) {
  try {
    const value = parse(readFileSync(path, 'utf8'));
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
    if (!validate(value)) stop(code);
    return Object.freeze(value);
  } catch (error) {
    if (error instanceof Stage1ControllerError) throw error;
    stop(code);
  }
}

const stage1 = loadContract(stage1ContractPath, stage1SchemaPath, 'P2_STAGE1_CONTRACT_INVALID');
const hostContract = loadContract(hostContractPath, hostSchemaPath, 'P2_HOST_CONTRACT_INVALID');
const combinedDigest = canonicalDigest({ stage1, hostContract });

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

function host(nodeName, role) {
  const selected = stage1.hosts.find((entry) => entry.nodeName === nodeName && entry.role === role);
  if (selected === undefined) stop('P2_STAGE1_HOST_INVALID');
  return selected;
}

function tangServer() {
  const nodeName = option('server');
  const machine = host(nodeName, 'tang');
  const server = hostContract.tang.servers.find((entry) => entry.nodeName === nodeName);
  if (server === undefined) stop('P2_STAGE1_SERVER_INVALID');
  return { machine, server };
}

function confirmations() {
  const short = combinedDigest.slice(0, 16);
  return Object.freeze({
    attestor: `fleet-p2-stage1-bootstrap-attestor-${short}`,
    tangProvision: hostProvisioningConfirmations(hostContract).tang,
    tang: Object.fromEntries(hostContract.tang.servers.map(({ nodeName }) => [
      nodeName,
      `fleet-p2-stage1-backup-${nodeName}-${short}`,
    ])),
    tangInstall: Object.fromEntries(hostContract.tang.servers.map(({ nodeName }) => [
      nodeName,
      `fleet-p2-stage1-install-evidence-${nodeName}-${short}`,
    ])),
    rpi5: `fleet-p2-stage1-install-rpi5-evidence-${short}`,
  });
}

function credentialRoot() {
  const root = fixtureCredentialRoot ?? join(homedir(), '.config/seorilabs');
  if (!isAbsolute(root)) stop('P2_STAGE1_CREDENTIAL_ROOT_INVALID');
  try {
    const entry = lstatSync(root);
    if (
      !entry.isDirectory() || entry.isSymbolicLink() || realpathSync(root) !== root ||
      (entry.mode & 0o077) !== 0 ||
      (fixtureCredentialRoot === undefined && entry.uid !== process.geteuid?.())
    ) stop('P2_STAGE1_CREDENTIAL_ROOT_INVALID');
  } catch (error) {
    if (error instanceof Stage1ControllerError) throw error;
    stop('P2_STAGE1_CREDENTIAL_ROOT_INVALID');
  }
  return root;
}

function relativeCredentialPath(root, relativePath) {
  if (
    typeof relativePath !== 'string' || relativePath.length === 0 || isAbsolute(relativePath) ||
    normalize(relativePath) !== relativePath || relativePath.split(sep).includes('..')
  ) stop('P2_STAGE1_CREDENTIAL_PATH_INVALID');
  const target = join(root, relativePath);
  const relation = relative(root, target);
  if (relation.startsWith('..') || isAbsolute(relation)) stop('P2_STAGE1_CREDENTIAL_PATH_INVALID');
  return target;
}

function ensureParent(root, target, modeValue = 0o700) {
  const relation = relative(root, dirname(target));
  let current = root;
  for (const part of relation.split(sep).filter(Boolean)) {
    const parent = current;
    current = join(current, part);
    let created = false;
    try {
      mkdirSync(current, { mode: modeValue });
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') stop('P2_STAGE1_CREDENTIAL_DIRECTORY_INVALID');
    }
    const entry = lstatSync(current);
    if (
      !entry.isDirectory() || entry.isSymbolicLink() || realpathSync(current) !== current ||
      (entry.mode & 0o022) !== 0 ||
      (fixtureCredentialRoot === undefined && entry.uid !== process.geteuid?.())
    ) stop('P2_STAGE1_CREDENTIAL_DIRECTORY_INVALID');
    if (created) {
      syncDirectoryPath(current);
      syncDirectoryPath(parent);
    }
  }
}

function syncDirectoryPath(path) {
  let descriptor;
  try {
    const entry = lstatSync(path);
    if (
      !entry.isDirectory() || entry.isSymbolicLink() || realpathSync(path) !== path ||
      (entry.mode & 0o022) !== 0 ||
      (fixtureCredentialRoot === undefined && entry.uid !== process.geteuid?.())
    ) stop('P2_STAGE1_CREDENTIAL_DIRECTORY_INVALID');
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const held = fstatSync(descriptor);
    if (
      held.dev !== entry.dev || held.ino !== entry.ino || held.mode !== entry.mode ||
      held.uid !== entry.uid || held.gid !== entry.gid
    ) stop('P2_STAGE1_CREDENTIAL_DIRECTORY_INVALID');
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof Stage1ControllerError) throw error;
    stop('P2_STAGE1_CREDENTIAL_DIRECTORY_INVALID');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readHeld(
  path,
  { mode: modeValue, modes: modeValues, maximum = 4 * 1024 * 1024, allowEmpty = false } = {},
) {
  let descriptor;
  try {
    if (
      modeValue !== undefined && modeValues !== undefined ||
      modeValues !== undefined && (
        !Array.isArray(modeValues) || modeValues.length === 0 ||
        modeValues.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 0o777)
      )
    ) stop('P2_STAGE1_CREDENTIAL_FILE_INVALID');
    const allowedModes = modeValues ?? (modeValue === undefined ? undefined : [modeValue]);
    const entry = lstatSync(path);
    if (
      !entry.isFile() || entry.isSymbolicLink() || realpathSync(path) !== path ||
      entry.nlink !== 1 ||
      (allowedModes !== undefined && !allowedModes.includes(entry.mode & 0o777)) ||
      (fixtureCredentialRoot === undefined && entry.uid !== process.geteuid?.()) ||
      (!allowEmpty && entry.size < 1) || entry.size > maximum
    ) stop('P2_STAGE1_CREDENTIAL_FILE_INVALID');
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const held = fstatSync(descriptor);
    if (
      held.dev !== entry.dev || held.ino !== entry.ino || held.size !== entry.size ||
      held.mode !== entry.mode || held.uid !== entry.uid || held.gid !== entry.gid ||
      held.nlink !== entry.nlink
    ) stop('P2_STAGE1_CREDENTIAL_FILE_DRIFT');
    const bytes = readFileSync(descriptor);
    const descriptorAfter = fstatSync(descriptor);
    const after = lstatSync(path);
    if (
      descriptorAfter.dev !== held.dev || descriptorAfter.ino !== held.ino ||
      descriptorAfter.size !== held.size || descriptorAfter.mode !== held.mode ||
      descriptorAfter.uid !== held.uid || descriptorAfter.gid !== held.gid ||
      descriptorAfter.nlink !== held.nlink || descriptorAfter.mtimeMs !== held.mtimeMs ||
      descriptorAfter.ctimeMs !== held.ctimeMs || after.dev !== entry.dev ||
      after.ino !== entry.ino || after.size !== entry.size || after.mode !== entry.mode ||
      after.uid !== entry.uid || after.gid !== entry.gid || after.nlink !== entry.nlink ||
      after.mtimeMs !== entry.mtimeMs || after.ctimeMs !== entry.ctimeMs
    ) {
      stop('P2_STAGE1_CREDENTIAL_FILE_DRIFT');
    }
    return bytes;
  } catch (error) {
    if (error instanceof Stage1ControllerError) throw error;
    stop('P2_STAGE1_CREDENTIAL_FILE_INVALID');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function pathState(path) {
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) stop('P2_STAGE1_CREDENTIAL_FILE_INVALID');
    return 'PRESENT';
  } catch (error) {
    if (error instanceof Stage1ControllerError) throw error;
    if (error?.code === 'ENOENT') return 'ABSENT';
    stop('P2_STAGE1_CREDENTIAL_FILE_INVALID');
  }
}

function recoverPublishedCreateOnlyOrphan(target, modeValue) {
  const temporary = join(dirname(target), `.${basename(target)}.seorilabs-stage1.pending`);
  try {
    const targetEntry = lstatSync(target);
    const temporaryEntry = lstatSync(temporary);
    if (
      !targetEntry.isFile() || targetEntry.isSymbolicLink() ||
      !temporaryEntry.isFile() || temporaryEntry.isSymbolicLink() ||
      targetEntry.dev !== temporaryEntry.dev || targetEntry.ino !== temporaryEntry.ino ||
      targetEntry.nlink !== 2 || temporaryEntry.nlink !== 2 ||
      (targetEntry.mode & 0o777) !== modeValue ||
      targetEntry.uid !== process.geteuid?.()
    ) stop('P2_STAGE1_CREATE_ONLY_ORPHAN_INVALID');
    unlinkSync(temporary);
    syncDirectoryPath(dirname(target));
  } catch (error) {
    if (error instanceof Stage1ControllerError) throw error;
    if (error?.code !== 'ENOENT') stop('P2_STAGE1_CREATE_ONLY_ORPHAN_INVALID');
  }
}

function writeCreateOnlyOrExact(root, relativePath, bytes, modeValue) {
  const target = relativeCredentialPath(root, relativePath);
  ensureParent(root, target);
  const parent = dirname(target);
  const temporary = join(parent, `.${basename(target)}.seorilabs-stage1.pending`);
  if (pathState(target) === 'PRESENT') {
    recoverPublishedCreateOnlyOrphan(target, modeValue);
    const existing = readHeld(target, { mode: modeValue, maximum: Math.max(bytes.length, 1) });
    try {
      if (!existing.equals(bytes)) stop('P2_STAGE1_CREATE_ONLY_DRIFT');
    } finally {
      existing.fill(0);
    }
    return Object.freeze({ state: 'EXACT_READBACK', path: target });
  }
  let descriptor;
  let identity;
  let published = false;
  try {
    try {
      const orphan = lstatSync(temporary);
      if (
        !orphan.isFile() || orphan.isSymbolicLink() || realpathSync(temporary) !== temporary ||
        orphan.nlink !== 1 || orphan.uid !== process.geteuid?.() ||
        ![0o600, modeValue].includes(orphan.mode & 0o777) ||
        orphan.size > Math.max(bytes.length, 1)
      ) stop('P2_STAGE1_CREATE_ONLY_ORPHAN_INVALID');
      const orphanBytes = orphan.size > 0 && (orphan.mode & 0o777) === modeValue
        ? readHeld(temporary, { mode: modeValue, maximum: Math.max(bytes.length, 1) })
        : Buffer.alloc(0);
      try {
        if (orphanBytes.equals(bytes)) {
          identity = orphan;
        } else {
          unlinkSync(temporary);
          syncDirectoryPath(parent);
        }
      } finally {
        orphanBytes.fill(0);
      }
    } catch (error) {
      if (error instanceof Stage1ControllerError) throw error;
      if (error?.code !== 'ENOENT') stop('P2_STAGE1_CREATE_ONLY_ORPHAN_INVALID');
    }
    if (identity === undefined) {
      descriptor = openSync(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        modeValue,
      );
      writeFileSync(descriptor, bytes);
      fchmodSync(descriptor, modeValue);
      fsyncSync(descriptor);
      identity = fstatSync(descriptor);
      syncDirectoryPath(parent);
    }
    linkSync(temporary, target);
    published = true;
    syncDirectoryPath(parent);
    unlinkSync(temporary);
    syncDirectoryPath(parent);
    const readback = readHeld(target, { mode: modeValue, maximum: Math.max(bytes.length, 1) });
    try {
      if (!readback.equals(bytes)) stop('P2_STAGE1_CREATE_ONLY_READBACK_FAILED');
    } finally {
      readback.fill(0);
    }
    return Object.freeze({ state: 'CREATED', path: target, device: identity.dev, inode: identity.ino });
  } catch (error) {
    if (error instanceof Stage1ControllerError) throw error;
    stop('P2_STAGE1_CREATE_ONLY_FAILED');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!published) {
      try {
        const current = lstatSync(temporary);
        if (identity !== undefined && current.dev === identity.dev && current.ino === identity.ino) {
          unlinkSync(temporary);
          syncDirectoryPath(parent);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') stop('P2_STAGE1_CREATE_ONLY_FAILED');
      }
    }
  }
}

function removeCreated(entry) {
  if (entry?.state !== 'CREATED') return;
  try {
    const current = lstatSync(entry.path);
    if (
      current.isFile() && !current.isSymbolicLink() &&
      current.dev === entry.device && current.ino === entry.inode
    ) {
      unlinkSync(entry.path);
      syncDirectoryPath(dirname(entry.path));
    }
  } catch {
    // Compensation is best effort and never removes an identity it did not create.
  }
}

function catalogBytes(entry) {
  return Buffer.from(`${canonicalJson({ version: 1, credentials: [entry] })}\n`, 'utf8');
}

function catalogPreflight(root) {
  if (fixtureCredentialRoot !== undefined) return;
  const script = join(root, 'scripts/credential-catalog.py');
  try {
    execFileSync(script, ['validate'], {
      env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 30_000,
    });
  } catch {
    stop('P2_STAGE1_CATALOG_PREFLIGHT_FAILED');
  }
}

function readLuksRecoveryKey(root) {
  if (fixtureCredentialRoot !== undefined) {
    return readHeld(relativeCredentialPath(root, 'seori-auth/luks-recovery.key'), {
      mode: 0o600,
      maximum: 4096,
    });
  }
  catalogPreflight(root);
  const resolver = relativeCredentialPath(root, 'scripts/credential-catalog.py');
  let output;
  try {
    output = execFileSync(resolver, ['resolve', '--id', LUKS_RECOVERY_LOGICAL_ID], {
      encoding: 'utf8',
      env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    });
  } catch {
    stop('P2_STAGE1_LUKS_RECOVERY_CREDENTIAL_INVALID');
  }
  const entries = output.trim().split('\n').map((line) => {
    const separator = line.indexOf('=');
    if (separator < 1) stop('P2_STAGE1_LUKS_RECOVERY_CREDENTIAL_INVALID');
    return [line.slice(0, separator), line.slice(separator + 1)];
  });
  if (entries.length !== 4 || new Set(entries.map(([key]) => key)).size !== entries.length) {
    stop('P2_STAGE1_LUKS_RECOVERY_CREDENTIAL_INVALID');
  }
  const fields = Object.fromEntries(entries);
  if (
    Object.keys(fields).toSorted().join('\0') !==
      ['CREDENTIAL_ID', 'CREDENTIAL_PATH', 'CREDENTIAL_SCOPE', 'CREDENTIAL_STATUS']
        .toSorted().join('\0') ||
    fields.CREDENTIAL_ID !== LUKS_RECOVERY_LOGICAL_ID || fields.CREDENTIAL_SCOPE !== 'shared' ||
    fields.CREDENTIAL_STATUS !== 'active' || !isAbsolute(fields.CREDENTIAL_PATH ?? '')
  ) stop('P2_STAGE1_LUKS_RECOVERY_CREDENTIAL_INVALID');
  const relation = relative(root, fields.CREDENTIAL_PATH);
  if (
    relation.length === 0 || relation.startsWith('..') || isAbsolute(relation) ||
    relativeCredentialPath(root, relation) !== fields.CREDENTIAL_PATH
  ) stop('P2_STAGE1_LUKS_RECOVERY_CREDENTIAL_INVALID');
  const bytes = readHeld(fields.CREDENTIAL_PATH, { mode: 0o600, maximum: 4096 });
  if (bytes.length < 32) {
    bytes.fill(0);
    stop('P2_STAGE1_LUKS_RECOVERY_CREDENTIAL_INVALID');
  }
  return bytes;
}

function hashHeldRegular(
  path,
  { mode: modeValue, modes: modeValues, maximum = 16 * 1024 * 1024 * 1024 } = {},
) {
  let descriptor;
  try {
    if (
      modeValue !== undefined && modeValues !== undefined ||
      modeValues !== undefined && (
        !Array.isArray(modeValues) || modeValues.length === 0 ||
        modeValues.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 0o777)
      )
    ) stop('P2_STAGE1_POST_BACKUP_ARTIFACT_INVALID');
    const allowedModes = modeValues ?? (modeValue === undefined ? undefined : [modeValue]);
    const entry = lstatSync(path);
    if (
      !entry.isFile() || entry.isSymbolicLink() || realpathSync(path) !== path ||
      entry.nlink !== 1 || entry.uid !== process.geteuid?.() ||
      (allowedModes !== undefined && !allowedModes.includes(entry.mode & 0o777)) ||
      entry.size < 1 || entry.size > maximum
    ) stop('P2_STAGE1_POST_BACKUP_ARTIFACT_INVALID');
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const held = fstatSync(descriptor);
    if (
      held.dev !== entry.dev || held.ino !== entry.ino || held.mode !== entry.mode ||
      held.uid !== entry.uid || held.gid !== entry.gid || held.size !== entry.size ||
      held.nlink !== entry.nlink
    ) stop('P2_STAGE1_POST_BACKUP_ARTIFACT_INVALID');
    const digest = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < held.size) {
      const count = readSync(descriptor, chunk, 0, Math.min(chunk.length, held.size - offset), offset);
      if (count < 1) stop('P2_STAGE1_POST_BACKUP_ARTIFACT_INVALID');
      digest.update(chunk.subarray(0, count));
      offset += count;
    }
    chunk.fill(0);
    const after = fstatSync(descriptor);
    const current = lstatSync(path);
    if (
      after.dev !== held.dev || after.ino !== held.ino || after.mode !== held.mode ||
      after.uid !== held.uid || after.gid !== held.gid || after.size !== held.size ||
      after.nlink !== held.nlink || after.mtimeMs !== held.mtimeMs ||
      after.ctimeMs !== held.ctimeMs || current.dev !== held.dev ||
      current.ino !== held.ino || current.mode !== held.mode || current.size !== held.size ||
      current.mtimeMs !== held.mtimeMs || current.ctimeMs !== held.ctimeMs
    ) stop('P2_STAGE1_POST_BACKUP_ARTIFACT_DRIFT');
    return Object.freeze({ sha256: digest.digest('hex'), sizeBytes: held.size });
  } catch (error) {
    if (error instanceof Stage1ControllerError) throw error;
    stop('P2_STAGE1_POST_BACKUP_ARTIFACT_INVALID');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function exactBackupPath(path, expectedRoot) {
  try {
    const canonical = realpathSync(path);
    const canonicalRoot = realpathSync(expectedRoot);
    const relation = relative(canonicalRoot, canonical);
    if (relation.length === 0 || relation.startsWith('..') || isAbsolute(relation)) {
      stop('P2_STAGE1_POST_BACKUP_PATH_INVALID');
    }
    return canonical;
  } catch (error) {
    if (error instanceof Stage1ControllerError) throw error;
    stop('P2_STAGE1_POST_BACKUP_PATH_INVALID');
  }
}

function fixtureCanonicalBackup(root, attestor, encryption) {
  const timestamp = `fixture-${process.pid}`;
  const backupRoot = join(dirname(root), 'credential-backups');
  const beeRoot = join(dirname(root), 'beestation-backups');
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  mkdirSync(beeRoot, { recursive: true, mode: 0o700 });
  const name = `seorilabs-credentials-${timestamp}.tar.zst.gpg`;
  const archive = join(backupRoot, name);
  const beeArchive = join(beeRoot, name);
  const bytes = Buffer.from(canonicalJson({
    attestorLogicalCredentialId: stage1.attestor.logicalCredentialId,
    attestorFingerprintSha256: attestor.details.fingerprintSha256,
    encryptionLogicalCredentialId: stage1.tangBackupEncryption.logicalCredentialId,
    encryptionFingerprintSha256: encryption.details.fingerprintSha256,
  }));
  const digest = sha256(bytes);
  const checksum = Buffer.from(`${digest}  ${name}\n`, 'utf8');
  try {
    writeFileSync(archive, bytes, { mode: 0o600, flag: 'wx' });
    writeFileSync(`${archive}.sha256`, checksum, { mode: 0o600, flag: 'wx' });
    writeFileSync(beeArchive, bytes, { mode: 0o600, flag: 'wx' });
    writeFileSync(`${beeArchive}.sha256`, checksum, { mode: 0o600, flag: 'wx' });
  } finally {
    bytes.fill(0);
    checksum.fill(0);
  }
  return Object.freeze({
    archive: realpathSync(archive),
    archiveSha256: digest,
    fileCount: 6,
    beeArchive: realpathSync(beeArchive),
    backupRoot,
    beeRoot,
    passphraseSource: 'fixture',
  });
}

function runCanonicalPostBootstrapBackup(root, attestor, encryption) {
  const specification = stage1.attestor.postBootstrapBackup;
  if (fixtureCredentialRoot !== undefined) {
    return fixtureCanonicalBackup(root, attestor, encryption);
  }
  const backupScript = relativeCredentialPath(root, specification.backupScriptRelativePath);
  const restoreScript = relativeCredentialPath(root, specification.restoreScriptRelativePath);
  const backupBytes = readHeld(backupScript, { mode: 0o755, maximum: 1024 * 1024 });
  const restoreBytes = readHeld(restoreScript, { mode: 0o755, maximum: 1024 * 1024 });
  try {
    if (sha256(backupBytes) !== specification.backupScriptSha256 ||
        sha256(restoreBytes) !== specification.restoreScriptSha256) {
      stop('P2_STAGE1_POST_BACKUP_SCRIPT_DRIFT');
    }
  } finally {
    backupBytes.fill(0);
    restoreBytes.fill(0);
  }
  let output;
  try {
    output = execFileSync(backupScript, [], {
      encoding: 'utf8',
      env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024,
      timeout: 30 * 60 * 1000,
    });
  } catch {
    stop('P2_STAGE1_POST_BACKUP_FAILED');
  }
  const parsed = parseCanonicalCredentialBackupOutput(output);
  const backupRoot = join(homedir(), '.seorilabs-credential-backups');
  const beeRoot = join(
    homedir(),
    'Library/CloudStorage/BeeStation-ChaedaStation/vault/seorilabs-credentials/backups',
  );
  const archive = exactBackupPath(parsed.archivePath, backupRoot);
  const beeArchive = exactBackupPath(parsed.beeArchivePath, beeRoot);
  const archiveSha256 = parsed.archiveSha256;
  const fileCount = parsed.fileCount;
  if (!SHA256.test(archiveSha256 ?? '') || !Number.isSafeInteger(fileCount) || fileCount < 6) {
    stop('P2_STAGE1_POST_BACKUP_OUTPUT_INVALID');
  }
  let restoreOutput;
  try {
    restoreOutput = execFileSync(restoreScript, [archive], {
      encoding: 'utf8',
      env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024,
      timeout: 30 * 60 * 1000,
    });
  } catch {
    stop('P2_STAGE1_POST_BACKUP_RESTORE_FAILED');
  }
  const restore = parseCanonicalCredentialRestoreOutput(restoreOutput);
  if (
    restore.archiveSha256 !== archiveSha256 || restore.fileCount !== fileCount ||
    !['macos-keychain', 'beestation-recovery-file'].includes(restore.passphraseSource)
  ) stop('P2_STAGE1_POST_BACKUP_RESTORE_FAILED');
  return Object.freeze({
    archive,
    archiveSha256,
    fileCount,
    beeArchive,
    backupRoot,
    beeRoot,
    passphraseSource: restore.passphraseSource,
  });
}

function verifyPostBootstrapScripts(root) {
  if (fixtureCredentialRoot !== undefined) return;
  const specification = stage1.attestor.postBootstrapBackup;
  for (const [relativePath, expectedSha256] of [
    [specification.backupScriptRelativePath, specification.backupScriptSha256],
    [specification.restoreScriptRelativePath, specification.restoreScriptSha256],
  ]) {
    const bytes = readHeld(relativeCredentialPath(root, relativePath), {
      mode: 0o755,
      maximum: 1024 * 1024,
    });
    try {
      if (sha256(bytes) !== expectedSha256) stop('P2_STAGE1_POST_BACKUP_SCRIPT_DRIFT');
    } finally {
      bytes.fill(0);
    }
  }
}

function postBackupUnsigned(receipt) {
  const { signature: _signature, ...unsigned } = receipt;
  return unsigned;
}

function verifyPostBootstrapBackup(root, attestor, encryption) {
  const specification = stage1.attestor.postBootstrapBackup;
  verifyPostBootstrapScripts(root);
  const bytes = readHeld(
    relativeCredentialPath(root, specification.receiptRelativePath),
    { mode: Number.parseInt(specification.receiptMode, 8), maximum: 64 * 1024 },
  );
  try {
    const receipt = parsePublicJson(bytes.toString('utf8'), 'P2_STAGE1_POST_BACKUP_RECEIPT_INVALID');
    const expectedKeys = [
      'archivePath', 'archiveSha256', 'attestorFingerprintSha256',
      'attestorLogicalCredentialId', 'backupFileCount', 'backupScriptSha256',
      'beeArchivePath', 'beeArchiveSha256', 'beeChecksumSha256',
      'checksumSha256', 'encryptionFingerprintSha256', 'encryptionLogicalCredentialId',
      'isolatedRestoreVerified', 'passphraseSource', 'restoreScriptSha256', 'schemaVersion', 'signature',
      'state',
    ];
    if (
      Object.keys(receipt).toSorted().join('\0') !== expectedKeys.toSorted().join('\0') ||
      receipt.schemaVersion !== 1 || receipt.state !== 'P2_STAGE1_POST_BOOTSTRAP_BACKUP_VERIFIED' ||
      receipt.attestorLogicalCredentialId !== stage1.attestor.logicalCredentialId ||
      receipt.encryptionLogicalCredentialId !== stage1.tangBackupEncryption.logicalCredentialId ||
      receipt.attestorFingerprintSha256 !== attestor.details.fingerprintSha256 ||
      receipt.encryptionFingerprintSha256 !== encryption.details.fingerprintSha256 ||
      receipt.backupScriptSha256 !== specification.backupScriptSha256 ||
      receipt.restoreScriptSha256 !== specification.restoreScriptSha256 ||
      receipt.isolatedRestoreVerified !== true || !SHA256.test(receipt.archiveSha256 ?? '') ||
      !SHA256.test(receipt.beeArchiveSha256 ?? '') || !SHA256.test(receipt.checksumSha256 ?? '') ||
      !SHA256.test(receipt.beeChecksumSha256 ?? '') ||
      !Number.isSafeInteger(receipt.backupFileCount) || receipt.backupFileCount < 6 ||
      !(fixtureCredentialRoot === undefined
        ? ['macos-keychain', 'beestation-recovery-file'].includes(receipt.passphraseSource)
        : receipt.passphraseSource === 'fixture')
    ) stop('P2_STAGE1_POST_BACKUP_RECEIPT_INVALID');
    const signature = Buffer.from(receipt.signature ?? '', 'base64');
    if (signature.length !== 64 || signature.toString('base64') !== receipt.signature ||
        !verify(
          null,
          Buffer.from(canonicalJson(postBackupUnsigned(receipt)), 'utf8'),
          createPublicKey(attestor.publicKey),
          signature,
        )) stop('P2_STAGE1_POST_BACKUP_RECEIPT_INVALID');
    const archive = exactBackupPath(
      receipt.archivePath,
      fixtureCredentialRoot === undefined
        ? join(homedir(), '.seorilabs-credential-backups')
        : join(dirname(root), 'credential-backups'),
    );
    const beeArchive = exactBackupPath(
      receipt.beeArchivePath,
      fixtureCredentialRoot === undefined
        ? join(homedir(), 'Library/CloudStorage/BeeStation-ChaedaStation/vault/seorilabs-credentials/backups')
        : join(dirname(root), 'beestation-backups'),
    );
    const archiveReadback = hashHeldRegular(archive, { mode: 0o600 });
    const beeReadback = hashHeldRegular(beeArchive, { modes: [0o600, 0o700] });
    const checksum = readHeld(`${archive}.sha256`, { mode: 0o600, maximum: 4096 });
    const beeChecksum = readHeld(
      `${beeArchive}.sha256`,
      { modes: [0o600, 0o700], maximum: 4096 },
    );
    try {
      const expectedChecksum = `${receipt.archiveSha256}  ${basename(archive)}\n`;
      if (
        archive !== receipt.archivePath || beeArchive !== receipt.beeArchivePath ||
        archiveReadback.sha256 !== receipt.archiveSha256 ||
        beeReadback.sha256 !== receipt.beeArchiveSha256 ||
        receipt.archiveSha256 !== receipt.beeArchiveSha256 ||
        checksum.toString('utf8') !== expectedChecksum ||
        beeChecksum.toString('utf8') !== expectedChecksum ||
        sha256(checksum) !== receipt.checksumSha256 ||
        sha256(beeChecksum) !== receipt.beeChecksumSha256
      ) stop('P2_STAGE1_POST_BACKUP_ARTIFACT_DRIFT');
    } finally {
      checksum.fill(0);
      beeChecksum.fill(0);
      signature.fill(0);
    }
    return receipt;
  } finally {
    bytes.fill(0);
  }
}

function createPostBootstrapBackupReceipt(root, attestor, encryption) {
  const specification = stage1.attestor.postBootstrapBackup;
  const receiptPath = relativeCredentialPath(root, specification.receiptRelativePath);
  recoverPublishedCreateOnlyOrphan(
    receiptPath,
    Number.parseInt(specification.receiptMode, 8),
  );
  if (pathState(receiptPath) === 'PRESENT') {
    return Object.freeze({
      receipt: verifyPostBootstrapBackup(root, attestor, encryption),
      state: 'EXACT_READBACK',
    });
  }
  const backup = runCanonicalPostBootstrapBackup(root, attestor, encryption);
  const archive = hashHeldRegular(backup.archive, { mode: 0o600 });
  const beeArchive = hashHeldRegular(backup.beeArchive, { modes: [0o600, 0o700] });
  const checksum = readHeld(`${backup.archive}.sha256`, { mode: 0o600, maximum: 4096 });
  const beeChecksum = readHeld(
    `${backup.beeArchive}.sha256`,
    { modes: [0o600, 0o700], maximum: 4096 },
  );
  let signature;
  try {
    if (archive.sha256 !== backup.archiveSha256 || beeArchive.sha256 !== backup.archiveSha256) {
      stop('P2_STAGE1_POST_BACKUP_ARTIFACT_DRIFT');
    }
    const unsigned = Object.freeze({
      schemaVersion: 1,
      state: 'P2_STAGE1_POST_BOOTSTRAP_BACKUP_VERIFIED',
      attestorLogicalCredentialId: stage1.attestor.logicalCredentialId,
      attestorFingerprintSha256: attestor.details.fingerprintSha256,
      encryptionLogicalCredentialId: stage1.tangBackupEncryption.logicalCredentialId,
      encryptionFingerprintSha256: encryption.details.fingerprintSha256,
      archivePath: backup.archive,
      archiveSha256: archive.sha256,
      checksumSha256: sha256(checksum),
      beeArchivePath: backup.beeArchive,
      beeArchiveSha256: beeArchive.sha256,
      beeChecksumSha256: sha256(beeChecksum),
      backupFileCount: backup.fileCount,
      isolatedRestoreVerified: true,
      passphraseSource: backup.passphraseSource,
      backupScriptSha256: specification.backupScriptSha256,
      restoreScriptSha256: specification.restoreScriptSha256,
    });
    signature = sign(
      null,
      Buffer.from(canonicalJson(unsigned), 'utf8'),
      createPrivateKey(attestor.privateKey),
    );
    const receipt = Object.freeze({ ...unsigned, signature: signature.toString('base64') });
    const receiptBytes = Buffer.from(`${canonicalJson(receipt)}\n`, 'utf8');
    try {
      const state = writeCreateOnlyOrExact(
        root,
        specification.receiptRelativePath,
        receiptBytes,
        Number.parseInt(specification.receiptMode, 8),
      ).state;
      return Object.freeze({ receipt: verifyPostBootstrapBackup(root, attestor, encryption), state });
    } finally {
      receiptBytes.fill(0);
    }
  } finally {
    checksum.fill(0);
    beeChecksum.fill(0);
    signature?.fill(0);
  }
}

function assertPostBootstrapBackup(root) {
  const attestor = readAttestor(root);
  const encryption = readEncryption(root);
  try {
    return verifyPostBootstrapBackup(root, attestor, encryption);
  } finally {
    attestor.privateKey.fill(0);
    attestor.publicKey.fill(0);
    encryption.privateKey.fill(0);
    encryption.publicKey.fill(0);
  }
}

function collectLocalRuntimeManifest(runtimeRoot) {
  const entries = [];
  function visit(directory, prefix = '') {
    let directoryEntry;
    try {
      directoryEntry = lstatSync(directory);
      if (
        !directoryEntry.isDirectory() || directoryEntry.isSymbolicLink() ||
        realpathSync(directory) !== directory || directoryEntry.uid !== process.geteuid?.() ||
        (directoryEntry.mode & 0o777) !==
          Number.parseInt(stage1.localProcessBoundary.directoryMode, 8)
      ) stop('P2_STAGE1_LOCAL_RUNTIME_INVALID');
    } catch (error) {
      if (error instanceof Stage1ControllerError) throw error;
      stop('P2_STAGE1_LOCAL_RUNTIME_INVALID');
    }
    const children = readdirSync(directory, { withFileTypes: true })
      .toSorted((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      const relativePath = prefix === '' ? child.name : `${prefix}/${child.name}`;
      if (
        prefix === '' && child.name === stage1.localProcessBoundary.sourceReceiptLeaf
      ) continue;
      if (!safeRuntimeRelativePath(relativePath) || child.isSymbolicLink()) {
        stop('P2_STAGE1_LOCAL_RUNTIME_INVALID');
      }
      const path = join(directory, child.name);
      if (child.isDirectory()) {
        entries.push(Object.freeze({ path: relativePath, type: 'directory', mode: '0700' }));
        visit(path, relativePath);
        continue;
      }
      if (!child.isFile()) stop('P2_STAGE1_LOCAL_RUNTIME_INVALID');
      const entry = lstatSync(path);
      const modeValue = (entry.mode & 0o777).toString(8).padStart(4, '0');
      if (modeValue !== stage1.localProcessBoundary.sourceFileMode) {
        stop('P2_STAGE1_LOCAL_RUNTIME_INVALID');
      }
      const bytes = readHeld(path, {
        mode: Number.parseInt(modeValue, 8), maximum: 32 * 1024 * 1024, allowEmpty: true,
      });
      try {
        entries.push(Object.freeze({
          path: relativePath,
          type: 'file',
          mode: modeValue,
          size: bytes.length,
          sha256: sha256(bytes),
        }));
      } finally {
        bytes.fill(0);
      }
    }
  }
  visit(runtimeRoot);
  return entries;
}

function safeRuntimeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !isAbsolute(value) &&
    normalize(value) === value && !value.split(sep).some((part) => part === '..' || part === '');
}

function readLocalProcessContext() {
  const boundary = stage1.localProcessBoundary;
  const controllerExecutable = fileURLToPath(import.meta.url);
  const runtimeFleetRoot = join(homedir(), boundary.runtimeRootRelativePath);
  const relation = relative(runtimeFleetRoot, controllerExecutable);
  const parts = relation.split(sep);
  if (
    parts.length < 2 || !SHA40.test(parts[0] ?? '') ||
    parts.slice(1).join('/') !== boundary.controllerRelativePath ||
    realpathSync(controllerExecutable) !== controllerExecutable
  ) stop('P2_STAGE1_LOCAL_RUNTIME_INVALID');
  const sourceSha = parts[0];
  const runtimeRoot = join(runtimeFleetRoot, sourceSha);
  const receiptPath = join(runtimeRoot, boundary.sourceReceiptLeaf);
  const archivePath = join(runtimeRoot, boundary.sourceArchiveLeaf);
  const receiptBytes = readHeld(receiptPath, {
    mode: Number.parseInt(boundary.receiptMode, 8), maximum: 32 * 1024,
  });
  const controllerBytes = readHeld(controllerExecutable, {
    mode: Number.parseInt(boundary.sourceFileMode, 8), maximum: 4 * 1024 * 1024,
  });
  const archiveBytes = readHeld(archivePath, {
    mode: Number.parseInt(boundary.sourceFileMode, 8), maximum: 128 * 1024 * 1024,
  });
  try {
    const receipt = parsePublicJson(receiptBytes.toString('utf8'), 'P2_STAGE1_LOCAL_RUNTIME_INVALID');
    const exactKeys = [
      'archiveSha256', 'contractDigest', 'controllerRelativePath', 'controllerSha256',
      'packageLockSha256', 'runtimeFileCount', 'runtimeManifestSha256', 'schemaVersion',
      'secretExposed', 'sourceRepository', 'sourceSha', 'state',
    ];
    if (
      Object.keys(receipt).toSorted().join('\0') !== exactKeys.toSorted().join('\0') ||
      receipt.schemaVersion !== 1 || receipt.state !== 'P2_STAGE1_LOCAL_RUNTIME_READY' ||
      receipt.sourceRepository !== stage1.sourceRepository || receipt.sourceSha !== sourceSha ||
      receipt.contractDigest !== combinedDigest ||
      receipt.controllerRelativePath !== boundary.controllerRelativePath ||
      receipt.controllerSha256 !== sha256(controllerBytes) ||
      receipt.archiveSha256 !== sha256(archiveBytes) ||
      !SHA256.test(receipt.packageLockSha256 ?? '') ||
      !SHA256.test(receipt.runtimeManifestSha256 ?? '') ||
      !Number.isSafeInteger(receipt.runtimeFileCount) || receipt.runtimeFileCount < 1 ||
      receipt.secretExposed !== false
    ) stop('P2_STAGE1_LOCAL_RUNTIME_INVALID');
    const manifest = collectLocalRuntimeManifest(runtimeRoot);
    if (
      canonicalDigest(manifest) !== receipt.runtimeManifestSha256 ||
      manifest.filter(({ type }) => type === 'file').length !== receipt.runtimeFileCount
    ) stop('P2_STAGE1_LOCAL_RUNTIME_INVALID');
    return Object.freeze({
      trustedRoot: credentialRoot(),
      runtimeRoot,
      controllerExecutable,
      sourceSha,
      archiveSha256: receipt.archiveSha256,
      packageLockSha256: receipt.packageLockSha256,
      contractDigest: receipt.contractDigest,
      controllerSha256: receipt.controllerSha256,
      runtimeManifestSha256: receipt.runtimeManifestSha256,
      runtimeFileCount: receipt.runtimeFileCount,
      sourceReceiptSha256: sha256(receiptBytes),
      receipt,
    });
  } finally {
    receiptBytes.fill(0);
    controllerBytes.fill(0);
    archiveBytes.fill(0);
  }
}

function assertLocalProcessHardening() {
  if (fixtureCredentialRoot !== undefined) return undefined;
  if (localProcessContext !== undefined) return localProcessContext;
  try {
    const context = readLocalProcessContext();
    activateP2ProcessHardening(stage1.localProcessBoundary, {
      trustedRoot: context.trustedRoot,
      sourceSha: context.sourceSha,
      archiveSha256: context.archiveSha256,
      packageLockSha256: context.packageLockSha256,
      contractDigest: context.contractDigest,
      controllerSha256: context.controllerSha256,
      runtimeManifestSha256: context.runtimeManifestSha256,
      runtimeFileCount: context.runtimeFileCount,
      sourceReceiptSha256: context.sourceReceiptSha256,
      controllerExecutable: context.controllerExecutable,
    });
    localProcessContext = context;
    return context;
  } catch (error) {
    if (error instanceof Stage1ControllerError) throw error;
    stop('P2_STAGE1_LOCAL_PROCESS_HARDENING_REQUIRED');
  }
}

function readAttestor(root) {
  const privatePath = relativeCredentialPath(root, stage1.attestor.privateKeyRelativePath);
  const publicPath = relativeCredentialPath(root, stage1.attestor.publicKeyRelativePath);
  const privateKey = readHeld(privatePath, { mode: Number.parseInt(stage1.attestor.privateKeyMode, 8), maximum: 16 * 1024 });
  const publicKey = readHeld(publicPath, { mode: Number.parseInt(stage1.attestor.publicKeyMode, 8), maximum: 16 * 1024 });
  try {
    const publicDetails = verifyAttestorPair(privateKey, publicKey);
    return { privateKey, publicKey, publicDetails, details: publicDetails };
  } catch (error) {
    privateKey.fill(0);
    publicKey.fill(0);
    throw error;
  }
}

function readAttestorPublic(root) {
  const publicKey = readHeld(
    relativeCredentialPath(root, stage1.attestor.publicKeyRelativePath),
    { mode: Number.parseInt(stage1.attestor.publicKeyMode, 8), maximum: 16 * 1024 },
  );
  return { publicKey, publicDetails: attestorPublicDetails(publicKey) };
}

function readEncryption(root) {
  const specification = stage1.tangBackupEncryption;
  const privatePath = relativeCredentialPath(root, specification.privateKeyRelativePath);
  const publicPath = relativeCredentialPath(root, specification.publicKeyRelativePath);
  const privateKey = readHeld(privatePath, {
    mode: Number.parseInt(specification.privateKeyMode, 8), maximum: 16 * 1024,
  });
  const publicKey = readHeld(publicPath, {
    mode: Number.parseInt(specification.publicKeyMode, 8), maximum: 16 * 1024,
  });
  try {
    const publicDetails = verifyEncryptionPair(privateKey, publicKey);
    return { privateKey, publicKey, publicDetails, details: publicDetails };
  } catch (error) {
    privateKey.fill(0);
    publicKey.fill(0);
    throw error;
  }
}

function bootstrapAttestor() {
  allowedOptions(['confirmation', 'pre-backup-sha', 'pre-backup-file-count', 'pre-backup-restore-verified']);
  if (
    option('confirmation') !== confirmations().attestor ||
    option('pre-backup-sha') !== stage1.attestor.preBootstrapBackup.artifactSha256 ||
    option('pre-backup-file-count') !== String(stage1.attestor.preBootstrapBackup.fileCount) ||
    option('pre-backup-restore-verified') !== 'true'
  ) stop('P2_STAGE1_ATTESTOR_PRE_BACKUP_GATE_REQUIRED');
  assertLocalProcessHardening();
  const root = credentialRoot();
  const encryption = stage1.tangBackupEncryption;
  const created = [];
  const initialStates = [];
  let attestorPair;
  let encryptionPair;
  let postBackupStarted = false;

  function completePair(specification, algorithm) {
    const paths = {
      private: relativeCredentialPath(root, specification.privateKeyRelativePath),
      public: relativeCredentialPath(root, specification.publicKeyRelativePath),
      catalog: relativeCredentialPath(root, specification.catalogShardRelativePath),
    };
    recoverPublishedCreateOnlyOrphan(
      paths.private,
      Number.parseInt(specification.privateKeyMode, 8),
    );
    recoverPublishedCreateOnlyOrphan(
      paths.public,
      Number.parseInt(specification.publicKeyMode, 8),
    );
    recoverPublishedCreateOnlyOrphan(paths.catalog, 0o644);
    const state = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, pathState(path)]));
    initialStates.push(`${algorithm}:${state.private}:${state.public}:${state.catalog}`);
    if (state.private === 'ABSENT' && (state.public === 'PRESENT' || state.catalog === 'PRESENT')) {
      stop('P2_STAGE1_CREDENTIAL_HUMAN_RECOVERY_REQUIRED');
    }
    let privateKey;
    let publicKey;
    try {
      if (state.private === 'ABSENT') {
        const pair = generateKeyPairSync(algorithm);
        privateKey = Buffer.from(pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));
        publicKey = Buffer.from(pair.publicKey.export({ format: 'pem', type: 'spki' }));
        created.push(writeCreateOnlyOrExact(
          root, specification.privateKeyRelativePath, privateKey,
          Number.parseInt(specification.privateKeyMode, 8),
        ));
      } else {
        privateKey = readHeld(paths.private, {
          mode: Number.parseInt(specification.privateKeyMode, 8), maximum: 16 * 1024,
        });
        const privateObject = createPrivateKey(privateKey);
        if (privateObject.asymmetricKeyType !== algorithm) {
          stop('P2_STAGE1_CREDENTIAL_HUMAN_RECOVERY_REQUIRED');
        }
        publicKey = Buffer.from(createPublicKey(privateObject).export({ format: 'pem', type: 'spki' }));
      }
      if (state.public === 'PRESENT') {
        const existing = readHeld(paths.public, {
          mode: Number.parseInt(specification.publicKeyMode, 8), maximum: 16 * 1024,
        });
        try {
          if (!existing.equals(publicKey)) stop('P2_STAGE1_CREDENTIAL_HUMAN_RECOVERY_REQUIRED');
        } finally {
          existing.fill(0);
        }
      } else {
        created.push(writeCreateOnlyOrExact(
          root, specification.publicKeyRelativePath, publicKey,
          Number.parseInt(specification.publicKeyMode, 8),
        ));
      }
      const details = algorithm === 'ed25519'
        ? verifyAttestorPair(privateKey, publicKey)
        : verifyEncryptionPair(privateKey, publicKey);
      const entry = algorithm === 'ed25519'
        ? expectedAttestorCatalogEntry(stage1, details)
        : expectedEncryptionCatalogEntry(stage1, details);
      const bytes = catalogBytes(entry);
      try {
        created.push(writeCreateOnlyOrExact(root, specification.catalogShardRelativePath, bytes, 0o644));
      } finally {
        bytes.fill(0);
      }
      return { privateKey, publicKey, details };
    } catch (error) {
      privateKey?.fill(0);
      publicKey?.fill(0);
      if (error instanceof Stage1ControllerError) throw error;
      stop('P2_STAGE1_CREDENTIAL_HUMAN_RECOVERY_REQUIRED');
    }
  }

  try {
    attestorPair = completePair(stage1.attestor, 'ed25519');
    encryptionPair = completePair(encryption, 'x25519');
    catalogPreflight(root);
    postBackupStarted = true;
    const postBackup = createPostBootstrapBackupReceipt(
      root,
      attestorPair,
      encryptionPair,
    );
    const recovered = initialStates.some((value) => !value.endsWith(':PRESENT:PRESENT:PRESENT'));
    return Object.freeze({
      schemaVersion: 1,
      state: recovered ? 'STAGE1_CREDENTIALS_BOOTSTRAPPED_OR_RECOVERED' : 'STAGE1_CREDENTIALS_EXACT_READBACK',
      logicalCredentialId: stage1.attestor.logicalCredentialId,
      public: attestorPair.details,
      encryptionLogicalCredentialId: encryption.logicalCredentialId,
      encryptionPublic: encryptionPair.details,
      preBootstrapBackup: stage1.attestor.preBootstrapBackup,
      postBootstrapBackup: {
        state: postBackup.state,
        archiveSha256: postBackup.receipt.archiveSha256,
        backupFileCount: postBackup.receipt.backupFileCount,
        isolatedRestoreVerified: postBackup.receipt.isolatedRestoreVerified,
      },
      secretExposed: false,
    });
  } catch (error) {
    if (!postBackupStarted) {
      for (const entry of created.toReversed()) removeCreated(entry);
    }
    throw error;
  } finally {
    attestorPair?.privateKey.fill(0);
    attestorPair?.publicKey.fill(0);
    encryptionPair?.privateKey.fill(0);
    encryptionPair?.publicKey.fill(0);
  }
}

function commandEnvironment() {
  const environment = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
  if (fixtureRemoteRoot !== undefined) environment.SEORILABS_P2_STAGE1_FIXTURE_REMOTE_ROOT = fixtureRemoteRoot;
  if (fixtureLog !== undefined) environment.SEORILABS_P2_STAGE1_FIXTURE_LOG = fixtureLog;
  if (fixtureScenario !== undefined) {
    environment.SEORILABS_P2_STAGE1_FIXTURE_SCENARIO = fixtureScenario;
  }
  return environment;
}

function sshAuthentication() {
  const passwordFile = options.get('ssh-password-file');
  if (passwordFile === undefined) return null;
  const sourceSha = localProcessContext?.sourceSha;
  if (!SHA40.test(sourceSha ?? '')) stop('P2_STAGE1_LOCAL_PROCESS_HARDENING_REQUIRED');
  const relay = relativeCredentialPath(
    credentialRoot(),
    `${stage1.ssh.relayInstallRelativePath}-${sourceSha}`,
  );
  try {
    if (!isAbsolute(passwordFile)) stop('P2_STAGE1_PASSWORD_FILE_INVALID');
    const passwordEntry = lstatSync(passwordFile);
    const relayEntry = lstatSync(relay);
    if (
      !passwordEntry.isFile() || passwordEntry.isSymbolicLink() ||
      realpathSync(passwordFile) !== passwordFile || passwordEntry.uid !== process.geteuid?.() ||
      (passwordEntry.mode & 0o077) !== 0 || passwordEntry.size < 1 || passwordEntry.size > 4096 ||
      !relayEntry.isFile() || relayEntry.isSymbolicLink() || realpathSync(relay) !== relay ||
      relayEntry.uid !== process.geteuid?.() || relayEntry.nlink !== 1 ||
      (relayEntry.mode & 0o777) !== Number.parseInt(stage1.ssh.relayInstalledMode, 8)
    ) stop('P2_STAGE1_PASSWORD_FILE_INVALID');
    return Object.freeze({ passwordFile, relay });
  } catch (error) {
    if (error instanceof Stage1ControllerError) throw error;
    stop('P2_STAGE1_PASSWORD_FILE_INVALID');
  }
}

function sshArgs(machine, remoteCommand) {
  const authentication = sshAuthentication();
  const selectedOptions = authentication === null
    ? stage1.ssh.publicKeyOptions
    : stage1.ssh.relayOptions;
  return [
    ...[...stage1.ssh.commonOptions, ...selectedOptions].flatMap((value) => ['-o', value]),
    `${stage1.ssh.user}@${machine.ipv4}`,
    remoteCommand,
  ];
}

function runFixtureAware(executable, args, { input, maximum = MAX_PUBLIC_OUTPUT } = {}) {
  const runtime = fixtureRemoteRoot === undefined ? executable : process.execPath;
  const runtimeArgs = fixtureRemoteRoot === undefined ? args : [fixtureCommand, executable, ...args];
  const result = spawnSync(runtime, runtimeArgs, {
    input,
    encoding: 'utf8',
    env: commandEnvironment(),
    maxBuffer: maximum,
    timeout: 120_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || result.error !== undefined) stop('P2_STAGE1_REMOTE_OUTCOME_UNKNOWN');
  return result.stdout;
}

async function runPublicSsh(machine, remoteCommand, input, { privileged = false, stdoutFd } = {}) {
  if (fixtureRemoteRoot !== undefined) {
    if (stdoutFd === undefined) {
      return runFixtureAware(stage1.ssh.executable, sshArgs(machine, remoteCommand), { input });
    }
    const result = spawnSync(
      process.execPath,
      [fixtureCommand, stage1.ssh.executable, ...sshArgs(machine, remoteCommand)],
      { input, env: commandEnvironment(), stdio: ['pipe', stdoutFd, 'ignore'], timeout: 120_000 },
    );
    if (result.status !== 0 || result.error !== undefined) stop('P2_STAGE1_REMOTE_OUTCOME_UNKNOWN');
    return '';
  }
  const authentication = sshAuthentication();
  if (authentication !== null && privileged && input !== undefined) {
    stop('P2_STAGE1_PRIVILEGED_INPUT_NOT_SEPARATED');
  }
  const runtime = authentication === null ? stage1.ssh.executable : authentication.relay;
  const runtimeArgs = authentication === null
    ? sshArgs(machine, remoteCommand)
    : ['relay', machine.nodeName, authentication.passwordFile, privileged ? '1' : '0', remoteCommand];
  const child = spawn(runtime, runtimeArgs, {
    env: commandEnvironment(),
    stdio: ['pipe', stdoutFd === undefined ? 'pipe' : stdoutFd, 'pipe'],
  });
  const chunks = [];
  let outputSize = 0;
  if (stdoutFd === undefined) {
    child.stdout.on('data', (chunk) => {
      outputSize += chunk.length;
      if (outputSize <= MAX_PUBLIC_OUTPUT) chunks.push(Buffer.from(chunk));
    });
  }
  child.stderr.resume();
  if (input !== undefined) child.stdin.write(input);
  child.stdin.end();
  const status = await new Promise((resolve) => child.once('close', resolve));
  if (status !== 0 || outputSize > MAX_PUBLIC_OUTPUT) {
    let publicCode;
    if (outputSize <= 4096 && chunks.length > 0) {
      try {
        const failure = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (
          failure !== null && typeof failure === 'object' && !Array.isArray(failure) &&
          Object.keys(failure).toSorted().join('\0') === ['code', 'ok'].join('\0') &&
          failure.ok === false &&
          /^(?:P2_|KUBECONFIG_|KUBECTL_|STATE_)[A-Z0-9_]+$/u.test(failure.code ?? '')
        ) publicCode = failure.code;
      } catch {
        // Arbitrary remote output is discarded and never reflected.
      }
    }
    for (const chunk of chunks) chunk.fill(0);
    if (publicCode !== undefined) stop(publicCode);
    stop('P2_STAGE1_REMOTE_OUTCOME_UNKNOWN');
  }
  const output = stdoutFd === undefined ? Buffer.concat(chunks).toString('utf8') : '';
  for (const chunk of chunks) chunk.fill(0);
  return output;
}

async function preparePrivilegedInput(machine, input) {
  if (!Buffer.isBuffer(input) || input.length < 1 || input.length > 128 * 1024 * 1024) {
    stop('P2_STAGE1_REMOTE_PAYLOAD_INVALID');
  }
  if (fixtureRemoteRoot !== undefined || sshAuthentication() === null) {
    return Object.freeze({ input, remotePath: null });
  }
  const digest = sha256(input);
  const remotePath = `${stage1.sourceBootstrap.incomingRoot}/relay-input-${digest}.payload`;
  await runPublicSsh(
    machine,
    `/usr/bin/install -d -m 0700 ${stage1.sourceBootstrap.incomingRoot}`,
  );
  const readbackScript = readFileSync(relayPayloadReadbackScript);
  const readbackCommand = `/bin/bash -s -- --payload=${remotePath} --sha=${digest}`;
  const before = parsePublicJson(
    await runPublicSsh(machine, readbackCommand, readbackScript),
    'P2_STAGE1_REMOTE_PAYLOAD_READBACK_INVALID',
  );
  if (before.state === 'ABSENT') {
    await runPublicSsh(
      machine,
      `/bin/bash -c 'umask 077 && exec /usr/bin/dd of=${remotePath} status=none conv=excl'`,
      input,
    );
  } else if (before.state !== 'EXACT_READBACK') {
    stop('P2_STAGE1_REMOTE_PAYLOAD_DRIFT');
  }
  const after = parsePublicJson(
    await runPublicSsh(machine, readbackCommand, readbackScript),
    'P2_STAGE1_REMOTE_PAYLOAD_READBACK_INVALID',
  );
  if (after.state !== 'EXACT_READBACK') stop('P2_STAGE1_REMOTE_PAYLOAD_READBACK_INVALID');
  return Object.freeze({ input: undefined, remotePath });
}

function remoteRoot(sourceSha) {
  if (!SHA40.test(sourceSha ?? '')) stop('P2_STAGE1_SOURCE_SHA_INVALID');
  return `${stage1.sourceBootstrap.installRoot}/${sourceSha}`;
}

function remoteHostHelper(sourceSha) {
  return `${remoteRoot(sourceSha)}/scripts/fleet/p2-stage1-tang-backup.mjs`;
}

function remoteHostEncryptionHelper(sourceSha) {
  return `${remoteRoot(sourceSha)}/scripts/fleet/provision-p2-host-encryption.mjs`;
}

function remoteTangHelper(sourceSha) {
  return `${remoteRoot(sourceSha)}/scripts/fleet/provision-p2-tang-server.mjs`;
}

function remoteNativeHelper(sourceSha) {
  if (!SHA40.test(sourceSha ?? '')) stop('P2_STAGE1_SOURCE_SHA_INVALID');
  return stage1.hostProcessBoundary.launcherExecutable;
}

function nativeNodeCommand(
  sourceSha,
  script,
  arguments_,
  remoteInputPath,
  { publicErrors = false } = {},
) {
  const passwordRelay = sshAuthentication() !== null;
  const sudo = passwordRelay ? "sudo -S -p ''" : 'sudo -n';
  const input = remoteInputPath === null
    ? '3<&0'
    : remoteInputPath === undefined && !passwordRelay ? '3<&0'
      : remoteInputPath === undefined ? '3</dev/null' : `3< ${remoteInputPath}`;
  const standardInput = passwordRelay ? ' </dev/null' : '';
  const effectiveArguments = publicErrors
    ? `${arguments_} --public-error-channel=stdout`
    : arguments_;
  return `${sudo} /bin/sh -c 'exec ${remoteNativeHelper(sourceSha)} launch -- ` +
    `/usr/local/bin/node ${script} ${effectiveArguments} ${input}${standardInput}'`;
}

function privilegedCatCommand(path) {
  const sudo = sshAuthentication() === null ? 'sudo -n' : "sudo -S -p ''";
  return sshAuthentication() === null
    ? `${sudo} /bin/cat -- ${path}`
    : `${sudo} /bin/sh -c 'exec /bin/cat -- ${path} </dev/null'`;
}

function parsePublicJson(text, code) {
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) stop(code);
    if (
      Object.keys(value).toSorted().join('\0') === ['code', 'ok'].join('\0') &&
      value.ok === false &&
      /^(?:P2_|KUBECONFIG_|KUBECTL_|STATE_)[A-Z0-9_]+$/u.test(value.code ?? '')
    ) stop(value.code);
    return value;
  } catch (error) {
    if (error instanceof Stage1ControllerError) throw error;
    stop(code);
  }
}

function localTangPaths(machine) {
  const root = `${stage1.tangBackup.localRelativeRoot}/${machine.nodeName}`;
  return Object.freeze({
    artifact: `${root}/${stage1.tangBackup.archiveSuffix}`,
    evidence: `${root}/${stage1.tangBackup.evidenceSuffix}`,
    serverAttestation: `${root}/${stage1.tangBackup.serverAttestationSuffix}`,
    catalog: machine.backupCatalogShardRelativePath,
  });
}

async function copyRemoteArtifact(machine, remotePath, root, relativePath, expectedSha256) {
  const target = relativeCredentialPath(root, relativePath);
  ensureParent(root, target);
  if (pathState(target) === 'PRESENT') {
    const bytes = readHeld(target, { mode: 0o600 });
    try {
      if (sha256(bytes) !== expectedSha256) stop('P2_STAGE1_LOCAL_BACKUP_DRIFT');
    } finally {
      bytes.fill(0);
    }
    return 'EXACT_READBACK';
  }
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.transfer`);
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const remoteCommand = privilegedCatCommand(remotePath);
    await runPublicSsh(machine, remoteCommand, undefined, { privileged: true, stdoutFd: descriptor });
    fsyncSync(descriptor);
    const transferred = readHeld(temporary, { mode: 0o600 });
    try {
      if (sha256(transferred) !== expectedSha256) stop('P2_STAGE1_REMOTE_ARTIFACT_DIGEST_MISMATCH');
    } finally {
      transferred.fill(0);
    }
    linkSync(temporary, target);
    unlinkSync(temporary);
    const readback = readHeld(target, { mode: 0o600 });
    try {
      if (sha256(readback) !== expectedSha256) stop('P2_STAGE1_LOCAL_BACKUP_DRIFT');
    } finally {
      readback.fill(0);
    }
    return 'CREATED';
  } catch (error) {
    if (error instanceof Stage1ControllerError) throw error;
    stop('P2_STAGE1_REMOTE_ARTIFACT_OUTCOME_UNKNOWN');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') stop('P2_STAGE1_REMOTE_ARTIFACT_OUTCOME_UNKNOWN');
    }
  }
}

async function backupTang() {
  allowedOptions(['server', 'source-sha', 'confirmation', 'ssh-password-file']);
  const { machine, server } = tangServer();
  const sourceSha = option('source-sha');
  if (!SHA40.test(sourceSha) || option('confirmation') !== confirmations().tang[server.nodeName]) {
    stop('P2_STAGE1_BACKUP_CONFIRMATION_REQUIRED');
  }
  assertLocalProcessHardening();
  const root = credentialRoot();
  assertPostBootstrapBackup(root);
  catalogPreflight(root);
  const attestor = readAttestor(root);
  const encryption = readEncryption(root);
  try {
    const helper = remoteHostHelper(sourceSha);
    const plan = parsePublicJson(await runPublicSsh(
      machine,
      nativeNodeCommand(sourceSha, helper, `plan --server=${server.nodeName}`),
      undefined,
      { privileged: true },
    ), 'P2_STAGE1_REMOTE_PLAN_INVALID');
    if (
      plan.contractDigest !== combinedDigest ||
      plan.confirmations?.backup !== confirmations().tang[server.nodeName]
    ) stop('P2_STAGE1_REMOTE_CONTRACT_DRIFT');
    const state = parsePublicJson(await runPublicSsh(
      machine,
      nativeNodeCommand(sourceSha, helper, `backup-state --server=${server.nodeName}`),
      undefined,
      { privileged: true },
    ), 'P2_STAGE1_REMOTE_STATE_INVALID');
    const command = state.state === 'BACKUP_ABSENT' ? 'backup-verify' :
      ['BACKUP_PRESENT_VERIFY_FIRST', 'BACKUP_ARTIFACT_PRESENT_EVIDENCE_RECOVERABLE']
          .includes(state.state)
        ? 'verify-existing'
        : undefined;
    if (command === undefined) stop('P2_STAGE1_REMOTE_STATE_INVALID');
    const encryptionInput = await preparePrivilegedInput(machine, encryption.publicKey);
    const result = parsePublicJson(await runPublicSsh(
      machine,
      nativeNodeCommand(sourceSha, helper, `${command} --server=${server.nodeName} ` +
        `--confirmation=${confirmations().tang[server.nodeName]}`, encryptionInput.remotePath),
      encryptionInput.input,
      { privileged: true },
    ), 'P2_STAGE1_REMOTE_BACKUP_RESULT_INVALID');
    if (
      result.state !== 'TANG_SCOPED_ENCRYPTED_BACKUP_RECORDED' ||
      result.nodeName !== server.nodeName || !SHA256.test(result.backupArtifactSha256 ?? '') ||
      !SHA256.test(result.inventoryEvidenceSha256 ?? '') || result.secretExposed !== false ||
      result.recipientPublicKeySha256 !== encryption.publicDetails.fingerprintSha256
    ) stop('P2_STAGE1_REMOTE_BACKUP_RESULT_INVALID');

    const remoteBase = `${stage1.tangBackup.remoteRoot}/${server.nodeName}`;
    const paths = localTangPaths(machine);
    const artifactState = await copyRemoteArtifact(
      machine,
      `${remoteBase}.${stage1.tangBackup.archiveSuffix}`,
      root,
      paths.artifact,
      result.backupArtifactSha256,
    );
    const liveEvidence = parsePublicJson(await runPublicSsh(
      machine,
      privilegedCatCommand(`${remoteBase}.live-evidence.json`),
      undefined,
      { privileged: true },
    ), 'P2_STAGE1_PRIVATE_EVIDENCE_INVALID');
    if (
      liveEvidence.backupArtifactSha256 !== result.backupArtifactSha256 ||
      liveEvidence.inventoryEvidenceSha256 !== result.inventoryEvidenceSha256 ||
      liveEvidence.recipientPublicKeySha256 !== encryption.publicDetails.fingerprintSha256 ||
      liveEvidence.rootRestoreContentSha256 !== liveEvidence.liveContentSha256 ||
      liveEvidence.rootRestoreMetadataSha256 !== liveEvidence.liveMetadataSha256 ||
      liveEvidence.rootRestoreInventoryEvidenceSha256 !==
        liveEvidence.inventoryEvidenceSha256
    ) stop('P2_STAGE1_PRIVATE_EVIDENCE_INVALID');
    const artifact = readHeld(relativeCredentialPath(root, paths.artifact), { mode: 0o600 });
    const restoreParent = mkdtempSync(join(tmpdir(), 'seorilabs-p2-tang-restore-'));
    let payload;
    let restored;
    try {
      payload = decryptTangBackup({
        contract: stage1,
        server,
        artifactBytes: artifact,
        recipientPrivateKeyBytes: encryption.privateKey,
        recipientPublicKeyBytes: encryption.publicKey,
      });
      restored = isolatedRestoreInventory({
        payload,
        temporaryParent: restoreParent,
        applyOwnership: false,
      });
    } finally {
      if (payload !== undefined) for (const file of payload.files) file.content = '';
      artifact.fill(0);
      rmSync(restoreParent, { recursive: true, force: true });
    }
    const privateEvidence = buildVerifiedPrivateEvidence({
      server,
      artifactSha256: result.backupArtifactSha256,
      live: {
        contentSha256: liveEvidence.liveContentSha256,
        metadataSha256: liveEvidence.liveMetadataSha256,
        inventoryEvidenceSha256: liveEvidence.inventoryEvidenceSha256,
      },
      restored,
      rootRestored: {
        contentSha256: liveEvidence.rootRestoreContentSha256,
        metadataSha256: liveEvidence.rootRestoreMetadataSha256,
        inventoryEvidenceSha256: liveEvidence.rootRestoreInventoryEvidenceSha256,
      },
    });
    const signed = signTangPrivateEvidence({
      hostContract,
      server,
      privateEvidence,
      privateKeyBytes: attestor.privateKey,
      publicKeyBytes: attestor.publicKey,
    });
    const publicPayload = Buffer.from(`${canonicalJson({
      publicKeyPem: attestor.publicKey.toString('utf8'),
      attestation: signed,
    })}\n`, 'utf8');
    try {
      const evidenceInput = await preparePrivilegedInput(machine, publicPayload);
      const installed = parsePublicJson(await runPublicSsh(
        machine,
        nativeNodeCommand(sourceSha, helper, `install-evidence --server=${server.nodeName} ` +
          `--confirmation=${confirmations().tangInstall[server.nodeName]}`, evidenceInput.remotePath),
        evidenceInput.input,
        { privileged: true },
      ), 'P2_STAGE1_REMOTE_EVIDENCE_INSTALL_INVALID');
      if (installed.state !== 'TANG_BACKUP_EVIDENCE_INSTALLED') {
        stop('P2_STAGE1_REMOTE_EVIDENCE_INSTALL_INVALID');
      }
    } finally {
      publicPayload.fill(0);
    }
    const remoteAttestationPath = `${stage1.tangBackup.hostAttestationRoot}/${server.nodeName}.json`;
    const serverAttestation = parsePublicJson(await runPublicSsh(
      machine,
      nativeNodeCommand(sourceSha, remoteTangHelper(sourceSha),
        `readback --server=${server.nodeName} --backup-attestation=${remoteAttestationPath}`),
      undefined,
      { privileged: true },
    ), 'P2_STAGE1_TANG_SERVER_ATTESTATION_INVALID');
    validateTangServerAttestation(hostContract, serverAttestation, attestor.publicKey);

    const evidenceBytes = Buffer.from(`${canonicalJson(signed)}\n`, 'utf8');
    const serverBytes = Buffer.from(`${canonicalJson(serverAttestation)}\n`, 'utf8');
    try {
      const evidenceState = writeCreateOnlyOrExact(root, paths.evidence, evidenceBytes, 0o600).state;
      const serverState = writeCreateOnlyOrExact(root, paths.serverAttestation, serverBytes, 0o600).state;
      const entry = expectedTangCatalogEntry(stage1, server, privateEvidence, serverAttestation);
      const shard = catalogBytes(entry);
      let catalogState;
      try {
        catalogState = writeCreateOnlyOrExact(root, paths.catalog, shard, 0o644).state;
      } finally {
        shard.fill(0);
      }
      catalogPreflight(root);
      return Object.freeze({
        schemaVersion: 1,
        state: 'TANG_BACKUP_SIGNED_AND_CATALOGED',
        nodeName: server.nodeName,
        logicalCredentialId: server.backupLogicalId,
        signerPublicKeySha256: attestor.publicDetails.fingerprintSha256,
        backupArtifactSha256: result.backupArtifactSha256,
        inventoryEvidenceSha256: result.inventoryEvidenceSha256,
        serverAttestationDigest: serverAttestation.observedDigest,
        artifactState,
        evidenceState,
        serverState,
        catalogState,
        secretExposed: false,
      });
    } finally {
      evidenceBytes.fill(0);
      serverBytes.fill(0);
    }
  } finally {
    attestor.privateKey.fill(0);
    attestor.publicKey.fill(0);
    encryption.privateKey.fill(0);
    encryption.publicKey.fill(0);
  }
}

async function provisionTang() {
  allowedOptions(['server', 'source-sha', 'confirmation', 'ssh-password-file']);
  assertLocalProcessHardening();
  assertPostBootstrapBackup(credentialRoot());
  const { machine, server } = tangServer();
  const sourceSha = option('source-sha');
  const expectedConfirmation = confirmations().tangProvision[server.nodeName];
  if (!SHA40.test(sourceSha) || option('confirmation') !== expectedConfirmation) {
    stop('P2_STAGE1_TANG_PROVISION_CONFIRMATION_REQUIRED');
  }
  const helper = remoteTangHelper(sourceSha);
  const plan = parsePublicJson(await runPublicSsh(
    machine,
    nativeNodeCommand(sourceSha, helper, `plan --server=${server.nodeName}`),
    undefined,
    { privileged: true },
  ), 'P2_STAGE1_TANG_PROVISION_PLAN_INVALID');
  if (
    plan.state !== 'DRY_RUN' || plan.contractDigest !== contractDigest(hostContract) ||
    plan.confirmation !== expectedConfirmation || plan.server?.nodeName !== server.nodeName
  ) stop('P2_STAGE1_TANG_PROVISION_PLAN_INVALID');
  const result = parsePublicJson(await runPublicSsh(
    machine,
    nativeNodeCommand(
      sourceSha,
      helper,
      `apply --server=${server.nodeName} --confirmation=${expectedConfirmation}`,
    ),
    undefined,
    { privileged: true },
  ), 'P2_STAGE1_TANG_PROVISION_RESULT_INVALID');
  if (
    result.state !== 'TANG_SERVER_KEYS_BACKUP_REQUIRED' ||
    result.contractDigest !== contractDigest(hostContract) || result.nodeName !== server.nodeName ||
    result.hostname !== server.expectedHostname || result.ipv4 !== server.ipv4 ||
    result.port !== server.port || result.url !== server.url ||
    result.requiredBackupLogicalId !== server.backupLogicalId ||
    typeof result.packageVersion !== 'string' || result.packageVersion.length < 1 ||
    !Array.isArray(result.signingKeyThumbprints) || result.signingKeyThumbprints.length !== 1 ||
    !/^[A-Za-z0-9_-]{43}$/u.test(result.signingKeyThumbprints[0] ?? '') ||
    !SHA256.test(result.advertisementSha256 ?? '') ||
    result.keyInventory?.directory !== server.keyDirectory ||
    !Number.isSafeInteger(result.keyInventory?.fileCount) || result.keyInventory.fileCount < 2 ||
    !SHA256.test(result.keyInventory?.inventoryEvidenceSha256 ?? '') ||
    result.keyInventory?.backupLogicalId !== server.backupLogicalId ||
    result.secretValuesReturned !== false
  ) stop('P2_STAGE1_TANG_PROVISION_RESULT_INVALID');
  return Object.freeze(result);
}

async function deliverRpi5() {
  allowedOptions(['source-sha', 'confirmation', 'ssh-password-file']);
  assertLocalProcessHardening();
  const sourceSha = option('source-sha');
  if (!SHA40.test(sourceSha) || option('confirmation') !== confirmations().rpi5) {
    stop('P2_STAGE1_INSTALL_CONFIRMATION_REQUIRED');
  }
  const root = credentialRoot();
  assertPostBootstrapBackup(root);
  catalogPreflight(root);
  const attestor = readAttestorPublic(root);
  try {
    const attestations = hostContract.tang.servers.map((server) => {
      const machine = host(server.nodeName, 'tang');
      const path = relativeCredentialPath(root, localTangPaths(machine).serverAttestation);
      return parsePublicJson(readHeld(path, { mode: 0o600 }).toString('utf8'),
        'P2_STAGE1_TANG_SERVER_ATTESTATION_INVALID');
    });
    const validated = validateTangFleetAttestations(hostContract, attestations, attestor.publicKey);
    const payload = Buffer.from(`${canonicalJson({
      publicKeyPem: attestor.publicKey.toString('utf8'),
      tangAttestations: validated,
    })}\n`, 'utf8');
    try {
      const machine = host(hostContract.target.nodeName, 'state-host');
      const rpi5Input = await preparePrivilegedInput(machine, payload);
      const result = parsePublicJson(await runPublicSsh(
        machine,
        nativeNodeCommand(sourceSha, remoteHostHelper(sourceSha),
          `install-rpi5-evidence --confirmation=${confirmations().rpi5}`, rpi5Input.remotePath),
        rpi5Input.input,
        { privileged: true },
      ), 'P2_STAGE1_RPI5_EVIDENCE_INSTALL_INVALID');
      if (
        result.state !== 'RPI5_TANG_TRUST_EVIDENCE_INSTALLED' ||
        result.signerPublicKeySha256 !== attestor.publicDetails.fingerprintSha256
      ) stop('P2_STAGE1_RPI5_EVIDENCE_INSTALL_INVALID');
      return result;
    } finally {
      payload.fill(0);
    }
  } finally {
    attestor.publicKey.fill(0);
  }
}

function tangAttestationPaths() {
  return hostContract.tang.servers.map(({ nodeName }) =>
    `${stage1.tangBackup.hostAttestationRoot}/${nodeName}.json`);
}

async function remoteHostEncryptionReadback(sourceSha, action = 'readback') {
  const machine = host(hostContract.target.nodeName, 'state-host');
  const command = [
    action,
    `--kubeconfig=${HOST_KUBECONFIG}`,
    ...tangAttestationPaths().map((path) => `--tang-attestation=${path}`),
  ].join(' ');
  const result = parsePublicJson(await runPublicSsh(
    machine,
    nativeNodeCommand(
      sourceSha,
      remoteHostEncryptionHelper(sourceSha),
      command,
      undefined,
      { publicErrors: true },
    ),
    undefined,
    { privileged: true },
  ), 'P2_STAGE1_HOST_ENCRYPTION_READBACK_INVALID');
  if (action === 'reboot-readback') {
    const rebootKeys = [
      'schemaVersion', 'state', 'nodeName', 'contractDigest', 'previousBootId',
      'currentBootId', 'provisionedDigest', 'hostEncryptionDigest', 'observedDigest',
    ];
    if (
      Object.keys(result).toSorted().join('\0') !== rebootKeys.toSorted().join('\0') ||
      result.schemaVersion !== 1 || result.state !== 'HOST_ENCRYPTED_MOUNT_REBOOT_VERIFIED' ||
      result.nodeName !== hostContract.target.nodeName ||
      result.contractDigest !== contractDigest(hostContract) ||
      !SHA256.test(result.observedDigest ?? '')
    ) stop('P2_STAGE1_HOST_ENCRYPTION_REBOOT_READBACK_INVALID');
    return Object.freeze(result);
  }
  const missingKeys = [
    'schemaVersion', 'state', 'nodeName', 'contractDigest', 'targetEmpty',
  ];
  const verifiedKeys = [
    'schemaVersion', 'state', 'nodeName', 'contractDigest', 'identity', 'luksUuid',
    'sourceIdentity', 'mapperBacking', 'mount', 'clevis', 'stateVolumeAttestation',
    'hostEncryption',
  ];
  const expectedKeys = result.state === 'HOST_ENCRYPTED_MOUNT_MISSING'
    ? missingKeys
    : result.state === 'HOST_ENCRYPTED_MOUNT_VERIFIED' ? verifiedKeys : undefined;
  if (
    expectedKeys === undefined ||
    Object.keys(result).toSorted().join('\0') !== expectedKeys.toSorted().join('\0') ||
    result.schemaVersion !== 1 || result.nodeName !== hostContract.target.nodeName ||
    result.contractDigest !== contractDigest(hostContract) ||
    (result.state === 'HOST_ENCRYPTED_MOUNT_MISSING' && result.targetEmpty !== true)
  ) stop('P2_STAGE1_HOST_ENCRYPTION_READBACK_INVALID');
  return Object.freeze(result);
}

async function hostEncryptionReadback() {
  allowedOptions(['source-sha', 'ssh-password-file']);
  const sourceSha = option('source-sha');
  if (!SHA40.test(sourceSha)) stop('P2_STAGE1_SOURCE_SHA_INVALID');
  assertLocalProcessHardening();
  return remoteHostEncryptionReadback(sourceSha);
}

async function remoteHostEncryptionBackupState(sourceSha) {
  const machine = host(hostContract.target.nodeName, 'state-host');
  const command = `backup-state --kubeconfig=${HOST_KUBECONFIG}`;
  const result = parsePublicJson(await runPublicSsh(
    machine,
    nativeNodeCommand(
      sourceSha,
      remoteHostEncryptionHelper(sourceSha),
      command,
      undefined,
      { publicErrors: true },
    ),
    undefined,
    { privileged: true },
  ), 'P2_STAGE1_HOST_ENCRYPTION_BACKUP_READBACK_INVALID');
  if (result.state === 'HOST_PRE_BACKUP_MISSING') {
    const expected = ['schemaVersion', 'state', 'nodeName', 'contractDigest', 'targetEmpty'];
    if (
      Object.keys(result).toSorted().join('\0') !== expected.toSorted().join('\0') ||
      result.schemaVersion !== 1 || result.nodeName !== hostContract.target.nodeName ||
      result.contractDigest !== contractDigest(hostContract) || result.targetEmpty !== true
    ) stop('P2_STAGE1_HOST_ENCRYPTION_BACKUP_READBACK_INVALID');
    return Object.freeze(result);
  }
  try {
    return validatePreProvisionBackupAttestation(hostContract, result);
  } catch {
    stop('P2_STAGE1_HOST_ENCRYPTION_BACKUP_READBACK_INVALID');
  }
}

function publicBackupReceipt(attestation) {
  return Object.freeze({
    schemaVersion: 1,
    state: 'P2_STAGE1_HOST_ENCRYPTION_BACKUP_VERIFIED',
    nodeName: hostContract.target.nodeName,
    contractDigest: contractDigest(hostContract),
    preBackupDigest: attestation.observedDigest,
    secretExposed: false,
  });
}

async function hostEncryptionBackup() {
  allowedOptions(['source-sha', 'confirmation', 'ssh-password-file']);
  const sourceSha = option('source-sha');
  if (!SHA40.test(sourceSha)) stop('P2_STAGE1_SOURCE_SHA_INVALID');
  if (option('confirmation') !== hostProvisioningConfirmations(hostContract).backup) {
    stop('P2_STAGE1_HOST_ENCRYPTION_BACKUP_CONFIRMATION_REQUIRED');
  }
  assertLocalProcessHardening();
  assertPostBootstrapBackup(credentialRoot());
  const before = await remoteHostEncryptionBackupState(sourceSha);
  if (before.state !== 'HOST_PRE_BACKUP_MISSING') return publicBackupReceipt(before);
  const machine = host(hostContract.target.nodeName, 'state-host');
  const command = `backup --confirmation=${option('confirmation')} --kubeconfig=${HOST_KUBECONFIG}`;
  const result = parsePublicJson(await runPublicSsh(
    machine,
    nativeNodeCommand(
      sourceSha,
      remoteHostEncryptionHelper(sourceSha),
      command,
      undefined,
      { publicErrors: true },
    ),
    undefined,
    { privileged: true },
  ), 'P2_STAGE1_HOST_ENCRYPTION_BACKUP_OUTCOME_UNKNOWN');
  let validated;
  try {
    validated = validatePreProvisionBackupAttestation(hostContract, result);
  } catch {
    stop('P2_STAGE1_HOST_ENCRYPTION_BACKUP_OUTCOME_UNKNOWN');
  }
  const after = await remoteHostEncryptionBackupState(sourceSha);
  if (after.observedDigest !== validated.observedDigest) {
    stop('P2_STAGE1_HOST_ENCRYPTION_BACKUP_OUTCOME_UNKNOWN');
  }
  return publicBackupReceipt(after);
}

async function hostEncryptionApply() {
  allowedOptions(['source-sha', 'confirmation', 'ssh-password-file']);
  const sourceSha = option('source-sha');
  if (!SHA40.test(sourceSha)) stop('P2_STAGE1_SOURCE_SHA_INVALID');
  if (option('confirmation') !== hostProvisioningConfirmations(hostContract).apply) {
    stop('P2_STAGE1_HOST_ENCRYPTION_APPLY_CONFIRMATION_REQUIRED');
  }
  assertLocalProcessHardening();
  const root = credentialRoot();
  assertPostBootstrapBackup(root);
  const current = await remoteHostEncryptionReadback(sourceSha);
  if (current.state === 'HOST_ENCRYPTED_MOUNT_VERIFIED') {
    return Object.freeze({
      schemaVersion: 1,
      state: current.state,
      nodeName: current.nodeName,
      contractDigest: current.contractDigest,
      hostEncryptionDigest: current.hostEncryption.observedDigest,
      secretExposed: false,
    });
  }
  const backup = await remoteHostEncryptionBackupState(sourceSha);
  if (backup.state !== 'PRE_PROVISION_BACKUP_RESTORE_VERIFIED') {
    stop('P2_STAGE1_HOST_ENCRYPTION_BACKUP_REQUIRED');
  }
  const recoveryKey = readLuksRecoveryKey(root);
  try {
    const machine = host(hostContract.target.nodeName, 'state-host');
    const command = 'sudo -n /usr/local/libexec/seori-auth-native launch -- ' +
      `/usr/local/bin/node ${remoteRoot(sourceSha)}/scripts/fleet/` +
      'p2-host-encryption-apply-loader.mjs';
    const result = parsePublicJson(await runPublicSsh(
      machine,
      command,
      recoveryKey,
    ), 'P2_STAGE1_HOST_ENCRYPTION_APPLY_OUTCOME_UNKNOWN');
    const expected = [
      'schemaVersion', 'state', 'nodeName', 'contractDigest', 'provisionedDigest',
      'secretExposed',
    ];
    if (
      Object.keys(result).toSorted().join('\0') !== expected.toSorted().join('\0') ||
      result.schemaVersion !== 1 ||
      result.state !== 'HOST_PROVISIONED_REBOOT_READBACK_REQUIRED' ||
      result.nodeName !== hostContract.target.nodeName ||
      result.contractDigest !== contractDigest(hostContract) ||
      !SHA256.test(result.provisionedDigest ?? '') || result.secretExposed !== false
    ) stop('P2_STAGE1_HOST_ENCRYPTION_APPLY_OUTCOME_UNKNOWN');
    return Object.freeze(result);
  } finally {
    recoveryKey.fill(0);
  }
}

async function hostEncryptionRebootReadback() {
  allowedOptions(['source-sha', 'ssh-password-file']);
  const sourceSha = option('source-sha');
  if (!SHA40.test(sourceSha)) stop('P2_STAGE1_SOURCE_SHA_INVALID');
  assertLocalProcessHardening();
  return remoteHostEncryptionReadback(sourceSha, 'reboot-readback');
}

function sourceArchive() {
  if (fixtureCredentialRoot === undefined) {
    const context = assertLocalProcessHardening();
    const archive = readHeld(
      join(context.runtimeRoot, stage1.localProcessBoundary.sourceArchiveLeaf),
      {
        mode: Number.parseInt(stage1.localProcessBoundary.sourceFileMode, 8),
        maximum: 128 * 1024 * 1024,
      },
    );
    const lock = readHeld(
      join(context.runtimeRoot, stage1.sourceBootstrap.packageLockPath),
      {
        mode: Number.parseInt(stage1.localProcessBoundary.sourceFileMode, 8),
        maximum: 8 * 1024 * 1024,
      },
    );
    if (
      sha256(archive) !== context.archiveSha256 ||
      sha256(lock) !== context.packageLockSha256
    ) {
      archive.fill(0);
      lock.fill(0);
      stop('P2_STAGE1_LOCAL_RUNTIME_INVALID');
    }
    lock.fill(0);
    return {
      sourceSha: context.sourceSha,
      archive,
      archiveSha256: context.archiveSha256,
      packageLockSha256: context.packageLockSha256,
    };
  }
  let status;
  let sourceSha;
  let archive;
  try {
    status = execFileSync('/usr/bin/git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: repositoryRoot, encoding: 'utf8', env: commandEnvironment(), stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (status !== '') stop('P2_STAGE1_SOURCE_WORKTREE_DIRTY');
    sourceSha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot, encoding: 'utf8', env: commandEnvironment(), stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!SHA40.test(sourceSha)) stop('P2_STAGE1_SOURCE_SHA_INVALID');
    archive = execFileSync('/usr/bin/git', ['archive', '--format=tar', sourceSha], {
      cwd: repositoryRoot, encoding: null, env: commandEnvironment(),
      stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
    const lock = readFileSync(join(repositoryRoot, stage1.sourceBootstrap.packageLockPath));
    return {
      sourceSha,
      archive,
      archiveSha256: sha256(archive),
      packageLockSha256: sha256(lock),
    };
  } catch (error) {
    archive?.fill(0);
    if (error instanceof Stage1ControllerError) throw error;
    stop('P2_STAGE1_SOURCE_ARCHIVE_FAILED');
  }
}

function sourceConfirmation(machine, source) {
  return `fleet-p2-stage1-bootstrap-source-${machine.nodeName}-${source.sourceSha.slice(0, 12)}-` +
    `${source.archiveSha256.slice(0, 12)}-${combinedDigest.slice(0, 16)}`;
}

function sourcePlan() {
  allowedOptions(['host']);
  assertLocalProcessHardening();
  const machine = stage1.hosts.find(({ nodeName }) => nodeName === option('host'));
  if (machine === undefined) stop('P2_STAGE1_HOST_INVALID');
  const source = sourceArchive();
  try {
    return Object.freeze({
      schemaVersion: 1,
      state: 'DRY_RUN',
      nodeName: machine.nodeName,
      sourceSha: source.sourceSha,
      archiveSha256: source.archiveSha256,
      packageLockSha256: source.packageLockSha256,
      installRoot: `${stage1.sourceBootstrap.installRoot}/${source.sourceSha}`,
      confirmation: sourceConfirmation(machine, source),
      runtime: stage1.nodeRuntime,
      secretExposed: false,
    });
  } finally {
    source.archive.fill(0);
  }
}

async function bootstrapSource() {
  allowedOptions(['host', 'confirmation', 'ssh-password-file']);
  assertLocalProcessHardening();
  assertPostBootstrapBackup(credentialRoot());
  const machine = stage1.hosts.find(({ nodeName }) => nodeName === option('host'));
  if (machine === undefined) stop('P2_STAGE1_HOST_INVALID');
  const source = sourceArchive();
  try {
    if (option('confirmation') !== sourceConfirmation(machine, source)) {
      stop('P2_STAGE1_SOURCE_CONFIRMATION_REQUIRED');
    }
    const remoteArchive = `${stage1.sourceBootstrap.incomingRoot}/${source.sourceSha}-${source.archiveSha256}.tar`;
    await runPublicSsh(
      machine,
      `/usr/bin/install -d -m 0700 ${stage1.sourceBootstrap.incomingRoot}`,
    );
    const archiveReadbackScript = readFileSync(
      join(repositoryRoot, 'scripts/fleet/readback-p2-stage1-source-archive.sh'),
    );
    const archiveState = parsePublicJson(await runPublicSsh(
      machine,
      `/bin/bash -s -- --archive=${remoteArchive} --sha=${source.archiveSha256}`,
      archiveReadbackScript,
    ), 'P2_STAGE1_SOURCE_ARCHIVE_READBACK_INVALID');
    if (archiveState.state === 'ABSENT') {
      await runPublicSsh(
        machine,
        `/usr/bin/dd of=${remoteArchive} status=none conv=excl`,
        source.archive,
      );
      const verified = parsePublicJson(await runPublicSsh(
        machine,
        `/bin/bash -s -- --archive=${remoteArchive} --sha=${source.archiveSha256}`,
        archiveReadbackScript,
      ), 'P2_STAGE1_SOURCE_ARCHIVE_READBACK_INVALID');
      if (verified.state !== 'EXACT_READBACK') stop('P2_STAGE1_SOURCE_ARCHIVE_READBACK_INVALID');
    } else if (archiveState.state !== 'EXACT_READBACK') {
      stop('P2_STAGE1_SOURCE_ARCHIVE_DRIFT');
    }
    const bootstrapScript = readFileSync(join(repositoryRoot, 'scripts/fleet/bootstrap-p2-stage1-host.sh'));
    const bootstrapInput = await preparePrivilegedInput(machine, bootstrapScript);
    const sudo = sshAuthentication() === null ? 'sudo -n' : "sudo -S -p ''";
    const bootstrapCommand = bootstrapInput.remotePath === null
      ? `${sudo} /bin/bash -s -- `
      : `${sudo} /bin/sh -c 'exec /bin/bash ${bootstrapInput.remotePath} `;
    const bootstrapSuffix =
        `--host=${machine.nodeName} --source-sha=${source.sourceSha} ` +
        `--archive=${remoteArchive} --archive-sha=${source.archiveSha256} ` +
        `--lock-sha=${source.packageLockSha256} --contract-digest=${combinedDigest} ` +
        `--confirmation=${sourceConfirmation(machine, source)}`;
    const result = parsePublicJson(await runPublicSsh(
      machine,
      bootstrapInput.remotePath === null
        ? `${bootstrapCommand}${bootstrapSuffix}`
        : `${bootstrapCommand}${bootstrapSuffix} </dev/null'`,
      bootstrapInput.input,
      { privileged: true },
    ), 'P2_STAGE1_SOURCE_BOOTSTRAP_INVALID');
    if (
      result.state !== 'P2_STAGE1_SOURCE_READY' || result.nodeName !== machine.nodeName ||
      result.sourceSha !== source.sourceSha || result.archiveSha256 !== source.archiveSha256 ||
      result.packageLockSha256 !== source.packageLockSha256
    ) stop('P2_STAGE1_SOURCE_BOOTSTRAP_INVALID');
    return result;
  } finally {
    source.archive.fill(0);
  }
}

function plan() {
  allowedOptions([]);
  const context = assertLocalProcessHardening();
  return Object.freeze({
    schemaVersion: 1,
    state: 'DRY_RUN',
    contractDigest: combinedDigest,
    confirmations: confirmations(),
    attestor: {
      logicalCredentialId: stage1.attestor.logicalCredentialId,
      preBootstrapBackup: stage1.attestor.preBootstrapBackup,
    },
    hosts: stage1.hosts,
    ...(context === undefined ? {} : { sourceSha: context.sourceSha }),
    secretExposed: false,
  });
}

function processBoundaryReadback() {
  allowedOptions([]);
  const context = assertLocalProcessHardening();
  if (context === undefined) stop('P2_STAGE1_LOCAL_PROCESS_HARDENING_REQUIRED');
  return Object.freeze({
    schemaVersion: 1,
    state: 'P2_STAGE1_LOCAL_PROCESS_BOUNDARY_VERIFIED',
    sourceSha: context.sourceSha,
    archiveSha256: context.archiveSha256,
    controllerSha256: context.controllerSha256,
    sourceReceiptSha256: context.sourceReceiptSha256,
    secretExposed: false,
  });
}

const handlers = new Map([
  ['plan', plan],
  ['process-boundary-readback', processBoundaryReadback],
  ['bootstrap-attestor', bootstrapAttestor],
  ['source-plan', sourcePlan],
  ['bootstrap-source', bootstrapSource],
  ['provision-tang', provisionTang],
  ['backup-tang', backupTang],
  ['deliver-rpi5-evidence', deliverRpi5],
  ['host-encryption-backup', hostEncryptionBackup],
  ['host-encryption-apply', hostEncryptionApply],
  ['host-encryption-readback', hostEncryptionReadback],
  ['host-encryption-reboot-readback', hostEncryptionRebootReadback],
]);

try {
  if (fixtureInjectionForbidden) stop('P2_STAGE1_FIXTURE_INJECTION_FORBIDDEN');
  const handler = handlers.get(mode);
  if (handler === undefined) stop('P2_STAGE1_COMMAND_INVALID');
  const result = await handler();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const code = error instanceof Stage1ControllerError || error instanceof P2Stage1Error
    ? error.code
    : 'P2_STAGE1_FAILED';
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exitCode = 1;
}
