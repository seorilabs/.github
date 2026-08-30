#!/usr/bin/env node
// release authority 테스트가 사용하는 최소 aapt protobuf manifest와 store ZIP AAB를
// 외부 도구 없이 결정적으로 만든다. 실제 검증 경로와 같이 unzip으로 manifest를 읽을 수 있다.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE_ROOT = resolve(ROOT, 'fixtures/release-version-authority');
const CHECK = process.argv.includes('--check');
const ANDROID_NAMESPACE = 'http://schemas.android.com/apk/res/android';

function varint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Buffer.from(bytes);
}

function field(fieldNumber, wireType, payload) {
  return Buffer.concat([varint((fieldNumber << 3) | wireType), payload]);
}

function stringField(fieldNumber, value) {
  const bytes = Buffer.from(value, 'utf8');
  return field(fieldNumber, 2, Buffer.concat([varint(bytes.length), bytes]));
}

function messageField(fieldNumber, value) {
  return field(fieldNumber, 2, Buffer.concat([varint(value.length), value]));
}

function attribute({ namespace = '', name, value }) {
  return Buffer.concat([
    ...(namespace ? [stringField(1, namespace)] : []),
    stringField(2, name),
    stringField(3, value),
  ]);
}

function manifest({ packageName, versionName, versionCode }) {
  const namespace = Buffer.concat([
    stringField(1, 'android'),
    stringField(2, ANDROID_NAMESPACE),
  ]);
  const element = Buffer.concat([
    messageField(1, namespace),
    stringField(3, 'manifest'),
    messageField(4, attribute({ name: 'package', value: packageName })),
    messageField(
      4,
      attribute({ namespace: ANDROID_NAMESPACE, name: 'versionCode', value: String(versionCode) }),
    ),
    messageField(
      4,
      attribute({ namespace: ANDROID_NAMESPACE, name: 'versionName', value: versionName }),
    ),
  ]);
  return messageField(1, element);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + data.length;
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

function aab(manifestBytes) {
  return zip([
    { name: 'base/manifest/AndroidManifest.xml', data: manifestBytes },
    { name: 'BundleConfig.pb', data: Buffer.alloc(0) },
  ]);
}

const cases = [
  {
    directory: 'react-native/android',
    stem: '',
    packageName: 'im.seorilabs.traittesthub',
    versionName: '1.2.3',
    versionCode: 1_001_002_003,
  },
  {
    directory: 'react-native/android',
    stem: '-package-json-authority',
    packageName: 'im.seorilabs.traittesthub',
    versionName: '0.9.3',
    versionCode: 903_000,
  },
  {
    directory: 'godot/android',
    stem: '',
    packageName: 'im.seorilabs.foamparty',
    versionName: '2.0.5',
    versionCode: 1_002_000_005,
  },
  {
    directory: 'godot/android',
    stem: '-config-json-authority',
    packageName: 'im.seorilabs.foamparty',
    versionName: '0.1.0',
    versionCode: 1,
  },
];

for (const fixture of cases) {
  const manifestBytes = manifest(fixture);
  const outputs = new Map([
    [`aab-manifest${fixture.stem}.pb`, manifestBytes],
    [`app-release${fixture.stem}.aab`, aab(manifestBytes)],
  ]);
  for (const [name, expected] of outputs) {
    const path = resolve(FIXTURE_ROOT, fixture.directory, name);
    if (CHECK) {
      if (!readFileSync(path).equals(expected)) throw new Error(`AAB fixture drift: ${path}`);
    } else {
      writeFileSync(path, expected);
    }
  }
}
