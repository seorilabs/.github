// GitHub 릴리즈 태그를 모든 지원 마켓 artifact의 유일한 version source of truth로 고정하는
// 계약을 검증한다. 라이브러리 규칙, CLI 계약, fixture readback, 워크플로우 배선을 함께 본다.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import {
  AUTHORITY_ID,
  ReleaseAuthorityError,
  applyGodotExportVersion,
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
  parseInfoPlistJson,
  parseReleaseBinding,
  parseTagReceipt,
  readAitContainer,
  renderTagReceipt,
  selectLatestStableTag,
} from '../scripts/release/tag-version-authority.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = resolve(REPOSITORY_ROOT, 'fixtures/release-version-authority');
const RESOLVE_CLI = resolve(REPOSITORY_ROOT, 'scripts/release/resolve-release-version.mjs');
const VERIFY_CLI = resolve(REPOSITORY_ROOT, 'scripts/release/verify-release-artifact.mjs');
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
  };
}

test('태그에서 display version과 deterministic build number를 파생한다', () => {
  const cases = [
    ['v0.1.0', '0.1.0', 1000],
    ['v1.0.0', '1.0.0', 1_000_000],
    ['v1.2.3', '1.2.3', 1_002_003],
    ['v2.0.5', '2.0.5', 2_000_005],
    ['v0.1.2', '0.1.2', 1002],
    ['v1.999.999', '1.999.999', 1_999_999],
  ];

  for (const [tag, versionName, buildNumber] of cases) {
    const version = deriveReleaseVersion(tag);
    assert.equal(version.versionName, versionName, tag);
    assert.equal(version.displayVersion, versionName, tag);
    assert.equal(version.appleMarketingVersion, versionName, tag);
    assert.equal(version.releaseName, versionName, tag);
    assert.equal(version.androidVersionCode, buildNumber, tag);
    assert.equal(version.appleBuildNumber, buildNumber, tag);
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
  assert.equal(receipt.androidVersionCode, '1002003');
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
  assert.deepEqual(rnManifest, { versionName: '1.2.3', versionCode: 1_002_003 });
  assert.doesNotThrow(() =>
    assertArtifactVersion({ kind: 'android-app-bundle', binding: rn, observed: rnManifest }),
  );

  // package.json을 authority로 삼은 빌드는 태그와 어긋난다.
  const leaked = parseAabManifest(
    readFileSync(join(FIXTURES, 'react-native/android/aab-manifest-package-json-authority.pb')),
  );
  assert.deepEqual(leaked, { versionName: '0.9.3', versionCode: 903_000 });
  assert.throws(
    () => assertArtifactVersion({ kind: 'android-app-bundle', binding: rn, observed: leaked }),
    (error) => error.code === 'artifact-provenance-mismatch',
  );

  const godot = binding({ tag: 'v2.0.5', workflow: 'godot-deploy-google-play.yml' });
  const godotManifest = parseAabManifest(readFileSync(join(FIXTURES, 'godot/android/aab-manifest.pb')));
  assert.deepEqual(godotManifest, { versionName: '2.0.5', versionCode: 2_000_005 });
  assert.doesNotThrow(() =>
    assertArtifactVersion({ kind: 'android-app-bundle', binding: godot, observed: godotManifest }),
  );

  // 실제 Godot 빌드에서 추출한 manifest. export preset 값이 태그와 무관하게 남아 있는 상태다.
  const configJson = parseAabManifest(
    readFileSync(join(FIXTURES, 'godot/android/aab-manifest-config-json-authority.pb')),
  );
  assert.deepEqual(configJson, { versionName: '0.1.0', versionCode: 1 });
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

test('.ait 컨테이너를 읽고 배포 memo를 태그에서 파생한 canonical 값으로 고정한다', () => {
  const rn = readAitContainer(readFileSync(join(FIXTURES, 'react-native/ait/trait-test-hub.ait')));
  assert.equal(rn.format, 'ait');
  assert.equal(rn.formatVersion, 1);
  assert.equal(rn.appName, 'trait-test-hub');
  assert.match(rn.deploymentId, /^[0-9a-f-]{36}$/u);

  const godot = readAitContainer(readFileSync(join(FIXTURES, 'godot/ait/foam-party.ait')));
  assert.equal(godot.format, 'zip');

  assert.throws(
    () => readAitContainer(Buffer.from('not a bundle at all')),
    (error) => error.code === 'artifact-provenance-mismatch',
  );

  const current = binding({ workflow: 'rn-deploy-ait.yml' });
  const memo = canonicalReleaseMemo(current);
  assert.equal(memo, `v1.2.3 1.2.3 (1002003) ${SHA_A.slice(0, 12)}`);
  assert.equal(canonicalReleaseMemo(current, ' hotfix  rollout '), `${memo} · hotfix rollout`);
  assert.ok(canonicalReleaseMemo(current, 'x'.repeat(2000)).length <= 1000);

  const digest = createHash('sha256').update('artifact').digest('hex');
  assert.doesNotThrow(() =>
    assertArtifactVersion({ kind: 'ait', binding: current, observed: { memo, digest } }),
  );
  assert.throws(
    () =>
      assertArtifactVersion({
        kind: 'ait',
        binding: current,
        observed: { memo: 'GitHub Actions main@abc1234', digest },
      }),
    (error) => error.code === 'artifact-provenance-mismatch',
  );
  assert.throws(
    () => assertArtifactVersion({ kind: 'ait', binding: current, observed: { memo, digest: 'nope' } }),
    (error) => error.code === 'artifact-provenance-mismatch',
  );
});

test('Godot export preset은 authority가 아니라 태그 파생값 주입 대상이다', () => {
  const presets = readFileSync(join(FIXTURES, 'godot/export_presets.cfg'), 'utf8');
  const current = binding({ tag: 'v2.0.5', workflow: 'godot-deploy-google-play.yml' });

  const android = applyGodotExportVersion(presets, { platform: 'Android', binding: current });
  assert.match(android, /^version\/code=2000005$/mu);
  assert.match(android, /^version\/name="2\.0\.5"$/mu);
  assert.doesNotMatch(android, /^version\/code=3$/mu);

  const ios = applyGodotExportVersion(android, { platform: 'iOS', binding: current });
  assert.match(ios, /^application\/short_version="2\.0\.5"$/mu);
  assert.match(ios, /^application\/version="2000005"$/mu);
  // 다른 preset의 값은 건드리지 않는다.
  assert.match(ios, /^package\/unique_name="im\.seorilabs\.foamparty"$/mu);
  assert.equal(ios.split('\n').length, presets.split('\n').length);

  assert.throws(
    () => applyGodotExportVersion(presets, { platform: 'macOS', binding: current }),
    (error) => error.code === 'artifact-provenance-mismatch',
  );
  assert.throws(
    () => applyGodotExportVersion('[preset.0]\n\nplatform="Android"\n', { platform: 'Android', binding: current }),
    (error) => error.code === 'artifact-provenance-mismatch',
  );
  assert.throws(
    () =>
      applyGodotExportVersion(
        '[preset.0]\n\nplatform="Android"\n\n[preset.0.options]\n\npackage/name="x"\n',
        { platform: 'Android', binding: current },
      ),
    (error) => error.code === 'artifact-provenance-mismatch',
  );
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
    assert.equal(readFileSync(outputPath, 'utf8'), `${githubOutputLines(expected).join('\n')}\n`);
    assert.match(readFileSync(outputPath, 'utf8'), /^version_name=1\.2\.3$/mu);
    assert.match(readFileSync(outputPath, 'utf8'), /^android_version_code=1002003$/mu);
    assert.match(readFileSync(outputPath, 'utf8'), /^apple_build_number=1002003$/mu);
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

    const cases = [
      ['android-app-bundle', rnBinding, 'react-native/android/aab-manifest.pb', true],
      ['android-app-bundle', rnBinding, 'react-native/android/aab-manifest-package-json-authority.pb', false],
      ['android-app-bundle', godotBinding, 'godot/android/aab-manifest.pb', true],
      ['android-app-bundle', godotBinding, 'godot/android/aab-manifest-config-json-authority.pb', false],
      ['xcode-archive', rnBinding, 'react-native/ios/info-plist.json', true],
      ['xcode-archive', rnBinding, 'react-native/ios/info-plist-run-number-build.json', false],
      ['xcode-archive', godotBinding, 'godot/ios/info-plist.json', true],
      ['xcode-archive', godotBinding, 'godot/ios/info-plist-godot-project-authority.json', false],
    ];

    for (const [kind, bindingPath, fixture, shouldPass] of cases) {
      const result = runNode(VERIFY_CLI, [
        '--kind',
        kind,
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
    assert.match(aitOutput, /^ait_format=ait$/mu);
    assert.match(aitOutput, /^release_memo=v1\.2\.3 1\.2\.3 \(1002003\) a{12} · internal rollout$/mu);
    assert.match(
      aitOutput,
      new RegExp(`^artifact_digest=${createHash('sha256').update(readFileSync(aitArtifact)).digest('hex')}$`, 'mu'),
    );

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
    assert.match(wrongMemo.stderr, /artifact-provenance-mismatch/u);
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

    for (const platform of ['Android', 'iOS']) {
      const result = runNode(GODOT_CLI, ['--binding', bindingPath, '--platform', platform, '--presets', presetsPath]);
      assert.equal(result.status, 0, result.stderr);
    }

    const patched = readFileSync(presetsPath, 'utf8');
    assert.match(patched, /^version\/code=2000005$/mu);
    assert.match(patched, /^version\/name="2\.0\.5"$/mu);
    assert.match(patched, /^application\/short_version="2\.0\.5"$/mu);
    assert.match(patched, /^application\/version="2000005"$/mu);
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

  const runTagBlock = (cwd, releaseTag) => {
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

test('Godot 릴리즈 경로는 export preset에 태그 파생 버전을 주입한다', () => {
  const androidWorkflow = workflowText('godot-deploy-google-play.yml');
  assert.match(
    androidWorkflow,
    /apply-godot-export-version\.mjs \\\n            --platform Android \\\n            --presets "\$PROJECT_DIR\/export_presets\.cfg"/u,
  );

  const iosWorkflow = workflowText('godot-deploy-app-store.yml');
  assert.match(
    iosWorkflow,
    /apply-godot-export-version\.mjs \\\n            --platform iOS \\\n            --presets "\$PROJECT_DIR\/export_presets\.cfg"/u,
  );
});

test('릴리즈 경로는 최소 권한과 승인된 러너 라우팅을 유지한다', () => {
  const approvedRunners = new Set([
    'seorilabs-rpi-arm64',
    'ubuntu-latest',
    'macos-26',
    '${{ inputs.runs_on }}',
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
  const releaseTag = parse(workflowText('release-tag.yml'));
  assert.deepEqual(releaseTag.permissions, { contents: 'write' });
  assert.equal(releaseTag.jobs.create['runs-on'], '${{ inputs.runs_on }}');
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
  assert.equal(contract.derivation.buildNumberFormula, 'major * 1000000 + minor * 1000 + patch');
  assert.equal(contract.derivation.androidVersionCode, 'build-number');
  assert.equal(contract.derivation.appleBuildNumber, 'build-number');
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
      'artifact-provenance-mismatch',
      'config-revision-mismatch',
      'forbidden-authority-override',
      'source-sha-mismatch',
      'tag-pattern-mismatch',
      'tag-ref-mismatch',
      'tag-reuse-with-different-config',
      'tag-reuse-with-different-source',
    ],
  );
  assert.deepEqual(Object.keys(contract.artifactReadback).sort(), ['ait', 'android-app-bundle', 'xcode-archive']);
  assert.equal(contract.artifactReadback['android-app-bundle'].tool, 'aab-proto-manifest');
  assert.equal(
    contract.artifactReadback['android-app-bundle'].manifestPath,
    'base/manifest/AndroidManifest.xml',
  );
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
