import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync('.github/workflows/godot-deploy-app-store.yml', 'utf8');

function extractResolveBlock() {
  const lines = workflow.split('\n');
  const step = lines.findIndex((line) => line.includes('- name: Resolve exact release tag'));
  assert.ok(step >= 0, 'exact release tag step을 찾지 못했다');
  const run = lines.findIndex((line, index) => index > step && line.trim() === 'run: |');
  assert.ok(run > step, 'resolve run block을 찾지 못했다');
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && line.length - line.trimStart().length <= 8) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

const RESOLVE_BLOCK = extractResolveBlock();

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createRepository() {
  const root = mkdtempSync(join(tmpdir(), 'godot-app-store-tag-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'App Store Test');
  git(root, 'config', 'user.email', 'app-store-test@example.invalid');
  writeFileSync(join(root, 'source.txt'), 'tag source\n');
  git(root, 'add', 'source.txt');
  git(root, 'commit', '-q', '-m', 'tag source');
  return root;
}

function runResolve(cwd, releaseTag) {
  const output = join(cwd, 'github-output.txt');
  const result = spawnSync('bash', ['-c', RESOLVE_BLOCK], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      RELEASE_TAG_INPUT: releaseTag,
    },
  });
  return {
    ...result,
    output: result.status === 0 ? readFileSync(output, 'utf8') : '',
  };
}

test('동명 branch가 있어도 refs/tags의 commit을 checkout한다', () => {
  const root = createRepository();
  try {
    const tagCommit = git(root, 'rev-parse', 'HEAD');
    git(root, 'tag', 'v1.2.3');
    writeFileSync(join(root, 'source.txt'), 'branch source\n');
    git(root, 'add', 'source.txt');
    git(root, 'commit', '-q', '-m', 'branch source');
    git(root, 'branch', 'v1.2.3');

    const result = runResolve(root, 'v1.2.3');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(root, 'rev-parse', 'HEAD^{commit}'), tagCommit);
    assert.match(result.output, /^tag=v1\.2\.3$/mu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('빈 입력은 malformed와 prerelease를 제외한 최신 stable tag를 고른다', () => {
  const root = createRepository();
  try {
    for (const tag of ['v1.2.9', 'v1.2.10', 'v9.0.0-rc.1', 'v10x.0y.0z', 'v01.2.3']) {
      git(root, 'tag', tag);
    }
    const result = runResolve(root, '');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /^tag=v1\.2\.10$/mu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exact stable SemVer가 아닌 입력은 checkout 전에 거부한다', () => {
  for (const releaseTag of ['1.2.3', 'v1.2.3-rc.1', 'v01.2.3', 'v1x.2y.3z']) {
    const root = createRepository();
    try {
      const before = git(root, 'rev-parse', 'HEAD');
      const result = runResolve(root, releaseTag);
      assert.notEqual(result.status, 0, releaseTag);
      assert.match(result.stderr, /exact stable SemVer/u);
      assert.equal(git(root, 'rev-parse', 'HEAD'), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('workflow는 사용자 입력을 shell 본문에 직접 보간하지 않는다', () => {
  assert.match(workflow, /RELEASE_TAG_INPUT: \$\{\{ inputs\.release_tag \}\}/u);
  assert.doesNotMatch(workflow, /tag="\$\{\{ inputs\.release_tag \}\}"/u);
  assert.match(workflow, /checkout "refs\/tags\/\$tag"/u);
  assert.match(workflow, /\[ "\$tag_commit" = "\$head_commit" \]/u);
});
