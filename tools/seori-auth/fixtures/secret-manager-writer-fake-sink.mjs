import { timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const SECRET_RESOURCE = /^projects\/[A-Za-z0-9._:-]+\/secrets\/[A-Za-z0-9_-]+$/;

function fail() {
  process.exitCode = 65;
}

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

function exposedOnPublicProcessSurface(material) {
  const surface = JSON.stringify({ argv: process.argv, env: process.env });
  return [
    material.toString('utf8'),
    material.toString('base64'),
    material.toString('hex'),
  ].some((candidate) => candidate.length > 0 && surface.includes(candidate));
}

const secretDescriptor = Number(process.env.SEORI_AUTH_SECRET_FD);
const resultDescriptor = Number(process.env.SEORI_AUTH_RESULT_FD);
const resourceArgument = process.argv[2];
const versionArgument = process.argv[3];
const resourceName = resourceArgument?.startsWith('--resource=')
  ? resourceArgument.slice('--resource='.length)
  : undefined;
const expectedVersion = versionArgument?.startsWith('--expected-version=')
  ? Number(versionArgument.slice('--expected-version='.length))
  : undefined;

let material;
let activeCopy;
let backupCopy;
try {
  if (
    process.argv.length !== 4 || process.argv[1] !== '-' ||
    secretDescriptor !== 3 || resultDescriptor !== 5 ||
    !SECRET_RESOURCE.test(resourceName ?? '') ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion < 1
  ) {
    fail();
  } else {
    material = readFileSync(secretDescriptor);
    if (material.length < 16 || material.length > 4_096) {
      fail();
    } else {
      const secretExposed = exposedOnPublicProcessSurface(material);
      const expectedCrc32c = crc32c(material);
      activeCopy = Buffer.from(material);
      backupCopy = Buffer.from(activeCopy);
      activeCopy.fill(0);
      backupCopy.copy(activeCopy);
      const backupRestoreVerified =
        timingSafeEqual(activeCopy, backupCopy) && crc32c(activeCopy) === expectedCrc32c;

      // These intentionally hostile channels are discarded by the parent boundary.
      process.stdout.write(material);
      process.stderr.write(material.toString('base64'));
      const result = {
        schemaVersion: 1,
        operation: 'secret-version-write',
        resourceName,
        versionResourceName: `${resourceName}/versions/${expectedVersion}`,
        dataCrc32c: expectedCrc32c,
        backupRestoreVerified,
        secretExposed,
      };
      if (resourceName.endsWith('-unexpected-result')) result.unexpected = true;
      if (resourceName.endsWith('-checksum-mismatch')) {
        result.dataCrc32c = String((Number(expectedCrc32c) + 1) % 0x100000000);
      }
      if (resourceName.endsWith('-version-mismatch')) {
        result.versionResourceName = `${resourceName}/versions/${expectedVersion + 1}`;
      }
      if (resourceName.endsWith('-oversized-result')) {
        result.padding = 'x'.repeat(4_096);
      }
      if (resourceName.endsWith('-concurrent-writer')) await delay(150);
      writeFileSync(resultDescriptor, JSON.stringify(result));
      if (!backupRestoreVerified || secretExposed) fail();
    }
  }
} catch {
  fail();
} finally {
  if (Buffer.isBuffer(material)) material.fill(0);
  if (Buffer.isBuffer(activeCopy)) activeCopy.fill(0);
  if (Buffer.isBuffer(backupCopy)) backupCopy.fill(0);
}
