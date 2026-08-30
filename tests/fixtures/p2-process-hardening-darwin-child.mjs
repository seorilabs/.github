#!/usr/bin/env node

import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';

const require = createRequire(import.meta.url);
const moduleExecutable = process.argv[2];

if (
  process.argv.length !== 3 || process.platform !== 'darwin' || process.arch !== 'arm64' ||
  !isAbsolute(moduleExecutable ?? '') ||
  !moduleExecutable.endsWith('/.build/seorilabs-p2-process-hardening.node')
) {
  throw new Error('P2 Darwin process hardening test boundary is invalid');
}

try {
  const receipt = require(moduleExecutable);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: 'P2_PROCESS_HARDENING_BOUNDARY_FAILED',
  })}\n`);
  process.exitCode = 1;
}
