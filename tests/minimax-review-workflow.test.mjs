import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW_PATH = ".github/workflows/minimax-review-v1.yml";

async function loadWorkflow() {
  const source = await readFile(resolve(REPOSITORY_ROOT, WORKFLOW_PATH), "utf8");
  return { source, workflow: parseDocument(source).toJS() };
}

test("MiniMax review workflow는 private repo를 seorilabs-rpi-arm64로 라우팅한다", async () => {
  const { workflow } = await loadWorkflow();
  const job = workflow.jobs.review;
  assert.equal(
    job["runs-on"],
    "${{ github.event.repository.private && 'seorilabs-rpi-arm64' || 'ubuntu-latest' }}",
  );
});

test("MiniMax review workflow는 fork PR과 draft를 배제한다", async () => {
  const { workflow } = await loadWorkflow();
  const condition = workflow.jobs.review.if;
  assert.match(condition, /github\.event_name == 'pull_request'/u);
  assert.match(
    condition,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u,
  );
  assert.match(condition, /github\.event\.pull_request\.draft == false/u);
});

test("리뷰는 플러그인 의존 없이 준비된 diff와 직접 프롬프트로 실행된다", async () => {
  const { workflow } = await loadWorkflow();
  const steps = workflow.jobs.review.steps;

  const exportStep = steps.find((step) => step.name === "Export PR metadata and diff");
  assert.ok(exportStep, "diff를 준비하는 스텝이 있어야 한다");
  assert.match(exportStep.run, /application\/vnd\.github\.v3\.diff/u);
  assert.match(exportStep.run, /test -s "\$RUNNER_TEMP\/minimax-review\/pr\.diff"/u);
  assert.doesNotMatch(exportStep.run, /\bgh\b/u, "ARC 러너에는 gh CLI가 없다");

  const reviewStep = steps.find(
    (step) => step.name === "Review with MiniMax-brained Claude Code",
  );
  assert.ok(reviewStep, "리뷰 실행 스텝이 있어야 한다");
  assert.equal(reviewStep.with.plugins, undefined);
  assert.equal(reviewStep.with.plugin_marketplaces, undefined);
  assert.match(reviewStep.with.prompt, /pr\.diff/u);
  assert.match(reviewStep.with.prompt, /summary\.md/u);
  assert.match(reviewStep.with.claude_args, /--max-turns 30/u);
  assert.match(
    reviewStep.with.claude_args,
    /--allowedTools "Read,Grep,Glob,Write,mcp__github_inline_comment__create_inline_comment"/u,
  );
});

test("요약 코멘트는 summary 생성 여부와 무관하게 항상 게시된다", async () => {
  const { workflow } = await loadWorkflow();
  const postStep = workflow.jobs.review.steps.find(
    (step) => step.name === "Post review summary",
  );
  assert.ok(postStep, "요약 게시 스텝이 있어야 한다");
  assert.equal(postStep.if, "${{ !cancelled() }}");
  assert.match(postStep.run, /node --input-type=module/u);
  assert.match(postStep.run, /"\/issues\/" \+ process\.env\.PR_NUMBER \+ "\/comments"/u);
  assert.match(postStep.run, /리뷰 세션이 요약을 생성하지 못했습니다/u);
  assert.doesNotMatch(postStep.run, /\bgh\b/u, "ARC 러너에는 gh CLI가 없다");
});

test("MINIMAX_API_KEY는 workflow_call.secrets 명시 선언으로만 전달된다", async () => {
  const { source, workflow } = await loadWorkflow();
  assert.deepEqual(workflow.on.workflow_call.secrets, {
    MINIMAX_API_KEY: { required: true },
  });
  assert.doesNotMatch(source, /secrets:\s*inherit/u);
});
