import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  planWorkflowBundleApproval,
  publishWorkflowBundleApproval,
  readbackWorkflowBundleApproval,
  signWorkflowBundleApproval,
} from "../scripts/fleet/workflow-bundle-approval.mjs";

const SOURCE = readFileSync(new URL("../scripts/fleet/workflow-bundle-approval.mjs", import.meta.url), "utf8");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "workflow-bundle-approval-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeJson(root, name, value) {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const evidenceRecord = Object.freeze({
  schemaVersion: 2,
  target: "static",
  profile: "react-native",
  repositoryId: 1250442131,
  fullName: "seorilabs/happy-farm",
  runId: 1,
  runAttempt: 1,
});

test("every mode refuses incomplete arguments before touching credentials or the network", async () => {
  await assert.rejects(planWorkflowBundleApproval({}), /ARGUMENT_INVALID/u);
  await assert.rejects(signWorkflowBundleApproval({}), /NATIVE_LAUNCH_REQUIRED|ARGUMENT_INVALID/u);
  await assert.rejects(publishWorkflowBundleApproval({}), /ARGUMENT_INVALID/u);
  await assert.rejects(readbackWorkflowBundleApproval({ sourceSha: "not-a-sha" }), /ARGUMENT_INVALID/u);
  await assert.rejects(readbackWorkflowBundleApproval({ sourceSha: "A".repeat(40) }), /ARGUMENT_INVALID/u);
});

test("signing is refused outside the native launcher", async (t) => {
  const root = fixture(t);
  const candidate = writeJson(root, "candidate.json", { source: { sha: "a".repeat(40) } });
  const evidence = writeJson(root, "evidence.json", evidenceRecord);
  const previous = process.env.SEORI_AUTH_NATIVE_LAUNCHED;
  delete process.env.SEORI_AUTH_NATIVE_LAUNCHED;
  t.after(() => {
    if (previous === undefined) delete process.env.SEORI_AUTH_NATIVE_LAUNCHED;
    else process.env.SEORI_AUTH_NATIVE_LAUNCHED = previous;
  });
  await assert.rejects(
    signWorkflowBundleApproval({ candidate, evidence, out: join(root, "approved.json") }),
    /NATIVE_LAUNCH_REQUIRED/u,
  );
});

test("duplicate evidence identities are rejected before any GitHub readback", async (t) => {
  const root = fixture(t);
  const candidate = writeJson(root, "candidate.json", { source: { sha: "a".repeat(40) } });
  const first = writeJson(root, "first.json", evidenceRecord);
  const second = writeJson(root, "second.json", { ...evidenceRecord, runId: 2 });
  await assert.rejects(
    planWorkflowBundleApproval({ candidate, evidence: `${first},${second}` }),
    /EVIDENCE_DUPLICATE/u,
  );
});

test("publishing refuses a bundle that is not signed as APPROVED", async (t) => {
  const root = fixture(t);
  const bundle = writeJson(root, "bundle.json", { approval: { state: "CANDIDATE" } });
  await assert.rejects(publishWorkflowBundleApproval({ bundle }), /BUNDLE_NOT_APPROVED/u);
});

test("missing input files fail closed instead of being treated as empty", async (t) => {
  const root = fixture(t);
  await assert.rejects(
    planWorkflowBundleApproval({ candidate: join(root, "absent.json"), evidence: join(root, "absent.json") }),
    /INPUT_MISSING/u,
  );
});

test("the tool stays outside the candidate path filter and keeps its fail-closed codes", () => {
  const filter = readFileSync(new URL("../.github/workflows/workflow-bundle-v5-candidate.yml", import.meta.url), "utf8");
  assert.ok(filter.includes("scripts/fleet/**-v5.mjs"));
  assert.ok(!"scripts/fleet/workflow-bundle-approval.mjs".endsWith("-v5.mjs"));
  for (const code of [
    "WORKFLOW_BUNDLE_APPROVAL_NATIVE_LAUNCH_REQUIRED",
    "WORKFLOW_BUNDLE_APPROVAL_REPO_ROOT_MISMATCH",
    "WORKFLOW_BUNDLE_APPROVAL_CREDENTIAL_UNSAFE",
    "WORKFLOW_BUNDLE_APPROVAL_KEY_NOT_ACTIVE",
    "WORKFLOW_BUNDLE_EVIDENCE_RUN_NOT_SUCCEEDED",
    "WORKFLOW_BUNDLE_EVIDENCE_ARTIFACT_AMBIGUOUS",
  ]) {
    assert.ok(SOURCE.includes(code), code);
  }
  assert.ok(!/console\.log\([^)]*token/iu.test(SOURCE));
});
