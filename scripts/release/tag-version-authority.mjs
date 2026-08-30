// GitHub release tag를 모든 지원 마켓 artifact의 유일한 version source of truth로 고정하는
// 조직 정본 구현. contracts/release-version-authority.yaml의 기계 판독 계약과 1:1로 대응한다.
//
// 이 모듈은 Node 표준 라이브러리만 사용한다. 재사용 워크플로우가 exact called-workflow SHA로
// 체크아웃한 번들에서 npm 설치 없이 그대로 실행하기 때문이다.
import { createHash } from 'node:crypto';

export const AUTHORITY_ID = 'release-version-authority-v1';
export const BINDING_SCHEMA_VERSION = 1;
export const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
export const VERSION_SEGMENT_BASE = 1000;
export const VERSION_CODE_MAX = 2_100_000_000;
export const TAG_RECEIPT_MARKER = 'seori-release-binding: 1';
export const ARTIFACT_KINDS = Object.freeze(['android-app-bundle', 'xcode-archive', 'ait']);

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const AIT_MAGIC = Buffer.from('AITBUNDL', 'ascii');
const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** 모든 authority 위반은 code를 가진 단일 오류 타입으로 fail-closed한다. */
export class ReleaseAuthorityError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'ReleaseAuthorityError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReleaseAuthorityError(code, message);
}

function requireSha(value, label) {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    fail('source-sha-mismatch', `${label}는 40자리 소문자 hex commit SHA여야 한다: ${value ?? 'missing'}`);
  }
  return value;
}

function requireDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    fail('config-revision-mismatch', `${label}는 64자리 소문자 hex sha256이어야 한다: ${value ?? 'missing'}`);
  }
  return value;
}

/** exact stable SemVer 태그만 허용한다. prerelease와 build metadata는 마켓 artifact를 만들지 않는다. */
export function parseReleaseTag(tag) {
  const match = RELEASE_TAG_PATTERN.exec(typeof tag === 'string' ? tag : '');
  if (match === null) {
    fail('tag-pattern-mismatch', `release tag는 exact stable SemVer vMAJOR.MINOR.PATCH여야 한다: ${tag ?? 'missing'}`);
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (minor > VERSION_SEGMENT_BASE - 1 || patch > VERSION_SEGMENT_BASE - 1) {
    fail(
      'tag-pattern-mismatch',
      `minor와 patch는 versionCode 세그먼트 규칙상 각각 ${VERSION_SEGMENT_BASE} 미만이어야 한다: ${tag}`,
    );
  }

  return { tag, major, minor, patch };
}

/**
 * v prefix를 제거한 값이 display/marketing version이고, Android versionCode와 Apple build
 * number는 기존 org resolver 규칙(세그먼트 base 1000)으로 파생한다.
 */
export function deriveReleaseVersion(tag) {
  const { major, minor, patch } = parseReleaseTag(tag);
  const buildNumber = major * 1_000_000 + minor * VERSION_SEGMENT_BASE + patch;
  if (!Number.isSafeInteger(buildNumber) || buildNumber > VERSION_CODE_MAX) {
    fail('tag-pattern-mismatch', `파생 versionCode가 Google Play 최대값을 넘는다: ${buildNumber}`);
  }

  const versionName = `${major}.${minor}.${patch}`;
  return {
    releaseTag: tag,
    versionName,
    displayVersion: versionName,
    androidVersionCode: buildNumber,
    appleMarketingVersion: versionName,
    appleBuildNumber: buildNumber,
    releaseName: versionName,
  };
}

/**
 * release_tag 입력이 비었을 때 사용할 최신 stable tag를 고른다. prerelease, build metadata,
 * leading zero, 비정수 세그먼트는 후보에서 제외한다. 비교는 문자열 정렬이 아닌 수치 비교다.
 */
export function selectLatestStableTag(tags) {
  let best = null;
  for (const candidate of Array.isArray(tags) ? tags : String(tags ?? '').split('\n')) {
    const tag = candidate.trim();
    const match = RELEASE_TAG_PATTERN.exec(tag);
    if (match === null) {
      continue;
    }
    const parsed = {
      tag,
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
    };
    if (parsed.minor > VERSION_SEGMENT_BASE - 1 || parsed.patch > VERSION_SEGMENT_BASE - 1) {
      continue;
    }
    const buildNumber = parsed.major * 1_000_000 + parsed.minor * VERSION_SEGMENT_BASE + parsed.patch;
    if (!Number.isSafeInteger(buildNumber) || buildNumber > VERSION_CODE_MAX) {
      // versionCode를 파생할 수 없는 태그는 마켓 artifact를 만들 수 없으므로 후보가 아니다.
      continue;
    }
    if (
      best === null ||
      parsed.major > best.major ||
      (parsed.major === best.major && parsed.minor > best.minor) ||
      (parsed.major === best.major && parsed.minor === best.minor && parsed.patch > best.patch)
    ) {
      best = parsed;
    }
  }
  if (best === null) {
    fail('tag-pattern-mismatch', 'release_tag가 비어 있고 사용할 stable vX.Y.Z 태그도 없다.');
  }
  return best.tag;
}

/**
 * authority 계약 본문의 revision. 워크플로우와 무관하게 같은 값이므로 annotated tag receipt에
 * 넣어, 같은 태그를 다른 version-authority 계약으로 다시 build하는 것을 배포 시점에 막는다.
 */
export function computeAuthorityRevision(authorityContract) {
  if (typeof authorityContract !== 'string' || authorityContract.length === 0) {
    fail('config-revision-mismatch', 'authority 계약 본문이 필요하다.');
  }
  return createHash('sha256').update(authorityContract, 'utf8').digest('hex');
}

/** 같은 tag를 다른 계약/워크플로우 revision으로 build하면 값이 달라지는 config revision. */
export function computeConfigRevision({
  calledWorkflowRepository,
  calledWorkflowRef,
  calledWorkflowSha,
  authorityRevision,
}) {
  if (calledWorkflowRepository !== 'seorilabs/.github') {
    fail(
      'config-revision-mismatch',
      `called workflow repository는 seorilabs/.github여야 한다: ${calledWorkflowRepository ?? 'missing'}`,
    );
  }
  if (typeof calledWorkflowSha !== 'string' || !/^[0-9a-f]{40}$/u.test(calledWorkflowSha)) {
    fail(
      'config-revision-mismatch',
      `called workflow SHA는 floating ref 없이 40자리 hex여야 한다: ${calledWorkflowSha ?? 'missing'}`,
    );
  }

  const expectedRef = `${calledWorkflowRepository}/`;
  if (typeof calledWorkflowRef !== 'string' || !calledWorkflowRef.startsWith(expectedRef)) {
    fail('config-revision-mismatch', `called workflow ref가 org 번들 경로가 아니다: ${calledWorkflowRef ?? 'missing'}`);
  }
  if (!calledWorkflowRef.endsWith(`@${calledWorkflowSha}`)) {
    fail(
      'config-revision-mismatch',
      `called workflow ref는 floating ref 없이 full commit SHA로 고정되어야 한다: ${calledWorkflowRef}`,
    );
  }
  requireDigest(authorityRevision, 'authority revision');

  const canonical = [
    `authority=${AUTHORITY_ID}`,
    `calledWorkflowRepository=${calledWorkflowRepository}`,
    `calledWorkflowRef=${calledWorkflowRef}`,
    `calledWorkflowSha=${calledWorkflowSha}`,
    `authorityRevision=${authorityRevision}`,
    '',
  ].join('\n');

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** tag, source SHA, config revision, 파생 version을 하나의 불변 binding으로 고정한다. */
export function createReleaseBinding({ tag, sourceSha, configRevision, authorityRevision }) {
  const version = deriveReleaseVersion(tag);
  requireSha(sourceSha, 'release source SHA');
  requireDigest(configRevision, 'config revision');
  requireDigest(authorityRevision, 'authority revision');

  return {
    schemaVersion: BINDING_SCHEMA_VERSION,
    authority: AUTHORITY_ID,
    authorityRevision,
    tag: version.releaseTag,
    sourceSha,
    configRevision,
    versionName: version.versionName,
    androidVersionCode: version.androidVersionCode,
    appleMarketingVersion: version.appleMarketingVersion,
    appleBuildNumber: version.appleBuildNumber,
    releaseName: version.releaseName,
  };
}

const BINDING_FIELDS = Object.freeze([
  'schemaVersion',
  'authority',
  'authorityRevision',
  'tag',
  'sourceSha',
  'configRevision',
  'versionName',
  'androidVersionCode',
  'appleMarketingVersion',
  'appleBuildNumber',
  'releaseName',
]);

export function canonicalBindingLines(binding) {
  return BINDING_FIELDS.map((field) => `${field}=${binding[field]}`).join('\n');
}

export function bindingDigest(binding) {
  return createHash('sha256').update(`${canonicalBindingLines(binding)}\n`, 'utf8').digest('hex');
}

/** binding JSON을 다시 읽을 때 형태와 파생값을 모두 재검증한다. */
export function parseReleaseBinding(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('artifact-provenance-mismatch', 'release binding JSON을 파싱하지 못했다.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('artifact-provenance-mismatch', 'release binding은 객체여야 한다.');
  }
  if (parsed.schemaVersion !== BINDING_SCHEMA_VERSION || parsed.authority !== AUTHORITY_ID) {
    fail(
      'config-revision-mismatch',
      `release binding authority가 다르다: ${parsed.authority ?? 'missing'}@${parsed.schemaVersion ?? 'missing'}`,
    );
  }

  const rebuilt = createReleaseBinding({
    tag: parsed.tag,
    sourceSha: parsed.sourceSha,
    configRevision: parsed.configRevision,
    authorityRevision: parsed.authorityRevision,
  });
  for (const field of BINDING_FIELDS) {
    if (String(parsed[field]) !== String(rebuilt[field])) {
      fail(
        'artifact-provenance-mismatch',
        `release binding ${field}이 tag 파생값과 다르다: ${parsed[field]} != ${rebuilt[field]}`,
      );
    }
  }
  return rebuilt;
}

/** release-tag.yml이 annotated tag message에 남기는 불변 receipt. */
export function renderTagReceipt(binding) {
  return [
    TAG_RECEIPT_MARKER,
    `authority: ${binding.authority}`,
    `authority-revision: ${binding.authorityRevision}`,
    `tag: ${binding.tag}`,
    `source-sha: ${binding.sourceSha}`,
    `version-name: ${binding.versionName}`,
    `android-version-code: ${binding.androidVersionCode}`,
    `apple-build-number: ${binding.appleBuildNumber}`,
  ].join('\n');
}

/** annotated tag message에서 receipt를 읽는다. 없으면 null. */
export function parseTagReceipt(message) {
  const text = typeof message === 'string' ? message : '';
  if (!text.includes(TAG_RECEIPT_MARKER)) {
    return null;
  }

  const fields = new Map();
  for (const line of text.split('\n')) {
    const match = /^([a-z-]+):[ \t]*(.*)$/u.exec(line.trim());
    if (match !== null) {
      fields.set(match[1], match[2].trim());
    }
  }

  return {
    authority: fields.get('authority') ?? '',
    authorityRevision: fields.get('authority-revision') ?? '',
    tag: fields.get('tag') ?? '',
    sourceSha: fields.get('source-sha') ?? '',
    versionName: fields.get('version-name') ?? '',
    androidVersionCode: fields.get('android-version-code') ?? '',
    appleBuildNumber: fields.get('apple-build-number') ?? '',
  };
}

/**
 * 태그 receipt가 있으면 binding과 exact match해야 한다. 같은 tag를 다른 source에서 다시 쓰는
 * 시도는 여기서 fail-closed한다.
 */
export function assertTagReceipt(binding, receipt) {
  if (receipt === null) {
    return;
  }
  if (receipt.authority !== binding.authority) {
    fail('config-revision-mismatch', `tag receipt authority가 다르다: ${receipt.authority} != ${binding.authority}`);
  }
  if (receipt.authorityRevision !== binding.authorityRevision) {
    fail(
      'tag-reuse-with-different-config',
      `tag receipt의 authority 계약 revision이 현재 실행 계약과 다르다: ` +
        `${receipt.authorityRevision || 'missing'} != ${binding.authorityRevision}`,
    );
  }
  if (receipt.tag !== binding.tag) {
    fail('tag-ref-mismatch', `tag receipt의 tag가 다르다: ${receipt.tag} != ${binding.tag}`);
  }
  if (receipt.sourceSha !== binding.sourceSha) {
    fail(
      'tag-reuse-with-different-source',
      `tag receipt의 source SHA가 현재 tag commit과 다르다: ${receipt.sourceSha} != ${binding.sourceSha}`,
    );
  }
  if (receipt.versionName !== binding.versionName) {
    fail('artifact-provenance-mismatch', `tag receipt versionName이 다르다: ${receipt.versionName} != ${binding.versionName}`);
  }
  if (receipt.androidVersionCode !== String(binding.androidVersionCode)) {
    fail(
      'artifact-provenance-mismatch',
      `tag receipt androidVersionCode가 다르다: ${receipt.androidVersionCode} != ${binding.androidVersionCode}`,
    );
  }
  if (receipt.appleBuildNumber !== String(binding.appleBuildNumber)) {
    fail(
      'artifact-provenance-mismatch',
      `tag receipt appleBuildNumber가 다르다: ${receipt.appleBuildNumber} != ${binding.appleBuildNumber}`,
    );
  }
}

/**
 * checkout된 HEAD와 refs/tags 해석 결과가 같은 commit을 가리켜야 한다.
 * 태그는 actions/checkout이 fetch-depth 0 + fetch-tags로 GitHub에서 직접 가져온 값이므로
 * refs/tags 해석이 곧 원격 값이다. 동명 branch나 stale local ref는 여기서 fail-closed한다.
 */
export function assertSourceBinding({ binding, headSha, localTagSha }) {
  const observed = {
    'checkout HEAD': headSha,
    'refs/tags commit': localTagSha,
  };
  for (const [label, value] of Object.entries(observed)) {
    requireSha(value, label);
    if (value !== binding.sourceSha) {
      fail('source-sha-mismatch', `${label}가 release binding source SHA와 다르다: ${value} != ${binding.sourceSha}`);
    }
  }
}

/** AppsInToss 배포 memo는 tag에서 파생한 canonical 문자열만 사용한다. */
export function canonicalReleaseMemo(binding, note = '') {
  const trimmed = typeof note === 'string' ? note.trim().replace(/\s+/gu, ' ') : '';
  const head = `${binding.tag} ${binding.versionName} (${binding.androidVersionCode}) ${binding.sourceSha.slice(0, 12)}`;
  const memo = trimmed.length > 0 ? `${head} · ${trimmed}` : head;
  return memo.length > 1000 ? memo.slice(0, 1000) : memo;
}

const ANDROID_RESOURCE_NAMESPACE = 'http://schemas.android.com/apk/res/android';

/**
 * protobuf 최소 reader. AAB의 AndroidManifest.xml은 aapt.pb.XmlNode 바이너리이며 런타임에
 * 외부 도구(aapt2/bundletool)를 쓰지 않고 필요한 필드만 읽는다. 반복 필드를 보존한다.
 */
function readProtobufFields(buffer) {
  const fields = new Map();
  let offset = 0;

  const readVarint = () => {
    let shift = 0;
    let value = 0;
    while (offset < buffer.length) {
      const byte = buffer[offset];
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        return value;
      }
      shift += 7;
      if (shift > 56) {
        fail('artifact-provenance-mismatch', 'protobuf varint이 지원 범위를 넘는다.');
      }
    }
    fail('artifact-provenance-mismatch', 'protobuf varint이 잘렸다.');
    return 0;
  };

  const push = (fieldNumber, value) => {
    const existing = fields.get(fieldNumber);
    if (existing === undefined) {
      fields.set(fieldNumber, [value]);
    } else {
      existing.push(value);
    }
  };

  while (offset < buffer.length) {
    const key = readVarint();
    const fieldNumber = Math.floor(key / 8);
    const wireType = key % 8;
    if (wireType === 0) {
      push(fieldNumber, readVarint());
    } else if (wireType === 2) {
      const length = readVarint();
      if (offset + length > buffer.length) {
        fail('artifact-provenance-mismatch', 'protobuf length-delimited 필드가 잘렸다.');
      }
      push(fieldNumber, buffer.subarray(offset, offset + length));
      offset += length;
    } else if (wireType === 5) {
      offset += 4;
    } else if (wireType === 1) {
      offset += 8;
    } else {
      fail('artifact-provenance-mismatch', `지원하지 않는 protobuf wire type: ${wireType}`);
    }
  }

  return fields;
}

function protobufString(fields, fieldNumber) {
  const value = fields.get(fieldNumber)?.[0];
  return Buffer.isBuffer(value) ? value.toString('utf8') : '';
}

/**
 * AAB의 base/manifest/AndroidManifest.xml(aapt.pb.XmlNode)에서 manifest element의
 * android:versionName과 android:versionCode를 읽는다.
 */
export function parseAabManifest(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (bytes.length === 0) {
    fail('artifact-provenance-mismatch', 'AAB manifest가 비어 있다.');
  }

  const elementBytes = readProtobufFields(bytes).get(1)?.[0];
  if (!Buffer.isBuffer(elementBytes)) {
    fail('artifact-provenance-mismatch', 'AAB manifest에서 XML element를 찾지 못했다.');
  }

  const element = readProtobufFields(elementBytes);
  if (protobufString(element, 3) !== 'manifest') {
    fail('artifact-provenance-mismatch', 'AAB manifest 루트 element가 manifest가 아니다.');
  }

  const found = new Map();
  for (const attributeBytes of element.get(4) ?? []) {
    if (!Buffer.isBuffer(attributeBytes)) {
      continue;
    }
    const attribute = readProtobufFields(attributeBytes);
    if (protobufString(attribute, 1) !== ANDROID_RESOURCE_NAMESPACE) {
      continue;
    }
    const name = protobufString(attribute, 2);
    if (name !== 'versionName' && name !== 'versionCode') {
      continue;
    }
    if (found.has(name)) {
      continue;
    }

    let value = protobufString(attribute, 3);
    if (name === 'versionCode' && !/^\d+$/u.test(value)) {
      // 원문 문자열이 없으면 compiled_item.prim.int_decimal_value를 읽는다.
      const compiledItem = attribute.get(6)?.[0];
      const primitive = Buffer.isBuffer(compiledItem)
        ? readProtobufFields(compiledItem).get(7)?.[0]
        : undefined;
      const decimal = Buffer.isBuffer(primitive)
        ? readProtobufFields(primitive).get(6)?.[0]
        : undefined;
      value = typeof decimal === 'number' ? String(decimal) : value;
    }
    found.set(name, value);
  }

  const versionName = found.get('versionName');
  const rawCode = found.get('versionCode');
  if (versionName === undefined || versionName.length === 0) {
    fail('artifact-provenance-mismatch', 'AAB manifest에 android:versionName이 없다.');
  }
  if (rawCode === undefined || !/^\d+$/u.test(rawCode)) {
    fail('artifact-provenance-mismatch', `AAB manifest versionCode를 정수로 읽지 못했다: ${rawCode ?? 'missing'}`);
  }

  const versionCode = Number(rawCode);
  if (!Number.isSafeInteger(versionCode)) {
    fail('artifact-provenance-mismatch', `AAB manifest versionCode가 안전한 정수가 아니다: ${rawCode}`);
  }

  return { versionName, versionCode };
}

/** plutil -convert json 출력에서 Apple marketing version과 build number를 읽는다. */
export function parseInfoPlistJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch {
    fail('artifact-provenance-mismatch', 'Info.plist JSON을 파싱하지 못했다.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('artifact-provenance-mismatch', 'Info.plist JSON은 객체여야 한다.');
  }

  const versionName = parsed.CFBundleShortVersionString;
  const rawBuild = parsed.CFBundleVersion;
  if (typeof versionName !== 'string' || versionName.length === 0) {
    fail('artifact-provenance-mismatch', 'Info.plist에 CFBundleShortVersionString이 없다.');
  }
  if (rawBuild === undefined || rawBuild === null || String(rawBuild).length === 0) {
    fail('artifact-provenance-mismatch', 'Info.plist에 CFBundleVersion이 없다.');
  }
  if (!/^\d+$/u.test(String(rawBuild))) {
    fail('artifact-provenance-mismatch', `Info.plist CFBundleVersion이 정수가 아니다: ${rawBuild}`);
  }

  return { versionName, versionCode: Number(rawBuild) };
}

/**
 * .ait 컨테이너를 읽는다. AIT v1 헤더는 deploymentId와 appName을 담고, legacy zip 번들은
 * entry 목록만 갖는다. 어느 형식도 version 필드를 갖지 않으므로 version authority는 tag다.
 */
export function readAitContainer(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (bytes.length < 4) {
    fail('artifact-provenance-mismatch', '.ait 아티팩트가 비어 있다.');
  }

  if (bytes.subarray(0, AIT_MAGIC.length).equals(AIT_MAGIC)) {
    if (bytes.length < 20) {
      fail('artifact-provenance-mismatch', 'AIT 헤더가 잘렸다.');
    }
    const formatVersion = bytes.readUInt32BE(8);
    const bundleLength = Number(bytes.readBigUInt64BE(12));
    if (!Number.isSafeInteger(bundleLength) || 20 + bundleLength > bytes.length) {
      fail('artifact-provenance-mismatch', `AIT bundle 길이가 파일 크기를 넘는다: ${bundleLength}`);
    }
    const fields = readProtobufFields(bytes.subarray(20, 20 + bundleLength));
    const deploymentId = protobufString(fields, 2);
    const appName = protobufString(fields, 3);
    if (appName.length === 0) {
      fail('artifact-provenance-mismatch', 'AIT bundle에서 appName을 읽지 못했다.');
    }
    return { format: 'ait', formatVersion, deploymentId, appName };
  }

  if (bytes.subarray(0, ZIP_LOCAL_HEADER.length).equals(ZIP_LOCAL_HEADER)) {
    return { format: 'zip', formatVersion: 0, deploymentId: '', appName: '' };
  }

  fail('artifact-provenance-mismatch', '.ait 아티팩트가 AIT/ZIP 컨테이너가 아니다.');
  return null;
}

const GODOT_PLATFORM_VERSION_KEYS = Object.freeze({
  Android: (binding) => [
    ['version/code', String(binding.androidVersionCode)],
    ['version/name', `"${binding.versionName}"`],
  ],
  iOS: (binding) => [
    ['application/short_version', `"${binding.appleMarketingVersion}"`],
    ['application/version', `"${binding.appleBuildNumber}"`],
  ],
});

/**
 * Godot export preset의 version 값을 tag 파생값으로 덮어쓴다. export_presets.cfg는 authority가
 * 아니라 주입 대상이며, 실제 반영 여부는 artifact readback으로 다시 확인한다.
 */
export function applyGodotExportVersion(text, { platform, binding }) {
  const keyFactory = GODOT_PLATFORM_VERSION_KEYS[platform];
  if (keyFactory === undefined) {
    fail('artifact-provenance-mismatch', `지원하지 않는 Godot export platform: ${platform}`);
  }

  const lines = String(text ?? '').split('\n');
  const sections = new Map();
  let current = null;
  lines.forEach((line, index) => {
    const header = /^\[([^\]]+)\]\s*$/u.exec(line.trim());
    if (header !== null) {
      current = { name: header[1], start: index + 1, end: index + 1 };
      sections.set(header[1], current);
      return;
    }
    if (current !== null) {
      current.end = index + 1;
    }
  });

  let presetName = null;
  for (const [name, section] of sections) {
    if (!/^preset\.\d+$/u.test(name)) {
      continue;
    }
    const body = lines.slice(section.start, section.end);
    if (body.some((line) => line.trim() === `platform="${platform}"`)) {
      presetName = name;
      break;
    }
  }
  if (presetName === null) {
    fail('artifact-provenance-mismatch', `export_presets.cfg에 ${platform} preset이 없다.`);
  }

  const options = sections.get(`${presetName}.options`);
  if (options === undefined) {
    fail('artifact-provenance-mismatch', `export_presets.cfg에 ${presetName}.options 섹션이 없다.`);
  }

  const patched = [...lines];
  for (const [key, value] of keyFactory(binding)) {
    const pattern = new RegExp(`^${key.replace('/', '\\/')}\\s*=`, 'u');
    let replaced = false;
    for (let index = options.start; index < options.end; index += 1) {
      if (pattern.test(patched[index].trim())) {
        patched[index] = `${key}=${value}`;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      fail('artifact-provenance-mismatch', `export_presets.cfg ${presetName}.options에 ${key}가 없다.`);
    }
  }

  return patched.join('\n');
}

/** artifact에서 읽은 metadata가 tag 파생 binding과 exact match하는지 검증한다. */
export function assertArtifactVersion({ kind, binding, observed }) {
  if (!ARTIFACT_KINDS.includes(kind)) {
    fail('artifact-provenance-mismatch', `지원하지 않는 artifact kind: ${kind}`);
  }

  if (kind === 'android-app-bundle') {
    if (observed.versionName !== binding.versionName) {
      fail(
        'artifact-provenance-mismatch',
        `AAB versionName이 tag 파생값과 다르다: ${observed.versionName} != ${binding.versionName}`,
      );
    }
    if (observed.versionCode !== binding.androidVersionCode) {
      fail(
        'artifact-provenance-mismatch',
        `AAB versionCode가 tag 파생값과 다르다: ${observed.versionCode} != ${binding.androidVersionCode}`,
      );
    }
    return;
  }

  if (kind === 'xcode-archive') {
    if (observed.versionName !== binding.appleMarketingVersion) {
      fail(
        'artifact-provenance-mismatch',
        `CFBundleShortVersionString이 tag 파생값과 다르다: ${observed.versionName} != ${binding.appleMarketingVersion}`,
      );
    }
    if (observed.versionCode !== binding.appleBuildNumber) {
      fail(
        'artifact-provenance-mismatch',
        `CFBundleVersion이 tag 파생값과 다르다: ${observed.versionCode} != ${binding.appleBuildNumber}`,
      );
    }
    return;
  }

  if (observed.memo !== canonicalReleaseMemo(binding, observed.note ?? '')) {
    fail(
      'artifact-provenance-mismatch',
      `AppsInToss memo가 tag 파생 canonical memo와 다르다: ${observed.memo}`,
    );
  }
  if (typeof observed.digest !== 'string' || !DIGEST_PATTERN.test(observed.digest)) {
    fail(
      'artifact-provenance-mismatch',
      `.ait artifact digest가 sha256 hex가 아니다: ${observed.digest ?? 'missing'}`,
    );
  }
}

export function githubOutputLines(binding) {
  return [
    `release_tag=${binding.tag}`,
    `source_sha=${binding.sourceSha}`,
    `config_revision=${binding.configRevision}`,
    `authority_revision=${binding.authorityRevision}`,
    `version_name=${binding.versionName}`,
    `display_version=${binding.versionName}`,
    `android_version_code=${binding.androidVersionCode}`,
    `apple_marketing_version=${binding.appleMarketingVersion}`,
    `apple_build_number=${binding.appleBuildNumber}`,
    `release_name=${binding.releaseName}`,
    `binding_digest=${bindingDigest(binding)}`,
  ];
}
