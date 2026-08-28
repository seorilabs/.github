import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign as signEd25519,
} from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  createBackofficeResolvedManifestReadback,
  createGitHubWorkflowSourceReadback,
  createWorkflowBundle,
  generateOrgContractCaller,
  loadApprovedWorkflowBundle,
  loadResolvedCallerBinding,
  promoteWorkflowBundle,
  validateOrgContractCaller,
  validateWorkflowBundle,
} from "../packages/repo-contract/src/fleet.mjs";
import {
  createTrustedWorkflowBundlePublisher,
  trustedWorkflowBundlePublisherContract,
} from "../packages/repo-contract/src/trusted-publisher.mjs";
import { CANARY_BUILD_BY_PROFILE } from "./helpers/workflow-bundle-fixtures.mjs";

const SOURCE_SHA = "a".repeat(40);
const STALE_SHA = "9".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const KEY_ID = "fleet-root-2026-01";
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
    sourceSha: "d".repeat(40),
    workflowBundleSourceSha: SOURCE_SHA,
    staticRunId: 456 + index * 2,
    buildRunId: 457 + index * 2,
    ...CANARY_BUILD_BY_PROFILE[profile],
    artifactSha256: DIGEST,
  })),
);
const temporaryRoots = [];
const REPOSITORY_CONTEXT = Object.freeze({
  repositoryId: "7001",
  fullName: "seorilabs/example-app",
  sourceSha: "d".repeat(40),
});

test.afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true }),
    ),
  );
});

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

function recomputePublicIntegrity(bundle) {
  const { integrity: _integrity, ...payload } = bundle;
  bundle.integrity = {
    algorithm: "sha256",
    payloadDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(canonicalize(payload)))
      .digest("hex")}`,
  };
}

function trustedSourceReadbackFor(bundle, repoRoot = ".") {
  return async ({ repository, sourceSha }) => ({
    repository,
    sourceSha,
    contractDigests: structuredClone(bundle.quality.contractDigests),
    runtimeAssetDigests: structuredClone(bundle.quality.runtimeAssetDigests),
    workflowBundleSchemaText: await readFile(
      join(repoRoot, "contracts/workflow-bundle.schema.json"),
      "utf8",
    ),
    contractAssetContents: Object.fromEntries(
      await Promise.all(
        Object.keys(bundle.quality.contractDigests).map(async (path) => [
          path,
          await readFile(join(repoRoot, path), "utf8"),
        ]),
      ),
    ),
    runtimeAssetContents: Object.fromEntries(
      await Promise.all(
        Object.keys(bundle.quality.runtimeAssetDigests).map(async (path) => [
          path,
          await readFile(join(repoRoot, path), "utf8"),
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

function trustedSignerOptions(privateKey, publicKey, keyId = KEY_ID) {
  return {
    trustedApprovalKeys: new Map([[keyId, publicKey]]),
    trustedApprovalSigner: async ({ payload }) => ({
      algorithm: "Ed25519",
      keyId,
      value: signEd25519(null, payload, privateKey).toString("base64url"),
    }),
  };
}

async function callerFixture({
  profile = "react-native",
  packageManager = "pnpm",
  workingDirectory = "apps/mobile",
  repositoryContext = REPOSITORY_CONTEXT,
} = {}) {
  const manifests = new Map();
  const manifest = {
    state: "ACTIVE",
    repositoryId: repositoryContext.repositoryId,
    fullName: repositoryContext.fullName,
    sourceSha: repositoryContext.sourceSha,
    sourceRef: "refs/heads/main",
    observationId: "cm-observation-1",
    sourcePayloadDigest: DIGEST,
    profile,
    packageManager,
    workingDirectory,
    configId: "cm1234567890",
    configRevision: 17,
    snapshotDigest: "e".repeat(64),
    configSignatureDigest: `sha256:${"f".repeat(64)}`,
  };
  manifests.set(repositoryContext.repositoryId, structuredClone(manifest));
  const trustedResolvedManifestReadback = async ({ repositoryId }) =>
    manifests.get(repositoryId);
  const callerBinding = await loadResolvedCallerBinding(repositoryContext, {
    trustedResolvedManifestReadback,
  });
  return {
    callerBinding,
    manifest,
    manifests,
    repositoryContext,
    trustedResolvedManifestReadback,
  };
}

async function approvedFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const registry = new Map();
  const candidate = await createWorkflowBundle({
    sourceSha: SOURCE_SHA,
    platformRelease: PLATFORM_RELEASE,
  });
  const trustedWorkflowSourceReadback = trustedSourceReadbackFor(candidate);
  const approved = await promoteWorkflowBundle(candidate, EVIDENCE, {
    evidenceVerifier: async (record, bundle) => verifiedEvidence(record, bundle),
    ...trustedSignerOptions(privateKey, publicKey),
    trustedWorkflowSourceReadback,
    trustedRunnerImageReadback,
    registryPublisher: async (record) => {
      const persisted = structuredClone(record);
      registry.set(record.subject, persisted);
      return persisted;
    },
  });
  const trust = {
    trustedApprovalKeys: new Map([[KEY_ID, publicKey]]),
    trustedRegistryReadback: async ({ subject }) => registry.get(subject),
    trustedWorkflowSourceReadback,
    trustedRunnerImageReadback,
  };
  const binding = await loadApprovedWorkflowBundle(approved, trust);
  return { approved, binding, privateKey, publicKey, registry, trust };
}

test("WorkflowBundle schema는 strict mode로 compile된다", async () => {
  const schema = JSON.parse(
    await readFile("contracts/workflow-bundle.schema.json", "utf8"),
  );
  assert.doesNotThrow(() =>
    new Ajv2020({ strict: true, validateFormats: false }).compile(schema),
  );
});

test("candidate bundle은 static, build-only workflow와 실행 asset의 실제 digest만 묶는다", async () => {
  const bundle = await createWorkflowBundle({ sourceSha: SOURCE_SHA });
  const result = await validateWorkflowBundle(bundle);

  assert.equal(result.ok, true, result.diagnostics.join(","));
  assert.equal(bundle.approval.state, "CANDIDATE");
  assert.equal(bundle.platform.state, "UNRESOLVED");
  assert.deepEqual(Object.keys(bundle.buildWorkflows).sort(), [
    "godot",
    "react-native",
  ]);
  assert.equal(bundle.builders, undefined);
  assert.deepEqual(Object.keys(bundle.quality.runtimeAssetDigests).sort(), [
    ".github/cloud-build/godot-android-build-only.yaml",
    ".github/cloud-build/rn-android-build-only.yaml",
    ".github/workflows/godot-build-android-cloud-v1.yml",
    ".github/workflows/godot-checks-v2.yml",
    ".github/workflows/rn-build-android-cloud-v1.yml",
    ".github/workflows/rn-static-checks-v2.yml",
    "fixtures/workflow-bundle/godot/fixture.json",
    "fixtures/workflow-bundle/godot/toolchain-probe/project.godot",
    "fixtures/workflow-bundle/react-native/fixture.json",
    "scripts/fleet/fixture-canary.mjs",
    "scripts/fleet/godot-diagnostic-gate.mjs",
    "scripts/fleet/secret-scan.mjs",
    "scripts/fleet/stage-private-pnpm-store.mjs",
    "scripts/fleet/static-preflight.mjs",
    "scripts/fleet/write-provenance.mjs",
  ]);
  for (const workflow of Object.values(bundle.reusableWorkflows)) {
    assert.equal(workflow.sha, SOURCE_SHA);
  }
  for (const workflow of Object.values(bundle.buildWorkflows)) {
    assert.equal(workflow.sha, SOURCE_SHA);
  }
  const source = await readFile("contracts/workflow-bundle-source.yaml", "utf8");
  assert.match(source, /buildWorkflows:[\s\S]*build-android-cloud/u);
  assert.doesNotMatch(source, /builders:/u);
});

test("candidate bundle은 공식 Platform v0.6.6 릴리스 manifest를 exact digest로 묶는다", async () => {
  const path = "contracts/platform-releases/v0.6.6/platform-release.json";
  const content = await readFile(path);
  const platformRelease = JSON.parse(content.toString("utf8"));
  const bundle = await createWorkflowBundle({
    sourceSha: SOURCE_SHA,
    platformRelease,
  });

  assert.deepEqual(bundle.platform, {
    state: "RESOLVED",
    sourceSha: "97f046ce2d9df5d72bc7a49fc81bb7c366ebaa17",
    contractRevision:
      "sha256:9906ee15a7a522d3401eb4dee788b44edc05f8145100bd33fdfeb021c6b05626",
    typescript: {
      version: "0.4.0",
      digest:
        "sha256:8d7151f6ec7ff0c0fe8c9fe6fee2e6aa5a1158bd394dc03cc09a4e40f5a6abd7",
    },
    gdscript: {
      version: "0.6.6",
      digest:
        "sha256:2df58acd5885f598e854a7fa1a13482315311701bad47f03cfe8b3edcd36f965",
    },
  });
  assert.equal(
    bundle.quality.contractDigests[path],
    "sha256:a04e829a5cd3e109609ecb74d7b8461fb180d9679d247dcade48881191d84788",
  );
});

test("v4 candidate는 3.x version downgrade로 runner와 delivery gate를 우회할 수 없다", async () => {
  const bundle = await createWorkflowBundle({ sourceSha: SOURCE_SHA });
  bundle.bundleVersion = "3.9.9";
  recomputePublicIntegrity(bundle);
  const result = await validateWorkflowBundle(bundle);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.includes("CANDIDATE_BUNDLE_VERSION_UNSUPPORTED"),
  );
});

test("GitHub source adapter는 fixed public origin의 exact commit Contents만 digest한다", async () => {
  const candidate = await createWorkflowBundle({ sourceSha: SOURCE_SHA });
  const requested = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    requested.push(url.href);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, undefined);
    if (url.pathname.endsWith(`/commits/${SOURCE_SHA}`)) {
      return { ok: true, status: 200, json: async () => ({ sha: SOURCE_SHA }) };
    }
    const prefix = "/repos/seorilabs/.github/contents/";
    assert.ok(url.pathname.startsWith(prefix), url.pathname);
    assert.equal(url.searchParams.get("ref"), SOURCE_SHA);
    const relativePath = decodeURIComponent(url.pathname.slice(prefix.length));
    const content = await readFile(relativePath);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        type: "file",
        encoding: "base64",
        content: content.toString("base64"),
      }),
    };
  };
  const readback = createGitHubWorkflowSourceReadback({ fetchImpl });
  const snapshot = await readback({
    repository: "seorilabs/.github",
    sourceSha: SOURCE_SHA,
    contractPaths: Object.keys(candidate.quality.contractDigests),
    runtimeAssetPaths: Object.keys(candidate.quality.runtimeAssetDigests),
  });

  assert.deepEqual(snapshot.contractDigests, candidate.quality.contractDigests);
  assert.deepEqual(
    snapshot.runtimeAssetDigests,
    candidate.quality.runtimeAssetDigests,
  );
  assert.equal(
    JSON.parse(snapshot.workflowBundleSchemaText).title,
    "Seorilabs immutable WorkflowBundle",
  );
  assert.match(
    snapshot.runtimeAssetContents[".github/workflows/rn-static-checks-v2.yml"],
    /name: RN Static Checks v2/u,
  );
  snapshot.runtimeAssetContents[".github/workflows/rn-static-checks-v2.yml"] =
    "mutated consumer copy";
  const cached = await readback({
    repository: "seorilabs/.github",
    sourceSha: SOURCE_SHA,
    contractPaths: Object.keys(candidate.quality.contractDigests),
    runtimeAssetPaths: Object.keys(candidate.quality.runtimeAssetDigests),
  });
  assert.match(
    cached.runtimeAssetContents[".github/workflows/rn-static-checks-v2.yml"],
    /name: RN Static Checks v2/u,
  );
  assert.equal(
    requested.length,
    1 +
      Object.keys(candidate.quality.contractDigests).length +
      Object.keys(candidate.quality.runtimeAssetDigests).length,
  );
});

test("존재하지 않는 GitHub source SHA는 APPROVED 승격 전에 거부한다", async () => {
  const candidate = await createWorkflowBundle({
    sourceSha: SOURCE_SHA,
    platformRelease: PLATFORM_RELEASE,
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const missingReadback = createGitHubWorkflowSourceReadback({
    fetchImpl: async (input) => {
      assert.equal(new URL(input).origin, "https://api.github.com");
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });

  await assert.rejects(
    promoteWorkflowBundle(candidate, EVIDENCE, {
      evidenceVerifier: async (record, bundle) => verifiedEvidence(record, bundle),
      ...trustedSignerOptions(privateKey, publicKey),
      registryPublisher: async (record) => record,
      trustedWorkflowSourceReadback: missingReadback,
    }),
    /WORKFLOW_SOURCE_READBACK_FAILED/u,
  );
});

test("Backoffice adapter는 fixed origin과 ref로 ACTIVE resolved manifest를 정규화한다", async () => {
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://backoffice.example");
    assert.equal(
      url.pathname,
      `/control-plane/apps/${REPOSITORY_CONTEXT.repositoryId}/resolved-manifest`,
    );
    assert.equal(url.searchParams.get("ref"), REPOSITORY_CONTEXT.sourceSha);
    assert.equal(options.redirect, "error");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        app: {
          repoId: REPOSITORY_CONTEXT.repositoryId,
          repoFullName: REPOSITORY_CONTEXT.fullName,
        },
        config: {
          id: "cm1234567890",
          revision: 17,
          status: "ACTIVE",
          digest: "e".repeat(64),
          signature: { algorithm: "Ed25519", value: "signed-snapshot" },
        },
        source: {
          sha: REPOSITORY_CONTEXT.sourceSha,
          ref: "refs/heads/main",
          observationId: "cm-observation-1",
          payload: {},
        },
        workflowCaller: {
          profile: "react-native",
          packageManager: "pnpm",
          workingDirectory: "apps/mobile",
        },
      }),
    };
  };
  const readback = createBackofficeResolvedManifestReadback({
    origin: "https://backoffice.example",
    fetchImpl,
  });
  const manifest = await readback(REPOSITORY_CONTEXT);

  assert.equal(manifest.repositoryId, "7001");
  assert.equal(manifest.sourceSha, REPOSITORY_CONTEXT.sourceSha);
  assert.equal(manifest.configRevision, 17);
  assert.equal(manifest.snapshotDigest, "e".repeat(64));
  assert.match(manifest.configSignatureDigest, /^sha256:[0-9a-f]{64}$/u);
  await assert.doesNotReject(
    loadResolvedCallerBinding(REPOSITORY_CONTEXT, {
      trustedResolvedManifestReadback: readback,
    }),
  );
});

test("Backoffice adapter는 missing caller와 repo/source/config mismatch를 거부한다", async () => {
  const validPayload = {
    app: {
      repoId: REPOSITORY_CONTEXT.repositoryId,
      repoFullName: REPOSITORY_CONTEXT.fullName,
    },
    config: {
      id: "cm1234567890",
      revision: 17,
      status: "ACTIVE",
      digest: "e".repeat(64),
      signature: "signed-snapshot",
    },
    source: {
      sha: REPOSITORY_CONTEXT.sourceSha,
      ref: "refs/heads/main",
      observationId: "cm-observation-1",
      payload: {},
    },
    workflowCaller: {
      profile: "react-native",
      packageManager: "pnpm",
      workingDirectory: "apps/mobile",
    },
  };
  const invalidPayloads = [
    { ...validPayload, workflowCaller: undefined },
    {
      ...validPayload,
      workflowCaller: { ...validPayload.workflowCaller, profile: "android" },
    },
    {
      ...validPayload,
      workflowCaller: {
        ...validPayload.workflowCaller,
        workingDirectory: "../outside",
      },
    },
    {
      ...validPayload,
      workflowCaller: {
        ...validPayload.workflowCaller,
        workingDirectory: "apps/../outside",
      },
    },
    {
      ...validPayload,
      app: { ...validPayload.app, repoId: "7002" },
    },
    {
      ...validPayload,
      source: { ...validPayload.source, sha: "8".repeat(40) },
    },
    {
      ...validPayload,
      source: { ...validPayload.source, ref: "refs/heads/develop" },
    },
    {
      ...validPayload,
      config: { ...validPayload.config, status: "DRAFT" },
    },
  ];
  for (const payload of invalidPayloads) {
    const readback = createBackofficeResolvedManifestReadback({
      origin: "https://backoffice.example",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => payload,
      }),
    });
    await assert.rejects(
      readback(REPOSITORY_CONTEXT),
      /BACKOFFICE_MANIFEST_RESPONSE_INVALID/u,
    );
  }

  const missing = createBackofficeResolvedManifestReadback({
    origin: "https://backoffice.example",
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      json: async () => ({ code: "NO_WORKFLOW_CALLER_FOR_SHA" }),
    }),
  });
  await assert.rejects(
    missing(REPOSITORY_CONTEXT),
    /BACKOFFICE_MANIFEST_HTTP_409/u,
  );
});

test("bundle payload 또는 실제 runtime asset 변조를 거부한다", async () => {
  const bundle = await createWorkflowBundle({ sourceSha: SOURCE_SHA });
  bundle.runners.privateGeneral = "ubuntu-latest";
  let result = await validateWorkflowBundle(bundle);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.includes("INTEGRITY_MISMATCH"));

  const root = await mkdtemp(join(tmpdir(), "fleet-bundle-assets-"));
  temporaryRoots.push(root);
  for (const directory of [
    "contracts",
    "profiles",
    "scripts/fleet",
    "fixtures",
    ".github/cloud-build",
    ".github/workflows",
  ]) {
    await cp(directory, join(root, directory), { recursive: true });
  }
  const isolated = await createWorkflowBundle({
    repoRoot: root,
    sourceSha: SOURCE_SHA,
  });
  await writeFile(
    join(root, "scripts/fleet/static-preflight.mjs"),
    "// mutated after bundle generation\n",
  );
  result = await validateWorkflowBundle(isolated, { repoRoot: root });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.includes("RUNTIME_ASSET_DIGEST_MISMATCH"));
});

test("bundle action 또는 toolchain 선언이 실제 workflow와 다르면 거부한다", async () => {
  const bundle = await createWorkflowBundle({ sourceSha: SOURCE_SHA });
  bundle.actions.checkout.sha = STALE_SHA;
  recomputePublicIntegrity(bundle);
  let result = await validateWorkflowBundle(bundle);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.includes("RUNTIME_DECLARATION_MISMATCH"));

  const toolchainMismatch = await createWorkflowBundle({ sourceSha: SOURCE_SHA });
  toolchainMismatch.toolchains.node = "24.15.0";
  recomputePublicIntegrity(toolchainMismatch);
  result = await validateWorkflowBundle(toolchainMismatch);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.includes("RUNTIME_DECLARATION_MISMATCH"));

  const root = await mkdtemp(join(tmpdir(), "fleet-bundle-action-allowlist-"));
  temporaryRoots.push(root);
  for (const directory of [
    "contracts",
    "profiles",
    "scripts/fleet",
    "fixtures",
    ".github/cloud-build",
    ".github/workflows",
  ]) {
    await cp(directory, join(root, directory), { recursive: true });
  }
  const workflowPath = join(root, ".github/workflows/rn-static-checks-v2.yml");
  const workflow = await readFile(workflowPath, "utf8");
  await writeFile(
    workflowPath,
    workflow.replace(
      /uses: actions\/checkout@[0-9a-f]{40}/u,
      'uses: "evil/action@main"',
    ),
  );
  await assert.rejects(
    createWorkflowBundle({ repoRoot: root, sourceSha: SOURCE_SHA }),
    /RUNTIME_DECLARATION_MISMATCH/u,
  );

  const semanticRoot = await mkdtemp(join(tmpdir(), "fleet-bundle-semantic-"));
  temporaryRoots.push(semanticRoot);
  for (const directory of [
    "contracts",
    "profiles",
    "scripts/fleet",
    "fixtures",
    ".github/cloud-build",
    ".github/workflows",
  ]) {
    await cp(directory, join(semanticRoot, directory), { recursive: true });
  }
  const semanticPath = join(
    semanticRoot,
    ".github/workflows/rn-static-checks-v2.yml",
  );
  const semanticWorkflow = await readFile(semanticPath, "utf8");
  await writeFile(
    semanticPath,
    semanticWorkflow.replace(
      "          node-version: 24.16.0",
      "          # node-version: 24.16.0\n          node-version: 24.15.0",
    ),
  );
  await assert.rejects(
    createWorkflowBundle({ repoRoot: semanticRoot, sourceSha: SOURCE_SHA }),
    /RUNTIME_DECLARATION_MISMATCH/u,
  );

  await writeFile(
    semanticPath,
    semanticWorkflow.replace(
      [
        '          case "$PACKAGE_MANAGER" in',
        "            npm) npm run test:core ;;",
        "            pnpm) pnpm test:core ;;",
        "          esac",
      ].join("\n"),
      [
        '          echo "npm run test:core"',
        '          echo "pnpm test:core"',
      ].join("\n"),
    ),
  );
  await assert.rejects(
    createWorkflowBundle({ repoRoot: semanticRoot, sourceSha: SOURCE_SHA }),
    /RUNTIME_DECLARATION_MISMATCH/u,
  );

  await writeFile(
    semanticPath,
    semanticWorkflow.replace("          persist-credentials: false", "          persist-credentials: true"),
  );
  await assert.rejects(
    createWorkflowBundle({ repoRoot: semanticRoot, sourceSha: SOURCE_SHA }),
    /RUNTIME_DECLARATION_MISMATCH/u,
  );

  await writeFile(
    semanticPath,
    semanticWorkflow.replace(
      "  org-contract:\n",
      [
        "  untrusted-extra-job:",
        "    runs-on: seorilabs-rpi-arm64",
        "    steps:",
        "      - run: echo unexpected",
        "",
        "  org-contract:",
        "",
      ].join("\n"),
    ),
  );
  await assert.rejects(
    createWorkflowBundle({ repoRoot: semanticRoot, sourceSha: SOURCE_SHA }),
    /RUNTIME_DECLARATION_MISMATCH/u,
  );

  await writeFile(semanticPath, semanticWorkflow);
  const privilegedBuildPath = join(
    semanticRoot,
    ".github/workflows/rn-build-android-cloud-v1.yml",
  );
  const privilegedBuild = await readFile(privilegedBuildPath, "utf8");
  await writeFile(
    privilegedBuildPath,
    privilegedBuild.replace(
      "      - name: Setup pinned gcloud",
      [
        "      - name: Unexpected privileged command",
        "        run: gcloud auth list",
        "",
        "      - name: Setup pinned gcloud",
      ].join("\n"),
    ),
  );
  await assert.rejects(
    createWorkflowBundle({ repoRoot: semanticRoot, sourceSha: SOURCE_SHA }),
    /RUNTIME_DECLARATION_MISMATCH/u,
  );

  const diagnosticRoot = await mkdtemp(
    join(tmpdir(), "fleet-bundle-godot-diagnostic-"),
  );
  temporaryRoots.push(diagnosticRoot);
  for (const directory of [
    "contracts",
    "profiles",
    "scripts/fleet",
    "fixtures",
    ".github/cloud-build",
    ".github/workflows",
  ]) {
    await cp(directory, join(diagnosticRoot, directory), { recursive: true });
  }
  const godotWorkflowPath = join(
    diagnosticRoot,
    ".github/workflows/godot-checks-v2.yml",
  );
  const godotWorkflow = await readFile(godotWorkflowPath, "utf8");
  await writeFile(
    godotWorkflowPath,
    godotWorkflow.replace(
      '--toolchain-log "$RUNNER_TEMP/godot-toolchain.log"',
      '--toolchain-log "$RUNNER_TEMP/godot-import.log"',
    ),
  );
  await assert.rejects(
    createWorkflowBundle({ repoRoot: diagnosticRoot, sourceSha: SOURCE_SHA }),
    /RUNTIME_DECLARATION_MISMATCH/u,
  );
});

test("APPROVED bundle은 source, Ed25519 key와 registry readback이 모두 있어야 소비된다", async () => {
  const { approved, trust } = await approvedFixture();
  assert.equal(approved.approval.signature.algorithm, "Ed25519");

  let result = await validateWorkflowBundle(approved);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.includes("APPROVAL_TRUSTED_KEY_REQUIRED"));
  assert.ok(result.diagnostics.includes("APPROVAL_REGISTRY_READBACK_REQUIRED"));
  assert.ok(result.diagnostics.includes("WORKFLOW_SOURCE_READBACK_REQUIRED"));
  assert.ok(result.diagnostics.includes("RUNNER_IMAGE_READBACK_REQUIRED"));

  result = await validateWorkflowBundle(approved, {
    ...trust,
    trustedRunnerImageReadback: async (request) => ({
      ...request,
      imageDigest: `registry.vzyx.xyz/seorilabs/arc-runner-node24@sha256:${"0".repeat(64)}`,
      state: "READY",
      generation: 13,
      observedAt: new Date(Date.now()).toISOString(),
    }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.includes("RUNNER_IMAGE_READBACK_MISMATCH"));

  result = await validateWorkflowBundle(approved, {
    trustedApprovalKeys: trust.trustedApprovalKeys,
  });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.includes("APPROVAL_REGISTRY_READBACK_REQUIRED"));

  result = await validateWorkflowBundle(approved, trust);
  assert.equal(result.ok, true, result.diagnostics.join(","));
});

test("primitive trusted approval keys는 정규화된 오류로 거부한다", async () => {
  const candidate = await createWorkflowBundle({
    sourceSha: SOURCE_SHA,
    platformRelease: PLATFORM_RELEASE,
  });
  const validation = await validateWorkflowBundle(candidate, {
    trustedApprovalKeys: "not-an-object",
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.diagnostics.includes("APPROVAL_TRUSTED_KEYS_INVALID"));

  await assert.rejects(
    promoteWorkflowBundle(candidate, EVIDENCE, {
      trustedApprovalKeys: 42,
    }),
    /APPROVAL_TRUSTED_KEYS_INVALID/u,
  );

  const { approved, trust } = await approvedFixture();
  await assert.rejects(
    loadApprovedWorkflowBundle(approved, {
      ...trust,
      trustedApprovalKeys: true,
    }),
    /APPROVAL_TRUSTED_KEYS_INVALID/u,
  );
});

test("과거 APPROVED bundle은 current repoRoot runtime asset과 비교하지 않는다", async () => {
  const { approved, trust } = await approvedFixture();
  const root = await mkdtemp(join(tmpdir(), "fleet-old-approved-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "contracts"), { recursive: true });
  await cp(
    "contracts/workflow-bundle.schema.json",
    join(root, "contracts/workflow-bundle.schema.json"),
  );

  const result = await validateWorkflowBundle(approved, {
    repoRoot: root,
    ...trust,
  });
  assert.equal(result.ok, true, result.diagnostics.join(","));
});

test("exact remote source의 runtime digest 또는 bytes가 다르면 load를 거부한다", async () => {
  const { approved, trust } = await approvedFixture();
  const mismatchedSourceReadback = async (request) => {
    const snapshot = await trust.trustedWorkflowSourceReadback(request);
    snapshot.runtimeAssetContents[
      "scripts/fleet/static-preflight.mjs"
    ] += "\n// remote mutation\n";
    return snapshot;
  };

  const result = await validateWorkflowBundle(approved, {
    ...trust,
    trustedWorkflowSourceReadback: mismatchedSourceReadback,
  });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.includes("WORKFLOW_SOURCE_READBACK_MISMATCH"));
  await assert.rejects(
    loadApprovedWorkflowBundle(approved, {
      ...trust,
      trustedWorkflowSourceReadback: mismatchedSourceReadback,
    }),
    /WORKFLOW_SOURCE_READBACK_MISMATCH/u,
  );
});

test("APPROVED bundle load는 exact remote source를 한 번만 읽는다", async () => {
  const { approved, trust } = await approvedFixture();
  let sourceReadbackCount = 0;
  const trustedWorkflowSourceReadback = async (request) => {
    sourceReadbackCount += 1;
    return trust.trustedWorkflowSourceReadback(request);
  };

  await loadApprovedWorkflowBundle(approved, {
    ...trust,
    trustedWorkflowSourceReadback,
  });

  assert.equal(sourceReadbackCount, 1);
});

test("공개 integrity 재계산과 공격자 registry로 APPROVED 상태를 위조할 수 없다", async () => {
  const { approved, trust } = await approvedFixture();
  const forged = structuredClone(approved);
  forged.approval.evidence[0].staticRunId += 1000;
  recomputePublicIntegrity(forged);

  const result = await validateWorkflowBundle(forged, {
    trustedApprovalKeys: trust.trustedApprovalKeys,
    trustedRegistryReadback: async () => ({
      registryId: forged.approval.registry.id,
      subject: forged.approval.registry.subject,
      bundleDigest: forged.integrity.payloadDigest,
      sourceSha: forged.source.sha,
      bundleVersion: forged.bundleVersion,
      state: "APPROVED",
    }),
    trustedWorkflowSourceReadback: trust.trustedWorkflowSourceReadback,
    trustedRunnerImageReadback,
  });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.includes("APPROVAL_SIGNATURE_INVALID"));
});

test("registry await 중 원본 bundle을 바꿔도 검증 snapshot과 caller SHA는 변하지 않는다", async () => {
  const { approved, publicKey, registry, trust } = await approvedFixture();
  const callerState = await callerFixture();
  let releaseReadback;
  const readbackGate = new Promise((resolve) => {
    releaseReadback = resolve;
  });
  let readbackStarted;
  const started = new Promise((resolve) => {
    readbackStarted = resolve;
  });
  const loading = loadApprovedWorkflowBundle(approved, {
    trustedApprovalKeys: new Map([[KEY_ID, publicKey]]),
    trustedRegistryReadback: async ({ subject }) => {
      readbackStarted();
      await readbackGate;
      return registry.get(subject);
    },
    trustedWorkflowSourceReadback: trust.trustedWorkflowSourceReadback,
    trustedRunnerImageReadback,
  });

  await started;
  approved.reusableWorkflows["react-native"].sha = STALE_SHA;
  releaseReadback();
  const binding = await loading;
  const caller = await generateOrgContractCaller({
    approvedBundleBinding: binding,
    callerBinding: callerState.callerBinding,
  });
  assert.match(caller, new RegExp(`@${SOURCE_SHA}`, "u"));
  assert.doesNotMatch(caller, new RegExp(`@${STALE_SHA}`, "u"));
});

test("승격은 canary readback, Ed25519 signer, registry publisher를 모두 요구한다", async () => {
  const candidate = await createWorkflowBundle({
    sourceSha: SOURCE_SHA,
    platformRelease: PLATFORM_RELEASE,
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const trustedWorkflowSourceReadback = trustedSourceReadbackFor(candidate);

  await assert.rejects(
    promoteWorkflowBundle(candidate, EVIDENCE),
    /WORKFLOW_SOURCE_READBACK_REQUIRED/u,
  );
  await assert.rejects(
    promoteWorkflowBundle(candidate, EVIDENCE, {
      evidenceVerifier: async (record, bundle) => verifiedEvidence(record, bundle),
      trustedWorkflowSourceReadback,
    }),
    /RUNNER_IMAGE_READBACK_REQUIRED/u,
  );
  await assert.rejects(
    promoteWorkflowBundle(candidate, EVIDENCE, {
      evidenceVerifier: async (record, bundle) => verifiedEvidence(record, bundle),
      trustedWorkflowSourceReadback,
      trustedRunnerImageReadback,
    }),
    /APPROVAL_SIGNER_REQUIRED/u,
  );
  await assert.rejects(
    promoteWorkflowBundle(candidate, EVIDENCE, {
      evidenceVerifier: async (record, bundle) => verifiedEvidence(record, bundle),
      ...trustedSignerOptions(privateKey, publicKey),
      trustedWorkflowSourceReadback,
      trustedRunnerImageReadback,
    }),
    /APPROVAL_REGISTRY_PUBLISHER_REQUIRED/u,
  );
});

test("trusted publisher는 signing key 없이 signer와 registry readback 경계만 노출한다", async () => {
  const candidate = await createWorkflowBundle({
    sourceSha: SOURCE_SHA,
    platformRelease: PLATFORM_RELEASE,
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const registry = new Map();
  let signerPayload;
  let registryPublishCount = 0;
  const publisher = createTrustedWorkflowBundlePublisher({
    approvalKeyId: KEY_ID,
    trustedApprovalKeys: new Map([[KEY_ID, publicKey]]),
    trustedWorkflowSourceReadback: trustedSourceReadbackFor(candidate),
    trustedRunnerImageReadback,
    evidenceVerifier: async (record, bundle) => verifiedEvidence(record, bundle),
    signApprovalPayload: async (request) => {
      assert.equal(
        request.credentialId,
        trustedWorkflowBundlePublisherContract.signingCredentialId,
      );
      assert.equal(request.keyId, KEY_ID);
      assert.equal(request.algorithm, "Ed25519");
      signerPayload = request.payload;
      return {
        algorithm: "Ed25519",
        keyId: KEY_ID,
        value: signEd25519(null, request.payload, privateKey).toString("base64url"),
      };
    },
    publishRegistryRecord: async ({ precondition, promoted, record }) => {
      registryPublishCount += 1;
      assert.equal(precondition.expectedState, "ABSENT");
      assert.equal(
        precondition.recordDigest,
        `sha256:${createHash("sha256")
          .update(JSON.stringify(canonicalize(record)))
          .digest("hex")}`,
      );
      assert.equal(promoted.integrity.payloadDigest, record.bundleDigest);
      registry.set(record.subject, structuredClone(record));
      return {
        recordDigest: precondition.recordDigest,
        state: "CREATED",
        subject: record.subject,
      };
    },
    readRegistryRecord: async ({ subject }) => registry.get(subject) ?? null,
  });

  const approved = await publisher.promote(candidate, EVIDENCE);
  const replay = await publisher.promote(candidate, EVIDENCE);
  assert.equal(approved.approval.state, "APPROVED");
  assert.equal(replay.approval.state, "APPROVED");
  assert.equal(registryPublishCount, 1);
  assert.equal(approved.approval.signature.keyId, KEY_ID);
  assert.ok(signerPayload.every((value) => value === 0));
  assert.deepEqual(Object.keys(publisher), ["promote"]);
  assert.equal(
    Object.hasOwn(trustedWorkflowBundlePublisherContract, "privateKey"),
    false,
  );
});

test("trusted publisher는 signer와 registry 오류 상세를 정규화한다", async () => {
  const candidate = await createWorkflowBundle({
    sourceSha: SOURCE_SHA,
    platformRelease: PLATFORM_RELEASE,
  });
  const { publicKey } = generateKeyPairSync("ed25519");
  const sensitive = `private-key-detail-${"x".repeat(32)}`;
  const publisher = createTrustedWorkflowBundlePublisher({
    approvalKeyId: KEY_ID,
    trustedApprovalKeys: new Map([[KEY_ID, publicKey]]),
    trustedWorkflowSourceReadback: trustedSourceReadbackFor(candidate),
    trustedRunnerImageReadback,
    evidenceVerifier: async (record, bundle) => verifiedEvidence(record, bundle),
    signApprovalPayload: async () => {
      throw new Error(sensitive);
    },
    publishRegistryRecord: async () => {},
    readRegistryRecord: async () => undefined,
  });

  await assert.rejects(
    publisher.promote(candidate, EVIDENCE),
    (error) =>
      error.message === "APPROVAL_SIGNATURE_FAILED" &&
      !error.message.includes(sensitive),
  );
});

test("저수준 승격도 registry publish 오류 상세를 노출하지 않는다", async () => {
  const candidate = await createWorkflowBundle({
    sourceSha: SOURCE_SHA,
    platformRelease: PLATFORM_RELEASE,
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const sensitive = `registry-token-detail-${"x".repeat(32)}`;

  await assert.rejects(
    promoteWorkflowBundle(candidate, EVIDENCE, {
      trustedWorkflowSourceReadback: trustedSourceReadbackFor(candidate),
      evidenceVerifier: async (record, bundle) => verifiedEvidence(record, bundle),
      trustedRunnerImageReadback,
      ...trustedSignerOptions(privateKey, publicKey),
      registryPublisher: async () => {
        throw new Error(sensitive);
      },
    }),
    (error) =>
      error.message === "APPROVAL_REGISTRY_PUBLISH_FAILED" &&
      !error.message.includes(sensitive),
  );
});

test("trusted publisher는 private signing key를 trust configuration으로 받지 않는다", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  assert.throws(
    () =>
      createTrustedWorkflowBundlePublisher({
        approvalKeyId: KEY_ID,
        trustedApprovalKeys: new Map([[KEY_ID, privateKey]]),
        trustedWorkflowSourceReadback: async () => {},
        trustedRunnerImageReadback: async () => {},
        evidenceVerifier: async () => {},
        signApprovalPayload: async () => {},
        publishRegistryRecord: async () => {},
        readRegistryRecord: async () => null,
      }),
    /TRUSTED_BUNDLE_PUBLISHER_CONFIGURATION_INVALID/u,
  );
});

test("evidence verifier가 입력을 바꿔도 검증 전 snapshot만 서명한다", async () => {
  const candidate = await createWorkflowBundle({
    sourceSha: SOURCE_SHA,
    platformRelease: PLATFORM_RELEASE,
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const approved = await promoteWorkflowBundle(candidate, EVIDENCE, {
    trustedWorkflowSourceReadback: trustedSourceReadbackFor(candidate),
    evidenceVerifier: async (record, bundle) => {
      const original = structuredClone(record);
      record.artifactSha256 = `sha256:${"f".repeat(64)}`;
      return verifiedEvidence(original, bundle);
    },
    trustedRunnerImageReadback,
    ...trustedSignerOptions(privateKey, publicKey),
    registryPublisher: async (record) => record,
  });

  assert.ok(
    approved.approval.evidence.every(
      (record) => record.artifactSha256 === DIGEST,
    ),
  );
});

test("generator와 validator는 trusted APPROVED bundle의 exact path와 SHA만 허용한다", async () => {
  const { binding } = await approvedFixture();
  for (const profile of ["react-native", "godot"]) {
    const callerState = await callerFixture({ profile });
    const caller = await generateOrgContractCaller({
      approvedBundleBinding: binding,
      callerBinding: callerState.callerBinding,
    });
    const result = await validateOrgContractCaller(caller, {
      approvedBundleBinding: binding,
      callerBinding: callerState.callerBinding,
      repositoryContext: callerState.repositoryContext,
    });
    assert.equal(result.ok, true, `${profile}: ${result.diagnostics}`);
    assert.equal(result.profile, profile);
    assert.equal(result.workflowSha, SOURCE_SHA);
    assert.doesNotMatch(caller, /secrets:|runs-on:/u);

    const stale = caller.replace(`@${SOURCE_SHA}`, `@${STALE_SHA}`);
    const staleResult = await validateOrgContractCaller(stale, {
      approvedBundleBinding: binding,
      callerBinding: callerState.callerBinding,
      repositoryContext: callerState.repositoryContext,
    });
    assert.equal(staleResult.ok, false);
    assert.ok(
      staleResult.diagnostics.includes("CALLER_APPROVED_WORKFLOW_MISMATCH"),
    );
  }

  await assert.rejects(
    async () =>
      generateOrgContractCaller({
        approvedBundleBinding: binding,
        profile: "react-native",
      }),
    /CALLER_GENERATION_INPUT_FORBIDDEN/u,
  );
});

test("registry 승인 철회와 5분 binding 만료 뒤 caller 생성을 거부한다", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const first = await approvedFixture();
  const firstCaller = await callerFixture();
  first.registry.clear();
  await assert.rejects(
    generateOrgContractCaller({
      approvedBundleBinding: first.binding,
      callerBinding: firstCaller.callerBinding,
    }),
    /APPROVED_BUNDLE_REGISTRY_REVOKED/u,
  );

  const second = await approvedFixture();
  const secondCaller = await callerFixture({ profile: "godot" });
  now += 5 * 60 * 1000;
  await assert.rejects(
    generateOrgContractCaller({
      approvedBundleBinding: second.binding,
      callerBinding: secondCaller.callerBinding,
    }),
    /APPROVED_BUNDLE_BINDING_EXPIRED/u,
  );
});

test("candidate 또는 구조만 흉내 낸 객체로 caller binding을 만들 수 없다", async () => {
  const candidate = await createWorkflowBundle({ sourceSha: SOURCE_SHA });
  const callerState = await callerFixture();
  await assert.rejects(
    loadApprovedWorkflowBundle(candidate),
    /APPROVED_BUNDLE_REQUIRED/u,
  );
  await assert.rejects(
    async () =>
      generateOrgContractCaller({
        approvedBundleBinding: {
          sourceSha: SOURCE_SHA,
          workflowByProfile: candidate.reusableWorkflows,
        },
        callerBinding: callerState.callerBinding,
      }),
    /APPROVED_BUNDLE_BINDING_REQUIRED/u,
  );
});

test("repo-scoped binding은 decoy directory, 반대 profile과 repository mismatch를 차단한다", async () => {
  const { binding } = await approvedFixture();
  const callerState = await callerFixture({
    profile: "react-native",
    packageManager: "pnpm",
    workingDirectory: "apps/mobile",
  });
  const valid = await generateOrgContractCaller({
    approvedBundleBinding: binding,
    callerBinding: callerState.callerBinding,
  });
  const check = (caller, repositoryContext = callerState.repositoryContext) =>
    validateOrgContractCaller(caller, {
      approvedBundleBinding: binding,
      callerBinding: callerState.callerBinding,
      repositoryContext,
    });

  const decoy = valid.replace(
    "working_directory: apps/mobile",
    "working_directory: decoy",
  );
  assert.ok(
    (await check(decoy)).diagnostics.includes("CALLER_RESOLVED_INPUT_MISMATCH"),
  );
  const wrongManager = valid.replace("package_manager: pnpm", "package_manager: npm");
  assert.ok(
    (await check(wrongManager)).diagnostics.includes(
      "CALLER_RESOLVED_INPUT_MISMATCH",
    ),
  );
  const wrongProfile = valid.replace(
    ".github/workflows/rn-static-checks-v2.yml",
    ".github/workflows/godot-checks-v2.yml",
  );
  assert.ok(
    (await check(wrongProfile)).diagnostics.includes(
      "CALLER_APPROVED_WORKFLOW_MISMATCH",
    ),
  );
  assert.ok(
    (
      await check(valid, {
        repositoryId: "7002",
        fullName: "seorilabs/other-app",
        sourceSha: callerState.repositoryContext.sourceSha,
      })
    ).diagnostics.includes("CALLER_REPOSITORY_CONTEXT_MISMATCH"),
  );
  assert.ok(
    (
      await check(valid, {
        ...callerState.repositoryContext,
        sourceSha: "8".repeat(40),
      })
    ).diagnostics.includes("CALLER_REPOSITORY_CONTEXT_MISMATCH"),
  );
  await assert.rejects(
    loadResolvedCallerBinding(callerState.repositoryContext, {
      trustedResolvedManifestReadback: async () => ({
        ...callerState.manifest,
        sourceSha: "8".repeat(40),
      }),
    }),
    /CALLER_MANIFEST_MISMATCH/u,
  );
});

test("resolved manifest 철회, 변경과 caller binding 만료를 매 소비 시 차단한다", async (t) => {
  let now = 2_000_000;
  t.mock.method(Date, "now", () => now);
  const first = await callerFixture();
  const firstBundle = await approvedFixture();
  first.manifests.clear();
  await assert.rejects(
    generateOrgContractCaller({
      approvedBundleBinding: firstBundle.binding,
      callerBinding: first.callerBinding,
    }),
    /CALLER_MANIFEST_REVOKED/u,
  );

  const changed = await callerFixture();
  const changedRecord = changed.manifests.get(REPOSITORY_CONTEXT.repositoryId);
  changedRecord.configRevision = 18;
  await assert.rejects(
    generateOrgContractCaller({
      approvedBundleBinding: firstBundle.binding,
      callerBinding: changed.callerBinding,
    }),
    /CALLER_MANIFEST_CHANGED/u,
  );

  const expired = await callerFixture();
  now += 5 * 60 * 1000;
  const freshBundle = await approvedFixture();
  await assert.rejects(
    generateOrgContractCaller({
      approvedBundleBinding: freshBundle.binding,
      callerBinding: expired.callerBinding,
    }),
    /CALLER_BINDING_EXPIRED/u,
  );
});

test("weak caller, secrets inherit, wrong runner와 weak trigger를 차단한다", async () => {
  const { binding } = await approvedFixture();
  const callerState = await callerFixture();
  const valid = await generateOrgContractCaller({
    approvedBundleBinding: binding,
    callerBinding: callerState.callerBinding,
  });
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
  const weakTrigger = valid.replace(
    "  pull_request: {}\n",
    "  schedule:\n    - cron: 0 0 * * *\n",
  );
  const check = async (caller) =>
    validateOrgContractCaller(caller, {
      approvedBundleBinding: binding,
      callerBinding: callerState.callerBinding,
      repositoryContext: callerState.repositoryContext,
    });

  assert.ok((await check(inherited)).diagnostics.includes("SECRET_INHERITANCE_FORBIDDEN"));
  assert.ok((await check(arbitraryRunner)).diagnostics.includes("THIN_CALLER_REQUIRED"));
  assert.ok((await check(skipped)).diagnostics.includes("CALLER_JOB_POLICY_INVALID"));
  assert.ok((await check(weakTrigger)).diagnostics.includes("CALLER_EVENTS_INVALID"));
});

test("구조만 흉내 낸 repo caller binding을 거부한다", async () => {
  const { binding } = await approvedFixture();
  await assert.rejects(
    async () =>
      generateOrgContractCaller({
        approvedBundleBinding: binding,
        callerBinding: {
          repositoryId: REPOSITORY_CONTEXT.repositoryId,
          fullName: REPOSITORY_CONTEXT.fullName,
        },
      }),
    /CALLER_BINDING_REQUIRED/u,
  );
});
