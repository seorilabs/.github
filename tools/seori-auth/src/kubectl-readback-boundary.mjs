import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';

const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const TEMP_PREFIX = 'seori-kubectl-readback-';

export class KubectlReadbackBoundaryError extends Error {
  constructor(code) {
    super(code);
    this.name = 'KubectlReadbackBoundaryError';
    this.code = code;
  }
}

function stop(code) {
  throw new KubectlReadbackBoundaryError(code);
}

export function resolveCanonicalKubeconfig(path) {
  try {
    if (typeof path !== 'string' || !isAbsolute(path)) stop('KUBECONFIG_PATH_INVALID');
    const entry = lstatSync(path);
    const canonical = realpathSync(path);
    accessSync(path, fsConstants.R_OK);
    if (
      !entry.isFile() || entry.isSymbolicLink() || canonical !== path ||
      (entry.mode & 0o022) !== 0
    ) stop('KUBECONFIG_PATH_INVALID');
    return canonical;
  } catch (error) {
    if (error instanceof KubectlReadbackBoundaryError) throw error;
    stop('KUBECONFIG_PATH_INVALID');
  }
}

export function resolveCanonicalMicrok8sKubeconfig({
  requestedPath,
  stateRoot,
  expectedOwner,
}) {
  try {
    if (
      typeof requestedPath !== 'string' || typeof stateRoot !== 'string' ||
      !isAbsolute(requestedPath) || !isAbsolute(stateRoot) ||
      requestedPath !== join(stateRoot, 'current/credentials/kubelet.config') ||
      !Number.isSafeInteger(expectedOwner) || expectedOwner < 0
    ) stop('KUBECONFIG_PATH_INVALID');
    const rootEntry = lstatSync(stateRoot);
    const current = join(stateRoot, 'current');
    const currentEntry = lstatSync(current);
    const revision = readlinkSync(current);
    if (
      !rootEntry.isDirectory() || rootEntry.isSymbolicLink() ||
      realpathSync(stateRoot) !== stateRoot || rootEntry.uid !== expectedOwner ||
      (rootEntry.mode & 0o022) !== 0 || !currentEntry.isSymbolicLink() ||
      currentEntry.uid !== expectedOwner || currentEntry.nlink !== 1 ||
      !/^[1-9][0-9]*$/u.test(revision)
    ) stop('KUBECONFIG_PATH_INVALID');
    const revisionRoot = join(stateRoot, revision);
    const credentialsRoot = join(revisionRoot, 'credentials');
    const canonical = join(credentialsRoot, 'kubelet.config');
    const revisionEntry = lstatSync(revisionRoot);
    const credentialsEntry = lstatSync(credentialsRoot);
    const fileEntry = lstatSync(canonical);
    if (
      !revisionEntry.isDirectory() || revisionEntry.isSymbolicLink() ||
      realpathSync(revisionRoot) !== revisionRoot || revisionEntry.uid !== expectedOwner ||
      (revisionEntry.mode & 0o022) !== 0 || !credentialsEntry.isDirectory() ||
      credentialsEntry.isSymbolicLink() || realpathSync(credentialsRoot) !== credentialsRoot ||
      credentialsEntry.uid !== expectedOwner || credentialsEntry.gid <= 0 ||
      (credentialsEntry.mode & 0o7777) !== 0o770 || !fileEntry.isFile() ||
      fileEntry.isSymbolicLink() || realpathSync(canonical) !== canonical ||
      fileEntry.uid !== expectedOwner || fileEntry.gid !== credentialsEntry.gid ||
      fileEntry.nlink !== 1 || (fileEntry.mode & 0o7777) !== 0o660 ||
      fileEntry.size < 1 || fileEntry.size > 1024 * 1024 ||
      realpathSync(current) !== revisionRoot || realpathSync(requestedPath) !== canonical ||
      readlinkSync(current) !== revision
    ) stop('KUBECONFIG_PATH_INVALID');
    accessSync(canonical, fsConstants.R_OK);
    return canonical;
  } catch (error) {
    if (error instanceof KubectlReadbackBoundaryError) throw error;
    stop('KUBECONFIG_PATH_INVALID');
  }
}

export function resolveCanonicalMicrok8sKubectl({
  snapRoot,
  revision,
  expectedOwner,
  expectedGroup,
}) {
  try {
    if (
      typeof snapRoot !== 'string' || !isAbsolute(snapRoot) ||
      typeof revision !== 'string' || !/^[1-9][0-9]*$/u.test(revision) ||
      !Number.isSafeInteger(expectedOwner) || expectedOwner < 0 ||
      !Number.isSafeInteger(expectedGroup) || expectedGroup < 0
    ) stop('KUBECTL_EXECUTABLE_INVALID');
    const rootEntry = lstatSync(snapRoot);
    const current = join(snapRoot, 'current');
    const currentEntry = lstatSync(current);
    if (
      !rootEntry.isDirectory() || rootEntry.isSymbolicLink() ||
      realpathSync(snapRoot) !== snapRoot || rootEntry.uid !== expectedOwner ||
      (rootEntry.mode & 0o022) !== 0 || !currentEntry.isSymbolicLink() ||
      currentEntry.uid !== expectedOwner || currentEntry.nlink !== 1 ||
      readlinkSync(current) !== revision
    ) stop('KUBECTL_EXECUTABLE_INVALID');
    const revisionRoot = join(snapRoot, revision);
    const executable = join(revisionRoot, 'kubectl');
    const revisionEntry = lstatSync(revisionRoot);
    const executableEntry = lstatSync(executable);
    if (
      !revisionEntry.isDirectory() || revisionEntry.isSymbolicLink() ||
      realpathSync(revisionRoot) !== revisionRoot || revisionEntry.uid !== expectedOwner ||
      (revisionEntry.mode & 0o022) !== 0 || !executableEntry.isFile() ||
      executableEntry.isSymbolicLink() || realpathSync(executable) !== executable ||
      executableEntry.uid !== expectedOwner || executableEntry.gid !== expectedGroup ||
      executableEntry.nlink !== 1 || (executableEntry.mode & 0o7777) !== 0o755 ||
      executableEntry.size < 1 || executableEntry.size > 256 * 1024 * 1024 ||
      realpathSync(current) !== revisionRoot || readlinkSync(current) !== revision
    ) stop('KUBECTL_EXECUTABLE_INVALID');
    accessSync(executable, fsConstants.X_OK);
    return executable;
  } catch (error) {
    if (error instanceof KubectlReadbackBoundaryError) throw error;
    stop('KUBECTL_EXECUTABLE_INVALID');
  }
}

function createBoundary(kubeconfig, descriptor, kubectlExecutable) {
  const systemTemp = realpathSync('/tmp');
  const root = mkdtempSync(join(systemTemp, TEMP_PREFIX));
  const paths = Object.freeze({
    cache: join(root, 'cache'),
    config: join(root, 'config'),
    data: join(root, 'data'),
    home: join(root, 'home'),
    runtime: join(root, 'runtime'),
    temp: join(root, 'tmp'),
  });
  for (const path of Object.values(paths)) mkdirSync(path, { mode: 0o700 });
  let closed = false;
  return Object.freeze({
    cacheDirectory: paths.cache,
    environment: Object.freeze({
      HOME: paths.home,
      KUBECONFIG: kubeconfig,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PATH: SAFE_PATH,
      TMPDIR: paths.temp,
      XDG_CACHE_HOME: paths.cache,
      XDG_CONFIG_HOME: paths.config,
      XDG_DATA_HOME: paths.data,
      XDG_RUNTIME_DIR: paths.runtime,
    }),
    inputDescriptors: Object.freeze(descriptor === undefined ? [] : [descriptor]),
    ...(kubectlExecutable === undefined ? {} : { kubectlExecutable }),
    kubeconfig,
    close() {
      if (closed) return;
      closed = true;
      if (descriptor !== undefined) closeSync(descriptor);
      const canonicalRoot = realpathSync(root);
      if (
        canonicalRoot !== root || !canonicalRoot.startsWith(`${systemTemp}/${TEMP_PREFIX}`)
      ) stop('KUBECTL_TEMP_BOUNDARY_INVALID');
      rmSync(canonicalRoot, { recursive: true, force: true });
    },
  });
}

export function openSecureKubectlReadbackBoundary(kubeconfigPath) {
  return createBoundary(resolveCanonicalKubeconfig(kubeconfigPath));
}

export function openSecureMicrok8sKubectlReadbackBoundary(options) {
  const canonical = resolveCanonicalMicrok8sKubeconfig(options);
  const current = join(options.stateRoot, 'current');
  let revision;
  try {
    revision = readlinkSync(current);
    const revisionRoot = join(options.stateRoot, revision);
    if (
      canonical !== join(revisionRoot, 'credentials/kubelet.config') ||
      realpathSync(current) !== revisionRoot
    ) stop('KUBECONFIG_PATH_INVALID');
  } catch {
    stop('KUBECONFIG_PATH_INVALID');
  }
  const kubectlExecutable = resolveCanonicalMicrok8sKubectl({
    snapRoot: options.snapRoot,
    revision,
    expectedOwner: options.expectedOwner,
    expectedGroup: options.expectedGroup,
  });
  let descriptor;
  try {
    descriptor = openSync(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const held = fstatSync(descriptor);
    const current = lstatSync(canonical);
    if (
      !held.isFile() || held.dev !== current.dev || held.ino !== current.ino ||
      held.uid !== current.uid || held.gid !== current.gid || held.mode !== current.mode ||
      held.nlink !== current.nlink || held.size !== current.size ||
      readlinkSync(join(options.stateRoot, 'current')) !== revision ||
      readlinkSync(join(options.snapRoot, 'current')) !== revision
    ) stop('KUBECONFIG_PATH_INVALID');
    return createBoundary('/proc/self/fd/3', descriptor, kubectlExecutable);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The original stable failure is retained.
      }
    }
    if (error instanceof KubectlReadbackBoundaryError) throw error;
    stop('KUBECONFIG_PATH_INVALID');
  }
}
