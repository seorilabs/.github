#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const source = resolve(repositoryRoot, 'scripts/fleet/native/p2-regular-file-askpass.c');
let outputArgument;
let testRoot;
let clevisExecutable;
let replyExecutable;
let localTestGate = false;
for (const argument of process.argv.slice(2)) {
  if (argument === '--local-test-gate') localTestGate = true;
  else if (argument.startsWith('--test-root=')) testRoot = argument.slice('--test-root='.length);
  else if (argument.startsWith('--clevis-executable=')) {
    clevisExecutable = argument.slice('--clevis-executable='.length);
  } else if (argument.startsWith('--reply-executable=')) {
    replyExecutable = argument.slice('--reply-executable='.length);
  } else if (outputArgument === undefined) outputArgument = argument;
  else throw new Error('regular-file askpass build argument is invalid');
}

if (process.platform !== 'linux' && testRoot === undefined) {
  if (!localTestGate) throw new Error('regular-file askpass production build requires Linux');
  process.stdout.write(`${JSON.stringify({ built: false, reason: 'LINUX_REQUIRED' })}\n`);
  process.exit(0);
}
if (
  [testRoot, clevisExecutable, replyExecutable].some((value) => value !== undefined) &&
  [testRoot, clevisExecutable, replyExecutable].some((value) => value === undefined)
) throw new Error('regular-file askpass test boundary is partial');
for (const value of [testRoot, clevisExecutable, replyExecutable].filter(Boolean)) {
  if (!isAbsolute(value) || normalize(value) !== value) {
    throw new Error('regular-file askpass test path is invalid');
  }
}

const output = outputArgument ?? resolve(repositoryRoot, '.build/seorilabs-p2-regular-file-askpass');
if (!isAbsolute(output)) throw new Error('regular-file askpass output must be absolute');
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const definitions = testRoot === undefined ? [] : [
  `-DSEORILABS_P2_TEST_ROOT=\"${testRoot}\"`,
  `-DSEORILABS_P2_CLEVIS_EXECUTABLE=\"${clevisExecutable}\"`,
  `-DSEORILABS_P2_REPLY_EXECUTABLE=\"${replyExecutable}\"`,
];
const arguments_ = [
  '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-D_FORTIFY_SOURCE=2',
  '-fPIE', '-fstack-protector-strong', ...definitions, source,
  ...(process.platform === 'linux' ? ['-pie', '-Wl,-z,relro,-z,now'] : []),
  '-o', output,
];
await new Promise((resolveBuild, rejectBuild) => {
  const child = spawn('cc', arguments_, {
    cwd: repositoryRoot,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    shell: false,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.once('error', rejectBuild);
  child.once('close', (code) => code === 0
    ? resolveBuild()
    : rejectBuild(new Error(`regular-file askpass compiler exited with ${code}`)));
});
await chmod(output, 0o755);
const [entry, canonical] = await Promise.all([lstat(output), realpath(output)]);
if (!entry.isFile() || entry.isSymbolicLink() || canonical !== output || (entry.mode & 0o022) !== 0) {
  throw new Error('regular-file askpass build artifact is unsafe');
}
process.stdout.write(`${JSON.stringify({
  built: true,
  architecture: process.arch,
  output,
  testBoundary: testRoot !== undefined,
})}\n`);
