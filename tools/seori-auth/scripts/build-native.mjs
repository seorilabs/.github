#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(packageRoot, 'native/seori-auth-native.c');
const output = resolve(process.argv[2] ?? resolve(packageRoot, '.build/seori-auth-native'));

if (!isAbsolute(output)) {
  throw new Error('native helper output must be absolute');
}

await mkdir(dirname(output), { recursive: true, mode: 0o700 });

const compiler = process.env.CC || 'cc';
const args = [
  '-std=c11',
  '-O2',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-D_FORTIFY_SOURCE=2',
  '-fPIE',
  '-fstack-protector-strong',
  source,
  ...(process.platform === 'linux' ? ['-pie', '-Wl,-z,relro,-z,now'] : []),
  '-o',
  output,
];

await new Promise((resolveBuild, rejectBuild) => {
  const child = spawn(compiler, args, {
    cwd: packageRoot,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    shell: false,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.once('error', rejectBuild);
  child.once('close', (code) => {
    if (code === 0) resolveBuild();
    else rejectBuild(new Error(`native helper compiler exited with ${code}`));
  });
});

await chmod(output, 0o755);
const [stat, canonical] = await Promise.all([lstat(output), realpath(output)]);
if (!stat.isFile() || stat.isSymbolicLink() || canonical !== output || (stat.mode & 0o022) !== 0) {
  throw new Error('native helper output failed ownership boundary validation');
}

process.stdout.write(`${JSON.stringify({ built: true, output })}\n`);
