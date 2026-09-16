// release-tag.yml의 할당·태그 생성 블록을 실제 git 저장소에서 실행해 동작을 고정한다.
// 핵심 계약: 운영자가 고른 exact source commit에만 태그를 달고, Android versionCode는
// 저장소 원장이 lastVersionCode + 1로 할당하며, 원장 갱신과 태그 생성이 한 번의 atomic push로
// 함께 반영되거나 함께 반영되지 않는다.
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { parseTagReceipt } from '../scripts/release/tag-version-authority.mjs';
import {
  AUTHORITY_REVISION,
  WORKFLOW,
  createRepository,
  expectedReceipt,
  git,
  initialLedger,
  ledgerCommitCount,
  remoteLedger,
  runCreateTag,
} from './helpers/release-ledger-fixtures.mjs';

test('운영자가 고른 exact source commit에 태그를 달고 앱 커밋이나 브랜치를 만들지 않는다', () => {
  const { root, work, origin } = createRepository();
  try {
    const before = git(work, 'rev-parse', 'HEAD');
    const beforeCount = git(work, 'rev-list', '--count', 'HEAD');
    const beforeRemoteHead = git(work, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0];

    const result = runCreateTag(work, { tagInput: 'v1.2.3' });
    assert.equal(result.status, 0, result.stderr);

    assert.equal(git(work, 'rev-parse', 'refs/tags/v1.2.3^{commit}'), before, '태그는 대상 commit을 가리켜야 한다');
    assert.equal(git(work, 'rev-parse', 'HEAD'), before, '새 커밋을 만들면 안 된다');
    assert.equal(git(work, 'rev-list', '--count', 'HEAD'), beforeCount, '커밋 수가 변하면 안 된다');
    assert.equal(
      git(work, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0],
      beforeRemoteHead,
      'main을 push하면 안 된다',
    );
    assert.equal(
      git(root, 'ls-remote', origin, 'refs/tags/v1.2.3^{}').split('\t')[0],
      before,
      '태그는 원격에 push돼야 한다',
    );
    assert.match(result.output, /^created=true$/mu);
    assert.match(result.output, /^tag=v1\.2\.3$/mu);
    assert.match(result.output, new RegExp(`^sha=${before}$`, 'mu'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('신규 저장소의 첫 Android versionCode는 1이고 태그 숫자와 무관하다', () => {
  const { root, work } = createRepository();
  try {
    const result = runCreateTag(work, { tagInput: 'v1.2.3' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /^android_version_code=1$/mu);

    const receipt = parseTagReceipt(git(work, 'for-each-ref', '--format=%(contents)', 'refs/tags/v1.2.3'));
    assert.equal(receipt.androidVersionCode, '1');
    assert.equal(receipt.androidVersionCodeSource, 'github-ledger');
    // 표시 버전은 여전히 태그 하나가 정본이다.
    assert.equal(receipt.versionName, '1.2.3');
    assert.equal(receipt.appleBuildNumber, '1002003');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('기존 원장 1001000001 다음 할당은 1001000002다', () => {
  // seorilabs/lord-ledger 파일럿의 인수조건이다.
  const seeded = initialLedger({
    baseline: 1_001_000_001,
    sources: [
      {
        kind: 'tag-receipt',
        androidVersionCode: 1_001_000_001,
        tag: 'v1.0.1',
        sourceSha: '81db93800ce5ffee2986523aa6235fa59ccf50b2',
      },
    ],
    lastTag: 'v1.0.1',
    lastSourceSha: '81db93800ce5ffee2986523aa6235fa59ccf50b2',
  });
  const { root, work, origin } = createRepository({ ledger: seeded });
  try {
    const result = runCreateTag(work, { bump: 'patch' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /^tag=v1\.0\.2$/mu);
    assert.match(result.output, /^android_version_code=1001000002$/mu);
    assert.equal(remoteLedger(origin).android.lastVersionCode, 1_001_000_002);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('annotated tag message는 org 정본이 만든 release binding receipt를 담는다', () => {
  const { root, work } = createRepository();
  try {
    const target = git(work, 'rev-parse', 'HEAD');
    const result = runCreateTag(work, { tagInput: 'v1.2.3' });
    assert.equal(result.status, 0, result.stderr);

    assert.equal(git(work, 'cat-file', '-t', 'refs/tags/v1.2.3'), 'tag');
    const message = git(work, 'for-each-ref', '--format=%(contents)', 'refs/tags/v1.2.3');
    const shortSha = git(work, 'rev-parse', '--short', target);
    assert.equal(message, `Release v1.2.3 (${shortSha})\n\n${expectedReceipt(target, 'v1.2.3', 1)}`);

    const receipt = parseTagReceipt(message);
    assert.equal(receipt.tag, 'v1.2.3');
    assert.equal(receipt.sourceSha, target);
    assert.match(receipt.authorityRevision, /^[0-9a-f]{64}$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('원장 갱신과 태그 생성이 한 커밋씩만 반영된다', () => {
  const { root, work, origin } = createRepository();
  try {
    assert.equal(ledgerCommitCount(origin), 1, '초기화 커밋 하나');
    assert.equal(runCreateTag(work, { tagInput: 'v1.0.0' }).status, 0);
    assert.equal(ledgerCommitCount(origin), 2);
    assert.equal(remoteLedger(origin).android.lastVersionCode, 1);
    assert.equal(runCreateTag(work, { tagInput: 'v1.0.1' }).status, 0);
    assert.equal(ledgerCommitCount(origin), 3);
    assert.equal(remoteLedger(origin).android.lastVersionCode, 2);
    assert.equal(remoteLedger(origin).release.lastTag, 'v1.0.1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('target_ref가 브랜치가 아니어도(SHA 지정) 그 commit에 그대로 태그를 단다', () => {
  const { root, work } = createRepository();
  try {
    const pinned = git(work, 'rev-parse', 'HEAD');
    writeFileSync(join(work, 'app.txt'), 'second\n');
    git(work, 'add', 'app.txt');
    git(work, 'commit', '-q', '-m', 'feat: 두 번째 커밋');
    git(work, 'push', '-q', 'origin', 'main');
    const head = git(work, 'rev-parse', 'HEAD');

    const result = runCreateTag(work, { targetRef: pinned, tagInput: 'v2.0.0' });
    assert.equal(result.status, 0, result.stderr);

    assert.equal(git(work, 'rev-parse', 'refs/tags/v2.0.0^{commit}'), pinned);
    assert.equal(git(work, 'rev-parse', 'HEAD'), head, 'HEAD가 움직이면 안 된다');
    assert.equal(parseTagReceipt(git(work, 'for-each-ref', '--format=%(contents)', 'refs/tags/v2.0.0')).sourceSha, pinned);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('같은 태그가 다른 commit에 있으면 태그를 옮기지 않고 원장도 건드리지 않는다', () => {
  const { root, work, origin } = createRepository();
  try {
    const first = git(work, 'rev-parse', 'HEAD');
    git(work, 'tag', 'v1.2.3', first);
    git(work, 'push', '-q', 'origin', 'refs/tags/v1.2.3');
    writeFileSync(join(work, 'app.txt'), 'second\n');
    git(work, 'add', 'app.txt');
    git(work, 'commit', '-q', '-m', 'feat: 두 번째 커밋');
    git(work, 'push', '-q', 'origin', 'main');
    const before = ledgerCommitCount(origin);

    const result = runCreateTag(work, { tagInput: 'v1.2.3' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tag-reuse-with-different-source/u);
    assert.equal(git(work, 'rev-parse', 'refs/tags/v1.2.3^{commit}'), first, '기존 태그가 유지돼야 한다');
    assert.equal(ledgerCommitCount(origin), before, '원장이 움직이면 안 된다');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('같은 태그 재실행은 같은 번호를 반환하고 원장을 이중 증가시키지 않는다', () => {
  const { root, work, origin } = createRepository();
  try {
    const first = runCreateTag(work, { tagInput: 'v1.2.3' });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.output, /^android_version_code=1$/mu);
    const afterFirst = ledgerCommitCount(origin);

    const again = runCreateTag(work, { tagInput: 'v1.2.3' });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.output, /^created=false$/mu);
    assert.equal(ledgerCommitCount(origin), afterFirst, '원장 커밋이 늘면 안 된다');
    assert.equal(remoteLedger(origin).android.lastVersionCode, 1, '번호가 이중 증가하면 안 된다');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('이미 있는 태그도 binding을 먼저 검증한 뒤에만 idempotent 통과한다', () => {
  // 1) 원장 할당 전이라면 receipt 없는 lightweight 태그도 통과한다(legacy 폴백).
  let repository = createRepository();
  try {
    const target = git(repository.work, 'rev-parse', 'HEAD');
    git(repository.work, 'tag', 'v1.2.3', target);
    git(repository.work, 'push', '-q', 'origin', 'refs/tags/v1.2.3');
    const result = runCreateTag(repository.work, { tagInput: 'v1.2.3' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /^created=false$/mu);
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
  }

  // 2) 이미 있는 v0.0.0은 같은 commit이어도 encoded version이 0이라 성공으로 보고하지 않는다.
  repository = createRepository();
  try {
    const target = git(repository.work, 'rev-parse', 'HEAD');
    git(repository.work, 'tag', 'v0.0.0', target);
    git(repository.work, 'push', '-q', 'origin', 'refs/tags/v0.0.0');
    const result = runCreateTag(repository.work, { tagInput: 'v0.0.0' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /derived-version-code-out-of-range/u);
    assert.doesNotMatch(result.output, /^created=/mu);
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
  }

  // 3) 다른 source SHA로 찍힌 receipt를 가진 annotated 태그는 idempotent 통과하지 않는다.
  repository = createRepository();
  try {
    const target = git(repository.work, 'rev-parse', 'HEAD');
    const foreignReceipt = [
      'Release v1.2.3 (deadbee)',
      '',
      'seori-release-binding: 1',
      'authority: release-version-authority-v1',
      `authority-revision: ${AUTHORITY_REVISION}`,
      'tag: v1.2.3',
      `source-sha: ${'d'.repeat(40)}`,
      'version-name: 1.2.3',
      'android-version-code: 7',
      'android-version-code-source: github-ledger',
      'apple-build-number: 1002003',
    ].join('\n');
    git(repository.work, 'tag', '-a', 'v1.2.3', target, '-m', foreignReceipt);
    git(repository.work, 'push', '-q', 'origin', 'refs/tags/v1.2.3');
    const result = runCreateTag(repository.work, { tagInput: 'v1.2.3' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tag-reuse-with-different-source|ledger-receipt-mismatch/u);
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
  }

  // 4) 등록되지 않은 authority 계약 revision으로 찍힌 receipt는 거부한다.
  repository = createRepository();
  try {
    const target = git(repository.work, 'rev-parse', 'HEAD');
    const staleReceipt = [
      'Release v1.2.3',
      '',
      'seori-release-binding: 1',
      'authority: release-version-authority-v1',
      `authority-revision: ${'0'.repeat(64)}`,
      'tag: v1.2.3',
      `source-sha: ${target}`,
      'version-name: 1.2.3',
      'android-version-code: 1001002003',
      'apple-build-number: 1002003',
    ].join('\n');
    git(repository.work, 'tag', '-a', 'v1.2.3', target, '-m', staleReceipt);
    git(repository.work, 'push', '-q', 'origin', 'refs/tags/v1.2.3');
    const result = runCreateTag(repository.work, { tagInput: 'v1.2.3' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tag-reuse-with-different-config/u);
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
  }
});

test('dry_run은 태그를 만들지도 push하지도 않고 원장도 그대로 둔다', () => {
  const { root, work, origin } = createRepository();
  try {
    const target = git(work, 'rev-parse', 'HEAD');
    const before = ledgerCommitCount(origin);
    const result = runCreateTag(work, { tagInput: 'v1.2.3', dryRun: 'true' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /^created=false$/mu);
    assert.match(result.output, /^android_version_code=1$/mu);
    assert.match(result.output, new RegExp(`^sha=${target}$`, 'mu'));
    assert.equal(git(root, 'ls-remote', origin, 'refs/tags/*'), '');
    assert.equal(ledgerCommitCount(origin), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('태그 미지정 시 원장의 마지막 태그에서 bump한다', () => {
  const seeded = initialLedger({
    baseline: 40,
    lastTag: 'v1.2.10',
    lastSourceSha: 'a'.repeat(40),
    sources: [{ kind: 'human-attestation', androidVersionCode: 40 }],
  });
  const { root, work } = createRepository({ ledger: seeded });
  try {
    const target = git(work, 'rev-parse', 'HEAD');
    const result = runCreateTag(work, { bump: 'minor' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /^tag=v1\.3\.0$/mu);
    assert.match(result.output, /^android_version_code=41$/mu);
    assert.equal(git(work, 'rev-parse', 'refs/tags/v1.3.0^{commit}'), target);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('원장 브랜치가 없으면 번호를 추측하지 않고 ledger-missing으로 멈춘다', () => {
  const { root, work, origin } = createRepository({ ledger: null });
  try {
    const result = runCreateTag(work, { tagInput: 'v1.0.0' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ledger-missing/u);
    assert.match(result.stderr, /init-release-version-ledger/u);
    assert.equal(git(root, 'ls-remote', origin, 'refs/tags/*'), '', '태그를 만들면 안 된다');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('versionCode를 파생할 수 없는 태그는 org 정본이 생성 전에 거부한다', () => {
  for (const tagInput of ['v1.1000.0', 'v1.0.1000', 'v2200.0.0']) {
    const { root, work, origin } = createRepository();
    try {
      const result = runCreateTag(work, { tagInput });
      assert.notEqual(result.status, 0, tagInput);
      assert.equal(git(root, 'ls-remote', origin, 'refs/tags/*'), '', tagInput);
      assert.equal(ledgerCommitCount(origin), 1, tagInput);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('워크플로우의 원격 쓰기는 원장과 태그를 함께 올리는 atomic push 하나뿐이다', () => {
  assert.doesNotMatch(WORKFLOW, /--allow-empty/u);
  assert.doesNotMatch(WORKFLOW, /chore\(release\)/u);
  assert.doesNotMatch(WORKFLOW, /git reset --hard/u);
  assert.doesNotMatch(WORKFLOW, /marker/iu);

  const pushes = [...WORKFLOW.matchAll(/^\s*(?:if )?git push [^\n]*/gmu)].map((match) => match[0].trim());
  assert.deepEqual(pushes, ['if git push --atomic --porcelain \\']);
  assert.match(WORKFLOW, /--force-with-lease="refs\/heads\/\$LEDGER_BRANCH:\$ledger_tip"/u);
  assert.match(WORKFLOW, /--force-with-lease="refs\/tags\/\$tag:"/u);
  assert.match(WORKFLOW, /ledger-atomic-push-partial/u);

  // hot path는 전체 태그를 나열하지 않는다.
  assert.doesNotMatch(WORKFLOW, /git tag --list/u);
  assert.doesNotMatch(WORKFLOW, /ls-remote --refs --tags/u);
  assert.doesNotMatch(WORKFLOW, /fetch --force --tags/u);
  assert.match(WORKFLOW, /fetch-depth: 1/u);
  assert.match(WORKFLOW, /fetch-tags: false/u);
  assert.match(WORKFLOW, /concurrency:\n {2}group: release-version-ledger-\$\{\{ github\.repository \}\}/u);
});
