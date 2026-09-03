import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";

const contract = parse(await readFile("contracts/product-verification.yaml", "utf8"));
const schema = JSON.parse(await readFile("contracts/product-verification.schema.json", "utf8"));
const workflow = await readFile(".github/workflows/godot-product-verification-v1.yml", "utf8");

test("product verification 계약은 schema와 일치한다", () => {
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(contract), true, JSON.stringify(validate.errors));
});

test("EVALUATE 대상은 lizard-tycoon 한 곳으로 닫혀 있다", () => {
  assert.deepEqual(contract.rollout.repositories, [{
    repositoryId: 1265192029,
    fullName: "seorilabs/lizard-tycoon",
    profile: "godot",
  }]);
});

test("Godot workflow는 caller 입력 없이 세 제품 검증 명령을 고정한다", () => {
  assert.match(workflow, /^on:\n  workflow_call:\s*$/mu);
  assert.doesNotMatch(workflow, /workflow_call:\s*\n\s+inputs:/u);
  for (const script of contract.profiles.godot.requiredScripts) {
    assert.match(workflow, new RegExp(`npm run ${script}`, "u"));
  }
  assert.match(
    workflow,
    new RegExp(`godot-checks\\.yml@${contract.profiles.godot.baseWorkflowSha}`, "u"),
  );
  assert.match(workflow, /name: Product Verification/u);
  assert.match(workflow, /if: \$\{\{ always\(\) \}\}/u);
});

test("PR 제품 검증과 release 기기 QA의 증거 단계를 섞지 않는다", () => {
  assert.equal(contract.releaseQa.pullRequestRequired, false);
  assert.equal(contract.releaseQa.requiredFor, "release-candidate");
  assert.doesNotMatch(workflow, /deploy|upload|xcodebuild|gradlew/u);
});
