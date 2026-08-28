#!/usr/bin/env node
import { EncryptedBrowserVault, NativeSecurityBoundary } from '../src/index.mjs';

function parseArguments(values) {
  const parsed = {};
  for (const value of values) {
    const match = value.match(/^--(runtime-directory|native-helper)=(\/.+)$/);
    if (!match || parsed[match[1]] !== undefined) {
      throw new Error('usage: cleanup-browser-runtime --runtime-directory=/absolute/path --native-helper=/absolute/path');
    }
    parsed[match[1]] = match[2];
  }
  if (Object.keys(parsed).length !== 2) {
    throw new Error('usage: cleanup-browser-runtime --runtime-directory=/absolute/path --native-helper=/absolute/path');
  }
  return parsed;
}

const options = parseArguments(process.argv.slice(2));
const boundary = await NativeSecurityBoundary.open({
  helperPath: options['native-helper'],
  resolvePrincipal: async () => ({
    subject: 'supervisor:browser-runtime-cleanup',
    runId: 'supervisor:browser-runtime-cleanup',
    repository: 'seorilabs/dot-github',
    workerId: 'auth-broker-supervisor',
  }),
});
await EncryptedBrowserVault.cleanupRuntime({
  runtimeDirectory: options['runtime-directory'],
  lockProvider: boundary.lockProvider(),
});
process.stdout.write('{"state":"CLEAN"}\n');
