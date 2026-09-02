import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { enrollWorkflowBundleCredentials } from "../scripts/fleet/workflow-bundle-credentials.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-credentials-test-")));
  mkdirSync(join(root, "catalog"), { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const approval = { confirmation: "shared-workflow-bundle-build-runtime-v1", backupSha256: "a".repeat(64) };

test("plan does not issue credentials; issuance requires explicit approval and backup binding", (t) => {
  const root = fixture(t);
  assert.equal(enrollWorkflowBundleCredentials({ root }).state, "ABSENT");
  assert.throws(() => enrollWorkflowBundleCredentials({ root, mode: "issue" }), /APPROVAL_BACKUP_REQUIRED/u);
  assert.deepEqual(readdirSync(root), ["catalog"]);
});

test("issue separates purposes, protects originals, emits only fingerprints, and never rotates", (t) => {
  const root = fixture(t);
  const result = enrollWorkflowBundleCredentials({ root, mode: "issue", ...approval });
  assert.equal(result.state, "ENROLLED_BACKUP_REQUIRED");
  assert.equal(new Set(result.credentials.map((entry) => entry.fingerprintSha256)).size, 3);
  const catalog = parse(readFileSync(join(root, "catalog/workflow-bundle-runtime.yaml"), "utf8"));
  const before = catalog.credentials.map((entry) => readFileSync(join(root, entry.path)));
  for (let index = 0; index < catalog.credentials.length; index += 1) {
    const path = join(root, catalog.credentials[index].path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(result).includes(before[index].toString()));
  }
  assert.equal(enrollWorkflowBundleCredentials({ root, mode: "issue", ...approval }).changed, false);
  for (let index = 0; index < catalog.credentials.length; index += 1) {
    assert.deepEqual(readFileSync(join(root, catalog.credentials[index].path)), before[index]);
  }
});

test("an existing common credential cannot be replaced with a second identity", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "catalog/existing.yaml"), "version: 1\ncredentials:\n  - id: shared/existing/signer\n    purpose: workflow-bundle-v5-approval-signing\n    status: active\n", { mode: 0o600 });
  assert.throws(() => enrollWorkflowBundleCredentials({ root, mode: "issue", ...approval }), /SHARED_DUPLICATE/u);
});

test("unregistered material and symlink directories fail closed without overwrite", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "seori-auth"), { mode: 0o700 });
  mkdirSync(join(root, "seori-auth/workflow-bundle-candidate"), { mode: 0o700 });
  const path = join(root, "seori-auth/workflow-bundle-candidate/adapter.bearer");
  writeFileSync(path, "existing-canary", { mode: 0o600 });
  assert.throws(() => enrollWorkflowBundleCredentials({ root, mode: "issue", ...approval }), /UNREGISTERED_MATERIAL/u);
  assert.equal(readFileSync(path, "utf8"), "existing-canary");
  const other = fixture(t);
  symlinkSync(root, join(other, "seori-auth"));
  assert.throws(() => enrollWorkflowBundleCredentials({ root: other, mode: "issue", ...approval }), /DIRECTORY_UNSAFE/u);
});
