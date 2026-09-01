import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

const workflowDirectory = new URL("../.github/workflows/", import.meta.url);

test("재사용 workflow가 참조하는 secret을 명시적으로 선언한다", async () => {
  const workflowNames = (await readdir(workflowDirectory)).filter((name) =>
    name.endsWith(".yml"),
  );

  for (const workflowName of workflowNames) {
    const source = await readFile(
      new URL(workflowName, workflowDirectory),
      "utf8",
    );
    const workflow = parse(source);
    const workflowCall = workflow?.on?.workflow_call;
    if (!workflowCall) {
      continue;
    }

    assert.doesNotMatch(
      source,
      /\bsecrets:\s*inherit\b/,
      `${workflowName}: secrets: inherit는 허용하지 않는다`,
    );

    const declared = new Set(Object.keys(workflowCall.secrets ?? {}));
    const referenced = new Set(
      [...source.matchAll(/\bsecrets\.([A-Z][A-Z0-9_]*)\b/g)].map(
        (match) => match[1],
      ),
    );
    const missing = [...referenced]
      .filter((name) => !declared.has(name))
      .sort();

    assert.deepEqual(
      missing,
      [],
      `${workflowName}: on.workflow_call.secrets에 선언되지 않은 secret 참조`,
    );
  }
});

test("AIT 광고 설정은 선택적 named secret이며 검증과 빌드에만 전달한다", async () => {
  const workflow = parse(
    await readFile(new URL("rn-deploy-ait.yml", workflowDirectory), "utf8"),
  );
  assert.deepEqual(workflow.on.workflow_call.secrets.VITE_AD_GROUP_ID, {
    required: false,
  });
  assert.equal(
    workflow.on.workflow_call.inputs.require_ad_group_id.default,
    false,
  );
  assert.equal(
    workflow.on.workflow_call.inputs.require_ad_group_id.type,
    "boolean",
  );
  assert.equal(workflow.env?.VITE_AD_GROUP_ID, undefined);
  assert.equal(workflow.jobs.deploy.env?.VITE_AD_GROUP_ID, undefined);

  const consumers = workflow.jobs.deploy.steps.filter(
    (step) => step.env?.VITE_AD_GROUP_ID,
  );
  assert.deepEqual(
    consumers.map((step) => step.name),
    [
      "Validate required ad configuration",
      "Build .ait bundle (custom)",
      "Build .ait bundle (default)",
    ],
  );
  for (const step of consumers) {
    assert.equal(step.env.VITE_AD_GROUP_ID, "${{ secrets.VITE_AD_GROUP_ID }}");
  }
  const validation = consumers[0];
  assert.equal(
    validation.env.REQUIRE_AD_GROUP_ID,
    "${{ inputs.require_ad_group_id }}",
  );
  assert.ok(
    workflow.jobs.deploy.steps.indexOf(validation) <
      workflow.jobs.deploy.steps.indexOf(consumers[1]),
  );
});

test("AIT 필수 광고 설정은 누락과 공백을 거부하고 식별자를 출력하지 않는다", async () => {
  const workflow = parse(
    await readFile(new URL("rn-deploy-ait.yml", workflowDirectory), "utf8"),
  );
  const validation = workflow.jobs.deploy.steps.find(
    (step) => step.name === "Validate required ad configuration",
  );
  const canary = "nonsecret-ad-configuration-canary";
  for (const [required, value, expectedStatus] of [
    ["false", "", 0],
    ["false", canary, 0],
    ["true", canary, 0],
    ["true", "", 1],
    ["true", " \t\n", 1],
  ]) {
    const result = spawnSync("bash", ["-c", validation.run], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        REQUIRE_AD_GROUP_ID: required,
        VITE_AD_GROUP_ID: value,
      },
    });
    assert.equal(result.status, expectedStatus);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(canary));
    assert.equal(
      result.stderr,
      expectedStatus === 0
        ? ""
        : "VITE_AD_GROUP_ID is required for this release build.\n",
    );
  }
});
