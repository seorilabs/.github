import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function unsafeDirectory() {
  return Object.assign(new Error('canary directory is unsafe'), { code: 'CANARY_DIRECTORY_UNSAFE' });
}

async function optionalDirectory(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// emptyDir's mount root belongs to kubelet, not runAsUser. Only freshly created
// private children contain canary state; never chmod/chown the shared mount root.
export async function withCanaryDirectories(run, {
  platform = process.platform,
  runtimeParent = '/run/seori-auth',
  vaultParent = '/var/lib/seori-auth',
  temporaryParent = tmpdir(),
} = {}) {
  const created = [];
  try {
    let parents;
    if (platform === 'linux') {
      const entries = await Promise.all([runtimeParent, vaultParent].map(optionalDirectory));
      if (entries.some(Boolean)) {
        parents = [runtimeParent, vaultParent];
        for (const [index, entry] of entries.entries()) {
          if (!entry?.isDirectory() || entry.isSymbolicLink() ||
            ![0, process.getuid?.()].includes(entry.uid) ||
            await realpath(parents[index]) !== parents[index]) throw unsafeDirectory();
        }
      }
    }
    if (!parents) {
      const localRoot = await mkdtemp(join(temporaryParent, 'seori-auth-runtime-canary-'));
      created.push(localRoot);
      parents = [localRoot, localRoot];
    }
    const paths = {};
    for (const [index, key] of ['runtimeRoot', 'vaultRoot'].entries()) {
      const path = await mkdtemp(join(parents[index], 'canary-'));
      created.push(path);
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink() ||
        entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0) throw unsafeDirectory();
      paths[key] = await realpath(path);
    }
    return await run(paths);
  } finally {
    for (const path of created.reverse()) await rm(path, { recursive: true, force: true });
  }
}
