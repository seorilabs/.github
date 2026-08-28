#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const imageArgument = process.argv[2];
const image = imageArgument?.startsWith('--image=') ? imageArgument.slice('--image='.length) : undefined;
if (process.argv.length !== 3 || !image || /[\s\0]/.test(image)) {
  throw new Error('usage: verify-container-runtime.mjs --image=<local-image-reference>');
}

const suffix = `${process.pid}-${randomBytes(6).toString('hex')}`;
const projectedVolume = `seori-auth-projected-${suffix}`;
const escapeVolume = `seori-auth-escape-${suffix}`;
const configVolume = `seori-auth-config-${suffix}`;
const fakeToken = 'FAKE_K8S_PROJECTED_TOKEN_CANARY_20260828';
const fakeSecretAccessConfig = `${JSON.stringify({
  schemaVersion: 1,
  allowedResources: ['projects/seori-auth-canary/secrets/fake-execution-copy/versions/1'],
  workloadIdentity: {
    audience: '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/seori-auth/providers/microk8s',
    impersonationUrl: 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/seori-auth-canary%40example-project.iam.gserviceaccount.com:generateAccessToken',
  },
  egressProxy: {
    uri: 'https://egress.invalid:8443',
    serverName: 'egress.invalid',
    caPath: '/etc/seori-auth/egress/ca.crt',
    certificatePath: '/etc/seori-auth/egress/tls.crt',
    privateKeyPath: '/etc/seori-auth/egress/tls.key',
  },
})}\n`;

async function docker(args, expectedCode = 0) {
  try {
    const result = await execFileAsync('docker', args, { maxBuffer: 1024 * 1024 });
    assert.equal(expectedCode, 0, 'docker command unexpectedly succeeded');
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const code = Number(error.code);
    if (code !== expectedCode) throw error;
    return { code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function hardenedRun(extra) {
  return [
    'run', '--rm', '--platform', 'linux/arm64', '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', ...extra,
  ];
}

try {
  await docker(['volume', 'create', projectedVolume]);
  await docker(['volume', 'create', escapeVolume]);
  await docker(['volume', 'create', configVolume]);
  await docker([
    'run', '--rm', '--platform', 'linux/arm64', '--user', '0', '--network', 'none',
    '-v', `${configVolume}:/etc/seori-auth`,
    '--entrypoint', '/usr/local/bin/node', image, '-e',
    "const fs=require('node:fs');const p='/etc/seori-auth/secret-access.json';fs.writeFileSync(p,Buffer.from(process.argv[1],'base64'));fs.chownSync(p,0,65532);fs.chmodSync(p,0o440)",
    Buffer.from(fakeSecretAccessConfig, 'utf8').toString('base64'),
  ]);
  const setup = [
    "const fs=require('node:fs')",
    "const root='/var/run/seori-auth/projected-identity'",
    "const version=`${root}/..2026_08_28_00_00_00.000000000`",
    'fs.mkdirSync(version,{mode:0o755})',
    `fs.writeFileSync(\`${'${version}'}/token\`,${JSON.stringify(`${fakeToken}\n`)},{mode:0o440})`,
    "fs.chownSync(`${version}/token`,0,65532)",
    "fs.symlinkSync('..2026_08_28_00_00_00.000000000',`${root}/..data`)",
    "fs.symlinkSync('..data/token',`${root}/token`)",
  ].join(';');
  await docker([
    'run', '--rm', '--platform', 'linux/arm64', '--user', '0', '--network', 'none',
    '-v', `${projectedVolume}:/var/run/seori-auth/projected-identity`,
    '--entrypoint', '/usr/local/bin/node', image, '-e', setup,
  ]);
  await docker([
    'run', '--rm', '--platform', 'linux/arm64', '--user', '0', '--network', 'none',
    '-v', `${escapeVolume}:/var/run/seori-auth/projected-identity`,
    '--entrypoint', '/usr/local/bin/node', image, '-e',
    "require('node:fs').symlinkSync('/etc/passwd','/var/run/seori-auth/projected-identity/token')",
  ]);

  const brokerCanary = await docker(hardenedRun([image]));
  assert.deepEqual(JSON.parse(brokerCanary.stdout), { state: 'CANARY_OK', secretExposed: false });
  assert.equal(brokerCanary.stderr, '');

  const childHardening = await docker(hardenedRun([
    '--entrypoint', '/opt/seori-auth/bin/seori-auth-native', image, 'process-hardening-self-test',
  ]));
  assert.deepEqual(JSON.parse(childHardening.stdout), {
    state: 'PROCESS_HARDENING_OK', coreDumps: false, noNewPrivileges: true,
  });

  const projected = await docker(hardenedRun([
    '-v', `${projectedVolume}:/var/run/seori-auth/projected-identity:ro`,
    '--entrypoint', '/opt/seori-auth/bin/seori-auth-native', image, 'projected-token-self-test',
  ]));
  assert.deepEqual(JSON.parse(projected.stdout), {
    state: 'PROJECTED_TOKEN_OK', tokenExposed: false, fdReusable: false,
  });

  const escape = await docker(hardenedRun([
    '-v', `${escapeVolume}:/var/run/seori-auth/projected-identity:ro`,
    '--entrypoint', '/opt/seori-auth/bin/seori-auth-native', image, 'projected-token-self-test',
  ]), 126);
  assert.match(escape.stderr, /crossed its trust boundary/);
  assert.doesNotMatch(`${escape.stdout}${escape.stderr}`, new RegExp(`${fakeToken}|/etc/passwd`));

  const argv = await docker(hardenedRun([
    '--entrypoint', '/opt/seori-auth/bin/seori-auth-native', image,
    'launch-with-projected-token', '--', '/usr/local/bin/node', '/tmp/untrusted-child.mjs',
    '--config=/etc/seori-auth/secret-access.json',
    '--resource=projects/seori-auth-canary/secrets/fake-execution-copy/versions/1',
  ]), 126);
  assert.match(argv.stderr, /fixed Secret Manager child contract/);
  assert.doesNotMatch(`${argv.stdout}${argv.stderr}`, /untrusted-child|fake-execution-copy/);

  const accessor = await docker(hardenedRun([
    '-v', `${projectedVolume}:/var/run/seori-auth/projected-identity:ro`,
    '-v', `${configVolume}:/etc/seori-auth:ro`,
    '--entrypoint', '/usr/local/bin/node', image,
    '/opt/seori-auth/runtime/native-accessor-canary.mjs',
  ]));
  assert.deepEqual(JSON.parse(accessor.stdout), {
    state: 'NATIVE_ACCESSOR_OK',
    digestMismatchBlocked: true,
    duplicateBlocked: true,
    secretExposed: false,
  });

  process.stdout.write(`${JSON.stringify({
    state: 'CONTAINER_RUNTIME_OK',
    secretExposed: false,
    projectedTokenFdReusable: false,
    escapeBlocked: true,
    digestMismatchBlocked: true,
    duplicateBlocked: true,
  })}\n`);
} finally {
  await docker(['volume', 'rm', '--force', projectedVolume]).catch(() => {});
  await docker(['volume', 'rm', '--force', escapeVolume]).catch(() => {});
  await docker(['volume', 'rm', '--force', configVolume]).catch(() => {});
}
