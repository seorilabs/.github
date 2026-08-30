#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!['linux', 'darwin'].includes(process.platform)) {
  throw new Error('P2 process hardening boundary build requires Linux or macOS');
}

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const source = resolve(repositoryRoot, 'scripts/fleet/native/p2-process-hardening-boundary.c');
const output = process.argv[2] ??
  resolve(repositoryRoot, '.build/seorilabs-p2-process-hardening.node');
if (process.argv.length > 3 || !isAbsolute(output) || !output.endsWith('.node')) {
  throw new Error('P2 process hardening boundary output is invalid');
}

const includeDirectory = resolve(dirname(process.execPath), '../include/node');
const header = resolve(includeDirectory, 'node_api.h');
const canonicalHeader = await realpath(header);
if (canonicalHeader !== header) throw new Error('Node N-API header boundary is invalid');

await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const compiler = process.env.CC || 'cc';
const arguments_ = [
  '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-D_FORTIFY_SOURCE=2',
  '-fPIC', '-fstack-protector-strong', `-I${includeDirectory}`, source,
  ...(process.platform === 'linux'
    ? ['-shared', '-Wl,-z,relro,-z,now']
    : ['-bundle', '-undefined', 'dynamic_lookup']),
  '-o', output,
];
await new Promise((resolveBuild, rejectBuild) => {
  const child = spawn(compiler, arguments_, {
    cwd: repositoryRoot,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    shell: false,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.once('error', rejectBuild);
  child.once('close', (code) => {
    if (code === 0) resolveBuild();
    else rejectBuild(new Error(`P2 process hardening boundary compiler exited with ${code}`));
  });
});

await chmod(output, 0o755);
const [entry, canonical] = await Promise.all([lstat(output), realpath(output)]);
if (!entry.isFile() || entry.isSymbolicLink() || canonical !== output || (entry.mode & 0o022) !== 0) {
  throw new Error('P2 process hardening boundary artifact is unsafe');
}
process.stdout.write(`${JSON.stringify({
  built: true,
  platform: process.platform,
  architecture: process.arch,
  output,
})}\n`);
