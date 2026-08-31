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
// 기존 Fleet의 Play versionCode 최고 관측값(로컬 build-only 포함 167,704,300)을 한 번에
// 넘어서는 조직 공통 epoch다. 앱별 offset/config가 아니라 tag만으로 모든 repo에서 같은 값을
// 파생하며, Play 상한 아래에서 major 0..1099를 온전히 쓸 수 있다.
export const ANDROID_VERSION_CODE_EPOCH = 1_000_000_000;
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

/**
 * v prefix를 제거한 값이 display/marketing version이다. Apple build number는 SemVer를
 * base-1000 정수로 인코딩하고, Android versionCode는 레거시 Fleet floor를 넘기기 위한 조직
 * 공통 epoch를 더한다. 둘 다 repo 설정 없이 tag 하나에서만 결정된다.
 */
export function deriveReleaseVersion(tag) {
  const { major, minor, patch } = parseReleaseTag(tag);
  const buildNumber = major * 1_000_000 + minor * VERSION_SEGMENT_BASE + patch;
  if (buildNumber < VERSION_CODE_MIN) {
    // v0.0.0은 Apple build number 0을 만든다. 마켓 release tag로 쓰지 않는다.
    fail(
      'derived-version-code-out-of-range',
      `파생 build number가 마켓 최소값 ${VERSION_CODE_MIN} 미만이다: ${tag} -> ${buildNumber}`,
    );
  }
  const androidVersionCode = ANDROID_VERSION_CODE_EPOCH + buildNumber;
  if (!Number.isSafeInteger(androidVersionCode) || androidVersionCode > VERSION_CODE_MAX) {
    fail(
      'tag-pattern-mismatch',
      `파생 Android versionCode가 Google Play 최대값을 넘는다: ${androidVersionCode}`,
    );
  }

  const versionName = `${major}.${minor}.${patch}`;
  return {
    releaseTag: tag,
    versionName,
    displayVersion: versionName,
    androidVersionCode,
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
    if (
      parsed.major > VERSION_MAJOR_MAX ||
      parsed.minor > VERSION_SEGMENT_BASE - 1 ||
      parsed.patch > VERSION_SEGMENT_BASE - 1
    ) {
      continue;
    }
    const buildNumber = parsed.major * 1_000_000 + parsed.minor * VERSION_SEGMENT_BASE + parsed.patch;
    const androidVersionCode = ANDROID_VERSION_CODE_EPOCH + buildNumber;
    if (
      !Number.isSafeInteger(buildNumber) ||
      !Number.isSafeInteger(androidVersionCode) ||
      androidVersionCode > VERSION_CODE_MAX ||
      buildNumber < VERSION_CODE_MIN
    ) {
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
 * WorkflowBundle v5 정본 경로는 `refs/tags/vX.Y.Z` push/dispatch 하나에서만 마켓 artifact를
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
  'latest-stable-dispatch',
]);

/**
 * 실행 이벤트에 맞는 release 태그 하나를 고른다.
 *
 * `refs/tags/vX.Y.Z` 이벤트는 그 태그가 곧 정본이다. 저장소에 더 최신 태그가 있더라도
 * latest fallback으로 넘어가면 v1.2.0 태그 push가 v1.3.0을 빌드할 수 있으므로 금지한다.
 * 태그가 없는 실행에서 최신 태그를 고르는 것은 운영자가 명시적으로 시작한 workflow_dispatch
 * 에서만 허용한다.
 */
export function selectReleaseTagForEvent({
  eventName = '',
  eventRef = '',
  requestedTag = '',
  tagList = '',
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
  return { tag: selectLatestStableTag(tagList), source: 'latest-stable-dispatch' };
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

export const RELEASE_MEMO_MAX_LENGTH = 1000;

/**
 * AppsInToss 배포 memo는 tag 파생값과 업로드 대상 artifact의 sha256만으로 만든다.
 * .ait 컨테이너는 내부 version 필드를 갖지 않으므로, provider 기록에서 "이 태그의 이 파일"을
 * 가리키는 유일한 식별자가 memo다. digest를 넣어 같은 태그로 다른 파일을 올리면 어긋나게 한다.
 */
export function canonicalReleaseMemo(binding, { artifactDigest, note = '' } = {}) {
  requireArtifactDigest(artifactDigest, '.ait artifact digest');
  const trimmed = typeof note === 'string' ? note.trim().replace(/\s+/gu, ' ') : '';
  const head =
    `${binding.tag} ${binding.versionName} (${binding.androidVersionCode}) ` +
    `src:${binding.sourceSha.slice(0, 12)} sha256:${artifactDigest}`;
  const memo = trimmed.length > 0 ? `${head} · ${trimmed}` : head;
  if (memo.length > RELEASE_MEMO_MAX_LENGTH) {
    // 잘라내면 digest가 사라져 식별자가 무너진다. 운영 메모를 줄이도록 fail-closed한다.
    fail(
      'artifact-digest-mismatch',
      `release memo가 ${RELEASE_MEMO_MAX_LENGTH}자를 넘는다. 운영 메모를 줄여야 한다: ${memo.length}자`,
    );
  }
  return memo;
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
    `apple_marketing_version=${binding.appleMarketingVersion}`,
    `apple_build_number=${binding.appleBuildNumber}`,
    `release_name=${binding.releaseName}`,
    `binding_digest=${bindingDigest(binding)}`,
  ];
}
