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
  assert.match(promoteStep, /--release-name\b/);
  // 중앙 스크립트가 기본값이다. 저장소 설정 파일을 읽지 않으므로 package name 을 넘긴다.
  assert.match(
    promoteStep,
    /UPLOAD_SCRIPT: \$\{\{ inputs\.upload_script \|\| '\.seorilabs-release-authority\/scripts\/release\/upload-google-play-aab\.py' \}\}/,
  );
  assert.match(promoteStep, /--package-name "\$PACKAGE_NAME"/);
  // repo-local 레거시 스크립트는 그 인자를 모른다. 비었을 때는 붙이지 않는다.
  assert.match(promoteStep, /if \[ -n "\$PACKAGE_NAME" \]; then/);
});
