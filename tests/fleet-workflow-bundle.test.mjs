import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  createWorkflowBundle,
  generateOrgContractCaller,
  promoteWorkflowBundle,
  validateOrgContractCaller,
  validateWorkflowBundle,
} from "../packages/repo-contract/src/fleet.mjs";

const SOURCE_SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;

test("WorkflowBundle schema는 strict mode로 compile된다", async () => {
  const schema = JSON.parse(
    await readFile("contracts/workflow-bundle.schema.json", "utf8"),
  );
  assert.doesNotThrow(() =>
    new Ajv2020({ strict: true, validateFormats: false }).compile(schema),
  );
});

test("candidate bundle은 workflow와 action과 builder를 불변 SHA로 묶는다", async () => {
  const bundle = await createWorkflowBundle({ sourceSha: SOURCE_SHA });
  const result = await validateWorkflowBundle(bundle);

  assert.equal(result.ok, true);
  assert.equal(bundle.approval.state, "CANDIDATE");
  assert.equal(bundle.platform.state, "UNRESOLVED");
  for (const workflow of Object.values(bundle.reusableWorkflows)) {
    assert.equal(workflow.sha, SOURCE_SHA);
  }
  assert.equal(bundle.buildWorkflows.android.sha, SOURCE_SHA);
  assert.equal(bundle.buildWorkflows.android.executor, "cloud-build-x64");
  for (const action of Object.values(bundle.actions)) {
    assert.match(action.sha, /^[0-9a-f]{40}$/u);
  }
  for (const builder of Object.values(bundle.builders)) {
    assert.match(builder.digest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(builder.architecture, "linux/amd64");
  }
});

test("bundle payload 변조는 integrity 검증에서 거부된다", async () => {
  const bundle = await createWorkflowBundle({ sourceSha: SOURCE_SHA });
  bundle.runners.androidBuild = "ubuntu-latest";
  const result = await validateWorkflowBundle(bundle);

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.includes("INTEGRITY_MISMATCH"));
});

test("RN과 Godot canary 및 platform release가 모두 있어야 approved로 승격된다", async () => {
  const bundle = await createWorkflowBundle({
    sourceSha: SOURCE_SHA,
    platformRelease: {
      sourceSha: "c".repeat(40),
      contractRevision: DIGEST,
      typescript: { version: "1.2.3", digest: DIGEST },
      gdscript: { version: "1.2.3", digest: DIGEST },
    },
  });
  const baseEvidence = {
    repositoryId: 123,
    sourceSha: "d".repeat(40),
    runId: 456,
    artifactSha256: DIGEST,
  };

  await assert.rejects(
    promoteWorkflowBundle(bundle, [
      { ...baseEvidence, profile: "react-native" },
    ]),
    /WORKFLOW_BUNDLE_NOT_PROMOTABLE/u,
  );

  const promoted = await promoteWorkflowBundle(
    bundle,
    [
      { ...baseEvidence, profile: "react-native" },
      { ...baseEvidence, profile: "godot", repositoryId: 124, runId: 457 },
    ],
    { evidenceVerifier: async () => true },
  );
  assert.equal(promoted.approval.state, "APPROVED");
  assert.equal((await validateWorkflowBundle(promoted)).ok, true);
});

test("provider readback verifier 없이 candidate를 로컬 승인할 수 없다", async () => {
  const bundle = await createWorkflowBundle({
    sourceSha: SOURCE_SHA,
    platformRelease: {
      sourceSha: "c".repeat(40),
      contractRevision: DIGEST,
      typescript: { version: "1.2.3", digest: DIGEST },
      gdscript: { version: "1.2.3", digest: DIGEST },
    },
  });
  const evidence = ["react-native", "godot"].map((profile, index) => ({
    profile,
    repositoryId: 123 + index,
    sourceSha: "d".repeat(40),
    runId: 456 + index,
    artifactSha256: DIGEST,
  }));

  await assert.rejects(
    promoteWorkflowBundle(bundle, evidence),
    /CANARY_EVIDENCE_VERIFIER_REQUIRED/u,
  );
  await assert.rejects(
    promoteWorkflowBundle(bundle, evidence, {
      evidenceVerifier: async () => false,
    }),
    /CANARY_EVIDENCE_READBACK_FAILED/u,
  );
});

test("generator는 full SHA thin caller만 만들고 임의 runner와 secret을 두지 않는다", () => {
  for (const profile of ["react-native", "godot"]) {
    const caller = generateOrgContractCaller({
      profile,
      workflowSha: SOURCE_SHA,
      workingDirectory: "apps/mobile",
      packageManager: "pnpm",
    });
    const result = validateOrgContractCaller(caller);

    assert.equal(result.ok, true, `${profile}: ${result.diagnostics}`);
    assert.equal(result.profile, profile);
    assert.doesNotMatch(caller, /secrets:/u);
    assert.doesNotMatch(caller, /runs-on:/u);
    assert.match(caller, new RegExp(`@${SOURCE_SHA}`, "u"));
  }
});

test("weak caller, secrets inherit, wrong runner를 모두 차단한다", () => {
  const valid = generateOrgContractCaller({
    profile: "react-native",
    workflowSha: SOURCE_SHA,
  });
  const weak = valid.replace(`@${SOURCE_SHA}`, "@main");
  const inherited = valid.replace(
    "    with:\n",
    "    secrets: inherit\n    with:\n",
  );
  const arbitraryRunner = valid.replace(
    "    uses:",
    "    runs-on: self-hosted\n    uses:",
  );
  const skipped = valid.replace(
    "    uses:",
    "    if: false\n    uses:",
  );
  const weakTrigger = valid.replace("  pull_request: {}\n", "  schedule:\n    - cron: 0 0 * * *\n");

  assert.ok(
    validateOrgContractCaller(weak).diagnostics.includes(
      "REUSABLE_WORKFLOW_FULL_SHA_REQUIRED",
    ),
  );
  assert.ok(
    validateOrgContractCaller(inherited).diagnostics.includes(
      "SECRET_INHERITANCE_FORBIDDEN",
    ),
  );
  assert.ok(
    validateOrgContractCaller(arbitraryRunner).diagnostics.includes(
      "THIN_CALLER_REQUIRED",
    ),
  );
  assert.ok(
    validateOrgContractCaller(skipped).diagnostics.includes(
      "CALLER_JOB_POLICY_INVALID",
    ),
  );
  assert.ok(
    validateOrgContractCaller(weakTrigger).diagnostics.includes(
      "CALLER_EVENTS_INVALID",
    ),
  );
});

test("profile이 모호하면 caller를 추측 생성하지 않는다", () => {
  assert.throws(
    () =>
      generateOrgContractCaller({
        profile: "unknown",
        workflowSha: SOURCE_SHA,
      }),
    /PROFILE_NEEDS_INPUT/u,
  );
});
