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
    const parsed = parse(workflow);
    assert.match(workflow, /name: Org Contract/u);
    assert.match(workflow, /name: Fleet Quality/u);
    assert.match(workflow, /test:core/u);
    assert.match(workflow, /check:architecture/u);
    assert.match(workflow, /check:release/u);
    assert.doesNotMatch(workflow, /check_command:|install_command:|runs_on:/u);
    assert.doesNotMatch(workflow, /secrets:\s*inherit/u);
    assert.match(workflow, /npm\) npm run test:core/u);
    assert.match(workflow, /pnpm\) pnpm test:core/u);
    assert.match(workflow, /npm\) npm audit --audit-level=high/u);
    assert.match(workflow, /pnpm\) pnpm audit --audit-level high/u);
    assert.match(workflow, /npm\) npm ci --ignore-scripts/u);
    assert.match(workflow, /pnpm\) pnpm install --frozen-lockfile --ignore-scripts/u);
    assert.match(workflow, /Rebuild dependencies without registry credential/u);
    const rebuild = parsed.jobs.quality.steps.find(
      (step) => step.name === "Rebuild dependencies without registry credential",
    );
    assert.deepEqual(rebuild.env, { PACKAGE_MANAGER: "${{ inputs.package_manager }}" });
  }
});

test("WorkflowBundle은 reusable workflow의 실제 final check 이름을 고정한다", async () => {
  const source = await readFile("contracts/workflow-bundle-source.yaml", "utf8");
  const parsed = parse(source);
  for (const workflow of Object.values(parsed.reusableWorkflows)) {
    assert.equal(workflow.requiredCheck, "Org Contract / Org Contract");
  }
});

test("재사용 workflow는 caller가 아니라 각 중앙 job의 source SHA를 checkout한다", () => {
  for (const workflow of workflows) {
    assert.equal(
      [...workflow.matchAll(/JOB_CONTEXT_JSON: \$\{\{ toJSON\(job\) \}\}/gu)].length,
      2,
    );
    assert.match(workflow, /repository: \$\{\{ steps\.bundle-identity\.outputs\.repository \}\}/u);
    assert.match(workflow, /ref: \$\{\{ steps\.bundle-identity\.outputs\.sha \}\}/u);
    assert.match(
      workflow,
      /repository: \$\{\{ steps\.evidence-bundle-identity\.outputs\.repository \}\}/u,
    );
    assert.match(
      workflow,
      /ref: \$\{\{ steps\.evidence-bundle-identity\.outputs\.sha \}\}/u,
    );
    assert.doesNotMatch(workflow, /github\.workflow_sha/u);
  }
});

test("Org Contract 증명 job은 앱 실행면과 격리되고 quality 성공에 fail-closed된다", () => {
  for (const workflow of workflows) {
    const parsed = parse(workflow);
    assert.deepEqual(Object.keys(parsed.jobs), ["quality", "org-contract"]);

    const quality = parsed.jobs.quality;
    const evidence = parsed.jobs["org-contract"];
    assert.equal(quality.name, "Fleet Quality");
    assert.equal(evidence.name, "Org Contract");
    assert.equal(evidence.needs, "quality");
    assert.equal(evidence.if, "${{ always() }}");
    assert.equal(
      evidence.steps[0].name,
      "Reject failed or cancelled quality job",
    );
    assert.equal(evidence.steps[0].env.QUALITY_RESULT, "${{ needs.quality.result }}");
    assert.equal(evidence.steps[0].run, 'test "$QUALITY_RESULT" = success');

    const qualityText = JSON.stringify(quality);
    const evidenceText = JSON.stringify(evidence);
    assert.doesNotMatch(qualityText, /write-provenance|upload-artifact/u);
    assert.doesNotMatch(evidenceText, /Checkout application source|test:core|check:architecture|check:release/u);
    assert.match(evidenceText, /\.seorilabs-org-evidence/u);
    assert.match(evidenceText, /write-provenance/u);
    assert.match(evidenceText, /upload-artifact/u);
    assert.match(evidenceText, /QUALITY_RESULT/u);
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

test("직접 실행되는 ESM entrypoint는 portable file URL 비교를 사용한다", async () => {
  const entrypoints = [
    "packages/repo-contract/src/fleet-cli.mjs",
    "scripts/fleet/static-preflight.mjs",
    "scripts/fleet/secret-scan.mjs",
    "scripts/fleet/write-provenance.mjs",
  ];
  for (const entrypoint of entrypoints) {
    const source = await readFile(entrypoint, "utf8");
    assert.match(source, /pathToFileURL\(process\.argv\[1\]\)\.href/u);
    assert.doesNotMatch(source, /`file:\/\/\$\{process\.argv\[1\]\}`/u);
  }
});
