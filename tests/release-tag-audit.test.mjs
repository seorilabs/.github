// 전체 태그·원장 드리프트 감사의 계약이다.
// 이 명령이 릴리스 hot path에 들어가면 태그가 수백 개인 저장소가 매 배포마다 전수 조회를 하고,
// receipt 없는 legacy 앱이 전부 배포 불가가 된다. 그래서 분리 자체를 테스트로 고정한다.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import { auditReleaseTags } from '../scripts/release/audit-release-tags.mjs';
import {
  createRepository,
  expectedReceipt,
  git,
  initialLedger,
  runCreateTag,
} from './helpers/release-ledger-fixtures.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const AUTHORITY_CONTRACT = readFileSync(
  resolve(REPOSITORY_ROOT, 'contracts/release-version-authority.yaml'),
  'utf8',
);
const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(
  JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, 'contracts/release-tag-audit.schema.json'), 'utf8')),
);

function audit(work) {
  return auditReleaseTags({
    root: work,
    fullName: 'seorilabs/example-app',
    observedAt: '2026-09-16T00:00:00Z',
    authorityContract: AUTHORITY_CONTRACT,
  });
}

test('원장이 할당한 태그만 있는 저장소는 중복도 드리프트도 없다', () => {
  const { root, work } = createRepository();
  try {
    assert.equal(runCreateTag(work, { tagInput: 'v1.0.0' }).status, 0);
    assert.equal(runCreateTag(work, { tagInput: 'v1.0.1' }).status, 0);
    git(work, 'fetch', '-q', '--no-tags', '--force', 'origin', '+refs/heads/release-version-ledger:refs/remotes/origin/release-version-ledger');

    const report = audit(work);
    assert.ok(validate(report), JSON.stringify(validate.errors));
    assert.equal(report.status, 'READY');
    assert.equal(report.tagCount, 2);
    assert.deepEqual(report.duplicateAndroidVersionCodes, []);
    assert.deepEqual(report.ledgerDrift, []);
    assert.deepEqual(report.tagsWithoutReceipt, []);
    assert.deepEqual(
      report.tags.map(({ androidVersionCodeSource }) => androidVersionCodeSource),
      ['github-ledger', 'github-ledger'],
    );
    assert.equal(report.ledgerTip.androidLastVersionCode, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('중복 versionCode와 receipt 없는 태그를 등급을 나눠 보고한다', () => {
  const { root, work } = createRepository({ ledger: initialLedger({ baseline: 1_001_002_003, sources: [{ kind: 'human-attestation', androidVersionCode: 1_001_002_003 }] }) });
  try {
    const target = git(work, 'rev-parse', 'HEAD');
    // 같은 번호를 담은 receipt 두 개. 과거 파생식 시절에는 태그마다 번호가 고정이라 생길 수 있다.
    for (const tag of ['v1.2.3', 'v2.2.3']) {
      const receipt = expectedReceipt(target, tag, 1_001_002_003, 'github-ledger').replace(
        /^tag: .*$/mu,
        `tag: ${tag}`,
      );
      git(work, 'tag', '-a', tag, target, '-m', `Release ${tag}\n\n${receipt}`);
    }
    git(work, 'tag', 'v0.9.0', target);
    git(work, 'fetch', '-q', '--no-tags', '--force', 'origin', '+refs/heads/release-version-ledger:refs/remotes/origin/release-version-ledger');

    const report = audit(work);
    assert.ok(validate(report), JSON.stringify(validate.errors));
    assert.equal(report.status, 'NEEDS_CHANGE');
    assert.deepEqual(report.duplicateAndroidVersionCodes, [
      { androidVersionCode: 1_001_002_003, tags: ['v1.2.3', 'v2.2.3'] },
    ]);
    assert.deepEqual(report.tagsWithoutReceipt, ['v0.9.0']);

    const severityById = new Map(report.findings.map(({ id, severity }) => [id, severity]));
    assert.equal(severityById.get('duplicate-android-version-code'), 'blocking');
    // 조직 태그의 다수가 lightweight다. blocking으로 두면 status가 신호를 잃는다.
    assert.equal(severityById.get('tag-lightweight'), 'advisory');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('원장이 실제 최신 태그보다 뒤처지면 드리프트로 보고한다', () => {
  const { root, work } = createRepository();
  try {
    assert.equal(runCreateTag(work, { tagInput: 'v1.0.0' }).status, 0);
    const target = git(work, 'rev-parse', 'HEAD');
    // 사람이 GitHub UI로 찍은 태그처럼 원장을 거치지 않은 태그.
    git(work, 'tag', 'v9.9.9', target);
    git(work, 'fetch', '-q', '--no-tags', '--force', 'origin', '+refs/heads/release-version-ledger:refs/remotes/origin/release-version-ledger');

    const report = audit(work);
    assert.equal(report.status, 'NEEDS_CHANGE');
    assert.deepEqual(
      report.ledgerDrift.map(({ id }) => id),
      ['ledger-behind-latest-tag'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('원장이 없는 저장소는 판정 불가로 멈춘다', () => {
  const { root, work } = createRepository({ ledger: null });
  try {
    const report = audit(work);
    assert.equal(report.status, 'NEEDS_INPUT');
    assert.equal(report.ledgerTip.present, false);
    assert.ok(report.findings.some(({ id }) => id === 'ledger-missing'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('감사 명령은 릴리스 hot path 워크플로 어디에도 등장하지 않는다', () => {
  const directory = resolve(REPOSITORY_ROOT, '.github/workflows');
  const hotPath = readdirSync(directory).filter((name) =>
    /^(release-tag|resolve-release-version|.*-deploy-.*|promote-google-play)\.yml$/u.test(name),
  );
  assert.ok(hotPath.length >= 7, `hot path 워크플로를 찾지 못했다: ${hotPath.join(', ')}`);
  for (const name of hotPath) {
    const text = readFileSync(join(directory, name), 'utf8');
    assert.doesNotMatch(text, /audit-release-tags/u, name);
    // 전수 태그 조회도 없어야 한다. refs/tags/* 를 한 번에 가져오거나 태그 목록을 나열하지 않는다.
    assert.doesNotMatch(text, /refs\/tags\/\*:refs\/tags\/\*/u, name);
    assert.doesNotMatch(text, /git tag --list/u, name);
    assert.doesNotMatch(text, /fetch-tags: true/u, name);
  }
});
