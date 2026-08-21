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
  "docs/migration/org-contract-v1-rollout.md",
  "docs/migration/p5-cleanup-inventory.md",
];
const JSON_SCHEMAS = [
  "contracts/app.schema.json",
  "contracts/credential-consumer.schema.json",
  "contracts/markets/app-store.schema.json",
  "contracts/markets/apps-in-toss.schema.json",
  "contracts/markets/google-play.schema.json",
];
const YAML_CONTRACTS = [
  "contracts/agent-policy.yaml",
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
