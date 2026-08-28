import { EncryptedBrowserVault, NativeSecurityBoundary } from '../src/index.mjs';

const [vaultDirectory, runtimeDirectory, helperPath] = process.argv.slice(2);
if (![vaultDirectory, runtimeDirectory, helperPath].every((value) => value?.startsWith('/'))) {
  process.exit(2);
}

const boundary = await NativeSecurityBoundary.open({
  helperPath,
  resolvePrincipal: async () => ({
    subject: 'fixture',
    runId: 'fixture',
    repository: 'seorilabs/fixture',
    workerId: 'fixture',
  }),
});
const vault = await EncryptedBrowserVault.open({
  vaultDirectory,
  runtimeDirectory,
  encryptionKey: Buffer.alloc(32, 0x5c),
  lockProvider: boundary.lockProvider(),
});
await vault.checkout({
  capabilityId: 'crash-capability',
  role: 'release',
  expectedIdentity: {
    provider: 'apps-in-toss',
    accountId: 'automation-account',
    teamId: 'seorilabs-team',
    workspaceId: 'release-workspace',
    appId: 'example-app',
  },
  expectedGeneration: 1,
  executionBinding: {
    subject: 'k8s:release-workers:worker-a',
    runId: 'github:123',
    repository: 'seorilabs/example-app',
    workerId: 'worker-a',
  },
  sourceSha: '1'.repeat(40),
});
process.stdout.write('{"status":"CHECKED_OUT"}\n');
setInterval(() => {}, 60_000);
await new Promise(() => {});
