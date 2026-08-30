import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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

export function openSecureKubectlReadbackBoundary(kubeconfigPath) {
  const kubeconfig = resolveCanonicalKubeconfig(kubeconfigPath);
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
    kubeconfig,
    close() {
      if (closed) return;
      closed = true;
      const canonicalRoot = realpathSync(root);
      if (
        canonicalRoot !== root || !canonicalRoot.startsWith(`${systemTemp}/${TEMP_PREFIX}`)
      ) stop('KUBECTL_TEMP_BOUNDARY_INVALID');
      rmSync(canonicalRoot, { recursive: true, force: true });
    },
  });
}
