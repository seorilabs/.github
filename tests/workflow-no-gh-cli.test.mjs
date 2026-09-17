import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';

const workflowDir = new URL('../.github/workflows/', import.meta.url);

// ARC 러너 이미지에는 gh CLI가 없다. `runner-node24.Dockerfile`(seorilabs-rpi-arm64)과
// `runner-android-x64.Dockerfile`(seorilabs-x64-android) 어디에도 설치 단계가 없다.
// gh가 다시 들어오면 `command not found`(exit 127)가 되는데, 호출부가 stderr를 버리면
// 그 실패가 「자산 없음」처럼 읽힌다. 실제로 그렇게 출시노트 없는 릴리스가 나갔다(#166).
// 재유입을 계약으로 막는다. GitHub 조작은 scripts/github-rest.mjs 를 쓴다.
const GH_INVOCATION = /(^|[\s;|&(`$])gh\s+(api|release|pr|issue|run|repo|auth|workflow|cache|secret|variable)\b/u;

async function workflowFiles() {
  const entries = await readdir(workflowDir);
  return entries.filter((name) => name.endsWith('.yml')).sort();
}

function collectRunScripts(workflow) {
  const scripts = [];
  for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (typeof step?.run === 'string') {
        scripts.push({ jobId, name: step.name ?? '(이름 없는 스텝)', run: step.run });
      }
    }
  }
  return scripts;
}

test('재사용 워크플로우의 run 스텝은 gh CLI를 부르지 않는다', async () => {
  const offenders = [];
  for (const file of await workflowFiles()) {
    const workflow = parse(await readFile(new URL(file, workflowDir), 'utf8'));
    for (const { jobId, name, run } of collectRunScripts(workflow)) {
      for (const [index, line] of run.split('\n').entries()) {
        const code = line.replace(/#.*$/u, '');
        if (GH_INVOCATION.test(code)) {
          offenders.push(`${file} · ${jobId} · ${name} · ${index + 1}행: ${line.trim()}`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `ARC 러너 이미지에 gh CLI가 없다. scripts/github-rest.mjs 로 REST를 쓴다:\n${offenders.join('\n')}`,
  );
});
