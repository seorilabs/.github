#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  chown,
  copyFile,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SeoriAuthError } from '../src/errors.mjs';
import { NativeSecurityBoundary } from '../src/native-boundary.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceHelper = join(packageRoot, '.build', 'seori-auth-native');
const sourceWriter = join(packageRoot, 'fixtures', 'secret-manager-writer-fake-sink.mjs');

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function expectWriteFailure(writer, resourceName, message) {
  const material = randomBytes(32);
  await assert.rejects(
    writer.writeVersion({ resourceName, expectedVersion: 1, material }),
    (error) => error instanceof SeoriAuthError &&
      error.code === 'secret_write_failed' &&
      (message === undefined || error.message === message),
  );
  assert.ok(material.every((byte) => byte === 0));
}

if (process.getuid?.() !== 0) {
  throw new Error('root-owned writer verification must run as root');
}

const rootParent = await realpath(userInfo().homedir);
const root = await mkdtemp(join(rootParent, 'seori-auth-root-writer-'));
const helperPath = join(root, 'seori-auth-native');
const executablePath = join(root, 'node');
const childPath = join(root, 'writer.mjs');

try {
  await Promise.all([
    copyFile(sourceHelper, helperPath),
    copyFile(process.execPath, executablePath),
    copyFile(sourceWriter, childPath),
  ]);
  await Promise.all([
    chown(root, 0, 0),
    chown(helperPath, 0, 0),
    chown(executablePath, 0, 0),
    chown(childPath, 0, 0),
  ]);
  await Promise.all([
    chmod(root, 0o700),
    chmod(helperPath, 0o500),
    chmod(executablePath, 0o500),
    chmod(childPath, 0o400),
  ]);

  const [helperSha256, executableSha256, childSha256] = await Promise.all([
    sha256(helperPath),
    sha256(executablePath),
    sha256(childPath),
  ]);
  const boundary = await NativeSecurityBoundary.open({
    helperPath,
    expectedSha256: helperSha256,
    expectedUid: 0,
    expectedGid: 0,
    resolvePrincipal: async () => ({
      subject: 'root-owned-writer-canary',
      runId: 'local-root-canary',
      repository: 'seorilabs/.github',
      workerId: 'root-owned-writer-canary',
    }),
  });
  const writer = await boundary.secretManagerWriter({
    executablePath,
    executableSha256,
    childPath,
    childSha256,
  });
  const concurrentWriter = await boundary.secretManagerWriter({
    executablePath,
    executableSha256,
    childPath,
    childSha256,
  });

  const serviceOwnedChildPath = join(root, 'service-owned-writer.mjs');
  await copyFile(sourceWriter, serviceOwnedChildPath);
  await chmod(serviceOwnedChildPath, 0o400);
  await chown(serviceOwnedChildPath, 65534, 65534);
  await assert.rejects(
    boundary.secretManagerWriter({
      executablePath,
      executableSha256,
      childPath: serviceOwnedChildPath,
      childSha256,
    }),
    (error) => error instanceof SeoriAuthError && error.code === 'invalid_native_helper',
  );

  const material = randomBytes(32);
  const result = await writer.writeVersion({
    resourceName: 'projects/seori-auth-canary/secrets/fake-root-owned-writer',
    expectedVersion: 1,
    material,
  });
  assert.deepEqual(Object.keys(result).sort(), [
    'backupRestoreVerified',
    'dataCrc32c',
    'operation',
    'resourceName',
    'schemaVersion',
    'secretExposed',
    'versionResourceName',
  ]);
  assert.equal(result.backupRestoreVerified, true);
  assert.equal(result.secretExposed, false);
  assert.ok(material.every((byte) => byte === 0));

  const verificationMaterial = randomBytes(32);
  const verification = await writer.verifyVersion({
    resourceName: 'projects/seori-auth-canary/secrets/fake-root-owned-verifier',
    expectedVersion: 1,
    material: verificationMaterial,
  });
  assert.equal(verification.operation, 'secret-version-verify');
  assert.equal(verification.backupRestoreVerified, true);
  assert.equal(verification.secretExposed, false);
  assert.ok(verificationMaterial.every((byte) => byte === 0));

  const firstMaterial = randomBytes(32);
  const duplicateMaterial = randomBytes(32);
  const firstWrite = writer.writeVersion({
    resourceName: 'projects/seori-auth-canary/secrets/fake-concurrent-writer',
    expectedVersion: 1,
    material: firstMaterial,
  });
  await assert.rejects(
    concurrentWriter.writeVersion({
      resourceName: 'projects/seori-auth-canary/secrets/fake-concurrent-writer',
      expectedVersion: 1,
      material: duplicateMaterial,
    }),
    (error) => error instanceof SeoriAuthError &&
      error.code === 'secret_write_failed' &&
      error.message === 'duplicate concurrent Secret Manager write is forbidden',
  );
  await firstWrite;
  assert.ok(firstMaterial.every((byte) => byte === 0));
  assert.ok(duplicateMaterial.every((byte) => byte === 0));

  await expectWriteFailure(
    writer,
    'projects/seori-auth-canary/secrets/fake-unexpected-result',
    'trusted Secret Manager writer returned an invalid public result',
  );
  await expectWriteFailure(
    writer,
    'projects/seori-auth-canary/secrets/fake-checksum-mismatch',
    'trusted Secret Manager writer returned an invalid public result',
  );
  await expectWriteFailure(
    writer,
    'projects/seori-auth-canary/secrets/fake-version-mismatch',
    'trusted Secret Manager writer returned an invalid public result',
  );
  await expectWriteFailure(
    writer,
    'projects/seori-auth-canary/secrets/fake-oversized-result',
    'Secret Manager writer public result exceeded its bound',
  );

  const originalChild = join(root, 'writer.original.mjs');
  await rename(childPath, originalChild);
  await writeFile(childPath, 'process.exit(0);\n', { mode: 0o400 });
  await expectWriteFailure(
    writer,
    'projects/seori-auth-canary/secrets/fake-replaced-writer',
  );

  await rm(childPath);
  await rename(originalChild, childPath);
  const originalHelper = join(root, 'seori-auth-native.original');
  await rename(helperPath, originalHelper);
  await writeFile(helperPath, '#!/bin/sh\nexit 0\n', { mode: 0o500 });
  await expectWriteFailure(
    writer,
    'projects/seori-auth-canary/secrets/fake-replaced-helper',
  );

  process.stdout.write(`${JSON.stringify({ rootOwnedWriterVerified: true })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
