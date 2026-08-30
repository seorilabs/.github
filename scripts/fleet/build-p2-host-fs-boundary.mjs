#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const source = resolve(repositoryRoot, 'scripts/fleet/native/p2-host-fs-boundary.c');
let outputArgument;
let testRoot;
let localTestGate = false;
for (const argument of process.argv.slice(2)) {
  if (argument === '--local-test-gate') {
    localTestGate = true;
  } else if (argument.startsWith('--test-root=')) {
    if (testRoot !== undefined) throw new Error('filesystem boundary test root is duplicated');
    testRoot = argument.slice('--test-root='.length);
  } else if (outputArgument === undefined) {
    outputArgument = argument;
  } else {
    throw new Error('filesystem boundary build argument is invalid');
  }
}

if (process.platform !== 'linux') {
  if (!localTestGate) throw new Error('filesystem boundary production build requires Linux');
  process.stdout.write(`${JSON.stringify({ built: false, reason: 'LINUX_REQUIRED' })}\n`);
  process.exit(0);
}
if (
  testRoot !== undefined &&
  (!isAbsolute(testRoot) || normalize(testRoot) !== testRoot ||
    !/^\/var\/tmp\/seorilabs-p2-native-harness-[a-f0-9-]+$/u.test(testRoot))
) {
  throw new Error('filesystem boundary test root is invalid');
}

const defaultOutput = resolve(repositoryRoot, '.build/seorilabs-p2-host-fs-boundary');
if (outputArgument !== undefined && !isAbsolute(outputArgument)) {
  throw new Error('filesystem boundary output must be absolute');
}
const output = outputArgument ?? defaultOutput;

await mkdir(dirname(output), { recursive: true, mode: 0o700 });

const arguments_ = [
  '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-D_FORTIFY_SOURCE=2',
  '-fPIE', '-fstack-protector-strong',
  ...(testRoot === undefined ? [] : [`-DSEORILABS_P2_TEST_ROOT=\"${testRoot}\"`]),
  source, '-pie', '-Wl,-z,relro,-z,now',
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
  child.once('close', (code) => {
    if (code === 0) resolveBuild();
    else rejectBuild(new Error(`filesystem boundary compiler exited with ${code}`));
  });
});

await chmod(output, 0o755);
const [entry, canonical] = await Promise.all([lstat(output), realpath(output)]);
if (!entry.isFile() || entry.isSymbolicLink() || canonical !== output || (entry.mode & 0o022) !== 0) {
  throw new Error('filesystem boundary build artifact is unsafe');
}
process.stdout.write(`${JSON.stringify({
  built: true,
  architecture: process.arch,
  output,
  testBoundary: testRoot !== undefined,
})}\n`);
