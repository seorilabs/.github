import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { parseDocument } from "yaml";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONTRACT_ENTRYPOINTS = [
  "README.md",
  ".github/workflows/README.md",
  "docs/fleet-control-plane.md",
  "docs/ci-cd/fleet-zero-touch-bootstrap.md",
  "docs/ci-cd/workflow-bundle-v4-shadow.md",
  "docs/migration/fleet-baseline-2026-08-27.md",
  "docs/migration/org-contract-v1-rollout.md",
  "docs/migration/p5-cleanup-inventory.md",
];
const JSON_SCHEMAS = [
  "contracts/app.schema.json",
  "contracts/credential-consumer.schema.json",
  "contracts/provider-auth-matrix.schema.json",
  "contracts/fleet-bootstrap-plan.schema.json",
  "contracts/fleet-cleanup-execution-receipt.schema.json",
  "contracts/fleet-migration-chain-head.schema.json",
  "contracts/fleet-migration-inventory.schema.json",
  "contracts/fleet-migration-plan.schema.json",
  "contracts/markets/app-store.schema.json",
  "contracts/markets/apps-in-toss.schema.json",
  "contracts/markets/google-play.schema.json",
  "contracts/workflow-bundle.schema.json",
  "contracts/xcode-cloud-run.schema.json",
];
const YAML_CONTRACTS = [
  "contracts/agent-policy.yaml",
  "contracts/provider-auth-matrix.yaml",
  "contracts/release-policy.yaml",
  "contracts/review-policy.yaml",
  "contracts/test-policy.yaml",
  "profiles/godot.yaml",
  "profiles/react-native.yaml",
];

function localMarkdownTargets(markdown) {
  return [...markdown.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/gu)]
    .map((match) => match[1].trim())
    .filter((target) => {
      return (
        target.length > 0 &&
        !target.startsWith("#") &&
        !/^[a-z][a-z0-9+.-]*:/iu.test(target)
      );
    })
    .map((target) => target.replace(/^<|>$/gu, "").split("#", 1)[0]);
}

test("Org Contract 진입 문서의 로컬 링크가 모두 존재한다", async () => {
  const missing = [];

  for (const document of CONTRACT_ENTRYPOINTS) {
    const absoluteDocument = resolve(REPOSITORY_ROOT, document);
    const markdown = await readFile(absoluteDocument, "utf8");
    for (const target of localMarkdownTargets(markdown)) {
      const absoluteTarget = resolve(dirname(absoluteDocument), target);
      try {
        await access(absoluteTarget);
      } catch {
        missing.push(`${document} -> ${target}`);
      }
    }
  }

  assert.deepEqual(missing, []);
});

test("Org Contract JSON Schema를 strict mode로 compile한다", async () => {
  for (const schemaPath of JSON_SCHEMAS) {
    const schema = JSON.parse(
      await readFile(resolve(REPOSITORY_ROOT, schemaPath), "utf8"),
    );
    assert.doesNotThrow(() => {
      new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
    }, schemaPath);
  }
});

test("Org Contract 정책과 프로필 YAML이 중복 key 없이 파싱된다", async () => {
  for (const contractPath of YAML_CONTRACTS) {
    const document = parseDocument(
      await readFile(resolve(REPOSITORY_ROOT, contractPath), "utf8"),
      { strict: true, uniqueKeys: true },
    );
    assert.deepEqual(document.errors, [], contractPath);
    const value = document.toJS();
    assert.equal(value.schemaVersion, 1, contractPath);
    assert.equal(typeof value.id, "string", contractPath);
  }
});

test("P0-P5 이관 단계와 P5 안전 삭제 gate를 문서 계약으로 고정한다", async () => {
  const rollout = await readFile(
    resolve(REPOSITORY_ROOT, "docs/migration/org-contract-v1-rollout.md"),
    "utf8",
  );
  const cleanup = await readFile(
    resolve(REPOSITORY_ROOT, "docs/migration/p5-cleanup-inventory.md"),
    "utf8",
  );

  assert.deepEqual(
    [...rollout.matchAll(/^### (P[0-5]) —/gmu)].map((match) => match[1]),
    ["P0", "P1", "P2", "P3", "P4", "P5"],
  );
  for (const gate of [
    "Owner",
    "Consumer",
    "Replacement",
    "Required checks",
    "Live readback",
    "Backup/restore",
    "Approval",
    "Rollback",
    "Observation",
  ]) {
    assert.match(cleanup, new RegExp(`\\| ${gate} \\|`, "u"), gate);
  }
  assert.match(cleanup, /이 문서는 삭제 승인이 아니며/u);
  assert.match(cleanup, /사용자 명시 승인/u);
  assert.match(cleanup, /확인되지 않은 consumer/u);
});

test("P7 chain head는 외부 durable CAS와 live current reservation readback을 명시한다", async () => {
  const controlPlane = await readFile(
    resolve(REPOSITORY_ROOT, "docs/fleet-control-plane.md"),
    "utf8",
  );
  const packageReadme = await readFile(
    resolve(REPOSITORY_ROOT, "packages/repo-contract/README.md"),
    "utf8",
  );

  for (const document of [controlPlane, packageReadme]) {
    assert.match(document, /durable CAS|durable compare-and-swap/u);
    assert.match(document, /live readback|trustedStateAuthorityReadback/u);
    assert.match(document, /STATE_AUTHORITY_READBACK_REQUIRED/u);
  }
  assert.match(controlPlane, /외부 CAS를 구현했다고 주장하지 않/u);
  assert.match(controlPlane, /mutation 직전에 같은 reservation을/u);
});

test("Contract Checks는 읽기 전용 중앙 정적 검증만 수행한다", async () => {
  const workflowPath = resolve(
    REPOSITORY_ROOT,
    ".github/workflows/contract-checks.yml",
  );
  const workflowText = await readFile(workflowPath, "utf8");
  const workflow = parseDocument(workflowText, {
    strict: true,
    uniqueKeys: true,
  }).toJS();

  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const forbidden of [
    "id-token: write",
    "secrets.",
    "environment: production",
    "gcloud ",
    "firebase ",
    "market-submit",
  ]) {
    assert.equal(workflowText.includes(forbidden), false, forbidden);
  }
});
