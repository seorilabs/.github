import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

const paths = [
  ".github/workflows/rn-static-checks-v2.yml",
  ".github/workflows/godot-checks-v2.yml",
];
const workflows = await Promise.all(paths.map((path) => readFile(path, "utf8")));

test("v2 정적 workflow는 고정 품질 명령과 stable required check를 사용한다", () => {
  for (const workflow of workflows) {
    assert.match(workflow, /name: Org Contract/u);
    assert.match(workflow, /test:core/u);
    assert.match(workflow, /check:architecture/u);
    assert.match(workflow, /check:release/u);
    assert.doesNotMatch(workflow, /check_command:|install_command:|runs_on:/u);
    assert.doesNotMatch(workflow, /secrets:\s*inherit/u);
  }
});

test("public repository는 ARC에 진입하지 않고 모든 external action은 full SHA다", () => {
  for (const workflow of workflows) {
    assert.match(
      workflow,
      /github\.event\.repository\.private && 'seorilabs-rpi-arm64' \|\| 'ubuntu-latest'/u,
    );
    const actionUses = [...workflow.matchAll(/uses: ([^\s#]+)/gu)].map(
      (match) => match[1],
    );
    assert.ok(actionUses.length >= 3);
    for (const uses of actionUses) {
      assert.match(uses, /@[0-9a-f]{40}$/u, uses);
    }
  }
});

test("workflow YAML은 파싱되고 static caller에 id-token 또는 write 권한이 없다", () => {
  for (let index = 0; index < workflows.length; index += 1) {
    const parsed = parse(workflows[index]);
    assert.ok(parsed.on.workflow_call, paths[index]);
    assert.deepEqual(parsed.permissions, {
      contents: "read",
      packages: "read",
    });
  }
});

test("Godot binary는 architecture별 공식 checksum으로 검증된다", () => {
  const godot = workflows[1];
  assert.match(
    godot,
    /5dd0d86405cf7e8adf79fb6377b38ba682a2846cb378ffe5364f38c01ad29b9d/u,
  );
  assert.match(
    godot,
    /cadd3204e728a35d3f13adb7fd0d7902636b79f6b95c40c265eb73b6c35329e4/u,
  );
  assert.match(godot, /sha256sum --check --status/u);
  assert.match(godot, /SCRIPT ERROR\|ERROR:/u);
});

test("candidate workflow는 테스트 뒤 불변 bundle을 만들고 3일만 보관한다", async () => {
  const candidate = await readFile(
    ".github/workflows/workflow-bundle-candidate.yml",
    "utf8",
  );
  assert.ok(candidate.indexOf("npm test") < candidate.indexOf("fleet-cli.mjs bundle"));
  assert.match(candidate, /--source-sha "\$GITHUB_SHA"/u);
  assert.match(candidate, /retention-days: 3/u);
  assert.doesNotMatch(candidate, /permissions:[\s\S]*?contents: write/u);
});
