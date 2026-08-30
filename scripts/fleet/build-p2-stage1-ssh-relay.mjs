#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const source = resolve(repositoryRoot, 'scripts/fleet/native/p2-stage1-ssh-relay.c');
const output = resolve(process.argv[2] ?? resolve(repositoryRoot, '.build/seorilabs-p2-stage1-ssh-relay'));
if (!isAbsolute(output)) throw new Error('stage1 SSH relay output must be absolute');
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const args = [
  '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-D_FORTIFY_SOURCE=2',
  '-fPIE', '-fstack-protector-strong', source,
  ...(process.platform === 'linux' ? ['-pie', '-Wl,-z,relro,-z,now'] : []),
  '-o', output,
];
await new Promise((resolveBuild, rejectBuild) => {
  const child = spawn('cc', args, {
    cwd: repositoryRoot, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    shell: false, stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.once('error', rejectBuild);
  child.once('close', (code) => code === 0
    ? resolveBuild()
    : rejectBuild(new Error(`stage1 SSH relay compiler exited with ${code}`)));
});
await chmod(output, 0o700);
const [entry, canonical] = await Promise.all([lstat(output), realpath(output)]);
if (
  !entry.isFile() || entry.isSymbolicLink() || canonical !== output ||
  (entry.mode & 0o777) !== 0o700 || entry.uid !== process.geteuid?.()
) throw new Error('stage1 SSH relay build artifact is unsafe');
process.stdout.write(`${JSON.stringify({ built: true, output })}\n`);
