#!/usr/bin/env node

import { activateP2ProcessHardening } from './p2-process-hardening-boundary.mjs';

const moduleExecutable = process.argv[2];
if (
  process.argv.length !== 3 || process.platform !== 'linux' || process.arch !== 'arm64' ||
  process.geteuid?.() !== 0 ||
  !/^\/root\/seorilabs-p2-native-harness-[a-f0-9]+\/bin\/seorilabs-p2-process-hardening\.node$/u
    .test(moduleExecutable ?? '')
) {
  throw new Error('P2 process hardening child harness boundary is invalid');
}

try {
  const receipt = activateP2ProcessHardening({
    launchMarker: 'SEORI_AUTH_NATIVE_LAUNCHED',
    moduleExecutable,
  });
  if (process.env.SEORI_AUTH_NATIVE_LAUNCHED !== undefined) {
    throw new Error('P2 process hardening launch marker was not consumed');
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: 'P2_PROCESS_HARDENING_BOUNDARY_FAILED',
  })}\n`);
  process.exitCode = 1;
}
