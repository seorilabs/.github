// 릴리스 번호 원장의 동시성·원자성·fail-closed 동작을 실제 git 원격에 대고 고정한다.
// 여기서 확인하는 것은 "번호가 중복되지 않는다"와 "원장과 태그가 함께 반영되거나 함께
// 반영되지 않는다" 두 가지다. 단위 검증은 release-version-authority.test.mjs가 맡는다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  VERSION_CODE_MAX,
  applyAndroidAllocation,
  applyIosObservation,
  parseLedger,
  parseTagReceipt,
  renderLedger,
  resolveDeploymentAndroidVersionCode,
} from '../scripts/release/tag-version-authority.mjs';
import {
  LEDGER_BRANCH,
  LEDGER_FILE,
  WORKFLOW,
  createRepository,
  git,
  initialLedger,
  ledgerCommitCount,
  remoteLedger,
  runCreateTag,
} from './helpers/release-ledger-fixtures.mjs';

/** bare origin에 pre-receive hook을 심어 서버측 거절을 재현한다. */
function installPreReceiveHook(origin, script) {
  const hooks = join(origin, 'hooks');
  mkdirSync(hooks, { recursive: true });
  const path = join(hooks, 'pre-receive');
  writeFileSync(path, script, 'utf8');
  chmodSync(path, 0o755);
}

/** 원장 tip의 JSON을 손으로 바꿔 넣는다. 훼손된 원장을 만들 때 쓴다. */
function overwriteLedger(work, origin, text) {
  const path = join(work, '.ledger-overwrite.json');
  writeFileSync(path, text, 'utf8');
  const blob = git(work, 'hash-object', '-w', path);
  rmSync(path, { force: true });
  const tree = spawnSync('git', ['mktree'], {
    cwd: work,
    encoding: 'utf8',
    input: `100644 blob ${blob}\t${LEDGER_FILE}\n`,
  }).stdout.trim();
  const commit = spawnSync('git', ['commit-tree', tree, '-m', 'overwrite'], {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'release test',
      GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
      GIT_COMMITTER_NAME: 'release test',
      GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
    },
  }).stdout.trim();
  git(work, 'push', '-q', '--force', 'origin', `${commit}:refs/heads/${LEDGER_BRANCH}`);
  void origin;
}

test('동시에 태그를 만들어도 Android versionCode가 중복되지 않는다', async () => {
  const { root, work, origin } = createRepository();
  try {
    const tags = ['v1.0.1', 'v1.0.2', 'v1.0.3', 'v1.0.4'];
    // 같은 원장 tip을 동시에 읽고 각자 할당을 시도한다. CAS가 없으면 여기서 번호가 겹친다.
    const results = await Promise.all(
      tags.map((tagInput) => Promise.resolve().then(() => runCreateTag(work, { tagInput }))),
    );

    for (const [index, result] of results.entries()) {
      assert.equal(result.status, 0, `${tags[index]}: ${result.stderr}`);
    }

    const codes = tags.map((tag) =>
      Number(parseTagReceipt(git(origin, 'cat-file', '-p', `refs/tags/${tag}`)).androidVersionCode),
    );
    assert.equal(new Set(codes).size, tags.length, `중복 versionCode: ${codes.join(',')}`);
    assert.deepEqual([...codes].sort((a, b) => a - b), [1, 2, 3, 4]);

    // 원장은 초기화 1 + 할당 4 = 5개의 선형 커밋이어야 한다. 유실도 이중 증가도 없다.
    assert.equal(ledgerCommitCount(origin), 1 + tags.length);
    assert.equal(remoteLedger(origin).android.lastVersionCode, tags.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('태그 ref가 서버에서 거절되면 원장도 반영되지 않는다', () => {
  const { root, work, origin } = createRepository();
  try {
    installPreReceiveHook(
      origin,
      '#!/bin/sh\nwhile read -r _old _new ref; do\n  case "$ref" in refs/tags/*) echo "tag refs are frozen" >&2; exit 1 ;; esac\ndone\nexit 0\n',
    );
    const before = ledgerCommitCount(origin);

    const result = runCreateTag(work, { tagInput: 'v1.0.1' });
    assert.notEqual(result.status, 0);
    assert.equal(ledgerCommitCount(origin), before, '부분 반영이 있으면 안 된다');
    assert.equal(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/tags/'), '');
    assert.equal(remoteLedger(origin).android.lastVersionCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('원장이 서버에서 거절되면 태그도 만들어지지 않는다', () => {
  const { root, work, origin } = createRepository();
  try {
    installPreReceiveHook(
      origin,
      '#!/bin/sh\nwhile read -r _old _new ref; do\n  case "$ref" in refs/heads/release-version-ledger) echo "ledger is frozen" >&2; exit 1 ;; esac\ndone\nexit 0\n',
    );
    const before = ledgerCommitCount(origin);

    const result = runCreateTag(work, { tagInput: 'v1.0.1' });
    assert.notEqual(result.status, 0);
    assert.equal(ledgerCommitCount(origin), before);
    assert.equal(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/tags/'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Google Play 상한 직전에서 fail-closed하고 아무것도 push하지 않는다', () => {
  const seeded = initialLedger({
    baseline: VERSION_CODE_MAX,
    sources: [{ kind: 'human-attestation', androidVersionCode: VERSION_CODE_MAX }],
  });
  const { root, work, origin } = createRepository({ ledger: seeded });
  try {
    const before = ledgerCommitCount(origin);
    const result = runCreateTag(work, { tagInput: 'v1.0.1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /android-version-code-exhausted/u);
    assert.equal(ledgerCommitCount(origin), before);
    assert.equal(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/tags/'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('훼손된 원장 JSON은 번호를 추측하지 않고 ledger-malformed로 멈춘다', () => {
  const cases = [
    ['잘린 JSON', '{"schemaVersion": 1, "release": {'],
    ['숫자가 아닌 lastVersionCode', JSON.stringify({ ...initialLedger(), android: { authority: 'github-ledger', lastVersionCode: 'x', legacyFallbackSealed: false } })],
    ['음수 lastVersionCode', JSON.stringify({ ...initialLedger(), android: { authority: 'github-ledger', lastVersionCode: -1, legacyFallbackSealed: false } })],
    ['android 구획 누락', JSON.stringify({ ...initialLedger(), android: undefined })],
  ];
  for (const [label, text] of cases) {
    const { root, work, origin } = createRepository();
    try {
      overwriteLedger(work, origin, `${text}\n`);
      const before = ledgerCommitCount(origin);
      const result = runCreateTag(work, { tagInput: 'v1.0.1' });
      assert.notEqual(result.status, 0, label);
      assert.match(result.stderr, /ledger-malformed/u, label);
      assert.equal(ledgerCommitCount(origin), before, label);
      assert.equal(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/tags/'), '', label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('baseline보다 작은 lastVersionCode는 ledger-non-monotonic으로 거부한다', () => {
  const seeded = initialLedger({ baseline: 100, sources: [{ kind: 'human-attestation', androidVersionCode: 100 }] });
  const broken = { ...seeded, android: { ...seeded.android, lastVersionCode: 99 } };
  const { root, work, origin } = createRepository();
  try {
    overwriteLedger(work, origin, `${JSON.stringify(broken, null, 2)}\n`);
    const result = runCreateTag(work, { tagInput: 'v1.0.1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ledger-non-monotonic/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('재시도는 유한하고 경합이 풀리지 않으면 고정된 코드로 보고한다', () => {
  // 실제 재시도 경로는 위 동시 할당 테스트가 태운다. 여기서는 루프가 무한하지 않다는
  // 구조적 사실과 보고 코드를 고정한다.
  const attempts = /for attempt in ([0-9 ]+); do/u.exec(WORKFLOW);
  assert.ok(attempts, '재시도 루프를 찾지 못했다');
  assert.deepEqual(attempts[1].trim().split(/\s+/u), ['1', '2', '3', '4', '5']);
  assert.match(WORKFLOW, /ledger-allocation-contention/u);
});

test('iOS 관측 기록은 Android 번호와 release 구획을 건드리지 않는다', () => {
  const seeded = applyAndroidAllocation({
    ledger: initialLedger(),
    tag: 'v1.0.1',
    sourceSha: 'a'.repeat(40),
    androidVersionCode: 1,
  });
  const observed = applyIosObservation({ ledger: seeded, tag: 'v1.0.1', buildNumber: 42 });

  assert.equal(observed.ios.lastObservedBuildNumber, 42);
  assert.equal(observed.ios.lastObservedTag, 'v1.0.1');
  assert.equal(observed.android.lastVersionCode, seeded.android.lastVersionCode);
  assert.equal(observed.release.lastTag, seeded.release.lastTag);

  for (const invalid of ['', '0', '-1', 'abc', 1.5]) {
    assert.throws(
      () => applyIosObservation({ ledger: seeded, tag: 'v1.0.1', buildNumber: invalid }),
      (error) => error.code === 'ios-observation-unverified',
      `${invalid}`,
    );
  }
});

test('원장이 할당을 시작하면 receipt 없는 태그를 구 파생식으로 배포하지 않는다', () => {
  const fresh = initialLedger();
  assert.deepEqual(resolveDeploymentAndroidVersionCode({ tag: 'v1.2.3', receipt: null, ledger: fresh }), {
    androidVersionCode: 1_001_002_003,
    androidVersionCodeSource: 'legacy-tag-formula',
  });

  const sealed = applyAndroidAllocation({ ledger: fresh, tag: 'v1.0.1', sourceSha: 'a'.repeat(40), androidVersionCode: 1 });
  assert.throws(
    () => resolveDeploymentAndroidVersionCode({ tag: 'v1.2.3', receipt: null, ledger: sealed }),
    (error) => error.code === 'legacy-derivation-not-applicable',
  );
});

test('같은 원장 상태는 항상 같은 바이트로 직렬화된다', () => {
  const ledger = initialLedger({ baseline: 7, sources: [{ kind: 'human-attestation', androidVersionCode: 7 }] });
  const once = renderLedger(ledger);
  assert.equal(once, renderLedger(parseLedger(once)));
  assert.equal(once, renderLedger({ ...ledger }));
  assert.ok(once.endsWith('}\n'), '끝 개행이 있어야 한다');
  assert.equal(JSON.parse(once).schemaVersion, 1);
});

test('태그 bump 규칙은 authority 계약이 아니라 원장 계약에 있다', () => {
  // authority 본문의 sha256이 tag receipt에 박힌다. 운영 규칙을 그쪽에 두면 규칙을 고칠 때마다
  // 이미 찍힌 receipt가 전부 미등록 revision이 된다. 원장 할당값은 공식으로 재계산할 수 없어
  // superseded 검증으로도 구제되지 않는다.
  const authority = readFileSync(new URL('../contracts/release-version-authority.yaml', import.meta.url), 'utf8');
  const ledger = readFileSync(new URL('../contracts/release-version-ledger.yaml', import.meta.url), 'utf8');
  assert.doesNotMatch(authority, /ledger-last-tag-unknown|tagBump/u);
  assert.match(ledger, /^tagBump:$/mu);
  assert.match(ledger, /^ {2}base: release\.lastTag$/mu);
  assert.match(ledger, /^ {2}withoutLastTag: fail-closed$/mu);
  assert.match(ledger, /^ {2}failClosed: ledger-last-tag-unknown$/mu);
  assert.match(ledger, /^ {2}- id: ledger-last-tag-unknown$/mu);
});

test('원장 파일과 계약이 같은 경로·브랜치를 가리킨다', () => {
  const contract = readFileSync(new URL('../contracts/release-version-ledger.yaml', import.meta.url), 'utf8');
  assert.match(contract, new RegExp(`name: ${LEDGER_BRANCH}`, 'u'));
  assert.match(contract, new RegExp(`path: ${LEDGER_FILE}`, 'u'));
  assert.match(WORKFLOW, new RegExp(`LEDGER_BRANCH=${LEDGER_BRANCH}`, 'u'));
  assert.match(WORKFLOW, new RegExp(`LEDGER_FILE=${LEDGER_FILE}`, 'u'));
});

test('iOS 관측 CLI는 App Store Connect readback 파일이 있어야만 기록한다', () => {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const cli = resolve(repositoryRoot, 'scripts/release/record-ios-build-observation.mjs');
  const fixture = resolve(repositoryRoot, 'fixtures/release-version-authority/xcode-cloud/build-readback.json');
  const { root, work } = createRepository();
  try {
    const ledgerPath = join(work, 'ledger.json');
    const nextPath = join(work, 'ledger-next.json');
    writeFileSync(
      ledgerPath,
      renderLedger(
        applyAndroidAllocation({
          ledger: initialLedger(),
          tag: 'v1.2.3',
          sourceSha: 'a'.repeat(40),
          androidVersionCode: 1,
        }),
      ),
    );

    const run = (args) =>
      spawnSync(process.execPath, [cli, '--ledger-in', ledgerPath, ...args], { encoding: 'utf8' });

    // 증거 파일 없이 값을 직접 넣을 수 없다.
    const missing = run([]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /ios-observation-unverified/u);

    const recorded = run(['--readback', fixture, '--ledger-out', nextPath]);
    assert.equal(recorded.status, 0, recorded.stderr);
    const next = parseLedger(readFileSync(nextPath, 'utf8'));
    assert.equal(next.ios.lastObservedBuildNumber, 42);
    assert.equal(next.ios.lastObservedTag, 'v1.2.3');
    assert.equal(next.android.lastVersionCode, 1, 'Android 번호를 소비하면 안 된다');

    // 태그가 여전히 marketing version의 정본이다. readback이 다른 값을 말하면 다른 build다.
    const drifted = join(work, 'drifted.json');
    writeFileSync(drifted, readFileSync(fixture, 'utf8').replace('"1.2.3"', '"9.9.9"'));
    const rejected = run(['--readback', drifted]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /ios-observation-unverified/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('태그 이력이 없는 원장은 bump하지 않고 태그를 요구한다', () => {
  // provider readback만으로 초기화한 원장은 번호 baseline은 있어도 태그 이력이 없다.
  // 없는 값을 v0.0.0으로 대신하면 이미 v1.10.3까지 나간 앱에 v0.0.1을 만들어 버리고,
  // 숫자는 원장이 올려주므로 성공한 것처럼 보인다. 실측으로 15개 중 11개가 이 상태였다.
  const readbackOnly = initialLedger({
    baseline: 1_010_003,
    sources: [{ kind: 'google-play-bundles-list', androidVersionCode: 1_010_003 }],
  });
  assert.equal(readbackOnly.release.lastTag, null);

  const { root, work, origin } = createRepository({ ledger: readbackOnly });
  try {
    const bumped = runCreateTag(work, { bump: 'patch' });
    assert.notEqual(bumped.status, 0);
    assert.match(bumped.stderr, /ledger-last-tag-unknown/u);
    assert.equal(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/tags/'), '', 'v0.0.1을 만들면 안 된다');
    assert.equal(ledgerCommitCount(origin), 1, '원장이 움직이면 안 된다');

    // 태그를 명시하면 그대로 진행하고 번호는 원장이 이어간다.
    const explicit = runCreateTag(work, { tagInput: 'v1.10.4' });
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.match(explicit.output, /^android_version_code=1010004$/mu);
    assert.equal(remoteLedger(origin).release.lastTag, 'v1.10.4');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
