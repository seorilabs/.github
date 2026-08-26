import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = new URL("../.github/workflows/promote-google-play.yml", import.meta.url);

test("Google Play 트랙 승격은 RPI ARC에서 재빌드 없이 실행한다", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const promoteStep = workflow.match(/- name: Promote track[\s\S]*?(?=\n      - name: Summary)/)?.[0];

  assert.match(workflow, /runs-on: seorilabs-rpi-arm64/);
  assert.doesNotMatch(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /environment: google-play/);
  assert.match(workflow, /google-github-actions\/auth@v3/);
  assert.ok(promoteStep, "Promote track step이 필요합니다.");
  assert.match(promoteStep, /--promote\b/);
  assert.match(promoteStep, /--promote-from-track\b/);
  assert.match(promoteStep, /--promote-to-track\b/);
  assert.match(promoteStep, /--release-status\b/);
});
