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

test("MINIMAX_API_KEY는 workflow_call.secrets 명시 선언으로만 전달된다", async () => {
  const { source, workflow } = await loadWorkflow();
  assert.deepEqual(workflow.on.workflow_call.secrets, {
    MINIMAX_API_KEY: { required: true },
  });
  assert.doesNotMatch(source, /secrets:\s*inherit/u);
});
