import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

const writerPath = fileURLToPath(
  new URL('../runtime/secret-manager-writer.mjs', import.meta.url),
);

function crc32c(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
    }
  }
  return String((crc ^ 0xffffffff) >>> 0);
}

test('production Secret Manager child writes through the API without public secret exposure', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seori-auth-secret-writer-')));
  const wrapper = join(root, 'gcloud-cli.sh');
  const token = 'test-access-token-0123456789-abcdefghijklmnopqrstuvwxyz';
  const secret = randomBytes(32);
  const resource = 'projects/seorilabs-ci/secrets/seori-auth-journal-mac';
  let requestBody = '';
  const server = createServer((request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, `/v1/${resource}:addVersion`);
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    request.setEncoding('utf8');
    request.on('data', (chunk) => { requestBody += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ name: `${resource}/versions/1`, state: 'ENABLED' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await writeFile(
      wrapper,
      `#!/bin/sh\nif { : <&3; } 2>/dev/null; then exit 9; fi\nprintf '%s\\n' '${token}'\n`,
      { mode: 0o500 },
    );
    await chmod(wrapper, 0o500);
    const address = server.address();
    const child = spawn(process.execPath, [
      writerPath,
      `--resource=${resource}`,
      '--expected-version=1',
    ], {
      env: {
        LANG: 'C.UTF-8',
        SEORI_AUTH_SECRET_FD: '3',
        SEORI_AUTH_RESULT_FD: '5',
        SEORI_AUTH_WRITER_TEST_MODE: '1',
        SEORI_AUTH_WRITER_TEST_GCLOUD_WRAPPER: wrapper,
        SEORI_AUTH_WRITER_TEST_ENDPOINT: `http://127.0.0.1:${address.port}`,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'ignore', 'pipe'],
    });
    child.stdio[3].end(secret);
    const [stdout, stderr, resultText, completion] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      new Response(child.stdio[5]).text(),
      new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      }),
    ]);
    assert.deepEqual(completion, { code: 0, signal: null }, stderr);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
    const result = JSON.parse(resultText);
    assert.deepEqual(JSON.parse(requestBody), {
      payload: { data: secret.toString('base64'), dataCrc32c: crc32c(secret) },
    });
    assert.deepEqual(result, {
      schemaVersion: 1,
      operation: 'secret-version-write',
      resourceName: resource,
      versionResourceName: `${resource}/versions/1`,
      dataCrc32c: crc32c(secret),
      backupRestoreVerified: true,
      secretExposed: false,
    });
    const publicSurfaces = `${stdout}\n${stderr}\n${JSON.stringify(result)}`;
    assert.equal(publicSurfaces.includes(secret.toString('hex')), false);
    assert.equal(publicSurfaces.includes(secret.toString('base64')), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    secret.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});
