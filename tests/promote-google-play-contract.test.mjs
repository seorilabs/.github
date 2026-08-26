import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = new URL("../.github/workflows/promote-google-play.yml", import.meta.url);

test("Google Play 트랙 승격은 RPI ARC에서 재빌드 없이 실행한다", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /runs-on: seorilabs-rpi-arm64/);
  assert.doesNotMatch(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /environment: google-play/);
  assert.match(workflow, /google-github-actions\/auth@v3/);
  assert.match(workflow, /--promote/);
  assert.match(workflow, /--promote-from-track/);
  assert.match(workflow, /--promote-to-track/);
  assert.match(workflow, /--release-status/);
});
