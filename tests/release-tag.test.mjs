// release-tag.yml의 태그 생성 블록을 실제 git 저장소에서 실행해 동작을 고정한다.
// 핵심 계약: 운영자가 고른 exact source commit에만 태그를 달고, 커밋이나 브랜치를 만들지 않으며,
// 태그 message에 org 정본이 만든 release binding receipt를 남긴다.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  computeAuthorityRevision,
  computeConfigRevision,
  createReleaseBinding,
  parseTagReceipt,
  renderTagReceipt,
} from '../scripts/release/tag-version-authority.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOW_PATH = resolve(REPOSITORY_ROOT, '.github/workflows/release-tag.yml');
const WORKFLOW = readFileSync(WORKFLOW_PATH, 'utf8');
const WORKFLOW_SHA = 'c'.repeat(40);
const AUTHORITY_ENV = {
  RELEASE_EVENT_NAME: 'workflow_dispatch',
  RELEASE_EVENT_REF: 'refs/heads/main',
  JOB_WORKFLOW_REPOSITORY: 'seorilabs/.github',
  JOB_WORKFLOW_SHA: WORKFLOW_SHA,
  JOB_WORKFLOW_REF: `seorilabs/.github/.github/workflows/release-tag.yml@${WORKFLOW_SHA}`,
};
// 현재 계약 본문의 revision. receipt 대조 fixture를 만들 때 쓴다.
const AUTHORITY_REVISION = computeAuthorityRevision(
  readFileSync(resolve(REPOSITORY_ROOT, 'contracts/release-version-authority.yaml'), 'utf8'),
);

/** 워크플로우 step의 run 블록만 dedent해 추출한다. */
function extractRunBlock(stepName) {
  const lines = WORKFLOW.split('\n');
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

const CREATE_TAG_BLOCK = extractRunBlock('Resolve and create tag');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** origin을 가진 임시 저장소와 org 정본 링크를 만든다. */
function createRepository() {
  const root = mkdtempSync(join(tmpdir(), 'release-tag-'));
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

  mkdirSync(join(work, '.seorilabs-release-authority'));
  for (const directory of ['scripts', 'contracts']) {
    symlinkSync(
      resolve(REPOSITORY_ROOT, directory),
      join(work, '.seorilabs-release-authority', directory),
    );
  }

  return { root, origin, work };
}

function runCreateTag(work, { targetRef = 'main', tagInput = '', bump = 'patch', dryRun = 'false' } = {}) {
  const outputPath = join(work, 'github-output.txt');
  writeFileSync(outputPath, '');
  const runnerTemp = mkdtempSync(join(tmpdir(), 'release-tag-runner-'));
  try {
    const result = spawnSync('bash', ['-c', CREATE_TAG_BLOCK], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...AUTHORITY_ENV,
        TARGET_REF: targetRef,
        TAG_INPUT: tagInput,
        BUMP: bump,
        DRY_RUN: dryRun,
        RUNNER_TEMP: runnerTemp,
        GITHUB_OUTPUT: outputPath,
      },
    });
    return { ...result, output: readFileSync(outputPath, 'utf8') };
  } finally {
    rmSync(runnerTemp, { recursive: true, force: true });
  }
}

function expectedReceipt(sourceSha, tag = 'v0.0.1') {
  const authorityRevision = computeAuthorityRevision(
    readFileSync(resolve(REPOSITORY_ROOT, 'contracts/release-version-authority.yaml'), 'utf8'),
  );
  return renderTagReceipt(
    createReleaseBinding({
      tag,
      sourceSha,
      authorityRevision,
      configRevision: computeConfigRevision({
        calledWorkflowRepository: AUTHORITY_ENV.JOB_WORKFLOW_REPOSITORY,
        calledWorkflowRef: AUTHORITY_ENV.JOB_WORKFLOW_REF,
        calledWorkflowSha: AUTHORITY_ENV.JOB_WORKFLOW_SHA,
        authorityRevision,
      }),
    }),
  );
}

test('운영자가 고른 exact source commit에 태그를 달고 커밋이나 브랜치를 만들지 않는다', () => {
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
      '브랜치를 push하면 안 된다',
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

test('annotated tag message는 org 정본이 만든 release binding receipt를 담는다', () => {
  const { root, work } = createRepository();
  try {
    const target = git(work, 'rev-parse', 'HEAD');
    const result = runCreateTag(work, { tagInput: 'v1.2.3' });
    assert.equal(result.status, 0, result.stderr);

    assert.equal(git(work, 'cat-file', '-t', 'refs/tags/v1.2.3'), 'tag');
    const message = git(work, 'for-each-ref', '--format=%(contents)', 'refs/tags/v1.2.3');
    const shortSha = git(work, 'rev-parse', '--short', target);
    assert.equal(message, `Release v1.2.3 (${shortSha})\n\n${expectedReceipt(target, 'v1.2.3')}`);

    const receipt = parseTagReceipt(message);
    assert.equal(receipt.tag, 'v1.2.3');
    assert.equal(receipt.sourceSha, target);
    assert.equal(receipt.versionName, '1.2.3');
    assert.equal(receipt.androidVersionCode, '1001002003');
    assert.equal(receipt.appleBuildNumber, '1002003');
    assert.match(receipt.authorityRevision, /^[0-9a-f]{64}$/u);
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

test('같은 태그가 다른 commit에 있으면 태그를 옮기지 않고 실패한다', () => {
  const { root, work } = createRepository();
  try {
    const first = git(work, 'rev-parse', 'HEAD');
    git(work, 'tag', 'v1.2.3', first);
    writeFileSync(join(work, 'app.txt'), 'second\n');
    git(work, 'add', 'app.txt');
    git(work, 'commit', '-q', '-m', 'feat: 두 번째 커밋');
    git(work, 'push', '-q', 'origin', 'main');

    const result = runCreateTag(work, { tagInput: 'v1.2.3' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists for a different commit/u);
    assert.equal(git(work, 'rev-parse', 'refs/tags/v1.2.3^{commit}'), first, '기존 태그가 유지돼야 한다');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('같은 태그가 같은 commit을 가리키면 idempotent하게 통과한다', () => {
  const { root, work } = createRepository();
  try {
    const target = git(work, 'rev-parse', 'HEAD');
    git(work, 'tag', 'v1.2.3', target);

    const result = runCreateTag(work, { tagInput: 'v1.2.3' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /^created=false$/mu);
    assert.match(result.output, new RegExp(`^sha=${target}$`, 'mu'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('이미 있는 태그도 파생값과 receipt를 먼저 검증한 뒤에만 idempotent 통과한다', () => {
  // 1) receipt 없는 lightweight 태그: 태그와 commit 자체가 정본이므로 통과한다.
  let repository = createRepository();
  try {
    const target = git(repository.work, 'rev-parse', 'HEAD');
    git(repository.work, 'tag', 'v1.2.3', target);
    const result = runCreateTag(repository.work, { tagInput: 'v1.2.3' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /^created=false$/mu);
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
  }

  // 2) GitHub UI에서 만든 annotated 태그처럼 receipt marker가 없는 message도 통과한다.
  repository = createRepository();
  try {
    const target = git(repository.work, 'rev-parse', 'HEAD');
    git(repository.work, 'tag', '-a', 'v1.2.3', target, '-m', 'Release v1.2.3 from the GitHub UI');
    const result = runCreateTag(repository.work, { tagInput: 'v1.2.3' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /^created=false$/mu);
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
  }

  // 3) 이미 있는 v0.0.0은 같은 commit이어도 파생 versionCode가 0이라 성공으로 보고하지 않는다.
  repository = createRepository();
  try {
    const target = git(repository.work, 'rev-parse', 'HEAD');
    git(repository.work, 'tag', 'v0.0.0', target);
    const result = runCreateTag(repository.work, { tagInput: 'v0.0.0' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /derived-version-code-out-of-range/u);
    assert.doesNotMatch(result.output, /^created=/mu);
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
  }

  // 4) 다른 source SHA로 찍힌 receipt를 가진 annotated 태그는 idempotent 통과하지 않는다.
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
      'android-version-code: 1001002003',
      'apple-build-number: 1002003',
    ].join('\n');
    git(repository.work, 'tag', '-a', 'v1.2.3', target, '-m', foreignReceipt);
    const result = runCreateTag(repository.work, { tagInput: 'v1.2.3' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tag-reuse-with-different-source/u);
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
  }

  // 5) 다른 authority 계약 revision으로 찍힌 receipt도 거부한다.
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
    const result = runCreateTag(repository.work, { tagInput: 'v1.2.3' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tag-reuse-with-different-config/u);
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
  }

  // 6) 현재 계약으로 org 정본이 만든 receipt를 가진 태그는 그대로 통과한다.
  repository = createRepository();
  try {
    const target = git(repository.work, 'rev-parse', 'HEAD');
    const created = runCreateTag(repository.work, { tagInput: 'v1.2.3' });
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.output, /^created=true$/mu);
    const again = runCreateTag(repository.work, { tagInput: 'v1.2.3' });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.output, /^created=false$/mu);
    assert.equal(git(repository.work, 'rev-parse', 'refs/tags/v1.2.3^{commit}'), target);
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
  }
});

test('dry_run은 태그를 만들지도 push하지도 않는다', () => {
  const { root, work, origin } = createRepository();
  try {
    const target = git(work, 'rev-parse', 'HEAD');
    const result = runCreateTag(work, { tagInput: 'v1.2.3', dryRun: 'true' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /^created=false$/mu);
    assert.match(result.output, new RegExp(`^sha=${target}$`, 'mu'));
    assert.equal(git(work, 'tag', '--list'), '');
    assert.equal(git(root, 'ls-remote', origin, 'refs/tags/*'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('태그 미지정 시 원격 최신 stable 태그에서 bump한다', () => {
  const { root, work } = createRepository();
  try {
    const target = git(work, 'rev-parse', 'HEAD');
    git(work, 'tag', 'v1.2.9', target);
    git(work, 'tag', 'v1.2.10', target);
    git(work, 'push', '-q', 'origin', '--tags');

    const result = runCreateTag(work, { bump: 'minor' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /^tag=v1\.3\.0$/mu);
    assert.equal(git(work, 'rev-parse', 'refs/tags/v1.3.0^{commit}'), target);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('versionCode를 파생할 수 없는 태그는 org 정본이 생성 전에 거부한다', () => {
  for (const tagInput of ['v1.1000.0', 'v1.0.1000', 'v2200.0.0']) {
    const { root, work } = createRepository();
    try {
      const result = runCreateTag(work, { tagInput });
      assert.notEqual(result.status, 0, tagInput);
      assert.equal(git(work, 'tag', '--list'), '', tagInput);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('워크플로우에 빈 마커 커밋과 브랜치 push 경로가 남아 있지 않다', () => {
  assert.doesNotMatch(WORKFLOW, /--allow-empty/u);
  assert.doesNotMatch(WORKFLOW, /chore\(release\)/u);
  assert.doesNotMatch(WORKFLOW, /git push origin "HEAD:refs\/heads/u);
  assert.doesNotMatch(WORKFLOW, /git reset --hard/u);
  assert.doesNotMatch(WORKFLOW, /marker/iu);

  // 태그 push 외에 다른 원격 쓰기가 없어야 한다.
  const pushes = [...WORKFLOW.matchAll(/^\s*(?:if )?git push [^\n]*/gmu)].map((match) => match[0].trim());
  assert.deepEqual(pushes, ['if git push origin "refs/tags/$tag" 2>/tmp/push_err; then']);
  assert.match(WORKFLOW, /git tag -a "\$tag" "\$target_commit" -F "\$tag_message_file"/u);
});
