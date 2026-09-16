// 원장 초기화 판정의 계약이다. 핵심은 하나다: 기준 번호를 추측하지 않는다.
// 잘못된 기준 번호는 이후 그 저장소의 모든 릴리스 번호를 오염시키므로, 검증된 근거가 없으면
// READY를 주지 않고 무엇이 필요한지만 남긴다.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import { computeAuthorityRevision, parseLedger } from '../scripts/release/tag-version-authority.mjs';
import { expectedReceipt, git } from './helpers/release-ledger-fixtures.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const INIT_CLI = resolve(REPOSITORY_ROOT, 'scripts/release/init-release-version-ledger.mjs');
const PLAY_READBACK_CLI = resolve(REPOSITORY_ROOT, 'scripts/release/read-google-play-version-codes.py');
const AUTHORITY_REVISION = computeAuthorityRevision(
  readFileSync(resolve(REPOSITORY_ROOT, 'contracts/release-version-authority.yaml'), 'utf8'),
);
const ajv = new Ajv2020({ strict: true, validateFormats: false });
const validateReport = ajv.compile(
  JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, 'contracts/release-version-ledger-init.schema.json'), 'utf8')),
);
const validateLedger = ajv.compile(
  JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, 'contracts/release-version-ledger.schema.json'), 'utf8')),
);

function createRepository() {
  const root = mkdtempSync(join(tmpdir(), 'ledger-init-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  git(root, 'init', '-q', '--bare', origin);
  git(root, 'clone', '-q', origin, work);
  git(work, 'config', 'user.name', 'release test');
  git(work, 'config', 'user.email', 'release-test@example.invalid');
  writeFileSync(join(work, 'app.txt'), 'first\n');
  git(work, 'add', 'app.txt');
  git(work, 'commit', '-q', '-m', 'feat: 첫 커밋');
  git(work, 'branch', '-M', 'main');
  git(work, 'push', '-q', 'origin', 'main');
  return { root, origin, work };
}

function runInit(work, extra = []) {
  const outPath = join(work, 'init.json');
  const result = spawnSync(
    process.execPath,
    [INIT_CLI, work, '--full-name', 'seorilabs/example-app', '--observed-at', '2026-09-16T00:00:00Z', '--out', outPath, ...extra],
    { encoding: 'utf8', env: { ...process.env, JOB_WORKFLOW_SHA: 'c'.repeat(40) } },
  );
  return { ...result, report: JSON.parse(readFileSync(outPath, 'utf8')) };
}

test('태그도 마켓 식별자도 없는 신규 저장소는 baseline 0에서 시작한다', () => {
  const { root, work } = createRepository();
  try {
    const { status, report } = runInit(work);
    assert.equal(status, 0);
    assert.ok(validateReport(report), JSON.stringify(validateReport.errors));
    assert.equal(report.status, 'READY');
    assert.equal(report.path, 'new-repository');
    assert.equal(report.baseline.androidVersionCode, 0);
    assert.deepEqual(report.baseline.sources, [{ kind: 'no-prior-release', androidVersionCode: 0 }]);
    assert.ok(validateLedger(report.proposedLedger), JSON.stringify(validateLedger.errors));
    // 첫 할당은 1이 된다. Google Play의 높은 최초 versionCode 경고가 사라지는 지점이다.
    assert.equal(parseLedger(JSON.stringify(report.proposedLedger)).android.lastVersionCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('태그가 없어도 Play 식별자가 선언돼 있으면 추측하지 않고 readback을 요구한다', () => {
  const { root, work } = createRepository();
  try {
    // 태그 0개가 Play 업로드 이력 0건을 뜻하지 않는다. 1부터 시작하면 기존 build와 충돌한다.
    execFileSync('mkdir', ['-p', join(work, 'play-store')]);
    writeFileSync(
      join(work, 'play-store/google-play.config.json'),
      `${JSON.stringify({ packageName: 'im.seorilabs.example' }, null, 2)}\n`,
    );
    const { status, report } = runInit(work);
    assert.equal(status, 1);
    assert.equal(report.status, 'NEEDS_INPUT');
    assert.equal(report.path, 'legacy-repository');
    assert.equal(report.baseline, null);
    assert.equal(report.required[0].reason, 'play-store-package-declared-without-readback');
    assert.equal(report.required[0].packageName, 'im.seorilabs.example');
    assert.deepEqual(
      report.required[0].acceptedEvidence.map(({ kind }) => kind),
      ['google-play-bundles-list', 'human-attestation'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('유효한 tag receipt가 있으면 그 번호가 baseline이 된다', () => {
  const { root, work } = createRepository();
  try {
    const target = git(work, 'rev-parse', 'HEAD');
    const message = `Release v1.0.1 (${git(work, 'rev-parse', '--short', target)})\n\n${expectedReceipt(target, 'v1.0.1', 1_001_000_001, 'legacy-tag-formula')}`;
    git(work, 'tag', '-a', 'v1.0.1', target, '-m', message);
    git(work, 'push', '-q', 'origin', 'refs/tags/v1.0.1');

    const { status, report } = runInit(work);
    assert.equal(status, 0);
    assert.ok(validateReport(report), JSON.stringify(validateReport.errors));
    assert.equal(report.status, 'READY');
    assert.equal(report.path, 'existing-repository-with-receipt');
    assert.equal(report.baseline.androidVersionCode, 1_001_000_001);
    assert.equal(report.baseline.sources[0].kind, 'tag-receipt');
    assert.equal(report.proposedLedger.release.lastTag, 'v1.0.1');
    assert.equal(report.proposedLedger.provenance.authorityRevision, AUTHORITY_REVISION);
    // 아직 원장이 번호를 할당한 적이 없으므로 legacy 폴백이 열려 있다.
    assert.equal(report.proposedLedger.android.legacyFallbackSealed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('receipt 없는 legacy 저장소는 근거 없이 READY가 되지 않는다', () => {
  const { root, work } = createRepository();
  try {
    const target = git(work, 'rev-parse', 'HEAD');
    git(work, 'tag', 'v1.9.7', target);
    git(work, 'push', '-q', 'origin', 'refs/tags/v1.9.7');

    const missing = runInit(work);
    assert.equal(missing.status, 1);
    assert.equal(missing.report.status, 'NEEDS_INPUT');
    assert.equal(missing.report.path, 'legacy-repository');
    assert.equal(missing.report.required[0].reason, 'no-verified-tag-receipt');

    // attestation만으로는 부족하다. 받아들이겠다고 명시해야 한다.
    const attestation = join(work, 'attest.json');
    writeFileSync(
      attestation,
      `${JSON.stringify({
        kind: 'human-attestation',
        packageName: 'im.seorilabs.example',
        maxVersionCode: 167_704_300,
        observedAt: '2026-09-16T00:00:00Z',
        observedBy: 'operator',
        evidenceUrl: 'https://play.google.com/console',
      })}\n`,
    );
    const ignored = runInit(work, ['--attestation', attestation]);
    assert.equal(ignored.status, 1);
    assert.ok(ignored.report.findings.some(({ id }) => id === 'attestation-not-accepted'));

    const accepted = runInit(work, ['--attestation', attestation, '--accept-attestation']);
    assert.equal(accepted.status, 0);
    assert.equal(accepted.report.status, 'READY');
    assert.equal(accepted.report.baseline.androidVersionCode, 167_704_300);
    assert.equal(accepted.report.baseline.sources[0].kind, 'human-attestation');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('baseline은 검증된 소스의 최댓값이고 원장은 그 값에서 시작한다', () => {
  const { root, work } = createRepository();
  try {
    const target = git(work, 'rev-parse', 'HEAD');
    const message = `Release v1.0.1\n\n${expectedReceipt(target, 'v1.0.1', 1_001_000_001, 'legacy-tag-formula')}`;
    git(work, 'tag', '-a', 'v1.0.1', target, '-m', message);
    git(work, 'push', '-q', 'origin', 'refs/tags/v1.0.1');

    const readback = join(work, 'play.json');
    writeFileSync(
      readback,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: 'google-play-version-code-readback',
        packageName: 'im.seorilabs.example',
        observedAt: '2026-09-16T00:00:00Z',
        source: 'androidpublisher-v3-edits',
        maxVersionCode: 1_001_000_005,
        bundleVersionCodes: [1_001_000_005],
        apkVersionCodes: [],
        tracks: [],
        status: 'READY',
        evidenceDigest: 'a'.repeat(64),
      })}\n`,
    );
    const { status, report } = runInit(work, ['--play-readback', readback]);
    assert.equal(status, 0);
    assert.equal(report.baseline.androidVersionCode, 1_001_000_005, 'Play 실측이 더 크면 그 값이 기준이다');
    assert.equal(report.baseline.sources.length, 2);
    assert.ok(validateLedger(report.proposedLedger), JSON.stringify(validateLedger.errors));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Play readback 조회는 published 상태를 바꾸지 않고 비밀값을 남기지 않는다', () => {
  const source = readFileSync(PLAY_READBACK_CLI, 'utf8');
  assert.match(source, /edits\.insert\(packageName=package_name, body=\{\}\)/u);
  assert.match(source, /edits\.delete\(packageName=package_name, editId=edit_id\)/u);
  assert.doesNotMatch(source, /\.commit\(/u);
  assert.doesNotMatch(source, /bundles\(\)\.upload/u);
  assert.doesNotMatch(source, /tracks\(\)\.update/u);
  // 원본 예외를 문자열화해 내보내지 않는다. 허용된 코드만 CI에 남는다.
  assert.doesNotMatch(source, /str\(error\)/u);
  assert.match(source, /GOOGLE_PLAY_EDIT_CLEANUP_FAILED/u);
  // 자격증명 해석 경로는 중앙 client 하나뿐이다.
  assert.match(source, /from google_play_client import \(/u);
  assert.doesNotMatch(source, /google\.auth\.default/u);

  const syntax = spawnSync(
    'python3',
    ['-c', 'compile(open(__import__("sys").argv[1], encoding="utf-8").read(), __import__("sys").argv[1], "exec")', PLAY_READBACK_CLI],
    { encoding: 'utf8' },
  );
  assert.equal(syntax.status, 0, syntax.stderr);
});
