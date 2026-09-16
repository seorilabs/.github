// release-tag.yml의 할당·태그 생성 블록을 실제 git 저장소에서 실행하기 위한 공용 하네스.
// 워크플로 YAML의 run 블록을 그대로 꺼내 bash로 돌리므로, 워크플로와 테스트가 갈라지지 않는다.
// release-tag 동작 테스트와 원장 동시성·원자성 테스트가 같은 하네스를 쓴다.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeAuthorityRevision,
  computeConfigRevision,
  createInitialLedger,
  createReleaseBinding,
  parseLedger,
  parseTagReceipt,
  renderLedger,
  renderTagReceipt,
} from '../../scripts/release/tag-version-authority.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKFLOW_PATH = resolve(REPOSITORY_ROOT, '.github/workflows/release-tag.yml');
const WORKFLOW = readFileSync(WORKFLOW_PATH, 'utf8');
const WORKFLOW_SHA = 'c'.repeat(40);
const LEDGER_BRANCH = 'release-version-ledger';
const LEDGER_FILE = 'release-version-ledger.json';
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

const CREATE_TAG_BLOCK = extractRunBlock('Allocate release version and create tag');

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** 초기화 워크플로가 만드는 첫 원장과 같은 문서. 신규 저장소의 baseline은 0이다. */
export function initialLedger({ baseline = 0, sources = null, lastTag = null, lastSourceSha = null } = {}) {
  return createInitialLedger({
    baselineAndroidVersionCode: baseline,
    baselineSources: sources ?? [{ kind: 'no-prior-release', androidVersionCode: baseline }],
    authorityRevision: AUTHORITY_REVISION,
    initializedFromWorkflowSha: WORKFLOW_SHA,
    initializedAt: '2026-09-16T00:00:00Z',
    lastTag,
    lastSourceSha,
  });
}

/** 원장 orphan 브랜치를 bare origin에 직접 만든다. 작업 트리를 건드리지 않는다. */
export function seedLedgerFromText(work, text) {
  const path = join(work, '.ledger-seed.json');
  writeFileSync(path, text, 'utf8');
  const blob = git(work, 'hash-object', '-w', path);
  rmSync(path, { force: true });
  const tree = execFileSync('git', ['mktree'], {
    cwd: work,
    encoding: 'utf8',
    input: `100644 blob ${blob}\t${LEDGER_FILE}\n`,
  }).trim();
  const commit = execFileSync('git', ['commit-tree', tree, '-m', 'release-version-ledger: initialize'], {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'release test',
      GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
      GIT_COMMITTER_NAME: 'release test',
      GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
    },
  }).trim();
  git(work, 'push', '-q', 'origin', `${commit}:refs/heads/${LEDGER_BRANCH}`);
  return commit;
}

// 워크플로가 --depth=1로 fetch하면 작업 복제본이 shallow가 된다. 원장 이력은 절대 잘리지
// 않는 bare origin에서 직접 읽는다.
/** 원격 원장 tip의 JSON을 읽는다. */
export function remoteLedger(origin) {
  return parseLedger(git(origin, 'show', `refs/heads/${LEDGER_BRANCH}:${LEDGER_FILE}`));
}

/** 원장 브랜치의 커밋 수. 이중 증가나 유실을 잡는다. */
export function ledgerCommitCount(origin) {
  return Number(git(origin, 'rev-list', '--count', `refs/heads/${LEDGER_BRANCH}`));
}

/** origin을 가진 임시 저장소와 org 정본 링크를 만든다. */
export function createRepository({ ledger = initialLedger() } = {}) {
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

  if (ledger !== null) {
    seedLedgerFromText(work, renderLedger(ledger));
  }

  return { root, origin, work };
}

export function runCreateTag(work, { targetRef = 'main', tagInput = '', bump = 'patch', dryRun = 'false' } = {}) {
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

export function expectedReceipt(sourceSha, tag, androidVersionCode, source = 'github-ledger') {
  return renderTagReceipt(
    createReleaseBinding({
      tag,
      sourceSha,
      authorityRevision: AUTHORITY_REVISION,
      androidVersionCode,
      androidVersionCodeSource: source,
      configRevision: computeConfigRevision({
        calledWorkflowRepository: AUTHORITY_ENV.JOB_WORKFLOW_REPOSITORY,
        calledWorkflowRef: AUTHORITY_ENV.JOB_WORKFLOW_REF,
        calledWorkflowSha: AUTHORITY_ENV.JOB_WORKFLOW_SHA,
        authorityRevision: AUTHORITY_REVISION,
      }),
    }),
  );
}

export { AUTHORITY_REVISION, LEDGER_BRANCH, LEDGER_FILE, WORKFLOW, WORKFLOW_SHA };
