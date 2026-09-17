// GitHub release tag를 모든 지원 마켓 artifact의 유일한 version source of truth로 고정하는
// 조직 정본 구현. contracts/release-version-authority.yaml의 기계 판독 계약과 1:1로 대응한다.
//
// 이 모듈은 Node 표준 라이브러리만 사용한다. 재사용 워크플로우가 exact called-workflow SHA로
// 체크아웃한 번들에서 npm 설치 없이 그대로 실행하기 때문이다.
import { createHash } from 'node:crypto';

export const AUTHORITY_ID = 'release-version-authority-v1';
export const BINDING_SCHEMA_VERSION = 2;
export const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
export const VERSION_SEGMENT_BASE = 1000;
// schemaVersion 2 이하에서 Android versionCode 정본이던 태그 파생 공식의 epoch다.
// schemaVersion 3부터 신규 태그의 Android versionCode는 저장소별 원장이 할당하고, 이 값은
// receipt 없는 태그의 재배포 fallback과 런타임 최소지원버전 비교값(runtimeVersionCode)으로만 남는다.
export const ANDROID_VERSION_CODE_EPOCH = 1_000_000_000;
/** Android versionCode의 정본이 무엇인지. binding과 tag receipt에 함께 기록한다. */
export const ANDROID_VERSION_CODE_SOURCES = Object.freeze(['github-ledger', 'legacy-tag-formula']);
/** 역대 계약이 쓰던 태그 파생 변형. superseded receipt는 이 이름으로만 재계산한다. */
export const LEGACY_ANDROID_VERSION_CODE_FORMULAS = Object.freeze([
  'epoch-plus-encoded-version',
  'encoded-version',
]);
export const LEDGER_SCHEMA_VERSION = 1;
export const LEDGER_ANDROID_AUTHORITY = 'github-ledger';
export const LEDGER_IOS_AUTHORITY = 'xcode-cloud';
export const VERSION_MAJOR_MAX = 1099;
export const VERSION_CODE_MAX = 2_100_000_000;
// Apple build number의 tag 파생값은 1 이상이어야 한다. v0.0.0은 0을 만들므로 태그 생성과
// 배포 양쪽에서 같은 하한으로 거부한다.
export const VERSION_CODE_MIN = 1;
export const TAG_RECEIPT_MARKER = 'seori-release-binding: 1';
// 빌드된 artifact 하나를 tag binding에 묶는 receipt. digest가 들어가므로 같은 태그라도
// 다른 파일로 업로드하면 대조에서 어긋난다.
export const ARTIFACT_RECEIPT_MARKER = 'seori-release-artifact: 1';
export const ARTIFACT_KINDS = Object.freeze(['android-app-bundle', 'xcode-archive', 'ait']);
export const RELEASE_TAG_REF_PREFIX = 'refs/tags/';

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

function requireArtifactDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    fail('artifact-digest-mismatch', `${label}는 64자리 소문자 hex sha256이어야 한다: ${value ?? 'missing'}`);
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
  if (
    major > VERSION_MAJOR_MAX ||
    minor > VERSION_SEGMENT_BASE - 1 ||
    patch > VERSION_SEGMENT_BASE - 1
  ) {
    fail(
      'tag-pattern-mismatch',
      `major는 ${VERSION_MAJOR_MAX} 이하이고 minor와 patch는 각각 ` +
        `${VERSION_SEGMENT_BASE} 미만이어야 한다: ${tag}`,
    );
  }

  return { tag, major, minor, patch };
}

/** v prefix를 제거한 값이 display/marketing version이다. 태그 하나가 유일한 정본이다. */
export function deriveMarketingVersion(tag) {
  const { major, minor, patch } = parseReleaseTag(tag);
  const versionName = `${major}.${minor}.${patch}`;
  return {
    releaseTag: tag,
    versionName,
    displayVersion: versionName,
    appleMarketingVersion: versionName,
    releaseName: versionName,
  };
}

/**
 * SemVer를 base-1000 정수로 인코딩한다. 비 Xcode Cloud Apple 경로의 build number 정본이며,
 * Android versionCode가 아니다. 리터럴 1_000_000 대신 segmentBase의 제곱으로 쓴다 —
 * 두 값이 따로 놀면 계약의 공식과 구현이 조용히 어긋난다.
 */
export function deriveEncodedVersion(tag) {
  const { major, minor, patch } = parseReleaseTag(tag);
  const encoded = major * VERSION_SEGMENT_BASE ** 2 + minor * VERSION_SEGMENT_BASE + patch;
  if (encoded < VERSION_CODE_MIN) {
    // v0.0.0은 Apple build number 0을 만든다. 마켓 release tag로 쓰지 않는다.
    fail(
      'derived-version-code-out-of-range',
      `파생 encoded version이 마켓 최소값 ${VERSION_CODE_MIN} 미만이다: ${tag} -> ${encoded}`,
    );
  }
  return encoded;
}

/**
 * epoch + encodedVersion. schemaVersion 3에서 이 값은 두 역할만 갖는다.
 *  1) receipt 없는 태그를 재배포할 때의 legacy fallback
 *  2) Android/iOS 런타임이 공유하는 최소지원버전 비교값(runtimeVersionCode)
 * 신규 태그의 Android versionCode는 이 함수가 만들지 않는다. 원장이 할당한다.
 */
export function deriveTagEncodedVersionCode(tag) {
  const code = ANDROID_VERSION_CODE_EPOCH + deriveEncodedVersion(tag);
  if (!Number.isSafeInteger(code) || code > VERSION_CODE_MAX) {
    fail('tag-pattern-mismatch', `파생 Android versionCode가 Google Play 최대값을 넘는다: ${code}`);
  }
  return code;
}

/** 역대 계약이 쓰던 변형으로 그 시절의 Android versionCode를 재현한다. */
export function legacyAndroidVersionCode(tag, formula) {
  const encoded = deriveEncodedVersion(tag);
  if (formula === 'epoch-plus-encoded-version') {
    return ANDROID_VERSION_CODE_EPOCH + encoded;
  }
  if (formula === 'encoded-version') {
    return encoded;
  }
  fail(
    'tag-reuse-with-different-config',
    `알 수 없는 legacy Android versionCode 공식이다: ${formula ?? 'missing'}`,
  );
  return 0;
}

/** 마켓이 받아들이는 정수 범위인지 확인한다. 원장 할당값과 receipt 판독값 모두 여기를 지난다. */
export function requireVersionCode(value, label) {
  const code = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isSafeInteger(code) || code < VERSION_CODE_MIN || code > VERSION_CODE_MAX) {
    fail(
      'derived-version-code-out-of-range',
      `${label}는 ${VERSION_CODE_MIN}..${VERSION_CODE_MAX} 범위의 정수여야 한다: ${value ?? 'missing'}`,
    );
  }
  return code;
}

/**
 * 마켓 artifact는 `refs/tags/vX.Y.Z` push/dispatch 하나에서만
 * 만든다. branch ref, 동명 ref, prerelease 태그 ref는 여기서 fail-closed한다.
 */
export function parseReleaseTagRef(ref) {
  const text = typeof ref === 'string' ? ref : '';
  if (!text.startsWith(RELEASE_TAG_REF_PREFIX)) {
    fail('tag-ref-mismatch', `release ref는 ${RELEASE_TAG_REF_PREFIX}vX.Y.Z여야 한다: ${ref ?? 'missing'}`);
  }
  const tag = text.slice(RELEASE_TAG_REF_PREFIX.length);
  if (tag.includes('/')) {
    fail('tag-ref-mismatch', `release tag ref에 중첩 경로를 둘 수 없다: ${text}`);
  }
  return parseReleaseTag(tag);
}

/** 어떤 이벤트에서 어떻게 태그를 골랐는지 남기는 값. latest fallback은 하나뿐이다. */
export const RELEASE_TAG_SOURCES = Object.freeze([
  'event-tag-ref',
  'requested-tag',
  'ledger-last-tag',
]);

/**
 * 실행 이벤트에 맞는 release 태그 하나를 고른다.
 *
 * `refs/tags/vX.Y.Z` 이벤트는 그 태그가 곧 정본이다. 저장소에 더 최신 태그가 있더라도
 * latest fallback으로 넘어가면 v1.2.0 태그 push가 v1.3.0을 빌드할 수 있으므로 금지한다.
 * 태그가 없는 실행에서 최신 태그를 고르는 것은 운영자가 명시적으로 시작한 workflow_dispatch
 * 에서만 허용하며, 기준은 전체 태그 나열이 아니라 원장 tip의 release.lastTag 하나다.
 */
export function selectReleaseTagForEvent({
  eventName = '',
  eventRef = '',
  requestedTag = '',
  ledgerLastTag = '',
} = {}) {
  const requested = typeof requestedTag === 'string' ? requestedTag.trim() : '';
  const ref = typeof eventRef === 'string' ? eventRef.trim() : '';

  if (ref.startsWith(RELEASE_TAG_REF_PREFIX)) {
    const { tag } = parseReleaseTagRef(ref);
    if (requested.length > 0 && parseReleaseTag(requested).tag !== tag) {
      fail(
        'tag-ref-mismatch',
        `tag 이벤트에서 다른 태그를 요청할 수 없다: ref=${ref} release_tag=${requested}`,
      );
    }
    return { tag, source: 'event-tag-ref' };
  }

  if (requested.length > 0) {
    if (eventName !== 'workflow_dispatch') {
      fail(
        'tag-ref-mismatch',
        `release_tag 지정은 workflow_dispatch에서만 허용한다: ` +
          `event=${eventName || 'missing'} ref=${ref || 'missing'}`,
      );
    }
    return { tag: parseReleaseTag(requested).tag, source: 'requested-tag' };
  }

  if (eventName !== 'workflow_dispatch') {
    fail(
      'tag-ref-mismatch',
      `release_tag가 비어 있으면 최신 태그 폴백은 workflow_dispatch에서만 허용한다: ` +
        `event=${eventName || 'missing'} ref=${ref || 'missing'}`,
    );
  }
  // 최신 태그 폴백은 전체 태그를 나열하지 않고 원장 tip의 release.lastTag 하나만 읽는다.
  const last = typeof ledgerLastTag === 'string' ? ledgerLastTag.trim() : '';
  if (last.length === 0) {
    fail(
      'tag-ref-mismatch',
      'release_tag가 비어 있고 원장에 release.lastTag도 없다. 태그를 명시하거나 원장을 먼저 초기화한다.',
    );
  }
  return { tag: parseReleaseTag(last).tag, source: 'ledger-last-tag' };
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
  // caller는 중앙 정본의 main을 참조한다. 어느 ref로 불렸는지는 실행 provenance로만 남기고
  // 값이 비어 있어도 해석을 막지 않는다. 릴리즈를 세우는 것은 태그이지 ref 형태가 아니다.
  requireDigest(authorityRevision, 'authority revision');

  const canonical = [
    `authority=${AUTHORITY_ID}`,
    `calledWorkflowRepository=${calledWorkflowRepository ?? ''}`,
    `calledWorkflowRef=${calledWorkflowRef ?? ''}`,
    `calledWorkflowSha=${calledWorkflowSha ?? ''}`,
    `authorityRevision=${authorityRevision}`,
    '',
  ].join('\n');

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * tag, source SHA, config revision, 할당된 번호를 하나의 불변 binding으로 고정한다.
 *
 * androidVersionCode는 더 이상 태그에서 파생하지 않으므로 호출자가 정본을 명시해야 한다.
 *  - github-ledger      : 저장소 원장이 할당한 값(신규 태그 할당, 또는 그 receipt 판독)
 *  - legacy-tag-formula : receipt 없는 태그를 재배포할 때의 fallback
 * marketing version과 비 Xcode Cloud Apple build number는 여전히 태그 하나가 정한다.
 */
export function createReleaseBinding({
  tag,
  sourceSha,
  configRevision,
  authorityRevision,
  androidVersionCode,
  androidVersionCodeSource,
}) {
  const version = deriveMarketingVersion(tag);
  const appleBuildNumber = deriveEncodedVersion(tag);
  requireSha(sourceSha, 'release source SHA');
  requireDigest(configRevision, 'config revision');
  requireDigest(authorityRevision, 'authority revision');

  if (!ANDROID_VERSION_CODE_SOURCES.includes(androidVersionCodeSource)) {
    fail(
      'artifact-provenance-mismatch',
      `androidVersionCodeSource는 ${ANDROID_VERSION_CODE_SOURCES.join('|')} 중 하나여야 한다: ` +
        `${androidVersionCodeSource ?? 'missing'}`,
    );
  }
  const code = requireVersionCode(androidVersionCode, 'Android versionCode');
  if (androidVersionCodeSource === 'legacy-tag-formula' && code !== deriveTagEncodedVersionCode(tag)) {
    // legacy fallback을 자칭하면서 공식과 다른 값을 넣을 수 없다.
    fail(
      'artifact-provenance-mismatch',
      `legacy-tag-formula versionCode가 공식값과 다르다: ${code} != ${deriveTagEncodedVersionCode(tag)}`,
    );
  }

  return {
    schemaVersion: BINDING_SCHEMA_VERSION,
    authority: AUTHORITY_ID,
    authorityRevision,
    tag: version.releaseTag,
    sourceSha,
    configRevision,
    versionName: version.versionName,
    androidVersionCode: code,
    androidVersionCodeSource,
    appleMarketingVersion: version.appleMarketingVersion,
    appleBuildNumber,
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
  'androidVersionCodeSource',
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

  // androidVersionCode는 태그에서 다시 파생하지 않는다. 원장이 할당한 값을 그대로 검증한다.
  const rebuilt = createReleaseBinding({
    tag: parsed.tag,
    sourceSha: parsed.sourceSha,
    configRevision: parsed.configRevision,
    authorityRevision: parsed.authorityRevision,
    androidVersionCode: parsed.androidVersionCode,
    androidVersionCodeSource: parsed.androidVersionCodeSource,
  });
  for (const field of BINDING_FIELDS) {
    if (String(parsed[field]) !== String(rebuilt[field])) {
      fail(
        'artifact-provenance-mismatch',
        `release binding ${field}이 재검증 결과와 다르다: ${parsed[field]} != ${rebuilt[field]}`,
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
    `android-version-code-source: ${binding.androidVersionCodeSource}`,
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
    // schemaVersion 2 이하 receipt에는 이 줄이 없다. 빈 값이 곧 "구 계약이 찍은 receipt"라는 신호다.
    androidVersionCodeSource: fields.get('android-version-code-source') ?? '',
    appleBuildNumber: fields.get('apple-build-number') ?? '',
  };
}

/**
 * 계약이 허용한 과거 authority revision 목록을 계약 본문에서 뽑는다.
 *
 * YAML 파서를 쓰지 않는다. authorityRevision이 계약 본문의 sha256이라 파서를 들이면
 * "파싱 결과"와 "본문 해시"라는 두 정본이 생기고, 이 모듈은 npm 설치 없이 실행되어야 한다.
 * 대신 계약이 고정한 줄 모양만 읽고, 모양이 다르면 통과시키지 않는다.
 * 테스트가 YAML 파서로 뽑은 값과 이 결과를 대조해 둘이 어긋나지 않게 고정한다.
 */
export function extractSupersededRevisions(authorityContract) {
  const body = typeof authorityContract === 'string' ? authorityContract : '';
  const lines = body.split('\n');
  const start = lines.indexOf('supersededAuthorityRevisions:');
  if (start < 0) {
    return [];
  }

  const entries = [];
  let current = null;
  const commit = () => {
    if (current === null) {
      return;
    }
    if (!LEGACY_ANDROID_VERSION_CODE_FORMULAS.includes(current.androidVersionCodeFormula)) {
      fail(
        'tag-reuse-with-different-config',
        `superseded revision ${current.revision}에 알 수 없는 공식이 선언됐다: ` +
          `${current.androidVersionCodeFormula || 'missing'}`,
      );
    }
    entries.push(current);
    current = null;
  };

  for (const line of lines.slice(start + 1)) {
    if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('#')) {
      break;
    }
    const revision = /^ {2}- revision: ([0-9a-f]{64})$/u.exec(line);
    if (revision !== null) {
      commit();
      current = { revision: revision[1], androidVersionCodeFormula: '' };
      continue;
    }
    const formula = /^ {4}androidVersionCodeFormula: ([a-z-]+)$/u.exec(line);
    if (formula !== null && current !== null) {
      current.androidVersionCodeFormula = formula[1];
    }
  }
  commit();

  // 자기참조(목록에 현재 본문의 sha256이 들어가는 것)는 sha256 고정점이 필요해 만들 수 없다.
  // 구조적으로 불가능한 경우를 위한 분기는 두지 않는다.
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.revision)) {
      fail('tag-reuse-with-different-config', `supersededAuthorityRevisions에 중복 revision이 있다: ${entry.revision}`);
    }
    seen.add(entry.revision);
  }
  return entries;
}

/**
 * 태그 receipt가 있으면 binding과 exact match해야 한다. 같은 tag를 다른 source에서 다시 쓰는
 * 시도는 여기서 fail-closed한다.
 */
export function assertTagReceipt(binding, receipt, { supersededRevisions = [] } = {}) {
  if (receipt === null) {
    return;
  }
  if (receipt.authority !== binding.authority) {
    fail('config-revision-mismatch', `tag receipt authority가 다르다: ${receipt.authority} != ${binding.authority}`);
  }
  if (receipt.authorityRevision !== binding.authorityRevision) {
    // 계약 본문이 바뀌면 그 전에 찍힌 receipt의 revision은 영원히 현재 값과 다르다.
    // 명시적으로 등록된 revision만 판독을 허용하되, 목록에 있다는 이유로 값을 믿지는 않는다.
    // 그 계약이 쓰던 공식으로 숫자를 다시 계산해 exact match할 때만 통과시킨다.
    const entry = supersededRevisions.find((item) => item.revision === receipt.authorityRevision);
    if (entry === undefined) {
      fail(
        'tag-reuse-with-different-config',
        `tag receipt의 authority 계약 revision이 현재 계약에도 supersededAuthorityRevisions에도 없다: ` +
          `${receipt.authorityRevision || 'missing'}`,
      );
    }
    if (receipt.androidVersionCodeSource.length > 0) {
      // 구 계약은 이 줄을 찍지 않았다. 있으면 위조된 receipt다.
      fail(
        'tag-reuse-with-different-config',
        `superseded revision receipt에 schemaVersion 3 필드가 있다: ${receipt.authorityRevision}`,
      );
    }
    const expectedAndroid = legacyAndroidVersionCode(binding.tag, entry.androidVersionCodeFormula);
    if (receipt.androidVersionCode !== String(expectedAndroid)) {
      fail(
        'tag-reuse-with-different-config',
        `superseded receipt의 androidVersionCode가 그 계약의 공식으로 재현되지 않는다: ` +
          `${receipt.androidVersionCode || 'missing'} != ${expectedAndroid}`,
      );
    }
    const expectedApple = deriveEncodedVersion(binding.tag);
    if (receipt.appleBuildNumber !== String(expectedApple)) {
      fail(
        'tag-reuse-with-different-config',
        `superseded receipt의 appleBuildNumber가 그 계약의 공식으로 재현되지 않는다: ` +
          `${receipt.appleBuildNumber || 'missing'} != ${expectedApple}`,
      );
    }
  } else if (receipt.androidVersionCodeSource !== binding.androidVersionCodeSource) {
    fail(
      'artifact-provenance-mismatch',
      `tag receipt androidVersionCodeSource가 다르다: ` +
        `${receipt.androidVersionCodeSource || 'missing'} != ${binding.androidVersionCodeSource}`,
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

// ---------------------------------------------------------------------------
// 저장소별 릴리스 번호 원장 (contracts/release-version-ledger.yaml)
// ---------------------------------------------------------------------------

const LEDGER_BASELINE_SOURCE_KINDS = Object.freeze([
  'no-prior-release',
  'tag-receipt',
  'google-play-bundles-list',
  'google-play-apks-list',
  'human-attestation',
]);
// 직렬화 키 순서를 고정한다. 같은 내용이 항상 같은 blob이어야 재시도에서 무엇이 바뀌었는지 판정할 수 있다.
const LEDGER_BASELINE_SOURCE_FIELDS = Object.freeze([
  'kind',
  'androidVersionCode',
  'tag',
  'tagObject',
  'sourceSha',
  'receiptAuthorityRevision',
  'packageName',
  'observedAt',
  'observedBy',
  'evidenceDigest',
  'evidenceUrl',
]);
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u;
const MARKETING_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function ledgerFail(message) {
  fail('ledger-malformed', message);
}

function requireLedgerObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    ledgerFail(`${label}는 객체여야 한다.`);
  }
  return value;
}

function requireLedgerNullableTag(value, label) {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || RELEASE_TAG_PATTERN.exec(value) === null) {
    ledgerFail(`${label}는 vX.Y.Z 또는 null이어야 한다: ${value ?? 'missing'}`);
  }
  return value;
}

function requireLedgerCount(value, label, { min, max }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    ledgerFail(`${label}는 ${min}..${max} 범위의 정수여야 한다: ${value ?? 'missing'}`);
  }
  return value;
}

/**
 * 원장 tip의 JSON을 읽는다. ajv를 쓰지 않는다 — 이 모듈은 npm 설치 없이 실행되는 org 정본이라
 * 표준 라이브러리만 쓴다. 형태가 조금이라도 다르면 번호를 추측하지 않고 fail-closed한다.
 */
export function parseLedger(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    ledgerFail('원장 JSON을 파싱하지 못했다.');
  }
  requireLedgerObject(parsed, '원장');
  if (parsed.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    ledgerFail(`원장 schemaVersion이 ${LEDGER_SCHEMA_VERSION}이 아니다: ${parsed.schemaVersion ?? 'missing'}`);
  }

  const release = requireLedgerObject(parsed.release, 'release');
  const lastTag = requireLedgerNullableTag(release.lastTag, 'release.lastTag');
  const lastSourceSha =
    release.lastSourceSha === null ? null : requireSha(release.lastSourceSha, 'release.lastSourceSha');
  const marketingVersion = release.marketingVersion;
  if (marketingVersion !== null && (typeof marketingVersion !== 'string' || MARKETING_VERSION_PATTERN.exec(marketingVersion) === null)) {
    ledgerFail(`release.marketingVersion는 X.Y.Z 또는 null이어야 한다: ${marketingVersion ?? 'missing'}`);
  }
  // 태그가 있으면 source SHA와 표시 버전도 함께 있어야 한다. 하나만 있는 원장은 신뢰할 수 없다.
  if ((lastTag === null) !== (lastSourceSha === null) || (lastTag === null) !== (marketingVersion === null)) {
    ledgerFail('release.lastTag, lastSourceSha, marketingVersion은 함께 있거나 함께 null이어야 한다.');
  }
  if (lastTag !== null && marketingVersion !== lastTag.slice(1)) {
    ledgerFail(`release.marketingVersion이 lastTag와 다르다: ${marketingVersion} != ${lastTag.slice(1)}`);
  }

  const android = requireLedgerObject(parsed.android, 'android');
  if (android.authority !== LEDGER_ANDROID_AUTHORITY) {
    ledgerFail(`android.authority는 ${LEDGER_ANDROID_AUTHORITY}여야 한다: ${android.authority ?? 'missing'}`);
  }
  const lastVersionCode = requireLedgerCount(android.lastVersionCode, 'android.lastVersionCode', {
    min: 0,
    max: VERSION_CODE_MAX,
  });
  if (typeof android.legacyFallbackSealed !== 'boolean') {
    ledgerFail(`android.legacyFallbackSealed는 boolean이어야 한다: ${android.legacyFallbackSealed ?? 'missing'}`);
  }

  const ios = requireLedgerObject(parsed.ios, 'ios');
  if (ios.authority !== LEDGER_IOS_AUTHORITY) {
    ledgerFail(`ios.authority는 ${LEDGER_IOS_AUTHORITY}여야 한다: ${ios.authority ?? 'missing'}`);
  }
  const lastObservedBuildNumber =
    ios.lastObservedBuildNumber === null
      ? null
      : requireLedgerCount(ios.lastObservedBuildNumber, 'ios.lastObservedBuildNumber', {
          min: 1,
          max: VERSION_CODE_MAX,
        });
  const lastObservedTag = requireLedgerNullableTag(ios.lastObservedTag, 'ios.lastObservedTag');
  if ((lastObservedBuildNumber === null) !== (lastObservedTag === null)) {
    ledgerFail('ios.lastObservedBuildNumber와 lastObservedTag는 함께 있거나 함께 null이어야 한다.');
  }

  const provenance = requireLedgerObject(parsed.provenance, 'provenance');
  if (typeof provenance.initializedAt !== 'string' || TIMESTAMP_PATTERN.exec(provenance.initializedAt) === null) {
    ledgerFail(`provenance.initializedAt는 ISO8601 UTC여야 한다: ${provenance.initializedAt ?? 'missing'}`);
  }
  if (provenance.initializedBy !== 'release-version-ledger-init-v1') {
    ledgerFail(`provenance.initializedBy가 다르다: ${provenance.initializedBy ?? 'missing'}`);
  }
  requireSha(provenance.initializedFromWorkflowSha, 'provenance.initializedFromWorkflowSha');
  requireDigest(provenance.authorityRevision, 'provenance.authorityRevision');

  const baseline = requireLedgerObject(provenance.baseline, 'provenance.baseline');
  requireLedgerCount(baseline.androidVersionCode, 'provenance.baseline.androidVersionCode', {
    min: 0,
    max: VERSION_CODE_MAX,
  });
  if (baseline.rule !== 'max-of-verified-sources') {
    ledgerFail(`provenance.baseline.rule이 다르다: ${baseline.rule ?? 'missing'}`);
  }
  if (!Array.isArray(baseline.sources) || baseline.sources.length === 0) {
    ledgerFail('provenance.baseline.sources는 최소 하나의 검증된 소스를 담아야 한다.');
  }
  for (const source of baseline.sources) {
    requireLedgerObject(source, 'provenance.baseline.sources[]');
    if (!LEDGER_BASELINE_SOURCE_KINDS.includes(source.kind)) {
      ledgerFail(`baseline source kind가 계약에 없다: ${source.kind ?? 'missing'}`);
    }
    requireLedgerCount(source.androidVersionCode, `baseline source(${source.kind}).androidVersionCode`, {
      min: 0,
      max: VERSION_CODE_MAX,
    });
    for (const key of Object.keys(source)) {
      if (!LEDGER_BASELINE_SOURCE_FIELDS.includes(key)) {
        ledgerFail(`baseline source에 알 수 없는 필드가 있다: ${key}`);
      }
    }
  }
  // baseline은 검증된 소스들의 최댓값이다. 다르면 누군가 손으로 고친 것이다.
  const maxSource = Math.max(...baseline.sources.map((source) => source.androidVersionCode));
  if (baseline.androidVersionCode !== maxSource) {
    ledgerFail(`provenance.baseline.androidVersionCode가 소스 최댓값과 다르다: ${baseline.androidVersionCode} != ${maxSource}`);
  }
  if (lastVersionCode < baseline.androidVersionCode) {
    fail(
      'ledger-non-monotonic',
      `android.lastVersionCode가 baseline보다 작다: ${lastVersionCode} < ${baseline.androidVersionCode}`,
    );
  }

  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    release: { lastTag, lastSourceSha, marketingVersion },
    android: {
      authority: LEDGER_ANDROID_AUTHORITY,
      lastVersionCode,
      legacyFallbackSealed: android.legacyFallbackSealed,
    },
    ios: { authority: LEDGER_IOS_AUTHORITY, lastObservedBuildNumber, lastObservedTag },
    provenance: {
      initializedAt: provenance.initializedAt,
      initializedBy: provenance.initializedBy,
      initializedFromWorkflowSha: provenance.initializedFromWorkflowSha,
      authorityRevision: provenance.authorityRevision,
      baseline: {
        androidVersionCode: baseline.androidVersionCode,
        rule: baseline.rule,
        sources: baseline.sources.map((source) => {
          const ordered = {};
          for (const field of LEDGER_BASELINE_SOURCE_FIELDS) {
            if (source[field] !== undefined) {
              ordered[field] = source[field];
            }
          }
          return ordered;
        }),
      },
    },
  };
}

/** 같은 원장 상태가 항상 같은 blob이 되도록 키 순서와 들여쓰기를 고정해 직렬화한다. */
export function renderLedger(ledger) {
  return `${JSON.stringify(parseLedger(JSON.stringify(ledger)), null, 2)}\n`;
}

/** 초기화 워크플로가 만드는 첫 원장. baseline은 반드시 검증된 소스에서 온다. */
export function createInitialLedger({
  baselineAndroidVersionCode,
  baselineSources,
  authorityRevision,
  initializedFromWorkflowSha,
  initializedAt,
  lastTag = null,
  lastSourceSha = null,
}) {
  const tag = lastTag === null ? null : parseReleaseTag(lastTag).tag;
  const ledger = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    release: {
      lastTag: tag,
      lastSourceSha: tag === null ? null : lastSourceSha,
      marketingVersion: tag === null ? null : tag.slice(1),
    },
    android: {
      authority: LEDGER_ANDROID_AUTHORITY,
      lastVersionCode: baselineAndroidVersionCode,
      // 아직 원장이 번호를 할당한 적이 없다. 첫 할당에서 true가 된다.
      legacyFallbackSealed: false,
    },
    ios: { authority: LEDGER_IOS_AUTHORITY, lastObservedBuildNumber: null, lastObservedTag: null },
    provenance: {
      initializedAt,
      initializedBy: 'release-version-ledger-init-v1',
      initializedFromWorkflowSha,
      authorityRevision,
      baseline: {
        androidVersionCode: baselineAndroidVersionCode,
        rule: 'max-of-verified-sources',
        sources: baselineSources,
      },
    },
  };
  return parseLedger(JSON.stringify(ledger));
}

/** 원장이 할당하는 다음 Android versionCode. 정확히 lastVersionCode + 1이다. */
export function allocateNextAndroidVersionCode(ledger) {
  const next = ledger.android.lastVersionCode + 1;
  if (!Number.isSafeInteger(next) || next > VERSION_CODE_MAX) {
    fail(
      'android-version-code-exhausted',
      `다음 Android versionCode가 Google Play 상한을 넘는다: ${next} > ${VERSION_CODE_MAX}`,
    );
  }
  return requireVersionCode(next, '할당된 Android versionCode');
}

/**
 * 태그 생성이 원장에 남기는 유일한 변화. release와 android 구획만 쓰고 ios와 provenance는
 * 건드리지 않는다(플랫폼 격리).
 */
export function applyAndroidAllocation({ ledger, tag, sourceSha, androidVersionCode }) {
  const version = deriveMarketingVersion(tag);
  requireSha(sourceSha, 'release source SHA');
  const code = requireVersionCode(androidVersionCode, '할당된 Android versionCode');
  if (code <= ledger.android.lastVersionCode) {
    fail(
      'ledger-non-monotonic',
      `할당 번호가 원장보다 크지 않다: ${code} <= ${ledger.android.lastVersionCode}`,
    );
  }
  return parseLedger(
    JSON.stringify({
      ...ledger,
      release: { lastTag: version.releaseTag, lastSourceSha: sourceSha, marketingVersion: version.versionName },
      android: { ...ledger.android, lastVersionCode: code, legacyFallbackSealed: true },
    }),
  );
}

/**
 * App Store Connect readback으로 확인한 build number만 기록한다. Android 번호를 소비하지 않고
 * release 구획도 건드리지 않는다. 추측한 값은 받지 않는다.
 */
export function applyIosObservation({ ledger, tag, buildNumber }) {
  const observedTag = parseReleaseTag(tag).tag;
  const number = typeof buildNumber === 'number' ? buildNumber : Number(String(buildNumber ?? '').trim());
  if (!Number.isSafeInteger(number) || number < 1 || number > VERSION_CODE_MAX) {
    fail(
      'ios-observation-unverified',
      `기록할 iOS build number는 1..${VERSION_CODE_MAX} 범위의 정수여야 한다: ${buildNumber ?? 'missing'}`,
    );
  }
  const next = parseLedger(
    JSON.stringify({
      ...ledger,
      ios: { ...ledger.ios, lastObservedBuildNumber: number, lastObservedTag: observedTag },
    }),
  );
  if (
    next.android.lastVersionCode !== ledger.android.lastVersionCode ||
    next.release.lastTag !== ledger.release.lastTag
  ) {
    fail('ledger-scope-violation', 'iOS 관측 기록이 release/android 구획을 바꿨다.');
  }
  return next;
}

/**
 * 배포 경로가 쓸 Android versionCode의 정본을 고른다. 절대 재계산하지 않는다.
 *  - receipt 있음 : receipt의 값이 정본이다.
 *  - receipt 없음 : 원장이 아직 번호를 할당한 적 없을 때만 legacy 공식으로 폴백한다.
 * 원장이 할당을 시작한 뒤에 만들어진 receipt 없는 태그는 구 공식으로 배포하면 번호가
 * 충돌하므로 여기서 막는다.
 */
export function resolveDeploymentAndroidVersionCode({ tag, receipt, ledger = null }) {
  if (receipt !== null && receipt !== undefined) {
    return {
      androidVersionCode: requireVersionCode(receipt.androidVersionCode, 'tag receipt androidVersionCode'),
      androidVersionCodeSource:
        receipt.androidVersionCodeSource.length > 0 ? receipt.androidVersionCodeSource : 'legacy-tag-formula',
    };
  }
  if (ledger !== null && ledger.android.legacyFallbackSealed === true) {
    fail(
      'legacy-derivation-not-applicable',
      `원장 할당이 시작된 저장소에서는 receipt 없는 태그를 배포할 수 없다: ${tag}`,
    );
  }
  return {
    androidVersionCode: deriveTagEncodedVersionCode(tag),
    androidVersionCodeSource: 'legacy-tag-formula',
  };
}

/** 원장이 할당한 번호가 원장 watermark를 넘어설 수 없다. 넘으면 원장이나 태그가 훼손된 것이다. */
export function assertLedgerReceiptConsistency({ ledger, receipt }) {
  if (ledger === null || receipt === null || receipt === undefined) {
    return;
  }
  if (receipt.androidVersionCodeSource !== 'github-ledger') {
    return;
  }
  const code = requireVersionCode(receipt.androidVersionCode, 'tag receipt androidVersionCode');
  if (code > ledger.android.lastVersionCode) {
    fail(
      'ledger-receipt-mismatch',
      `tag receipt의 androidVersionCode가 원장 최신값보다 크다: ${code} > ${ledger.android.lastVersionCode}`,
    );
  }
}

export const RELEASE_MEMO_MAX_LENGTH = 120;

function truncateMemoNote(note, maxLength) {
  if (maxLength <= 0) {
    return '';
  }
  if (note.length <= maxLength) {
    return note;
  }
  if (maxLength === 1) {
    return '…';
  }

  let truncated = '';
  for (const character of note) {
    if ((truncated + character).length > maxLength - 1) {
      break;
    }
    truncated += character;
  }
  return `${truncated}…`;
}

/**
 * AppsInToss 배포 memo는 tag·source SHA·업로드 대상 artifact의 sha256을 항상 보존한다.
 * .ait 컨테이너는 내부 version 필드를 갖지 않으므로, provider 기록에서 "이 태그의 이 파일"을
 * 가리키는 유일한 식별자가 memo다. digest를 넣어 같은 태그로 다른 파일을 올리면 어긋나게 한다.
 * AppsInToss의 120자 제한 안에서 이 식별자를 먼저 보존하고 선택 운영 메모만 줄임표로 잘라낸다.
 */
export function canonicalReleaseMemo(binding, { artifactDigest, note = '' } = {}) {
  requireArtifactDigest(artifactDigest, '.ait artifact digest');
  const trimmed = typeof note === 'string' ? note.trim().replace(/\s+/gu, ' ') : '';
  const head = `${binding.tag} src:${binding.sourceSha.slice(0, 12)} sha256:${artifactDigest}`;
  if (head.length > RELEASE_MEMO_MAX_LENGTH) {
    fail(
      'artifact-digest-mismatch',
      `canonical release memo 식별자가 ${RELEASE_MEMO_MAX_LENGTH}자를 넘는다: ${head.length}자`,
    );
  }
  if (trimmed.length === 0) {
    return head;
  }

  const separator = ' · ';
  const fittedNote = truncateMemoNote(trimmed, RELEASE_MEMO_MAX_LENGTH - head.length - separator.length);
  return fittedNote.length > 0 ? `${head}${separator}${fittedNote}` : head;
}

/**
 * kind별로 digest를 어디서 뜨는지 고정한다. AAB와 .ait은 업로드 대상 파일 자체를, xcarchive는
 * 디렉터리 번들이라 파일 하나로 잡을 수 없으므로 readback한 archive Info.plist를 쓴다.
 */
export const ARTIFACT_DIGEST_SOURCES = Object.freeze({
  'android-app-bundle': 'artifact-file',
  'xcode-archive': 'archive-info-plist',
  ait: 'artifact-file',
});

export function artifactDigestSource(kind) {
  const source = ARTIFACT_DIGEST_SOURCES[kind];
  if (source === undefined) {
    fail('artifact-provenance-mismatch', `지원하지 않는 artifact kind: ${kind}`);
  }
  return source;
}

const ARTIFACT_RECEIPT_FIELDS = Object.freeze([
  ['authority', (context) => context.binding.authority],
  ['authority-revision', (context) => context.binding.authorityRevision],
  ['tag', (context) => context.binding.tag],
  ['source-sha', (context) => context.binding.sourceSha],
  ['config-revision', (context) => context.binding.configRevision],
  ['artifact-kind', (context) => context.kind],
  ['artifact-digest-source', (context) => artifactDigestSource(context.kind)],
  ['artifact-sha256', (context) => context.artifactDigest],
  ['version-name', (context) => context.binding.versionName],
  ['android-version-code', (context) => String(context.binding.androidVersionCode)],
  ['android-version-code-source', (context) => context.binding.androidVersionCodeSource],
  ['apple-build-number', (context) => String(context.binding.appleBuildNumber)],
  ['upload-memo', (context) => context.memo],
]);

/**
 * 업로드 직전 artifact 하나를 binding에 묶는 receipt. provider에 남기는 memo와 같은 digest를
 * 담으므로, 검증한 파일과 실제로 올린 파일이 다르면 receipt 대조에서 드러난다.
 */
export function renderArtifactReceipt({ binding, kind, artifactDigest, memo = '' }) {
  artifactDigestSource(kind);
  requireArtifactDigest(artifactDigest, 'artifact digest');
  const context = { binding, kind, artifactDigest, memo };
  return [
    ARTIFACT_RECEIPT_MARKER,
    ...ARTIFACT_RECEIPT_FIELDS.filter(([field]) => field !== 'upload-memo' || memo.length > 0).map(
      ([field, read]) => `${field}: ${read(context)}`,
    ),
  ].join('\n');
}

/** artifact receipt를 다시 읽는다. marker가 없으면 null. */
export function parseArtifactReceipt(text) {
  const body = typeof text === 'string' ? text : '';
  if (!body.includes(ARTIFACT_RECEIPT_MARKER)) {
    return null;
  }
  const fields = new Map();
  for (const line of body.split('\n')) {
    const match = /^([a-z0-9-]+):[ \t]*(.*)$/u.exec(line.trim());
    if (match !== null && match[1] !== ARTIFACT_RECEIPT_MARKER.split(':')[0]) {
      fields.set(match[1], match[2].trim());
    }
  }
  return Object.fromEntries(fields);
}

/** receipt가 현재 binding·kind·digest와 exact match하는지 확인한다. */
export function assertArtifactReceipt({ binding, kind, artifactDigest, memo = '', receipt }) {
  if (receipt === null || receipt === undefined) {
    fail('artifact-digest-mismatch', 'artifact receipt가 없다.');
  }
  const expected = parseArtifactReceipt(renderArtifactReceipt({ binding, kind, artifactDigest, memo }));
  for (const [field, value] of Object.entries(expected)) {
    if (receipt[field] !== value) {
      fail(
        'artifact-digest-mismatch',
        `artifact receipt ${field}이 현재 실행값과 다르다: ${receipt[field] ?? 'missing'} != ${value}`,
      );
    }
  }
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
 * package, android:versionName, android:versionCode를 읽는다. package name은 중앙
 * uploader가 repo-local config나 script를 읽지 않고 exact artifact identity를 사용하게 한다.
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
    const namespace = protobufString(attribute, 1);
    const name = protobufString(attribute, 2);
    const isPackageName = namespace === '' && name === 'package';
    const isVersion =
      namespace === ANDROID_RESOURCE_NAMESPACE &&
      (name === 'versionName' || name === 'versionCode');
    if (!isPackageName && !isVersion) {
      continue;
    }
    const key = isPackageName ? 'packageName' : name;
    if (found.has(key)) {
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
    found.set(key, value);
  }

  const packageName = found.get('packageName');
  const versionName = found.get('versionName');
  const rawCode = found.get('versionCode');
  if (
    packageName === undefined ||
    !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(packageName)
  ) {
    fail(
      'artifact-provenance-mismatch',
      `AAB manifest package name을 읽지 못했다: ${packageName ?? 'missing'}`,
    );
  }
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

  return { packageName, versionName, versionCode };
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

// AIT v1 bundle 헤더에서 의미가 확정된 필드. 나머지 필드에 version 문자열이 들어오면
// 컨테이너가 자체 version 기록을 갖게 된 것이므로 tag 단일 authority 가정이 깨진다.
const AIT_KNOWN_BUNDLE_FIELDS = Object.freeze([2, 3]);
const SEMVER_SHAPED = /^v?\d+\.\d+\.\d+/u;
// .ait zip payload의 루트 metadata 후보. 존재하면 version 기록을 담을 수 있으므로 fail-closed한다.
const ZIP_METADATA_ENTRY = /^(?:manifest|metadata|version|app)(?:\.(?:json|txt|ya?ml))?$/iu;
const ZIP_CENTRAL_HEADER = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const ZIP_END_OF_CENTRAL_DIRECTORY = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
// AIT v1 framing: magic(8) + formatVersion(4) + protobuf length(8) + protobuf
//                 + zip payload length(8) + zip payload + reserved zero trailer(8)
const AIT_HEADER_LENGTH = 20;
const AIT_ZIP_LENGTH_FIELD = 8;
const AIT_TRAILER_LENGTH = 8;

function scanAitBundleVersionFields(fields) {
  const found = [];
  for (const [fieldNumber, values] of fields) {
    if (AIT_KNOWN_BUNDLE_FIELDS.includes(fieldNumber)) {
      continue;
    }
    for (const value of values) {
      if (Buffer.isBuffer(value) && SEMVER_SHAPED.test(value.toString('utf8').trim())) {
        found.push(`bundle.field${fieldNumber}`);
        break;
      }
    }
  }
  return found;
}

/**
 * zip payload의 entry 이름을 central directory에서 읽는다. local header만 훑으면 data
 * descriptor를 쓰는 entry에서 크기가 0이라 순회가 조용히 끊긴다. 그 경우 "version 기록 없음"과
 * 구분되지 않으므로, central directory를 읽지 못하면 빈 목록 대신 fail-closed한다.
 */
export function readZipEntryNames(payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? []);
  if (bytes.length < 22) {
    fail('artifact-provenance-mismatch', '.ait zip payload가 end-of-central-directory보다 짧다.');
  }
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (bytes.subarray(offset, offset + 4).equals(ZIP_END_OF_CENTRAL_DIRECTORY)) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) {
    fail('artifact-provenance-mismatch', '.ait zip payload에서 end-of-central-directory를 찾지 못했다.');
  }

  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const directorySize = bytes.readUInt32LE(endOffset + 12);
  const directoryOffset = bytes.readUInt32LE(endOffset + 16);
  if (directoryOffset + directorySize > bytes.length) {
    fail('artifact-provenance-mismatch', '.ait zip central directory가 payload 밖을 가리킨다.');
  }

  const names = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || !bytes.subarray(offset, offset + 4).equals(ZIP_CENTRAL_HEADER)) {
      fail('artifact-provenance-mismatch', `.ait zip central directory entry ${index}를 읽지 못했다.`);
    }
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) {
      fail('artifact-provenance-mismatch', `.ait zip entry ${index} 이름이 잘렸다.`);
    }
    names.push(bytes.subarray(nameStart, nameEnd).toString('utf8'));
    offset = nameEnd + extraLength + commentLength;
  }
  return names;
}

function scanZipVersionEntries(payload) {
  return readZipEntryNames(payload)
    .filter((name) => ZIP_METADATA_ENTRY.test(name))
    .map((name) => `zip:${name}`);
}

/**
 * .ait 컨테이너를 읽는다. AIT v1은 magic + formatVersion + protobuf 길이 + protobuf +
 * zip payload 길이 + zip payload + 8-byte zero trailer로 framing되고, legacy 번들은 zip 자체다. 어느 형식도 내부
 * version 필드를 갖지 않으므로 version authority는 tag다. 이 가정이 깨진 컨테이너를 조용히
 * 통과시키지 않도록 framing을 exact length로 검증하고 versionFields로 관측 결과를 돌려준다.
 */
export function readAitContainer(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (bytes.length < 4) {
    fail('artifact-provenance-mismatch', '.ait 아티팩트가 비어 있다.');
  }

  if (bytes.subarray(0, AIT_MAGIC.length).equals(AIT_MAGIC)) {
    if (bytes.length < AIT_HEADER_LENGTH) {
      fail('artifact-provenance-mismatch', 'AIT 헤더가 잘렸다.');
    }
    const formatVersion = bytes.readUInt32BE(8);
    if (formatVersion !== 1) {
      fail('artifact-provenance-mismatch', `지원하지 않는 AIT formatVersion이다: ${formatVersion}`);
    }
    const bundleLength = Number(bytes.readBigUInt64BE(12));
    const bundleEnd = AIT_HEADER_LENGTH + bundleLength;
    if (!Number.isSafeInteger(bundleLength) || bundleEnd > bytes.length) {
      fail('artifact-provenance-mismatch', `AIT bundle 길이가 파일 크기를 넘는다: ${bundleLength}`);
    }
    const fields = readProtobufFields(bytes.subarray(AIT_HEADER_LENGTH, bundleEnd));
    const deploymentId = protobufString(fields, 2);
    const appName = protobufString(fields, 3);
    if (appName.length === 0) {
      fail('artifact-provenance-mismatch', 'AIT bundle에서 appName을 읽지 못했다.');
    }

    // protobuf 다음은 zip payload 길이(8바이트)다. 이 값을 건너뛰고 zip을 찾으면 payload 전체를
    // 스캔하지 못한 채 "version 기록 없음"으로 통과해 버린다.
    if (bundleEnd + AIT_ZIP_LENGTH_FIELD > bytes.length) {
      fail('artifact-provenance-mismatch', 'AIT zip payload 길이 필드가 잘렸다.');
    }
    const zipLength = Number(bytes.readBigUInt64BE(bundleEnd));
    const zipStart = bundleEnd + AIT_ZIP_LENGTH_FIELD;
    const zipEnd = zipStart + zipLength;
    const trailerEnd = zipEnd + AIT_TRAILER_LENGTH;
    if (!Number.isSafeInteger(zipLength) || trailerEnd !== bytes.length) {
      fail(
        'artifact-provenance-mismatch',
        `AIT zip payload와 trailer 길이가 파일 크기와 다르다: ` +
          `${zipStart}+${zipLength}+${AIT_TRAILER_LENGTH} != ${bytes.length}`,
      );
    }
    const trailer = bytes.subarray(zipEnd, trailerEnd);
    if (!trailer.equals(Buffer.alloc(AIT_TRAILER_LENGTH))) {
      fail('artifact-provenance-mismatch', 'AIT reserved trailer가 8-byte zero가 아니다.');
    }
    const zipPayload = bytes.subarray(zipStart, zipEnd);
    if (!zipPayload.subarray(0, ZIP_LOCAL_HEADER.length).equals(ZIP_LOCAL_HEADER)) {
      fail('artifact-provenance-mismatch', 'AIT zip payload가 PK local header로 시작하지 않는다.');
    }

    return {
      format: 'ait',
      formatVersion,
      deploymentId,
      appName,
      zipLength,
      trailerLength: AIT_TRAILER_LENGTH,
      versionFields: Object.freeze([
        ...scanAitBundleVersionFields(fields),
        ...scanZipVersionEntries(zipPayload),
      ]),
    };
  }

  if (bytes.subarray(0, ZIP_LOCAL_HEADER.length).equals(ZIP_LOCAL_HEADER)) {
    return {
      format: 'zip',
      formatVersion: 0,
      deploymentId: '',
      appName: '',
      zipLength: bytes.length,
      versionFields: Object.freeze(scanZipVersionEntries(bytes)),
    };
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

export const GODOT_PRESET_SECTION = /^preset\.(0|[1-9]\d*)$/u;

/**
 * export_presets.cfg에서 주입 대상 preset을 고른다. 호출자는 preset 이름(`name="Android"`)이나
 * 인덱스(`preset.0`)를 반드시 명시한다. 같은 platform preset이 여럿일 때 첫 번째를 임의로
 * 고르면 배포 대상이 아닌 preset을 덮어쓸 수 있으므로, 선택자 없는 호출은 fail-closed한다.
 */
export function selectGodotExportPreset(text, { platform, preset }) {
  if (typeof preset !== 'string' || preset.trim().length === 0) {
    fail(
      'godot-preset-selector-required',
      'export preset 선택자(preset 이름 또는 preset.N 인덱스)를 명시해야 한다.',
    );
  }
  const selector = preset.trim();
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

  const matches = [];
  for (const [name, section] of sections) {
    if (!GODOT_PRESET_SECTION.test(name)) {
      continue;
    }
    const body = lines.slice(section.start, section.end);
    const presetName = body
      .map((line) => /^name="(.*)"\s*$/u.exec(line.trim()))
      .find((match) => match !== null)?.[1];
    if (name !== selector && presetName !== selector) {
      continue;
    }
    if (!body.some((line) => line.trim() === `platform="${platform}"`)) {
      fail(
        'godot-preset-selector-mismatch',
        `preset ${selector}의 platform이 ${platform}이 아니다.`,
      );
    }
    matches.push({ section: name, presetName: presetName ?? '', options: sections.get(`${name}.options`) });
  }

  if (matches.length === 0) {
    fail('godot-preset-selector-mismatch', `export_presets.cfg에 preset ${selector}이 없다.`);
  }
  if (matches.length > 1) {
    // 같은 이름 preset이 둘 이상이면 어느 쪽을 export하는지 파일만으로 결정할 수 없다.
    fail(
      'godot-preset-selector-ambiguous',
      `preset 선택자 ${selector}가 ${matches.length}개 preset과 일치한다.`,
    );
  }
  const [selected] = matches;
  if (selected.options === undefined) {
    fail('godot-preset-selector-mismatch', `export_presets.cfg에 ${selected.section}.options 섹션이 없다.`);
  }
  return { lines, ...selected };
}

/**
 * Godot export preset의 version 값을 tag 파생값으로 덮어쓴다. export_presets.cfg는 authority가
 * 아니라 주입 대상이며, 실제 반영 여부는 artifact readback으로 다시 확인한다.
 * 명시된 preset 하나의 options 섹션만 바꾸고 다른 preset은 그대로 둔다.
 */
export function applyGodotExportVersion(text, { platform, binding, preset }) {
  const keyFactory = GODOT_PLATFORM_VERSION_KEYS[platform];
  if (keyFactory === undefined) {
    fail('artifact-provenance-mismatch', `지원하지 않는 Godot export platform: ${platform}`);
  }

  const { lines, section, options } = selectGodotExportPreset(text, { platform, preset });
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
      fail('artifact-provenance-mismatch', `export_presets.cfg ${section}.options에 ${key}가 없다.`);
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

  requireArtifactDigest(observed.digest, '.ait artifact digest');
  // .ait 컨테이너가 자체 version 기록을 갖게 되면 tag 단일 authority 전제가 깨진다.
  // 새 형식을 조용히 통과시키지 않고 계약을 갱신하도록 fail-closed한다.
  const versionFields = Array.isArray(observed.versionFields) ? observed.versionFields : [];
  if (versionFields.length > 0) {
    fail(
      'ait-internal-version-field-present',
      `.ait 컨테이너에 내부 version 기록이 있다. 계약 갱신 없이 배포할 수 없다: ${versionFields.join(', ')}`,
    );
  }
  const expectedMemo = canonicalReleaseMemo(binding, {
    artifactDigest: observed.digest,
    note: observed.note ?? '',
  });
  if (observed.memo !== expectedMemo) {
    fail(
      'artifact-digest-mismatch',
      `AppsInToss memo가 tag·digest 파생 canonical memo와 다르다: ${observed.memo} != ${expectedMemo}`,
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
    `android_version_code_source=${binding.androidVersionCodeSource}`,
    `apple_marketing_version=${binding.appleMarketingVersion}`,
    `apple_build_number=${binding.appleBuildNumber}`,
    `release_name=${binding.releaseName}`,
    `binding_digest=${bindingDigest(binding)}`,
  ];
}
