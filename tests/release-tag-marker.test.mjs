// release-tag.yml 의 릴리즈 마커 커밋 블록을 워크플로우에서 그대로 뽑아
// 실제 git 저장소에 실행해 동작을 고정한다(정규식 대조가 아닌 행위 검증).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflowPath = '.github/workflows/release-tag.yml';
const workflow = readFileSync(workflowPath, 'utf8');

/** 워크플로우 run 블록에서 마커 커밋 구간만 추출해 dedent 한다. */
function extractMarkerBlock() {
  const lines = workflow.split('\n');
  const start = lines.findIndex((l) => l.includes('marker_prefix="chore(release): "'));
  const end = lines.findIndex((l) => l.includes('git tag -a "$tag" "$target_commit"'));
  assert.ok(start > 0, 'marker_prefix 선언을 찾지 못했다');
  assert.ok(end > start, 'git tag 라인을 찾지 못했다');

  const body = lines.slice(start, end);
  const indent = body[0].length - body[0].trimStart().length;
  return body.map((l) => l.slice(indent)).join('\n');
}

const MARKER_BLOCK = extractMarkerBlock();

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** origin 을 가진 임시 저장소를 만들고 마커 블록을 실행한다. */
function runScenario(setup, { targetRefIsSha = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'release-marker-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');

  try {
    git(root, 'init', '-q', '--bare', origin);
    git(root, 'clone', '-q', origin, work);
    git(work, 'config', 'user.name', 'test');
    git(work, 'config', 'user.email', 'test@example.com');
    git(work, 'commit', '-q', '--allow-empty', '-m', 'feat: 첫 커밋');
    git(work, 'branch', '-M', 'main');
    git(work, 'push', '-q', 'origin', 'main');

    setup({ git, work, origin });

    let targetRef = 'main';
    if (targetRefIsSha) {
      targetRef = git(work, 'rev-parse', 'HEAD');
      git(work, 'checkout', '-q', '--detach');
    }

    const before = git(work, 'rev-parse', 'HEAD');
    const script = [
      'set -euo pipefail',
      `TARGET_REF=${JSON.stringify(targetRef)}`,
      'tag=v1.1.0',
      'target_commit="$(git rev-parse HEAD)"',
      'short_sha="$(git rev-parse --short "$target_commit")"',
      MARKER_BLOCK,
      'echo "TAGGED=$target_commit"',
    ].join('\n');

    const out = execFileSync('bash', ['-c', script], { cwd: work, encoding: 'utf8' });
    const tagged = out.match(/TAGGED=([0-9a-f]{40})/)?.[1];
    assert.ok(tagged, '태그 대상 커밋을 얻지 못했다');

    return {
      marked: tagged !== before,
      taggedSubject: git(work, 'log', '-1', '--format=%s', tagged),
      remoteHead: git(work, 'ls-remote', '--heads', 'origin', 'refs/heads/main').split('\t')[0],
      tagged,
      before,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('브랜치 헤드이고 부모가 일반 커밋이면 마커 커밋을 남기고 그 커밋을 태그 대상으로 삼는다', () => {
  const r = runScenario(() => {});

  assert.equal(r.marked, true);
  assert.equal(r.taggedSubject, 'chore(release): v1.1.0');
  assert.equal(r.remoteHead, r.tagged, '마커 커밋이 원격 main 에 반영돼야 한다');
});

test('마커 커밋은 부모와 트리가 같다(파일 변경 0)', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-marker-tree-'));
  try {
    const origin = join(root, 'origin.git');
    const work = join(root, 'work');
    git(root, 'init', '-q', '--bare', origin);
    git(root, 'clone', '-q', origin, work);
    git(work, 'config', 'user.name', 'test');
    git(work, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(work, 'app.txt'), 'hello\n');
    git(work, 'add', 'app.txt');
    git(work, 'commit', '-q', '-m', 'feat: 앱 추가');
    git(work, 'branch', '-M', 'main');
    git(work, 'push', '-q', 'origin', 'main');

    const parentTree = git(work, 'rev-parse', 'HEAD^{tree}');
    execFileSync(
      'bash',
      [
        '-c',
        ['set -euo pipefail', 'TARGET_REF=main', 'tag=v1.1.0',
         'target_commit="$(git rev-parse HEAD)"',
         'short_sha="$(git rev-parse --short "$target_commit")"',
         MARKER_BLOCK].join('\n'),
      ],
      { cwd: work, encoding: 'utf8' },
    );

    assert.equal(git(work, 'rev-parse', 'HEAD^{tree}'), parentTree);
    assert.equal(git(work, 'diff', '--name-only', 'HEAD~1', 'HEAD'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('부모가 이미 마커 커밋이면 마커를 남기지 않는다(연쇄 방지)', () => {
  const r = runScenario(({ git: g, work }) => {
    g(work, 'commit', '-q', '--allow-empty', '-m', 'chore(release): v1.0.0');
    g(work, 'push', '-q', 'origin', 'main');
  });

  assert.equal(r.marked, false);
  assert.equal(r.taggedSubject, 'chore(release): v1.0.0');
});

test('원격 브랜치 헤드가 대상 커밋과 다르면 마커를 남기지 않는다', () => {
  const r = runScenario(({ git: g, work }) => {
    g(work, 'commit', '-q', '--allow-empty', '-m', '다른 사람 커밋');
    g(work, 'push', '-q', 'origin', 'main');
    g(work, 'reset', '-q', '--hard', 'HEAD~1');
  });

  assert.equal(r.marked, false);
});

test('target_ref 가 브랜치가 아니면(태그/SHA 지정) 브랜치를 변경하지 않는다', () => {
  const r = runScenario(() => {}, { targetRefIsSha: true });

  assert.equal(r.marked, false);
  assert.equal(r.remoteHead, r.before, '원격 main 이 그대로여야 한다');
});

test('push 가 거절되면 마커 없이 원래 커밋을 태그 대상으로 되돌린다', () => {
  const r = runScenario(({ origin }) => {
    const hook = join(origin, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);
  });

  assert.equal(r.marked, false);
  assert.equal(r.taggedSubject, 'feat: 첫 커밋');
  assert.equal(r.remoteHead, r.before, '원격 main 이 그대로여야 한다');
});

test('마커 커밋 메시지에 CI skip 지시어를 넣지 않는다(push:tags 배포 보호)', () => {
  for (const directive of ['[skip ci]', '[ci skip]', '[skip actions]', '***NO_CI***']) {
    assert.equal(MARKER_BLOCK.includes(directive), false, `${directive} 가 포함되면 안 된다`);
  }
});
