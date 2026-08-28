import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { NativeSecurityBoundary, SeoriAuthError } from '../src/index.mjs';

const helperPath = '/opt/seori-auth/bin/seori-auth-native';
const nodePath = '/usr/local/bin/node';
const childPath = '/opt/seori-auth/runtime/secret-manager-child.mjs';
const configPath = '/etc/seori-auth/secret-access.json';
const resourceName = 'projects/seori-auth-canary/secrets/fake-execution-copy/versions/1';

async function sha256(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    digest.update(chunk);
    if (Buffer.isBuffer(chunk)) chunk.fill(0);
  }
  return digest.digest('hex');
}

if (process.platform !== 'linux' || process.argv.length !== 2) process.exit(64);

let digestMismatchBlocked = false;
let duplicateBlocked = false;
try {
  const [helperSha256, nodeSha256, childSha256, configSha256] = await Promise.all([
    sha256(helperPath), sha256(nodePath), sha256(childPath), sha256(configPath),
  ]);
  const boundary = await NativeSecurityBoundary.open({
    helperPath,
    expectedSha256: helperSha256,
    resolvePrincipal: async () => {
      throw new Error('principal resolution is unavailable in accessor canary');
    },
  });
  try {
    await boundary.secretManagerAccessor({ nodeSha256, childSha256: '0'.repeat(64), configSha256 });
  } catch (error) {
    digestMismatchBlocked = error instanceof SeoriAuthError && error.code === 'native_helper_mismatch';
  }
  const accessor = await boundary.secretManagerAccessor({ nodeSha256, childSha256, configSha256, timeoutMs: 2_000 });
  const first = accessor.accessVersion({ resourceName });
  const second = accessor.accessVersion({ resourceName });
  const [, secondResult] = await Promise.allSettled([first, second]);
  duplicateBlocked = secondResult.status === 'rejected' &&
    secondResult.reason instanceof SeoriAuthError &&
    secondResult.reason.code === 'secret_load_failed' &&
    secondResult.reason.message === 'duplicate concurrent Secret Manager execution is forbidden';
} catch {
  process.exitCode = 65;
}

if (!digestMismatchBlocked || !duplicateBlocked) process.exitCode = 65;
if (process.exitCode === undefined) {
  process.stdout.write(`${JSON.stringify({
    state: 'NATIVE_ACCESSOR_OK',
    digestMismatchBlocked: true,
    duplicateBlocked: true,
    secretExposed: false,
  })}\n`);
}
