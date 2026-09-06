import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";

import {
  createWorkflowBundleV5,
  generateCandidateBuildCallerV5,
  generateCandidateStaticCallerV5,
  generateBuildCallerV5,
  generateStaticCallerV5,
  generateXcodeCloudRunV5,
  loadApprovedWorkflowBundleV5,
  loadCandidateWorkflowBundleV5,
  loadResolvedWorkflowBindingV5,
  promoteWorkflowBundleV5,
  validateBuildCallerV5,
  validateCandidateBuildCallerV5,
  validateCandidateStaticCallerV5,
  validateStaticCallerV5,
  validateWorkflowBundleV5,
  workflowBundleV5Contract,
} from "../packages/repo-contract/src/workflow-bundle-v5.mjs";
import {
  inspectExactPlatformDependencyV5,
  stageExactPlatformDependencyV5,
} from "../scripts/fleet/stage-private-package-v5.mjs";
import { runStaticPreflightV5 } from "../scripts/fleet/static-preflight-v5.mjs";
import {
  buildRuntimeBindingV5Contract,
  createBuildManifestReadbackV5,
  createStaticManifestReadbackV5,
  requestGithubOidcToken,
  resolveBuildRuntimeBindingV5,
  resolveStaticRuntimeBindingV5,
  staticRuntimeBindingV5Contract,
} from "../scripts/fleet/static-runtime-binding-v5.mjs";
import {
  resolveSafeDirectory,
  resolveSafeFile,
} from "../scripts/fleet/v5-paths.mjs";

const BUNDLE_SOURCE_SHA = "a".repeat(40);
const WORKFLOW_EXECUTION_SHA = "b".repeat(40);
const PLAN_IDENTITY = "e".repeat(64);
const DIGEST = `sha256:${"c".repeat(64)}`;
const roots = [];

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function staticRuntimeContext({
  eventName = "push",
  eventRef = "refs/heads/main",
  applicationSourceSha = "d".repeat(40),
  pullRequestBaseSha = "",
  pullRequestHeadRepository = "",
  calledWorkflowPath = ".github/workflows/js-static-checks-v1.yml",
} = {}) {
  const fullName = "seorilabs/runtime-canary";
  return {
    eventName,
    eventRef,
    applicationSourceSha,
    pullRequestBaseSha,
    pullRequestHeadRepository,
    repositoryId: "7001",
    fullName,
    repositoryPrivate: "true",
    callerWorkflowRef:
      `${fullName}/.github/workflows/org-contract.yml@${eventRef}`,
    jobWorkflowRepository: "seorilabs/.github",
    jobWorkflowSha: WORKFLOW_EXECUTION_SHA,
    jobWorkflowRef:
      `seorilabs/.github/${calledWorkflowPath}@${WORKFLOW_EXECUTION_SHA}`,
    runId: "1234",
    runAttempt: "1",
  };
}

function staticRuntimeResponse(
  request,
  {
    lifecycleState = "ACTIVE",
    staticBinding = {
      profile: "capacitor",
      packageManager: "pnpm",
      workspaceRoot: ".",
      commandDirectory: ".",
    },
    dependencyAuditException,
  } = {},
) {
  const manifest = {
    schemaVersion: 1,
    lifecycleState,
    repositoryId: request.repositoryId,
    fullName: request.fullName,
    sourceSha: request.bindingSourceSha,
    sourceRef: "refs/heads/main",
    observationId: "observation-runtime-1",
    observationDigest: `sha256:${"4".repeat(64)}`,
    configRevisionId: "config-runtime-1",
    configRevision: 7,
    configRevisionDigest: `sha256:${"5".repeat(64)}`,
    signedSnapshotDigest: `sha256:${"6".repeat(64)}`,
    snapshotSignature: {
      keyId: "snapshot-runtime-key",
      policyRevision: "snapshot-runtime-policy-v1",
      digest: `sha256:${"7".repeat(64)}`,
    },
    staticBinding: structuredClone(staticBinding),
    ...(dependencyAuditException === undefined
      ? {}
      : { dependencyAuditException: structuredClone(dependencyAuditException) }),
  };
  return {
    schemaVersion: 1,
    state: "VERIFIED",
    repositoryId: request.repositoryId,
    fullName: request.fullName,
    bindingSourceSha: request.bindingSourceSha,
    applicationSourceSha: request.applicationSourceSha,
    manifestDigest: sha256(JSON.stringify(canonicalize(manifest))),
    manifest,
  };
}

function buildRuntimeContext({
  profile = "react-native-android",
  eventName = "workflow_dispatch",
  eventRef = "refs/heads/main",
  eventSourceSha = "d".repeat(40),
  repositoryId = "7001",
  fullName = "seorilabs/runtime-canary",
  pullRequestBaseSha = "",
  pullRequestHeadRef = "",
  pullRequestHeadRepository = "",
} = {}) {
  const called = profile === "react-native-android"
    ? ".github/workflows/rn-build-android-cloud-v2.yml"
    : ".github/workflows/godot-build-android-cloud-v2.yml";
  return {
    eventName,
    eventRef,
    eventSourceSha,
    pullRequestBaseSha,
    pullRequestHeadRef,
    pullRequestHeadRepository,
    repositoryPrivate: "true",
    repositoryId,
    fullName,
    callerWorkflowRef:
      `${fullName}/.github/workflows/android-build-only.yml@${eventRef}`,
    jobWorkflowRepository: "seorilabs/.github",
    jobWorkflowSha: WORKFLOW_EXECUTION_SHA,
    jobWorkflowRef: `seorilabs/.github/${called}@${WORKFLOW_EXECUTION_SHA}`,
    runId: "1234",
    runAttempt: "1",
    bindingTarget: "android",
  };
}

function candidateBranchRef({
  repositoryId = "1250442131",
  workflowExecutionSha = WORKFLOW_EXECUTION_SHA,
  planIdentity = PLAN_IDENTITY,
} = {}) {
  return (
    `seori/workflow-bundle-v5-canary/${repositoryId}/` +
    `${workflowExecutionSha.slice(0, 12)}/${planIdentity}`
  );
}

function buildRuntimeResponse(
  request,
  { lifecycleState = "ACTIVE", dependencyAuditException } = {},
) {
  const reactNative = request.buildProfile === "react-native-android";
  const manifest = {
    schemaVersion: 1,
    lifecycleState,
    repositoryId: request.repositoryId,
    fullName: request.fullName,
    sourceSha: request.applicationSourceSha,
    sourceRef: "refs/heads/main",
    observationId: "observation-build-runtime-1",
    observationDigest: `sha256:${"4".repeat(64)}`,
    configRevisionId: "config-build-runtime-1",
    configRevision: 7,
    configRevisionDigest: `sha256:${"5".repeat(64)}`,
    signedSnapshotDigest: `sha256:${"6".repeat(64)}`,
    snapshotSignature: {
      keyId: "snapshot-runtime-key",
      policyRevision: "snapshot-runtime-policy-v1",
      digest: `sha256:${"7".repeat(64)}`,
    },
    workflowBundle: {
      sourceSha: request.workflowExecutionSha,
      payloadDigest: DIGEST,
      approvalState: request.mode,
      buildProfiles: ["react-native-android", "godot-android"],
    },
    buildBinding: {
      target: "android",
      buildProfile: request.buildProfile,
      packageManager: reactNative ? "pnpm" : null,
      executionRoot: ".",
      dependencyRoot: ".",
      scriptPath: "scripts/build-android.sh",
      artifactKind: "android-aab",
    },
    ...(dependencyAuditException === undefined
      ? {}
      : { dependencyAuditException: structuredClone(dependencyAuditException) }),
  };
  return {
    schemaVersion: 1,
    state: "VERIFIED",
    mode: request.mode,
    repositoryId: request.repositoryId,
    fullName: request.fullName,
    applicationSourceSha: request.applicationSourceSha,
    eventSourceSha: request.eventSourceSha,
    manifestDigest: sha256(JSON.stringify(canonicalize(manifest))),
    manifest,
  };
}

function dependencyAuditExceptionFixture({
  repositoryId,
  fullName,
  staticSourceSha,
  androidSourceSha,
  staticLockDigest = `sha256:${"1".repeat(64)}`,
  androidLockDigest = `sha256:${"2".repeat(64)}`,
  expiresAt = "2026-09-13T00:00:00Z",
} = {}) {
  return {
    schemaVersion: 1,
    repositoryId,
    fullName,
    expiresAt,
    reason: "공식 patched release가 없는 transitive build-tool advisory의 한시적 build-only 예외",
    bindings: [
      {
        actionClass: "ANDROID_BUILD_ONLY",
        sourceSha: androidSourceSha,
        lockfileSha256: androidLockDigest,
      },
      {
        actionClass: "STATIC_CHECK",
        sourceSha: staticSourceSha,
        lockfileSha256: staticLockDigest,
      },
    ],
    advisories: [
      {
        ghsa: "GHSA-2p57-rm9w-gvfp",
        module: "ip",
        severity: "high",
        versions: ["1.1.9"],
      },
      {
        ghsa: "GHSA-5p2g-fcmc-qvqq",
        module: "image-size",
        severity: "high",
        versions: ["0.6.3", "1.2.1"],
      },
      {
        ghsa: "GHSA-w3rx-r6r6-pgpr",
        module: "image-size",
        severity: "high",
        versions: ["0.6.3", "1.2.1"],
      },
    ],
  };
}

async function fixtureRepository(name) {
  const root = await mkdtemp(join(tmpdir(), `workflow-v5-${name}-`));
  roots.push(root);
  await cp(resolve(`fixtures/workflow-bundle-v5/${name}/repository`), root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  const manifest = JSON.parse(
    await readFile(`fixtures/workflow-bundle-v5/${name}/binding.json`, "utf8"),
  );
  manifest.sourceSha = git(root, ["rev-parse", "HEAD"]);
  return { root, manifest };
}

function evidenceSet(candidate) {
  const base = (repositoryId) => ({
    schemaVersion: 2,
    repositoryId,
    fullName: `seorilabs/canary-${repositoryId}`,
    sourceSha: "d".repeat(40),
    workflowExecutionSha: WORKFLOW_EXECUTION_SHA,
    workflowRef:
      `seorilabs/.github/.github/workflows/canary-v5.yml@${WORKFLOW_EXECUTION_SHA}`,
    runId: 1000 + repositoryId,
    runAttempt: 1,
    configRevisionId: `config-canary-${repositoryId}`,
    configRevision: 1,
    configRevisionDigest: `sha256:${"1".repeat(64)}`,
    signedSnapshotDigest: `sha256:${"2".repeat(64)}`,
    snapshotSignatureKeyId: "snapshot-test-key",
    snapshotSignaturePolicyRevision: "snapshot-policy-v1",
    snapshotSignatureDigest: `sha256:${"3".repeat(64)}`,
    artifactSha256: DIGEST,
  });
  const workflowRef = (path) => `seorilabs/.github/${path}@${WORKFLOW_EXECUTION_SHA}`;
  const staticEvidence = ["react-native", "godot", "capacitor"].map((profile, index) => ({
      target: "static",
      profile,
      bindingSourceSha: "d".repeat(40),
      callerWorkflowRef:
        `seorilabs/canary-${index + 1}/.github/workflows/org-contract.yml@refs/heads/main`,
      manifestDigest: `sha256:${"8".repeat(64)}`,
      ...base(index + 1),
      workflowRef: workflowRef(
        profile === "godot"
          ? ".github/workflows/godot-checks-v3.yml"
          : ".github/workflows/js-static-checks-v1.yml",
      ),
    }));
  const buildEvidence = [
    {
      repositoryId: 1250442131,
      fullName: "seorilabs/happy-farm",
      buildProfile: "react-native-android",
      workflow: ".github/workflows/rn-build-android-cloud-v2.yml",
    },
    {
      repositoryId: 1265192029,
      fullName: "seorilabs/lizard-tycoon",
      buildProfile: "godot-android",
      workflow: ".github/workflows/godot-build-android-cloud-v2.yml",
    },
  ].map((record, index) => ({
    ...base(index + 5),
    target: "build",
    buildProfile: record.buildProfile,
    repositoryId: record.repositoryId,
    fullName: record.fullName,
    bindingSourceSha: "d".repeat(40),
    callerWorkflowRef:
      `${record.fullName}/.github/workflows/android-build-only.yml@refs/pull/${index + 41}/merge`,
    manifestDigest: `sha256:${"8".repeat(64)}`,
    bundlePayloadDigest: candidate.integrity.payloadDigest,
    workflowRef: workflowRef(record.workflow),
    cloudBuildId: `${index + 1}1111111-1111-4111-8111-111111111111`,
    builderImage: candidate.buildProfiles[record.buildProfile].builderImage,
    cloudBuildConfigSha256: candidate.quality.runtimeAssetDigests[
      record.buildProfile === "react-native-android"
        ? ".github/cloud-build/rn-android-build-only-v2.yaml"
        : ".github/cloud-build/godot-android-build-only-v2.yaml"
    ],
    marketUpload: false,
  }));
  return [...staticEvidence, ...buildEvidence];
}

async function approvedBundleBinding() {
  const candidate = await createWorkflowBundleV5({
    sourceSha: BUNDLE_SOURCE_SHA,
    workflowExecutionSha: WORKFLOW_EXECUTION_SHA,
  });
  const evidence = evidenceSet(candidate);
  const approved = await promoteWorkflowBundleV5(candidate, evidence, {
    trustedEvidenceVerifier: async (record) => ({
      ...structuredClone(record),
      state: "VERIFIED",
      identity: `${record.target}:${record.profile ?? record.buildProfile}`,
      evidenceDigest: sha256(JSON.stringify(canonicalize(record))),
    }),
    trustedApprovalSigner: async () => ({
      algorithm: "Ed25519",
      keyId: "workflow-bundle-v5-test",
      policyRevision: "workflow-bundle-policy-v5",
      value: Buffer.alloc(64).toString("base64url"),
    }),
  });
  const binding = await loadApprovedWorkflowBundleV5(approved, {
    trustedApprovalVerifier: async ({ payloadDigest, candidateDigest, approvalPayloadDigest }) => ({
      state: "VERIFIED",
      payloadDigest,
      candidateDigest,
      sourceSha: BUNDLE_SOURCE_SHA,
      workflowExecutionSha: WORKFLOW_EXECUTION_SHA,
      keyId: "workflow-bundle-v5-test",
      policyRevision: "workflow-bundle-policy-v5",
      contractDigestsDigest: sha256(
        JSON.stringify(canonicalize(approved.quality.contractDigests)),
      ),
      runtimeAssetDigestsDigest: sha256(
        JSON.stringify(canonicalize(approved.quality.runtimeAssetDigests)),
      ),
      evidenceDigest: sha256(JSON.stringify(canonicalize(approved.approval.evidence))),
      approvalPayloadDigest,
    }),
  });
  return { candidate, approved, binding };
}

async function resolvedBinding(root, manifest) {
  return loadResolvedWorkflowBindingV5(
    {
      repositoryId: manifest.repositoryId,
      fullName: manifest.fullName,
      sourceSha: manifest.sourceSha,
    },
    {
      repoRoot: root,
      trustedResolvedManifestReadback: async () => ({
        state: "VERIFIED",
        repositoryId: manifest.repositoryId,
        fullName: manifest.fullName,
        sourceSha: manifest.sourceSha,
        manifestDigest: sha256(JSON.stringify(canonicalize(manifest))),
        configRevisionId: manifest.configRevisionId,
        configRevision: manifest.configRevision,
        configRevisionDigest: manifest.configRevisionDigest,
        signedSnapshotDigest: manifest.signedSnapshotDigest,
        snapshotSignatureKeyId: manifest.snapshotSignature.keyId,
        snapshotSignaturePolicyRevision: manifest.snapshotSignature.policyRevision,
        snapshotSignatureDigest: manifest.snapshotSignature.digest,
        manifest: structuredClone(manifest),
      }),
    },
  );
}

test("v5 candidate binds every contract, runtime asset, profile, and immutable workflow SHA", async () => {
  const candidate = await createWorkflowBundleV5({
    sourceSha: BUNDLE_SOURCE_SHA,
    workflowExecutionSha: WORKFLOW_EXECUTION_SHA,
  });
  const validation = await validateWorkflowBundleV5(candidate);
  assert.equal(validation.ok, true, validation.diagnostics.join("\n"));
  assert.deepEqual(Object.keys(candidate.staticProfiles).sort(), [
    "ait-web",
    "capacitor",
    "godot",
    "react-native",
  ]);
  assert.deepEqual(workflowBundleV5Contract.lifecycle, {
    ACTIVE: "ENFORCE",
    PAUSED: "SHADOW",
    DEPRECATED: "NO_CALLER",
  });
  // 번들은 ait-web 실행 경로를 계속 담지만 승인 범위에는 넣지 않는다. 그 프로필을 쓰는
  // 저장소가 모두 폐기돼 증거를 만들 수 없고, 범위에 남기면 모든 승인이 막힌다.
  assert.deepEqual(candidate.promotionScope, {
    staticProfiles: ["react-native", "godot", "capacitor"],
    buildProfiles: ["react-native-android", "godot-android"],
  });
  assert.ok(Object.keys(candidate.staticProfiles).includes("ait-web"));
  assert.deepEqual(workflowBundleV5Contract.promotionScope.buildProfiles, [
    "react-native-android",
    "godot-android",
  ]);
  assert.equal(candidate.callerPolicies.static.namedSecrets.length, 0);
  assert.deepEqual(candidate.callerPolicies.static.permissions, {
    contents: "read",
    "id-token": "write",
    packages: "read",
  });
  assert.deepEqual(candidate.staticRuntimeBinding, {
    origin: staticRuntimeBindingV5Contract.origin,
    endpoint: staticRuntimeBindingV5Contract.endpoint,
    authentication: staticRuntimeBindingV5Contract.authentication,
    audience: staticRuntimeBindingV5Contract.audience,
    sourceStrategy: "event-sha-with-pr-base-binding",
    prPolicy: "trusted-github-pr-readback-required",
    identity: staticRuntimeBindingV5Contract.identity,
    calledWorkflows: staticRuntimeBindingV5Contract.calledWorkflows,
  });
  assert.deepEqual(candidate.quality.godotCanonicalChecks, [
    "public-lock-audit-or-no-managed-dependencies",
    "headless-import",
    "diagnostic-gate",
    "test:core",
    "check:architecture",
    "check:release",
  ]);
  assert.deepEqual(candidate.quality.jsCanonicalScripts, [
    "test:core",
    "check:architecture",
    "check:release",
  ]);
  assert.deepEqual(candidate.actions, {
    checkout: {
      ref: "v7.0.1",
      sha: "3d3c42e5aac5ba805825da76410c181273ba90b1",
    },
    "setup-node": {
      ref: "v7.0.0",
      sha: "820762786026740c76f36085b0efc47a31fe5020",
    },
    "upload-artifact": {
      ref: "v7.0.1",
      sha: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    },
    "download-artifact": {
      ref: "v8.0.1",
      sha: "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    },
    "google-auth": {
      ref: "v3.0.0",
      sha: "7c6bc770dae815cd3e89ee6cdf493a5fab2cc093",
    },
    "setup-gcloud": {
      ref: "v3.0.1",
      sha: "aa5489c8933f4cc7a4f7d45035b3b1440c9c10db",
    },
  });
  assert.deepEqual(
    candidate.staticRuntimeBinding.calledWorkflows,
    workflowBundleV5Contract.staticRuntimeBinding.calledWorkflows,
  );
  assert.deepEqual(
    candidate.buildRuntimeBinding.calledWorkflows,
    workflowBundleV5Contract.buildRuntimeBinding.calledWorkflows,
  );
  assert.equal(
    candidate.buildRuntimeBinding.candidatePolicy,
    "fixed-repository-workflow-sha-and-plan-identity",
  );
  assert.equal(
    candidate.buildRuntimeBinding.candidateBranchTemplate,
    "seori/workflow-bundle-v5-canary/{repositoryId}/{workflowSha12}/{planIdentity}",
  );
  assert.equal(
    buildRuntimeBindingV5Contract.candidateBranchTemplate,
    candidate.buildRuntimeBinding.candidateBranchTemplate,
  );
  assert.equal(candidate.toolchains.godot, "4.7.2");
  assert.equal(
    candidate.staticProfiles.godot.path,
    ".github/workflows/godot-checks-v3.yml",
  );
  assert.equal(
    candidate.quality.contractDigests[
      "contracts/workflow-bundle-v5-static-runtime-readback.schema.json"
    ],
    sha256(await readFile("contracts/workflow-bundle-v5-static-runtime-readback.schema.json")),
  );
  assert.equal(
    candidate.quality.runtimeAssetDigests["scripts/fleet/static-runtime-binding-v5.mjs"],
    sha256(await readFile("scripts/fleet/static-runtime-binding-v5.mjs")),
  );
  assert.equal(candidate.quality.runtimeAssetDigests[".github/workflows/ait-build-only-v1.yml"],
    sha256(await readFile(".github/workflows/ait-build-only-v1.yml")));
  assert.equal(candidate.quality.runtimeAssetDigests[".github/workflows/godot-checks-v3.yml"],
    sha256(await readFile(".github/workflows/godot-checks-v3.yml")));

  const tampered = structuredClone(candidate);
  tampered.quality.runtimeAssetDigests[".github/workflows/ait-build-only-v1.yml"] = DIGEST;
  assert.equal((await validateWorkflowBundleV5(tampered)).ok, false);

  const crossedStaticPath = structuredClone(candidate);
  crossedStaticPath.staticProfiles.godot.path =
    ".github/workflows/js-static-checks-v1.yml";
  const { integrity: _integrity, ...crossedPayload } = crossedStaticPath;
  crossedStaticPath.integrity.payloadDigest =
    sha256(JSON.stringify(canonicalize(crossedPayload)));
  const crossedValidation = await validateWorkflowBundleV5(crossedStaticPath);
  assert.equal(crossedValidation.ok, false);
  assert.ok(crossedValidation.diagnostics.some((diagnostic) =>
    diagnostic.includes("/staticProfiles/godot/path:const")));
});

test("v5 candidate CI runs the cold npm and pnpm fixtures instead of silently skipping them", async () => {
  const workflow = parse(
    await readFile(".github/workflows/workflow-bundle-v5-candidate.yml", "utf8"),
  );
  for (const event of ["pull_request", "push"]) {
    const paths = workflow.on[event].paths;
    assert.ok(
      paths.includes("contracts/workflow-bundle-v5*"),
      `${event} must include the primary v5 schema as well as suffixed contracts`,
    );
    for (const sharedRuntimeAsset of [
      ".github/cloud-build/godot-android-build-only-v2.yaml",
      ".github/cloud-build/rn-android-build-only-v2.yaml",
      ".github/workflows/godot-build-android-cloud-v2.yml",
      ".github/workflows/rn-build-android-cloud-v2.yml",
      "scripts/fleet/secret-scan.mjs",
      // release version authority 구현도 digest-bound runtime asset이다.
      "contracts/release-version-authority.yaml",
      "scripts/release/**.mjs",
    ]) {
      assert.ok(
        paths.includes(sharedRuntimeAsset),
        `${event} must rerun when digest-bound ${sharedRuntimeAsset} changes`,
      );
    }
  }
  const coldCacheStep = workflow.jobs.candidate.steps.find(({ name }) =>
    name === "Validate truly cold npm and pnpm fixture installs");
  assert.equal(coldCacheStep.env.WORKFLOW_BUNDLE_V5_COLD_CACHE, "1");
  assert.match(coldCacheStep.run, /test "\$\(npm --version\)" = 11\.13\.0/u);
  assert.match(coldCacheStep.run, /corepack prepare pnpm@11\.3\.0 --activate/u);
  assert.match(
    coldCacheStep.run,
    /\(cd "\$RUNNER_TEMP" && test "\$\(pnpm --version\)" = 11\.3\.0\)/u,
  );
  assert.match(coldCacheStep.run, /node --test tests\/workflow-bundle-v5-cold-cache\.test\.mjs/u);
});

test("approval requires the promoted static profiles and two exact build-only evidence records", async () => {
  const { candidate, approved } = await approvedBundleBinding();
  assert.equal(approved.approval.state, "APPROVED");
  // 승인 범위(static 3 + build 2)와 필수 증거 수는 같은 값에서 파생된다.
  assert.equal(
    approved.approval.evidence.length,
    workflowBundleV5Contract.promotionScope.staticProfiles.length
      + workflowBundleV5Contract.promotionScope.buildProfiles.length,
  );
  assert.equal(approved.approval.evidence.length, 5);
  await assert.rejects(
    promoteWorkflowBundleV5(candidate, evidenceSet(candidate).slice(0, 3), {
      trustedEvidenceVerifier: async () => ({ state: "VERIFIED" }),
      trustedApprovalSigner: async () => ({}),
    }),
    /WORKFLOW_BUNDLE_EVIDENCE_SET_INVALID/u,
  );
  const wrongWorkflow = evidenceSet(candidate);
  wrongWorkflow[0].workflowRef =
    `seorilabs/.github/.github/workflows/other.yml@${WORKFLOW_EXECUTION_SHA}`;
  await assert.rejects(
    promoteWorkflowBundleV5(candidate, wrongWorkflow, {
      trustedEvidenceVerifier: async () => assert.fail("runtime mismatch must precede readback"),
      trustedApprovalSigner: async () => assert.fail("runtime mismatch must precede signing"),
    }),
    /WORKFLOW_BUNDLE_EVIDENCE_RUNTIME_MISMATCH/u,
  );
  const wrongBuildDigest = evidenceSet(candidate);
  // 첫 build 증거를 어긋나게 해서, 어떤 build readback보다 먼저 멈추는지 본다.
  wrongBuildDigest.find((record) => record.target === "build").bundlePayloadDigest =
    `sha256:${"9".repeat(64)}`;
  await assert.rejects(
    promoteWorkflowBundleV5(candidate, wrongBuildDigest, {
      trustedEvidenceVerifier: async (record) => {
        if (record.target === "build") assert.fail("bundle drift must precede build readback");
        return {
          ...structuredClone(record),
          state: "VERIFIED",
          identity: `${record.target}:${record.profile}`,
          evidenceDigest: sha256(JSON.stringify(canonicalize(record))),
        };
      },
      trustedApprovalSigner: async () => assert.fail("bundle drift must precede signing"),
    }),
    /WORKFLOW_BUNDLE_EVIDENCE_RUNTIME_MISMATCH/u,
  );
  await assert.rejects(
    promoteWorkflowBundleV5(candidate, evidenceSet(candidate), {
      trustedEvidenceVerifier: async (record) => ({
        ...structuredClone(record),
        state: "VERIFIED",
        identity: `${record.target}:${record.profile ?? record.buildProfile}`,
        runAttempt: record.runAttempt + 1,
        evidenceDigest: sha256(JSON.stringify(canonicalize(record))),
      }),
      trustedApprovalSigner: async () => assert.fail("drifted readback must precede signing"),
    }),
    /WORKFLOW_BUNDLE_EVIDENCE_UNTRUSTED/u,
  );
  await assert.rejects(
    loadApprovedWorkflowBundleV5(approved, {
      trustedApprovalVerifier: async ({ payloadDigest, candidateDigest, approvalPayloadDigest }) => ({
        state: "VERIFIED",
        payloadDigest,
        candidateDigest,
        sourceSha: "0".repeat(40),
        workflowExecutionSha: WORKFLOW_EXECUTION_SHA,
        keyId: "workflow-bundle-v5-test",
        policyRevision: "workflow-bundle-policy-v5",
        contractDigestsDigest: sha256(
          JSON.stringify(canonicalize(approved.quality.contractDigests)),
        ),
        runtimeAssetDigestsDigest: sha256(
          JSON.stringify(canonicalize(approved.quality.runtimeAssetDigests)),
        ),
        evidenceDigest: sha256(JSON.stringify(canonicalize(approved.approval.evidence))),
        approvalPayloadDigest,
      }),
    }),
    /WORKFLOW_BUNDLE_APPROVAL_UNTRUSTED/u,
  );
});

test("v5 approval signs one canonical public envelope through the shared logical credential", async () => {
  const candidate = await createWorkflowBundleV5({
    sourceSha: WORKFLOW_EXECUTION_SHA,
    workflowExecutionSha: WORKFLOW_EXECUTION_SHA,
  });
  const evidence = evidenceSet(candidate);
  let signingRequest;
  await promoteWorkflowBundleV5(candidate, evidence, {
    trustedEvidenceVerifier: async (record) => ({
      ...structuredClone(record),
      state: "VERIFIED",
      identity: `${record.target}:${record.profile ?? record.buildProfile}`,
      evidenceDigest: sha256(JSON.stringify(canonicalize(record))),
    }),
    trustedApprovalSigner: async (request) => {
      signingRequest = {
        ...structuredClone(request),
        payload: Buffer.from(request.payload),
      };
      return {
        algorithm: "Ed25519",
        keyId: "workflow-bundle-v5-test",
        policyRevision: "workflow-bundle-policy-v5",
        value: Buffer.alloc(64).toString("base64url"),
      };
    },
  });
  assert.equal(signingRequest.algorithm, "Ed25519");
  assert.equal(signingRequest.credentialId, "shared/workflow-bundle/approval-signing");
  assert.equal(signingRequest.keyPurpose, "WORKFLOW_BUNDLE_V5_APPROVAL");
  assert.equal(signingRequest.registryId, "seorilabs-workflow-bundles-v5");
  assert.equal(signingRequest.subject, `workflow-bundle-v5:${WORKFLOW_EXECUTION_SHA}`);
  assert.equal(signingRequest.kind, "WORKFLOW_BUNDLE_V5_APPROVAL");
  const envelope = {
    schemaVersion: signingRequest.schemaVersion,
    kind: signingRequest.kind,
    registryId: signingRequest.registryId,
    subject: signingRequest.subject,
    bundleVersion: signingRequest.bundleVersion,
    source: signingRequest.source,
    candidateDigest: signingRequest.candidateDigest,
    evidenceDigest: signingRequest.evidenceDigest,
    contractDigestsDigest: signingRequest.contractDigestsDigest,
    runtimeAssetDigestsDigest: signingRequest.runtimeAssetDigestsDigest,
  };
  assert.equal(
    signingRequest.payload.toString("utf8"),
    JSON.stringify(canonicalize(envelope)),
  );
  assert.equal(signingRequest.payloadDigest, sha256(signingRequest.payload));
});

test("unpromoted Capacitor and AIT build profiles remain fail-closed", async () => {
  const [{ root, manifest }, { binding: bundle }] = await Promise.all([
    fixtureRepository("saju-reader"),
    approvedBundleBinding(),
  ]);
  const preflight = await runStaticPreflightV5({ repoRoot: root, staticBinding: manifest.staticBinding });
  assert.equal(preflight.profile, "capacitor");
  assert.deepEqual(preflight.commands, [
    "pnpm test:core",
    "pnpm check:architecture",
    "pnpm check:release",
  ]);
  const resolved = await resolvedBinding(root, manifest);
  const staticCaller = generateStaticCallerV5({ approvedBundleBinding: bundle, resolvedBinding: resolved });
  assert.match(staticCaller, new RegExp(`js-static-checks-v1\\.yml@${WORKFLOW_EXECUTION_SHA}`, "u"));
  assert.match(staticCaller, /id-token: write/u);
  assert.doesNotMatch(
    staticCaller,
    /\bwith:|source_sha|config_revision|signed_snapshot|enforcement_mode|secrets:|@main\b/u,
  );
  assert.equal(validateStaticCallerV5(staticCaller, {
    approvedBundleBinding: bundle,
    resolvedBinding: resolved,
  }).ok, true);

  const androidOptions = {
    approvedBundleBinding: bundle,
    resolvedBinding: resolved,
    target: "android",
  };
  assert.throws(() => generateBuildCallerV5(androidOptions), /BUILD_PROFILE_NOT_PROMOTED/u);
  assert.deepEqual(validateBuildCallerV5("", androidOptions), {
    ok: false,
    diagnostics: ["BUILD_PROFILE_NOT_PROMOTED"],
  });
  assert.throws(() => generateBuildCallerV5({
    ...androidOptions,
    target: "ait",
  }), /BUILD_PROFILE_NOT_PROMOTED/u);

  await assert.rejects(
    generateXcodeCloudRunV5({
      approvedBundleBinding: bundle,
      resolvedBinding: resolved,
      productId: "product-saju",
      workflowId: "workflow-saju",
      sourceReferenceId: "main-reference-saju",
    }),
    /BUILD_PROFILE_NOT_PROMOTED/u,
  );
});

test("trait fixture keeps root static commands and nested Granite AIT execution", async () => {
  const [{ root, manifest }, { binding: bundle }] = await Promise.all([
    fixtureRepository("trait-test-hub"),
    approvedBundleBinding(),
  ]);
  const preflight = await runStaticPreflightV5({ repoRoot: root, staticBinding: manifest.staticBinding });
  assert.equal(preflight.profile, "react-native");
  const resolved = await resolvedBinding(root, manifest);
  assert.throws(() => generateBuildCallerV5({
    approvedBundleBinding: bundle,
    resolvedBinding: resolved,
    target: "ait",
  }), /BUILD_PROFILE_NOT_PROMOTED/u);

  const splitOutsideDependency = structuredClone(manifest);
  splitOutsideDependency.buildBindings[0].dependencyRoot = "apps/ait";
  await assert.rejects(
    resolvedBinding(root, splitOutsideDependency),
    /BUILD_BINDING_PATH_RELATION_INVALID/u,
  );
});

test("Godot v3 fixture generates a stable dynamic caller without package authority", async () => {
  const [{ root, manifest }, { binding: bundle }] = await Promise.all([
    fixtureRepository("godot-runtime"),
    approvedBundleBinding(),
  ]);
  const preflight = await runStaticPreflightV5({
    repoRoot: root,
    staticBinding: manifest.staticBinding,
  });
  assert.deepEqual(preflight, {
    profile: "godot",
    packageManager: null,
    workspaceRoot: ".",
    commandDirectory: ".",
    dependencyMode: "NO_MANAGED_DEPENDENCIES",
    commands: [
      "npm run test:core",
      "npm run check:architecture",
      "npm run check:release",
    ],
  });
  const npmConfigRoot = await mkdtemp(join(tmpdir(), "workflow-v5-godot-npm-config-"));
  roots.push(npmConfigRoot);
  const npmUserConfig = join(npmConfigRoot, "user.npmrc");
  const npmGlobalConfig = join(npmConfigRoot, "global.npmrc");
  await Promise.all([
    writeFile(npmUserConfig, ""),
    writeFile(npmGlobalConfig, ""),
  ]);
  for (const script of ["test:core", "check:architecture", "check:release"]) {
    const result = spawnSync("npm", [
      "--location=global",
      `--prefix=${root}`,
      "--ignore-scripts",
      "run",
      script,
    ], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
        NPM_CONFIG_USERCONFIG: npmUserConfig,
        NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
        NPM_CONFIG_LOCATION: "global",
      },
    });
    assert.equal(result.status, 0, `${script}\n${result.stdout}\n${result.stderr}`);
  }

  const initialBinding = await resolvedBinding(root, manifest);
  const caller = generateStaticCallerV5({
    approvedBundleBinding: bundle,
    resolvedBinding: initialBinding,
  });
  assert.match(
    caller,
    new RegExp(`godot-checks-v3\\.yml@${WORKFLOW_EXECUTION_SHA}`, "u"),
  );
  assert.match(caller, /id-token: write/u);
  assert.doesNotMatch(caller, /packages:|\bwith:|secrets:|@main\b/u);
  assert.equal(validateStaticCallerV5(caller, {
    approvedBundleBinding: bundle,
    resolvedBinding: initialBinding,
  }).ok, true);

  await mkdir(join(root, ".github/workflows"), { recursive: true });
  await writeFile(join(root, ".github/workflows/org-contract.yml"), caller);
  git(root, ["add", ".github/workflows/org-contract.yml"]);
  git(root, ["commit", "-qm", "install dynamic Godot caller"]);
  const installSha = git(root, ["rev-parse", "HEAD"]);
  const verifySource = async (sourceSha) => {
    const binding = await resolvedBinding(root, { ...manifest, sourceSha });
    assert.equal(generateStaticCallerV5({
      approvedBundleBinding: bundle,
      resolvedBinding: binding,
    }), caller);
    const context = staticRuntimeContext({
      applicationSourceSha: sourceSha,
      calledWorkflowPath: ".github/workflows/godot-checks-v3.yml",
    });
    const runtime = await resolveStaticRuntimeBindingV5(context, {
      trustedManifestReadback: async (request) => {
        assert.equal(request.calledWorkflowPath, ".github/workflows/godot-checks-v3.yml");
        return staticRuntimeResponse(request, { staticBinding: manifest.staticBinding });
      },
    });
    assert.equal(runtime.applicationSourceSha, sourceSha);
    assert.equal(runtime.calledWorkflowPath, ".github/workflows/godot-checks-v3.yml");
    assert.equal(runtime.profile, "godot");
    assert.equal(runtime.packageManager, null);
  };
  await verifySource(installSha);

  await writeFile(join(root, "next-source.txt"), "next source\n");
  git(root, ["add", "next-source.txt"]);
  git(root, ["commit", "-qm", "next Godot source"]);
  const nextSha = git(root, ["rev-parse", "HEAD"]);
  await verifySource(nextSha);
});

test("candidate canary generator permits only Happy Farm RN and Lizard Tycoon Godot", async () => {
  const candidate = await createWorkflowBundleV5({
    sourceSha: WORKFLOW_EXECUTION_SHA,
    workflowExecutionSha: WORKFLOW_EXECUTION_SHA,
  });
  const candidateBundleBinding = await loadCandidateWorkflowBundleV5(candidate, {
    trustedCandidateVerifier: async () => ({
      state: "VERIFIED",
      payloadDigest: candidate.integrity.payloadDigest,
      sourceSha: WORKFLOW_EXECUTION_SHA,
      workflowExecutionSha: WORKFLOW_EXECUTION_SHA,
      contractDigestsDigest: sha256(JSON.stringify(canonicalize(candidate.quality.contractDigests))),
      runtimeAssetDigestsDigest:
        sha256(JSON.stringify(canonicalize(candidate.quality.runtimeAssetDigests))),
    }),
  });
  const approved = await approvedBundleBinding();
  const fixtures = [
    {
      fixture: "saju-reader",
      repositoryId: "1250442131",
      fullName: "seorilabs/happy-farm",
      staticBinding: {
        profile: "react-native",
        packageManager: "pnpm",
        workspaceRoot: ".",
        commandDirectory: ".",
      },
      buildProfile: "react-native-android",
      staticWorkflow: "js-static-checks-v1.yml",
      workflow: "rn-build-android-cloud-v2.yml",
      permissions: ["contents: read", "id-token: write", "packages: read"],
    },
    {
      fixture: "godot-runtime",
      repositoryId: "1265192029",
      fullName: "seorilabs/lizard-tycoon",
      staticBinding: {
        profile: "godot",
        packageManager: null,
        workspaceRoot: ".",
        commandDirectory: ".",
      },
      buildProfile: "godot-android",
      staticWorkflow: "godot-checks-v3.yml",
      workflow: "godot-build-android-cloud-v2.yml",
      permissions: ["contents: read", "id-token: write"],
    },
  ];
  for (const fixture of fixtures) {
    const { root, manifest: original } = await fixtureRepository(fixture.fixture);
    if (fixture.fixture === "godot-runtime") {
      await writeFile(join(root, "build.env"), "BUILD_MODE=test\n");
      await writeFile(join(root, "scripts/build-android.sh"), "#!/usr/bin/env bash\nexit 0\n");
      git(root, ["add", "build.env", "scripts/build-android.sh"]);
      git(root, ["commit", "-qm", "add build-only fixture"]);
    }
    const manifest = {
      ...original,
      repositoryId: fixture.repositoryId,
      fullName: fixture.fullName,
      sourceSha: git(root, ["rev-parse", "HEAD"]),
      staticBinding: fixture.staticBinding,
      workflowBundleBinding: {
        sourceSha: candidate.source.sha,
        payloadDigest: candidate.integrity.payloadDigest,
      },
      buildBindings: [{
        target: "android",
        buildProfile: fixture.buildProfile,
        executionRoot: ".",
        dependencyRoot: ".",
        scriptPath: "scripts/build-android.sh",
        artifactKind: "android-aab",
      }],
    };
    const resolved = await resolvedBinding(root, manifest);
    const candidateStaticCaller = generateCandidateStaticCallerV5({
      candidateBundleBinding,
      resolvedBinding: resolved,
    });
    const candidateStaticDocument = parse(candidateStaticCaller);
    assert.deepEqual(candidateStaticDocument.on, {
      pull_request: { paths: [".github/workflows/org-contract.yml"] },
    });
    assert.equal(
      candidateStaticDocument.jobs["org-contract"].uses,
      `seorilabs/.github/.github/workflows/${fixture.staticWorkflow}@${WORKFLOW_EXECUTION_SHA}`,
    );
    assert.equal(candidateStaticDocument.permissions["id-token"], "write");
    assert.doesNotMatch(
      candidateStaticCaller,
      /push:|workflow_dispatch:|\bwith:|secrets:|runs-on:|@main\b/u,
    );
    assert.equal(validateCandidateStaticCallerV5(candidateStaticCaller, {
      candidateBundleBinding,
      resolvedBinding: resolved,
    }).ok, true);

    const candidateCaller = generateCandidateBuildCallerV5({
      candidateBundleBinding,
      resolvedBinding: resolved,
      target: "android",
    });
    assert.match(candidateCaller, new RegExp(`${fixture.workflow}@${WORKFLOW_EXECUTION_SHA}`, "u"));
    assert.match(candidateCaller, /pull_request:/u);
    assert.doesNotMatch(candidateCaller, /workflow_dispatch:|\bwith:|secrets:|runs-on:|@main\b/u);
    for (const permission of fixture.permissions) assert.match(candidateCaller, new RegExp(permission, "u"));
    assert.equal(validateCandidateBuildCallerV5(candidateCaller, {
      candidateBundleBinding,
      resolvedBinding: resolved,
      target: "android",
    }).ok, true);

    const approvedManifest = {
      ...manifest,
      workflowBundleBinding: {
        sourceSha: approved.approved.source.sha,
        payloadDigest: approved.approved.integrity.payloadDigest,
      },
    };
    const approvedResolved = await resolvedBinding(root, approvedManifest);
    const approvedCaller = generateBuildCallerV5({
      approvedBundleBinding: approved.binding,
      resolvedBinding: approvedResolved,
      target: "android",
    });
    assert.match(approvedCaller, /workflow_dispatch:/u);
    assert.doesNotMatch(approvedCaller, /pull_request:|\bwith:|secrets:|runs-on:|@main\b/u);
  }

  const { root, manifest: original } = await fixtureRepository("saju-reader");
  const crossed = {
    ...original,
    repositoryId: "1250442131",
    fullName: "seorilabs/happy-farm",
    sourceSha: git(root, ["rev-parse", "HEAD"]),
    staticBinding: {
      profile: "godot",
      packageManager: null,
      workspaceRoot: ".",
      commandDirectory: ".",
    },
    workflowBundleBinding: {
      sourceSha: candidate.source.sha,
      payloadDigest: candidate.integrity.payloadDigest,
    },
    buildBindings: [{
      target: "android",
      buildProfile: "godot-android",
      executionRoot: ".",
      dependencyRoot: ".",
      scriptPath: "scripts/build-android.sh",
      artifactKind: "android-aab",
    }],
  };
  const crossedBinding = await resolvedBinding(root, crossed);
  assert.throws(() => generateCandidateStaticCallerV5({
    candidateBundleBinding,
    resolvedBinding: crossedBinding,
  }), /CANDIDATE_STATIC_REPOSITORY_NOT_ALLOWED/u);
  assert.throws(() => generateCandidateBuildCallerV5({
    candidateBundleBinding,
    resolvedBinding: crossedBinding,
    target: "android",
  }), /CANDIDATE_BUILD_REPOSITORY_NOT_ALLOWED/u);
});

test("Godot preflight runs from the central checkout without npm runtime bootstrap", async () => {
  const [{ root }, isolatedRuntime] = await Promise.all([
    fixtureRepository("godot-runtime"),
    mkdtemp(join(tmpdir(), "workflow-v5-godot-runtime-")),
  ]);
  roots.push(isolatedRuntime);
  const scriptRoot = join(isolatedRuntime, "scripts/fleet");
  await mkdir(scriptRoot, { recursive: true });
  await Promise.all([
    cp("scripts/fleet/static-preflight-v5.mjs", join(scriptRoot, "static-preflight-v5.mjs")),
    cp("scripts/fleet/v5-paths.mjs", join(scriptRoot, "v5-paths.mjs")),
  ]);
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      'import { pathToFileURL } from "node:url";',
      'const { runStaticPreflightV5 } = await import(pathToFileURL(process.argv[1]));',
      'const result = await runStaticPreflightV5({ repoRoot: process.argv[2], staticBinding: { profile: "godot", packageManager: null, workspaceRoot: ".", commandDirectory: "." } });',
      'if (result.dependencyMode !== "NO_MANAGED_DEPENDENCIES" || result.commands.join(",") !== "npm run test:core,npm run check:architecture,npm run check:release") process.exit(1);',
      'process.stdout.write("isolated Godot preflight passed\\n");',
    ].join("\n"),
    join(scriptRoot, "static-preflight-v5.mjs"),
    root,
  ], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /isolated Godot preflight passed/u);
});

test("Godot preflight CLI preserves the exact missing quality script diagnostic", async () => {
  const { root, manifest } = await fixtureRepository("godot-runtime");
  const packagePath = join(root, "package.json");
  const packageManifest = JSON.parse(await readFile(packagePath, "utf8"));
  delete packageManifest.scripts["check:release"];
  await writeFile(packagePath, `${JSON.stringify(packageManifest, null, 2)}\n`);

  const result = spawnSync(process.execPath, [
    resolve("scripts/fleet/static-preflight-v5.mjs"),
    "--repo-root",
    root,
    "--profile",
    manifest.staticBinding.profile,
    "--package-manager",
    "null",
    "--workspace-root",
    manifest.staticBinding.workspaceRoot,
    "--command-directory",
    manifest.staticBinding.commandDirectory,
    "--github-output",
    join(root, "github-output"),
  ], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /오류: QUALITY_SCRIPT_MISSING_check:release/u);
  assert.doesNotMatch(result.stderr, /STATIC_PREFLIGHT_FAILED/u);
});

test("Godot preflight requires exact scripts and classifies dependency audit state", async () => {
  const [missingScript, unlockedDependency, publicLock] = await Promise.all([
    fixtureRepository("godot-runtime"),
    fixtureRepository("godot-runtime"),
    fixtureRepository("godot-runtime"),
  ]);

  const missingPath = join(missingScript.root, "package.json");
  const missingPackage = JSON.parse(await readFile(missingPath, "utf8"));
  delete missingPackage.scripts["check:release"];
  await writeFile(missingPath, `${JSON.stringify(missingPackage, null, 2)}\n`);
  await assert.rejects(
    runStaticPreflightV5({
      repoRoot: missingScript.root,
      staticBinding: missingScript.manifest.staticBinding,
    }),
    /QUALITY_SCRIPT_MISSING_check:release/u,
  );

  const unlockedPath = join(unlockedDependency.root, "package.json");
  const unlockedPackage = JSON.parse(await readFile(unlockedPath, "utf8"));
  unlockedPackage.dependencies = { "public-package": "1.0.0" };
  await writeFile(unlockedPath, `${JSON.stringify(unlockedPackage, null, 2)}\n`);
  await assert.rejects(
    runStaticPreflightV5({
      repoRoot: unlockedDependency.root,
      staticBinding: unlockedDependency.manifest.staticBinding,
    }),
    /GODOT_DEPENDENCY_LOCK_REQUIRED/u,
  );

  const publicPackagePath = join(publicLock.root, "package.json");
  const publicPackage = JSON.parse(await readFile(publicPackagePath, "utf8"));
  publicPackage.dependencies = { "public-package": "1.0.0" };
  await writeFile(publicPackagePath, `${JSON.stringify(publicPackage, null, 2)}\n`);
  const publicLockPath = join(publicLock.root, "package-lock.json");
  const publicLockValue = {
    name: publicPackage.name,
    version: publicPackage.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: publicPackage.name,
        version: publicPackage.version,
        dependencies: { "public-package": "1.0.0" },
      },
      "node_modules/public-package": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/public-package/-/public-package-1.0.0.tgz",
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      },
    },
  };
  await writeFile(publicLockPath, `${JSON.stringify(publicLockValue, null, 2)}\n`);
  git(publicLock.root, ["add", "package.json", "package-lock.json"]);
  git(publicLock.root, ["commit", "-qm", "add public lock"]);
  const audited = await runStaticPreflightV5({
    repoRoot: publicLock.root,
    staticBinding: publicLock.manifest.staticBinding,
  });
  assert.equal(audited.dependencyMode, "PUBLIC_NPM_LOCK_AUDIT");

  publicLockValue.packages["node_modules/public-package"].resolved =
    "https://runner-metadata.internal/public-package.tgz";
  await writeFile(publicLockPath, `${JSON.stringify(publicLockValue, null, 2)}\n`);
  await assert.rejects(
    runStaticPreflightV5({
      repoRoot: publicLock.root,
      staticBinding: publicLock.manifest.staticBinding,
    }),
    /GODOT_DEPENDENCY_SOURCE_FORBIDDEN/u,
  );
});

test("lifecycle is fail-closed: PAUSED is static shadow only and DEPRECATED has no caller", async () => {
  const [{ root, manifest }, { binding: bundle }] = await Promise.all([
    fixtureRepository("saju-reader"),
    approvedBundleBinding(),
  ]);
  const activeBinding = await resolvedBinding(root, manifest);
  const activeCaller = generateStaticCallerV5({
    approvedBundleBinding: bundle,
    resolvedBinding: activeBinding,
  });
  const paused = { ...manifest, state: "PAUSED" };
  const pausedBinding = await resolvedBinding(root, paused);
  assert.equal(generateStaticCallerV5({
    approvedBundleBinding: bundle,
    resolvedBinding: pausedBinding,
  }), activeCaller);
  assert.doesNotMatch(activeCaller, /enforcement_mode|config_revision|source_sha/u);
  assert.throws(() => generateBuildCallerV5({
    approvedBundleBinding: bundle,
    resolvedBinding: pausedBinding,
    target: "ait",
  }), /PAUSED_BUILD_CALLER_FORBIDDEN/u);

  const deprecated = { ...manifest, state: "DEPRECATED" };
  const deprecatedBinding = await resolvedBinding(root, deprecated);
  assert.throws(() => generateStaticCallerV5({
    approvedBundleBinding: bundle,
    resolvedBinding: deprecatedBinding,
  }), /DEPRECATED_NO_CALLER/u);
  assert.throws(() => generateBuildCallerV5({
    approvedBundleBinding: bundle,
    resolvedBinding: deprecatedBinding,
    target: "ait",
  }), /DEPRECATED_BUILD_CALLER_FORBIDDEN/u);
});

test("static caller has no source self-reference and remains exact across caller and app commits", async () => {
  const [{ root, manifest }, { binding: bundle }] = await Promise.all([
    fixtureRepository("saju-reader"),
    approvedBundleBinding(),
  ]);
  const initialBinding = await resolvedBinding(root, manifest);
  const caller = generateStaticCallerV5({
    approvedBundleBinding: bundle,
    resolvedBinding: initialBinding,
  });
  assert.doesNotMatch(
    caller,
    /\bwith:|source_sha|config_revision|signed_snapshot|snapshot_signature|enforcement_mode/u,
  );

  await mkdir(join(root, ".github/workflows"), { recursive: true });
  await writeFile(join(root, ".github/workflows/org-contract.yml"), caller);
  git(root, ["add", ".github/workflows/org-contract.yml"]);
  git(root, ["commit", "-qm", "install generic static caller"]);
  const callerCommitSha = git(root, ["rev-parse", "HEAD"]);
  const callerCommitManifest = { ...manifest, sourceSha: callerCommitSha };
  const callerCommitBinding = await resolvedBinding(root, callerCommitManifest);
  assert.equal(generateStaticCallerV5({
    approvedBundleBinding: bundle,
    resolvedBinding: callerCommitBinding,
  }), caller);

  await writeFile(join(root, "runtime-next-commit.txt"), "next application source\n");
  git(root, ["add", "runtime-next-commit.txt"]);
  git(root, ["commit", "-qm", "next application commit"]);
  const nextCommitSha = git(root, ["rev-parse", "HEAD"]);
  const nextCommitManifest = { ...manifest, sourceSha: nextCommitSha };
  const nextCommitBinding = await resolvedBinding(root, nextCommitManifest);
  assert.equal(generateStaticCallerV5({
    approvedBundleBinding: bundle,
    resolvedBinding: nextCommitBinding,
  }), caller);

  for (const sourceSha of [callerCommitSha, nextCommitSha]) {
    const context = staticRuntimeContext({ applicationSourceSha: sourceSha });
    const runtime = await resolveStaticRuntimeBindingV5(context, {
      trustedManifestReadback: async (request) => staticRuntimeResponse(request),
    });
    assert.equal(runtime.applicationSourceSha, sourceSha);
    assert.equal(runtime.bindingSourceSha, sourceSha);
    assert.equal(runtime.enforcementMode, "ENFORCE");
  }
});

test("same-repo PR binds merge, base, and called path while trusted drift readback fails closed", async () => {
  const mergeSha = "8".repeat(40);
  const baseSha = "9".repeat(40);
  const eventRef = "refs/pull/37/merge";
  const context = staticRuntimeContext({
    eventName: "pull_request",
    eventRef,
    applicationSourceSha: mergeSha,
    pullRequestBaseSha: baseSha,
    pullRequestHeadRepository: "seorilabs/runtime-canary",
  });
  const request = {
    repositoryId: context.repositoryId,
    fullName: context.fullName,
    applicationSourceSha: mergeSha,
    bindingSourceSha: baseSha,
  };
  const response = staticRuntimeResponse(request);
  const schema = JSON.parse(
    await readFile("contracts/workflow-bundle-v5-static-runtime-readback.schema.json", "utf8"),
  );
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(response), true, JSON.stringify(validate.errors));

  let readbackCalls = 0;
  const runtime = await resolveStaticRuntimeBindingV5(context, {
    trustedManifestReadback: async (runtimeRequest) => {
      readbackCalls += 1;
      assert.deepEqual(runtimeRequest, {
        repositoryId: context.repositoryId,
        fullName: context.fullName,
        applicationSourceSha: mergeSha,
        bindingSourceSha: baseSha,
        callerWorkflowRef: context.callerWorkflowRef,
        calledWorkflowRef: context.jobWorkflowRef,
        calledWorkflowPath: ".github/workflows/js-static-checks-v1.yml",
        runId: context.runId,
        runAttempt: context.runAttempt,
      });
      return structuredClone(response);
    },
  });
  assert.equal(readbackCalls, 1);
  assert.equal(runtime.applicationSourceSha, mergeSha);
  assert.equal(runtime.bindingSourceSha, baseSha);

  for (const attack of [
    { pullRequestHeadRepository: "attacker/fork" },
    { callerWorkflowRef: `${context.fullName}/.github/workflows/other.yml@${eventRef}` },
    { jobWorkflowRef: `seorilabs/.github/.github/workflows/other.yml@${WORKFLOW_EXECUTION_SHA}` },
  ]) {
    let attackReadbackCalls = 0;
    await assert.rejects(
      resolveStaticRuntimeBindingV5({ ...context, ...attack }, {
        trustedManifestReadback: async (runtimeRequest) => {
          attackReadbackCalls += 1;
          return staticRuntimeResponse(runtimeRequest);
        },
      }),
      /STATIC_RUNTIME_(?:PULL_REQUEST|CALLER_WORKFLOW|CALLED_WORKFLOW)_IDENTITY_INVALID/u,
    );
    assert.equal(attackReadbackCalls, 0);
  }

  const token = "header.payload.signature";
  for (const scenario of [
    {
      label: "base drift",
      context: { ...context, pullRequestBaseSha: "7".repeat(40) },
      expectedRef: "7".repeat(40),
      expectedApplicationRef: mergeSha,
    },
    {
      label: "merge or head substitution",
      context: { ...context, applicationSourceSha: "6".repeat(40) },
      expectedRef: baseSha,
      expectedApplicationRef: "6".repeat(40),
    },
    {
      label: "trusted head readback mismatch",
      context,
      expectedRef: baseSha,
      expectedApplicationRef: mergeSha,
    },
  ]) {
    let calls = 0;
    const rejectingReadback = createStaticManifestReadbackV5({
      oidcTokenProvider: async () => token,
      fetchImpl: async (input) => {
        calls += 1;
        const url = new URL(input);
        assert.equal(url.searchParams.get("ref"), scenario.expectedRef, scenario.label);
        assert.equal(
          url.searchParams.get("application_ref"),
          scenario.expectedApplicationRef,
          scenario.label,
        );
        return new Response("{}", { status: 401 });
      },
    });
    await assert.rejects(
      resolveStaticRuntimeBindingV5(scenario.context, {
        trustedManifestReadback: rejectingReadback,
      }),
      /STATIC_RUNTIME_MANIFEST_HTTP_401/u,
    );
    assert.equal(calls, 1, scenario.label);
  }

  let staleCalls = 0;
  const staleReadback = createStaticManifestReadbackV5({
    oidcTokenProvider: async () => token,
    waitImpl: async () => undefined,
    fetchImpl: async () => {
      staleCalls += 1;
      return new Response("{}", { status: 409 });
    },
  });
  await assert.rejects(
    resolveStaticRuntimeBindingV5(context, { trustedManifestReadback: staleReadback }),
    /STATIC_RUNTIME_MANIFEST_HTTP_409/u,
  );
  assert.equal(staleCalls, 8);

  const pushContext = staticRuntimeContext({ applicationSourceSha: baseSha });
  const tampered = staticRuntimeResponse({
    repositoryId: pushContext.repositoryId,
    fullName: pushContext.fullName,
    applicationSourceSha: baseSha,
    bindingSourceSha: baseSha,
  });
  tampered.manifest.staticBinding.workspaceRoot = "apps/mobile";
  await assert.rejects(
    resolveStaticRuntimeBindingV5(pushContext, {
      trustedManifestReadback: async () => tampered,
    }),
    /STATIC_RUNTIME_READBACK_INVALID/u,
  );
});

test("signed dependency audit exception is exact-source, scoped, ordered, and time-bound", async () => {
  const staticContext = staticRuntimeContext({ applicationSourceSha: "8".repeat(40) });
  const staticException = dependencyAuditExceptionFixture({
    repositoryId: staticContext.repositoryId,
    fullName: staticContext.fullName,
    staticSourceSha: staticContext.applicationSourceSha,
    androidSourceSha: "9".repeat(40),
  });
  const staticBinding = await resolveStaticRuntimeBindingV5(staticContext, {
    now: () => new Date("2026-08-30T00:00:00Z"),
    trustedManifestReadback: async (request) => staticRuntimeResponse(request, {
      dependencyAuditException: staticException,
    }),
  });
  assert.deepEqual(
    JSON.parse(Buffer.from(staticBinding.dependencyAuditException, "base64url").toString("utf8")),
    canonicalize(staticException),
  );

  const prStaticContext = staticRuntimeContext({
    eventName: "pull_request",
    eventRef: "refs/pull/41/merge",
    applicationSourceSha: "a".repeat(40),
    pullRequestBaseSha: "8".repeat(40),
    pullRequestHeadRepository: "seorilabs/runtime-canary",
  });
  const prStaticBinding = await resolveStaticRuntimeBindingV5(prStaticContext, {
    now: () => new Date("2026-08-30T00:00:00Z"),
    trustedManifestReadback: async (request) => staticRuntimeResponse(request, {
      dependencyAuditException: staticException,
    }),
  });
  assert.deepEqual(
    JSON.parse(Buffer.from(prStaticBinding.dependencyAuditException, "base64url").toString("utf8")),
    canonicalize(staticException),
  );
  await assert.rejects(
    resolveStaticRuntimeBindingV5(prStaticContext, {
      now: () => new Date("2026-08-30T00:00:00Z"),
      trustedManifestReadback: async (request) => staticRuntimeResponse(request, {
        dependencyAuditException: dependencyAuditExceptionFixture({
          repositoryId: prStaticContext.repositoryId,
          fullName: prStaticContext.fullName,
          staticSourceSha: prStaticContext.applicationSourceSha,
          androidSourceSha: "9".repeat(40),
        }),
      }),
    }),
    /DEPENDENCY_AUDIT_EXCEPTION_BINDING_MISMATCH/u,
  );

  const buildContext = buildRuntimeContext({ eventSourceSha: "9".repeat(40) });
  const buildException = dependencyAuditExceptionFixture({
    repositoryId: buildContext.repositoryId,
    fullName: buildContext.fullName,
    staticSourceSha: "8".repeat(40),
    androidSourceSha: buildContext.eventSourceSha,
  });
  const buildBinding = await resolveBuildRuntimeBindingV5(buildContext, {
    now: () => new Date("2026-08-30T00:00:00Z"),
    trustedManifestReadback: async (request) => buildRuntimeResponse(request, {
      dependencyAuditException: buildException,
    }),
  });
  assert.deepEqual(
    JSON.parse(Buffer.from(buildBinding.dependencyAuditException, "base64url").toString("utf8")),
    canonicalize(buildException),
  );

  for (const invalid of [
    { ...staticException, expiresAt: "2026-08-29T23:59:59Z" },
    {
      ...staticException,
      bindings: staticException.bindings.map((binding) => (
        binding.actionClass === "STATIC_CHECK"
          ? { ...binding, sourceSha: "7".repeat(40) }
          : binding
      )),
    },
    { ...staticException, advisories: [...staticException.advisories].reverse() },
  ]) {
    await assert.rejects(
      resolveStaticRuntimeBindingV5(staticContext, {
        now: () => new Date("2026-08-30T00:00:00Z"),
        trustedManifestReadback: async (request) => staticRuntimeResponse(request, {
          dependencyAuditException: invalid,
        }),
      }),
      /DEPENDENCY_AUDIT_EXCEPTION_(?:INVALID|BINDING_MISMATCH)/u,
    );
  }
});

test("called workflow path, profile, and package manager are one exact runtime identity", async () => {
  const context = staticRuntimeContext({
    calledWorkflowPath: ".github/workflows/godot-checks-v3.yml",
  });
  const request = {
    repositoryId: context.repositoryId,
    fullName: context.fullName,
    applicationSourceSha: context.applicationSourceSha,
    bindingSourceSha: context.applicationSourceSha,
  };
  const schema = JSON.parse(
    await readFile("contracts/workflow-bundle-v5-static-runtime-readback.schema.json", "utf8"),
  );
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const godotResponse = staticRuntimeResponse(request, {
    staticBinding: {
      profile: "godot",
      packageManager: null,
      workspaceRoot: ".",
      commandDirectory: ".",
    },
  });
  assert.equal(validate(godotResponse), true, JSON.stringify(validate.errors));
  const responseWithSelfAssertedPath = {
    ...structuredClone(godotResponse),
    calledWorkflowPath: ".github/workflows/godot-checks-v3.yml",
  };
  assert.equal(validate(responseWithSelfAssertedPath), false);
  const godot = await resolveStaticRuntimeBindingV5(context, {
    trustedManifestReadback: async (runtimeRequest) => {
      assert.equal(runtimeRequest.calledWorkflowPath, ".github/workflows/godot-checks-v3.yml");
      return structuredClone(godotResponse);
    },
  });
  assert.equal(godot.profile, "godot");
  assert.equal(godot.packageManager, null);
  assert.equal(godot.calledWorkflowPath, ".github/workflows/godot-checks-v3.yml");
  await assert.rejects(
    resolveStaticRuntimeBindingV5(context, {
      trustedManifestReadback: async () => responseWithSelfAssertedPath,
    }),
    /STATIC_RUNTIME_READBACK_INVALID/u,
  );

  for (const [calledWorkflowPath, staticBinding] of [
    [".github/workflows/js-static-checks-v1.yml", {
      profile: "godot",
      packageManager: null,
      workspaceRoot: ".",
      commandDirectory: ".",
    }],
    [".github/workflows/godot-checks-v3.yml", {
      profile: "react-native",
      packageManager: "npm",
      workspaceRoot: ".",
      commandDirectory: ".",
    }],
    [".github/workflows/js-static-checks-v1.yml", {
      profile: "react-native",
      packageManager: null,
      workspaceRoot: ".",
      commandDirectory: ".",
    }],
    [".github/workflows/godot-checks-v3.yml", {
      profile: "godot",
      packageManager: "npm",
      workspaceRoot: ".",
      commandDirectory: ".",
    }],
  ]) {
    const invalid = staticRuntimeResponse(request, { staticBinding });
    if (
      (staticBinding.profile === "godot" && staticBinding.packageManager !== null) ||
      (staticBinding.profile !== "godot" && staticBinding.packageManager === null)
    ) {
      assert.equal(validate(invalid), false);
    } else {
      assert.equal(validate(invalid), true, JSON.stringify(validate.errors));
    }
    await assert.rejects(
      resolveStaticRuntimeBindingV5(staticRuntimeContext({ calledWorkflowPath }), {
        trustedManifestReadback: async () => structuredClone(invalid),
      }),
      /STATIC_RUNTIME_READBACK_INVALID/u,
    );
  }

  const jsContext = staticRuntimeContext();
  const js = await resolveStaticRuntimeBindingV5(jsContext, {
    trustedManifestReadback: async (runtimeRequest) => staticRuntimeResponse(runtimeRequest, {
      staticBinding: {
        profile: "capacitor",
        packageManager: "pnpm",
        workspaceRoot: ".",
        commandDirectory: ".",
      },
    }),
  });
  assert.equal(js.calledWorkflowPath, ".github/workflows/js-static-checks-v1.yml");

  for (const jobWorkflowRef of [
    `seorilabs/.github/.github/workflows/godot-checks-v3.yml.evil@${WORKFLOW_EXECUTION_SHA}`,
    `attacker/.github/.github/workflows/godot-checks-v3.yml@${WORKFLOW_EXECUTION_SHA}`,
    `seorilabs/.github/.github/workflows/godot-checks-v3.yml@${"0".repeat(40)}`,
  ]) {
    let calls = 0;
    await assert.rejects(
      resolveStaticRuntimeBindingV5({ ...context, jobWorkflowRef }, {
        trustedManifestReadback: async () => {
          calls += 1;
          return structuredClone(godotResponse);
        },
      }),
      /STATIC_RUNTIME_CALLED_WORKFLOW_IDENTITY_INVALID/u,
    );
    assert.equal(calls, 0);
  }
});

test("runner-injected OIDC HTTPS endpoint is opaque while userinfo and fragments fail closed", async () => {
  const requestToken = "opaque-runner-request-token";
  const idToken = "header.payload.signature";
  let called;
  assert.equal(
    await requestGithubOidcToken("seorilabs-control-plane", {
      env: {
        ACTIONS_ID_TOKEN_REQUEST_URL:
          "https://pipelinesghubeus6.actions.githubusercontent.com/opaque/_apis/distributedtask/hubs/build/plans/1/jobs/2/idtoken?api-version=2.0",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestToken,
      },
      fetchImpl: async (input, options) => {
        called = { input: String(input), options };
        return new Response(JSON.stringify({ value: idToken }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }),
    idToken,
  );
  const endpoint = new URL(called.input);
  assert.equal(endpoint.hostname, "pipelinesghubeus6.actions.githubusercontent.com");
  assert.equal(endpoint.searchParams.get("api-version"), "2.0");
  assert.equal(endpoint.searchParams.get("audience"), "seorilabs-control-plane");
  assert.equal(called.options.headers.Authorization, `Bearer ${requestToken}`);
  assert.equal(called.options.redirect, "error");

  for (const forbidden of [
    "http://pipelines.actions.githubusercontent.com/idtoken",
    "https://user@pipelines.actions.githubusercontent.com/idtoken",
    "https://pipelines.actions.githubusercontent.com/idtoken#fragment",
  ]) {
    await assert.rejects(
      requestGithubOidcToken("seorilabs-control-plane", {
        env: {
          ACTIONS_ID_TOKEN_REQUEST_URL: forbidden,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestToken,
        },
        fetchImpl: async () => assert.fail("invalid OIDC endpoint must not be fetched"),
      }),
      /STATIC_RUNTIME_OIDC_ENDPOINT_INVALID/u,
    );
  }
});

test("approved main and two fixed candidate PR build bindings resolve before app checkout", async () => {
  const schema = JSON.parse(
    await readFile("contracts/workflow-bundle-v5-build-runtime-readback.schema.json", "utf8"),
  );
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

  for (const profile of ["react-native-android", "godot-android"]) {
    const context = buildRuntimeContext({ profile });
    let readbackCalls = 0;
    const binding = await resolveBuildRuntimeBindingV5(context, {
      trustedManifestReadback: async (request) => {
        readbackCalls += 1;
        assert.equal(request.mode, "APPROVED");
        assert.equal(request.schema, "workflow-bundle-v5-build");
        const response = buildRuntimeResponse(request);
        assert.equal(validate(response), true, JSON.stringify(validate.errors));
        return response;
      },
    });
    assert.equal(readbackCalls, 1);
    assert.equal(binding.applicationSourceSha, context.eventSourceSha);
    assert.equal(binding.buildProfile, profile);
    assert.equal(binding.packageManager, profile === "react-native-android" ? "pnpm" : null);
    assert.equal(binding.workflowBundleApprovalState, "APPROVED");
    assert.equal(binding.planIdentity, null);
  }

  const baseSha = "8".repeat(40);
  const mergeSha = "9".repeat(40);
  for (const canary of [
    ["1250442131", "seorilabs/happy-farm", "react-native-android"],
    ["1265192029", "seorilabs/lizard-tycoon", "godot-android"],
  ]) {
    const [repositoryId, fullName, profile] = canary;
    const context = buildRuntimeContext({
      profile,
      eventName: "pull_request",
      eventRef: "refs/pull/41/merge",
      eventSourceSha: mergeSha,
      repositoryId,
      fullName,
      pullRequestBaseSha: baseSha,
      pullRequestHeadRepository: fullName,
      pullRequestHeadRef: candidateBranchRef({ repositoryId }),
    });
    const binding = await resolveBuildRuntimeBindingV5(context, {
      trustedManifestReadback: async (request) => {
        assert.equal(request.mode, "CANDIDATE");
        assert.equal(request.schema, "workflow-bundle-v5-build-canary");
        assert.equal(request.applicationSourceSha, baseSha);
        assert.equal(request.eventSourceSha, mergeSha);
        assert.equal(request.planIdentity, PLAN_IDENTITY);
        return buildRuntimeResponse(request);
      },
    });
    assert.equal(binding.applicationSourceSha, baseSha);
    assert.equal(binding.eventSourceSha, mergeSha);
    assert.equal(binding.workflowBundleApprovalState, "CANDIDATE");
    assert.equal(binding.planIdentity, PLAN_IDENTITY);
  }
});

test("build runtime blocks lookalike caller, malformed candidate branch identity, stale bundle state, and PAUSED", async () => {
  const main = buildRuntimeContext();
  for (const attack of [
    { callerWorkflowRef: main.callerWorkflowRef.replace("runtime-canary", "runtime-lookalike") },
    { jobWorkflowRef: `${main.jobWorkflowRef}.evil` },
    { repositoryPrivate: "false" },
  ]) {
    let calls = 0;
    await assert.rejects(
      resolveBuildRuntimeBindingV5({ ...main, ...attack }, {
        trustedManifestReadback: async () => {
          calls += 1;
          return {};
        },
      }),
      /BUILD_RUNTIME_(?:CONTEXT_INVALID|CALLER_WORKFLOW_IDENTITY_INVALID|CALLED_WORKFLOW_IDENTITY_INVALID|PUBLIC_STABLE_TAG_REQUIRED)/u,
    );
    assert.equal(calls, 0);
  }

  const candidate = buildRuntimeContext({
    eventName: "pull_request",
    eventRef: "refs/pull/41/merge",
    eventSourceSha: "9".repeat(40),
    repositoryId: "1250442131",
    fullName: "seorilabs/happy-farm",
    pullRequestBaseSha: "8".repeat(40),
    pullRequestHeadRepository: "seorilabs/happy-farm",
    pullRequestHeadRef: candidateBranchRef(),
  });
  const prefix =
    `seori/workflow-bundle-v5-canary/${candidate.repositoryId}/` +
    WORKFLOW_EXECUTION_SHA.slice(0, 12);
  for (const pullRequestHeadRef of [
    prefix,
    `${prefix}/${PLAN_IDENTITY.toUpperCase()}`,
    `${prefix}/${"g".repeat(64)}`,
    `${prefix}/${"e".repeat(63)}`,
    `${prefix}/${"e".repeat(65)}`,
    candidateBranchRef({ repositoryId: "1250442132" }),
    candidateBranchRef({ workflowExecutionSha: "c".repeat(40) }),
    candidateBranchRef({ workflowExecutionSha: "B".repeat(40) }),
    `${candidateBranchRef()}/lookalike`,
  ]) {
    let readbackCalls = 0;
    await assert.rejects(
      resolveBuildRuntimeBindingV5({ ...candidate, pullRequestHeadRef }, {
        trustedManifestReadback: async () => {
          readbackCalls += 1;
          return {};
        },
      }),
      /BUILD_RUNTIME_CANDIDATE_IDENTITY_INVALID/u,
    );
    assert.equal(readbackCalls, 0);
  }

  await assert.rejects(
    resolveBuildRuntimeBindingV5(main, {
      trustedManifestReadback: async (request) => {
        const response = buildRuntimeResponse(request);
        response.manifest.workflowBundle.approvalState = "CANDIDATE";
        return response;
      },
    }),
    /BUILD_RUNTIME_READBACK_INVALID/u,
  );
  await assert.rejects(
    resolveBuildRuntimeBindingV5(main, {
      trustedManifestReadback: async (request) =>
        buildRuntimeResponse(request, { lifecycleState: "PAUSED" }),
    }),
    /PAUSED_BUILD_RUNTIME_FORBIDDEN/u,
  );
});

test("build manifest adapter fixes origin and exposes only public exact claims", async () => {
  const context = buildRuntimeContext();
  const token = "header.payload.signature";
  const calls = [];
  const readback = createBuildManifestReadbackV5({
    oidcTokenProvider: async (audience) => {
      assert.equal(audience, buildRuntimeBindingV5Contract.audience);
      return token;
    },
    fetchImpl: async (input, options) => {
      calls.push({ input: String(input), options });
      const url = new URL(input);
      const schema = url.searchParams.get("schema");
      const repositoryId = url.pathname.split("/").at(-2);
      const request = {
        repositoryId,
        fullName: repositoryId === "1250442131"
          ? "seorilabs/happy-farm"
          : context.fullName,
        applicationSourceSha: url.searchParams.get("ref"),
        eventSourceSha: url.searchParams.get("event_ref"),
        workflowExecutionSha: url.searchParams.get("workflow_sha"),
        buildProfile: url.searchParams.get("build_profile"),
        mode: schema === "workflow-bundle-v5-build-canary" ? "CANDIDATE" : "APPROVED",
      };
      return new Response(JSON.stringify(buildRuntimeResponse(request)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await resolveBuildRuntimeBindingV5(context, { trustedManifestReadback: readback });
  assert.equal(calls.length, 1);
  const requested = new URL(calls[0].input);
  assert.equal(requested.origin, buildRuntimeBindingV5Contract.origin);
  assert.deepEqual([...requested.searchParams.keys()].sort(), [
    "build_profile", "build_target", "event_ref", "ref", "schema", "workflow_sha",
  ]);
  assert.equal(requested.searchParams.get("build_target"), "android");
  assert.equal(requested.searchParams.get("schema"), "workflow-bundle-v5-build");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
  assert.doesNotMatch(calls[0].input, /header|payload|signature/u);

  let retryConflictCalls = 0;
  const retryConflictDelays = [];
  const retryConflictReadback = createBuildManifestReadbackV5({
    oidcTokenProvider: async () => token,
    waitImpl: async (delayMs) => retryConflictDelays.push(delayMs),
    fetchImpl: async (input) => {
      retryConflictCalls += 1;
      if (retryConflictCalls === 1) {
        return new Response(JSON.stringify({ error: "NO_DISCOVERY_FOR_SHA" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      const url = new URL(input);
      return new Response(JSON.stringify(buildRuntimeResponse({
        repositoryId: context.repositoryId,
        fullName: context.fullName,
        applicationSourceSha: url.searchParams.get("ref"),
        eventSourceSha: url.searchParams.get("event_ref"),
        workflowExecutionSha: url.searchParams.get("workflow_sha"),
        buildProfile: url.searchParams.get("build_profile"),
        mode: "APPROVED",
      })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await resolveBuildRuntimeBindingV5(context, { trustedManifestReadback: retryConflictReadback });
  assert.equal(retryConflictCalls, 2);
  assert.deepEqual(retryConflictDelays, [1_000]);

  let permanentConflictCalls = 0;
  const permanentConflictDelays = [];
  const permanentConflictReadback = createBuildManifestReadbackV5({
    oidcTokenProvider: async () => token,
    waitImpl: async (delayMs) => permanentConflictDelays.push(delayMs),
    fetchImpl: async () => {
      permanentConflictCalls += 1;
      return new Response(JSON.stringify({
        error: "DEPENDENCY_AUDIT_EXCEPTION_BINDING_MISMATCH",
        message: "operator action required",
      }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await assert.rejects(
    resolveBuildRuntimeBindingV5(context, { trustedManifestReadback: permanentConflictReadback }),
    /BUILD_RUNTIME_MANIFEST_HTTP_409_DEPENDENCY_AUDIT_EXCEPTION_BINDING_MISMATCH/u,
  );
  assert.equal(permanentConflictCalls, 1);
  assert.deepEqual(permanentConflictDelays, []);

  const candidateContext = buildRuntimeContext({
    eventName: "pull_request",
    eventRef: "refs/pull/41/merge",
    eventSourceSha: "9".repeat(40),
    repositoryId: "1250442131",
    fullName: "seorilabs/happy-farm",
    pullRequestBaseSha: "8".repeat(40),
    pullRequestHeadRepository: "seorilabs/happy-farm",
    pullRequestHeadRef: candidateBranchRef(),
  });
  const candidateBinding = await resolveBuildRuntimeBindingV5(candidateContext, {
    trustedManifestReadback: readback,
  });
  assert.equal(candidateBinding.planIdentity, PLAN_IDENTITY);
  assert.equal(calls.length, 2);
  const candidateRequest = new URL(calls[1].input);
  assert.deepEqual([...candidateRequest.searchParams.keys()].sort(), [
    "build_profile", "build_target", "event_ref", "plan_identity", "ref", "schema", "workflow_sha",
  ]);
  assert.equal(candidateRequest.searchParams.get("plan_identity"), PLAN_IDENTITY);
  assert.equal(
    candidateRequest.searchParams.get("schema"),
    "workflow-bundle-v5-build-canary",
  );

  const oversizedReadback = createBuildManifestReadbackV5({
    oidcTokenProvider: async () => token,
    fetchImpl: async () => new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(2 * 1024 * 1024),
      },
    }),
  });
  await assert.rejects(
    resolveBuildRuntimeBindingV5(context, { trustedManifestReadback: oversizedReadback }),
    /BUILD_RUNTIME_RESPONSE_TOO_LARGE/u,
  );
});

test("static manifest adapter fixes origin, uses OIDC only in headers, and fails closed on errors", async () => {
  const context = staticRuntimeContext();
  const token = "header.payload.signature";
  const calls = [];
  const readback = createStaticManifestReadbackV5({
    oidcTokenProvider: async (audience) => {
      assert.equal(audience, staticRuntimeBindingV5Contract.audience);
      return token;
    },
    fetchImpl: async (input, options) => {
      calls.push({ input: String(input), options });
      const url = new URL(input);
      const request = {
        repositoryId: context.repositoryId,
        fullName: context.fullName,
        bindingSourceSha: url.searchParams.get("ref"),
        applicationSourceSha: url.searchParams.get("application_ref"),
      };
      return new Response(JSON.stringify(staticRuntimeResponse(request)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await resolveStaticRuntimeBindingV5(context, { trustedManifestReadback: readback });
  assert.equal(calls.length, 1);
  const requested = new URL(calls[0].input);
  assert.equal(requested.origin, staticRuntimeBindingV5Contract.origin);
  assert.equal(
    requested.pathname,
    "/api/control-plane/apps/7001/resolved-manifest",
  );
  assert.deepEqual([...requested.searchParams.keys()].sort(), [
    "application_ref",
    "ref",
    "schema",
  ]);
  assert.equal(requested.searchParams.get("ref"), context.applicationSourceSha);
  assert.equal(requested.searchParams.get("application_ref"), context.applicationSourceSha);
  assert.equal(requested.searchParams.get("schema"), "workflow-bundle-v5-static");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
  assert.doesNotMatch(calls[0].input, /header|payload|signature/u);

  await readback({
    repositoryId: context.repositoryId,
    fullName: context.fullName,
    bindingSourceSha: "9".repeat(40),
    applicationSourceSha: "8".repeat(40),
    runId: context.runId,
  });
  const pullRequestQuery = new URL(calls[1].input);
  assert.equal(pullRequestQuery.searchParams.get("ref"), "9".repeat(40));
  assert.equal(pullRequestQuery.searchParams.get("application_ref"), "8".repeat(40));
  assert.equal(pullRequestQuery.searchParams.get("schema"), "workflow-bundle-v5-static");

  let retryTokenCalls = 0;
  let retryFetchCalls = 0;
  const retryDelays = [];
  const retryingReadback = createStaticManifestReadbackV5({
    oidcTokenProvider: async () => {
      retryTokenCalls += 1;
      return token;
    },
    waitImpl: async (delayMs) => retryDelays.push(delayMs),
    fetchImpl: async (input) => {
      retryFetchCalls += 1;
      if (retryFetchCalls < 8) {
        return new Response(JSON.stringify({ error: "NO_DISCOVERY_FOR_SHA" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      const url = new URL(input);
      return new Response(JSON.stringify(staticRuntimeResponse({
        repositoryId: context.repositoryId,
        fullName: context.fullName,
        bindingSourceSha: url.searchParams.get("ref"),
        applicationSourceSha: url.searchParams.get("application_ref"),
      })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await resolveStaticRuntimeBindingV5(context, { trustedManifestReadback: retryingReadback });
  assert.equal(retryTokenCalls, 1);
  assert.equal(retryFetchCalls, 8);
  assert.deepEqual(retryDelays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  // push[main] 직후 discovery 관측이 기록되기까지 실측 30~40초였다. 총 대기가 그보다
  // 짧아지면 같은 경합이 다시 열린다.
  assert.ok(retryDelays.reduce((total, delay) => total + delay, 0) >= 90_000);

  let exhaustedCalls = 0;
  const exhaustedReadback = createStaticManifestReadbackV5({
    oidcTokenProvider: async () => token,
    waitImpl: async () => undefined,
    fetchImpl: async () => {
      exhaustedCalls += 1;
      return new Response("{}", { status: 409 });
    },
  });
  await assert.rejects(
    resolveStaticRuntimeBindingV5(context, { trustedManifestReadback: exhaustedReadback }),
    /STATIC_RUNTIME_MANIFEST_HTTP_409_ERROR_CODE_UNKNOWN/u,
  );
  assert.equal(exhaustedCalls, 8);

  let permanentConflictCalls = 0;
  const permanentConflictDelays = [];
  const permanentConflictReadback = createStaticManifestReadbackV5({
    oidcTokenProvider: async () => token,
    waitImpl: async (delayMs) => permanentConflictDelays.push(delayMs),
    fetchImpl: async () => {
      permanentConflictCalls += 1;
      return new Response(JSON.stringify({
        error: "DEPENDENCY_AUDIT_EXCEPTION_BINDING_MISMATCH",
        message: "operator action required",
      }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await assert.rejects(
    resolveStaticRuntimeBindingV5(context, { trustedManifestReadback: permanentConflictReadback }),
    /STATIC_RUNTIME_MANIFEST_HTTP_409_DEPENDENCY_AUDIT_EXCEPTION_BINDING_MISMATCH/u,
  );
  assert.equal(permanentConflictCalls, 1);
  assert.deepEqual(permanentConflictDelays, []);

  const failingReadback = createStaticManifestReadbackV5({
    oidcTokenProvider: async () => token,
    fetchImpl: async () => new Response(token, { status: 401 }),
  });
  await assert.rejects(
    resolveStaticRuntimeBindingV5(context, { trustedManifestReadback: failingReadback }),
    (error) => {
      assert.equal(error.message, "STATIC_RUNTIME_MANIFEST_HTTP_401");
      assert.doesNotMatch(error.message, /header|payload|signature/u);
      return true;
    },
  );

  for (const secretFailure of [
    createStaticManifestReadbackV5({
      oidcTokenProvider: async () => {
        throw new Error(token);
      },
      fetchImpl: async () => assert.fail("manifest fetch must not run"),
    }),
    createStaticManifestReadbackV5({
      oidcTokenProvider: async () => token,
      fetchImpl: async () => {
        throw new Error(token);
      },
    }),
  ]) {
    await assert.rejects(
      resolveStaticRuntimeBindingV5(context, { trustedManifestReadback: secretFailure }),
      (error) => {
        assert.match(
          error.message,
          /^STATIC_RUNTIME_(?:OIDC|MANIFEST)_REQUEST_FAILED$/u,
        );
        assert.doesNotMatch(error.message, /header|payload|signature/u);
        return true;
      },
    );
  }

  const oversizedReadback = createStaticManifestReadbackV5({
    oidcTokenProvider: async () => token,
    fetchImpl: async () => new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(2 * 1024 * 1024),
      },
    }),
  });
  await assert.rejects(
    resolveStaticRuntimeBindingV5(context, { trustedManifestReadback: oversizedReadback }),
    /STATIC_RUNTIME_RESPONSE_TOO_LARGE/u,
  );
});

test("canonical paths reject traversal, dot segments, backslashes, and symlink escapes", async () => {
  const { root } = await fixtureRepository("saju-reader");
  await assert.rejects(resolveSafeDirectory(root, "../outside"), /DIRECTORY_PATH_INVALID/u);
  await assert.rejects(resolveSafeDirectory(root, "scripts/./nested"), /DIRECTORY_PATH_INVALID/u);
  await assert.rejects(resolveSafeFile(root, "scripts\\build-ait.sh"), /FILE_PATH_INVALID/u);

  const outside = await mkdtemp(join(tmpdir(), "workflow-v5-outside-"));
  roots.push(outside);
  await writeFile(join(outside, "secret.sh"), "not-secret\n");
  await symlink(outside, join(root, "linked-directory"));
  await symlink(join(outside, "secret.sh"), join(root, "linked-file.sh"));
  await assert.rejects(resolveSafeDirectory(root, "linked-directory"), /DIRECTORY_PATH_UNTRUSTED/u);
  await assert.rejects(resolveSafeFile(root, "linked-file.sh"), /FILE_PATH_UNTRUSTED/u);
});

test("a plain self-asserted manifest cannot create a trusted resolved binding", async () => {
  const { root, manifest } = await fixtureRepository("saju-reader");
  await assert.rejects(
    loadResolvedWorkflowBindingV5(
      {
        repositoryId: manifest.repositoryId,
        fullName: manifest.fullName,
        sourceSha: manifest.sourceSha,
      },
      {
        repoRoot: root,
        trustedResolvedManifestReadback: async () => structuredClone(manifest),
      },
    ),
    /RESOLVED_BINDING_READBACK_UNTRUSTED/u,
  );
});

test("pnpm and npm staging require exact Platform lock evidence and never retain the token", async () => {
  const { root } = await fixtureRepository("saju-reader");
  const pnpm = await inspectExactPlatformDependencyV5({
    repoRoot: root,
    dependencyRoot: ".",
    packageManager: "pnpm",
  });
  assert.equal(pnpm.version, "1.2.3");

  const npmRoot = await mkdtemp(join(tmpdir(), "workflow-v5-npm-"));
  roots.push(npmRoot);
  await writeFile(join(npmRoot, "package.json"), `${JSON.stringify({
    packageManager: "npm@11.13.0",
    scripts: { preinstall: "node attacker-hook.mjs" },
    dependencies: { "@seorilabs/platform-sdk": "1.2.3" },
  })}\n`);
  await writeFile(join(npmRoot, "package-lock.json"), `${JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "@seorilabs/platform-sdk": "1.2.3" } },
      "node_modules/@seorilabs/platform-sdk": {
        version: "1.2.3",
        resolved: `https://npm.pkg.github.com/download/@seorilabs/platform-sdk/1.2.3/${"9".repeat(40)}`,
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      },
    },
  })}\n`);
  git(npmRoot, ["init", "-q"]);
  git(npmRoot, ["config", "user.name", "Fixture"]);
  git(npmRoot, ["config", "user.email", "fixture@example.invalid"]);
  git(npmRoot, ["add", "."]);
  git(npmRoot, ["commit", "-qm", "fixture"]);
  assert.equal((await inspectExactPlatformDependencyV5({
    repoRoot: npmRoot,
    dependencyRoot: ".",
    packageManager: "npm",
  })).version, "1.2.3");

  const token = "token-that-must-never-be-persisted";
  const cacheRoot = join(npmRoot, ".seorilabs-npm-cache");
  writeFileSync(
    join(npmRoot, ".npmrc"),
    "@seorilabs:registry=https://attacker.invalid\n//attacker.invalid/:_authToken=${NODE_AUTH_TOKEN}\n",
  );
  let spawnCalls = 0;
  const staged = await stageExactPlatformDependencyV5({
    repoRoot: npmRoot,
    dependencyRoot: ".",
    packageManager: "npm",
    cacheRoot,
    token,
    childEnvironment: {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "must-not-reach-package-manager",
      HOME: "/tmp/fixture-home",
      PATH: "/usr/bin:/bin",
      UNRELATED_SECRET: "must-not-reach-package-manager",
    },
    spawn: (_command, args, options) => {
      spawnCalls += 1;
      assert.equal(options.env.HOME, "/tmp/fixture-home");
      assert.equal(options.env.PATH, "/usr/bin:/bin");
      assert.equal(options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
      assert.equal(options.env.UNRELATED_SECRET, undefined);
      assert.notEqual(options.cwd, npmRoot);
      assert.equal(options.env.NPM_CONFIG_GLOBALCONFIG, "/dev/null");
      assert.equal(options.env.NPM_CONFIG_REGISTRY, "https://registry.npmjs.org");
      assert.match(args.join(" "), /--registry=https:\/\/registry\.npmjs\.org/u);
      if (spawnCalls === 2) {
        assert.equal(options.env.NODE_AUTH_TOKEN, undefined);
        assert.equal(options.env.NPM_CONFIG_USERCONFIG, join(options.cwd, ".npmrc.audit"));
        assert.match(args.join(" "), /^audit .*--audit-level=high/u);
        const auditConfig = readFileSync(options.env.NPM_CONFIG_USERCONFIG, "utf8");
        assert.doesNotMatch(auditConfig, /_authToken|attacker\.invalid/u);
        return { status: 0, signal: null };
      }
      assert.equal(options.env.NODE_AUTH_TOKEN, token);
      assert.equal(options.env.NPM_CONFIG_USERCONFIG, join(options.cwd, ".npmrc"));
      assert.match(args.join(" "), /^ci --ignore-scripts/u);
      const trustedConfig = readFileSync(options.env.NPM_CONFIG_USERCONFIG, "utf8");
      assert.match(trustedConfig, /@seorilabs:registry=https:\/\/npm\.pkg\.github\.com/u);
      assert.doesNotMatch(trustedConfig, /attacker\.invalid|token-that-must/u);
      assert.match(readFileSync(join(options.cwd, "package-lock.json"), "utf8"), /platform-sdk/u);
      assert.match(readFileSync(join(options.cwd, "package.json"), "utf8"), /attacker-hook/u);
      mkdirSync(join(cacheRoot, "content"), { recursive: true });
      writeFileSync(join(cacheRoot, "content", "package.tgz"), "public-package-bytes");
      return { status: 0, signal: null };
    },
  });
  assert.equal(staged.tokenPersisted, false);
  assert.equal(spawnCalls, 2);
  assert.match(staged.contentDigest, /^sha256:[0-9a-f]{64}$/u);

  const appBin = join(npmRoot, "app-bin");
  await mkdir(appBin);
  await writeFile(join(appBin, "npm"), "#!/bin/sh\nexit 0\n");
  await assert.rejects(
    stageExactPlatformDependencyV5({
      repoRoot: npmRoot,
      dependencyRoot: ".",
      packageManager: "npm",
      cacheRoot,
      token,
      childEnvironment: { PATH: `${appBin}:/usr/bin:/bin` },
      spawn: () => assert.fail("app-controlled PATH must fail before package execution"),
    }),
    /PACKAGE_MANAGER_PATH_APP_CONTROLLED/u,
  );

  const scopeAttackRoot = await mkdtemp(join(tmpdir(), "workflow-v5-scope-attack-"));
  roots.push(scopeAttackRoot);
  await cp(npmRoot, scopeAttackRoot, { recursive: true });
  const scopeAttackManifestPath = join(scopeAttackRoot, "package.json");
  const scopeAttackManifest = JSON.parse(await readFile(scopeAttackManifestPath, "utf8"));
  scopeAttackManifest.dependencies["attacker-alias"] =
    "npm:@seorilabs/other-private-package@1.0.0";
  await writeFile(scopeAttackManifestPath, `${JSON.stringify(scopeAttackManifest)}\n`);
  await assert.rejects(
    inspectExactPlatformDependencyV5({
      repoRoot: scopeAttackRoot,
      dependencyRoot: ".",
      packageManager: "npm",
    }),
    /PACKAGE_DEPENDENCY_SOURCE_FORBIDDEN/u,
  );

  // capacitor 앱은 자기 native 플러그인을 저장소 안 file: package로 참조한다. 그 바이트는
  // 이미 검증한 checkout 안에 있으므로 허용하고, workspace 밖을 가리키면 그대로 거부한다.
  const inRepoRoot = await mkdtemp(join(tmpdir(), "workflow-v5-in-repo-package-"));
  roots.push(inRepoRoot);
  await cp(npmRoot, inRepoRoot, { recursive: true });
  await mkdir(join(inRepoRoot, "plugins/native-bridge"), { recursive: true });
  await writeFile(
    join(inRepoRoot, "plugins/native-bridge/package.json"),
    `${JSON.stringify({ name: "@seorilabs/native-bridge", version: "0.1.0", main: "index.js" })}\n`,
  );
  const inRepoManifestPath = join(inRepoRoot, "package.json");
  const inRepoManifest = JSON.parse(await readFile(inRepoManifestPath, "utf8"));
  inRepoManifest.dependencies["@seorilabs/native-bridge"] = "file:plugins/native-bridge";
  await writeFile(inRepoManifestPath, `${JSON.stringify(inRepoManifest)}\n`);
  execFileSync("git", ["-C", inRepoRoot, "add", "-A"], { stdio: "ignore" });
  await assert.doesNotReject(
    inspectExactPlatformDependencyV5({
      repoRoot: inRepoRoot,
      dependencyRoot: ".",
      packageManager: "npm",
    }),
  );

  for (const escape of ["file:../outside", "file:/etc", "file:plugins/../../outside", "link:../outside"]) {
    const escapeManifest = JSON.parse(await readFile(inRepoManifestPath, "utf8"));
    escapeManifest.dependencies["@seorilabs/native-bridge"] = escape;
    await writeFile(inRepoManifestPath, `${JSON.stringify(escapeManifest)}\n`);
    await assert.rejects(
      inspectExactPlatformDependencyV5({
        repoRoot: inRepoRoot,
        dependencyRoot: ".",
        packageManager: "npm",
      }),
      /PACKAGE_DEPENDENCY_SOURCE_FORBIDDEN/u,
      escape,
    );
  }
  inRepoManifest.dependencies["@seorilabs/native-bridge"] = "file:plugins/native-bridge";
  await writeFile(inRepoManifestPath, `${JSON.stringify(inRepoManifest)}\n`);

  const inRepoLockPath = join(inRepoRoot, "package-lock.json");
  const inRepoLock = JSON.parse(await readFile(inRepoLockPath, "utf8"));
  inRepoLock.packages["node_modules/@seorilabs/native-bridge"] = { resolved: "file:../../outside" };
  await writeFile(inRepoLockPath, `${JSON.stringify(inRepoLock)}\n`);
  await assert.rejects(
    inspectExactPlatformDependencyV5({
      repoRoot: inRepoRoot,
      dependencyRoot: ".",
      packageManager: "npm",
    }),
    /LOCKFILE_SOURCE_FORBIDDEN/u,
  );

  const attackerRoot = await mkdtemp(join(tmpdir(), "workflow-v5-lock-attack-"));
  roots.push(attackerRoot);
  await cp(npmRoot, attackerRoot, { recursive: true });
  const attackerLockPath = join(attackerRoot, "package-lock.json");
  const attackerLock = JSON.parse(await readFile(attackerLockPath, "utf8"));
  attackerLock.packages["node_modules/@seorilabs/platform-sdk"].resolved =
    "https://runner-metadata.internal/platform-sdk.tgz";
  await writeFile(attackerLockPath, `${JSON.stringify(attackerLock)}\n`);
  await assert.rejects(
    inspectExactPlatformDependencyV5({
      repoRoot: attackerRoot,
      dependencyRoot: ".",
      packageManager: "npm",
    }),
    /LOCKFILE_REGISTRY_FORBIDDEN/u,
  );

  attackerLock.packages["node_modules/indirect-source"] = {
    version: "https://runner-metadata.internal/indirect-package.tgz",
  };
  attackerLock.packages["node_modules/@seorilabs/platform-sdk"].resolved =
    `https://npm.pkg.github.com/download/@seorilabs/platform-sdk/1.2.3/${"9".repeat(40)}`;
  await writeFile(attackerLockPath, `${JSON.stringify(attackerLock)}\n`);
  await assert.rejects(
    inspectExactPlatformDependencyV5({
      repoRoot: attackerRoot,
      dependencyRoot: ".",
      packageManager: "npm",
    }),
    /LOCKFILE_REGISTRY_FORBIDDEN/u,
  );
});

test("audit exception permits only the exact high advisory set for one source and lock", async () => {
  const { root } = await fixtureRepository("saju-reader");
  const sourceSha = git(root, ["rev-parse", "HEAD"]);
  const lockDigest = sha256(await readFile(join(root, "pnpm-lock.yaml")));
  const exception = dependencyAuditExceptionFixture({
    repositoryId: "1250442131",
    fullName: "seorilabs/happy-farm",
    staticSourceSha: sourceSha,
    androidSourceSha: "9".repeat(40),
    staticLockDigest: lockDigest,
  });
  const auditReport = JSON.stringify({
    advisories: Object.fromEntries(exception.advisories.map((advisory, index) => [String(index + 1), {
      github_advisory_id: advisory.ghsa,
      module_name: advisory.module,
      severity: advisory.severity,
      findings: advisory.versions.map((version) => ({ version })),
    }])),
  });
  const cacheRoot = join(root, ".seorilabs-pnpm-store");
  let calls = 0;
  const staged = await stageExactPlatformDependencyV5({
    repoRoot: root,
    dependencyRoot: ".",
    packageManager: "pnpm",
    cacheRoot,
    token: "token-that-must-never-be-persisted",
    childEnvironment: { HOME: "/tmp/fixture-home", PATH: "/usr/bin:/bin" },
    dependencyAuditException: exception,
    auditActionClass: "STATIC_CHECK",
    repositoryId: exception.repositoryId,
    fullName: exception.fullName,
    sourceSha,
    now: () => new Date("2026-08-30T00:00:00Z"),
    spawn: (_command, _args, options) => {
      calls += 1;
      if (calls === 1) {
        mkdirSync(join(cacheRoot, "content"), { recursive: true });
        writeFileSync(join(cacheRoot, "content", "package.tgz"), "public-package-bytes");
        return { status: 0, signal: null };
      }
      assert.equal(_args.includes("--json"), true);
      assert.equal(options.env.NODE_AUTH_TOKEN, undefined);
      assert.equal(options.timeout, 300_000);
      return { status: 1, signal: null, stdout: auditReport };
    },
  });
  assert.equal(calls, 2);
  assert.equal(staged.dependencyAuditExceptionDigest, sha256(JSON.stringify(canonicalize(exception))));

  await rm(cacheRoot, { recursive: true, force: true });
  const baseSha = "b".repeat(40);
  const baseBoundException = dependencyAuditExceptionFixture({
    repositoryId: "1250442131",
    fullName: "seorilabs/happy-farm",
    staticSourceSha: baseSha,
    androidSourceSha: "9".repeat(40),
    staticLockDigest: lockDigest,
  });
  const stagedFromPullRequest = await stageExactPlatformDependencyV5({
    repoRoot: root,
    dependencyRoot: ".",
    packageManager: "pnpm",
    cacheRoot,
    token: "token-that-must-never-be-persisted",
    childEnvironment: { HOME: "/tmp/fixture-home", PATH: "/usr/bin:/bin" },
    dependencyAuditException: baseBoundException,
    auditActionClass: "STATIC_CHECK",
    repositoryId: baseBoundException.repositoryId,
    fullName: baseBoundException.fullName,
    sourceSha,
    bindingSourceSha: baseSha,
    now: () => new Date("2026-08-30T00:00:00Z"),
    spawn: (_command, _args, options) => {
      if (!options.env.NODE_AUTH_TOKEN) return { status: 1, signal: null, stdout: auditReport };
      mkdirSync(join(cacheRoot, "content"), { recursive: true });
      writeFileSync(join(cacheRoot, "content", "package.tgz"), "public-package-bytes");
      return { status: 0, signal: null };
    },
  });
  assert.equal(
    stagedFromPullRequest.dependencyAuditExceptionDigest,
    sha256(JSON.stringify(canonicalize(baseBoundException))),
  );
  await rm(cacheRoot, { recursive: true, force: true });
  await assert.rejects(
    stageExactPlatformDependencyV5({
      repoRoot: root,
      dependencyRoot: ".",
      packageManager: "pnpm",
      cacheRoot,
      token: "token-that-must-never-be-persisted",
      childEnvironment: { HOME: "/tmp/fixture-home", PATH: "/usr/bin:/bin" },
      dependencyAuditException: baseBoundException,
      auditActionClass: "STATIC_CHECK",
      repositoryId: baseBoundException.repositoryId,
      fullName: baseBoundException.fullName,
      sourceSha,
      now: () => new Date("2026-08-30T00:00:00Z"),
      spawn: () => ({ status: 1, signal: null, stdout: auditReport }),
    }),
    /DEPENDENCY_AUDIT_EXCEPTION_BINDING_MISMATCH/u,
  );

  await rm(cacheRoot, { recursive: true, force: true });
  const substituted = structuredClone(exception);
  substituted.advisories[0].versions = ["1.1.8"];
  await assert.rejects(
    stageExactPlatformDependencyV5({
      repoRoot: root,
      dependencyRoot: ".",
      packageManager: "pnpm",
      cacheRoot,
      token: "token-that-must-never-be-persisted",
      childEnvironment: { HOME: "/tmp/fixture-home", PATH: "/usr/bin:/bin" },
      dependencyAuditException: substituted,
      auditActionClass: "STATIC_CHECK",
      repositoryId: exception.repositoryId,
      fullName: exception.fullName,
      sourceSha,
      now: () => new Date("2026-08-30T00:00:00Z"),
      spawn: (_command, _args, options) => {
        if (!options.env.NODE_AUTH_TOKEN) {
          return { status: 1, signal: null, stdout: auditReport };
        }
        mkdirSync(join(cacheRoot, "content"), { recursive: true });
        writeFileSync(join(cacheRoot, "content", "package.tgz"), "public-package-bytes");
        return { status: 0, signal: null };
      },
    }),
    /DEPENDENCY_AUDIT_EXCEPTION_MISMATCH/u,
  );
  assert.equal(await lstat(cacheRoot).catch(() => null), null);
});

test("staging prunes dangling pnpm project symlinks so Cloud Build source packaging cannot crash", async () => {
  const { root } = await fixtureRepository("saju-reader");
  const cacheRoot = join(root, ".seorilabs-pnpm-store");
  const staged = await stageExactPlatformDependencyV5({
    repoRoot: root,
    dependencyRoot: ".",
    packageManager: "pnpm",
    cacheRoot,
    token: "token-that-must-never-be-persisted",
    childEnvironment: { HOME: "/tmp/fixture-home", PATH: "/usr/bin:/bin" },
    spawn: (_command, args, options) => {
      if (args.includes("audit")) return { status: 0, signal: null, stdout: "{}" };
      mkdirSync(join(cacheRoot, "content"), { recursive: true });
      writeFileSync(join(cacheRoot, "content", "package.tgz"), "public-package-bytes");
      mkdirSync(join(cacheRoot, "v11", "projects"), { recursive: true });
      // pnpm이 격리 staging 디렉터리를 가리키는 project 색인을 남긴 상황. staging은 이후 삭제된다.
      symlinkSync(join(options.cwd, "node_modules", ".pnpm"), join(cacheRoot, "v11", "projects", "deadbeef"));
      symlinkSync(join(cacheRoot, "content", "package.tgz"), join(cacheRoot, "content", "alias.tgz"));
      return { status: 0, signal: null };
    },
  });
  assert.equal(staged.schemaVersion, 1);
  assert.equal(await lstat(join(cacheRoot, "v11")).catch(() => null), null);
  assert.equal((await lstat(join(cacheRoot, "content", "alias.tgz"))).isSymbolicLink(), true);
  assert.equal((await lstat(join(cacheRoot, "content", "package.tgz"))).isFile(), true);
});

test("pnpm staging preserves only exact stable public-registry overrides from the locked graph", async () => {
  const { root } = await fixtureRepository("saju-reader");
  const lockPath = join(root, "pnpm-lock.yaml");
  const originalLock = await readFile(lockPath, "utf8");
  await writeFile(lockPath, originalLock.replace(
    "\nimporters:\n",
    [
      "\noverrides:",
      "  find-my-way: 9.7.0",
      "  '@fastify/middie': 9.3.2",
      "  fastify: 5.8.5",
      "",
      "importers:",
      "",
    ].join("\n"),
  ));

  const inspected = await inspectExactPlatformDependencyV5({
    repoRoot: root,
    dependencyRoot: ".",
    packageManager: "pnpm",
  });
  assert.deepEqual({ ...inspected.pnpmOverrides }, {
    "@fastify/middie": "9.3.2",
    fastify: "5.8.5",
    "find-my-way": "9.7.0",
  });

  const cacheRoot = join(root, ".seorilabs-pnpm-store");
  let spawnCalls = 0;
  await stageExactPlatformDependencyV5({
    repoRoot: root,
    dependencyRoot: ".",
    packageManager: "pnpm",
    cacheRoot,
    token: "token-that-must-never-be-persisted",
    childEnvironment: { HOME: "/tmp/fixture-home", PATH: "/usr/bin:/bin" },
    spawn: (_command, _args, options) => {
      spawnCalls += 1;
      if (spawnCalls === 1) {
        const stagedWorkspace = parse(readFileSync(join(options.cwd, "pnpm-workspace.yaml"), "utf8"));
        assert.deepEqual(stagedWorkspace.overrides, {
          "@fastify/middie": "9.3.2",
          fastify: "5.8.5",
          "find-my-way": "9.7.0",
        });
        mkdirSync(join(cacheRoot, "content"), { recursive: true });
        writeFileSync(join(cacheRoot, "content", "package.tgz"), "public-package-bytes");
      }
      return { status: 0, signal: null };
    },
  });
  assert.equal(spawnCalls, 2);

  for (const target of ["^5.8.5", "npm:fastify@5.8.5", "git+https://example.invalid/fork.git#deadbeef"]) {
    const invalid = parse(await readFile(lockPath, "utf8"));
    invalid.overrides.fastify = target;
    await writeFile(lockPath, JSON.stringify(invalid));
    await assert.rejects(
      inspectExactPlatformDependencyV5({
        repoRoot: root,
        dependencyRoot: ".",
        packageManager: "pnpm",
      }),
      /PNPM_OVERRIDE_SOURCE_FORBIDDEN/u,
    );
  }

  const invalidSelector = parse(await readFile(lockPath, "utf8"));
  invalidSelector.overrides = { "fastify@^4": "5.8.5" };
  await writeFile(lockPath, JSON.stringify(invalidSelector));
  await assert.rejects(
    inspectExactPlatformDependencyV5({
      repoRoot: root,
      dependencyRoot: ".",
      packageManager: "pnpm",
    }),
    /PNPM_OVERRIDE_SOURCE_FORBIDDEN/u,
  );

  const excessive = parse(await readFile(lockPath, "utf8"));
  excessive.overrides = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [`package-${index}`, "1.0.0"]),
  );
  await writeFile(lockPath, JSON.stringify(excessive));
  await assert.rejects(
    inspectExactPlatformDependencyV5({
      repoRoot: root,
      dependencyRoot: ".",
      packageManager: "pnpm",
    }),
    /PNPM_OVERRIDES_INVALID/u,
  );
});

test("new workflows are build-only, visibility-routed, checksum-bound, and retain evidence for three days", async () => {
  const [staticWorkflow, godotWorkflow, aitWorkflow, androidWorkflow, cloudBuild] = await Promise.all([
    readFile(".github/workflows/js-static-checks-v1.yml", "utf8"),
    readFile(".github/workflows/godot-checks-v3.yml", "utf8"),
    readFile(".github/workflows/ait-build-only-v1.yml", "utf8"),
    readFile(".github/workflows/capacitor-build-android-cloud-v1.yml", "utf8"),
    readFile(".github/cloud-build/capacitor-android-build-only-v1.yaml", "utf8"),
  ]);
  for (const workflow of [staticWorkflow, godotWorkflow, aitWorkflow, androidWorkflow]) {
    assert.doesNotMatch(workflow, /secrets:\s*inherit|uses:.*@main\b/u);
    assert.match(workflow, /retention-days: 3/u);
    assert.match(workflow, /JOB_CONTEXT_JSON: \$\{\{ toJSON\(job\) \}\}/u);
    assert.match(workflow, /identity\.workflow_ref/u);
    assert.match(workflow, /identity\.workflow_sha/u);
    assert.match(workflow, /identity\.workflow_repository/u);
    assert.doesNotMatch(workflow, /github\.workflow_sha/u);
  }
  assert.match(staticWorkflow, /CALLER_WORKFLOW_REF: \$\{\{ github\.workflow_ref \}\}/u);
  assert.match(staticWorkflow, /APPLICATION_SOURCE_SHA: \$\{\{ github\.sha \}\}/u);
  assert.match(staticWorkflow, /PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u);
  assert.match(staticWorkflow, /static-runtime-binding-v5\.mjs/u);
  assert.match(staticWorkflow, /bindingSourceSha/u);
  const staticDefinition = parse(staticWorkflow);
  assert.equal(
    Object.hasOwn(staticDefinition.on.workflow_call ?? {}, "inputs"),
    false,
  );
  assert.deepEqual(staticDefinition.jobs["resolve-binding"].permissions, {
    contents: "read",
    "id-token": "write",
  });
  assert.equal(
    staticDefinition.jobs["resolve-binding"].outputs.dependency_audit_exception,
    "${{ steps.runtime-binding.outputs.dependency_audit_exception }}",
  );
  assert.deepEqual(staticDefinition.jobs.quality.permissions, {
    contents: "read",
    packages: "read",
  });
  assert.deepEqual(staticDefinition.jobs.evidence.permissions, {
    contents: "read",
  });
  assert.deepEqual(staticDefinition.jobs["org-contract"].permissions, {
    contents: "read",
  });
  assert.equal(
    staticDefinition.jobs["resolve-binding"].if,
    "${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}",
  );
  for (const job of Object.values(staticDefinition.jobs)) {
    assert.equal(
      job["runs-on"],
      "${{ github.event.repository.private && 'seorilabs-rpi-arm64' || 'ubuntu-latest' }}",
    );
  }
  assert.equal(
    staticDefinition.jobs["resolve-binding"].steps.some(({ name }) =>
      /application source/iu.test(name)),
    false,
  );
  assert.equal(
    staticDefinition.jobs.quality.steps.some(({ name }) => /evidence|provenance/iu.test(name)),
    false,
  );
  const staticAuditTransport = staticDefinition.jobs.quality.steps.filter((step) =>
    step.env?.DEPENDENCY_AUDIT_EXCEPTION !== undefined);
  assert.deepEqual(staticAuditTransport.map(({ name }) => name), [
    "Stage exactly locked dependency cache in an isolated process",
  ]);
  assert.equal(
    staticAuditTransport[0].env.DEPENDENCY_AUDIT_EXCEPTION,
    "${{ needs.resolve-binding.outputs.dependency_audit_exception }}",
  );
  assert.equal(staticAuditTransport[0].env.SEORI_AUDIT_ACTION_CLASS, "STATIC_CHECK");
  assert.equal(
    staticDefinition.jobs.evidence.steps.some(({ name }) => /Upload static evidence/u.test(name)),
    true,
  );
  const staticEvidence = staticDefinition.jobs.evidence.steps.find(({ name }) =>
    name === "Write target-discriminated static evidence in a fresh job");
  assert.equal(
    staticEvidence.env.CALLED_WORKFLOW_PATH,
    "${{ needs.resolve-binding.outputs.called_workflow_path }}",
  );
  assert.match(
    staticEvidence.run,
    /process\.env\.CALLED_WORKFLOW_PATH/u,
  );
  assert.match(staticWorkflow, /id-token: write/u);
  const godotDefinition = parse(godotWorkflow);
  assert.equal(
    Object.hasOwn(godotDefinition.on.workflow_call ?? {}, "inputs"),
    false,
  );
  assert.deepEqual(godotDefinition.permissions, {
    contents: "read",
    "id-token": "write",
  });
  assert.deepEqual(godotDefinition.jobs["resolve-binding"].permissions, {
    contents: "read",
    "id-token": "write",
  });
  assert.deepEqual(godotDefinition.jobs.quality.permissions, { contents: "read" });
  assert.deepEqual(godotDefinition.jobs.evidence.permissions, { contents: "read" });
  assert.deepEqual(godotDefinition.jobs["org-contract"].permissions, { contents: "read" });
  assert.equal(
    godotDefinition.jobs["resolve-binding"].if,
    "${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}",
  );
  for (const job of Object.values(godotDefinition.jobs)) {
    assert.equal(
      job["runs-on"],
      "${{ github.event.repository.private && 'seorilabs-rpi-arm64' || 'ubuntu-latest' }}",
    );
  }
  const godotResolveSteps = godotDefinition.jobs["resolve-binding"].steps;
  assert.equal(
    godotResolveSteps.some(({ name, run = "" }) =>
      /application source/iu.test(name) || /seorilabs-application/u.test(run)),
    false,
  );
  assert.equal(
    godotDefinition.jobs.quality.steps.some(({ name }) => /evidence|provenance/iu.test(name)),
    false,
  );
  assert.equal(
    godotDefinition.jobs.evidence.steps.some(({ name }) =>
      name === "Upload Godot static evidence"),
    true,
  );
  assert.equal(
    godotDefinition.jobs.evidence.steps.some(({ uses = "" }) =>
      /checkout|download-artifact/u.test(uses)),
    false,
  );
  assert.deepEqual(
    Object.values(godotDefinition.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.env?.NODE_AUTH_TOKEN !== undefined),
    [],
  );
  assert.doesNotMatch(godotWorkflow, /packages:\s*read|npm\s+(?:ci|install|rebuild)|pnpm\s+(?:install|audit|rebuild)/u);
  assert.match(godotWorkflow, /npm audit/u);
  const godotNpmPrepare = godotDefinition.jobs.quality.steps.find(({ name }) =>
    name === "Validate bundled npm and prepare trusted configuration");
  assert.equal(godotNpmPrepare.env.NODE_AUTH_TOKEN, undefined);
  assert.equal(godotNpmPrepare.env.NPM_CONFIG_REGISTRY, "https://registry.npmjs.org");
  assert.equal(godotNpmPrepare.env.NPM_CONFIG_LOCATION, "global");
  assert.notEqual(
    godotNpmPrepare.env.NPM_CONFIG_USERCONFIG,
    godotNpmPrepare.env.NPM_CONFIG_GLOBALCONFIG,
  );
  assert.match(godotNpmPrepare.run, /test "\$\(npm --version\)" = 11\.13\.0/u);
  assert.doesNotMatch(godotNpmPrepare.run, /npm\s+(?:install|ci|audit|rebuild)/u);
  const godotScripts = godotDefinition.jobs.quality.steps.find(({ name }) =>
    name === "Run exact Godot repository quality scripts without credentials");
  assert.equal(godotScripts.env.NODE_AUTH_TOKEN, undefined);
  assert.equal(godotScripts.env.NPM_CONFIG_LOCATION, "global");
  assert.notEqual(
    godotScripts.env.NPM_CONFIG_USERCONFIG,
    godotScripts.env.NPM_CONFIG_GLOBALCONFIG,
  );
  assert.match(godotScripts.run, /npm --location=global --prefix="\$application_root" --ignore-scripts run test:core/u);
  assert.match(godotScripts.run, /npm --location=global --prefix="\$application_root" --ignore-scripts run check:architecture/u);
  assert.match(godotScripts.run, /npm --location=global --prefix="\$application_root" --ignore-scripts run check:release/u);
  assert.match(godotWorkflow, /godot-checks-v3\.yml/u);
  assert.match(godotWorkflow, /test "\$PROFILE" = godot/u);
  assert.match(godotWorkflow, /test "\$PACKAGE_MANAGER" = null/u);
  assert.match(godotWorkflow, /godot-diagnostic-gate\.mjs/u);
  assert.match(godotWorkflow, /retention-days: 3/u);
  assert.match(aitWorkflow, /github\.event\.repository\.private && 'seorilabs-rpi-arm64' \|\| 'ubuntu-latest'/u);
  // public PR은 실행하지 않고 public build는 exact stable tag release에만 열린다.
  assert.match(aitWorkflow, /github\.event_name != 'pull_request'/u);
  assert.match(aitWorkflow, /release_mode == 'true'/u);
  assert.equal(Object.hasOwn(parse(aitWorkflow).on.workflow_call ?? {}, "inputs"), false);
  assert.match(aitWorkflow, /RUNNER_ROUTE=private-arc/u);
  assert.match(aitWorkflow, /RUNNER_ROUTE=public-github-hosted/u);
  assert.match(aitWorkflow, /resolve-github-tag-commit\.mjs --github-output/u);
  assert.match(aitWorkflow, /find .*\.ait/u);
  assert.match(aitWorkflow, /artifactSha256/u);
  const aitDefinition = parse(aitWorkflow);
  assert.deepEqual(aitDefinition.jobs["resolve-binding"].permissions, {
    contents: "read",
    "id-token": "write",
  });
  assert.deepEqual(aitDefinition.jobs["build-only"].permissions, {
    contents: "read",
    packages: "read",
  });
  assert.equal(
    aitDefinition.jobs["resolve-binding"].steps.some(({ name }) =>
      /application source/iu.test(name)),
    false,
  );
  assert.equal(
    aitDefinition.jobs["build-only"].steps.some(({ name }) =>
      /Write checksum-bound target evidence/u.test(name)),
    false,
  );
  assert.equal(
    aitDefinition.jobs.evidence.steps.some(({ name }) =>
      /Write checksum-bound target evidence/u.test(name)),
    true,
  );
  assert.match(aitWorkflow, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/u);
  for (const definition of [staticDefinition, aitDefinition]) {
    const tokenSteps = Object.values(definition.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.env?.NODE_AUTH_TOKEN !== undefined);
    assert.deepEqual(
      tokenSteps.map(({ name }) => name),
      ["Stage exactly locked dependency cache in an isolated process"],
    );
  }
  assert.match(androidWorkflow, /runs-on: seorilabs-rpi-arm64/u);
  assert.match(androidWorkflow, /id-token: write/u);
  const androidDefinition = parse(androidWorkflow);
  assert.deepEqual(androidDefinition.jobs["resolve-binding"].permissions, {
    contents: "read",
    "id-token": "write",
  });
  assert.equal(
    androidDefinition.jobs["resolve-binding"].steps.some(({ name }) =>
      /application source/iu.test(name)),
    false,
  );
  assert.equal(
    androidDefinition.jobs["submit-build-only"].if,
    "${{ github.event.repository.private }}",
  );
  assert.deepEqual(
    Object.values(androidDefinition.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.env?.NODE_AUTH_TOKEN !== undefined)
      .map(({ name }) => name),
    ["Stage exactly locked dependency cache in an isolated process"],
  );
  for (const definition of [staticDefinition, aitDefinition, androidDefinition]) {
    const stagingSteps = Object.values(definition.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter(({ name }) => name === "Stage exactly locked dependency cache in an isolated process");
    assert.equal(stagingSteps.length, 1);
    assert.equal(stagingSteps[0]["working-directory"], ".seorilabs-workflow-bundle");
    assert.match(stagingSteps[0].run, /^set -euo pipefail\n/u);
    assert.doesNotMatch(stagingSteps[0].run, /cd .*seorilabs-application/u);
  }
  for (const definition of [staticDefinition, aitDefinition, androidDefinition]) {
    const applicationJob = definition.jobs.quality
      ?? definition.jobs["build-only"]
      ?? definition.jobs["submit-build-only"];
    const stepNames = applicationJob.steps.map(({ name }) => name);
    const bootstrapIndex = stepNames.indexOf(
      "Install exact WorkflowBundle runtime dependencies without package credentials",
    );
    const checkoutIndex = stepNames.indexOf("Checkout exact application source");
    assert.ok(bootstrapIndex >= 0 && bootstrapIndex < checkoutIndex);
    const bootstrap = applicationJob.steps[bootstrapIndex];
    assert.equal(bootstrap.env.NODE_AUTH_TOKEN, undefined);
    assert.equal(bootstrap.env.NPM_CONFIG_REGISTRY, "https://registry.npmjs.org");
    assert.notEqual(
      bootstrap.env.NPM_CONFIG_USERCONFIG,
      bootstrap.env.NPM_CONFIG_GLOBALCONFIG,
    );
    assert.match(bootstrap.run, /test -z "\$\{NODE_AUTH_TOKEN:-\}"/u);
    assert.match(bootstrap.run, /npm ci --prefix "\$bundle_root" --ignore-scripts/u);
    assert.match(bootstrap.run, /url\.origin !== "https:\/\/registry\.npmjs\.org"/u);
    const prepare = applicationJob.steps.find(({ name }) =>
      name === "Prepare pinned package managers without package credentials");
    assert.equal(prepare.env.NODE_AUTH_TOKEN, undefined);
    assert.equal(prepare.env.NPM_CONFIG_REGISTRY, "https://registry.npmjs.org");
    assert.equal(prepare.env.NPM_CONFIG_LOCATION, "global");
    assert.equal(prepare.env.NPM_CONFIG_USERCONFIG, bootstrap.env.NPM_CONFIG_USERCONFIG);
    assert.equal(prepare.env.NPM_CONFIG_GLOBALCONFIG, bootstrap.env.NPM_CONFIG_GLOBALCONFIG);
    assert.notEqual(prepare.env.NPM_CONFIG_USERCONFIG, prepare.env.NPM_CONFIG_GLOBALCONFIG);
    assert.match(prepare.run, /test -z "\$\{NODE_AUTH_TOKEN:-\}"/u);
    assert.match(prepare.run, /test "\$\(npm --version\)" = 11\.13\.0/u);
    assert.match(prepare.run, /test "\$\(pnpm --version\)" = 11\.3\.0/u);
    assert.doesNotMatch(prepare.run, /npm\s+(?:install|ci|audit|rebuild)/u);
    assert.ok(stepNames.indexOf(prepare.name) < checkoutIndex);
  }
  assert.doesNotMatch(
    `${aitWorkflow}\n${androidWorkflow}\n${cloudBuild}`,
    /\bait deploy\b|\bfirebase deploy\b|\bgcloud\s+.*\bdeploy\b/u,
  );
  assert.match(cloudBuild, /SEORI_BUILD_MODE=build-only/u);
});

test("RN Cloud Build v2는 ARC cgroup보다 큰 8GB standard worker를 고정한다", async () => {
  const cloudBuild = await readFile(
    ".github/cloud-build/rn-android-build-only-v2.yaml",
    "utf8",
  );
  assert.match(cloudBuild, /machineType: E2_STANDARD_2/u);
  assert.doesNotMatch(cloudBuild, /E2_HIGHCPU_|N1_HIGHCPU_/u);
});

test("Android Cloud Build v2 config는 대문자 셸 변수를 Cloud Build에서 이스케이프한다", async () => {
  for (const path of [
    ".github/cloud-build/godot-android-build-only-v2.yaml",
    ".github/cloud-build/rn-android-build-only-v2.yaml",
  ]) {
    const cloudBuild = await readFile(path, "utf8");
    assert.doesNotMatch(cloudBuild, /substitution_option:\s*ALLOW_LOOSE/u);
    const unescapedShellVariables = [
      ...cloudBuild.matchAll(
        /(?<!\$)\$(?!\$)(?:\{([A-Z_][A-Z0-9_]*)\}|([A-Z_][A-Z0-9_]*))/gu,
      ),
    ].filter(([, bracedName]) => !bracedName?.startsWith("_SEORI_"));
    assert.deepEqual(
      unescapedShellVariables.map(([reference]) => reference),
      [],
      `${path} must escape uppercase shell variables as $$NAME`,
    );
  }
});

test("RN and Godot v2 workflows resolve signed config before app checkout and never upload markets", async () => {
  for (const [profile, path] of [
    ["react-native-android", ".github/workflows/rn-build-android-cloud-v2.yml"],
    ["godot-android", ".github/workflows/godot-build-android-cloud-v2.yml"],
  ]) {
    const source = await readFile(path, "utf8");
    const workflow = parse(source);
    assert.equal(Object.hasOwn(workflow.on.workflow_call ?? {}, "inputs"), false);
    assert.deepEqual(Object.keys(workflow.jobs), ["resolve-binding", "submit-build-only"]);
    assert.equal(
      workflow.jobs["resolve-binding"]["runs-on"],
      "${{ github.event.repository.private && 'seorilabs-rpi-arm64' || 'ubuntu-latest' }}",
    );
    assert.equal(workflow.jobs["submit-build-only"]["runs-on"], "seorilabs-rpi-arm64");
    assert.equal(workflow.jobs["submit-build-only"].environment, "internal");
    assert.deepEqual(workflow.jobs["resolve-binding"].permissions, {
      contents: "read",
      "id-token": "write",
    });
    for (const job of [workflow.jobs["resolve-binding"], workflow.jobs["submit-build-only"]]) {
      const nodeSetupIndex = job.steps.findIndex(({ uses }) =>
        uses === "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
      const firstNodeRunIndex = job.steps.findIndex(({ run }) =>
        typeof run === "string" && /(?:^|\n)\s*node\b/u.test(run));
      assert.ok(nodeSetupIndex >= 0 && nodeSetupIndex < firstNodeRunIndex);
      assert.equal(job.steps[nodeSetupIndex].with["node-version"], "24.16.0");
      assert.equal(job.steps[nodeSetupIndex].with["check-latest"], false);
    }
    assert.equal(
      workflow.jobs["resolve-binding"].steps.some(({ name }) =>
        name === "Checkout exact application source"),
      false,
    );
    const resolve = workflow.jobs["resolve-binding"].steps.find(({ name }) =>
      name === "Resolve current signed build-only binding before app checkout");
    assert.equal(resolve.env.BINDING_TARGET, "android");
    assert.equal(resolve.env.EVENT_SOURCE_SHA, "${{ github.sha }}");
    assert.equal(resolve.env.PR_BASE_SHA, "${{ github.event.pull_request.base.sha }}");
    assert.match(resolve.run, /static-runtime-binding-v5\.mjs/u);
    const submitNames = workflow.jobs["submit-build-only"].steps.map(({ name }) => name);
    assert.ok(
      submitNames.indexOf("Validate resolved non-release request") <
        submitNames.indexOf("Checkout exact application source"),
    );
    assert.ok(
      submitNames.indexOf("Resolve exact canary executor binding") <
        submitNames.indexOf("Authenticate keylessly for Cloud Build"),
    );
    assert.match(source, new RegExp(`buildProfile: "${profile}"`, "u"));
    assert.match(source, /schemaVersion: 2, target: "build"/u);
    assert.match(source, /marketUpload: false/u);
    assert.match(source, /retention-days: 3/u);
    assert.match(source, /vars\.GOOGLE_WORKLOAD_IDENTITY_PROVIDER/u);
    assert.match(source, /vars\.SEORI_CLOUD_BUILD_SUBMITTER_SERVICE_ACCOUNT/u);
    assert.match(source, /resolve-android-cloud-build-target\.mjs/u);
    assert.match(source, /ANDROID_CANARY_BUILD_ONLY/u);
    assert.match(source, /steps\.cloud-target\.outputs\.executor_service_account/u);
    assert.doesNotMatch(source, /seori-cloud-build-executor@seorilabs-ci\.iam\.gserviceaccount\.com/u);
    assert.doesNotMatch(source, /secrets:\s*inherit|uses:.*@main\b|\bdeploy\b|production|public release/iu);
    const tokenSteps = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.env?.NODE_AUTH_TOKEN !== undefined);
    assert.deepEqual(
      tokenSteps.map(({ name }) => name),
      profile === "react-native-android"
        ? ["Stage exact private Platform SDK without exporting the token"]
        : [],
    );
    const auditTransport = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.env?.DEPENDENCY_AUDIT_EXCEPTION !== undefined);
    assert.deepEqual(
      auditTransport.map(({ name }) => name),
      profile === "react-native-android"
        ? ["Stage exact private Platform SDK without exporting the token"]
        : [],
    );
    if (profile === "react-native-android") {
      assert.equal(
        workflow.jobs["resolve-binding"].outputs.dependency_audit_exception,
        "${{ steps.binding.outputs.dependency_audit_exception }}",
      );
      assert.equal(
        auditTransport[0].env.DEPENDENCY_AUDIT_EXCEPTION,
        "${{ needs.resolve-binding.outputs.dependency_audit_exception }}",
      );
      assert.equal(auditTransport[0].env.SEORI_AUDIT_ACTION_CLASS, "ANDROID_BUILD_ONLY");
    }
  }
});

test("public fork PR keeps ARC skipped and makes the required Org Contract fail", async () => {
  for (const workflowPath of [
    ".github/workflows/js-static-checks-v1.yml",
    ".github/workflows/godot-checks-v3.yml",
  ]) {
    const definition = parse(await readFile(workflowPath, "utf8"));
    assert.equal(
      definition.jobs["resolve-binding"].if,
      "${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}",
    );
    assert.equal(
      definition.jobs["resolve-binding"]["runs-on"],
      "${{ github.event.repository.private && 'seorilabs-rpi-arm64' || 'ubuntu-latest' }}",
    );
    assert.equal(
      definition.jobs.quality.if,
      "${{ needs.resolve-binding.result == 'success' }}",
    );
    assert.equal(
      definition.jobs.evidence.if,
      "${{ needs.quality.result == 'success' }}",
    );
    const orgContract = definition.jobs["org-contract"];
    assert.equal(orgContract.if, "${{ always() }}");
    assert.equal(
      orgContract["runs-on"],
      "${{ github.event.repository.private && 'seorilabs-rpi-arm64' || 'ubuntu-latest' }}",
    );
    const enforcement = orgContract.steps.find(({ name }) =>
      name === "Apply lifecycle enforcement");
    const forkResult = spawnSync("bash", ["-e", "-o", "pipefail", "-c", enforcement.run], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        BINDING_RESULT: "skipped",
        QUALITY_RESULT: "skipped",
        EVIDENCE_RESULT: "skipped",
        ENFORCEMENT_MODE: "",
      },
    });
    assert.notEqual(forkResult.status, 0, workflowPath);
  }
});

test("승인된 예외가 없는 감사 실패는 차단 advisory 공개 식별자를 그대로 보고한다", async () => {
  const { root } = await fixtureRepository("saju-reader");
  const cacheRoot = join(root, ".seorilabs-pnpm-store");
  const auditReport = JSON.stringify({
    advisories: {
      1: {
        github_advisory_id: "GHSA-4c9v-hjjm-x577",
        module_name: "left-pad",
        severity: "high",
        findings: [{ version: "1.3.0" }],
      },
      2: {
        github_advisory_id: "GHSA-2p57-rm9w-gvfp",
        module_name: "tar-fs",
        severity: "critical",
        findings: [{ version: "2.1.1" }, { version: "2.1.0" }],
      },
      3: {
        github_advisory_id: "GHSA-6h7j-mpqr-vwx2",
        module_name: "ignored-low",
        severity: "moderate",
        findings: [{ version: "1.0.0" }],
      },
    },
  });
  await assert.rejects(
    stageExactPlatformDependencyV5({
      repoRoot: root,
      dependencyRoot: ".",
      packageManager: "pnpm",
      cacheRoot,
      token: "token-that-must-never-be-persisted",
      childEnvironment: { HOME: "/tmp/fixture-home", PATH: "/usr/bin:/bin" },
      dependencyAuditException: null,
      auditActionClass: "STATIC_CHECK",
      repositoryId: "1250442131",
      fullName: "seorilabs/happy-farm",
      sourceSha: git(root, ["rev-parse", "HEAD"]),
      now: () => new Date("2026-08-30T00:00:00Z"),
      spawn: (_command, _args, options) => {
        if (!options.env.NODE_AUTH_TOKEN) {
          return { status: 1, signal: null, stdout: auditReport };
        }
        mkdirSync(join(cacheRoot, "content"), { recursive: true });
        writeFileSync(join(cacheRoot, "content", "package.tgz"), "public-package-bytes");
        return { status: 0, signal: null };
      },
    }),
    (error) => {
      assert.equal(
        error.message,
        "DEPENDENCY_AUDIT_FAILED:GHSA-2p57-rm9w-gvfp/tar-fs/critical/2.1.0+2.1.1," +
          "GHSA-4c9v-hjjm-x577/left-pad/high/1.3.0",
      );
      assert.doesNotMatch(error.message, /token-that-must-never-be-persisted/u);
      return true;
    },
  );
  assert.equal(await lstat(cacheRoot).catch(() => null), null);
});

test("감사 보고서를 해석할 수 없으면 실패 코드에 상세를 덧붙이지 않는다", async () => {
  const { root } = await fixtureRepository("saju-reader");
  const cacheRoot = join(root, ".seorilabs-pnpm-store");
  await assert.rejects(
    stageExactPlatformDependencyV5({
      repoRoot: root,
      dependencyRoot: ".",
      packageManager: "pnpm",
      cacheRoot,
      token: "token-that-must-never-be-persisted",
      childEnvironment: { HOME: "/tmp/fixture-home", PATH: "/usr/bin:/bin" },
      dependencyAuditException: null,
      auditActionClass: "STATIC_CHECK",
      repositoryId: "1250442131",
      fullName: "seorilabs/happy-farm",
      sourceSha: git(root, ["rev-parse", "HEAD"]),
      now: () => new Date("2026-08-30T00:00:00Z"),
      spawn: (_command, _args, options) => {
        if (!options.env.NODE_AUTH_TOKEN) {
          return { status: 1, signal: null, stdout: "not-json" };
        }
        mkdirSync(join(cacheRoot, "content"), { recursive: true });
        writeFileSync(join(cacheRoot, "content", "package.tgz"), "public-package-bytes");
        return { status: 0, signal: null };
      },
    }),
    (error) => {
      assert.equal(error.message, "DEPENDENCY_AUDIT_FAILED");
      return true;
    },
  );
});

test("Android cloud build은 repo가 executor를 입력하지 못하고 중앙 canary mapping만 사용한다", async () => {
  for (const name of [
    "rn-build-android-cloud-v2.yml",
    "godot-build-android-cloud-v2.yml",
  ]) {
    const source = await readFile(
      new URL(`../.github/workflows/${name}`, import.meta.url),
      "utf8",
    );
    const workflow = parse(source);
    const step = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .find(({ name: stepName }) => stepName === "Resolve exact canary executor binding");
    assert.notEqual(step, undefined, `${name}: target resolver step이 있어야 한다`);
    assert.deepEqual(Object.keys(step.env).toSorted(), [
      "GOOGLE_WORKLOAD_IDENTITY_PROVIDER",
      "SEORI_ACTION_CAPABILITY",
      "SEORI_BUILD_PROFILE",
      "SEORI_CLOUD_BUILD_EXECUTOR_SERVICE_ACCOUNT",
      "SEORI_CLOUD_BUILD_SUBMITTER_SERVICE_ACCOUNT",
      "SEORI_REPOSITORY_FULL_NAME",
      "SEORI_REPOSITORY_ID",
    ]);
    // 값 자체는 공개 변수이며 secret을 참조하지 않는다.
    assert.doesNotMatch(source, /\bsecrets\.(?:GOOGLE|SEORI_CLOUD_BUILD)/u);
    assert.equal(step.env.SEORI_ACTION_CAPABILITY, "ANDROID_CANARY_BUILD_ONLY");
    assert.match(step.run, /resolve-android-cloud-build-target\.mjs/u);
    const submit = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .find(({ name: stepName }) => stepName === "Submit exact source to x64 Cloud Build");
    assert.equal(
      submit.env.CLOUD_BUILD_SERVICE_ACCOUNT,
      "${{ steps.cloud-target.outputs.executor_service_account }}",
    );
    assert.doesNotMatch(source, /ANDROID_PLAY_PROMOTABLE_SIGNED_BUILD/u);
  }
});
