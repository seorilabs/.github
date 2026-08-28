import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign as signEd25519,
} from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";

import {
  createGitHubWorkflowSourceReadback,
  createWorkflowBundle,
  consumePlatformReleaseGateBinding,
  evaluateLegacyWorkflow,
  evaluatePlatformReleaseGate,
  generateAndroidBuildCaller,
  generateXcodeCloudRunContract,
  loadApprovedWorkflowBundle,
  loadResolvedCallerBinding,
  promoteWorkflowBundle,
  validateAndroidBuildCaller,
  validateWorkflowBundle,
  validateXcodeCloudRunContract,
  verifyXcodeCloudRunReadback,
} from "../packages/repo-contract/src/fleet.mjs";
import { runFixtureCanary } from "../scripts/fleet/fixture-canary.mjs";
import { CANARY_BUILD_BY_PROFILE } from "./helpers/workflow-bundle-fixtures.mjs";

const BUNDLE_SHA = "a".repeat(40);
const SOURCE_SHA = "d".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const PLATFORM_RELEASE = Object.freeze({
  sourceSha: "c".repeat(40),
  contractRevision: DIGEST,
  typescript: { version: "1.2.3", digest: DIGEST },
  gdscript: { version: "1.2.3", digest: DIGEST },
});
const EVIDENCE = Object.freeze(
  ["react-native", "godot"].map((profile, index) => ({
    profile,
    gates: ["static", "build-only"],
    repositoryId: profile === "react-native" ? 1250442131 : 1265192029,
    sourceSha: "e".repeat(40),
    workflowBundleSourceSha: BUNDLE_SHA,
    staticRunId: 900 + index * 2,
    buildRunId: 901 + index * 2,
    ...CANARY_BUILD_BY_PROFILE[profile],
    artifactSha256: DIGEST,
  })),
);
const temporaryRoots = [];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

test.afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true }),
    ),
  );
});

function trustedSourceReadbackFor(bundle) {
  return async ({ repository, sourceSha }) => ({
    repository,
    sourceSha,
    contractDigests: structuredClone(bundle.quality.contractDigests),
    runtimeAssetDigests: structuredClone(bundle.quality.runtimeAssetDigests),
    workflowBundleSchemaText: await readFile(
      "contracts/workflow-bundle.schema.json",
      "utf8",
    ),
    contractAssetContents: Object.fromEntries(
      await Promise.all(
        Object.keys(bundle.quality.contractDigests).map(async (path) => [
          path,
          await readFile(path, "utf8"),
        ]),
      ),
    ),
    runtimeAssetContents: Object.fromEntries(
      await Promise.all(
        Object.keys(bundle.quality.runtimeAssetDigests).map(async (path) => [
          path,
          await readFile(path, "utf8"),
        ]),
      ),
    ),
  });
}

const trustedRunnerImageReadback = async (request) => ({
  ...request,
  state: "READY",
  generation: 12,
  observedAt: new Date(Date.now()).toISOString(),
});

function verifiedEvidence(record, bundle) {
  return {
    state: "VERIFIED",
    profile: record.profile,
    repositoryId: record.repositoryId,
    fullName: bundle.quality.canaries[record.profile].fullName,
    sourceSha: record.sourceSha,
    workflowBundleSourceSha: record.workflowBundleSourceSha,
    staticRunId: record.staticRunId,
    buildRunId: record.buildRunId,
    cloudBuildId: record.cloudBuildId,
    builderImage: record.builderImage,
    cloudBuildConfigSha256: record.cloudBuildConfigSha256,
    staticConclusion: "success",
    buildConclusion: "success",
    staticWorkflowRef: `seorilabs/.github/${bundle.reusableWorkflows[record.profile].path}@${bundle.source.sha}`,
    buildWorkflowRef: `seorilabs/.github/${bundle.buildWorkflows[record.profile].path}@${bundle.source.sha}`,
    marketUpload: false,
    artifactSha256: record.artifactSha256,
  };
}

function trustedSignerOptions(privateKey, publicKey, keyId) {
  return {
    trustedApprovalKeys: new Map([[keyId, publicKey]]),
    trustedApprovalSigner: async ({ payload }) => ({
      algorithm: "Ed25519",
      keyId,
      value: signEd25519(null, payload, privateKey).toString("base64url"),
    }),
  };
}

async function approvedContext(profile = "react-native") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const candidate = await createWorkflowBundle({
    sourceSha: BUNDLE_SHA,
    platformRelease: PLATFORM_RELEASE,
  });
  const readback = trustedSourceReadbackFor(candidate);
  const registry = new Map();
  const approved = await promoteWorkflowBundle(candidate, EVIDENCE, {
    evidenceVerifier: async (record, bundle) => verifiedEvidence(record, bundle),
    ...trustedSignerOptions(
      privateKey,
      publicKey,
      "workflow-bundle-v4-test",
    ),
    trustedWorkflowSourceReadback: readback,
    trustedRunnerImageReadback,
    registryPublisher: async (record) => {
      registry.set(record.subject, structuredClone(record));
      return record;
    },
  });
  const bundleBinding = await loadApprovedWorkflowBundle(approved, {
    trustedApprovalKeys: new Map([["workflow-bundle-v4-test", publicKey]]),
    trustedRegistryReadback: async ({ subject }) => registry.get(subject),
    trustedWorkflowSourceReadback: readback,
    trustedRunnerImageReadback,
  });
  const repositoryContext = {
    repositoryId: "7001",
    fullName: "seorilabs/example-app",
    sourceSha: SOURCE_SHA,
  };
  const manifest = {
    state: "ACTIVE",
    repositoryId: repositoryContext.repositoryId,
    fullName: repositoryContext.fullName,
    sourceSha: repositoryContext.sourceSha,
    sourceRef: "refs/heads/main",
    observationId: "cm-observation-1",
    sourcePayloadDigest: DIGEST,
    profile,
    packageManager: "pnpm",
    workingDirectory: profile === "react-native" ? "apps/mobile" : ".",
    configId: "cm1234567890",
    configRevision: 7,
    snapshotDigest: "f".repeat(64),
    configSignatureDigest: `sha256:${"1".repeat(64)}`,
  };
  const callerBinding = await loadResolvedCallerBinding(repositoryContext, {
    trustedResolvedManifestReadback: async () => structuredClone(manifest),
  });
  return {
    approved,
    bundleBinding,
    callerBinding,
    manifest,
    repositoryContext,
  };
}

test("v4 bundle은 고정 action, Android Cloud Build, Xcode Cloud와 shadow 경계를 묶는다", async () => {
  const bundle = await createWorkflowBundle({ sourceSha: BUNDLE_SHA });
  assert.equal(bundle.bundleVersion, "4.1.0");
  assert.deepEqual(bundle.quality.requiredCanaryGates, ["static", "build-only"]);
  assert.deepEqual(Object.keys(bundle.actions).sort(), [
    "checkout",
    "google-auth",
    "setup-gcloud",
    "setup-node",
    "upload-artifact",
  ]);
  assert.equal(bundle.delivery.android.submitRunner, "seorilabs-rpi-arm64");
  assert.equal(bundle.delivery.android.executor, "cloud-build-x64");
  assert.equal(bundle.delivery.android.project, "seorilabs-ci");
  assert.equal(bundle.delivery.android.artifactBucket, "gs://seorilabs-ci-build-artifacts");
  assert.equal(bundle.toolchains.gcloud, "582.0.0");
  assert.equal(
    bundle.runners.androidSubmitImage,
    "registry.vzyx.xyz/seorilabs/arc-runner-node24@sha256:4663a0066aa61f05006af285f2d5bcf95855fd9e8256c44c08c9e32ff92ac45e",
  );
  assert.equal(bundle.delivery.ios.executor, "xcode-cloud");
  assert.equal(bundle.delivery.ios.githubMacosAllowed, false);
  assert.deepEqual(bundle.callerPolicies.androidBuild.namedSecrets, []);
  assert.deepEqual(bundle.callerPolicies.androidBuild.permissions, {
    "react-native": {
      contents: "read",
      "id-token": "write",
      packages: "read",
    },
    godot: { contents: "read", "id-token": "write" },
  });
  assert.equal(
    bundle.callerPolicies.androidBuild.sourceBinding,
    "backoffice-resolved-manifest",
  );
  assert.equal(
    bundle.callerPolicies.androidBuild.managedCallerPath,
    ".github/workflows/android-build-only.yml",
  );
  assert.equal(
    bundle.callerPolicies.androidBuild.requiredRef,
    "refs/heads/main",
  );
  assert.deepEqual(bundle.quality.canaries, {
    "react-native": {
      repositoryId: 1250442131,
      fullName: "seorilabs/happy-farm",
    },
    godot: {
      repositoryId: 1265192029,
      fullName: "seorilabs/lizard-tycoon",
    },
  });
  assert.deepEqual(bundle.rollout, {
    mode: "SHADOW",
    ruleset: "EVALUATE",
    legacyConsumersPreserved: true,
  });
  assert.equal(bundle.platformGate.release.mode, "FAIL_CLOSED");
  assert.equal(bundle.platformGate.static.mode, "SHADOW");
});

test("profile build workflow path를 서로 바꾼 candidate는 integrity를 다시 계산해도 거부한다", async () => {
  const bundle = await createWorkflowBundle({ sourceSha: BUNDLE_SHA });
  bundle.buildWorkflows["react-native"].path =
    ".github/workflows/godot-build-android-cloud-v1.yml";
  delete bundle.integrity;
  bundle.integrity = {
    algorithm: "sha256",
    payloadDigest: sha256(canonicalJson(bundle)),
  };
  const result = await validateWorkflowBundle(bundle);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.includes("BUILD_WORKFLOW_DECLARATION_MISMATCH"),
  );

  const runnerMismatch = await createWorkflowBundle({ sourceSha: BUNDLE_SHA });
  runnerMismatch.runners.privateGeneralImage =
    `registry.vzyx.xyz/seorilabs/arc-runner-node24@sha256:${"0".repeat(64)}`;
  delete runnerMismatch.integrity;
  runnerMismatch.integrity = {
    algorithm: "sha256",
    payloadDigest: sha256(canonicalJson(runnerMismatch)),
  };
  const runnerResult = await validateWorkflowBundle(runnerMismatch);
  assert.equal(runnerResult.ok, false);
  assert.ok(
    runnerResult.diagnostics.includes("RUNNER_IMAGE_DECLARATION_MISMATCH"),
  );
});

test("bundle 승격은 profile별 static과 build-only gate evidence가 모두 없으면 외부 publish 전에 거부한다", async () => {
  const candidate = await createWorkflowBundle({
    sourceSha: BUNDLE_SHA,
    platformRelease: PLATFORM_RELEASE,
  });
  let published = false;
  let verified = false;
  await assert.rejects(
    promoteWorkflowBundle(
      candidate,
      EVIDENCE.map((record) => ({ ...record, gates: ["static"] })),
      {
        evidenceVerifier: async () => {
          verified = true;
          return true;
        },
        registryPublisher: async (record) => {
          published = true;
          return record;
        },
      },
    ),
    /CANARY_EVIDENCE_INVALID/u,
  );
  assert.equal(verified, false);
  assert.equal(published, false);
});

test("canary 승격 원장은 Cloud Build 실행과 signed builder/config를 exact match한다", async () => {
  const candidate = await createWorkflowBundle({
    sourceSha: BUNDLE_SHA,
    platformRelease: PLATFORM_RELEASE,
  });
  for (const record of EVIDENCE) {
    assert.equal(
      record.builderImage,
      candidate.delivery.android.builderImages[record.profile],
    );
    assert.equal(
      record.cloudBuildConfigSha256,
      candidate.quality.runtimeAssetDigests[
        `.github/cloud-build/${record.profile === "react-native" ? "rn" : "godot"}-android-build-only.yaml`
      ],
    );
  }

  const wrongConfigEvidence = EVIDENCE.map((record, index) => ({
    ...record,
    cloudBuildConfigSha256:
      index === 0 ? `sha256:${"0".repeat(64)}` : record.cloudBuildConfigSha256,
  }));
  await assert.rejects(
    promoteWorkflowBundle(candidate, wrongConfigEvidence),
    /CANARY_EVIDENCE_INVALID/u,
  );

  await assert.rejects(
    promoteWorkflowBundle(candidate, EVIDENCE, {
      trustedWorkflowSourceReadback: trustedSourceReadbackFor(candidate),
      trustedRunnerImageReadback,
      evidenceVerifier: async (record, bundle) => {
        const verified = verifiedEvidence(record, bundle);
        if (record.profile === "react-native") {
          verified.cloudBuildId = "33333333-3333-4333-8333-333333333333";
        }
        return verified;
      },
    }),
    /CANARY_EVIDENCE_READBACK_FAILED/u,
  );
});

test("exact GitHub readback은 과거 bundle의 signed path set을 허용하되 traversal을 거부한다", async () => {
  const contractPaths = ["contracts/workflow-bundle.schema.json"];
  const runtimeAssetPaths = [".github/workflows/rn-static-checks-v2.yml"];
  const readback = createGitHubWorkflowSourceReadback({
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.pathname.endsWith(`/commits/${BUNDLE_SHA}`)) {
        return { ok: true, status: 200, json: async () => ({ sha: BUNDLE_SHA }) };
      }
      const prefix = "/repos/seorilabs/.github/contents/";
      const path = decodeURIComponent(url.pathname.slice(prefix.length));
      const content = await readFile(path);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          type: "file",
          encoding: "base64",
          content: content.toString("base64"),
        }),
      };
    },
  });
  const snapshot = await readback({
    repository: "seorilabs/.github",
    sourceSha: BUNDLE_SHA,
    contractPaths,
    runtimeAssetPaths,
  });
  assert.deepEqual(Object.keys(snapshot.contractDigests), contractPaths);
  assert.deepEqual(Object.keys(snapshot.contractAssetContents), contractPaths);
  assert.deepEqual(Object.keys(snapshot.runtimeAssetDigests), runtimeAssetPaths);
  await assert.rejects(
    readback({
      repository: "seorilabs/.github",
      sourceSha: BUNDLE_SHA,
      contractPaths: ["contracts/workflow-bundle.schema.json", "../package.json"],
      runtimeAssetPaths,
    }),
    /GITHUB_SOURCE_REQUEST_INVALID/u,
  );
});

test("v4 runtime asset 추가 뒤에도 buildWorkflows가 없던 signed v3 bundle을 static rollback에 로드한다", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const legacy = await createWorkflowBundle({
    sourceSha: BUNDLE_SHA,
    platformRelease: PLATFORM_RELEASE,
  });
  legacy.bundleVersion = "3.0.0";
  delete legacy.buildWorkflows;
  delete legacy.callerPolicies;
  delete legacy.delivery;
  delete legacy.rollout;
  delete legacy.platformGate;
  delete legacy.quality.requiredCanaryGates;
  delete legacy.quality.canaries;
  delete legacy.actions["google-auth"];
  delete legacy.actions["setup-gcloud"];
  delete legacy.runners.androidSubmit;
  delete legacy.runners.privateGeneralImage;
  delete legacy.runners.androidSubmitImage;
  delete legacy.toolchains.gcloud;
  const legacyRuntimePaths = [
    ".github/workflows/godot-checks-v2.yml",
    ".github/workflows/rn-static-checks-v2.yml",
    "scripts/fleet/secret-scan.mjs",
    "scripts/fleet/static-preflight.mjs",
    "scripts/fleet/write-provenance.mjs",
  ];
  const legacyWorkflowDigests = {
    ".github/workflows/rn-static-checks-v2.yml":
      "sha256:37ca3e10b701607c504d7bf027987c7f609e65955a4a807f1bf6f895f2f0a7df",
    ".github/workflows/godot-checks-v2.yml":
      "sha256:ae856034b919397b4be33ca524d304e07d0b9209d1deead321292dcd7e7dcf3b",
  };
  const runtimeAssetContents = Object.fromEntries(
    await Promise.all(
      legacyRuntimePaths.map(async (path) => {
        let contents = await readFile(path, "utf8");
        if (path.endsWith("-checks-v2.yml")) {
          contents = contents
            .replace("          path: .seorilabs-application\n", "")
            .replaceAll(
              "$GITHUB_WORKSPACE/.seorilabs-application",
              "$GITHUB_WORKSPACE",
            )
            .replaceAll(
              "${{ format('.seorilabs-application/{0}', inputs.working_directory) }}",
              "${{ inputs.working_directory }}",
            )
            .replace(
              [
                "      - name: Probe pinned Godot toolchain diagnostics",
                "        shell: bash",
                "        run: |",
                "          set -euo pipefail",
                "          cp -R \\",
                "            \"$GITHUB_WORKSPACE/.seorilabs-org/fixtures/workflow-bundle/godot/toolchain-probe\" \\",
                '            "$RUNNER_TEMP/godot-toolchain-probe"',
                "          godot --headless \\",
                "            --path \"$RUNNER_TEMP/godot-toolchain-probe\" \\",
                "            --import --quit-after 1 2>&1 \\",
                '            | tee "$RUNNER_TEMP/godot-toolchain.log"',
                "",
                "      - name: Import Godot project",
                "        shell: bash",
                "        working-directory: ${{ inputs.working_directory }}",
                "        run: |",
                "          set -euo pipefail",
                '          godot --headless --import --quit-after 1 2>&1 | tee "$RUNNER_TEMP/godot-import.log"',
                "",
                "      - name: Reject product Godot diagnostics",
                "        shell: bash",
                "        run: |",
                "          node .seorilabs-org/scripts/fleet/godot-diagnostic-gate.mjs \\",
                "            --toolchain-log \"$RUNNER_TEMP/godot-toolchain.log\" \\",
                "            --application-log \"$RUNNER_TEMP/godot-import.log\" \\",
                '            --summary "$GITHUB_STEP_SUMMARY"',
              ].join("\n"),
              [
                "      - name: Import Godot project and reject engine errors",
                "        shell: bash",
                "        working-directory: ${{ inputs.working_directory }}",
                "        run: |",
                "          set -euo pipefail",
                '          godot --headless --import --quit-after 1 2>&1 | tee "$RUNNER_TEMP/godot-import.log"',
                "          if grep -E 'SCRIPT ERROR|ERROR:' \"$RUNNER_TEMP/godot-import.log\"; then",
                '            echo "Godot import log에 오류가 있습니다." >&2',
                "            exit 1",
                "          fi",
              ].join("\n"),
            )
            .replace(
              "        with:\n          persist-credentials: false\n",
              "",
            )
            .replace(/\n          persist-credentials: false/gu, "")
            .replace(
              "    if: ${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}\n",
              "",
            )
            .replace(
              "    permissions:\n      contents: read\n    runs-on:",
              "    runs-on:",
            );
          assert.doesNotMatch(contents, /persist-credentials/u);
          assert.equal(sha256(contents), legacyWorkflowDigests[path]);
        }
        return [path, contents];
      }),
    ),
  );
  legacy.quality.runtimeAssetDigests = Object.fromEntries(
    legacyRuntimePaths.map((path) => [path, sha256(runtimeAssetContents[path])]),
  );

  const oldSchema = JSON.parse(
    await readFile("contracts/workflow-bundle.schema.json", "utf8"),
  );
  for (const key of [
    "buildWorkflows",
    "callerPolicies",
    "delivery",
    "rollout",
    "platformGate",
  ]) {
    oldSchema.required = oldSchema.required.filter((item) => item !== key);
    delete oldSchema.properties[key];
  }
  oldSchema.properties.quality.required =
    oldSchema.properties.quality.required.filter(
      (item) => !["requiredCanaryGates", "canaries"].includes(item),
    );
  delete oldSchema.properties.quality.properties.requiredCanaryGates;
  delete oldSchema.properties.quality.properties.canaries;
  oldSchema.properties.runners.required =
    oldSchema.properties.runners.required.filter(
      (item) => item !== "androidSubmit",
    );
  delete oldSchema.properties.runners.properties.androidSubmit;
  for (const key of ["privateGeneralImage", "androidSubmitImage"]) {
    oldSchema.properties.runners.required =
      oldSchema.properties.runners.required.filter((item) => item !== key);
    delete oldSchema.properties.runners.properties[key];
  }
  oldSchema.properties.toolchains.required =
    oldSchema.properties.toolchains.required.filter((item) => item !== "gcloud");
  delete oldSchema.properties.toolchains.properties.gcloud;
  for (const key of [
    "gates",
    "workflowBundleSourceSha",
    "staticRunId",
    "buildRunId",
    "cloudBuildId",
    "builderImage",
    "cloudBuildConfigSha256",
  ]) {
    oldSchema.$defs.canaryEvidence.required =
      oldSchema.$defs.canaryEvidence.required.filter((item) => item !== key);
    delete oldSchema.$defs.canaryEvidence.properties[key];
  }
  oldSchema.$defs.canaryEvidence.required.push("runId");
  oldSchema.$defs.canaryEvidence.properties.runId = {
    type: "integer",
    minimum: 1,
  };
  oldSchema.$defs.signedApproval.required =
    oldSchema.$defs.signedApproval.required.filter(
      (item) => item !== "runnerImage",
  );
  delete oldSchema.$defs.signedApproval.properties.runnerImage;
  oldSchema.properties.bundleVersion = { const: "3.0.0" };
  const oldSchemaText = `${JSON.stringify(oldSchema, null, 2)}\n`;
  legacy.quality.contractDigests["contracts/workflow-bundle.schema.json"] =
    sha256(oldSchemaText);
  legacy.approval = {
    state: "APPROVED",
    requiredCanaries: ["react-native", "godot"],
    evidence: EVIDENCE.map((record) => ({
      profile: record.profile,
      repositoryId: record.repositoryId,
      sourceSha: record.sourceSha,
      runId: record.staticRunId,
      artifactSha256: record.artifactSha256,
    })).sort((left, right) => left.profile.localeCompare(right.profile)),
    registry: {
      id: "seorilabs-workflow-bundles-v1",
      subject: `workflow-bundle/3.0.0/${BUNDLE_SHA}`,
    },
  };
  delete legacy.integrity;
  legacy.approval.signature = {
    algorithm: "Ed25519",
    keyId: "legacy-v3-test",
    value: signEd25519(
      null,
      Buffer.from(canonicalJson(legacy)),
      privateKey,
    ).toString("base64url"),
  };
  legacy.integrity = {
    algorithm: "sha256",
    payloadDigest: sha256(canonicalJson(legacy)),
  };
  const registryRecord = {
    registryId: legacy.approval.registry.id,
    subject: legacy.approval.registry.subject,
    bundleDigest: legacy.integrity.payloadDigest,
    sourceSha: BUNDLE_SHA,
    bundleVersion: "3.0.0",
    state: "APPROVED",
  };
  const binding = await loadApprovedWorkflowBundle(legacy, {
    trustedApprovalKeys: new Map([["legacy-v3-test", publicKey]]),
    trustedRegistryReadback: async () => registryRecord,
    trustedWorkflowSourceReadback: async () => ({
      repository: "seorilabs/.github",
      sourceSha: BUNDLE_SHA,
      contractDigests: structuredClone(legacy.quality.contractDigests),
      runtimeAssetDigests: structuredClone(legacy.quality.runtimeAssetDigests),
      workflowBundleSchemaText: oldSchemaText,
      runtimeAssetContents,
    }),
  });
  assert.deepEqual(binding.buildWorkflowByProfile, {});
  assert.equal(binding.workflowByProfile.godot.sha, BUNDLE_SHA);
});

test("Android caller generator는 full SHA, 최소 권한, 고정 concurrency와 zero-secret만 만든다", async () => {
  const context = await approvedContext("react-native");
  const caller = await generateAndroidBuildCaller({
    approvedBundleBinding: context.bundleBinding,
    callerBinding: context.callerBinding,
  });
  const validation = await validateAndroidBuildCaller(caller, {
    approvedBundleBinding: context.bundleBinding,
    callerBinding: context.callerBinding,
    repositoryContext: context.repositoryContext,
  });
  assert.equal(validation.ok, true, validation.diagnostics.join(","));
  assert.equal(validation.enforcement, "SHADOW");
  assert.match(
    caller,
    /rn-build-android-cloud-v1\.yml@a{40}/u,
  );
  assert.match(caller, new RegExp(`source_sha: ${SOURCE_SHA}`, "u"));
  assert.deepEqual(parse(caller).permissions, {
    contents: "read",
    "id-token": "write",
    packages: "read",
  });
  assert.doesNotMatch(caller, /secrets:|runs-on:|@main|inputs\.source_sha/u);

  const mutations = [
    caller.replace(`@${BUNDLE_SHA}`, "@main"),
    caller.replace(
      "    with:",
      "    secrets: inherit\n    with:",
    ),
    caller.replace("  id-token: write", "  id-token: write\n  actions: write"),
    caller.replace(
      "    name: Android Build-only",
      "    name: Android Build-only\n    runs-on: ubuntu-latest",
    ),
    caller.replace(
      "android-build-${{ github.repository_id }}-" + SOURCE_SHA,
      "android-build-${{ github.repository_id }}",
    ),
    caller.replace(`source_sha: ${SOURCE_SHA}`, `source_sha: ${"e".repeat(40)}`),
    caller.replace("working_directory: apps/mobile", "working_directory: ../escape"),
  ];
  for (const mutation of mutations) {
    const rejected = await validateAndroidBuildCaller(mutation, {
      approvedBundleBinding: context.bundleBinding,
      callerBinding: context.callerBinding,
      repositoryContext: context.repositoryContext,
    });
    assert.equal(rejected.ok, false, mutation);
  }
});

test("Godot Android caller에는 사용하지 않는 package 권한을 부여하지 않는다", async () => {
  const context = await approvedContext("godot");
  const caller = await generateAndroidBuildCaller({
    approvedBundleBinding: context.bundleBinding,
    callerBinding: context.callerBinding,
  });
  assert.deepEqual(parse(caller).permissions, {
    contents: "read",
    "id-token": "write",
  });
  const validation = await validateAndroidBuildCaller(caller, {
    approvedBundleBinding: context.bundleBinding,
    callerBinding: context.callerBinding,
    repositoryContext: context.repositoryContext,
  });
  assert.equal(validation.ok, true, validation.diagnostics.join(","));
});

test("Android reusable workflow는 RPI submit/fetch만 하고 x64 Cloud Build에 exact source를 보낸다", async () => {
  for (const profile of ["rn", "godot"]) {
    const workflow = await readFile(
      `.github/workflows/${profile}-build-android-cloud-v1.yml`,
      "utf8",
    );
    const parsed = parse(workflow);
    const job = parsed.jobs["submit-build-only"];
    assert.equal(job["runs-on"], "seorilabs-rpi-arm64");
    assert.equal(job.environment, "internal");
    assert.equal(job.if, "${{ github.event.repository.private }}");
    assert.deepEqual(
      parsed.permissions,
      profile === "rn"
        ? { contents: "read", "id-token": "write", packages: "read" }
        : { contents: "read", "id-token": "write" },
    );
    assert.equal(parsed.on.workflow_call.secrets, undefined);
    assert.deepEqual(Object.keys(parsed.on.workflow_call.inputs).sort(), [
      "source_sha",
      "working_directory",
    ]);
    assert.match(workflow, /gcloud config set billing\/quota_project seorilabs-ci/u);
    assert.match(workflow, /--project=seorilabs-ci/u);
    assert.match(workflow, /--region=asia-northeast3/u);
    assert.match(workflow, /--ignore-file="\$ignore_file"/u);
    assert.match(
      workflow,
      /ignore_file="\$RUNNER_TEMP\/seorilabs-cloud-build\.ignore"/u,
    );
    assert.doesNotMatch(workflow, /ignore_file="\$application_root\//u);
    assert.match(workflow, /gha-creds-\*\.json/u);
    assert.match(workflow, /ref: \$\{\{ inputs\.source_sha \}\}/u);
    assert.match(workflow, /path: \.seorilabs-application/u);
    assert.match(workflow, /gcloud builds submit "\$application_root"/u);
    assert.match(workflow, /git -C "\$application_root" rev-parse HEAD/u);
    assert.doesNotMatch(workflow, /gcloud builds submit "\$GITHUB_WORKSPACE"/u);
    assert.match(workflow, /CALLER_WORKFLOW_REF: \$\{\{ github\.workflow_ref \}\}/u);
    assert.match(workflow, /EVENT_REF: \$\{\{ github\.ref \}\}/u);
    assert.match(
      workflow,
      /\.github\/workflows\/android-build-only\.yml@refs\/heads\/main/u,
    );
    if (profile === "rn") {
      assert.match(workflow, /stage-private-pnpm-store\.mjs/u);
      assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ github\.token \}\}/u);
      assert.match(workflow, /ulimit -c 0/u);
    } else {
      assert.doesNotMatch(workflow, /stage-private-pnpm-store\.mjs/u);
    }
    assert.ok(
      workflow.indexOf("test \"$CALLER_WORKFLOW_REF\"") <
        workflow.indexOf("Authenticate keylessly for Cloud Build"),
    );
    assert.match(workflow, /gcloud storage cp/u);
    assert.match(workflow, /segment" != "\." && "\$segment" != "\.\."/u);
    assert.match(workflow, /version: 582\.0\.0/u);
    assert.match(workflow, /artifactSha256/u);
    assert.match(workflow, /cloudBuildConfigSha256/u);
    assert.match(workflow, /workflowBundleSourceSha/u);
    assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/android-aab/u);
    assert.doesNotMatch(workflow, /gradlew|godot --headless|upload-google-play|androidpublisher/u);
    for (const uses of [...workflow.matchAll(/uses: ([^\s#]+)/gu)].map((match) => match[1])) {
      assert.match(uses, /@[0-9a-f]{40}$/u, uses);
    }
    const checkoutSteps = job.steps.filter((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    assert.equal(checkoutSteps.length, 2);
    assert.ok(
      checkoutSteps.every((step) => step.with?.["persist-credentials"] === false),
    );
  }
});

test("Cloud Build config는 digest-pinned builder와 build-only artifact만 허용한다", async () => {
  const expectations = {
    rn: CANARY_BUILD_BY_PROFILE["react-native"].builderImage.split(
      "@sha256:",
    )[1],
    godot: CANARY_BUILD_BY_PROFILE.godot.builderImage.split("@sha256:")[1],
  };
  for (const [profile, digest] of Object.entries(expectations)) {
    const config = await readFile(
      `.github/cloud-build/${profile}-android-build-only.yaml`,
      "utf8",
    );
    const parsed = parse(config);
    assert.match(parsed.steps[0].name, new RegExp(`@sha256:${digest}$`, "u"));
    assert.match(config, /scripts\/build-android\.sh/u);
    assert.match(config, /SEORI_BUILD_MODE=build-only/u);
    assert.match(config, /rm -f "\$SEORI_ANDROID_AAB_OUTPUT"/u);
    assert.match(config, /working_directory="\$\(realpath/u);
    assert.match(config, /"\$workspace_root"\/\*/u);
    assert.match(config, /SEORI_ANDROID_AAB_OUTPUT=\/workspace\/app-release\.aab/u);
    if (profile === "rn") {
      assert.match(config, /pnpm_config_store_dir/u);
      assert.match(config, /pnpm_config_enable_global_virtual_store=false/u);
      assert.match(config, /npm_config_userconfig=\/dev\/null/u);
      assert.match(config, /\$private_store\/v11/u);
    } else {
      assert.doesNotMatch(config, /pnpm_config_store_dir/u);
    }
    assert.deepEqual(parsed.artifacts.objects.paths, ["app-release.aab"]);
    assert.equal(parsed.options.logging, "CLOUD_LOGGING_ONLY");
    assert.doesNotMatch(config, /google.?play|androidpublisher|tracks\/|edits\//iu);
  }
});

test("Xcode Cloud generator는 ASC ciBuildRuns build-only 계약만 만들고 GitHub macOS를 배제한다", async () => {
  const context = await approvedContext("godot");
  const targetReadback = async (request) => ({
    ...request,
    state: "ACTIVE",
    productId: "product-123",
    workflowId: "workflow-456",
    bindingObservationId: "cm-xcode-binding-1",
    distribution: "BUILD_ONLY",
    sourceReferenceId: "git-reference-123",
    sourceReferenceName: `seori-rc-${request.sourceSha}`,
    sourceReferenceKind: "TAG",
    sourceReferenceCommitSha: request.sourceSha,
    sourceReferenceImmutable: true,
  });
  const contract = await generateXcodeCloudRunContract(
    {
      approvedBundleBinding: context.bundleBinding,
      callerBinding: context.callerBinding,
      runId: "agent-run-789",
      idempotencyKey: "xcode-run-0000000001",
    },
    { trustedXcodeCloudTargetReadback: targetReadback },
  );
  assert.equal(contract.provider.action, "ciBuildRuns.create");
  assert.equal(contract.provider.distribution, "BUILD_ONLY");
  assert.equal(contract.provider.bindingObservationId, "cm-xcode-binding-1");
  assert.equal(contract.provider.sourceReference.kind, "TAG");
  assert.equal(contract.provider.sourceReference.commitSha, SOURCE_SHA);
  assert.equal(
    contract.provider.createRequest.body.data.relationships.sourceBranchOrTag.data.id,
    "git-reference-123",
  );
  assert.equal(
    contract.provider.requiredReadback.expectedSourceCommitSha,
    SOURCE_SHA,
  );
  assert.equal(contract.marketUpload, false);
  assert.equal(contract.githubRunner, null);
  assert.deepEqual(contract.requiredScripts, [
    "ios/ci_scripts/ci_post_clone.sh",
    "ios/ci_scripts/ci_pre_xcodebuild.sh",
  ]);
  const valid = await validateXcodeCloudRunContract(contract, {
    approvedBundleBinding: context.bundleBinding,
    callerBinding: context.callerBinding,
    repositoryContext: context.repositoryContext,
    trustedXcodeCloudTargetReadback: targetReadback,
  });
  assert.equal(valid.ok, true, valid.diagnostics.join(","));
  assert.notEqual(valid.contract, contract);
  assert.equal(Object.isFrozen(valid.contract.provider), true);

  const observedAt = "2026-08-28T00:00:00.000Z";
  const runReadback = await verifyXcodeCloudRunReadback(
    contract,
    "ci-build-run-123",
    {
      approvedBundleBinding: context.bundleBinding,
      callerBinding: context.callerBinding,
      repositoryContext: context.repositoryContext,
      trustedXcodeCloudTargetReadback: targetReadback,
      now: () => Date.parse(observedAt),
      trustedXcodeCloudRunReadback: async (request) => ({
        state: "VERIFIED",
        action: request.action,
        providerRunId: request.providerRunId,
        productId: request.productId,
        workflowId: request.workflowId,
        sourceReferenceId: request.sourceReferenceId,
        sourceCommitSha: request.expectedSourceCommitSha,
        marketUpload: false,
        observedAt,
      }),
    },
  );
  assert.equal(runReadback.ok, true, runReadback.diagnostics.join(","));
  assert.equal(runReadback.evidence.sourceCommitSha, SOURCE_SHA);

  const movedReference = await verifyXcodeCloudRunReadback(
    contract,
    "ci-build-run-124",
    {
      approvedBundleBinding: context.bundleBinding,
      callerBinding: context.callerBinding,
      repositoryContext: context.repositoryContext,
      trustedXcodeCloudTargetReadback: targetReadback,
      now: () => Date.parse(observedAt),
      trustedXcodeCloudRunReadback: async (request) => ({
        state: "VERIFIED",
        action: request.action,
        providerRunId: request.providerRunId,
        productId: request.productId,
        workflowId: request.workflowId,
        sourceReferenceId: request.sourceReferenceId,
        sourceCommitSha: "e".repeat(40),
        marketUpload: false,
        observedAt,
      }),
    },
  );
  assert.equal(movedReference.ok, false);
  assert.ok(
    movedReference.diagnostics.includes("XCODE_RUN_READBACK_MISMATCH"),
  );

  const forbidden = structuredClone(contract);
  forbidden.githubRunner = "macos-15";
  forbidden.marketUpload = true;
  const rejected = await validateXcodeCloudRunContract(forbidden, {
    approvedBundleBinding: context.bundleBinding,
    callerBinding: context.callerBinding,
    repositoryContext: context.repositoryContext,
    trustedXcodeCloudTargetReadback: targetReadback,
  });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.diagnostics.includes("XCODE_BUILD_ONLY_POLICY_MISMATCH"));

  const malformed = await validateXcodeCloudRunContract(undefined, {
    approvedBundleBinding: context.bundleBinding,
    callerBinding: context.callerBinding,
    repositoryContext: context.repositoryContext,
    trustedXcodeCloudTargetReadback: targetReadback,
  });
  assert.equal(malformed.ok, false);
  assert.ok(
    malformed.diagnostics.some((diagnostic) =>
      diagnostic.startsWith("XCODE_SCHEMA_"),
    ),
  );

  const untrustedBundle = await validateXcodeCloudRunContract(contract, {
    callerBinding: context.callerBinding,
    repositoryContext: context.repositoryContext,
    trustedXcodeCloudTargetReadback: targetReadback,
  });
  assert.equal(untrustedBundle.ok, false);
  assert.ok(
    untrustedBundle.diagnostics.includes(
      "APPROVED_BUNDLE_BINDING_REQUIRED",
    ),
  );
  assert.equal(
    untrustedBundle.diagnostics.includes("XCODE_SIGNED_SCHEMA_UNREADABLE"),
    false,
  );

  const wrongTarget = await validateXcodeCloudRunContract(contract, {
    approvedBundleBinding: context.bundleBinding,
    callerBinding: context.callerBinding,
    repositoryContext: context.repositoryContext,
    trustedXcodeCloudTargetReadback: async (request) => ({
      ...request,
      state: "ACTIVE",
      productId: "other-product",
      workflowId: "other-workflow",
      bindingObservationId: "cm-xcode-binding-2",
      distribution: "BUILD_ONLY",
      sourceReferenceId: "git-reference-456",
      sourceReferenceName: `seori-rc-${request.sourceSha}`,
      sourceReferenceKind: "TAG",
      sourceReferenceCommitSha: request.sourceSha,
      sourceReferenceImmutable: true,
    }),
  });
  assert.equal(wrongTarget.ok, false);
  assert.ok(wrongTarget.diagnostics.includes("XCODE_TARGET_BINDING_MISMATCH"));

  const schemaRoot = await mkdtemp(join(tmpdir(), "xcode-schema-rollback-"));
  temporaryRoots.push(schemaRoot);
  await mkdir(join(schemaRoot, "contracts"), { recursive: true });
  await writeFile(
    join(schemaRoot, "contracts/xcode-cloud-run.schema.json"),
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}\n',
  );
  const driftedSchema = await validateXcodeCloudRunContract(contract, {
    approvedBundleBinding: context.bundleBinding,
    callerBinding: context.callerBinding,
    repositoryContext: context.repositoryContext,
    repoRoot: schemaRoot,
    trustedXcodeCloudTargetReadback: targetReadback,
  });
  assert.equal(driftedSchema.ok, true, driftedSchema.diagnostics.join(","));
  assert.equal(
    driftedSchema.diagnostics.includes("XCODE_SIGNED_SCHEMA_MISMATCH"),
    false,
  );
});

test("legacy workflow 진단은 @main, inherit, 임의 runner와 hosted build를 shadow로만 관찰한다", () => {
  const legacy = `
name: Legacy
on: {workflow_dispatch: {}}
jobs:
  build:
    runs-on: \${{ inputs.runs_on }}
    uses: seorilabs/.github/.github/workflows/rn-build-android.yml@main
    secrets: inherit
`;
  const result = evaluateLegacyWorkflow(legacy, { scope: "android" });
  assert.equal(result.blocking, false);
  assert.equal(result.mode, "SHADOW");
  assert.deepEqual(result.diagnostics, [
    "LEGACY_ARBITRARY_RUNNER",
    "LEGACY_FLOATING_CENTRAL_WORKFLOW",
    "LEGACY_SECRET_INHERITANCE",
  ]);

  const hosted = evaluateLegacyWorkflow(
    "name: Legacy\non: {workflow_dispatch: {}}\njobs: {build: {runs-on: ubuntu-latest, steps: []}}\n",
    { scope: "android" },
  );
  assert.ok(hosted.diagnostics.includes("LEGACY_GITHUB_HOSTED_ANDROID_BUILD"));
  assert.equal(hosted.blocking, false);
});

test("로컬 fixture는 승격 evidence가 아닌 RN/Godot 계약 probe만 만든다", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-bundle-fixtures-"));
  temporaryRoots.push(root);
  for (const profile of ["react-native", "godot"]) {
    const outputPath = join(root, `${profile}.json`);
    const evidence = await runFixtureCanary({ profile, outputPath });
    assert.equal(evidence.kind, "WORKFLOW_BUNDLE_CONTRACT_FIXTURE");
    assert.equal(evidence.gates, undefined);
    assert.equal(evidence.marketUpload, false);
    assert.match(evidence.contractProbeSha256, /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), evidence);
  }
});

test("Platform release gate는 release에서 signed manifest와 observation readback 없으면 fail-closed다", async () => {
  const context = await approvedContext("react-native");
  const request = {
    mode: "RELEASE",
    runId: "platform-run-0001",
    approvedBundleBinding: context.bundleBinding,
    callerBinding: context.callerBinding,
    repositoryContext: context.repositoryContext,
  };
  const missing = await evaluatePlatformReleaseGate(request);
  assert.equal(missing.ok, false);
  assert.equal(missing.enforcement, "FAIL_CLOSED");
  assert.ok(missing.diagnostics.includes("PLATFORM_GATE_READBACK_REQUIRED"));

  const staticObservation = await evaluatePlatformReleaseGate({
    ...request,
    mode: "STATIC",
  });
  assert.equal(staticObservation.ok, true);
  assert.equal(staticObservation.enforcement, "SHADOW");
  assert.ok(
    staticObservation.diagnostics.includes("PLATFORM_GATE_READBACK_REQUIRED"),
  );

  const nowMs = Date.parse("2026-08-28T00:00:00.000Z");
  const approved = await evaluatePlatformReleaseGate(request, {
    now: () => nowMs,
    trustedPlatformGateReadback: async (expected) => ({
      ...expected,
      state: "APPROVED",
      receiptId: "cm-platform-receipt-1",
      generation: 1,
      expiresAt: "2026-08-28T00:04:00.000Z",
      manifest: {
        state: "FLEET_APPROVED",
        signatureVerified: true,
        digest: DIGEST,
      },
      observation: {
        id: "cm-platform-1",
        current: true,
        digest: `sha256:${"2".repeat(64)}`,
      },
    }),
  });
  assert.equal(approved.ok, true, approved.diagnostics.join(","));
  assert.equal(approved.blocking, true);
  assert.equal(approved.binding.observationId, "cm-platform-1");
  const expectedBinding = {
    repositoryId: context.repositoryContext.repositoryId,
    fullName: context.repositoryContext.fullName,
    sourceSha: context.repositoryContext.sourceSha,
    workflowBundleDigest: context.approved.integrity.payloadDigest,
    platformSourceSha: PLATFORM_RELEASE.sourceSha,
    platformContractRevision: PLATFORM_RELEASE.contractRevision,
    runId: "platform-run-0001",
  };
  const durableReceipts = new Set();
  const durableConsumer = async (consumeRequest) => {
    if (durableReceipts.has(consumeRequest.receiptId)) {
      throw new Error("DUPLICATE_RECEIPT");
    }
    durableReceipts.add(consumeRequest.receiptId);
    return {
      state: "CONSUMED",
      receiptId: consumeRequest.receiptId,
      generation: consumeRequest.generation,
      runId: consumeRequest.runId,
      consumedAt: "2026-08-28T00:00:00.000Z",
    };
  };
  const consumed = await consumePlatformReleaseGateBinding(
    approved.binding,
    expectedBinding,
    { now: () => nowMs, trustedPlatformGateConsume: durableConsumer },
  );
  assert.equal(consumed.observationId, "cm-platform-1");
  assert.equal(Object.isFrozen(consumed), true);
  await assert.rejects(
    async () =>
      consumePlatformReleaseGateBinding(approved.binding, expectedBinding, {
        now: () => nowMs,
        trustedPlatformGateConsume: durableConsumer,
      }),
    /PLATFORM_GATE_BINDING_CONSUMED/u,
  );

  const duplicateBinding = await evaluatePlatformReleaseGate(request, {
    now: () => nowMs,
    trustedPlatformGateReadback: async (expected) => ({
      ...expected,
      state: "APPROVED",
      receiptId: "cm-platform-receipt-1",
      generation: 1,
      expiresAt: "2026-08-28T00:04:00.000Z",
      manifest: {
        state: "FLEET_APPROVED",
        signatureVerified: true,
        digest: DIGEST,
      },
      observation: {
        id: "cm-platform-1",
        current: true,
        digest: `sha256:${"2".repeat(64)}`,
      },
    }),
  });
  await assert.rejects(
    consumePlatformReleaseGateBinding(
      duplicateBinding.binding,
      expectedBinding,
      { now: () => nowMs, trustedPlatformGateConsume: durableConsumer },
    ),
    /PLATFORM_GATE_DURABLE_CONSUME_FAILED/u,
  );

  const reentrantBinding = await evaluatePlatformReleaseGate(request, {
    now: () => nowMs,
    trustedPlatformGateReadback: async (expected) => ({
      ...expected,
      state: "APPROVED",
      receiptId: "cm-platform-receipt-3",
      generation: 1,
      expiresAt: "2026-08-28T00:04:00.000Z",
      manifest: {
        state: "FLEET_APPROVED",
        signatureVerified: true,
        digest: DIGEST,
      },
      observation: {
        id: "cm-platform-3",
        current: true,
        digest: `sha256:${"3".repeat(64)}`,
      },
    }),
  });
  const getterExpected = { ...expectedBinding };
  delete getterExpected.repositoryId;
  let reentrantAttempt;
  Object.defineProperty(getterExpected, "repositoryId", {
    enumerable: true,
    get() {
      reentrantAttempt ??= consumePlatformReleaseGateBinding(
        reentrantBinding.binding,
        expectedBinding,
        { now: () => nowMs, trustedPlatformGateConsume: durableConsumer },
      );
      return expectedBinding.repositoryId;
    },
  });
  await consumePlatformReleaseGateBinding(
    reentrantBinding.binding,
    getterExpected,
    { now: () => nowMs, trustedPlatformGateConsume: durableConsumer },
  );
  await assert.rejects(
    reentrantAttempt,
    /PLATFORM_GATE_BINDING_IN_PROGRESS/u,
  );

  const uncertainBinding = await evaluatePlatformReleaseGate(request, {
    now: () => nowMs,
    trustedPlatformGateReadback: async (expected) => ({
      ...expected,
      state: "APPROVED",
      receiptId: "cm-platform-receipt-4",
      generation: 1,
      expiresAt: "2026-08-28T00:04:00.000Z",
      manifest: {
        state: "FLEET_APPROVED",
        signatureVerified: true,
        digest: DIGEST,
      },
      observation: {
        id: "cm-platform-4",
        current: true,
        digest: `sha256:${"4".repeat(64)}`,
      },
    }),
  });
  let committedRecord;
  await assert.rejects(
    consumePlatformReleaseGateBinding(
      uncertainBinding.binding,
      expectedBinding,
      {
        now: () => nowMs,
        trustedPlatformGateConsume: async (consumeRequest) => {
          committedRecord = {
            state: "CONSUMED",
            receiptId: consumeRequest.receiptId,
            generation: consumeRequest.generation,
            runId: consumeRequest.runId,
            consumedAt: "2026-08-28T00:00:00.000Z",
          };
          throw new Error("RESPONSE_LOST_AFTER_COMMIT");
        },
      },
    ),
    /PLATFORM_GATE_DURABLE_CONSUME_FAILED/u,
  );
  await assert.rejects(
    consumePlatformReleaseGateBinding(
      uncertainBinding.binding,
      expectedBinding,
      { now: () => nowMs, trustedPlatformGateConsume: durableConsumer },
    ),
    /PLATFORM_GATE_DURABLE_READBACK_REQUIRED/u,
  );
  const resumed = await consumePlatformReleaseGateBinding(
    uncertainBinding.binding,
    expectedBinding,
    {
      now: () => nowMs,
      trustedPlatformGateConsume: async () => {
        throw new Error("CAS_MUST_NOT_REPEAT_AFTER_COMMIT");
      },
      trustedPlatformGateConsumeReadback: async () => committedRecord,
    },
  );
  assert.equal(resumed.receiptId, "cm-platform-receipt-4");

  const expiringBinding = await evaluatePlatformReleaseGate(request, {
    now: () => nowMs,
    trustedPlatformGateReadback: async (expected) => ({
      ...expected,
      state: "APPROVED",
      receiptId: "cm-platform-receipt-5",
      generation: 1,
      expiresAt: "2026-08-28T00:04:00.000Z",
      manifest: {
        state: "FLEET_APPROVED",
        signatureVerified: true,
        digest: DIGEST,
      },
      observation: {
        id: "cm-platform-5",
        current: true,
        digest: `sha256:${"5".repeat(64)}`,
      },
    }),
  });
  let consumeClockCalls = 0;
  await assert.rejects(
    consumePlatformReleaseGateBinding(
      expiringBinding.binding,
      expectedBinding,
      {
        now: () =>
          consumeClockCalls++ === 0
            ? Date.parse("2026-08-28T00:03:59.999Z")
            : Date.parse("2026-08-28T00:04:00.001Z"),
        trustedPlatformGateConsume: async (consumeRequest) => ({
          state: "CONSUMED",
          receiptId: consumeRequest.receiptId,
          generation: consumeRequest.generation,
          runId: consumeRequest.runId,
          consumedAt: "2026-08-28T00:03:59.999Z",
        }),
      },
    ),
    /PLATFORM_GATE_BINDING_EXPIRED/u,
  );

  let clockCalls = 0;
  const staleAfterReadback = await evaluatePlatformReleaseGate(request, {
    now: () => (clockCalls++ === 0 ? nowMs : nowMs + 5 * 60 * 1000),
    trustedPlatformGateReadback: async (expected) => ({
      ...expected,
      state: "APPROVED",
      receiptId: "cm-platform-receipt-2",
      generation: 1,
      expiresAt: "2026-08-28T00:04:00.000Z",
      manifest: {
        state: "FLEET_APPROVED",
        signatureVerified: true,
        digest: DIGEST,
      },
      observation: {
        id: "cm-platform-1",
        current: true,
        digest: `sha256:${"2".repeat(64)}`,
      },
    }),
  });
  assert.equal(staleAfterReadback.ok, false);
  assert.ok(
    staleAfterReadback.diagnostics.includes("PLATFORM_GATE_RECEIPT_INVALID"),
  );
});

test("Xcode schema와 non-promotable contract probe는 candidate CI에 연결된다", async () => {
  const schema = JSON.parse(
    await readFile("contracts/xcode-cloud-run.schema.json", "utf8"),
  );
  assert.doesNotThrow(() =>
    new Ajv2020({ strict: true, validateFormats: false }).compile(schema),
  );
  const workflow = await readFile(
    ".github/workflows/workflow-bundle-candidate.yml",
    "utf8",
  );
  assert.ok(
    workflow.indexOf("npm test") < workflow.indexOf("fixture-canary.mjs"),
  );
  assert.ok(
    workflow.indexOf("fixture-canary.mjs") <
      workflow.indexOf("fleet-cli.mjs bundle"),
  );
  assert.match(workflow, /workflow-bundle-contract-fixtures/u);
  assert.match(workflow, /non-promotable/u);
});
