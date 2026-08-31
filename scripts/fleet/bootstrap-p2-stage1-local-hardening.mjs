#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

import {
  canonicalDigest,
  canonicalJson,
} from '../../tools/seori-auth/src/host-encryption-provisioning.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const stage1Path = join(repositoryRoot, 'contracts/fleet-p2-stage1.yaml');
const stage1SchemaPath = join(repositoryRoot, 'contracts/fleet-p2-stage1.schema.json');
const hostPath = join(repositoryRoot, 'contracts/fleet-p2-host-encryption.yaml');
const hostSchemaPath = join(repositoryRoot, 'contracts/fleet-p2-host-encryption.schema.json');
const fixtureEntrypoint = fileURLToPath(
  new URL('../../tests/fixtures/p2-stage1-local-bootstrap-fixture-entrypoint.mjs', import.meta.url),
);
const mode = process.argv[2] ?? 'plan';
const SHA40 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SOURCE_ARCHIVE = 128 * 1024 * 1024;
const MAX_RUNTIME_FILE = 32 * 1024 * 1024;

class LocalHardeningBootstrapError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LocalHardeningBootstrapError';
    this.code = code;
  }
}

function stop(code) {
  throw new LocalHardeningBootstrapError(code);
}

let invokedEntrypoint;
try {
  invokedEntrypoint = process.argv[1] === undefined ? undefined : realpathSync(process.argv[1]);
} catch {
  invokedEntrypoint = undefined;
}
const fixtureRequested = [
  'SEORILABS_P2_STAGE1_FIXTURE_CREDENTIAL_ROOT',
  'SEORILABS_P2_STAGE1_FIXTURE_HOME',
  'SEORILABS_P2_STAGE1_FIXTURE_LOCAL_CRASH',
].some((name) => process.env[name] !== undefined);
const fixtureInjectionForbidden = fixtureRequested && invokedEntrypoint !== fixtureEntrypoint;
const fixtureCredentialRoot = invokedEntrypoint === fixtureEntrypoint
  ? process.env.SEORILABS_P2_STAGE1_FIXTURE_CREDENTIAL_ROOT
  : undefined;
const fixtureHome = invokedEntrypoint === fixtureEntrypoint
  ? process.env.SEORILABS_P2_STAGE1_FIXTURE_HOME
  : undefined;
const fixtureCrash = invokedEntrypoint === fixtureEntrypoint
  ? process.env.SEORILABS_P2_STAGE1_FIXTURE_LOCAL_CRASH
  : undefined;

function loadContract(path, schemaPath, code) {
  try {
    const contract = parse(readFileSync(path, 'utf8'));
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
    if (!validate(contract)) stop(code);
    return Object.freeze(contract);
  } catch (error) {
    if (error instanceof LocalHardeningBootstrapError) throw error;
    stop(code);
  }
}

const stage1 = loadContract(stage1Path, stage1SchemaPath, 'P2_STAGE1_CONTRACT_INVALID');
const hostContract = loadContract(hostPath, hostSchemaPath, 'P2_HOST_CONTRACT_INVALID');
const combinedDigest = canonicalDigest({ stage1, hostContract });

function parseOptions() {
  const parsed = new Map();
  for (const argument of process.argv.slice(3)) {
    if (!argument.startsWith('--') || !argument.includes('=')) {
      stop('P2_STAGE1_LOCAL_COMMAND_INVALID');
    }
    const separator = argument.indexOf('=');
    const key = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (value.length === 0 || parsed.has(key)) stop('P2_STAGE1_LOCAL_COMMAND_INVALID');
    parsed.set(key, value);
  }
  return parsed;
}

const options = parseOptions();

function allowedOptions(allowed) {
  for (const key of options.keys()) {
    if (!allowed.includes(key)) stop('P2_STAGE1_LOCAL_COMMAND_INVALID');
  }
}

function option(name) {
  const value = options.get(name);
  if (value === undefined) stop('P2_STAGE1_LOCAL_COMMAND_INVALID');
  return value;
}

function commandEnvironment() {
  const nodeDirectory = dirname(process.execPath);
  return {
    PATH: `${nodeDirectory}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    LANG: 'C',
    LC_ALL: 'C',
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function currentUid() {
  const uid = process.geteuid?.();
  if (!Number.isSafeInteger(uid) || uid <= 0) stop('P2_STAGE1_LOCAL_USER_REQUIRED');
  return uid;
}

function requireDarwinUser() {
  currentUid();
  if (fixtureCredentialRoot === undefined && process.platform !== 'darwin') {
    stop('P2_STAGE1_LOCAL_DARWIN_REQUIRED');
  }
  const expectedNode = join(
    homedir(),
    `.nvm/versions/node/v${stage1.nodeRuntime.version}/bin/node`,
  );
  try {
    if (
      fixtureCredentialRoot === undefined &&
      (realpathSync(process.execPath) !== expectedNode || realpathSync(expectedNode) !== expectedNode)
    ) stop('P2_STAGE1_LOCAL_NODE_INVALID');
    const version = execFileSync(process.execPath, ['--version'], {
      encoding: 'utf8',
      env: commandEnvironment(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (version !== `v${stage1.nodeRuntime.version}`) stop('P2_STAGE1_LOCAL_NODE_INVALID');
  } catch (error) {
    if (error instanceof LocalHardeningBootstrapError) throw error;
    stop('P2_STAGE1_LOCAL_NODE_INVALID');
  }
}

function sourceSha() {
  try {
    const safeDirectory = `safe.directory=${repositoryRoot}`;
    const status = execFileSync(
      '/usr/bin/git',
      ['-c', safeDirectory, 'status', '--porcelain', '--untracked-files=normal'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: commandEnvironment(),
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    if (status !== '') stop('P2_STAGE1_LOCAL_SOURCE_DIRTY');
    const value = execFileSync('/usr/bin/git', ['-c', safeDirectory, 'rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: commandEnvironment(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!SHA40.test(value)) stop('P2_STAGE1_LOCAL_SOURCE_INVALID');
    const tree = execFileSync(
      '/usr/bin/git',
      ['-c', safeDirectory, 'ls-tree', '-rz', '--full-tree', value],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: commandEnvironment(),
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    for (const record of tree.split('\0').filter(Boolean)) {
      const match = /^(100644|100755) blob [a-f0-9]{40}\t([^\0]+)$/u.exec(record);
      if (match === null || !safeRelativePath(match[2])) stop('P2_STAGE1_LOCAL_SOURCE_INVALID');
    }
    return value;
  } catch (error) {
    if (error instanceof LocalHardeningBootstrapError) throw error;
    stop('P2_STAGE1_LOCAL_SOURCE_INVALID');
  }
}

function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !isAbsolute(value) &&
    normalize(value) === value && !value.split(sep).some((part) => part === '..' || part === '');
}

function gitBytes(arguments_, maximum = MAX_SOURCE_ARCHIVE) {
  try {
    return execFileSync('/usr/bin/git', arguments_, {
      cwd: repositoryRoot,
      encoding: null,
      env: commandEnvironment(),
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: maximum,
    });
  } catch {
    stop('P2_STAGE1_LOCAL_SOURCE_INVALID');
  }
}

function sourceReadback() {
  const sha = sourceSha();
  const archive = gitBytes(['archive', '--format=tar', sha]);
  const lock = gitBytes(['show', `${sha}:${stage1.sourceBootstrap.packageLockPath}`], 8 * 1024 * 1024);
  const controller = gitBytes(
    ['show', `${sha}:${stage1.localProcessBoundary.controllerRelativePath}`],
    4 * 1024 * 1024,
  );
  return Object.freeze({
    sourceSha: sha,
    archive,
    archiveSha256: sha256(archive),
    packageLockSha256: sha256(lock),
    controllerSha256: sha256(controller),
  });
}

function buildArtifacts() {
  try {
    execFileSync(process.execPath, [join(repositoryRoot, 'tools/seori-auth/scripts/build-native.mjs')], {
      cwd: repositoryRoot,
      env: commandEnvironment(),
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 120_000,
    });
    execFileSync(
      process.execPath,
      [join(repositoryRoot, 'scripts/fleet/build-p2-process-hardening-boundary.mjs')],
      {
        cwd: repositoryRoot,
        env: commandEnvironment(),
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 120_000,
      },
    );
    execFileSync(
      process.execPath,
      [join(repositoryRoot, 'scripts/fleet/build-p2-stage1-ssh-relay.mjs')],
      {
        cwd: repositoryRoot,
        env: commandEnvironment(),
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 120_000,
      },
    );
  } catch {
    stop('P2_STAGE1_LOCAL_BUILD_FAILED');
  }
}

function readHeld(
  path,
  { expectedOwner, mode: expectedMode, maximum = MAX_RUNTIME_FILE, allowEmpty = false } = {},
) {
  let descriptor;
  try {
    const entry = lstatSync(path);
    if (
      !entry.isFile() || entry.isSymbolicLink() || realpathSync(path) !== path ||
      entry.nlink !== 1 ||
      (expectedOwner !== undefined && entry.uid !== expectedOwner) ||
      (expectedMode !== undefined && (entry.mode & 0o777) !== expectedMode) ||
      (!allowEmpty && entry.size < 1) || entry.size > maximum
    ) stop('P2_STAGE1_LOCAL_ARTIFACT_INVALID');
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const held = fstatSync(descriptor);
    if (
      held.dev !== entry.dev || held.ino !== entry.ino || held.mode !== entry.mode ||
      held.uid !== entry.uid || held.gid !== entry.gid || held.size !== entry.size ||
      held.nlink !== entry.nlink
    ) stop('P2_STAGE1_LOCAL_ARTIFACT_DRIFT');
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(path);
    if (
      after.dev !== held.dev || after.ino !== held.ino || after.size !== held.size ||
      after.mode !== held.mode || after.uid !== held.uid || after.gid !== held.gid ||
      after.nlink !== held.nlink || after.mtimeMs !== held.mtimeMs ||
      after.ctimeMs !== held.ctimeMs || pathAfter.dev !== held.dev ||
      pathAfter.ino !== held.ino || pathAfter.size !== held.size ||
      pathAfter.mtimeMs !== held.mtimeMs || pathAfter.ctimeMs !== held.ctimeMs
    ) {
      stop('P2_STAGE1_LOCAL_ARTIFACT_DRIFT');
    }
    return { bytes, entry };
  } catch (error) {
    if (error instanceof LocalHardeningBootstrapError) throw error;
    stop('P2_STAGE1_LOCAL_ARTIFACT_INVALID');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function artifactPaths(configRoot, homeRoot, source) {
  const boundary = stage1.localProcessBoundary;
  const runtimeRootRelativePath = `${boundary.runtimeRootRelativePath}/${source.sourceSha}`;
  const sourceBound = (path) => `${path}-${source.sourceSha}`;
  return Object.freeze({
    launcherSource: join(repositoryRoot, stage1.sourceBootstrap.nativeLauncherRelativePath),
    moduleSource: join(repositoryRoot, stage1.sourceBootstrap.processBoundaryBuildRelativePath),
    relaySource: join(repositoryRoot, stage1.ssh.relayBuiltRelativePath),
    launcherRelativePath: sourceBound(boundary.launcherRelativePath),
    moduleRelativePath: sourceBound(boundary.moduleRelativePath),
    relayRelativePath: sourceBound(stage1.ssh.relayInstallRelativePath),
    boundaryReceiptRelativePath: sourceBound(boundary.receiptRelativePath),
    launcherTarget: relativeRootPath(configRoot, sourceBound(boundary.launcherRelativePath)),
    moduleTarget: relativeRootPath(configRoot, sourceBound(boundary.moduleRelativePath)),
    relayTarget: relativeRootPath(configRoot, sourceBound(stage1.ssh.relayInstallRelativePath)),
    boundaryReceiptTarget: relativeRootPath(configRoot, sourceBound(boundary.receiptRelativePath)),
    runtimeRootRelativePath,
    runtimeTarget: relativeRootPath(homeRoot, runtimeRootRelativePath),
    archiveTarget: relativeRootPath(
      homeRoot,
      `${runtimeRootRelativePath}/${boundary.sourceArchiveLeaf}`,
    ),
    runtimeReceiptTarget: relativeRootPath(
      homeRoot,
      `${runtimeRootRelativePath}/${boundary.sourceReceiptLeaf}`,
    ),
    controllerTarget: relativeRootPath(
      homeRoot,
      `${runtimeRootRelativePath}/${boundary.controllerRelativePath}`,
    ),
  });
}

function artifactReadback(configRoot, homeRoot, source, expectedOwner) {
  const paths = artifactPaths(configRoot, homeRoot, source);
  const launcher = readHeld(paths.launcherSource, { expectedOwner, mode: 0o755 });
  const module = readHeld(paths.moduleSource, { expectedOwner, mode: 0o755 });
  const relay = readHeld(paths.relaySource, { expectedOwner, mode: 0o700 });
  try {
    return Object.freeze({
      paths,
      launcherSha256: sha256(launcher.bytes),
      moduleSha256: sha256(module.bytes),
      relaySha256: sha256(relay.bytes),
    });
  } finally {
    launcher.bytes.fill(0);
    module.bytes.fill(0);
    relay.bytes.fill(0);
  }
}

function confirmation(source, artifacts) {
  return `fleet-p2-stage1-install-local-${source.sourceSha.slice(0, 12)}-` +
    `${source.archiveSha256.slice(0, 12)}-${source.packageLockSha256.slice(0, 12)}-` +
    `${artifacts.launcherSha256.slice(0, 12)}-${artifacts.moduleSha256.slice(0, 12)}-` +
    `${artifacts.relaySha256.slice(0, 12)}-` +
    `${combinedDigest.slice(0, 16)}`;
}

function credentialRoot() {
  const root = fixtureCredentialRoot ?? join(homedir(), '.config/seorilabs');
  if (!isAbsolute(root)) stop('P2_STAGE1_LOCAL_ROOT_INVALID');
  try {
    const entry = lstatSync(root);
    if (
      !entry.isDirectory() || entry.isSymbolicLink() || realpathSync(root) !== root ||
      entry.uid !== currentUid() || (entry.mode & 0o777) !== 0o700
    ) stop('P2_STAGE1_LOCAL_ROOT_INVALID');
  } catch (error) {
    if (error instanceof LocalHardeningBootstrapError) throw error;
    stop('P2_STAGE1_LOCAL_ROOT_INVALID');
  }
  return root;
}

function localHome() {
  const root = fixtureHome ?? homedir();
  if (!isAbsolute(root)) stop('P2_STAGE1_LOCAL_HOME_INVALID');
  try {
    const entry = lstatSync(root);
    if (
      !entry.isDirectory() || entry.isSymbolicLink() || realpathSync(root) !== root ||
      entry.uid !== currentUid() || (entry.mode & 0o022) !== 0
    ) stop('P2_STAGE1_LOCAL_HOME_INVALID');
  } catch (error) {
    if (error instanceof LocalHardeningBootstrapError) throw error;
    stop('P2_STAGE1_LOCAL_HOME_INVALID');
  }
  return root;
}

function relativeRootPath(root, relativePath) {
  if (!safeRelativePath(relativePath)) stop('P2_STAGE1_LOCAL_TARGET_INVALID');
  const target = join(root, relativePath);
  const relation = relative(root, target);
  if (relation.startsWith('..') || isAbsolute(relation)) stop('P2_STAGE1_LOCAL_TARGET_INVALID');
  return target;
}

function exactDirectory(path, expectedOwner, expectedMode = 0o700) {
  try {
    const entry = lstatSync(path);
    if (
      !entry.isDirectory() || entry.isSymbolicLink() || realpathSync(path) !== path ||
      entry.uid !== expectedOwner || (entry.mode & 0o777) !== expectedMode
    ) stop('P2_STAGE1_LOCAL_DIRECTORY_INVALID');
    return entry;
  } catch (error) {
    if (error instanceof LocalHardeningBootstrapError) throw error;
    stop('P2_STAGE1_LOCAL_DIRECTORY_INVALID');
  }
}

function ensureDirectory(root, target, created) {
  const relation = relative(root, target);
  if (relation.startsWith('..') || isAbsolute(relation)) stop('P2_STAGE1_LOCAL_TARGET_INVALID');
  let current = root;
  for (const part of relation.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      mkdirSync(current, { mode: 0o700 });
      const identity = exactDirectory(current, currentUid());
      created.push({ state: 'CREATED_DIRECTORY', path: current, identity });
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        if (error instanceof LocalHardeningBootstrapError) throw error;
        stop('P2_STAGE1_LOCAL_DIRECTORY_INVALID');
      }
      exactDirectory(current, currentUid());
    }
  }
}

function ensureRuntimeRoot(homeRoot, created) {
  let current = homeRoot;
  const parts = stage1.localProcessBoundary.runtimeRootRelativePath.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const privateComponent = index >= 2;
    try {
      mkdirSync(current, { mode: 0o700 });
      const identity = lstatSync(current);
      created.push({ state: 'CREATED_DIRECTORY', path: current, identity });
    } catch (error) {
      if (error?.code !== 'EEXIST') stop('P2_STAGE1_LOCAL_DIRECTORY_INVALID');
    }
    const entry = lstatSync(current);
    if (
      !entry.isDirectory() || entry.isSymbolicLink() || realpathSync(current) !== current ||
      entry.uid !== currentUid() ||
      (privateComponent ? (entry.mode & 0o777) !== 0o700 : (entry.mode & 0o022) !== 0)
    ) stop('P2_STAGE1_LOCAL_DIRECTORY_INVALID');
  }
  return current;
}

function readInstalledExact(path, expectedSha256, expectedMode, maximum = MAX_RUNTIME_FILE) {
  const held = readHeld(path, {
    expectedOwner: currentUid(),
    mode: expectedMode,
    maximum,
    allowEmpty: true,
  });
  try {
    if (held.entry.nlink !== 1 || sha256(held.bytes) !== expectedSha256) {
      stop('P2_STAGE1_LOCAL_TARGET_DRIFT');
    }
    return held.entry;
  } finally {
    held.bytes.fill(0);
  }
}

function installCreateOnly(root, path, sourceBytes, expectedSha256, expectedMode, created) {
  ensureDirectory(root, dirname(path), created);
  try {
    const entry = readInstalledExact(path, expectedSha256, expectedMode, sourceBytes.length);
    return { state: 'EXACT_READBACK', entry, path };
  } catch (error) {
    if (
      !(error instanceof LocalHardeningBootstrapError) ||
      error.code !== 'P2_STAGE1_LOCAL_ARTIFACT_INVALID'
    ) throw error;
    try {
      lstatSync(path);
      stop('P2_STAGE1_LOCAL_TARGET_DRIFT');
    } catch (nested) {
      if (nested instanceof LocalHardeningBootstrapError) throw nested;
      if (nested?.code !== 'ENOENT') stop('P2_STAGE1_LOCAL_TARGET_INVALID');
    }
  }
  const parent = dirname(path);
  const parentIdentity = exactDirectory(parent, currentUid());
  const temporary = join(parent, `.${basename(path)}.${process.pid}.stage1`);
  let descriptor;
  let linkedIdentity;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, sourceBytes);
    fchmodSync(descriptor, expectedMode);
    fsyncSync(descriptor);
    const staged = fstatSync(descriptor);
    const currentParent = exactDirectory(parent, currentUid());
    if (
      staged.uid !== currentUid() || (staged.mode & 0o777) !== expectedMode ||
      staged.size !== sourceBytes.length || sha256(sourceBytes) !== expectedSha256 ||
      currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino
    ) stop('P2_STAGE1_LOCAL_TARGET_INVALID');
    linkSync(temporary, path);
    linkedIdentity = staged;
    unlinkSync(temporary);
    const installed = readInstalledExact(path, expectedSha256, expectedMode, sourceBytes.length);
    const parentDescriptor = openSync(parent, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    try {
      fsyncSync(parentDescriptor);
    } finally {
      closeSync(parentDescriptor);
    }
    const result = { state: 'CREATED_FILE', entry: installed, path };
    created.push(result);
    return result;
  } catch (error) {
    if (linkedIdentity !== undefined) {
      try {
        const current = lstatSync(path);
        if (current.dev === linkedIdentity.dev && current.ino === linkedIdentity.ino) {
          unlinkSync(path);
        }
      } catch {
        // Same-run compensation never removes an inode it did not create.
      }
    }
    if (error instanceof LocalHardeningBootstrapError) throw error;
    if (error?.code === 'EEXIST') {
      return {
        state: 'EXACT_READBACK',
        entry: readInstalledExact(path, expectedSha256, expectedMode, sourceBytes.length),
        path,
      };
    }
    stop('P2_STAGE1_LOCAL_INSTALL_FAILED');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') stop('P2_STAGE1_LOCAL_INSTALL_FAILED');
    }
  }
}

function compensate(entry) {
  try {
    const current = lstatSync(entry.path);
    const expected = entry.identity ?? entry.entry;
    if (expected === undefined || current.dev !== expected.dev || current.ino !== expected.ino) {
      return;
    }
    if (entry.state === 'CREATED_FILE') unlinkSync(entry.path);
    if (entry.state === 'CREATED_DIRECTORY') rmdirSync(entry.path);
  } catch {
    // Compensation is best effort and identity-bound; crash recovery is readback-first.
  }
}

function createStagingRuntime(runtimeRoot, source) {
  const staging = mkdtempSync(join(runtimeRoot, '.stage1-runtime-'));
  const identity = exactDirectory(staging, currentUid());
  const extraction = spawnSync('/usr/bin/tar', ['-xf', '-', '-C', staging], {
    input: source.archive,
    env: commandEnvironment(),
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 120_000,
  });
  if (extraction.status !== 0 || extraction.error !== undefined) {
    removeStaging(runtimeRoot, staging, identity);
    stop('P2_STAGE1_LOCAL_SOURCE_EXTRACT_FAILED');
  }
  const archivePath = join(staging, stage1.localProcessBoundary.sourceArchiveLeaf);
  let descriptor;
  try {
    descriptor = openSync(
      archivePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o400,
    );
    writeFileSync(descriptor, source.archive);
    fchmodSync(descriptor, 0o400);
    fsyncSync(descriptor);
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    removeStaging(runtimeRoot, staging, identity);
    stop('P2_STAGE1_LOCAL_SOURCE_EXTRACT_FAILED');
  }
  if (descriptor !== undefined) closeSync(descriptor);
  const npm = join(dirname(process.execPath), 'npm');
  const installed = spawnSync(
    npm,
    [
      'ci', '--ignore-scripts', '--no-bin-links', '--workspaces=false',
      '--audit=false', '--fund=false',
    ],
    {
      cwd: staging,
      env: commandEnvironment(),
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 180_000,
    },
  );
  if (installed.status !== 0 || installed.error !== undefined) {
    removeStaging(runtimeRoot, staging, identity);
    stop('P2_STAGE1_LOCAL_DEPENDENCY_INSTALL_FAILED');
  }
  removeGeneratedWorkspaceLinks(staging);
  return { path: staging, identity };
}

function removeGeneratedWorkspaceLinks(staging) {
  const parent = join(staging, 'node_modules/@seorilabs');
  for (const [leaf, expectedTarget] of [
    ['repo-contract', '../../packages/repo-contract'],
    ['seori-auth', '../../tools/seori-auth'],
  ]) {
    const path = join(parent, leaf);
    try {
      const entry = lstatSync(path);
      if (!entry.isSymbolicLink() || readlinkSync(path) !== expectedTarget) {
        stop('P2_STAGE1_LOCAL_DEPENDENCY_INSTALL_FAILED');
      }
      unlinkSync(path);
    } catch (error) {
      if (error instanceof LocalHardeningBootstrapError) throw error;
      if (error?.code === 'ENOENT') continue;
      stop('P2_STAGE1_LOCAL_DEPENDENCY_INSTALL_FAILED');
    }
  }
  try {
    rmdirSync(parent);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    stop('P2_STAGE1_LOCAL_DEPENDENCY_INSTALL_FAILED');
  }
}

function removeStaging(runtimeRoot, path, identity) {
  try {
    const current = lstatSync(path);
    if (
      current.isDirectory() && !current.isSymbolicLink() &&
      current.dev === identity.dev && current.ino === identity.ino &&
      dirname(path) === runtimeRoot && basename(path).startsWith('.stage1-runtime-')
    ) rmSync(path, { recursive: true, force: false });
  } catch {
    // A failed cleanup never broadens its target or changes canonical runtime state.
  }
}

function collectManifest(root, excludedLeaf, { sourceTree = false } = {}) {
  const entries = [];
  function visit(directory, prefix = '') {
    const directoryEntry = lstatSync(directory);
    if (
      !directoryEntry.isDirectory() || directoryEntry.isSymbolicLink() ||
      realpathSync(directory) !== directory || directoryEntry.uid !== currentUid() ||
      (sourceTree ? (directoryEntry.mode & 0o022) !== 0 :
        prefix !== '' && (directoryEntry.mode & 0o777) !== 0o700)
    ) {
      stop('P2_STAGE1_LOCAL_RUNTIME_DRIFT');
    }
    const children = readdirSync(directory, { withFileTypes: true })
      .toSorted((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      const relativePath = prefix === '' ? child.name : `${prefix}/${child.name}`;
      if (prefix === '' && child.name === excludedLeaf) continue;
      if (!safeRelativePath(relativePath) || child.isSymbolicLink()) {
        stop('P2_STAGE1_LOCAL_RUNTIME_DRIFT');
      }
      const path = join(directory, child.name);
      if (child.isDirectory()) {
        entries.push(Object.freeze({ path: relativePath, type: 'directory', mode: '0700' }));
        visit(path, relativePath);
        continue;
      }
      if (!child.isFile()) stop('P2_STAGE1_LOCAL_RUNTIME_DRIFT');
      const held = readHeld(path, { expectedOwner: currentUid(), allowEmpty: true });
      try {
        if (sourceTree && (held.entry.mode & 0o022) !== 0) {
          stop('P2_STAGE1_LOCAL_RUNTIME_DRIFT');
        }
        entries.push(Object.freeze({
          path: relativePath,
          type: 'file',
          mode: stage1.localProcessBoundary.sourceFileMode,
          size: held.entry.size,
          sha256: sha256(held.bytes),
        }));
      } finally {
        held.bytes.fill(0);
      }
    }
  }
  visit(root);
  return entries;
}

function publishRuntime(runtimeRoot, paths, source, created) {
  const staging = createStagingRuntime(runtimeRoot, source);
  try {
    const expected = collectManifest(
      staging.path,
      stage1.localProcessBoundary.sourceReceiptLeaf,
      { sourceTree: true },
    );
    ensureDirectory(runtimeRoot, paths.runtimeTarget, created);
    const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
    const existing = collectManifest(
      paths.runtimeTarget,
      stage1.localProcessBoundary.sourceReceiptLeaf,
    );
    for (const entry of existing) {
      const expectedEntry = expectedByPath.get(entry.path);
      if (expectedEntry === undefined || canonicalDigest(entry) !== canonicalDigest(expectedEntry)) {
        stop('P2_STAGE1_LOCAL_RUNTIME_DRIFT');
      }
    }
    let createdRuntimeFile = false;
    for (const entry of expected) {
      const target = relativeRootPath(paths.runtimeTarget, entry.path);
      if (entry.type === 'directory') {
        ensureDirectory(paths.runtimeTarget, target, created);
        continue;
      }
      const sourceFile = readHeld(join(staging.path, entry.path), {
        expectedOwner: currentUid(),
        maximum: MAX_RUNTIME_FILE,
        allowEmpty: true,
      });
      try {
        const installed = installCreateOnly(
          paths.runtimeTarget,
          target,
          sourceFile.bytes,
          entry.sha256,
          Number.parseInt(entry.mode, 8),
          created,
        );
        if (installed.state === 'CREATED_FILE' && !createdRuntimeFile) {
          createdRuntimeFile = true;
          if (fixtureCrash === 'after-runtime-file') process.exit(86);
        }
      } finally {
        sourceFile.bytes.fill(0);
      }
    }
    const readback = collectManifest(
      paths.runtimeTarget,
      stage1.localProcessBoundary.sourceReceiptLeaf,
    );
    if (canonicalDigest(readback) !== canonicalDigest(expected)) {
      stop('P2_STAGE1_LOCAL_RUNTIME_DRIFT');
    }
    const controller = expectedByPath.get(stage1.localProcessBoundary.controllerRelativePath);
    if (
      controller?.type !== 'file' || controller.sha256 !== source.controllerSha256 ||
      realpathSync(paths.controllerTarget) !== paths.controllerTarget
    ) stop('P2_STAGE1_LOCAL_CONTROLLER_INVALID');
    return Object.freeze({
      runtimeManifestSha256: canonicalDigest(expected),
      runtimeFileCount: expected.filter(({ type }) => type === 'file').length,
      controllerMode: controller.mode,
    });
  } finally {
    removeStaging(runtimeRoot, staging.path, staging.identity);
  }
}

function runtimeReceipt(source, runtime) {
  return Object.freeze({
    schemaVersion: 1,
    state: 'P2_STAGE1_LOCAL_RUNTIME_READY',
    sourceRepository: stage1.sourceRepository,
    sourceSha: source.sourceSha,
    archiveSha256: source.archiveSha256,
    packageLockSha256: source.packageLockSha256,
    contractDigest: combinedDigest,
    controllerRelativePath: stage1.localProcessBoundary.controllerRelativePath,
    controllerSha256: source.controllerSha256,
    runtimeManifestSha256: runtime.runtimeManifestSha256,
    runtimeFileCount: runtime.runtimeFileCount,
    secretExposed: false,
  });
}

function boundaryReceipt(artifacts) {
  return Object.freeze({
    schemaVersion: 1,
    state: 'P2_STAGE1_LOCAL_PROCESS_BOUNDARY_READY',
    launcherRelativePath: artifacts.paths.launcherRelativePath,
    launcherSha256: artifacts.launcherSha256,
    moduleRelativePath: artifacts.paths.moduleRelativePath,
    moduleSha256: artifacts.moduleSha256,
    relayRelativePath: artifacts.paths.relayRelativePath,
    relaySha256: artifacts.relaySha256,
    secretExposed: false,
  });
}

function plan() {
  allowedOptions([]);
  requireDarwinUser();
  const configRoot = credentialRoot();
  const homeRoot = localHome();
  const source = sourceReadback();
  try {
    buildArtifacts();
    const artifacts = artifactReadback(configRoot, homeRoot, source, currentUid());
    return Object.freeze({
      schemaVersion: 1,
      state: 'DRY_RUN',
      sourceSha: source.sourceSha,
      archiveSha256: source.archiveSha256,
      packageLockSha256: source.packageLockSha256,
      controllerSha256: source.controllerSha256,
      launcherSha256: artifacts.launcherSha256,
      moduleSha256: artifacts.moduleSha256,
      relaySha256: artifacts.relaySha256,
      targets: {
        launcher: artifacts.paths.launcherTarget,
        module: artifacts.paths.moduleTarget,
        relay: artifacts.paths.relayTarget,
        runtime: artifacts.paths.runtimeTarget,
        controller: artifacts.paths.controllerTarget,
      },
      confirmation: confirmation(source, artifacts),
      secretExposed: false,
    });
  } finally {
    source.archive.fill(0);
  }
}

function verifyOptions(source, artifacts) {
  if (
    option('source-sha') !== source.sourceSha || !SHA40.test(option('source-sha')) ||
    option('archive-sha') !== source.archiveSha256 || !SHA256.test(option('archive-sha')) ||
    option('lock-sha') !== source.packageLockSha256 || !SHA256.test(option('lock-sha')) ||
    option('controller-sha') !== source.controllerSha256 ||
    !SHA256.test(option('controller-sha')) ||
    option('launcher-sha') !== artifacts.launcherSha256 ||
    option('module-sha') !== artifacts.moduleSha256 ||
    option('relay-sha') !== artifacts.relaySha256 ||
    !SHA256.test(option('launcher-sha')) || !SHA256.test(option('module-sha')) ||
    !SHA256.test(option('relay-sha')) ||
    option('confirmation') !== confirmation(source, artifacts)
  ) stop('P2_STAGE1_LOCAL_CONFIRMATION_REQUIRED');
}

function verifyInstalledBoundary(source, artifacts, sourceReceiptSha256) {
  const arguments_ = [
    stage1.localProcessBoundary.launchOperation,
    `--source-sha=${source.sourceSha}`,
    `--controller-sha256=${source.controllerSha256}`,
    `--receipt-sha256=${sourceReceiptSha256}`,
    '--',
    process.execPath,
    artifacts.paths.controllerTarget,
    'process-boundary-readback',
  ];
  try {
    const output = execFileSync(artifacts.paths.launcherTarget, arguments_, {
      encoding: 'utf8',
      env: commandEnvironment(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    });
    const receipt = JSON.parse(output);
    if (
      receipt.state !== 'P2_STAGE1_LOCAL_PROCESS_BOUNDARY_VERIFIED' ||
      receipt.sourceSha !== source.sourceSha || receipt.secretExposed !== false
    ) stop('P2_STAGE1_LOCAL_BOUNDARY_READBACK_FAILED');
  } catch (error) {
    if (error instanceof LocalHardeningBootstrapError) throw error;
    stop('P2_STAGE1_LOCAL_BOUNDARY_READBACK_FAILED');
  }
}

function apply() {
  allowedOptions([
    'source-sha',
    'archive-sha',
    'lock-sha',
    'controller-sha',
    'launcher-sha',
    'module-sha',
    'relay-sha',
    'confirmation',
  ]);
  requireDarwinUser();
  const configRoot = credentialRoot();
  const homeRoot = localHome();
  const source = sourceReadback();
  const created = [];
  let launcher;
  let module;
  let relay;
  try {
    buildArtifacts();
    const artifacts = artifactReadback(configRoot, homeRoot, source, currentUid());
    verifyOptions(source, artifacts);
    launcher = readHeld(artifacts.paths.launcherSource, {
      expectedOwner: currentUid(),
      mode: 0o755,
    });
    module = readHeld(artifacts.paths.moduleSource, {
      expectedOwner: currentUid(),
      mode: 0o755,
    });
    relay = readHeld(artifacts.paths.relaySource, {
      expectedOwner: currentUid(),
      mode: 0o700,
    });
    const launcherState = installCreateOnly(
      configRoot,
      artifacts.paths.launcherTarget,
      launcher.bytes,
      artifacts.launcherSha256,
      Number.parseInt(stage1.localProcessBoundary.launcherMode, 8),
      created,
    ).state;
    if (fixtureCrash === 'after-launcher') process.exit(86);
    const moduleState = installCreateOnly(
      configRoot,
      artifacts.paths.moduleTarget,
      module.bytes,
      artifacts.moduleSha256,
      Number.parseInt(stage1.localProcessBoundary.moduleMode, 8),
      created,
    ).state;
    const relayState = installCreateOnly(
      configRoot,
      artifacts.paths.relayTarget,
      relay.bytes,
      artifacts.relaySha256,
      Number.parseInt(stage1.ssh.relayInstalledMode, 8),
      created,
    ).state;
    const runtimeRoot = ensureRuntimeRoot(homeRoot, created);
    const runtime = publishRuntime(runtimeRoot, artifacts.paths, source, created);
    const sourceReceiptBytes = Buffer.from(`${canonicalJson(runtimeReceipt(source, runtime))}\n`);
    let sourceReceiptState;
    let sourceReceiptSha256;
    try {
      sourceReceiptSha256 = sha256(sourceReceiptBytes);
      sourceReceiptState = installCreateOnly(
        runtimeRoot,
        artifacts.paths.runtimeReceiptTarget,
        sourceReceiptBytes,
        sourceReceiptSha256,
        Number.parseInt(stage1.localProcessBoundary.receiptMode, 8),
        created,
      ).state;
    } finally {
      sourceReceiptBytes.fill(0);
    }
    const boundaryReceiptBytes = Buffer.from(`${canonicalJson(
      boundaryReceipt(artifacts),
    )}\n`);
    let boundaryReceiptState;
    try {
      boundaryReceiptState = installCreateOnly(
        configRoot,
        artifacts.paths.boundaryReceiptTarget,
        boundaryReceiptBytes,
        sha256(boundaryReceiptBytes),
        Number.parseInt(stage1.localProcessBoundary.receiptMode, 8),
        created,
      ).state;
    } finally {
      boundaryReceiptBytes.fill(0);
    }
    if (fixtureCredentialRoot === undefined) {
      verifyInstalledBoundary(source, artifacts, sourceReceiptSha256);
    }
    return Object.freeze({
      schemaVersion: 1,
      state: 'P2_STAGE1_LOCAL_PROCESS_BOUNDARY_READY',
      sourceSha: source.sourceSha,
      archiveSha256: source.archiveSha256,
      packageLockSha256: source.packageLockSha256,
      controllerSha256: source.controllerSha256,
      sourceReceiptSha256,
      launcherSha256: artifacts.launcherSha256,
      moduleSha256: artifacts.moduleSha256,
      relaySha256: artifacts.relaySha256,
      runtimeManifestSha256: runtime.runtimeManifestSha256,
      runtimeFileCount: runtime.runtimeFileCount,
      launcherState,
      moduleState,
      relayState,
      sourceReceiptState,
      boundaryReceiptState,
      secretExposed: false,
    });
  } catch (error) {
    for (const entry of created.toReversed()) compensate(entry);
    throw error;
  } finally {
    launcher?.bytes.fill(0);
    module?.bytes.fill(0);
    relay?.bytes.fill(0);
    source.archive.fill(0);
  }
}

try {
  if (fixtureInjectionForbidden) stop('P2_STAGE1_FIXTURE_INJECTION_FORBIDDEN');
  const handler = new Map([['plan', plan], ['apply', apply]]).get(mode);
  if (handler === undefined) stop('P2_STAGE1_LOCAL_COMMAND_INVALID');
  process.stdout.write(`${JSON.stringify(handler())}\n`);
} catch (error) {
  const code = error instanceof LocalHardeningBootstrapError
    ? error.code
    : 'P2_STAGE1_LOCAL_BOOTSTRAP_FAILED';
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exitCode = 1;
}
