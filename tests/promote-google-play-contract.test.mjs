import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = new URL("../.github/workflows/promote-google-play.yml", import.meta.url);

test("Google Play 트랙 승격은 RPI ARC에서 재빌드 없이 실행한다", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const installStep = workflow.match(
    /- name: Install Google Play API client[\s\S]*?(?=\n      # 태그 Release)/,
  )?.[0];
  const promoteStep = workflow.match(/- name: Promote track[\s\S]*?(?=\n      - name: Summary)/)?.[0];

  assert.match(workflow, /runs-on: seorilabs-rpi-arm64/);
  assert.doesNotMatch(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /environment: google-play/);
  // 외부 action은 공식 최신 stable의 immutable SHA로 고정한다.
  assert.match(workflow, /google-github-actions\/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3\.0\.0/);
  assert.doesNotMatch(workflow, /uses: [A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@(?![0-9a-f]{40})/);
  assert.ok(installStep, "Google Play API client 설치 step이 필요합니다.");
  assert.match(installStep, /python3 -m ensurepip --version/);
  assert.doesNotMatch(installStep, /python3 -m venv --help/);
  assert.match(installStep, /python3 -m venv/);
  assert.match(installStep, /sudo apt-get install --yes python3-venv/);
  assert.match(installStep, /GITHUB_PATH/);
  assert.doesNotMatch(installStep, /python3 -m pip install/);
  assert.ok(promoteStep, "Promote track step이 필요합니다.");
  assert.match(promoteStep, /--promote\b/);
  assert.match(promoteStep, /--promote-from-track\b/);
  assert.match(promoteStep, /--promote-to-track\b/);
  assert.match(promoteStep, /--release-status\b/);
});
