#!/usr/bin/env node
// AIT CLI 2.10.x framing을 재현하는 deterministic test fixture generator.
// framing: magic + formatVersion + protobuf length + protobuf + ZIP length + ZIP + zero trailer.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE_ROOT = resolve(ROOT, 'fixtures/release-version-authority/react-native/ait');
const CHECK = process.argv.includes('--check');

function protobufString(fieldNumber, value) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length >= 128) {
    throw new Error('fixture protobuf string is too long');
  }
  return Buffer.concat([Buffer.from([(fieldNumber << 3) | 2, bytes.length]), bytes]);
}

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function ait(entries) {
  const bundle = Buffer.concat([
    protobufString(2, '00000000-0000-4000-8000-000000000001'),
    protobufString(3, 'trait-test-hub'),
  ]);
  const payload = zip(entries);
  const header = Buffer.alloc(20);
  header.write('AITBUNDL', 0, 'ascii');
  header.writeUInt32BE(1, 8);
  header.writeBigUInt64BE(BigInt(bundle.length), 12);
  const payloadLength = Buffer.alloc(8);
  payloadLength.writeBigUInt64BE(BigInt(payload.length));
  return Buffer.concat([header, bundle, payloadLength, payload, Buffer.alloc(8)]);
}

const fixtures = new Map([
  ['trait-test-hub.ait', ait(['index.html'])],
  ['trait-test-hub-version-metadata.ait', ait(['index.html', 'version.json'])],
]);

for (const [name, expected] of fixtures) {
  const path = resolve(FIXTURE_ROOT, name);
  if (CHECK) {
    if (!readFileSync(path).equals(expected)) {
      throw new Error(`AIT fixture drift: ${name}`);
    }
  } else {
    writeFileSync(path, expected);
  }
}
