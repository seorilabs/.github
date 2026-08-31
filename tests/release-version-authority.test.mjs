// GitHub 릴리즈 태그를 모든 지원 마켓 artifact의 유일한 version source of truth로 고정하는
// 계약을 검증한다. 라이브러리 규칙, CLI 계약, fixture readback, 워크플로우 배선을 함께 본다.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import {
  AUTHORITY_ID,
  RELEASE_TAG_SOURCES,
  ReleaseAuthorityError,
  applyGodotExportVersion,
  assertArtifactReceipt,
  assertArtifactVersion,
  assertSourceBinding,
  assertTagReceipt,
  canonicalReleaseMemo,
  computeAuthorityRevision,
  computeConfigRevision,
  createReleaseBinding,
  deriveReleaseVersion,
  githubOutputLines,
  parseAabManifest,
  parseArtifactReceipt,
  parseInfoPlistJson,
  parseReleaseBinding,
  parseReleaseTagRef,
  parseTagReceipt,
  readAitContainer,
  readZipEntryNames,
  renderArtifactReceipt,
  renderTagReceipt,
  selectLatestStableTag,
  selectReleaseTagForEvent,
} from '../scripts/release/tag-version-authority.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = resolve(REPOSITORY_ROOT, 'fixtures/release-version-authority');
const RESOLVE_CLI = resolve(REPOSITORY_ROOT, 'scripts/release/resolve-release-version.mjs');
const VERIFY_CLI = resolve(REPOSITORY_ROOT, 'scripts/release/verify-release-artifact.mjs');
const PLAY_UPLOAD_CLI = resolve(REPOSITORY_ROOT, 'scripts/release/upload-google-play-aab.py');
const GODOT_CLI = resolve(REPOSITORY_ROOT, 'scripts/release/apply-godot-export-version.mjs');
const AUTHORITY_CONTRACT = resolve(REPOSITORY_ROOT, 'contracts/release-version-authority.yaml');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const WORKFLOW_SHA = 'c'.repeat(40);

/** 마켓 artifact를 만드는 워크플로우: 태그가 유일한 authority여야 하는 경로 전체. */
const RELEASE_WORKFLOWS = Object.freeze([
  'rn-deploy-google-play.yml',
  'rn-deploy-app-store.yml',
  'rn-deploy-ait.yml',
  'rn-build-android.yml',
  'godot-deploy-google-play.yml',
  'godot-deploy-app-store.yml',
  'godot-deploy-ait.yml',
]);

function workflowText(name) {
  return readFileSync(resolve(REPOSITORY_ROOT, '.github/workflows', name), 'utf8');
}

/** 워크플로우 step의 run 블록만 dedent해 추출한다. */
function extractRunBlock(text, stepName) {
  const lines = text.split('\n');
  const step = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  assert.ok(step >= 0, `${stepName} step을 찾지 못했다`);
  const run = lines.findIndex((line, index) => index > step && line.trim() === 'run: |');
  assert.ok(run > step, `${stepName}의 run 블록을 찾지 못했다`);
  const indent = lines[run].length - lines[run].trimStart().length + 2;

  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim().length === 0) {
      body.push('');
      continue;
    }
    if (line.length - line.trimStart().length < indent) {
      break;
    }
    body.push(line.slice(indent));
  }
  return body.join('\n').trimEnd();
}

function binding({ tag = 'v1.2.3', sourceSha = SHA_A, workflow = 'rn-deploy-google-play.yml' } = {}) {
  const authorityRevision = computeAuthorityRevision(readFileSync(AUTHORITY_CONTRACT, 'utf8'));
  return createReleaseBinding({
    tag,
    sourceSha,
    authorityRevision,
    configRevision: computeConfigRevision({
      calledWorkflowRepository: 'seorilabs/.github',
      calledWorkflowRef: `seorilabs/.github/.github/workflows/${workflow}@${WORKFLOW_SHA}`,
      calledWorkflowSha: WORKFLOW_SHA,
      authorityRevision,
    }),
  });
}

function runNode(cliPath, args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function authorityEnv(workflow = 'rn-deploy-google-play.yml') {
  return {
    JOB_WORKFLOW_REPOSITORY: 'seorilabs/.github',
    JOB_WORKFLOW_SHA: WORKFLOW_SHA,
    JOB_WORKFLOW_REF: `seorilabs/.github/.github/workflows/${workflow}@${WORKFLOW_SHA}`,
    RELEASE_EVENT_NAME: 'workflow_dispatch',
    RELEASE_EVENT_REF: 'refs/heads/main',
  };
}

test('태그에서 display version과 마켓별 deterministic build number를 파생한다', () => {
  const cases = [
    ['v0.1.0', '0.1.0', 1_000_001_000, 1000],
    ['v1.0.0', '1.0.0', 1_001_000_000, 1_000_000],
    ['v1.2.3', '1.2.3', 1_001_002_003, 1_002_003],
    ['v2.0.5', '2.0.5', 1_002_000_005, 2_000_005],
    ['v0.1.2', '0.1.2', 1_000_001_002, 1002],
    ['v1.999.999', '1.999.999', 1_001_999_999, 1_999_999],
  ];

  for (const [tag, versionName, androidVersionCode, appleBuildNumber] of cases) {
    const version = deriveReleaseVersion(tag);
    assert.equal(version.versionName, versionName, tag);
    assert.equal(version.displayVersion, versionName, tag);
    assert.equal(version.appleMarketingVersion, versionName, tag);
    assert.equal(version.releaseName, versionName, tag);
    assert.equal(version.androidVersionCode, androidVersionCode, tag);
    assert.equal(version.appleBuildNumber, appleBuildNumber, tag);
  }
});

test('exact stable SemVer가 아니거나 세그먼트 범위를 넘는 태그는 거부한다', () => {
  for (const tag of [
    '1.2.3',
    'v1.2',
    'v1.2.3.4',
    'v01.2.3',
    'v1.2.3-rc.1',
    'v1.2.3+build.7',
    'v1.1000.0',
    'v1.0.1000',
    'v1100.0.0',
    'v2200.0.0',
    '',
    undefined,
  ]) {
    assert.throws(
      () => deriveReleaseVersion(tag),
      (error) => error instanceof ReleaseAuthorityError && error.code === 'tag-pattern-mismatch',
      String(tag),
    );
  }
});

test('빈 입력은 prerelease와 파생 불가 태그를 제외한 최신 stable 태그를 고른다', () => {
  const tags = [
    'v1.2.9',
    'v1.2.10',
    'v9.0.0-rc.1',
    'v01.2.3',
    'v10x.0y.0z',
    'v9223372036854775808.0.0',
    'v1.1000.0',
    'main',
    '',
  ];
  assert.equal(selectLatestStableTag(tags), 'v1.2.10');
  assert.equal(selectLatestStableTag(tags.join('\n')), 'v1.2.10');
  assert.throws(
    () => selectLatestStableTag(['main', 'v9.0.0-rc.1']),
    (error) => error.code === 'tag-pattern-mismatch',
  );
});

test('config revision은 org 정본 workflow full SHA와 계약 revision에만 의존한다', () => {
  const contract = readFileSync(AUTHORITY_CONTRACT, 'utf8');
  const base = {
    calledWorkflowRepository: 'seorilabs/.github',
    calledWorkflowRef: `seorilabs/.github/.github/workflows/rn-deploy-ait.yml@${WORKFLOW_SHA}`,
    calledWorkflowSha: WORKFLOW_SHA,
    authorityRevision: computeAuthorityRevision(contract),
  };
  const revision = computeConfigRevision(base);
  assert.match(revision, /^[0-9a-f]{64}$/u);
  assert.equal(computeConfigRevision(base), revision);

  const otherSha = 'd'.repeat(40);
  assert.notEqual(
    computeConfigRevision({
      ...base,
      calledWorkflowSha: otherSha,
      calledWorkflowRef: `seorilabs/.github/.github/workflows/rn-deploy-ait.yml@${otherSha}`,
    }),
    revision,
  );
  assert.notEqual(
    computeConfigRevision({ ...base, authorityRevision: computeAuthorityRevision(`${contract}\n# drift\n`) }),
    revision,
  );

  for (const invalid of [
    { ...base, calledWorkflowRepository: 'attacker/.github' },
    { ...base, calledWorkflowSha: 'main' },
    { ...base, calledWorkflowRef: 'seorilabs/.github/.github/workflows/rn-deploy-ait.yml@main' },
    { ...base, calledWorkflowRef: `other/repo/.github/workflows/x.yml@${WORKFLOW_SHA}` },
    { ...base, authorityRevision: '' },
    { ...base, authorityRevision: 'not-a-digest' },
  ]) {
    assert.throws(
      () => computeConfigRevision(invalid),
      (error) => error.code === 'config-revision-mismatch',
      JSON.stringify(invalid.calledWorkflowRef),
    );
  }
});

test('release binding은 태그 파생값과 다르게 위조할 수 없다', () => {
  const original = binding();
  const roundTrip = parseReleaseBinding(JSON.stringify(original));
  assert.deepEqual(roundTrip, original);

  for (const tampered of [
    { ...original, versionName: '9.9.9' },
    { ...original, androidVersionCode: 7 },
    { ...original, appleBuildNumber: 7 },
    { ...original, appleMarketingVersion: '9.9.9' },
    { ...original, releaseName: 'hand-written' },
  ]) {
    assert.throws(
      () => parseReleaseBinding(JSON.stringify(tampered)),
      (error) => error.code === 'artifact-provenance-mismatch',
    );
  }

  assert.throws(
    () => parseReleaseBinding(JSON.stringify({ ...original, authority: 'legacy-resolver' })),
    (error) => error.code === 'config-revision-mismatch',
  );
  for (const authorityRevision of ['', 'not-a-digest', '0'.repeat(63)]) {
    assert.throws(
      () => parseReleaseBinding(JSON.stringify({ ...original, authorityRevision })),
      (error) => error.code === 'config-revision-mismatch',
      authorityRevision || 'missing',
    );
  }
  assert.throws(
    () => parseReleaseBinding('not json'),
    (error) => error.code === 'artifact-provenance-mismatch',
  );
});

test('checkout HEAD가 exact tag commit과 다르면 fail-closed한다', () => {
  const current = binding();
  assert.doesNotThrow(() =>
    assertSourceBinding({ binding: current, headSha: SHA_A, localTagSha: SHA_A }),
  );

  for (const observed of [
    { headSha: SHA_B, localTagSha: SHA_A },
    { headSha: SHA_A, localTagSha: SHA_B },
    { headSha: 'HEAD', localTagSha: SHA_A },
    { headSha: '', localTagSha: SHA_A },
  ]) {
    assert.throws(
      () => assertSourceBinding({ binding: current, ...observed }),
      (error) => error.code === 'source-sha-mismatch',
      JSON.stringify(observed),
    );
  }
});

test('authority 계약 revision은 워크플로우와 무관하게 같고 config revision에 반영된다', () => {
  const contract = readFileSync(AUTHORITY_CONTRACT, 'utf8');
  const authorityRevision = computeAuthorityRevision(contract);
  assert.match(authorityRevision, /^[0-9a-f]{64}$/u);
  assert.equal(computeAuthorityRevision(contract), authorityRevision);
  assert.notEqual(computeAuthorityRevision(`${contract}\n# drift\n`), authorityRevision);
  assert.throws(
    () => computeAuthorityRevision(''),
    (error) => error.code === 'config-revision-mismatch',
  );

  // 같은 계약이면 배포 워크플로우가 달라도 tag receipt의 authority revision은 같다.
  const deployBinding = binding({ workflow: 'rn-deploy-google-play.yml' });
  const tagBinding = binding({ workflow: 'release-tag.yml' });
  assert.equal(deployBinding.authorityRevision, authorityRevision);
  assert.equal(tagBinding.authorityRevision, authorityRevision);
  assert.notEqual(deployBinding.configRevision, tagBinding.configRevision);
  assert.doesNotThrow(() => assertTagReceipt(deployBinding, parseTagReceipt(renderTagReceipt(tagBinding))));

  assert.throws(
    () => createReleaseBinding({ tag: 'v1.2.3', sourceSha: SHA_A, configRevision: authorityRevision }),
    (error) => error.code === 'config-revision-mismatch',
  );
});

test('같은 태그를 다른 authority 계약 revision으로 다시 build하면 fail-closed한다', () => {
  const current = binding();
  const receipt = parseTagReceipt(renderTagReceipt(current));
  assert.equal(receipt.authorityRevision, current.authorityRevision);
  assert.doesNotThrow(() => assertTagReceipt(current, receipt));

  for (const authorityRevision of ['0'.repeat(64), '', 'not-a-digest']) {
    assert.throws(
      () => assertTagReceipt(current, { ...receipt, authorityRevision }),
      (error) => error.code === 'tag-reuse-with-different-config',
      authorityRevision || 'missing',
    );
  }
});

test('annotated tag receipt는 같은 태그의 다른 source 재사용을 fail-closed한다', () => {
  const current = binding();
  const receipt = parseTagReceipt(`Release v1.2.3 (abc1234)\n\n${renderTagReceipt(current)}`);

  assert.equal(receipt.authority, AUTHORITY_ID);
  assert.equal(receipt.tag, 'v1.2.3');
  assert.equal(receipt.sourceSha, SHA_A);
  assert.equal(receipt.androidVersionCode, '1001002003');
  assert.doesNotThrow(() => assertTagReceipt(current, receipt));

  // receipt가 없는 legacy 태그는 tag→commit 결속만으로 계속 검증한다.
  assert.equal(parseTagReceipt('Release v1.2.3 (abc1234)'), null);
  assert.doesNotThrow(() => assertTagReceipt(current, null));

  assert.throws(
    () => assertTagReceipt(current, { ...receipt, sourceSha: SHA_B }),
    (error) => error.code === 'tag-reuse-with-different-source',
  );
  assert.throws(
    () => assertTagReceipt(current, { ...receipt, tag: 'v1.2.4' }),
    (error) => error.code === 'tag-ref-mismatch',
  );
  assert.throws(
    () => assertTagReceipt(current, { ...receipt, authority: 'legacy-resolver' }),
    (error) => error.code === 'config-revision-mismatch',
  );
  for (const field of ['versionName', 'androidVersionCode', 'appleBuildNumber']) {
    assert.throws(
      () => assertTagReceipt(current, { ...receipt, [field]: '999' }),
      (error) => error.code === 'artifact-provenance-mismatch',
      field,
    );
  }
});

test('AAB manifest readback은 tag 파생값과 다르면 fail-closed한다', () => {
  const rn = binding();
  const rnManifest = parseAabManifest(readFileSync(join(FIXTURES, 'react-native/android/aab-manifest.pb')));
  assert.deepEqual(rnManifest, {
    packageName: 'im.seorilabs.traittesthub',
    versionName: '1.2.3',
    versionCode: 1_001_002_003,
  });
  assert.doesNotThrow(() =>
    assertArtifactVersion({ kind: 'android-app-bundle', binding: rn, observed: rnManifest }),
  );

  // package.json을 authority로 삼은 빌드는 태그와 어긋난다.
  const leaked = parseAabManifest(
    readFileSync(join(FIXTURES, 'react-native/android/aab-manifest-package-json-authority.pb')),
  );
  assert.deepEqual(leaked, {
    packageName: 'im.seorilabs.traittesthub',
    versionName: '0.9.3',
    versionCode: 903_000,
  });
  assert.throws(
    () => assertArtifactVersion({ kind: 'android-app-bundle', binding: rn, observed: leaked }),
    (error) => error.code === 'artifact-provenance-mismatch',
  );

  const godot = binding({ tag: 'v2.0.5', workflow: 'godot-deploy-google-play.yml' });
  const godotManifest = parseAabManifest(readFileSync(join(FIXTURES, 'godot/android/aab-manifest.pb')));
  assert.deepEqual(godotManifest, {
    packageName: 'im.seorilabs.foamparty',
    versionName: '2.0.5',
    versionCode: 1_002_000_005,
  });
  assert.doesNotThrow(() =>
    assertArtifactVersion({ kind: 'android-app-bundle', binding: godot, observed: godotManifest }),
  );

  // 실제 Godot 빌드에서 추출한 manifest. export preset 값이 태그와 무관하게 남아 있는 상태다.
  const configJson = parseAabManifest(
    readFileSync(join(FIXTURES, 'godot/android/aab-manifest-config-json-authority.pb')),
  );
  assert.deepEqual(configJson, {
    packageName: 'im.seorilabs.foamparty',
    versionName: '0.1.0',
    versionCode: 1,
  });
  assert.throws(
    () => assertArtifactVersion({ kind: 'android-app-bundle', binding: godot, observed: configJson }),
    (error) => error.code === 'artifact-provenance-mismatch',
  );

  for (const broken of [Buffer.alloc(0), Buffer.from('not protobuf at all'), Buffer.from([0x0a, 0x00])]) {
    assert.throws(
      () => parseAabManifest(broken),
      (error) => error.code === 'artifact-provenance-mismatch',
    );
  }
});

test('AAB fixture는 Android migration epoch를 적용한 실제 ZIP/protobuf 경로를 재현한다', () => {
  const generated = spawnSync(
    process.execPath,
    [join(REPOSITORY_ROOT, 'scripts/release/generate-aab-fixtures.mjs'), '--check'],
    { encoding: 'utf8' },
  );
  assert.equal(generated.status, 0, generated.stderr);
});

test('xcarchive Info.plist readback은 tag 파생값과 다르면 fail-closed한다', () => {
  const rn = binding({ workflow: 'rn-deploy-app-store.yml' });
  const matched = parseInfoPlistJson(
    readFileSync(join(FIXTURES, 'react-native/ios/info-plist.json'), 'utf8'),
  );
  assert.deepEqual(matched, { versionName: '1.2.3', versionCode: 1_002_003 });
  assert.doesNotThrow(() =>
    assertArtifactVersion({ kind: 'xcode-archive', binding: rn, observed: matched }),
  );

  // run_number를 build number로 쓰는 비결정 폴백은 태그 파생값과 다르다.
  const runNumber = parseInfoPlistJson(
    readFileSync(join(FIXTURES, 'react-native/ios/info-plist-run-number-build.json'), 'utf8'),
  );
  assert.deepEqual(runNumber, { versionName: '1.2.3', versionCode: 47 });
  assert.throws(
    () => assertArtifactVersion({ kind: 'xcode-archive', binding: rn, observed: runNumber }),
    (error) => error.code === 'artifact-provenance-mismatch',
  );

  const godot = binding({ tag: 'v2.0.5', workflow: 'godot-deploy-app-store.yml' });
  assert.doesNotThrow(() =>
    assertArtifactVersion({
      kind: 'xcode-archive',
      binding: godot,
      observed: parseInfoPlistJson(readFileSync(join(FIXTURES, 'godot/ios/info-plist.json'), 'utf8')),
    }),
  );
  assert.throws(
    () =>
      assertArtifactVersion({
        kind: 'xcode-archive',
        binding: godot,
        observed: parseInfoPlistJson(
          readFileSync(join(FIXTURES, 'godot/ios/info-plist-godot-project-authority.json'), 'utf8'),
        ),
      }),
    (error) => error.code === 'artifact-provenance-mismatch',
  );

  for (const broken of ['[]', '{}', '{"CFBundleShortVersionString":"1.2.3"}', '{"CFBundleShortVersionString":"1.2.3","CFBundleVersion":"1.2.3"}']) {
    assert.throws(
      () => parseInfoPlistJson(broken),
      (error) => error.code === 'artifact-provenance-mismatch',
    );
  }
});

test('지원하는 .ait 형식에는 내부 version 필드가 없고 memo가 artifact digest를 담는다', () => {
  // 실제 RN(.ait v1 컨테이너)과 Godot(legacy zip) 산출물 fixture를 그대로 읽는다.
  const rn = readAitContainer(readFileSync(join(FIXTURES, 'react-native/ait/trait-test-hub.ait')));
  assert.equal(rn.format, 'ait');
  assert.equal(rn.formatVersion, 1);
  assert.equal(rn.appName, 'trait-test-hub');
  assert.match(rn.deploymentId, /^[0-9a-f-]{36}$/u);
  // 계약: 지원 형식 어느 쪽도 내부 version 기록을 갖지 않는다. 그래서 authority는 태그다.
  assert.deepEqual([...rn.versionFields], []);

  const godot = readAitContainer(readFileSync(join(FIXTURES, 'godot/ait/foam-party.ait')));
  assert.equal(godot.format, 'zip');
  assert.deepEqual([...godot.versionFields], []);

  assert.throws(
    () => readAitContainer(Buffer.from('not a bundle at all')),
    (error) => error.code === 'artifact-provenance-mismatch',
  );

  const current = binding({ workflow: 'rn-deploy-ait.yml' });
  const digest = createHash('sha256').update('artifact').digest('hex');
  const memo = canonicalReleaseMemo(current, { artifactDigest: digest });
  assert.equal(
    memo,
    `v1.2.3 1.2.3 (1001002003) src:${SHA_A.slice(0, 12)} sha256:${digest}`,
  );
  assert.equal(
    canonicalReleaseMemo(current, { artifactDigest: digest, note: ' hotfix  rollout ' }),
    `${memo} · hotfix rollout`,
  );
  // digest가 사라지면 식별자가 무너지므로 자르지 않고 fail-closed한다.
  assert.throws(
    () => canonicalReleaseMemo(current, { artifactDigest: digest, note: 'x'.repeat(2000) }),
    (error) => error.code === 'artifact-digest-mismatch',
  );
  assert.throws(
    () => canonicalReleaseMemo(current, { artifactDigest: 'nope' }),
    (error) => error.code === 'artifact-digest-mismatch',
  );

  assert.doesNotThrow(() =>
    assertArtifactVersion({ kind: 'ait', binding: current, observed: { memo, digest } }),
  );
  // 같은 태그·같은 memo라도 다른 파일이면 digest가 달라 대조에서 어긋난다.
  const otherDigest = createHash('sha256').update('other artifact').digest('hex');
  assert.throws(
    () =>
      assertArtifactVersion({
        kind: 'ait',
        binding: current,
        observed: { memo, digest: otherDigest },
      }),
    (error) => error.code === 'artifact-digest-mismatch',
  );
  assert.throws(
    () =>
      assertArtifactVersion({
        kind: 'ait',
        binding: current,
        observed: { memo: 'GitHub Actions main@abc1234', digest },
      }),
    (error) => error.code === 'artifact-digest-mismatch',
  );
  assert.throws(
    () => assertArtifactVersion({ kind: 'ait', binding: current, observed: { memo, digest: 'nope' } }),
    (error) => error.code === 'artifact-digest-mismatch',
  );
  // 컨테이너가 내부 version 기록을 갖게 되면 계약 갱신 전까지 배포하지 않는다.
  assert.throws(
    () =>
      assertArtifactVersion({
        kind: 'ait',
        binding: current,
        observed: { memo, digest, versionFields: ['bundle.field9'] },
      }),
    (error) => error.code === 'ait-internal-version-field-present',
  );
});

test('AIT v1 framing을 exact length로 읽어 zip payload 스캔을 건너뛰지 않는다', () => {
  const bytes = readFileSync(join(FIXTURES, 'react-native/ait/trait-test-hub.ait'));
  // magic(8) + formatVersion(4) + protobuf 길이(8) + protobuf + zip 길이(8) + zip payload + zero trailer(8)
  const protobufLength = Number(bytes.readBigUInt64BE(12));
  const zipStart = 20 + protobufLength + 8;
  const zipLength = Number(bytes.readBigUInt64BE(20 + protobufLength));
  const zipEnd = zipStart + zipLength;
  assert.equal(zipEnd + 8, bytes.length);
  assert.deepEqual(bytes.subarray(zipEnd), Buffer.alloc(8));
  assert.deepEqual(bytes.subarray(zipStart, zipStart + 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]));

  const container = readAitContainer(bytes);
  assert.equal(container.zipLength, zipLength);
  assert.equal(container.trailerLength, 8);
  // zip payload를 실제로 열어 entry를 읽었는지 확인한다. 건너뛰면 아래가 비어 있다.
  assert.ok(readZipEntryNames(bytes.subarray(zipStart, zipEnd)).length > 0);
  assert.deepEqual([...container.versionFields], []);

  // framing의 의미가 확정되지 않은 미래 formatVersion은 v1으로 추측하지 않는다.
  const futureFormat = Buffer.from(bytes);
  futureFormat.writeUInt32BE(2, 8);
  assert.throws(
    () => readAitContainer(futureFormat),
    (error) => error.code === 'artifact-provenance-mismatch',
  );

  // zip payload 길이 필드를 건너뛴 옛 framing은 길이 검증에서 fail-closed한다.
  const legacyFraming = Buffer.concat([
    bytes.subarray(0, 20 + protobufLength),
    bytes.subarray(zipStart, zipEnd),
  ]);
  assert.throws(
    () => readAitContainer(legacyFraming),
    (error) => error.code === 'artifact-provenance-mismatch',
  );
  // 잘린 길이 필드와 실제 payload보다 큰/작은 길이도 모두 거부한다.
  assert.throws(
    () => readAitContainer(bytes.subarray(0, 20 + protobufLength + 4)),
    (error) => error.code === 'artifact-provenance-mismatch',
  );
  for (const delta of [-1, 1]) {
    const wrongLength = Buffer.from(bytes);
    wrongLength.writeBigUInt64BE(BigInt(zipLength + delta), 20 + protobufLength);
    assert.throws(
      () => readAitContainer(wrongLength),
      (error) => error.code === 'artifact-provenance-mismatch',
      `delta ${delta}`,
    );
  }
  // central directory를 읽을 수 없으면 "version 기록 없음"으로 통과시키지 않는다.
  assert.throws(
    () => readZipEntryNames(bytes.subarray(zipStart, zipStart + 40)),
    (error) => error.code === 'artifact-provenance-mismatch',
  );
  const nonzeroTrailer = Buffer.from(bytes);
  nonzeroTrailer[nonzeroTrailer.length - 1] = 1;
  assert.throws(
    () => readAitContainer(nonzeroTrailer),
    (error) => error.code === 'artifact-provenance-mismatch',
  );
});

test('AIT fixture는 현행 CLI의 8-byte zero trailer framing을 재현한다', () => {
  const generated = spawnSync(
    process.execPath,
    [join(REPOSITORY_ROOT, 'scripts/release/generate-ait-fixtures.mjs'), '--check'],
    { encoding: 'utf8' },
  );
  assert.equal(generated.status, 0, generated.stderr);
});

test('zip payload에 version metadata가 들어간 .ait은 배포를 거부한다', () => {
  const injectedPath = join(FIXTURES, 'react-native/ait/trait-test-hub-version-metadata.ait');
  const injected = readAitContainer(readFileSync(injectedPath));
  assert.equal(injected.format, 'ait');
  assert.deepEqual([...injected.versionFields], ['zip:version.json']);

  const current = binding({ workflow: 'rn-deploy-ait.yml' });
  const digest = createHash('sha256').update(readFileSync(injectedPath)).digest('hex');
  assert.throws(
    () =>
      assertArtifactVersion({
        kind: 'ait',
        binding: current,
        observed: {
          memo: canonicalReleaseMemo(current, { artifactDigest: digest }),
          digest,
          versionFields: injected.versionFields,
        },
      }),
    (error) => error.code === 'ait-internal-version-field-present',
  );

  // 검증 CLI도 같은 이유로 업로드 전에 fail-closed한다.
  const root = mkdtempSync(join(tmpdir(), 'release-ait-injected-'));
  try {
    const bindingPath = join(root, 'binding.json');
    writeFileSync(bindingPath, JSON.stringify(current, null, 2));
    const result = runNode(VERIFY_CLI, [
      '--kind',
      'ait',
      '--binding',
      bindingPath,
      '--artifact',
      injectedPath,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ait-internal-version-field-present/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact receipt는 binding·kind·digest·memo를 한 파일로 묶는다', () => {
  const current = binding({ workflow: 'rn-deploy-ait.yml' });
  const digest = createHash('sha256').update('artifact').digest('hex');
  const memo = canonicalReleaseMemo(current, { artifactDigest: digest });
  const receipt = parseArtifactReceipt(
    renderArtifactReceipt({ binding: current, kind: 'ait', artifactDigest: digest, memo }),
  );
  assert.equal(receipt['artifact-sha256'], digest);
  assert.equal(receipt['artifact-digest-source'], 'artifact-file');
  assert.equal(receipt['upload-memo'], memo);
  assert.equal(receipt.tag, 'v1.2.3');
  assert.doesNotThrow(() =>
    assertArtifactReceipt({ binding: current, kind: 'ait', artifactDigest: digest, memo, receipt }),
  );
  // 다른 파일을 올리면 receipt 대조에서 드러난다.
  assert.throws(
    () =>
      assertArtifactReceipt({
        binding: current,
        kind: 'ait',
        artifactDigest: createHash('sha256').update('swapped').digest('hex'),
        memo,
        receipt,
      }),
    (error) => error.code === 'artifact-digest-mismatch',
  );
  assert.equal(
    parseArtifactReceipt(
      renderArtifactReceipt({
        binding: current,
        kind: 'xcode-archive',
        artifactDigest: digest,
      }),
    )['artifact-digest-source'],
    'archive-info-plist',
  );
});

test('Godot export preset 주입은 명시된 preset 하나만 바꾼다', () => {
  const presets = readFileSync(join(FIXTURES, 'godot/export_presets.cfg'), 'utf8');
  const current = binding({ tag: 'v2.0.5', workflow: 'godot-deploy-google-play.yml' });

  const android = applyGodotExportVersion(presets, {
    platform: 'Android',
    binding: current,
    preset: 'Android',
  });
  assert.match(android, /^version\/code=1002000005$/mu);
  assert.match(android, /^version\/name="2\.0\.5"$/mu);
  assert.doesNotMatch(android, /^version\/code=3$/mu);

  // 인덱스 선택자도 같은 preset을 가리킨다.
  assert.equal(
    applyGodotExportVersion(presets, { platform: 'Android', binding: current, preset: 'preset.0' }),
    android,
  );

  const ios = applyGodotExportVersion(android, {
    platform: 'iOS',
    binding: current,
    preset: 'iOS',
  });
  assert.match(ios, /^application\/short_version="2\.0\.5"$/mu);
  assert.match(ios, /^application\/version="2000005"$/mu);
  // 다른 preset의 값은 건드리지 않는다.
  assert.match(ios, /^package\/unique_name="im\.seorilabs\.foamparty"$/mu);
  assert.equal(ios.split('\n').length, presets.split('\n').length);

  // 선택자가 없으면 같은 platform preset이 여럿일 때 임의로 고를 수 있으므로 fail-closed한다.
  assert.throws(
    () => applyGodotExportVersion(presets, { platform: 'Android', binding: current }),
    (error) => error.code === 'godot-preset-selector-required',
  );
  assert.throws(
    () =>
      applyGodotExportVersion(presets, {
        platform: 'Android',
        binding: current,
        preset: 'AndroidQA',
      }),
    (error) => error.code === 'godot-preset-selector-mismatch',
  );
  // 선택자가 실제 export 대상 platform과 다르면 잘못된 preset을 덮어쓰게 되므로 거부한다.
  assert.throws(
    () => applyGodotExportVersion(presets, { platform: 'iOS', binding: current, preset: 'Android' }),
    (error) => error.code === 'godot-preset-selector-mismatch',
  );
  // 같은 이름 preset이 둘이면 어느 쪽을 export하는지 파일만으로 결정할 수 없다.
  const duplicated = [
    '[preset.0]',
    '',
    'name="Android"',
    'platform="Android"',
    '',
    '[preset.0.options]',
    '',
    'version/code=1',
    'version/name="0.0.1"',
    '',
    '[preset.1]',
    '',
    'name="Android"',
    'platform="Android"',
    '',
    '[preset.1.options]',
    '',
    'version/code=1',
    'version/name="0.0.1"',
    '',
  ].join('\n');
  assert.throws(
    () =>
      applyGodotExportVersion(duplicated, {
        platform: 'Android',
        binding: current,
        preset: 'Android',
      }),
    (error) => error.code === 'godot-preset-selector-ambiguous',
  );
  assert.throws(
    () =>
      applyGodotExportVersion(presets, {
        platform: 'macOS',
        binding: current,
        preset: 'preset.0',
      }),
    (error) => error.code === 'artifact-provenance-mismatch',
  );
  assert.throws(
    () =>
      applyGodotExportVersion(
        '[preset.0]\n\nplatform="Android"\n\n[preset.0.options]\n\npackage/name="x"\n',
        { platform: 'Android', binding: current, preset: 'preset.0' },
      ),
    (error) => error.code === 'artifact-provenance-mismatch',
  );
});

test('v0.0.0과 versionCode 0은 어떤 마켓 artifact도 만들 수 없다', () => {
  assert.throws(
    () => deriveReleaseVersion('v0.0.0'),
    (error) => error.code === 'derived-version-code-out-of-range',
  );
  // 태그 생성 경로(release-tag.yml)도 같은 구현을 쓰므로 태그 자체가 만들어지지 않는다.
  assert.throws(
    () =>
      createReleaseBinding({
        tag: 'v0.0.0',
        sourceSha: SHA_A,
        authorityRevision: 'a'.repeat(64),
        configRevision: 'b'.repeat(64),
      }),
    (error) => error.code === 'derived-version-code-out-of-range',
  );
  // 최신 stable 태그 자동 선택에서도 후보가 아니다.
  assert.equal(selectLatestStableTag(['v0.0.0', 'v0.0.1']), 'v0.0.1');
  assert.throws(
    () => selectLatestStableTag(['v0.0.0']),
    (error) => error.code === 'tag-pattern-mismatch',
  );
  assert.equal(deriveReleaseVersion('v0.0.1').androidVersionCode, 1_000_000_001);
});

test('release ref는 exact stable tag ref 하나만 허용한다', () => {
  assert.equal(parseReleaseTagRef('refs/tags/v1.2.3').tag, 'v1.2.3');
  for (const ref of [
    'refs/heads/main',
    'refs/heads/v1.2.3',
    'refs/tags/v1.2.3-rc.1',
    'refs/tags/release/v1.2.3',
    'refs/pull/41/merge',
    '',
  ]) {
    assert.throws(
      () => parseReleaseTagRef(ref),
      (error) => ['tag-ref-mismatch', 'tag-pattern-mismatch'].includes(error.code),
      ref,
    );
  }
});

test('resolver CLI는 태그만으로 GitHub output과 binding 파일을 만든다', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-resolver-'));
  try {
    const outputPath = join(root, 'github-output.txt');
    const bindingPath = join(root, 'binding.json');
    const result = runNode(
      RESOLVE_CLI,
      ['--tag', 'v1.2.3', '--source-sha', SHA_A, '--binding', bindingPath, '--github-output'],
      { ...authorityEnv(), GITHUB_OUTPUT: outputPath },
    );
    assert.equal(result.status, 0, result.stderr);

    const expected = binding();
    assert.deepEqual(JSON.parse(readFileSync(bindingPath, 'utf8')), expected);
    assert.equal(
      readFileSync(outputPath, 'utf8'),
      `${[...githubOutputLines(expected), 'tag_source=requested-tag'].join('\n')}\n`,
    );
    assert.match(readFileSync(outputPath, 'utf8'), /^version_name=1\.2\.3$/mu);
    assert.match(readFileSync(outputPath, 'utf8'), /^android_version_code=1001002003$/mu);
    assert.match(readFileSync(outputPath, 'utf8'), /^apple_build_number=1002003$/mu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('태그 이벤트는 그 태그만 build하고 latest 폴백은 workflow_dispatch에서만 허용한다', () => {
  const tagList = ['v1.0.0', 'v1.2.3', 'v2.0.0'].join('\n');

  // refs/tags 이벤트는 저장소에 더 최신 태그가 있어도 그 태그가 정본이다.
  assert.deepEqual(
    selectReleaseTagForEvent({ eventName: 'push', eventRef: 'refs/tags/v1.2.3', tagList }),
    { tag: 'v1.2.3', source: 'event-tag-ref' },
  );
  // 같은 값을 명시해도 같고, 다른 태그를 요청하면 거부한다.
  assert.equal(
    selectReleaseTagForEvent({
      eventName: 'push',
      eventRef: 'refs/tags/v1.2.3',
      requestedTag: 'v1.2.3',
      tagList,
    }).tag,
    'v1.2.3',
  );
  assert.throws(
    () =>
      selectReleaseTagForEvent({
        eventName: 'push',
        eventRef: 'refs/tags/v1.2.3',
        requestedTag: 'v2.0.0',
        tagList,
      }),
    (error) => error.code === 'tag-ref-mismatch',
  );

  // 운영자가 시작한 workflow_dispatch에서만 최신 태그 폴백을 허용한다.
  assert.deepEqual(
    selectReleaseTagForEvent({ eventName: 'workflow_dispatch', eventRef: 'refs/heads/main', tagList }),
    { tag: 'v2.0.0', source: 'latest-stable-dispatch' },
  );
  for (const eventName of ['push', 'release', 'schedule', '']) {
    assert.throws(
      () => selectReleaseTagForEvent({ eventName, eventRef: 'refs/heads/main', tagList }),
      (error) => error.code === 'tag-ref-mismatch',
      eventName,
    );
  }
  // 명시한 태그도 운영자가 시작한 workflow_dispatch에서만 허용한다.
  assert.deepEqual(
    selectReleaseTagForEvent({
      eventName: 'workflow_dispatch',
      eventRef: 'refs/heads/main',
      requestedTag: 'v1.0.0',
    }),
    { tag: 'v1.0.0', source: 'requested-tag' },
  );
  for (const eventName of ['push', 'pull_request', 'schedule', '']) {
    assert.throws(
      () =>
        selectReleaseTagForEvent({
          eventName,
          eventRef: 'refs/heads/main',
          requestedTag: 'v1.0.0',
        }),
      (error) => error.code === 'tag-ref-mismatch',
      eventName,
    );
  }
});

test('resolver CLI는 태그 이벤트에서 latest 폴백과 다른 commit을 거부한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-event-'));
  try {
    const tagListPath = join(root, 'tags.txt');
    writeFileSync(tagListPath, 'v1.2.3\nv2.0.0\n');

    // 태그 push 이벤트: 저장소에 v2.0.0이 있어도 이벤트 태그만 고른다.
    const pinned = runNode(RESOLVE_CLI, ['--tag-list-file', tagListPath, '--print-tag'], {
      RELEASE_EVENT_NAME: 'push',
      RELEASE_EVENT_REF: 'refs/tags/v1.2.3',
    });
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.equal(pinned.stdout.trim(), 'v1.2.3');

    // workflow_dispatch에서만 최신 태그 폴백을 쓴다.
    const dispatched = runNode(RESOLVE_CLI, ['--tag-list-file', tagListPath, '--print-tag'], {
      RELEASE_EVENT_NAME: 'workflow_dispatch',
      RELEASE_EVENT_REF: 'refs/heads/main',
    });
    assert.equal(dispatched.stdout.trim(), 'v2.0.0');

    const pushed = runNode(RESOLVE_CLI, ['--tag-list-file', tagListPath, '--print-tag'], {
      RELEASE_EVENT_NAME: 'push',
      RELEASE_EVENT_REF: 'refs/heads/main',
    });
    assert.notEqual(pushed.status, 0);
    assert.match(pushed.stderr, /tag-ref-mismatch/u);

    // 태그 이벤트 commit과 해석된 source SHA가 다르면 build하지 않는다.
    const drifted = runNode(
      RESOLVE_CLI,
      ['--source-sha', SHA_A, '--github-output'],
      {
        ...authorityEnv(),
        GITHUB_OUTPUT: join(root, 'output.txt'),
        RELEASE_EVENT_NAME: 'push',
        RELEASE_EVENT_REF: 'refs/tags/v1.2.3',
        RELEASE_EVENT_SHA: SHA_B,
      },
    );
    assert.notEqual(drifted.status, 0);
    assert.match(drifted.stderr, /source-sha-mismatch/u);

    const aligned = runNode(
      RESOLVE_CLI,
      ['--source-sha', SHA_A, '--github-output'],
      {
        ...authorityEnv(),
        GITHUB_OUTPUT: join(root, 'aligned.txt'),
        RELEASE_EVENT_NAME: 'push',
        RELEASE_EVENT_REF: 'refs/tags/v1.2.3',
        RELEASE_EVENT_SHA: SHA_A,
      },
    );
    assert.equal(aligned.status, 0, aligned.stderr);
    assert.match(readFileSync(join(root, 'aligned.txt'), 'utf8'), /^tag_source=event-tag-ref$/mu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolver CLI는 tag/source/receipt 불일치를 종료 코드로 fail-closed한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-resolver-fail-'));
  try {
    const receiptPath = join(root, 'tag-message.txt');
    writeFileSync(receiptPath, `Release v1.2.3\n\n${renderTagReceipt(binding({ sourceSha: SHA_B }))}\n`);

    const mismatchedReceipt = runNode(
      RESOLVE_CLI,
      ['--tag', 'v1.2.3', '--source-sha', SHA_A, '--tag-message-file', receiptPath],
      authorityEnv(),
    );
    assert.notEqual(mismatchedReceipt.status, 0);
    assert.match(mismatchedReceipt.stderr, /tag-reuse-with-different-source/u);

    const badHead = runNode(
      RESOLVE_CLI,
      ['--tag', 'v1.2.3', '--source-sha', SHA_A, '--head-sha', SHA_B],
      authorityEnv(),
    );
    assert.notEqual(badHead.status, 0);
    assert.match(badHead.stderr, /source-sha-mismatch/u);

    const floating = runNode(RESOLVE_CLI, ['--tag', 'v1.2.3', '--source-sha', SHA_A], {
      JOB_WORKFLOW_REPOSITORY: 'seorilabs/.github',
      JOB_WORKFLOW_SHA: WORKFLOW_SHA,
      JOB_WORKFLOW_REF: 'seorilabs/.github/.github/workflows/rn-deploy-ait.yml@main',
      RELEASE_EVENT_NAME: 'workflow_dispatch',
      RELEASE_EVENT_REF: 'refs/heads/main',
    });
    assert.notEqual(floating.status, 0);
    assert.match(floating.stderr, /config-revision-mismatch/u);

    const badTag = runNode(RESOLVE_CLI, ['--tag', 'v1.2.3-rc.1', '--source-sha', SHA_A], authorityEnv());
    assert.notEqual(badTag.status, 0);
    assert.match(badTag.stderr, /tag-pattern-mismatch/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact 검증 CLI는 RN·Godot·AIT 경로 fixture를 그대로 readback한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-verify-'));
  try {
    const rnBinding = join(root, 'rn.json');
    const godotBinding = join(root, 'godot.json');
    writeFileSync(rnBinding, JSON.stringify(binding(), null, 2));
    writeFileSync(
      godotBinding,
      JSON.stringify(binding({ tag: 'v2.0.5', workflow: 'godot-deploy-google-play.yml' }), null, 2),
    );

    // AAB fixture는 실제 컨테이너다. 워크플로우와 같은 방식으로 zip에서 manifest를 꺼내 읽는다.
    const androidCases = [
      [rnBinding, 'react-native/android/app-release.aab', true],
      [rnBinding, 'react-native/android/app-release-package-json-authority.aab', false],
      [godotBinding, 'godot/android/app-release.aab', true],
      [godotBinding, 'godot/android/app-release-config-json-authority.aab', false],
    ];
    for (const [bindingPath, fixture, shouldPass] of androidCases) {
      const artifactPath = join(FIXTURES, fixture);
      const manifestPath = join(root, `${fixture.replaceAll('/', '_')}.pb`);
      writeFileSync(
        manifestPath,
        execFileSync('unzip', ['-p', artifactPath, 'base/manifest/AndroidManifest.xml'], {
          maxBuffer: 8 * 1024 * 1024,
        }),
      );
      const receiptPath = join(root, `${fixture.replaceAll('/', '_')}.receipt.txt`);
      const result = runNode(VERIFY_CLI, [
        '--kind',
        'android-app-bundle',
        '--binding',
        bindingPath,
        '--artifact',
        artifactPath,
        '--metadata',
        manifestPath,
        '--receipt',
        receiptPath,
      ]);
      assert.equal(result.status === 0, shouldPass, `${fixture}: ${result.stderr}`);
      if (shouldPass) {
        const receipt = parseArtifactReceipt(readFileSync(receiptPath, 'utf8'));
        assert.equal(
          receipt['artifact-sha256'],
          createHash('sha256').update(readFileSync(artifactPath)).digest('hex'),
          fixture,
        );
        assert.equal(receipt['artifact-kind'], 'android-app-bundle', fixture);
        assert.equal(receipt['artifact-digest-source'], 'artifact-file', fixture);
      } else {
        assert.match(result.stderr, /artifact-provenance-mismatch/u, fixture);
      }
    }
    // 업로드 대상 파일 없이 metadata만으로는 AAB를 검증하지 않는다.
    assert.match(
      runNode(VERIFY_CLI, [
        '--kind',
        'android-app-bundle',
        '--binding',
        rnBinding,
        '--metadata',
        join(FIXTURES, 'react-native/android/aab-manifest.pb'),
      ]).stderr,
      /artifact-digest-mismatch/u,
    );

    const archiveCases = [
      [rnBinding, 'react-native/ios/info-plist.json', true],
      [rnBinding, 'react-native/ios/info-plist-run-number-build.json', false],
      [godotBinding, 'godot/ios/info-plist.json', true],
      [godotBinding, 'godot/ios/info-plist-godot-project-authority.json', false],
    ];
    for (const [bindingPath, fixture, shouldPass] of archiveCases) {
      const result = runNode(VERIFY_CLI, [
        '--kind',
        'xcode-archive',
        '--binding',
        bindingPath,
        '--metadata',
        join(FIXTURES, fixture),
      ]);
      assert.equal(result.status === 0, shouldPass, `${fixture}: ${result.stderr}`);
      if (!shouldPass) {
        assert.match(result.stderr, /artifact-provenance-mismatch/u, fixture);
      }
    }

    const outputPath = join(root, 'ait-output.txt');
    const aitArtifact = join(FIXTURES, 'react-native/ait/trait-test-hub.ait');
    const ait = runNode(
      VERIFY_CLI,
      ['--kind', 'ait', '--binding', rnBinding, '--artifact', aitArtifact, '--github-output'],
      { GITHUB_OUTPUT: outputPath, RELEASE_MEMO_NOTE: 'internal rollout' },
    );
    assert.equal(ait.status, 0, ait.stderr);
    const aitOutput = readFileSync(outputPath, 'utf8');
    const aitDigest = createHash('sha256').update(readFileSync(aitArtifact)).digest('hex');
    assert.match(aitOutput, /^ait_format=ait$/mu);
    assert.match(
      aitOutput,
      new RegExp(
        `^release_memo=v1\\.2\\.3 1\\.2\\.3 \\(1001002003\\) src:a{12} sha256:${aitDigest} · internal rollout$`,
        'mu',
      ),
    );
    assert.match(aitOutput, new RegExp(`^artifact_digest=${aitDigest}$`, 'mu'));
    assert.match(aitOutput, /^artifact_digest_source=artifact-file$/mu);

    const wrongMemo = runNode(VERIFY_CLI, [
      '--kind',
      'ait',
      '--binding',
      rnBinding,
      '--artifact',
      aitArtifact,
      '--memo',
      'GitHub Actions main@abc1234',
    ]);
    assert.notEqual(wrongMemo.status, 0);
    assert.match(wrongMemo.stderr, /artifact-digest-mismatch/u);

    // 같은 태그·같은 binding이라도 다른 .ait 파일을 올리면 memo digest가 달라 대조에서 어긋난다.
    const swapped = runNode(VERIFY_CLI, [
      '--kind',
      'ait',
      '--binding',
      rnBinding,
      '--artifact',
      join(FIXTURES, 'godot/ait/foam-party.ait'),
      '--memo',
      readFileSync(outputPath, 'utf8')
        .split('\n')
        .find((line) => line.startsWith('release_memo='))
        .slice('release_memo='.length),
    ]);
    assert.notEqual(swapped.status, 0);
    assert.match(swapped.stderr, /artifact-digest-mismatch/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Godot 주입 CLI는 binding 파일 기준으로 export preset을 덮어쓴다', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-godot-'));
  try {
    const bindingPath = join(root, 'binding.json');
    const presetsPath = join(root, 'export_presets.cfg');
    writeFileSync(
      bindingPath,
      JSON.stringify(binding({ tag: 'v2.0.5', workflow: 'godot-deploy-google-play.yml' }), null, 2),
    );
    writeFileSync(presetsPath, readFileSync(join(FIXTURES, 'godot/export_presets.cfg'), 'utf8'));

    for (const [platform, preset] of [['Android', 'Android'], ['iOS', 'iOS']]) {
      const result = runNode(GODOT_CLI, [
        '--binding',
        bindingPath,
        '--platform',
        platform,
        '--preset',
        preset,
        '--presets',
        presetsPath,
      ]);
      assert.equal(result.status, 0, result.stderr);
    }

    const patched = readFileSync(presetsPath, 'utf8');
    assert.match(patched, /^version\/code=1002000005$/mu);
    assert.match(patched, /^version\/name="2\.0\.5"$/mu);
    assert.match(patched, /^application\/short_version="2\.0\.5"$/mu);
    assert.match(patched, /^application\/version="2000005"$/mu);

    // 선택자 없이 호출하면 어떤 preset을 바꿀지 결정할 수 없어 fail-closed한다.
    const missingSelector = runNode(GODOT_CLI, [
      '--binding',
      bindingPath,
      '--platform',
      'Android',
      '--presets',
      presetsPath,
    ]);
    assert.notEqual(missingSelector.status, 0);
    assert.match(missingSelector.stderr, /godot-preset-selector-required/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('워크플로우의 exact tag 해석 블록은 동명 branch와 비정상 태그를 거부한다', () => {
  const blocks = RELEASE_WORKFLOWS.map((name) => extractRunBlock(workflowText(name), 'Resolve exact release tag'));
  for (const block of blocks) {
    assert.equal(block, blocks[0], '모든 릴리즈 경로가 같은 tag 해석 구현을 써야 한다');
  }

  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  const runTagBlock = (cwd, releaseTag, event = {}) => {
    const output = join(cwd, 'github-output.txt');
    writeFileSync(output, '');
    return {
      ...spawnSync('bash', ['-c', `set -euo pipefail\n${blocks[0]}`], {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          RELEASE_TAG: releaseTag,
          RUNNER_TEMP: cwd,
          GITHUB_OUTPUT: output,
          // 기본은 운영자가 시작한 dispatch. 태그 이벤트는 호출부에서 명시한다.
          RELEASE_EVENT_NAME: event.name ?? 'workflow_dispatch',
          RELEASE_EVENT_REF: event.ref ?? 'refs/heads/main',
          RELEASE_EVENT_SHA: event.sha ?? '',
        },
      }),
      output: readFileSync(output, 'utf8'),
    };
  };

  const createRepository = () => {
    const root = mkdtempSync(join(tmpdir(), 'release-tag-block-'));
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Release Test');
    git(root, 'config', 'user.email', 'release-test@example.invalid');
    writeFileSync(join(root, 'source.txt'), 'tag source\n');
    git(root, 'add', 'source.txt');
    git(root, 'commit', '-q', '-m', 'tag source');
    mkdirSync(join(root, '.seorilabs-release-authority'));
    symlinkSync(
      resolve(REPOSITORY_ROOT, 'scripts'),
      join(root, '.seorilabs-release-authority', 'scripts'),
    );
    symlinkSync(
      resolve(REPOSITORY_ROOT, 'contracts'),
      join(root, '.seorilabs-release-authority', 'contracts'),
    );
    return root;
  };

  let root = createRepository();
  try {
    const tagCommit = git(root, 'rev-parse', 'HEAD');
    git(root, 'tag', '-a', 'v1.2.3', '-m', 'annotated stable');
    writeFileSync(join(root, 'source.txt'), 'branch source\n');
    git(root, 'add', 'source.txt');
    git(root, 'commit', '-q', '-m', 'branch source');
    git(root, 'branch', 'v1.2.3');

    const result = runTagBlock(root, 'v1.2.3');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(root, 'rev-parse', 'HEAD^{commit}'), tagCommit);
    assert.match(result.output, /^tag=v1\.2\.3$/mu);
    assert.match(result.output, new RegExp(`^sha=${tagCommit}$`, 'mu'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  root = createRepository();
  try {
    for (const tag of ['v1.2.9', 'v1.2.10', 'v9.0.0-rc.1', 'v01.2.3', 'v9223372036854775808.0.0']) {
      git(root, 'tag', tag);
    }
    const result = runTagBlock(root, '');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /^tag=v1\.2\.10$/mu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  for (const releaseTag of ['1.2.3', 'v1.2.3-rc.1', 'v01.2.3', 'v1.1000.0']) {
    root = createRepository();
    try {
      const before = git(root, 'rev-parse', 'HEAD');
      const result = runTagBlock(root, releaseTag);
      assert.notEqual(result.status, 0, releaseTag);
      assert.match(result.stderr, /tag-pattern-mismatch/u, releaseTag);
      assert.equal(git(root, 'rev-parse', 'HEAD'), before, releaseTag);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // refs/tags 이벤트는 더 최신 태그가 있어도 그 태그의 commit만 build한다.
  root = createRepository();
  try {
    const tagCommit = git(root, 'rev-parse', 'HEAD');
    git(root, 'tag', '-a', 'v1.2.3', '-m', 'annotated stable');
    writeFileSync(join(root, 'source.txt'), 'newer\n');
    git(root, 'add', 'source.txt');
    git(root, 'commit', '-q', '-m', 'newer');
    git(root, 'tag', '-a', 'v9.9.9', '-m', 'newer stable');
    const newerCommit = git(root, 'rev-parse', 'HEAD^{commit}');

    const pinned = runTagBlock(root, '', {
      name: 'push',
      ref: 'refs/tags/v1.2.3',
      sha: tagCommit,
    });
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.match(pinned.output, /^tag=v1\.2\.3$/mu);
    assert.match(pinned.output, new RegExp(`^sha=${tagCommit}$`, 'mu'));
    assert.doesNotMatch(pinned.output, /v9\.9\.9/u);

    // 태그 이벤트 commit이 태그가 가리키는 commit과 다르면 build하지 않는다.
    const drifted = runTagBlock(root, '', {
      name: 'push',
      ref: 'refs/tags/v1.2.3',
      sha: newerCommit,
    });
    assert.notEqual(drifted.status, 0);
    assert.match(drifted.stderr, /tag 이벤트 commit과 태그 commit이 다름/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // 태그도 없고 dispatch도 아닌 실행에서는 최신 태그 폴백을 쓰지 않는다.
  root = createRepository();
  try {
    git(root, 'tag', '-a', 'v1.2.3', '-m', 'annotated stable');
    const result = runTagBlock(root, '', { name: 'push', ref: 'refs/heads/main' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tag-ref-mismatch/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('모든 릴리즈 경로가 org 정본 authority를 exact SHA로 호출한다', () => {
  for (const name of RELEASE_WORKFLOWS) {
    const text = workflowText(name);

    assert.match(
      text,
      new RegExp(`EXPECTED_WORKFLOW_PATH: seorilabs/\\.github/\\.github/workflows/${name.replace('.', '\\.')}`, 'u'),
      name,
    );
    assert.match(text, /identity\.workflow_repository !== "seorilabs\/\.github"/u, name);
    assert.match(text, /\/\^\[0-9a-f\]\{40\}\$\/\.test\(identity\.workflow_sha/u, name);
    assert.match(text, /ref: \$\{\{ steps\.authority\.outputs\.sha \}\}/u, name);
    assert.match(text, /path: \.seorilabs-release-authority/u, name);
    assert.match(text, /persist-credentials: false/u, name);
    assert.match(
      text,
      /node \.seorilabs-release-authority\/scripts\/release\/resolve-release-version\.mjs --tag-list-file "\$RUNNER_TEMP\/git-tags\.txt" --print-tag/u,
      name,
    );
    assert.match(
      text,
      /node \.seorilabs-release-authority\/scripts\/release\/resolve-release-version\.mjs --github-output/u,
      name,
    );
    assert.match(text, /checkout "refs\/tags\/\$tag"/u, name);
    assert.match(text, /\[ "\$tag_commit" = "\$head_commit" \]/u, name);

    // 죽은 구버전 authority가 남아 있으면 안 된다.
    assert.doesNotMatch(text, /version_script/u, name);
    assert.doesNotMatch(text, /scripts\/resolve-release-version\.mjs/u, name);
    assert.doesNotMatch(text, /set_google_play_version_code\.py/u, name);
    assert.doesNotMatch(text, /GITHUB_RUN_NUMBER/u, name);
    assert.doesNotMatch(text, /secrets: inherit/u, name);

    // 사용자 입력을 shell 본문에 직접 보간하지 않는다.
    assert.doesNotMatch(text, /tag="\$\{\{ inputs\.release_tag \}\}"/u, name);
    assert.match(text, /RELEASE_TAG: \$\{\{ inputs\.release_tag \}\}/u, name);
  }
});

test('릴리즈 경로는 artifact metadata를 다시 읽어 태그와 대조한다', () => {
  const readback = {
    'rn-deploy-google-play.yml': 'android-app-bundle',
    'rn-build-android.yml': 'android-app-bundle',
    'godot-deploy-google-play.yml': 'android-app-bundle',
    'rn-deploy-app-store.yml': 'xcode-archive',
    'godot-deploy-app-store.yml': 'xcode-archive',
    'rn-deploy-ait.yml': 'ait',
    'godot-deploy-ait.yml': 'ait',
  };

  for (const [name, kind] of Object.entries(readback)) {
    const text = workflowText(name);
    assert.match(
      text,
      /node \.seorilabs-release-authority\/scripts\/release\/verify-release-artifact\.mjs/u,
      name,
    );
    assert.match(text, new RegExp(`--kind ${kind}`, 'u'), name);

    if (kind === 'android-app-bundle') {
      assert.match(
        text,
        /unzip -p "\$AAB_PATH" base\/manifest\/AndroidManifest\.xml > "\$RUNNER_TEMP\/aab-manifest\.pb"/u,
        name,
      );
      // aapt2 dump는 AAB 컨테이너를 인식하지 못하므로 실행 라인에 남아 있으면 안 된다.
      assert.doesNotMatch(text, /^\s*[^#\s][^\n]*aapt2[^\n]*dump/mu, name);
    }
    if (kind === 'xcode-archive') {
      assert.match(text, /plutil -convert json -o "\$RUNNER_TEMP\/archive-info\.json"/u, name);
    }
    if (kind === 'ait') {
      assert.match(text, /DEPLOY_MEMO: \$\{\{ steps\.provenance\.outputs\.release_memo \}\}/u, name);
      assert.doesNotMatch(text, /GitHub Actions \$\{DEPLOY_REF\}/u, name);
    }
  }
});

test('RN Play build는 Backoffice가 관리하는 선택적 Play Games public binding을 보존한다', () => {
  const workflow = workflowText('rn-deploy-google-play.yml');
  const definition = parse(workflow);
  const build = definition.jobs['build-aab'].steps.find(
    ({ name }) => name === 'Build signed Android AAB',
  );
  assert.equal(build.env.PLAY_GAMES_PROJECT_ID, '${{ vars.PLAY_GAMES_PROJECT_ID }}');
  assert.equal(build.env.PLAY_GAMES_LEADERBOARD_ID, '${{ vars.PLAY_GAMES_LEADERBOARD_ID }}');
  assert.match(build.run, /-PversionNameOverride="\$APP_VERSION_NAME"/u);
  assert.match(build.run, /-PversionCodeOverride="\$APP_VERSION_CODE"/u);
});

test('Godot 릴리즈 경로는 명시된 preset 하나에만 태그 파생 버전을 주입한다', () => {
  // 주입 대상 preset과 export 대상 preset이 같은 변수여야 다른 preset을 덮어쓰지 않는다.
  const androidWorkflow = workflowText('godot-deploy-google-play.yml');
  assert.match(
    androidWorkflow,
    /apply-godot-export-version\.mjs \\\n            --platform Android \\\n            --preset "\$ANDROID_EXPORT_PRESET" \\\n            --presets "\$PROJECT_DIR\/export_presets\.cfg"/u,
  );
  assert.match(
    androidWorkflow,
    /--export-release "\$ANDROID_EXPORT_PRESET"/u,
  );
  assert.match(androidWorkflow, /ANDROID_EXPORT_PRESET: \$\{\{ inputs\.android_export_preset \}\}/u);

  const iosWorkflow = workflowText('godot-deploy-app-store.yml');
  assert.match(
    iosWorkflow,
    /apply-godot-export-version\.mjs \\\n            --platform iOS \\\n            --preset "\$IOS_EXPORT_PRESET" \\\n            --presets "\$PROJECT_DIR\/export_presets\.cfg"/u,
  );
  assert.match(iosWorkflow, /--export-release "\$IOS_EXPORT_PRESET"/u);
});

test('릴리즈 업로드는 검증한 파일 하나만 올린다', () => {
  for (const name of ['rn-deploy-google-play.yml', 'godot-deploy-google-play.yml']) {
    const workflow = workflowText(name);
    const bind = extractRunBlock(workflow, 'Bind the verified AAB as the only upload candidate');
    assert.match(bind, /sha256sum "\$VERIFIED_AAB_PATH"/u, name);
    assert.match(bind, /\$observed" = "\$VERIFIED_AAB_DIGEST/u, name);
    assert.match(bind, /-maxdepth 1 -type f -name '\*\.aab'/u, name);
    // 업로드 스텝은 검증된 exact 경로만 받는다.
    assert.match(workflow, /--aab-path "\$VERIFIED_AAB_PATH"/u, name);
    assert.match(
      workflow,
      /SEORI_EXPECTED_AAB_SHA256: \$\{\{ steps\.provenance\.outputs\.artifact_digest \}\}/u,
      name,
    );
  }

  for (const name of ['rn-deploy-ait.yml', 'godot-deploy-ait.yml']) {
    const workflow = workflowText(name);
    const bind = extractRunBlock(workflow, 'Bind the verified .ait as the only upload candidate');
    assert.match(bind, /sha256sum "\$VERIFIED_AIT_PATH"/u, name);
    assert.match(bind, /\$observed" = "\$VERIFIED_AIT_DIGEST/u, name);
    assert.match(bind, /-maxdepth 1 -type f -name '\*\.ait'/u, name);
    // AppsInToss 배포 memo는 artifact digest를 담은 canonical memo 하나뿐이다.
    assert.match(workflow, /DEPLOY_MEMO: \$\{\{ steps\.provenance\.outputs\.release_memo \}\}/u, name);
    assert.match(workflow, /--receipt "\$RUNNER_TEMP\/release-artifact-receipt\.txt"/u, name);
  }
});

test('마켓 업로드와 트랙 승격은 태그 파생 exact versionCode를 넘긴다', () => {
  for (const name of ['rn-deploy-google-play.yml', 'godot-deploy-google-play.yml']) {
    const workflow = workflowText(name);
    const stepName = name.startsWith('rn-') ? 'Upload AAB to Google Play' : 'Upload to Google Play';
    const upload = extractRunBlock(workflow, stepName);
    // 업로드 직전에 검증한 파일 그대로인지 다시 본다(post-export/readiness 이후 값).
    assert.match(upload, /sha256sum "\$VERIFIED_AAB_PATH"/u, name);
    assert.match(upload, /\$observed" = "\$SEORI_EXPECTED_AAB_SHA256/u, name);
    // uploader가 요구하는 태그 파생 versionCode를 넘기고, 비어 있으면 업로드하지 않는다.
    assert.match(
      workflow,
      /SEORI_EXPECTED_ANDROID_VERSION_CODE: \$\{\{ steps\.release\.outputs\.android_version_code \}\}/u,
      name,
    );
    assert.match(upload, /SEORI_EXPECTED_ANDROID_VERSION_CODE" =~ \^\[1-9\]\[0-9\]\*\$/u, name);
    assert.match(upload, /--aab-path "\$VERIFIED_AAB_PATH"/u, name);
    assert.match(upload, /--expected-aab-sha256 "\$SEORI_EXPECTED_AAB_SHA256"/u, name);
    assert.match(upload, /--expected-version-code "\$SEORI_EXPECTED_ANDROID_VERSION_CODE"/u, name);
    assert.match(upload, /--package-name "\$VERIFIED_PACKAGE_NAME"/u, name);
    assert.match(
      upload,
      /python3 \.seorilabs-release-authority\/scripts\/release\/upload-google-play-aab\.py/u,
      name,
    );
    assert.match(upload, /VERIFIED_PACKAGE_NAME" = "\$EXPECTED_PACKAGE_NAME/u, name);
    assert.doesNotMatch(upload, /scripts\/upload-google-play|tools\/upload_google_play/u, name);
  }

  const rnDefinition = parse(workflowText('rn-deploy-google-play.yml'));
  const godotDefinition = parse(workflowText('godot-deploy-google-play.yml'));
  assert.equal(Object.hasOwn(rnDefinition.on.workflow_call.inputs, 'upload_script'), false);
  assert.equal(rnDefinition.on.workflow_call.inputs.package_name.default, '');
  assert.equal(godotDefinition.on.workflow_call.inputs.package_name.default, '');

  // 트랙 승격은 트랙의 최신 build가 아니라 태그가 정한 build 하나만 올린다.
  const promote = workflowText('promote-google-play.yml');
  const promoteBlock = extractRunBlock(promote, 'Promote track');
  assert.match(promoteBlock, /--promote-version-code "\$PROMOTE_VERSION_CODE"/u);
  assert.match(promoteBlock, /PROMOTE_VERSION_CODE" =~ \^\[1-9\]\[0-9\]\*\$/u);
  assert.match(
    promote,
    /PROMOTE_VERSION_CODE: \$\{\{ steps\.release\.outputs\.android_version_code \}\}/u,
  );
  // 승격도 org 정본 authority를 exact SHA로 받아 태그에서 파생한다.
  assert.match(promote, /EXPECTED_WORKFLOW_PATH: seorilabs\/\.github\/\.github\/workflows\/promote-google-play\.yml/u);
  assert.match(promote, /resolve-release-version\.mjs --github-output/u);
  assert.doesNotMatch(promote, /--sort=-v:refname/u);
});

test('중앙 Google Play uploader는 repo config 없이 exact AAB digest와 공개 identity를 검증한다', () => {
  const source = readFileSync(PLAY_UPLOAD_CLI, 'utf8');
  assert.doesNotMatch(source, /google-play\.config\.json|package\.json|resolve-release-version/u);
  assert.match(source, /uploaded_version_code != validated\["expectedVersionCode"\]/u);
  assert.match(source, /GOOGLE_PLAY_VERSION_CODE_MISMATCH/u);
  assert.match(source, /google\.auth\.default\(scopes=\[ANDROID_PUBLISHER_SCOPE\]\)/u);

  const syntax = spawnSync(
    'python3',
    ['-c', 'compile(open(__import__("sys").argv[1], encoding="utf-8").read(), __import__("sys").argv[1], "exec")', PLAY_UPLOAD_CLI],
    { encoding: 'utf8' },
  );
  assert.equal(syntax.status, 0, syntax.stderr);

  const root = mkdtempSync(join(tmpdir(), 'central-play-uploader-'));
  try {
    const aab = join(root, 'verified.aab');
    const bytes = Buffer.from('verified-central-aab-fixture', 'utf8');
    writeFileSync(aab, bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const probe = [
      'import argparse, importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("central_uploader", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'args = argparse.Namespace(package_name="im.seorilabs.cyclepair", track="internal", release_name="1.0.5", release_status="draft", expected_version_code=1001000005, expected_aab_sha256=sys.argv[3], aab_path=sys.argv[2], release_notes_json="")',
      'result = module.validate_upload(args)',
      'result["aabPath"] = str(result["aabPath"])',
      'print(json.dumps(result, sort_keys=True))',
    ].join('; ');
    const valid = spawnSync('python3', ['-c', probe, PLAY_UPLOAD_CLI, aab, digest], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    assert.equal(valid.status, 0, valid.stderr);
    const result = JSON.parse(valid.stdout);
    assert.equal(result.packageName, 'im.seorilabs.cyclepair');
    assert.equal(result.expectedVersionCode, 1_001_000_005);
    assert.equal(result.aabPath, realpathSync(aab));

    const invalid = spawnSync('python3', ['-c', probe, PLAY_UPLOAD_CLI, aab, '0'.repeat(64)], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    assert.notEqual(invalid.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AppsInToss 배포는 검증한 exact 파일 경로를 CLI에 넘기고 API key를 job 전체에 두지 않는다', () => {
  for (const name of ['rn-deploy-ait.yml', 'godot-deploy-ait.yml']) {
    const workflow = workflowText(name);
    const definition = parse(workflow);
    const job = Object.values(definition.jobs)[0];
    // 시크릿은 job 전체가 아니라 검증·배포 step에만 노출한다.
    assert.equal(Object.hasOwn(job.env ?? {}, 'APPS_IN_TOSS_API_KEY'), false, name);
    const secretSteps = job.steps
      .filter((step) => Object.hasOwn(step.env ?? {}, 'APPS_IN_TOSS_API_KEY'))
      .map(({ name: stepName }) => stepName);
    assert.deepEqual(secretSteps, ['Validate AppsInToss secret', 'Deploy to AppsInToss'], name);

    const deploy = extractRunBlock(workflow, 'Deploy to AppsInToss');
    // CLI가 디렉터리에서 다른 번들을 고르지 못하도록 absolute path를 명시한다.
    assert.match(deploy, /--location "\$artifact"/u, name);
    assert.match(deploy, /artifact="\$\(cd "\$GITHUB_WORKSPACE"/u, name);
    // 호출 직전에 digest를 다시 대조한다.
    assert.match(deploy, /sha256sum "\$artifact"/u, name);
    assert.match(deploy, /\$observed" = "\$VERIFIED_AIT_DIGEST/u, name);
  }
});

test('릴리즈 경로는 최소 권한과 승인된 러너 라우팅을 유지한다', () => {
  // 권한 있는 job의 러너는 caller 입력을 그대로 쓰지 않는다. 승인된 라벨만 허용한다.
  const approvedRunners = new Set([
    'seorilabs-rpi-arm64',
    'seorilabs-x64-android',
    'ubuntu-latest',
    'macos-26',
    "${{ (inputs.runs_on == 'ubuntu-latest' && 'ubuntu-latest') || 'seorilabs-rpi-arm64' }}",
  ]);
  const marketPermissions = {
    'rn-deploy-google-play.yml': { contents: 'read', 'id-token': 'write', packages: 'read' },
    'godot-deploy-google-play.yml': { contents: 'read', 'id-token': 'write' },
    'rn-deploy-app-store.yml': { contents: 'read', packages: 'read' },
    'godot-deploy-app-store.yml': { contents: 'read' },
    'rn-deploy-ait.yml': { contents: 'read', packages: 'read' },
    'godot-deploy-ait.yml': { contents: 'read' },
    'rn-build-android.yml': { contents: 'read' },
  };

  for (const name of RELEASE_WORKFLOWS) {
    const workflow = parse(workflowText(name));
    assert.deepEqual(workflow.permissions, marketPermissions[name], name);
    assert.equal(workflow.permissions.contents, 'read', name);
    assert.equal(workflow.permissions['contents-write'], undefined, name);

    for (const job of Object.values(workflow.jobs)) {
      assert.ok(approvedRunners.has(job['runs-on']), `${name}: ${job['runs-on']}`);
    }
  }

  // 태그 생성만 contents:write를 갖는다.
  // 태그를 push하는 job과 마켓 자격증명을 쓰는 job은 러너를 중앙에서 고정한다.
  const releaseTag = parse(workflowText('release-tag.yml'));
  assert.deepEqual(releaseTag.permissions, { contents: 'write' });
  assert.equal(releaseTag.jobs.create['runs-on'], 'seorilabs-rpi-arm64');
  const resolveTagStep = releaseTag.jobs.create.steps.find(
    (step) => step.name === 'Resolve and create tag',
  );
  assert.equal(resolveTagStep.env.RELEASE_EVENT_NAME, '${{ github.event_name }}');
  assert.equal(resolveTagStep.env.RELEASE_EVENT_REF, '${{ github.ref }}');
  assert.equal(resolveTagStep.env.RELEASE_EVENT_SHA, '${{ github.sha }}');
  const godotPlay = parse(workflowText('godot-deploy-google-play.yml'));
  assert.equal(godotPlay.jobs['build-aab']['runs-on'], 'seorilabs-x64-android');
  for (const [name, definition] of [
    ['release-tag.yml', releaseTag],
    ['godot-deploy-google-play.yml', godotPlay],
  ]) {
    // caller가 러너를 고를 수 없도록 입력 자체를 없앴다.
    assert.equal(
      Object.hasOwn(definition.on.workflow_call.inputs ?? {}, 'runs_on'),
      false,
      name,
    );
    assert.doesNotMatch(workflowText(name), /inputs\.runs_on/u, name);
  }

  // runs_on을 남긴 나머지 권한 workflow는 승인된 라벨로만 라우팅한다.
  for (const name of ['cleanup-actions-storage.yml', 'godot-pages.yml']) {
    const text = workflowText(name);
    assert.doesNotMatch(text, /runs-on: \$\{\{ inputs\.runs_on \}\}/u, name);
    assert.match(text, /- name: Reject unapproved runner routing/u, name);
  }
});

test('authority 계약이 파생 규칙과 금지된 authority를 기계 판독으로 고정한다', () => {
  const contract = parse(readFileSync(AUTHORITY_CONTRACT, 'utf8'));

  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.id, AUTHORITY_ID);
  assert.equal(contract.authority.source, 'github-release-tag');
  assert.equal(contract.authority.prereleaseAllowed, false);
  assert.equal(contract.authority.buildsExactTagCommit, true);
  assert.equal(contract.derivation.displayVersion, 'tag-without-v-prefix');
  assert.equal(contract.derivation.marketingVersion, 'tag-without-v-prefix');
  assert.equal(contract.derivation.segmentBase, 1000);
  assert.equal(contract.derivation.encodedVersionFormula, 'major * 1000000 + minor * 1000 + patch');
  assert.equal(contract.derivation.androidVersionCodeEpoch, 1_000_000_000);
  assert.equal(
    contract.derivation.androidVersionCodeFormula,
    'androidVersionCodeEpoch + encodedVersion',
  );
  assert.equal(contract.derivation.appleBuildNumber, 'encoded-version');
  assert.equal(contract.derivation.bounds.majorMax, 1099);
  assert.equal(contract.derivation.bounds.versionCodeMax, 2_100_000_000);

  const tagPattern = new RegExp(contract.authority.tagPattern, 'u');
  assert.equal(tagPattern.test('v1.2.3'), true);
  for (const invalid of ['1.2.3', 'v1.2', 'v01.2.3', 'v1.2.3-rc.1', 'v1.2.3+build.7']) {
    assert.equal(tagPattern.test(invalid), false, invalid);
  }

  assert.deepEqual(
    contract.forbiddenAuthorities.map(({ id }) => id).sort(),
    [
      'godot-project-version',
      'gradle-version',
      'granite-config-version',
      'market-config-json-version',
      'non-deterministic-build-counter',
      'package-json-version',
      'repository-local-release-version-resolver',
      'workflow-caller-version-input',
      'xcode-version',
    ],
  );
  assert.deepEqual(
    contract.failClosed.map(({ id }) => id).sort(),
    [
      'ait-internal-version-field-present',
      'artifact-digest-mismatch',
      'artifact-provenance-mismatch',
      'config-revision-mismatch',
      'derived-version-code-out-of-range',
      'forbidden-authority-override',
      'godot-preset-selector-ambiguous',
      'godot-preset-selector-mismatch',
      'godot-preset-selector-required',
      'source-sha-mismatch',
      'tag-pattern-mismatch',
      'tag-ref-mismatch',
      'tag-reuse-with-different-config',
      'tag-reuse-with-different-source',
    ],
  );
  // 마켓 최소 versionCode. v0.0.0은 어떤 artifact도 만들 수 없다.
  assert.equal(contract.derivation.bounds.versionCodeMin, 1);
  // .ait 형식 계약: 내부 version 필드가 없고 memo가 artifact digest를 담는다.
  assert.deepEqual(contract.artifactReadback.ait.supportedFormats, ['ait', 'zip']);
  assert.equal(contract.artifactReadback.ait.internalVersionField, 'none');
  assert.equal(contract.artifactReadback.ait.onInternalVersionFieldObserved, 'fail-closed');
  assert.equal(
    contract.artifactReadback.ait.fields.memo,
    'canonical-release-memo-with-artifact-digest',
  );
  assert.ok(contract.artifactReadback.ait.memoFields.includes('artifact-sha256'));
  // 업로드 결속과 preset 선택자 정책.
  assert.equal(contract.uploadBinding.passVerifiedArtifactPath, true);
  assert.equal(contract.uploadBinding.reverifyDigestBeforeUpload, true);
  assert.equal(contract.uploadBinding.singleCandidateInArtifactDirectory, true);
  assert.deepEqual(contract.uploadBinding.arguments, {
    'android-app-bundle': '--aab-path',
    ait: '--location',
    promote: '--promote-version-code',
  });
  assert.deepEqual(contract.uploadBinding.expectedEnvironment, [
    'SEORI_EXPECTED_AAB_SHA256',
    'SEORI_EXPECTED_ANDROID_VERSION_CODE',
  ]);
  // 트랙 승격은 트랙 최신 build가 아니라 태그가 정한 versionCode만 올린다.
  assert.equal(contract.trackPromotion.versionCodeSource, 'release-tag-derived');
  assert.equal(contract.trackPromotion.promotesLatestInTrack, false);
  assert.equal(contract.trackPromotion.requiredArgument, '--promote-version-code');
  // 태그 선택은 실행 이벤트에 묶인다.
  assert.equal(contract.authority.tagSelection.eventTagRef, 'pinned-to-event-ref-and-event-sha');
  assert.equal(contract.authority.tagSelection.latestStableFallback, 'workflow-dispatch-only');
  assert.deepEqual(contract.authority.tagSelection.sources, RELEASE_TAG_SOURCES);
  // .ait framing은 exact length로 검증하고 zip entry는 central directory에서 읽는다.
  assert.equal(contract.artifactReadback.ait.framing.exactLengthRequired, true);
  assert.equal(contract.artifactReadback.ait.framing.zeroTrailerRequired, true);
  assert.equal(contract.artifactReadback.ait.framing.zipEntrySource, 'central-directory');
  assert.deepEqual(contract.artifactReadback.ait.framing.layout, [
    'magic-8',
    'format-version-4',
    'protobuf-length-8',
    'protobuf',
    'zip-length-8',
    'zip-payload',
    'zero-trailer-8',
  ]);
  assert.equal(contract.godotExportPreset.selector, 'explicit-preset-name-or-index');
  assert.equal(contract.godotExportPreset.ambiguousSelector, 'fail-closed');
  // WorkflowBundle v5 정본 경로도 같은 authority를 쓴다.
  assert.deepEqual(contract.workflowBundleV5.calledWorkflows.sort(), [
    '.github/workflows/ait-build-only-v1.yml',
    '.github/workflows/godot-build-android-cloud-v2.yml',
    '.github/workflows/rn-build-android-cloud-v2.yml',
  ]);
  assert.equal(contract.workflowBundleV5.bindingMode, 'RELEASE');
  assert.equal(contract.workflowBundleV5.requiresApprovedBundle, true);
  const releaseRefPattern = new RegExp(contract.workflowBundleV5.releaseRefPattern, 'u');
  assert.equal(releaseRefPattern.test('refs/tags/v1.2.3'), true);
  for (const invalid of ['refs/heads/main', 'refs/tags/v1.2.3-rc.1', 'refs/tags/release/v1.2.3']) {
    assert.equal(releaseRefPattern.test(invalid), false, invalid);
  }
  assert.deepEqual(contract.artifactReceipt.digestSource, {
    'android-app-bundle': 'artifact-file',
    ait: 'artifact-file',
    'xcode-archive': 'archive-info-plist',
  });
  assert.deepEqual(Object.keys(contract.artifactReadback).sort(), ['ait', 'android-app-bundle', 'xcode-archive']);
  assert.equal(contract.artifactReadback['android-app-bundle'].tool, 'aab-proto-manifest');
  assert.equal(
    contract.artifactReadback['android-app-bundle'].manifestPath,
    'base/manifest/AndroidManifest.xml',
  );
  // 이미 있는 태그도 파생값 검증을 먼저 통과해야 idempotent success다.
  assert.equal(
    contract.tagCreation.existingTag.sameCommit,
    'verify-derivation-then-idempotent-success',
  );
  assert.equal(contract.tagCreation.existingTag.receiptPresent, 'exact-match-required');
  assert.equal(contract.tagCreation.existingTag.receiptAbsent, 'tag-and-commit-are-authority');
  assert.equal(contract.tagCreation.existingTag.differentCommit, 'fail-closed');
  assert.equal(contract.binding.tagReceiptMarker, 'seori-release-binding: 1');
  assert.deepEqual(contract.binding.tagReceiptFields, [
    'authority',
    'authority-revision',
    'tag',
    'source-sha',
    'version-name',
    'android-version-code',
    'apple-build-number',
  ]);
  assert.deepEqual(contract.binding.authorityRevision.inputs, ['authorityContractBody']);
  assert.deepEqual(contract.binding.configRevision.inputs, [
    'calledWorkflowRepository',
    'calledWorkflowRef',
    'calledWorkflowSha',
    'authorityRevision',
  ]);
  assert.ok(contract.binding.fields.includes('authorityRevision'));

  // 태그 생성 경계: 운영자가 고른 commit에만, 마커 커밋과 브랜치 push 없이.
  assert.equal(contract.tagCreation.target, 'exact-operator-selected-commit');
  assert.equal(contract.tagCreation.markerCommit, 'forbidden');
  assert.equal(contract.tagCreation.branchPush, 'forbidden');
  assert.equal(contract.tagCreation.tagMove, 'forbidden');
  assert.equal(contract.tagCreation.annotated, true);
});

test('tag receipt는 계약이 선언한 필드만 선언 순서대로 담는다', () => {
  const contract = parse(readFileSync(AUTHORITY_CONTRACT, 'utf8'));
  const lines = renderTagReceipt(binding()).split('\n');
  assert.equal(lines[0], contract.binding.tagReceiptMarker);
  assert.deepEqual(
    lines.slice(1).map((line) => line.split(':', 1)[0]),
    contract.binding.tagReceiptFields,
  );
});

test('authority 구현은 org 번들만으로 실행 가능한 표준 라이브러리 코드다', () => {
  const scripts = [
    'scripts/release/tag-version-authority.mjs',
    'scripts/release/resolve-release-version.mjs',
    'scripts/release/verify-release-artifact.mjs',
    'scripts/release/apply-godot-export-version.mjs',
  ];

  for (const script of scripts) {
    const source = readFileSync(resolve(REPOSITORY_ROOT, script), 'utf8');
    for (const specifier of source.matchAll(/^import[^;]*?from '([^']+)';$/gmu)) {
      const target = specifier[1];
      assert.ok(
        target.startsWith('node:') || target.startsWith('./'),
        `${script}: 외부 의존성 ${target}을 쓸 수 없다`,
      );
    }
    assert.doesNotMatch(source, /require\(/u, script);
  }

  assert.equal(dirname(RESOLVE_CLI), dirname(VERIFY_CLI));
});
