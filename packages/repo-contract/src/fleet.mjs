import {
  createPublicKey,
  createHash,
  verify as verifyEd25519,
} from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { parseDocument, stringify } from "yaml";

const WORKSPACE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SOURCE_PATH = "contracts/workflow-bundle-source.yaml";
const SCHEMA_PATH = "contracts/workflow-bundle.schema.json";
const XCODE_SCHEMA_PATH = "contracts/xcode-cloud-run.schema.json";
const PROFILE_BY_WORKFLOW = Object.freeze({
  ".github/workflows/rn-static-checks-v2.yml": "react-native",
  ".github/workflows/godot-checks-v2.yml": "godot",
});
const WORKFLOW_BY_PROFILE = Object.freeze(
  Object.fromEntries(
    Object.entries(PROFILE_BY_WORKFLOW).map(([workflow, profile]) => [
      profile,
      workflow,
    ]),
  ),
);
const BUILD_PROFILE_BY_WORKFLOW = Object.freeze({
  ".github/workflows/rn-build-android-cloud-v1.yml": "react-native",
  ".github/workflows/godot-build-android-cloud-v1.yml": "godot",
});
const BUILD_WORKFLOW_BY_PROFILE = Object.freeze(
  Object.fromEntries(
    Object.entries(BUILD_PROFILE_BY_WORKFLOW).map(([workflow, profile]) => [
      profile,
      workflow,
    ]),
  ),
);
const CLOUD_BUILD_CONFIG_BY_PROFILE = Object.freeze({
  "react-native": ".github/cloud-build/rn-android-build-only.yaml",
  godot: ".github/cloud-build/godot-android-build-only.yaml",
});
const V4_RUNTIME_AST_DIGEST_BY_PATH = Object.freeze({
  ".github/workflows/rn-static-checks-v2.yml":
    "sha256:e725c646653cc6871c0faa0786a13077ecd753b8ed6a7c170ab42b39d7f30933",
  ".github/workflows/godot-checks-v2.yml":
    "sha256:53ca7b29a018780122f09bdd711f93580ac1640df09b95b20b4782c85055f077",
  ".github/workflows/rn-build-android-cloud-v1.yml":
    "sha256:20f146537adbe4cff9fdbc591fe472eb2429363c18e7a4c6ae486b74496f2083",
  ".github/workflows/godot-build-android-cloud-v1.yml":
    "sha256:13bdb5701f9936b634012f20e61602ee67b4abf1031fe7caf3e8c1761698b4e1",
  ".github/cloud-build/rn-android-build-only.yaml":
    "sha256:1dd60b78d45f701fb66f04d773ffdd73ec327ad82472db432f4828f6c2617d0c",
  ".github/cloud-build/godot-android-build-only.yaml":
    "sha256:c951ca151239c5946135263c58fa0d4f007bd9e9d1bf15fe36752cdda7632e3c",
});
const CONTRACT_FILES = Object.freeze([
  "contracts/app.schema.json",
  "contracts/fleet-bootstrap-plan.schema.json",
  "contracts/platform-releases/v0.6.6/platform-release.json",
  "contracts/release-policy.yaml",
  "contracts/test-policy.yaml",
  "contracts/workflow-bundle.schema.json",
  "contracts/workflow-bundle-source.yaml",
  "contracts/xcode-cloud-run.schema.json",
  "profiles/fleet-godot.yaml",
  "profiles/fleet-react-native.yaml",
  "profiles/godot.yaml",
  "profiles/react-native.yaml",
]);
const RUNTIME_ASSET_FILES = Object.freeze([
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
const ACTION_REPOSITORY_BY_KEY = Object.freeze({
  checkout: "actions/checkout",
  "google-auth": "google-github-actions/auth",
  "setup-node": "actions/setup-node",
  "setup-gcloud": "google-github-actions/setup-gcloud",
  "upload-artifact": "actions/upload-artifact",
});
const APPROVAL_REGISTRY_ID = "seorilabs-workflow-bundles-v1";
const CURRENT_BUNDLE_VERSION = "4.1.0";
const APPROVAL_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const APPROVED_BINDING_TTL_MS = 5 * 60 * 1000;
const TRUSTED_BUNDLE_BINDINGS = new WeakMap();
const TRUSTED_CALLER_BINDINGS = new WeakMap();
const TRUSTED_PLATFORM_GATE_BINDINGS = new WeakMap();
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CLOUD_BUILD_ID_PATTERN =
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const SAFE_RELATIVE_DIRECTORY = /^(?:\.|[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*)$/u;
const REPOSITORY_FULL_NAME_PATTERN = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,31}$/u;
const CONFIG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{9,127}$/u;
const SNAPSHOT_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_REF_PATTERN = /^[^\u0000-\u001F\u007F]{1,512}$/u;
const FLEET_DEFAULT_REF = "refs/heads/main";
const SAFE_SOURCE_PATH = /^[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*$/u;
const XCODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const XCODE_SOURCE_REFERENCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

function isWorkflowBundleV4(bundle) {
  return /^4\./u.test(bundle?.bundleVersion ?? "");
}

function isSafeRelativeDirectory(value) {
  return (
    typeof value === "string" &&
    SAFE_RELATIVE_DIRECTORY.test(value) &&
    (value === "." ||
      value
        .split("/")
        .every((segment) => segment !== "." && segment !== ".."))
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function isObjectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function bundlePayload(bundle) {
  const { integrity: _integrity, ...payload } = bundle;
  return payload;
}

function withIntegrity(bundle) {
  const payload = bundlePayload(bundle);
  return {
    ...payload,
    integrity: {
      algorithm: "sha256",
      payloadDigest: sha256(canonicalJson(payload)),
    },
  };
}

async function readYaml(path) {
  const text = await readFile(path, "utf8");
  const document = parseDocument(text, {
    maxAliasCount: 20,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(`YAML_PARSE_FAILED:${path}`);
  }
  return document.toJS({ maxAliasCount: 20 });
}

async function contractDigests(repoRoot) {
  return Object.fromEntries(
    await Promise.all(
      CONTRACT_FILES.map(async (relativePath) => [
        relativePath,
        sha256(await readFile(resolve(repoRoot, relativePath))),
      ]),
    ),
  );
}

async function runtimeAssetDigests(repoRoot) {
  return Object.fromEntries(
    await Promise.all(
      RUNTIME_ASSET_FILES.map(async (relativePath) => [
        relativePath,
        sha256(await readFile(resolve(repoRoot, relativePath))),
      ]),
    ),
  );
}

function sourceSnapshotMatches(snapshot, bundle) {
  const expectedContractPaths = Object.keys(
    bundle?.quality?.contractDigests ?? {},
  ).sort();
  const expectedRuntimePaths = Object.keys(
    bundle?.quality?.runtimeAssetDigests ?? {},
  ).sort();
  if (!(
    snapshot !== null &&
    typeof snapshot === "object" &&
    snapshot.repository === "seorilabs/.github" &&
    snapshot.sourceSha === bundle?.source?.sha &&
    canonicalJson(snapshot.contractDigests ?? {}) ===
      canonicalJson(bundle?.quality?.contractDigests ?? {}) &&
    canonicalJson(snapshot.runtimeAssetDigests ?? {}) ===
      canonicalJson(bundle?.quality?.runtimeAssetDigests ?? {}) &&
    typeof snapshot.workflowBundleSchemaText === "string" &&
    sha256(Buffer.from(snapshot.workflowBundleSchemaText, "utf8")) ===
      bundle?.quality?.contractDigests?.[SCHEMA_PATH]
  )) {
    return false;
  }
  if (isWorkflowBundleV4(bundle)) {
    const contractContents = snapshot.contractAssetContents;
    if (
      contractContents === null ||
      typeof contractContents !== "object" ||
      canonicalJson(Object.keys(contractContents).sort()) !==
        canonicalJson(expectedContractPaths) ||
      expectedContractPaths.some(
        (path) =>
          typeof contractContents[path] !== "string" ||
          sha256(Buffer.from(contractContents[path], "utf8")) !==
            bundle.quality.contractDigests[path],
      )
    ) {
      return false;
    }
  }
  const runtimeContents = snapshot.runtimeAssetContents;
  return (
    runtimeContents !== null &&
    typeof runtimeContents === "object" &&
    canonicalJson(Object.keys(runtimeContents).sort()) ===
      canonicalJson(expectedRuntimePaths) &&
    expectedRuntimePaths.every(
      (path) =>
        typeof runtimeContents[path] === "string" &&
        sha256(Buffer.from(runtimeContents[path], "utf8")) ===
          bundle.quality.runtimeAssetDigests[path],
    )
  );
}

async function verifyWorkflowSourceReadback(bundle, trustedWorkflowSourceReadback) {
  if (typeof trustedWorkflowSourceReadback !== "function") {
    return { diagnostic: "WORKFLOW_SOURCE_READBACK_REQUIRED" };
  }
  try {
    const observed = await trustedWorkflowSourceReadback({
      repository: "seorilabs/.github",
      sourceSha: bundle.source.sha,
      contractPaths: Object.keys(bundle.quality.contractDigests),
      runtimeAssetPaths: Object.keys(bundle.quality.runtimeAssetDigests),
    });
    const snapshot = structuredClone(observed);
    if (!sourceSnapshotMatches(snapshot, bundle)) {
      return { diagnostic: "WORKFLOW_SOURCE_READBACK_MISMATCH" };
    }
    return { snapshot };
  } catch {
    return { diagnostic: "WORKFLOW_SOURCE_READBACK_FAILED" };
  }
}

function fixedGitHubApiUrl(path, query = {}) {
  const url = new URL(`https://api.github.com${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url;
}

async function githubJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
  });
  if (!response?.ok) {
    throw new Error(`GITHUB_READBACK_HTTP_${response?.status ?? "UNKNOWN"}`);
  }
  return response.json();
}

function decodeGitHubContents(value) {
  const normalized = value.replace(/\s/gu, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(normalized)) {
    throw new Error("GITHUB_CONTENT_INVALID");
  }
  return Buffer.from(normalized, "base64");
}

export function createGitHubWorkflowSourceReadback({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("GITHUB_FETCH_REQUIRED");
  }
  const snapshotPromises = new Map();
  return async ({ repository, sourceSha, contractPaths, runtimeAssetPaths }) => {
    const validPaths = (paths) =>
      Array.isArray(paths) &&
      paths.length > 0 &&
      paths.length <= 64 &&
      new Set(paths).size === paths.length &&
      paths.every(
        (path) =>
          SAFE_SOURCE_PATH.test(path) &&
          path.split("/").every((segment) => segment !== "." && segment !== ".."),
      );
    if (
      repository !== "seorilabs/.github" ||
      !SHA_PATTERN.test(sourceSha ?? "") ||
      !validPaths(contractPaths) ||
      !validPaths(runtimeAssetPaths) ||
      !contractPaths.includes(SCHEMA_PATH)
    ) {
      throw new Error("GITHUB_SOURCE_REQUEST_INVALID");
    }
    const cacheKey = `${sourceSha}:${sha256(canonicalJson({ contractPaths, runtimeAssetPaths }))}`;
    if (!snapshotPromises.has(cacheKey)) {
      snapshotPromises.set(
        cacheKey,
        (async () => {
          const commit = await githubJson(
            fetchImpl,
            fixedGitHubApiUrl(`/repos/seorilabs/.github/commits/${sourceSha}`),
          );
          if (commit?.sha !== sourceSha) {
            throw new Error("GITHUB_COMMIT_MISMATCH");
          }

          const fileEntries = await Promise.all(
            [...contractPaths, ...runtimeAssetPaths].map(
              async (relativePath) => {
                const encodedPath = relativePath
                  .split("/")
                  .map((segment) => encodeURIComponent(segment))
                  .join("/");
                const contents = await githubJson(
                  fetchImpl,
                  fixedGitHubApiUrl(
                    `/repos/seorilabs/.github/contents/${encodedPath}`,
                    { ref: sourceSha },
                  ),
                );
                if (
                  contents?.type !== "file" ||
                  contents?.encoding !== "base64" ||
                  typeof contents.content !== "string"
                ) {
                  throw new Error("GITHUB_CONTENT_INVALID");
                }
                const content = decodeGitHubContents(contents.content);
                return [relativePath, { content, digest: sha256(content) }];
              },
            ),
          );
          const fileByPath = Object.fromEntries(fileEntries);
          return {
            repository,
            sourceSha,
            contractDigests: Object.fromEntries(
              contractPaths.map((path) => [path, fileByPath[path].digest]),
            ),
            runtimeAssetDigests: Object.fromEntries(
              runtimeAssetPaths.map((path) => [path, fileByPath[path].digest]),
            ),
            workflowBundleSchemaText:
              fileByPath[SCHEMA_PATH].content.toString("utf8"),
            contractAssetContents: Object.fromEntries(
              contractPaths.map((path) => [
                path,
                fileByPath[path].content.toString("utf8"),
              ]),
            ),
            runtimeAssetContents: Object.fromEntries(
              runtimeAssetPaths.map((path) => [
                path,
                fileByPath[path].content.toString("utf8"),
              ]),
            ),
          };
        })(),
      );
    }
    try {
      return structuredClone(await snapshotPromises.get(cacheKey));
    } catch (error) {
      snapshotPromises.delete(cacheKey);
      throw error;
    }
  };
}

function runtimeDeclarationsMatchTexts(bundle, runtimeTextByPath) {
  const declaredActions = new Map();
  for (const [key, action] of Object.entries(bundle?.actions ?? {})) {
    const repository = ACTION_REPOSITORY_BY_KEY[key];
    if (!repository || !SHA_PATTERN.test(action?.sha ?? "")) return false;
    declaredActions.set(repository, action.sha);
  }
  if (declaredActions.size !== Object.keys(bundle?.actions ?? {}).length) {
    return false;
  }
  const observedActions = [];
  const workflowByPath = {};
  for (const [path, text] of Object.entries(runtimeTextByPath)) {
    if (!path.startsWith(".github/workflows/") || !path.endsWith(".yml")) {
      continue;
    }
    const document = parseDocument(text, {
      maxAliasCount: 10,
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) return false;
    const workflow = document.toJS({ maxAliasCount: 10 });
    if (
      isWorkflowBundleV4(bundle) &&
      sha256(canonicalJson(workflow)) !== V4_RUNTIME_AST_DIGEST_BY_PATH[path]
    ) {
      return false;
    }
    workflowByPath[path] = workflow;
    for (const uses of collectWorkflowValues(workflow, "uses")) {
      const match =
        typeof uses === "string"
          ? /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-f]{40})$/u.exec(uses)
          : undefined;
      if (!match) return false;
      observedActions.push([uses, match[1], match[2]]);
    }
  }
  if (observedActions.length === 0) return false;
  const seen = new Set();
  for (const [, repository, sha] of observedActions) {
    if (declaredActions.get(repository) !== sha) {
      return false;
    }
    seen.add(repository);
  }
  if ([...declaredActions.keys()].some((repository) => !seen.has(repository))) {
    return false;
  }

  const allSteps = Object.values(workflowByPath).flatMap((workflow) =>
    Object.values(workflow?.jobs ?? {}).flatMap((job) => job?.steps ?? []),
  );
  const stepsUsing = (repository) =>
    allSteps.filter(
      (step) =>
        typeof step?.uses === "string" &&
        step.uses.startsWith(`${repository}@`),
    );
  const nodeSteps = stepsUsing("actions/setup-node");
  const gcloudSteps = stepsUsing("google-github-actions/setup-gcloud");
  const checkoutSteps = stepsUsing("actions/checkout");
  if (
    (isWorkflowBundleV4(bundle) &&
      (checkoutSteps.length === 0 ||
        checkoutSteps.some(
          (step) => step?.with?.["persist-credentials"] !== false,
        ))) ||
    nodeSteps.length === 0 ||
    nodeSteps.some(
      (step) => step?.with?.["node-version"] !== bundle?.toolchains?.node,
    ) ||
    (bundle?.toolchains?.gcloud !== undefined &&
      (gcloudSteps.length === 0 ||
        gcloudSteps.some(
          (step) => step?.with?.version !== bundle.toolchains.gcloud,
        )))
  ) {
    return false;
  }
  const stepByName = (workflow, jobName, stepName) =>
    workflow?.jobs?.[jobName]?.steps?.find((step) => step?.name === stepName);
  const hasExactKeys = (value, expectedKeys) =>
    value !== null &&
    typeof value === "object" &&
    canonicalJson(Object.keys(value).sort()) ===
      canonicalJson([...expectedKeys].sort());
  for (const profile of ["react-native", "godot"]) {
    const workflow = workflowByPath[bundle?.reusableWorkflows?.[profile]?.path];
    const qualityJob = workflow?.jobs?.quality;
    const orgContractJob = workflow?.jobs?.["org-contract"];
    const expectedQualityStepNames = [
      "Checkout application source",
      "Setup pinned Node",
      "Resolve called workflow identity",
      "Checkout immutable org bundle source",
      "Validate discovered inputs and canonical commands",
      "Scan tracked source for high-confidence credentials",
      "Enable pinned pnpm",
      "Fetch locked dependencies without lifecycle scripts",
      "Rebuild dependencies without registry credential",
      "Reject high severity dependency advisories",
      ...(profile === "godot"
        ? isWorkflowBundleV4(bundle)
          ? [
              "Install pinned Godot when the runner image differs",
              "Probe pinned Godot toolchain diagnostics",
              "Import Godot project",
              "Reject product Godot diagnostics",
            ]
          : [
              "Install pinned Godot when the runner image differs",
              "Import Godot project and reject engine errors",
            ]
        : []),
      "Run canonical product tests",
      "Run canonical architecture checks",
      "Run canonical release checks",
    ];
    const expectedOrgContractStepNames = [
      "Reject failed or cancelled quality job",
      "Setup pinned Node in isolated evidence job",
      "Resolve called workflow identity in isolated evidence job",
      "Checkout immutable org evidence writer",
      "Record non-secret CI provenance",
      "Upload isolated CI provenance",
    ];
    const runnerExpression =
      "${{ github.event.repository.private && '" +
      bundle?.runners?.privateGeneral +
      "' || '" +
      bundle?.runners?.publicPullRequest +
      "' }}";
    const trustedPullRequestExpression =
      "${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}";
    if (
      canonicalJson(Object.keys(workflow?.jobs ?? {}).sort()) !==
        canonicalJson(["org-contract", "quality"]) ||
      canonicalJson((qualityJob?.steps ?? []).map((step) => step?.name)) !==
        canonicalJson(expectedQualityStepNames) ||
      canonicalJson((orgContractJob?.steps ?? []).map((step) => step?.name)) !==
      canonicalJson(expectedOrgContractStepNames) ||
      qualityJob?.name !== "Fleet Quality" ||
      (isWorkflowBundleV4(bundle)
        ? qualityJob?.if !== trustedPullRequestExpression
        : Object.hasOwn(qualityJob ?? {}, "if")) ||
      qualityJob?.["runs-on"] !== runnerExpression ||
      Object.hasOwn(qualityJob ?? {}, "continue-on-error") ||
      orgContractJob?.name !== "Org Contract" ||
      orgContractJob?.needs !== "quality" ||
      orgContractJob?.if !== "${{ always() }}" ||
      (isWorkflowBundleV4(bundle)
        ? canonicalJson(orgContractJob?.permissions) !==
          canonicalJson({ contents: "read" })
        : Object.hasOwn(orgContractJob ?? {}, "permissions")) ||
      orgContractJob?.["runs-on"] !== runnerExpression ||
      Object.hasOwn(orgContractJob ?? {}, "continue-on-error")
    ) {
      return false;
    }
    const pnpmStep = stepByName(workflow, "quality", "Enable pinned pnpm");
    const applicationCheckoutStep = stepByName(
      workflow,
      "quality",
      "Checkout application source",
    );
    const bundleCheckoutStep = stepByName(
      workflow,
      "quality",
      "Checkout immutable org bundle source",
    );
    const preflightStep = stepByName(
      workflow,
      "quality",
      "Validate discovered inputs and canonical commands",
    );
    const secretScanStep = stepByName(
      workflow,
      "quality",
      "Scan tracked source for high-confidence credentials",
    );
    const applicationWorkingDirectory = isWorkflowBundleV4(bundle)
      ? "${{ format('.seorilabs-application/{0}', inputs.working_directory) }}"
      : "${{ inputs.working_directory }}";
    const applicationStepNames = [
      "Fetch locked dependencies without lifecycle scripts",
      "Rebuild dependencies without registry credential",
      "Reject high severity dependency advisories",
      ...(profile === "godot"
        ? [
            isWorkflowBundleV4(bundle)
              ? "Import Godot project"
              : "Import Godot project and reject engine errors",
          ]
        : []),
      "Run canonical product tests",
      "Run canonical architecture checks",
      "Run canonical release checks",
    ];
    const expectedPnpmRun = [
      "set -euo pipefail",
      "corepack enable",
      `corepack prepare pnpm@${bundle?.toolchains?.pnpm} --activate`,
    ].join("\n");
    if (
      (isWorkflowBundleV4(bundle) &&
        (applicationCheckoutStep?.with?.path !== ".seorilabs-application" ||
          applicationCheckoutStep?.with?.["persist-credentials"] !== false ||
          bundleCheckoutStep?.with?.path !== ".seorilabs-org" ||
          !preflightStep?.run?.includes(
            '--repo-root "$GITHUB_WORKSPACE/.seorilabs-application"',
          ) ||
          secretScanStep?.run !==
            'node .seorilabs-org/scripts/fleet/secret-scan.mjs "$GITHUB_WORKSPACE/.seorilabs-application"')) ||
      applicationStepNames.some(
        (name) =>
          stepByName(workflow, "quality", name)?.["working-directory"] !==
          applicationWorkingDirectory,
      ) ||
      !hasExactKeys(pnpmStep, ["name", "if", "shell", "run"]) ||
      pnpmStep.if !== "inputs.package_manager == 'pnpm'" ||
      pnpmStep.shell !== "bash" ||
      pnpmStep.run.trim() !== expectedPnpmRun
    ) {
      return false;
    }
    const orgGateStep = stepByName(
      workflow,
      "org-contract",
      "Reject failed or cancelled quality job",
    );
    if (
      !hasExactKeys(orgGateStep, ["name", "shell", "env", "run"]) ||
      orgGateStep.shell !== "bash" ||
      canonicalJson(orgGateStep.env) !==
        canonicalJson({ QUALITY_RESULT: "${{ needs.quality.result }}" }) ||
      orgGateStep.run !== 'test "$QUALITY_RESULT" = success'
    ) {
      return false;
    }
    const canonicalStepNames = {
      "test:core": "Run canonical product tests",
      "check:architecture": "Run canonical architecture checks",
      "check:release": "Run canonical release checks",
    };
    for (const script of bundle?.quality?.canonicalScripts ?? []) {
      const step = stepByName(workflow, "quality", canonicalStepNames[script]);
      const expectedRun = [
        'case "$PACKAGE_MANAGER" in',
        `  npm) npm run ${script} ;;`,
        `  pnpm) pnpm ${script} ;;`,
        "esac",
      ].join("\n");
      if (
        !hasExactKeys(step, ["name", "shell", "working-directory", "env", "run"]) ||
        step.shell !== "bash" ||
        step["working-directory"] !== applicationWorkingDirectory ||
        canonicalJson(step.env) !==
          canonicalJson({ PACKAGE_MANAGER: "${{ inputs.package_manager }}" }) ||
        step.run.trim() !== expectedRun
      ) {
        return false;
      }
    }
    if (profile === "godot" && isWorkflowBundleV4(bundle)) {
      const probeStep = stepByName(
        workflow,
        "quality",
        "Probe pinned Godot toolchain diagnostics",
      );
      const diagnosticGateStep = stepByName(
        workflow,
        "quality",
        "Reject product Godot diagnostics",
      );
      if (
        Object.hasOwn(probeStep ?? {}, "continue-on-error") ||
        !probeStep?.run?.includes(
          '"$GITHUB_WORKSPACE/.seorilabs-org/fixtures/workflow-bundle/godot/toolchain-probe"',
        ) ||
        !probeStep?.run?.includes('tee "$RUNNER_TEMP/godot-toolchain.log"') ||
        Object.hasOwn(diagnosticGateStep ?? {}, "continue-on-error") ||
        !diagnosticGateStep?.run?.includes(
          "node .seorilabs-org/scripts/fleet/godot-diagnostic-gate.mjs",
        ) ||
        !diagnosticGateStep?.run?.includes(
          '--application-log "$RUNNER_TEMP/godot-import.log"',
        )
      ) {
        return false;
      }
    }
  }
  if (bundle?.buildWorkflows !== undefined) {
    for (const profile of ["react-native", "godot"]) {
      const workflow = workflowByPath[bundle.buildWorkflows?.[profile]?.path];
      const job = workflow?.jobs?.["submit-build-only"];
      const appCheckout = stepByName(
        workflow,
        "submit-build-only",
        "Checkout exact application source",
      );
      const bundleCheckout = stepByName(
        workflow,
        "submit-build-only",
        "Checkout exact bundle source outside application tree",
      );
      const validateInputs = stepByName(
        workflow,
        "submit-build-only",
        "Validate immutable inputs",
      );
      const authenticate = stepByName(
        workflow,
        "submit-build-only",
        "Authenticate keylessly for Cloud Build",
      );
      const submit = stepByName(
        workflow,
        "submit-build-only",
        "Submit exact source to x64 Cloud Build",
      );
      const expectedBuildPermissions =
        bundle?.callerPolicies?.androidBuild?.permissions?.[profile];
      const privatePackageStage = stepByName(
        workflow,
        "submit-build-only",
        "Stage exact private Platform SDK without exporting the token",
      );
      if (
        canonicalJson(Object.keys(workflow?.jobs ?? {}).sort()) !==
          canonicalJson(["submit-build-only"]) ||
        !isObjectRecord(expectedBuildPermissions) ||
        canonicalJson(workflow?.permissions) !==
          canonicalJson(expectedBuildPermissions) ||
        workflow?.on?.workflow_call?.secrets !== undefined ||
        canonicalJson(
          Object.keys(workflow?.on?.workflow_call?.inputs ?? {}).sort(),
        ) !== canonicalJson(["source_sha", "working_directory"]) ||
        job?.name !== "Android Build-only" ||
        job?.if !== "${{ github.event.repository.private }}" ||
        job?.["runs-on"] !== bundle?.runners?.androidSubmit ||
        job?.environment !== "internal" ||
        Object.hasOwn(job ?? {}, "continue-on-error") ||
        !hasExactKeys(appCheckout, ["name", "uses", "with"]) ||
        canonicalJson(appCheckout.with) !==
          canonicalJson({
            ref: "${{ inputs.source_sha }}",
            path: ".seorilabs-application",
            "persist-credentials": false,
          }) ||
        !hasExactKeys(bundleCheckout, ["name", "uses", "with"]) ||
        canonicalJson(bundleCheckout.with) !==
          canonicalJson({
            repository: "${{ steps.bundle-identity.outputs.repository }}",
            ref: "${{ steps.bundle-identity.outputs.sha }}",
            path: ".seorilabs-workflow-bundle",
            "persist-credentials": false,
          }) ||
        typeof validateInputs?.run !== "string" ||
        !validateInputs.run.includes(
          'test "$CALLER_WORKFLOW_REF" = "${GITHUB_REPOSITORY}/.github/workflows/android-build-only.yml@refs/heads/main"',
        ) ||
        authenticate?.with?.workload_identity_provider !==
          "${{ vars.GOOGLE_WORKLOAD_IDENTITY_PROVIDER }}" ||
        authenticate?.with?.service_account !==
          "${{ vars.SEORI_CLOUD_BUILD_SUBMITTER_SERVICE_ACCOUNT }}" ||
        (profile === "react-native" &&
          (privatePackageStage?.env?.NODE_AUTH_TOKEN !== "${{ github.token }}" ||
            !privatePackageStage?.run?.includes(
              "stage-private-pnpm-store.mjs",
            ))) ||
        (profile === "godot" && privatePackageStage !== undefined) ||
        typeof submit?.run !== "string" ||
        !submit.run.includes(
          'application_root="$GITHUB_WORKSPACE/.seorilabs-application"',
        ) ||
        !submit.run.includes('gcloud builds submit "$application_root"') ||
        /androidpublisher|upload-google-play|tracks\/|edits\//iu.test(
          collectWorkflowValues(workflow, "run").join("\n"),
        )
      ) {
        return false;
      }

      const cloudBuildText =
        runtimeTextByPath[CLOUD_BUILD_CONFIG_BY_PROFILE[profile]];
      const cloudBuildDocument = parseDocument(cloudBuildText, {
        maxAliasCount: 10,
        prettyErrors: false,
        strict: true,
        uniqueKeys: true,
      });
      if (cloudBuildDocument.errors.length > 0) return false;
      const cloudBuild = cloudBuildDocument.toJS({ maxAliasCount: 10 });
      if (
        sha256(canonicalJson(cloudBuild)) !==
        V4_RUNTIME_AST_DIGEST_BY_PATH[CLOUD_BUILD_CONFIG_BY_PROFILE[profile]]
      ) {
        return false;
      }
      const buildStep = cloudBuild?.steps?.[0];
      const expectedBuildScript = [
        'workspace_root="$(realpath /workspace)"',
        'working_directory="$(realpath "/workspace/${_SEORI_WORKING_DIRECTORY}")"',
        'case "$working_directory" in',
        '  "$workspace_root"|"$workspace_root"/*) ;;',
        "  *) exit 1 ;;",
        "esac",
        'cd "$working_directory"',
        "test -f build.env",
        "test -f scripts/build-android.sh",
        ...(profile === "react-native"
          ? [
              'private_store="$(realpath /workspace/.seorilabs-pnpm-store)"',
              'test "$private_store" = /workspace/.seorilabs-pnpm-store',
              'test -d "$private_store/v11"',
              'export pnpm_config_store_dir="$private_store"',
              "export pnpm_config_enable_global_virtual_store=false",
              "export npm_config_userconfig=/dev/null",
            ]
          : []),
        "export SEORI_ANDROID_AAB_OUTPUT=/workspace/app-release.aab",
        "export SEORI_BUILD_MODE=build-only",
        "export SEORI_SOURCE_SHA=${_SEORI_SOURCE_SHA}",
        'rm -f "$SEORI_ANDROID_AAB_OUTPUT"',
        "bash scripts/build-android.sh",
        'test -s "$SEORI_ANDROID_AAB_OUTPUT"',
      ].join("\n");
      if (
        canonicalJson(Object.keys(cloudBuild ?? {}).sort()) !==
          canonicalJson(["artifacts", "options", "steps", "timeout"]) ||
        !Array.isArray(cloudBuild.steps) ||
        cloudBuild.steps.length !== 1 ||
        !hasExactKeys(buildStep, ["id", "name", "entrypoint", "args"]) ||
        buildStep.id !== "build-only" ||
        buildStep.name !== bundle?.delivery?.android?.builderImages?.[profile] ||
        buildStep.entrypoint !== "bash" ||
        canonicalJson(buildStep.args?.slice(0, 1)) !== canonicalJson(["-ceu"]) ||
        buildStep.args?.length !== 2 ||
        buildStep.args?.[1]?.trim() !== expectedBuildScript ||
        canonicalJson(cloudBuild.artifacts) !==
          canonicalJson({
            objects: {
              location: "${_SEORI_ARTIFACT_URI}",
              paths: ["app-release.aab"],
            },
          }) ||
        canonicalJson(cloudBuild.options) !==
          canonicalJson({ logging: "CLOUD_LOGGING_ONLY" }) ||
        cloudBuild.timeout !== "2400s"
      ) {
        return false;
      }
    }
  }

  const godotPath = bundle?.reusableWorkflows?.godot?.path;
  const godot = stepByName(
    workflowByPath[godotPath],
    "quality",
    "Install pinned Godot when the runner image differs",
  )?.run;
  const godotToolchain = bundle?.toolchains?.godot;
  return (
    typeof godot === "string" &&
    godot.includes(`Godot_v${godotToolchain?.version}-stable_linux.arm64.zip`) &&
    godot.includes(`Godot_v${godotToolchain?.version}-stable_linux.x86_64.zip`) &&
    godot.includes(godotToolchain?.linuxArm64Sha256 ?? "missing") &&
    godot.includes(godotToolchain?.linuxX64Sha256 ?? "missing")
  );
}

async function runtimeDeclarationsMatch(bundle, repoRoot) {
  const runtimeTextByPath = Object.fromEntries(
    await Promise.all(
      RUNTIME_ASSET_FILES.map(async (path) => [
        path,
        await readFile(resolve(repoRoot, path), "utf8"),
      ]),
    ),
  );
  return runtimeDeclarationsMatchTexts(bundle, runtimeTextByPath);
}

function sourceRuntimeDeclarationsMatch(bundle, snapshot) {
  return runtimeDeclarationsMatchTexts(bundle, snapshot.runtimeAssetContents);
}

function approvalSigningPayload(bundle) {
  const payload = bundlePayload(bundle);
  const { signature: _signature, ...approval } = payload.approval ?? {};
  return {
    ...payload,
    approval,
  };
}

function approvalRegistrySubject(bundle) {
  return `workflow-bundle/${bundle.bundleVersion}/${bundle.source.sha}`;
}

function trustedApprovalKey(trustedApprovalKeys, keyId) {
  if (trustedApprovalKeys instanceof Map) {
    return trustedApprovalKeys.get(keyId);
  }
  if (
    trustedApprovalKeys !== null &&
    typeof trustedApprovalKeys === "object" &&
    Object.hasOwn(trustedApprovalKeys, keyId)
  ) {
    return trustedApprovalKeys[keyId];
  }
  return undefined;
}

function snapshotTrustedApprovalKeys(trustedApprovalKeys) {
  if (trustedApprovalKeys === undefined || trustedApprovalKeys === null) {
    return Object.freeze({});
  }
  if (
    !(trustedApprovalKeys instanceof Map) &&
    (typeof trustedApprovalKeys !== "object" ||
      Object.getPrototypeOf(trustedApprovalKeys) !== Object.prototype)
  ) {
    throw new Error("APPROVAL_TRUSTED_KEYS_INVALID");
  }
  const entries =
    trustedApprovalKeys instanceof Map
      ? [...trustedApprovalKeys.entries()]
      : Object.entries(trustedApprovalKeys);
  if (
    !entries ||
    entries.some(
      ([keyId, key]) =>
        !APPROVAL_KEY_ID_PATTERN.test(keyId ?? "") ||
        key?.type !== "public" ||
        key?.asymmetricKeyType !== "ed25519",
    )
  ) {
    throw new Error("APPROVAL_TRUSTED_KEYS_INVALID");
  }
  return Object.freeze(
    Object.fromEntries(
      entries.map(([keyId, key]) => [
        keyId,
        createPublicKey({
          key: key.export({
            format: "der",
            type: "spki",
          }),
          format: "der",
          type: "spki",
        }),
      ]),
    ),
  );
}

function registryRecordMatches(record, bundle) {
  return (
    record !== null &&
    typeof record === "object" &&
    record.registryId === bundle.approval.registry.id &&
    record.subject === bundle.approval.registry.subject &&
    record.bundleDigest === bundle.integrity.payloadDigest &&
    record.sourceSha === bundle.source.sha &&
    record.bundleVersion === bundle.bundleVersion &&
    record.state === "APPROVED"
  );
}

function runnerImageRequest(bundle) {
  return {
    scaleSet: bundle.runners.androidSubmit,
    imageDigest: bundle.runners.androidSubmitImage,
  };
}

function runnerImageApprovalMatches(bundle) {
  const expected = runnerImageRequest(bundle);
  return (
    bundle?.approval?.runnerImage !== null &&
    typeof bundle?.approval?.runnerImage === "object" &&
    canonicalJson(bundle.approval.runnerImage) === canonicalJson(expected)
  );
}

async function verifyRunnerImageReadback(
  bundle,
  trustedRunnerImageReadback,
  { now = () => Date.now() } = {},
) {
  if (typeof trustedRunnerImageReadback !== "function") {
    return { diagnostic: "RUNNER_IMAGE_READBACK_REQUIRED" };
  }
  const request = runnerImageRequest(bundle);
  try {
    const record = structuredClone(
      await trustedRunnerImageReadback(structuredClone(request)),
    );
    const observedAtMs = Date.parse(record?.observedAt ?? "");
    const nowMs = now();
    const expectedKeys = [
      "generation",
      "imageDigest",
      "observedAt",
      "scaleSet",
      "state",
    ];
    if (
      record === null ||
      typeof record !== "object" ||
      canonicalJson(Object.keys(record).sort()) !== canonicalJson(expectedKeys) ||
      record.state !== "READY" ||
      record.scaleSet !== request.scaleSet ||
      record.imageDigest !== request.imageDigest ||
      !Number.isSafeInteger(record.generation) ||
      record.generation < 1 ||
      !ISO_DATE_PATTERN.test(record.observedAt ?? "") ||
      !Number.isFinite(observedAtMs) ||
      !Number.isFinite(nowMs) ||
      observedAtMs > nowMs + 60 * 1000 ||
      observedAtMs < nowMs - APPROVED_BINDING_TTL_MS
    ) {
      return { diagnostic: "RUNNER_IMAGE_READBACK_MISMATCH" };
    }
    return { record: deepFreeze(record) };
  } catch {
    return { diagnostic: "RUNNER_IMAGE_READBACK_FAILED" };
  }
}

function normalizePlatformRelease(platformRelease) {
  if (platformRelease === undefined || platformRelease === null) {
    return { state: "UNRESOLVED" };
  }

  const sourceSha = platformRelease.sourceSha ?? platformRelease.release?.sourceSha;
  const contractRevision =
    platformRelease.contractRevision ?? platformRelease.contract?.revision;
  const typescript =
    platformRelease.typescript ??
    platformRelease.artifacts?.typescript ??
    (platformRelease.sdk?.typescript
      ? {
          version: platformRelease.sdk.typescript.version,
          digest: `sha256:${platformRelease.sdk.typescript.artifact?.sha256 ?? ""}`,
        }
      : undefined);
  const gdscript =
    platformRelease.gdscript ??
    platformRelease.artifacts?.gdscript ??
    (platformRelease.sdk?.gdscript
      ? {
          version: platformRelease.sdk.gdscript.version,
          digest: `sha256:${platformRelease.sdk.gdscript.artifact?.sha256 ?? ""}`,
        }
      : undefined);

  if (
    platformRelease.schemaVersion !== undefined &&
    (platformRelease.schemaVersion !== 1 ||
      platformRelease.release?.tag !== `v${platformRelease.sdk?.gdscript?.version}` ||
      platformRelease.contract?.classification === undefined)
  ) {
    throw new Error("PLATFORM_RELEASE_INVALID");
  }

  if (
    !SHA_PATTERN.test(sourceSha ?? "") ||
    !SHA256_PATTERN.test(contractRevision ?? "") ||
    !typescript ||
    !gdscript
  ) {
    throw new Error("PLATFORM_RELEASE_INVALID");
  }

  for (const artifact of [typescript, gdscript]) {
    if (
      typeof artifact.version !== "string" ||
      !SHA256_PATTERN.test(artifact.digest ?? "")
    ) {
      throw new Error("PLATFORM_RELEASE_INVALID");
    }
  }

  return {
    state: "RESOLVED",
    sourceSha,
    contractRevision,
    typescript: {
      version: typescript.version,
      digest: typescript.digest,
    },
    gdscript: {
      version: gdscript.version,
      digest: gdscript.digest,
    },
  };
}

function canaryEvidenceValid(record, requiredGates, canaries, bundle) {
  const expectedKeys = [
    "artifactSha256",
    "builderImage",
    "buildRunId",
    "cloudBuildConfigSha256",
    "cloudBuildId",
    "gates",
    "profile",
    "repositoryId",
    "sourceSha",
    "staticRunId",
    "workflowBundleSourceSha",
  ];
  const expectedCanary = canaries?.[record?.profile];
  return (
    record !== null &&
    typeof record === "object" &&
    canonicalJson(Object.keys(record).sort()) ===
      canonicalJson([...expectedKeys].sort()) &&
    ["react-native", "godot"].includes(record.profile) &&
    canonicalJson(record.gates) === canonicalJson(requiredGates) &&
    expectedCanary !== null &&
    typeof expectedCanary === "object" &&
    Number.isSafeInteger(record.repositoryId) &&
    record.repositoryId === expectedCanary.repositoryId &&
    SHA_PATTERN.test(record.sourceSha ?? "") &&
    record.workflowBundleSourceSha === bundle?.source?.sha &&
    Number.isSafeInteger(record.staticRunId) &&
    record.staticRunId > 0 &&
    Number.isSafeInteger(record.buildRunId) &&
    record.buildRunId > 0 &&
    record.staticRunId !== record.buildRunId &&
    CLOUD_BUILD_ID_PATTERN.test(record.cloudBuildId ?? "") &&
    record.builderImage ===
      bundle?.delivery?.android?.builderImages?.[record.profile] &&
    record.cloudBuildConfigSha256 ===
      bundle?.quality?.runtimeAssetDigests?.[
        CLOUD_BUILD_CONFIG_BY_PROFILE[record.profile]
      ] &&
    SHA256_PATTERN.test(record.artifactSha256 ?? "")
  );
}

function canaryEvidenceReadbackMatches(verified, record, canary, bundle) {
  const expectedKeys = [
    "artifactSha256",
    "builderImage",
    "buildConclusion",
    "buildRunId",
    "buildWorkflowRef",
    "cloudBuildConfigSha256",
    "cloudBuildId",
    "fullName",
    "marketUpload",
    "profile",
    "repositoryId",
    "sourceSha",
    "state",
    "staticConclusion",
    "staticRunId",
    "staticWorkflowRef",
    "workflowBundleSourceSha",
  ];
  return (
    verified !== null &&
    typeof verified === "object" &&
    canonicalJson(Object.keys(verified).sort()) ===
      canonicalJson([...expectedKeys].sort()) &&
    verified.state === "VERIFIED" &&
    verified.staticConclusion === "success" &&
    verified.buildConclusion === "success" &&
    verified.marketUpload === false &&
    verified.staticWorkflowRef ===
      `seorilabs/.github/${bundle?.reusableWorkflows?.[record.profile]?.path}@${bundle?.source?.sha}` &&
    verified.buildWorkflowRef ===
      `seorilabs/.github/${bundle?.buildWorkflows?.[record.profile]?.path}@${bundle?.source?.sha}` &&
    verified.builderImage ===
      bundle?.delivery?.android?.builderImages?.[record.profile] &&
    verified.cloudBuildConfigSha256 ===
      bundle?.quality?.runtimeAssetDigests?.[
        CLOUD_BUILD_CONFIG_BY_PROFILE[record.profile]
      ] &&
    verified.fullName === canary?.fullName &&
    [
      "artifactSha256",
      "builderImage",
      "buildRunId",
      "cloudBuildConfigSha256",
      "cloudBuildId",
      "profile",
      "repositoryId",
      "sourceSha",
      "staticRunId",
      "workflowBundleSourceSha",
    ].every((key) => verified[key] === record[key])
  );
}

export async function createWorkflowBundle({
  repoRoot = WORKSPACE_ROOT,
  sourceSha,
  platformRelease,
} = {}) {
  if (!SHA_PATTERN.test(sourceSha ?? "")) {
    throw new Error("SOURCE_SHA_INVALID");
  }

  const source = await readYaml(resolve(repoRoot, SOURCE_PATH));
  if (source.bundleVersion !== CURRENT_BUNDLE_VERSION) {
    throw new Error("CANDIDATE_BUNDLE_VERSION_UNSUPPORTED");
  }
  const workflows = Object.fromEntries(
    Object.entries(source.reusableWorkflows).map(([profile, workflow]) => [
      profile,
      { ...workflow, sha: sourceSha },
    ]),
  );
  const buildWorkflows = Object.fromEntries(
    Object.entries(source.buildWorkflows).map(([profile, workflow]) => [
      profile,
      { ...workflow, sha: sourceSha },
    ]),
  );

  const candidate = withIntegrity({
    schemaVersion: source.schemaVersion,
    bundleVersion: source.bundleVersion,
    source: {
      repository: source.repository,
      sha: sourceSha,
    },
    quality: {
      ...source.quality,
      contractDigests: await contractDigests(repoRoot),
      runtimeAssetDigests: await runtimeAssetDigests(repoRoot),
    },
    reusableWorkflows: workflows,
    buildWorkflows,
    actions: source.actions,
    runners: source.runners,
    toolchains: source.toolchains,
    callerPolicies: source.callerPolicies,
    delivery: source.delivery,
    rollout: source.rollout,
    platformGate: source.platformGate,
    platform: normalizePlatformRelease(platformRelease),
    approval: {
      ...source.approval,
      evidence: [],
    },
  });

  const result = await validateWorkflowBundle(candidate, { repoRoot });
  if (!result.ok) {
    throw new Error(`WORKFLOW_BUNDLE_INVALID:${result.diagnostics.join(",")}`);
  }
  return candidate;
}

export async function validateWorkflowBundle(
  bundle,
  {
    repoRoot = WORKSPACE_ROOT,
    trustedApprovalKeys,
    trustedRegistryReadback,
    trustedWorkflowSourceReadback,
    trustedRunnerImageReadback,
  } = {},
) {
  try {
    bundle = structuredClone(bundle);
  } catch {
    return { ok: false, diagnostics: ["BUNDLE_SNAPSHOT_INVALID"] };
  }
  const diagnostics = [];
  let trustedApprovalKeySnapshot;
  try {
    trustedApprovalKeySnapshot = snapshotTrustedApprovalKeys(trustedApprovalKeys);
  } catch {
    trustedApprovalKeySnapshot = Object.freeze({});
    diagnostics.push("APPROVAL_TRUSTED_KEYS_INVALID");
  }
  if (
    bundle?.approval?.state !== "APPROVED" &&
    bundle?.bundleVersion !== CURRENT_BUNDLE_VERSION
  ) {
    diagnostics.push("CANDIDATE_BUNDLE_VERSION_UNSUPPORTED");
  }
  const approvedSourceReadback =
    bundle?.approval?.state === "APPROVED"
      ? await verifyWorkflowSourceReadback(
          bundle,
          trustedWorkflowSourceReadback,
        )
      : undefined;
  if (approvedSourceReadback?.diagnostic) {
    diagnostics.push(approvedSourceReadback.diagnostic);
  }
  let schema;
  try {
    const schemaText = approvedSourceReadback?.snapshot
      ?.workflowBundleSchemaText ??
      (await readFile(resolve(repoRoot, SCHEMA_PATH), "utf8"));
    schema = JSON.parse(schemaText);
  } catch {
    diagnostics.push("SCHEMA_UNREADABLE");
    return { ok: false, diagnostics: [...new Set(diagnostics)].sort() };
  }

  let validate;
  try {
    validate = new Ajv2020({
      allErrors: true,
      messages: false,
      strict: true,
      validateFormats: false,
    }).compile(schema);
  } catch {
    diagnostics.push("SCHEMA_INVALID");
    return { ok: false, diagnostics: [...new Set(diagnostics)].sort() };
  }

  if (!validate(bundle)) {
    diagnostics.push(
      ...(validate.errors ?? []).map(
        (error) =>
          `SCHEMA_${error.keyword.toUpperCase()}:${error.instancePath || "/"}`,
      ),
    );
  }

  const expectedDigest = sha256(canonicalJson(bundlePayload(bundle)));
  if (bundle?.integrity?.payloadDigest !== expectedDigest) {
    diagnostics.push("INTEGRITY_MISMATCH");
  }

  const workflowShas = [
    ...Object.values(bundle?.reusableWorkflows ?? {}),
    ...Object.values(bundle?.buildWorkflows ?? {}),
  ].map((workflow) => workflow.sha);
  if (workflowShas.some((sha) => sha !== bundle?.source?.sha)) {
    diagnostics.push("WORKFLOW_SOURCE_SHA_MISMATCH");
  }
  if (
    Object.entries(bundle?.reusableWorkflows ?? {}).some(
      ([profile, workflow]) => WORKFLOW_BY_PROFILE[profile] !== workflow.path,
    )
  ) {
    diagnostics.push("STATIC_WORKFLOW_DECLARATION_MISMATCH");
  }
  if (
    Object.entries(bundle?.buildWorkflows ?? {}).some(
      ([profile, workflow]) =>
        BUILD_WORKFLOW_BY_PROFILE[profile] !== workflow.path,
    )
  ) {
    diagnostics.push("BUILD_WORKFLOW_DECLARATION_MISMATCH");
  }
  if (
    isWorkflowBundleV4(bundle) &&
    (bundle?.runners?.privateGeneral !== bundle?.runners?.androidSubmit ||
      bundle?.runners?.privateGeneralImage !==
        bundle?.runners?.androidSubmitImage)
  ) {
    diagnostics.push("RUNNER_IMAGE_DECLARATION_MISMATCH");
  }

  if (bundle?.approval?.state !== "APPROVED") {
    try {
      const expectedContractDigests = await contractDigests(repoRoot);
      if (
        canonicalJson(bundle?.quality?.contractDigests ?? {}) !==
        canonicalJson(expectedContractDigests)
      ) {
        diagnostics.push("CONTRACT_DIGEST_MISMATCH");
      }
    } catch {
      diagnostics.push("CONTRACT_ASSET_UNREADABLE");
    }
    try {
      const expectedRuntimeAssetDigests = await runtimeAssetDigests(repoRoot);
      if (
        canonicalJson(bundle?.quality?.runtimeAssetDigests ?? {}) !==
        canonicalJson(expectedRuntimeAssetDigests)
      ) {
        diagnostics.push("RUNTIME_ASSET_DIGEST_MISMATCH");
      }
    } catch {
      diagnostics.push("RUNTIME_ASSET_UNREADABLE");
    }
    try {
      if (!(await runtimeDeclarationsMatch(bundle, repoRoot))) {
        diagnostics.push("RUNTIME_DECLARATION_MISMATCH");
      }
    } catch {
      diagnostics.push("RUNTIME_DECLARATION_UNREADABLE");
    }
  } else if (
    approvedSourceReadback?.snapshot &&
    !sourceRuntimeDeclarationsMatch(bundle, approvedSourceReadback.snapshot)
  ) {
    diagnostics.push("RUNTIME_DECLARATION_MISMATCH");
  }

  if (bundle?.approval?.state === "APPROVED") {
    if (bundle?.platform?.state !== "RESOLVED") {
      diagnostics.push("APPROVED_PLATFORM_UNRESOLVED");
    }
    const profiles = (bundle.approval.evidence ?? [])
      .map(({ profile }) => profile)
      .sort();
    if (
      profiles.length !== 2 ||
      profiles[0] !== "godot" ||
      profiles[1] !== "react-native"
    ) {
      diagnostics.push("APPROVED_CANARY_EVIDENCE_INCOMPLETE");
    }
    if (bundle.approval.registry?.subject !== approvalRegistrySubject(bundle)) {
      diagnostics.push("APPROVAL_REGISTRY_SUBJECT_MISMATCH");
    }

    if (isWorkflowBundleV4(bundle)) {
      if (!runnerImageApprovalMatches(bundle)) {
        diagnostics.push("APPROVAL_RUNNER_IMAGE_MISMATCH");
      }
      const runnerReadback = await verifyRunnerImageReadback(
        bundle,
        trustedRunnerImageReadback,
      );
      if (runnerReadback.diagnostic) {
        diagnostics.push(runnerReadback.diagnostic);
      }
    }

    const signature = bundle.approval.signature;
    const trustedKey = trustedApprovalKey(
      trustedApprovalKeySnapshot,
      signature?.keyId,
    );
    let signatureVerified = false;
    if (!trustedKey) {
      diagnostics.push("APPROVAL_TRUSTED_KEY_REQUIRED");
    } else {
      try {
        signatureVerified = verifyEd25519(
          null,
          Buffer.from(canonicalJson(approvalSigningPayload(bundle))),
          trustedKey,
          Buffer.from(signature.value, "base64url"),
        );
      } catch {
        signatureVerified = false;
      }
      if (!signatureVerified) {
        diagnostics.push("APPROVAL_SIGNATURE_INVALID");
      }
    }

    if (typeof trustedRegistryReadback !== "function") {
      diagnostics.push("APPROVAL_REGISTRY_READBACK_REQUIRED");
    } else if (signatureVerified) {
      try {
        const record = await trustedRegistryReadback({
          registryId: bundle.approval.registry.id,
          subject: bundle.approval.registry.subject,
          bundleDigest: bundle.integrity.payloadDigest,
          sourceSha: bundle.source.sha,
          bundleVersion: bundle.bundleVersion,
        });
        if (!registryRecordMatches(record, bundle)) {
          diagnostics.push("APPROVAL_REGISTRY_READBACK_MISMATCH");
        }
      } catch {
        diagnostics.push("APPROVAL_REGISTRY_READBACK_FAILED");
      }
    }
  }

  return {
    ok: diagnostics.length === 0,
    diagnostics: [...new Set(diagnostics)].sort(),
  };
}

export async function promoteWorkflowBundle(
  bundle,
  evidence,
  {
    repoRoot = WORKSPACE_ROOT,
    evidenceVerifier,
    trustedApprovalSigner,
    trustedApprovalKeys,
    registryPublisher,
    trustedWorkflowSourceReadback,
    trustedRunnerImageReadback,
  } = {},
) {
  try {
    bundle = structuredClone(bundle);
    evidence = structuredClone(evidence);
  } catch {
    throw new Error("BUNDLE_SNAPSHOT_INVALID");
  }
  const trustedApprovalKeySnapshot = snapshotTrustedApprovalKeys(
    trustedApprovalKeys,
  );
  const requiredGates = bundle?.quality?.requiredCanaryGates;
  const canaries = bundle?.quality?.canaries;
  if (
    !Array.isArray(evidence) ||
    !Array.isArray(requiredGates) ||
    evidence.some(
      (record) =>
        !canaryEvidenceValid(
          record,
          requiredGates,
          canaries,
          bundle,
        ),
    )
  ) {
    throw new Error("CANARY_EVIDENCE_INVALID");
  }
  const profiles = evidence.map(({ profile }) => profile).sort();
  if (
    bundle?.approval?.state !== "CANDIDATE" ||
    bundle?.bundleVersion !== CURRENT_BUNDLE_VERSION ||
    bundle?.platform?.state !== "RESOLVED" ||
    profiles.length !== 2 ||
    profiles[0] !== "godot" ||
    profiles[1] !== "react-native"
  ) {
    throw new Error("WORKFLOW_BUNDLE_NOT_PROMOTABLE");
  }
  const candidateValidation = await validateWorkflowBundle(bundle, { repoRoot });
  if (!candidateValidation.ok) {
    throw new Error(
      `WORKFLOW_BUNDLE_INVALID:${candidateValidation.diagnostics.join(",")}`,
    );
  }
  const sourceReadback = await verifyWorkflowSourceReadback(
    bundle,
    trustedWorkflowSourceReadback,
  );
  if (sourceReadback.diagnostic) {
    throw new Error(sourceReadback.diagnostic);
  }
  if (typeof evidenceVerifier !== "function") {
    throw new Error("CANARY_EVIDENCE_VERIFIER_REQUIRED");
  }
  let evidenceResults;
  try {
    evidenceResults = await Promise.all(
      evidence.map(async (record) =>
        structuredClone(
          await evidenceVerifier(
            structuredClone(record),
            structuredClone(bundle),
          ),
        ),
      ),
    );
  } catch {
    throw new Error("CANARY_EVIDENCE_READBACK_FAILED");
  }
  if (
    evidenceResults.some(
      (verified, index) =>
        !canaryEvidenceReadbackMatches(
          verified,
          evidence[index],
          canaries[evidence[index].profile],
          bundle,
        ),
    )
  ) {
    throw new Error("CANARY_EVIDENCE_READBACK_FAILED");
  }

  const runnerReadback = await verifyRunnerImageReadback(
    bundle,
    trustedRunnerImageReadback,
  );
  if (runnerReadback.diagnostic) {
    throw new Error(runnerReadback.diagnostic);
  }

  if (typeof trustedApprovalSigner !== "function") {
    throw new Error("APPROVAL_SIGNER_REQUIRED");
  }
  if (typeof registryPublisher !== "function") {
    throw new Error("APPROVAL_REGISTRY_PUBLISHER_REQUIRED");
  }

  const unsignedApproval = {
    ...bundle.approval,
    state: "APPROVED",
    evidence: evidence.toSorted((left, right) =>
      left.profile.localeCompare(right.profile),
    ),
    registry: {
      id: APPROVAL_REGISTRY_ID,
      subject: approvalRegistrySubject(bundle),
    },
    runnerImage: runnerImageRequest(bundle),
  };
  const unsignedPromoted = {
    ...bundlePayload(bundle),
    approval: unsignedApproval,
  };
  const signingPayload = Buffer.from(canonicalJson(unsignedPromoted));
  let signature;
  let signerPayload;
  try {
    signerPayload = Buffer.from(signingPayload);
    signature = structuredClone(
      await trustedApprovalSigner({
        algorithm: "Ed25519",
        keyPurpose: "workflow-bundle-approval",
        payload: signerPayload,
        payloadDigest: sha256(signingPayload),
        registryId: APPROVAL_REGISTRY_ID,
        subject: unsignedApproval.registry.subject,
      }),
    );
  } catch {
    throw new Error("APPROVAL_SIGNATURE_FAILED");
  } finally {
    if (Buffer.isBuffer(signerPayload)) signerPayload.fill(0);
  }
  if (
    signature === null ||
    typeof signature !== "object" ||
    canonicalJson(Object.keys(signature).sort()) !==
      canonicalJson(["algorithm", "keyId", "value"]) ||
    signature.algorithm !== "Ed25519" ||
    !APPROVAL_KEY_ID_PATTERN.test(signature.keyId ?? "") ||
    !/^[A-Za-z0-9_-]{86}$/u.test(signature.value ?? "")
  ) {
    throw new Error("APPROVAL_SIGNATURE_INVALID");
  }
  const trustedKey = trustedApprovalKey(
    trustedApprovalKeySnapshot,
    signature.keyId,
  );
  if (!trustedKey) {
    throw new Error("APPROVAL_TRUSTED_KEY_REQUIRED");
  }
  let signatureVerified = false;
  try {
    signatureVerified = verifyEd25519(
      null,
      signingPayload,
      trustedKey,
      Buffer.from(signature.value, "base64url"),
    );
  } catch {
    signatureVerified = false;
  }
  if (!signatureVerified) {
    throw new Error("APPROVAL_SIGNATURE_INVALID");
  }
  signingPayload.fill(0);
  const promoted = withIntegrity({
    ...unsignedPromoted,
    approval: {
      ...unsignedApproval,
      signature,
    },
  });
  const registryRecord = {
    registryId: promoted.approval.registry.id,
    subject: promoted.approval.registry.subject,
    bundleDigest: promoted.integrity.payloadDigest,
    sourceSha: promoted.source.sha,
    bundleVersion: promoted.bundleVersion,
    state: "APPROVED",
  };
  const prePublishValidation = await validateWorkflowBundle(promoted, {
    repoRoot,
    trustedApprovalKeys: trustedApprovalKeySnapshot,
    trustedRegistryReadback: async () => structuredClone(registryRecord),
    trustedWorkflowSourceReadback,
    trustedRunnerImageReadback,
  });
  if (!prePublishValidation.ok) {
    throw new Error(
      `WORKFLOW_BUNDLE_INVALID:${prePublishValidation.diagnostics.join(",")}`,
    );
  }
  let publishedRecord;
  try {
    publishedRecord = await registryPublisher(
      structuredClone(registryRecord),
      structuredClone(promoted),
    );
  } catch {
    throw new Error("APPROVAL_REGISTRY_PUBLISH_FAILED");
  }
  if (!registryRecordMatches(publishedRecord, promoted)) {
    throw new Error("APPROVAL_REGISTRY_PUBLISH_FAILED");
  }
  const result = await validateWorkflowBundle(promoted, {
    repoRoot,
    trustedApprovalKeys: trustedApprovalKeySnapshot,
    trustedRegistryReadback: async () => publishedRecord,
    trustedWorkflowSourceReadback,
    trustedRunnerImageReadback,
  });
  if (!result.ok) {
    throw new Error(`WORKFLOW_BUNDLE_INVALID:${result.diagnostics.join(",")}`);
  }
  return promoted;
}

export async function loadApprovedWorkflowBundle(
  bundle,
  {
    repoRoot = WORKSPACE_ROOT,
    trustedApprovalKeys,
    trustedRegistryReadback,
    trustedWorkflowSourceReadback,
    trustedRunnerImageReadback,
  } = {},
) {
  try {
    bundle = structuredClone(bundle);
  } catch {
    throw new Error("BUNDLE_SNAPSHOT_INVALID");
  }
  const trustedApprovalKeySnapshot = snapshotTrustedApprovalKeys(
    trustedApprovalKeys,
  );
  if (bundle?.approval?.state !== "APPROVED") {
    throw new Error("APPROVED_BUNDLE_REQUIRED");
  }
  const sourceReadback = await verifyWorkflowSourceReadback(
    bundle,
    trustedWorkflowSourceReadback,
  );
  if (sourceReadback.diagnostic) {
    throw new Error(sourceReadback.diagnostic);
  }
  const validation = await validateWorkflowBundle(bundle, {
    repoRoot,
    trustedApprovalKeys: trustedApprovalKeySnapshot,
    trustedRegistryReadback,
    trustedWorkflowSourceReadback: async () =>
      structuredClone(sourceReadback.snapshot),
    trustedRunnerImageReadback,
  });
  if (!validation.ok) {
    throw new Error(
      `APPROVED_BUNDLE_UNTRUSTED:${validation.diagnostics.join(",")}`,
    );
  }
  const workflowByProfile = Object.freeze(
    Object.fromEntries(
      Object.entries(bundle.reusableWorkflows).map(([profile, workflow]) => [
        profile,
        Object.freeze({ path: workflow.path, sha: workflow.sha }),
      ]),
    ),
  );
  const buildWorkflowByProfile = Object.freeze(
    Object.fromEntries(
      Object.entries(bundle.buildWorkflows ?? {}).map(([profile, workflow]) => [
        profile,
        Object.freeze({ path: workflow.path, sha: workflow.sha }),
      ]),
    ),
  );
  const binding = Object.freeze({
    bundleDigest: bundle.integrity.payloadDigest,
    sourceSha: bundle.source.sha,
    workflowByProfile,
    buildWorkflowByProfile,
    expiresAt: new Date(Date.now() + APPROVED_BINDING_TTL_MS).toISOString(),
  });
  TRUSTED_BUNDLE_BINDINGS.set(
    binding,
    Object.freeze({
      expiresAtMs: Date.parse(binding.expiresAt),
      bundle,
      workflowByProfile,
      buildWorkflowByProfile,
      trustedRegistryReadback,
      trustedRunnerImageReadback,
      sourceSnapshot: deepFreeze(sourceReadback.snapshot),
    }),
  );
  return binding;
}

function bundleBindingState(binding) {
  if (binding === null || typeof binding !== "object") return undefined;
  return TRUSTED_BUNDLE_BINDINGS.get(binding);
}

async function verifyBundleBinding(binding) {
  const state = bundleBindingState(binding);
  if (!state) return { diagnostic: "APPROVED_BUNDLE_BINDING_REQUIRED" };
  if (Date.now() >= state.expiresAtMs) {
    return { diagnostic: "APPROVED_BUNDLE_BINDING_EXPIRED" };
  }
  try {
    const record = await state.trustedRegistryReadback({
      registryId: state.bundle.approval.registry.id,
      subject: state.bundle.approval.registry.subject,
      bundleDigest: state.bundle.integrity.payloadDigest,
      sourceSha: state.bundle.source.sha,
      bundleVersion: state.bundle.bundleVersion,
    });
    if (!registryRecordMatches(record, state.bundle)) {
      return { diagnostic: "APPROVED_BUNDLE_REGISTRY_REVOKED" };
    }
    if (isWorkflowBundleV4(state.bundle)) {
      const runnerReadback = await verifyRunnerImageReadback(
        state.bundle,
        state.trustedRunnerImageReadback,
      );
      if (runnerReadback.diagnostic) {
        return { diagnostic: runnerReadback.diagnostic };
      }
    }
    if (Date.now() >= state.expiresAtMs) {
      return { diagnostic: "APPROVED_BUNDLE_BINDING_EXPIRED" };
    }
  } catch {
    return { diagnostic: "APPROVED_BUNDLE_REGISTRY_READBACK_FAILED" };
  }
  return { state };
}

export async function resolveApprovedBuildWorkflowBinding(binding, profile) {
  const verification = await verifyBundleBinding(binding);
  if (!verification.state) {
    throw new Error(verification.diagnostic);
  }
  const workflow = verification.state.buildWorkflowByProfile[profile];
  if (
    !workflow ||
    !BUILD_WORKFLOW_BY_PROFILE[profile] ||
    workflow.path !== BUILD_WORKFLOW_BY_PROFILE[profile] ||
    !SHA_PATTERN.test(workflow.sha ?? "")
  ) {
    throw new Error("APPROVED_BUILD_WORKFLOW_BINDING_REQUIRED");
  }
  return Object.freeze({
    bundleDigest: verification.state.bundle.integrity.payloadDigest,
    path: workflow.path,
    sha: workflow.sha,
  });
}

export function createBackofficeResolvedManifestReadback({
  origin,
  fetchImpl = globalThis.fetch,
} = {}) {
  let fixedOrigin;
  try {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("BACKOFFICE_ORIGIN_INVALID");
    }
    fixedOrigin = parsed.origin;
  } catch {
    throw new Error("BACKOFFICE_ORIGIN_INVALID");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("BACKOFFICE_FETCH_REQUIRED");
  }

  return async ({ repositoryId, fullName, sourceSha }) => {
    if (
      !REPOSITORY_ID_PATTERN.test(repositoryId ?? "") ||
      !REPOSITORY_FULL_NAME_PATTERN.test(fullName ?? "") ||
      !SHA_PATTERN.test(sourceSha ?? "")
    ) {
      throw new Error("BACKOFFICE_MANIFEST_REQUEST_INVALID");
    }
    const url = new URL(
      `/control-plane/apps/${encodeURIComponent(repositoryId)}/resolved-manifest`,
      fixedOrigin,
    );
    url.searchParams.set("ref", sourceSha);
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
    });
    if (!response?.ok) {
      throw new Error(
        `BACKOFFICE_MANIFEST_HTTP_${response?.status ?? "UNKNOWN"}`,
      );
    }
    const payload = await response.json();
    const { app, config, source, workflowCaller } = payload ?? {};
    if (
      app?.repoId !== repositoryId ||
      app?.repoFullName !== fullName ||
      source?.sha !== sourceSha ||
      !SOURCE_REF_PATTERN.test(source?.ref ?? "") ||
      source.ref !== FLEET_DEFAULT_REF ||
      !CONFIG_ID_PATTERN.test(source?.observationId ?? "") ||
      source?.payload === null ||
      typeof source?.payload !== "object" ||
      Array.isArray(source.payload) ||
      config?.status !== "ACTIVE" ||
      !CONFIG_ID_PATTERN.test(config?.id ?? "") ||
      !Number.isSafeInteger(config?.revision) ||
      config.revision < 1 ||
      !SNAPSHOT_DIGEST_PATTERN.test(config?.digest ?? "") ||
      config.signature === undefined ||
      config.signature === null ||
      workflowCaller === null ||
      typeof workflowCaller !== "object" ||
      canonicalJson(Object.keys(workflowCaller).sort()) !==
        canonicalJson(["packageManager", "profile", "workingDirectory"]) ||
      !Object.hasOwn(WORKFLOW_BY_PROFILE, workflowCaller.profile) ||
      !["npm", "pnpm"].includes(workflowCaller.packageManager) ||
      !isSafeRelativeDirectory(workflowCaller.workingDirectory)
    ) {
      throw new Error("BACKOFFICE_MANIFEST_RESPONSE_INVALID");
    }
    return {
      state: "ACTIVE",
      repositoryId,
      fullName,
      sourceSha,
      sourceRef: source.ref,
      observationId: source.observationId,
      sourcePayloadDigest: sha256(canonicalJson(source.payload)),
      profile: workflowCaller.profile,
      packageManager: workflowCaller.packageManager,
      workingDirectory: workflowCaller.workingDirectory,
      configId: config.id,
      configRevision: config.revision,
      snapshotDigest: config.digest,
      configSignatureDigest: sha256(canonicalJson(config.signature)),
    };
  };
}

function normalizeCallerManifest(value) {
  let manifest;
  try {
    manifest = structuredClone(value);
  } catch {
    return undefined;
  }
  const expectedKeys = [
    "configId",
    "configRevision",
    "configSignatureDigest",
    "fullName",
    "observationId",
    "packageManager",
    "profile",
    "repositoryId",
    "snapshotDigest",
    "sourcePayloadDigest",
    "sourceRef",
    "sourceSha",
    "state",
    "workingDirectory",
  ];
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    canonicalJson(Object.keys(manifest).sort()) !== canonicalJson(expectedKeys) ||
    manifest.state !== "ACTIVE" ||
    !REPOSITORY_ID_PATTERN.test(manifest.repositoryId ?? "") ||
    !REPOSITORY_FULL_NAME_PATTERN.test(manifest.fullName ?? "") ||
    !SHA_PATTERN.test(manifest.sourceSha ?? "") ||
    !SOURCE_REF_PATTERN.test(manifest.sourceRef ?? "") ||
    !CONFIG_ID_PATTERN.test(manifest.observationId ?? "") ||
    !SHA256_PATTERN.test(manifest.sourcePayloadDigest ?? "") ||
    !Object.hasOwn(WORKFLOW_BY_PROFILE, manifest.profile) ||
    !["npm", "pnpm"].includes(manifest.packageManager) ||
    !isSafeRelativeDirectory(manifest.workingDirectory) ||
    !CONFIG_ID_PATTERN.test(manifest.configId ?? "") ||
    !Number.isSafeInteger(manifest.configRevision) ||
    manifest.configRevision < 1 ||
    !SNAPSHOT_DIGEST_PATTERN.test(manifest.snapshotDigest ?? "") ||
    !SHA256_PATTERN.test(manifest.configSignatureDigest ?? "")
  ) {
    return undefined;
  }
  return Object.freeze(manifest);
}

function repositoryContextMatches(context, manifest) {
  return (
    context !== null &&
    typeof context === "object" &&
    REPOSITORY_ID_PATTERN.test(context.repositoryId ?? "") &&
    context.repositoryId === manifest.repositoryId &&
    context.fullName === manifest.fullName &&
    context.sourceSha === manifest.sourceSha
  );
}

export async function loadResolvedCallerBinding(
  repositoryContext,
  { trustedResolvedManifestReadback } = {},
) {
  if (
    typeof trustedResolvedManifestReadback !== "function" ||
    repositoryContext === null ||
    typeof repositoryContext !== "object" ||
    !REPOSITORY_ID_PATTERN.test(repositoryContext.repositoryId ?? "") ||
    !REPOSITORY_FULL_NAME_PATTERN.test(repositoryContext.fullName ?? "") ||
    !SHA_PATTERN.test(repositoryContext.sourceSha ?? "")
  ) {
    throw new Error("CALLER_MANIFEST_READBACK_REQUIRED");
  }
  let manifest;
  try {
    manifest = normalizeCallerManifest(
      await trustedResolvedManifestReadback({
        repositoryId: repositoryContext.repositoryId,
        fullName: repositoryContext.fullName,
        sourceSha: repositoryContext.sourceSha,
      }),
    );
  } catch {
    throw new Error("CALLER_MANIFEST_READBACK_FAILED");
  }
  if (!manifest || !repositoryContextMatches(repositoryContext, manifest)) {
    throw new Error("CALLER_MANIFEST_MISMATCH");
  }
  const expiresAtMs = Date.now() + APPROVED_BINDING_TTL_MS;
  const binding = Object.freeze({
    repositoryId: manifest.repositoryId,
    fullName: manifest.fullName,
    sourceSha: manifest.sourceSha,
    sourceRef: manifest.sourceRef,
    observationId: manifest.observationId,
    sourcePayloadDigest: manifest.sourcePayloadDigest,
    configId: manifest.configId,
    configRevision: manifest.configRevision,
    snapshotDigest: manifest.snapshotDigest,
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
  TRUSTED_CALLER_BINDINGS.set(
    binding,
    Object.freeze({
      expiresAtMs,
      manifest,
      trustedResolvedManifestReadback,
    }),
  );
  return binding;
}

async function verifyCallerBinding(binding, repositoryContext) {
  const state =
    binding !== null && typeof binding === "object"
      ? TRUSTED_CALLER_BINDINGS.get(binding)
      : undefined;
  if (!state) return { diagnostic: "CALLER_BINDING_REQUIRED" };
  if (Date.now() >= state.expiresAtMs) {
    return { diagnostic: "CALLER_BINDING_EXPIRED" };
  }
  if (!repositoryContextMatches(repositoryContext, state.manifest)) {
    return { diagnostic: "CALLER_REPOSITORY_CONTEXT_MISMATCH" };
  }
  try {
    const observed = normalizeCallerManifest(
      await state.trustedResolvedManifestReadback({
        repositoryId: state.manifest.repositoryId,
        fullName: state.manifest.fullName,
        sourceSha: state.manifest.sourceSha,
      }),
    );
    if (!observed) {
      return { diagnostic: "CALLER_MANIFEST_REVOKED" };
    }
    if (canonicalJson(observed) !== canonicalJson(state.manifest)) {
      return { diagnostic: "CALLER_MANIFEST_CHANGED" };
    }
    if (Date.now() >= state.expiresAtMs) {
      return { diagnostic: "CALLER_BINDING_EXPIRED" };
    }
  } catch {
    return { diagnostic: "CALLER_MANIFEST_READBACK_FAILED" };
  }
  return { state };
}

function parseCaller(text) {
  let document;
  try {
    document = parseDocument(text, {
      maxAliasCount: 10,
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
  } catch {
    return { diagnostic: "CALLER_YAML_INVALID" };
  }
  if (document.errors.length > 0) {
    return { diagnostic: "CALLER_YAML_INVALID" };
  }
  return { value: document.toJS({ maxAliasCount: 10 }) };
}

function containsSecretInheritance(value) {
  if (value === "inherit") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(containsSecretInheritance);
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([key, nested]) =>
        (key.toLowerCase() === "secrets" && nested === "inherit") ||
        containsSecretInheritance(nested),
    );
  }
  return false;
}

export async function validateOrgContractCaller(
  text,
  { approvedBundleBinding, callerBinding, repositoryContext } = {},
) {
  const parsed = parseCaller(text);
  if (parsed.diagnostic) {
    return { ok: false, diagnostics: [parsed.diagnostic] };
  }
  const caller = parsed.value;
  const diagnostics = [];
  const bindingVerification = await verifyBundleBinding(approvedBundleBinding);
  const trustedBinding = bindingVerification.state;
  if (!trustedBinding) diagnostics.push(bindingVerification.diagnostic);
  const callerBindingVerification = await verifyCallerBinding(
    callerBinding,
    repositoryContext,
  );
  const trustedCallerBinding = callerBindingVerification.state;
  if (!trustedCallerBinding) {
    diagnostics.push(callerBindingVerification.diagnostic);
  }

  const allowedTopLevel = new Set([
    "name",
    "on",
    "permissions",
    "concurrency",
    "jobs",
  ]);
  if (
    caller === null ||
    typeof caller !== "object" ||
    Object.keys(caller).some((key) => !allowedTopLevel.has(key))
  ) {
    diagnostics.push("CALLER_TOP_LEVEL_INVALID");
  }
  if (caller?.name !== "Org Contract") {
    diagnostics.push("CALLER_NAME_INVALID");
  }

  const eventNames = Object.keys(caller?.on ?? {}).sort();
  if (
    JSON.stringify(eventNames) !==
      JSON.stringify(["pull_request", "push", "workflow_dispatch"])
  ) {
    diagnostics.push("CALLER_EVENTS_INVALID");
  }
  if (
    canonicalJson(caller?.on ?? {}) !==
    canonicalJson({
      pull_request: {},
      push: { branches: ["main"] },
      workflow_dispatch: {},
    })
  ) {
    diagnostics.push("CALLER_TRIGGER_POLICY_INVALID");
  }

  if (containsSecretInheritance(caller)) {
    diagnostics.push("SECRET_INHERITANCE_FORBIDDEN");
  }

  const permissionEntries = Object.entries(caller?.permissions ?? {}).sort();
  const expectedPermissions = [
    ["contents", "read"],
    ["packages", "read"],
  ];
  if (JSON.stringify(permissionEntries) !== JSON.stringify(expectedPermissions)) {
    diagnostics.push("CALLER_PERMISSIONS_INVALID");
  }

  if (
    caller?.concurrency?.["cancel-in-progress"] !== true ||
    caller?.concurrency?.group !==
      "org-contract-${{ github.repository_id }}-${{ github.ref }}"
  ) {
    diagnostics.push("CALLER_CONCURRENCY_INVALID");
  }

  const jobs = Object.entries(caller?.jobs ?? {});
  if (jobs.length !== 1 || jobs[0]?.[0] !== "org-contract") {
    diagnostics.push("CALLER_JOB_SET_INVALID");
  }
  const job = caller?.jobs?.["org-contract"];
  if (!job || job.name !== "Org Contract") {
    diagnostics.push("REQUIRED_CHECK_NAME_INVALID");
  }
  if (job && (job["runs-on"] !== undefined || job.steps !== undefined)) {
    diagnostics.push("THIN_CALLER_REQUIRED");
  }
  if (
    job &&
    Object.keys(job).some((key) => !["name", "uses", "with"].includes(key))
  ) {
    diagnostics.push("CALLER_JOB_POLICY_INVALID");
  }
  if (job?.secrets !== undefined) {
    diagnostics.push("STATIC_CALLER_SECRETS_FORBIDDEN");
  }

  const usesPattern =
    /^seorilabs\/\.github\/(\.github\/workflows\/[a-z0-9-]+\.yml)@([0-9a-f]{40})$/u;
  const usesMatch = usesPattern.exec(job?.uses ?? "");
  if (!usesMatch) {
    diagnostics.push("REUSABLE_WORKFLOW_FULL_SHA_REQUIRED");
  }

  const withInputs = job?.with ?? {};
  const unexpectedInputs = Object.keys(withInputs).filter(
    (key) => !["package_manager", "working_directory"].includes(key),
  );
  if (unexpectedInputs.length > 0) {
    diagnostics.push("CALLER_INPUT_NOT_ALLOWED");
  }
  if (!isSafeRelativeDirectory(withInputs.working_directory ?? ".")) {
    diagnostics.push("WORKING_DIRECTORY_INVALID");
  }
  if (!["npm", "pnpm"].includes(withInputs.package_manager ?? "pnpm")) {
    diagnostics.push("PACKAGE_MANAGER_INVALID");
  }

  const profile = usesMatch ? PROFILE_BY_WORKFLOW[usesMatch[1]] : undefined;
  const expectedCaller = trustedCallerBinding?.manifest;
  const approvedWorkflow =
    trustedBinding && expectedCaller
      ? trustedBinding.workflowByProfile[expectedCaller.profile]
      : undefined;
  if (
    usesMatch &&
    (!approvedWorkflow ||
      profile !== expectedCaller?.profile ||
      usesMatch[1] !== approvedWorkflow.path ||
      usesMatch[2] !== approvedWorkflow.sha)
  ) {
    diagnostics.push("CALLER_APPROVED_WORKFLOW_MISMATCH");
  }
  if (
    expectedCaller &&
    (withInputs.package_manager !== expectedCaller.packageManager ||
      withInputs.working_directory !== expectedCaller.workingDirectory)
  ) {
    diagnostics.push("CALLER_RESOLVED_INPUT_MISMATCH");
  }
  return {
    ok: diagnostics.length === 0,
    diagnostics: [...new Set(diagnostics)].sort(),
    profile,
    workflowSha: approvedWorkflow?.sha,
  };
}

export async function generateOrgContractCaller(options = {}) {
  const allowedKeys = ["approvedBundleBinding", "callerBinding"];
  if (
    options === null ||
    typeof options !== "object" ||
    Object.keys(options).some((key) => !allowedKeys.includes(key))
  ) {
    throw new Error("CALLER_GENERATION_INPUT_FORBIDDEN");
  }
  const { approvedBundleBinding, callerBinding } = options;
  const bundleVerification = await verifyBundleBinding(approvedBundleBinding);
  if (!bundleVerification.state) {
    throw new Error(bundleVerification.diagnostic);
  }
  const callerState =
    callerBinding !== null && typeof callerBinding === "object"
      ? TRUSTED_CALLER_BINDINGS.get(callerBinding)
      : undefined;
  if (!callerState) {
    throw new Error("CALLER_BINDING_REQUIRED");
  }
  const repositoryContext = {
    repositoryId: callerState.manifest.repositoryId,
    fullName: callerState.manifest.fullName,
    sourceSha: callerState.manifest.sourceSha,
  };
  const callerVerification = await verifyCallerBinding(
    callerBinding,
    repositoryContext,
  );
  if (!callerVerification.state) {
    throw new Error(callerVerification.diagnostic);
  }
  const { profile, packageManager, workingDirectory } =
    callerVerification.state.manifest;
  const approvedWorkflow =
    bundleVerification.state.workflowByProfile[profile];
  if (
    !approvedWorkflow ||
    approvedWorkflow.path !== WORKFLOW_BY_PROFILE[profile] ||
    !SHA_PATTERN.test(approvedWorkflow.sha)
  ) {
    throw new Error("APPROVED_WORKFLOW_MISSING");
  }

  const caller = {
    name: "Org Contract",
    on: {
      pull_request: {},
      push: { branches: ["main"] },
      workflow_dispatch: {},
    },
    permissions: {
      contents: "read",
      packages: "read",
    },
    concurrency: {
      group:
        "org-contract-${{ github.repository_id }}-${{ github.ref }}",
      "cancel-in-progress": true,
    },
    jobs: {
      "org-contract": {
        name: "Org Contract",
        uses: `seorilabs/.github/${approvedWorkflow.path}@${approvedWorkflow.sha}`,
        with: {
          package_manager: packageManager,
          working_directory: workingDirectory,
        },
      },
    },
  };
  const rendered = [
    "# 중앙 generator가 관리합니다. 수동 편집하지 마십시오.",
    stringify(caller, { lineWidth: 0 }).trimEnd(),
    "",
  ].join("\n");
  const validation = await validateOrgContractCaller(rendered, {
    approvedBundleBinding,
    callerBinding,
    repositoryContext,
  });
  if (!validation.ok) {
    throw new Error(`GENERATED_CALLER_INVALID:${validation.diagnostics.join(",")}`);
  }
  return rendered;
}

const ANDROID_DISPATCH = Object.freeze({ workflow_dispatch: {} });

export async function validateAndroidBuildCaller(
  text,
  { approvedBundleBinding, callerBinding, repositoryContext } = {},
) {
  const parsed = parseCaller(text);
  if (parsed.diagnostic) {
    return { ok: false, diagnostics: [parsed.diagnostic] };
  }
  const caller = parsed.value;
  const diagnostics = [];
  const bundleVerification = await verifyBundleBinding(approvedBundleBinding);
  const trustedBundle = bundleVerification.state;
  if (!trustedBundle) diagnostics.push(bundleVerification.diagnostic);
  const callerVerification = await verifyCallerBinding(
    callerBinding,
    repositoryContext,
  );
  const trustedCaller = callerVerification.state;
  if (!trustedCaller) diagnostics.push(callerVerification.diagnostic);

  const allowedTopLevel = new Set([
    "name",
    "on",
    "permissions",
    "concurrency",
    "jobs",
  ]);
  if (
    caller === null ||
    typeof caller !== "object" ||
    Object.keys(caller).some((key) => !allowedTopLevel.has(key))
  ) {
    diagnostics.push("ANDROID_CALLER_TOP_LEVEL_INVALID");
  }
  if (caller?.name !== "Android Build-only") {
    diagnostics.push("ANDROID_CALLER_NAME_INVALID");
  }
  if (canonicalJson(caller?.on ?? {}) !== canonicalJson(ANDROID_DISPATCH)) {
    diagnostics.push("ANDROID_CALLER_TRIGGER_INVALID");
  }
  if (containsSecretInheritance(caller)) {
    diagnostics.push("SECRET_INHERITANCE_FORBIDDEN");
  }
  const expectedCaller = trustedCaller?.manifest;
  const expectedPermissions =
    trustedBundle?.bundle?.callerPolicies?.androidBuild?.permissions?.[
      expectedCaller?.profile
    ];
  if (
    canonicalJson(caller?.permissions ?? {}) !==
    canonicalJson(expectedPermissions)
  ) {
    diagnostics.push("ANDROID_CALLER_PERMISSIONS_INVALID");
  }
  const expectedConcurrency = expectedCaller
    ? `android-build-\${{ github.repository_id }}-${expectedCaller.sourceSha}`
    : undefined;
  if (
    caller?.concurrency?.group !== expectedConcurrency ||
    caller?.concurrency?.["cancel-in-progress"] !== false
  ) {
    diagnostics.push("ANDROID_CALLER_CONCURRENCY_INVALID");
  }

  const jobs = Object.entries(caller?.jobs ?? {});
  if (jobs.length !== 1 || jobs[0]?.[0] !== "android-build") {
    diagnostics.push("ANDROID_CALLER_JOB_SET_INVALID");
  }
  const job = caller?.jobs?.["android-build"];
  if (!job || job.name !== "Android Build-only") {
    diagnostics.push("ANDROID_BUILD_CHECK_NAME_INVALID");
  }
  if (
    job &&
    (job["runs-on"] !== undefined ||
      job.steps !== undefined ||
      Object.keys(job).some((key) => !["name", "uses", "with"].includes(key)))
  ) {
    diagnostics.push("ANDROID_THIN_CALLER_REQUIRED");
  }
  if (job?.secrets !== undefined) {
    diagnostics.push("ANDROID_CALLER_SECRETS_FORBIDDEN");
  }

  const usesMatch =
    /^seorilabs\/\.github\/(\.github\/workflows\/[a-z0-9-]+\.yml)@([0-9a-f]{40})$/u.exec(
      job?.uses ?? "",
    );
  if (!usesMatch) {
    diagnostics.push("REUSABLE_WORKFLOW_FULL_SHA_REQUIRED");
  }
  const withInputs = job?.with ?? {};
  if (
    canonicalJson(Object.keys(withInputs).sort()) !==
      canonicalJson(["source_sha", "working_directory"])
  ) {
    diagnostics.push("ANDROID_CALLER_INPUT_INVALID");
  }
  if (withInputs.source_sha !== expectedCaller?.sourceSha) {
    diagnostics.push("ANDROID_SOURCE_SHA_BINDING_MISMATCH");
  }
  if (!isSafeRelativeDirectory(withInputs.working_directory)) {
    diagnostics.push("WORKING_DIRECTORY_INVALID");
  }

  const profile = usesMatch
    ? BUILD_PROFILE_BY_WORKFLOW[usesMatch[1]]
    : undefined;
  const approvedWorkflow =
    trustedBundle && expectedCaller
      ? trustedBundle.buildWorkflowByProfile[expectedCaller.profile]
      : undefined;
  if (
    usesMatch &&
    (!approvedWorkflow ||
      profile !== expectedCaller?.profile ||
      usesMatch[1] !== approvedWorkflow.path ||
      usesMatch[2] !== approvedWorkflow.sha)
  ) {
    diagnostics.push("ANDROID_APPROVED_WORKFLOW_MISMATCH");
  }
  if (
    expectedCaller &&
    withInputs.working_directory !== expectedCaller.workingDirectory
  ) {
    diagnostics.push("ANDROID_RESOLVED_INPUT_MISMATCH");
  }
  if (
    trustedBundle?.bundle?.rollout?.mode !== "SHADOW" ||
    trustedBundle?.bundle?.rollout?.ruleset !== "EVALUATE"
  ) {
    diagnostics.push("ANDROID_SHADOW_ROLLOUT_REQUIRED");
  }
  return {
    ok: diagnostics.length === 0,
    diagnostics: [...new Set(diagnostics)].sort(),
    profile,
    enforcement: "SHADOW",
    blocking: false,
  };
}

export async function generateAndroidBuildCaller(options = {}) {
  const allowedKeys = ["approvedBundleBinding", "callerBinding"];
  if (
    options === null ||
    typeof options !== "object" ||
    Object.keys(options).some((key) => !allowedKeys.includes(key))
  ) {
    throw new Error("ANDROID_CALLER_GENERATION_INPUT_FORBIDDEN");
  }
  const bundleVerification = await verifyBundleBinding(
    options.approvedBundleBinding,
  );
  if (!bundleVerification.state) {
    throw new Error(bundleVerification.diagnostic);
  }
  const callerState =
    options.callerBinding !== null && typeof options.callerBinding === "object"
      ? TRUSTED_CALLER_BINDINGS.get(options.callerBinding)
      : undefined;
  if (!callerState) throw new Error("CALLER_BINDING_REQUIRED");
  const repositoryContext = {
    repositoryId: callerState.manifest.repositoryId,
    fullName: callerState.manifest.fullName,
    sourceSha: callerState.manifest.sourceSha,
  };
  const callerVerification = await verifyCallerBinding(
    options.callerBinding,
    repositoryContext,
  );
  if (!callerVerification.state) throw new Error(callerVerification.diagnostic);
  const { profile, sourceSha, workingDirectory } = callerVerification.state.manifest;
  const approvedWorkflow =
    bundleVerification.state.buildWorkflowByProfile[profile];
  if (
    !approvedWorkflow ||
    approvedWorkflow.path !== BUILD_WORKFLOW_BY_PROFILE[profile] ||
    !SHA_PATTERN.test(approvedWorkflow.sha)
  ) {
    throw new Error("APPROVED_ANDROID_WORKFLOW_MISSING");
  }
  const approvedPermissions =
    bundleVerification.state.bundle.callerPolicies?.androidBuild?.permissions?.[
      profile
    ];
  if (!isObjectRecord(approvedPermissions)) {
    throw new Error("APPROVED_ANDROID_PERMISSIONS_MISSING");
  }

  const caller = {
    name: "Android Build-only",
    on: ANDROID_DISPATCH,
    permissions: approvedPermissions,
    concurrency: {
      group: `android-build-\${{ github.repository_id }}-${sourceSha}`,
      "cancel-in-progress": false,
    },
    jobs: {
      "android-build": {
        name: "Android Build-only",
        uses: `seorilabs/.github/${approvedWorkflow.path}@${approvedWorkflow.sha}`,
        with: {
          source_sha: sourceSha,
          working_directory: workingDirectory,
        },
      },
    },
  };
  const rendered = [
    "# WorkflowBundle shadow generator가 관리합니다. 수동 편집하지 마십시오.",
    stringify(caller, { lineWidth: 0 }).trimEnd(),
    "",
  ].join("\n");
  const validation = await validateAndroidBuildCaller(rendered, {
    approvedBundleBinding: options.approvedBundleBinding,
    callerBinding: options.callerBinding,
    repositoryContext,
  });
  if (!validation.ok) {
    throw new Error(
      `GENERATED_ANDROID_CALLER_INVALID:${validation.diagnostics.join(",")}`,
    );
  }
  return rendered;
}

async function readXcodeCloudTarget(manifest, trustedXcodeCloudTargetReadback) {
  if (!manifest || typeof trustedXcodeCloudTargetReadback !== "function") {
    return { diagnostic: "XCODE_TARGET_READBACK_REQUIRED" };
  }
  const request = {
    repositoryId: manifest.repositoryId,
    fullName: manifest.fullName,
    sourceSha: manifest.sourceSha,
    profile: manifest.profile,
  };
  try {
    const target = structuredClone(
      await trustedXcodeCloudTargetReadback(structuredClone(request)),
    );
    const expectedKeys = [
      "bindingObservationId",
      "distribution",
      "fullName",
      "productId",
      "profile",
      "repositoryId",
      "sourceSha",
      "sourceReferenceCommitSha",
      "sourceReferenceId",
      "sourceReferenceImmutable",
      "sourceReferenceKind",
      "sourceReferenceName",
      "state",
      "workflowId",
    ];
    if (
      target === null ||
      typeof target !== "object" ||
      canonicalJson(Object.keys(target).sort()) !==
        canonicalJson([...expectedKeys].sort()) ||
      target.state !== "ACTIVE" ||
      target.distribution !== "BUILD_ONLY" ||
      target.repositoryId !== request.repositoryId ||
      target.fullName !== request.fullName ||
      target.sourceSha !== request.sourceSha ||
      target.profile !== request.profile ||
      target.sourceReferenceCommitSha !== request.sourceSha ||
      target.sourceReferenceKind !== "TAG" ||
      target.sourceReferenceImmutable !== true ||
      !CONFIG_ID_PATTERN.test(target.bindingObservationId ?? "") ||
      !XCODE_ID_PATTERN.test(target.productId ?? "") ||
      !XCODE_ID_PATTERN.test(target.workflowId ?? "") ||
      !XCODE_ID_PATTERN.test(target.sourceReferenceId ?? "") ||
      !XCODE_SOURCE_REFERENCE_NAME_PATTERN.test(
        target.sourceReferenceName ?? "",
      )
    ) {
      return { diagnostic: "XCODE_TARGET_READBACK_MISMATCH" };
    }
    return { target: deepFreeze(target) };
  } catch {
    return { diagnostic: "XCODE_TARGET_READBACK_FAILED" };
  }
}

function xcodeCloudCreateRequest(workflowId, sourceReferenceId) {
  return {
    method: "POST",
    path: "/v1/ciBuildRuns",
    body: {
      data: {
        type: "ciBuildRuns",
        attributes: { clean: true },
        relationships: {
          workflow: {
            data: { type: "ciWorkflows", id: workflowId },
          },
          sourceBranchOrTag: {
            data: { type: "scmGitReferences", id: sourceReferenceId },
          },
        },
      },
    },
  };
}

function xcodeCloudRequiredReadback(sourceSha) {
  return {
    action: "ciBuildRuns.get",
    fields: [
      "id",
      "sourceCommit.commitSha",
      "workflow.id",
      "sourceBranchOrTag.id",
    ],
    expectedSourceCommitSha: sourceSha,
  };
}

export async function validateXcodeCloudRunContract(
  contract,
  {
    approvedBundleBinding,
    callerBinding,
    repositoryContext,
    trustedXcodeCloudTargetReadback,
  } = {},
) {
  const diagnostics = [];
  let snapshot;
  let schemaText;
  try {
    snapshot = structuredClone(contract);
  } catch {
    return { ok: false, diagnostics: ["XCODE_CONTRACT_SNAPSHOT_INVALID"] };
  }
  const bundleVerification = await verifyBundleBinding(approvedBundleBinding);
  const trustedBundle = bundleVerification.state;
  if (!trustedBundle) diagnostics.push(bundleVerification.diagnostic);
  try {
    schemaText =
      trustedBundle?.sourceSnapshot?.contractAssetContents?.[XCODE_SCHEMA_PATH];
    if (typeof schemaText !== "string") {
      throw new Error("XCODE_SIGNED_SCHEMA_REQUIRED");
    }
    const schema = JSON.parse(schemaText);
    const validate = new Ajv2020({
      allErrors: true,
      messages: false,
      strict: true,
      validateFormats: false,
    }).compile(schema);
    if (!validate(snapshot)) {
      diagnostics.push(
        ...(validate.errors ?? []).map(
          (error) =>
            `XCODE_SCHEMA_${error.keyword.toUpperCase()}:${error.instancePath || "/"}`,
        ),
      );
    }
  } catch {
    if (trustedBundle) diagnostics.push("XCODE_SIGNED_SCHEMA_UNREADABLE");
  }
  if (
    trustedBundle &&
    typeof schemaText === "string" &&
    sha256(Buffer.from(schemaText, "utf8")) !==
      trustedBundle.bundle.quality.contractDigests[
        "contracts/xcode-cloud-run.schema.json"
      ]
  ) {
    diagnostics.push("XCODE_SIGNED_SCHEMA_MISMATCH");
  }
  const callerVerification = await verifyCallerBinding(
    callerBinding,
    repositoryContext,
  );
  const trustedCaller = callerVerification.state;
  if (!trustedCaller) diagnostics.push(callerVerification.diagnostic);
  const expected = trustedCaller?.manifest;
  const targetReadback = await readXcodeCloudTarget(
    expected,
    trustedXcodeCloudTargetReadback,
  );
  if (targetReadback.diagnostic) diagnostics.push(targetReadback.diagnostic);
  const expectedTarget = targetReadback.target;
  const expectedScripts =
    expected &&
    trustedBundle?.bundle?.delivery?.ios?.requiredScripts?.[expected.profile];
  if (trustedBundle && !expectedScripts) {
    diagnostics.push("XCODE_BUNDLE_POLICY_MISSING");
  }
  if (
    expected &&
    (snapshot?.repository?.id !== expected.repositoryId ||
      snapshot?.repository?.fullName !== expected.fullName ||
      snapshot?.sourceSha !== expected.sourceSha ||
      snapshot?.profile !== expected.profile)
  ) {
    diagnostics.push("XCODE_CALLER_BINDING_MISMATCH");
  }
  if (
    trustedBundle &&
    (snapshot?.workflowBundle?.sourceSha !== trustedBundle.bundle.source.sha ||
      snapshot?.workflowBundle?.digest !==
        trustedBundle.bundle.integrity.payloadDigest)
  ) {
    diagnostics.push("XCODE_BUNDLE_BINDING_MISMATCH");
  }
  if (
    expectedScripts &&
    canonicalJson(snapshot?.requiredScripts) !== canonicalJson(expectedScripts)
  ) {
    diagnostics.push("XCODE_REQUIRED_SCRIPTS_MISMATCH");
  }
  if (
    expectedTarget &&
    (snapshot?.provider?.productId !== expectedTarget.productId ||
      snapshot?.provider?.workflowId !== expectedTarget.workflowId ||
      snapshot?.provider?.bindingObservationId !==
        expectedTarget.bindingObservationId ||
      snapshot?.provider?.distribution !== expectedTarget.distribution ||
      canonicalJson(snapshot?.provider?.sourceReference) !==
        canonicalJson({
          id: expectedTarget.sourceReferenceId,
          name: expectedTarget.sourceReferenceName,
          kind: expectedTarget.sourceReferenceKind,
          commitSha: expectedTarget.sourceReferenceCommitSha,
          immutable: expectedTarget.sourceReferenceImmutable,
        }) ||
      canonicalJson(snapshot?.provider?.createRequest) !==
        canonicalJson(
          xcodeCloudCreateRequest(
            expectedTarget.workflowId,
            expectedTarget.sourceReferenceId,
          ),
        ) ||
      canonicalJson(snapshot?.provider?.requiredReadback) !==
        canonicalJson(xcodeCloudRequiredReadback(expected.sourceSha)))
  ) {
    diagnostics.push("XCODE_TARGET_BINDING_MISMATCH");
  }
  if (
    snapshot?.marketUpload !== false ||
    snapshot?.githubRunner !== null ||
    snapshot?.provider?.action !== "ciBuildRuns.create"
  ) {
    diagnostics.push("XCODE_BUILD_ONLY_POLICY_MISMATCH");
  }
  if (
    trustedBundle?.bundle?.rollout?.mode !== "SHADOW" ||
    trustedBundle?.bundle?.rollout?.ruleset !== "EVALUATE"
  ) {
    diagnostics.push("XCODE_SHADOW_ROLLOUT_REQUIRED");
  }
  const ok = diagnostics.length === 0;
  return {
    ok,
    diagnostics: [...new Set(diagnostics)].sort(),
    enforcement: "SHADOW",
    blocking: false,
    contract: ok ? deepFreeze(snapshot) : undefined,
  };
}

export async function generateXcodeCloudRunContract(
  options = {},
  { trustedXcodeCloudTargetReadback } = {},
) {
  const allowedKeys = [
    "approvedBundleBinding",
    "callerBinding",
    "idempotencyKey",
    "runId",
  ];
  if (
    options === null ||
    typeof options !== "object" ||
    Object.keys(options).some((key) => !allowedKeys.includes(key)) ||
    !XCODE_ID_PATTERN.test(options.runId ?? "") ||
    !IDEMPOTENCY_KEY_PATTERN.test(options.idempotencyKey ?? "")
  ) {
    throw new Error("XCODE_CONTRACT_GENERATION_INPUT_INVALID");
  }
  const bundleVerification = await verifyBundleBinding(
    options.approvedBundleBinding,
  );
  if (!bundleVerification.state) throw new Error(bundleVerification.diagnostic);
  const callerState =
    options.callerBinding !== null && typeof options.callerBinding === "object"
      ? TRUSTED_CALLER_BINDINGS.get(options.callerBinding)
      : undefined;
  if (!callerState) throw new Error("CALLER_BINDING_REQUIRED");
  const repositoryContext = {
    repositoryId: callerState.manifest.repositoryId,
    fullName: callerState.manifest.fullName,
    sourceSha: callerState.manifest.sourceSha,
  };
  const callerVerification = await verifyCallerBinding(
    options.callerBinding,
    repositoryContext,
  );
  if (!callerVerification.state) throw new Error(callerVerification.diagnostic);
  const manifest = callerVerification.state.manifest;
  const bundle = bundleVerification.state.bundle;
  const targetReadback = await readXcodeCloudTarget(
    manifest,
    trustedXcodeCloudTargetReadback,
  );
  if (!targetReadback.target) throw new Error(targetReadback.diagnostic);
  const target = targetReadback.target;
  const requiredScripts = bundle?.delivery?.ios?.requiredScripts?.[manifest.profile];
  if (
    !requiredScripts ||
    bundle?.rollout?.mode !== "SHADOW" ||
    bundle?.rollout?.ruleset !== "EVALUATE"
  ) {
    throw new Error("XCODE_BUNDLE_POLICY_MISSING");
  }
  const contract = {
    schemaVersion: 1,
    kind: "XCODE_CLOUD_BUILD_ONLY",
    repository: {
      id: manifest.repositoryId,
      fullName: manifest.fullName,
    },
    sourceSha: manifest.sourceSha,
    workflowBundle: {
      sourceSha: bundle.source.sha,
      digest: bundle.integrity.payloadDigest,
    },
    profile: manifest.profile,
    provider: {
      action: "ciBuildRuns.create",
      productId: target.productId,
      workflowId: target.workflowId,
      bindingObservationId: target.bindingObservationId,
      distribution: target.distribution,
      sourceReference: {
        id: target.sourceReferenceId,
        name: target.sourceReferenceName,
        kind: target.sourceReferenceKind,
        commitSha: target.sourceReferenceCommitSha,
        immutable: target.sourceReferenceImmutable,
      },
      createRequest: xcodeCloudCreateRequest(
        target.workflowId,
        target.sourceReferenceId,
      ),
      requiredReadback: xcodeCloudRequiredReadback(manifest.sourceSha),
    },
    requiredScripts,
    marketUpload: false,
    githubRunner: null,
    runId: options.runId,
    idempotencyKey: options.idempotencyKey,
  };
  const validation = await validateXcodeCloudRunContract(contract, {
    approvedBundleBinding: options.approvedBundleBinding,
    callerBinding: options.callerBinding,
    repositoryContext,
    trustedXcodeCloudTargetReadback,
  });
  if (!validation.ok) {
    throw new Error(`GENERATED_XCODE_CONTRACT_INVALID:${validation.diagnostics.join(",")}`);
  }
  return validation.contract;
}

export async function verifyXcodeCloudRunReadback(
  contract,
  providerRunId,
  {
    approvedBundleBinding,
    callerBinding,
    repositoryContext,
    trustedXcodeCloudTargetReadback,
    trustedXcodeCloudRunReadback,
    now = () => Date.now(),
  } = {},
) {
  const contractValidation = await validateXcodeCloudRunContract(contract, {
    approvedBundleBinding,
    callerBinding,
    repositoryContext,
    trustedXcodeCloudTargetReadback,
  });
  const diagnostics = [...contractValidation.diagnostics];
  if (!XCODE_ID_PATTERN.test(providerRunId ?? "")) {
    diagnostics.push("XCODE_RUN_ID_INVALID");
  }
  if (typeof trustedXcodeCloudRunReadback !== "function") {
    diagnostics.push("XCODE_RUN_READBACK_REQUIRED");
  }
  let observed;
  if (diagnostics.length === 0) {
    const snapshot = contractValidation.contract;
    const request = {
      action: snapshot.provider.requiredReadback.action,
      providerRunId,
      productId: snapshot.provider.productId,
      workflowId: snapshot.provider.workflowId,
      sourceReferenceId: snapshot.provider.sourceReference.id,
      expectedSourceCommitSha:
        snapshot.provider.requiredReadback.expectedSourceCommitSha,
      idempotencyKey: snapshot.idempotencyKey,
    };
    try {
      observed = structuredClone(
        await trustedXcodeCloudRunReadback(structuredClone(request)),
      );
      const observedAtMs = Date.parse(observed?.observedAt ?? "");
      const completedAtMs = now();
      const expectedKeys = [
        "action",
        "marketUpload",
        "observedAt",
        "productId",
        "providerRunId",
        "sourceCommitSha",
        "sourceReferenceId",
        "state",
        "workflowId",
      ];
      if (
        observed === null ||
        typeof observed !== "object" ||
        canonicalJson(Object.keys(observed).sort()) !==
          canonicalJson(expectedKeys) ||
        observed.state !== "VERIFIED" ||
        observed.action !== "ciBuildRuns.get" ||
        observed.providerRunId !== providerRunId ||
        observed.productId !== request.productId ||
        observed.workflowId !== request.workflowId ||
        observed.sourceReferenceId !== request.sourceReferenceId ||
        observed.sourceCommitSha !== request.expectedSourceCommitSha ||
        observed.marketUpload !== false ||
        !ISO_DATE_PATTERN.test(observed.observedAt ?? "") ||
        !Number.isFinite(observedAtMs) ||
        !Number.isFinite(completedAtMs) ||
        observedAtMs > completedAtMs + 60 * 1000 ||
        observedAtMs < completedAtMs - APPROVED_BINDING_TTL_MS
      ) {
        diagnostics.push("XCODE_RUN_READBACK_MISMATCH");
      }
    } catch {
      diagnostics.push("XCODE_RUN_READBACK_FAILED");
    }
  }
  const ok = diagnostics.length === 0;
  return {
    ok,
    diagnostics: [...new Set(diagnostics)].sort(),
    blocking: true,
    evidence: ok
      ? deepFreeze({
          providerRunId: observed.providerRunId,
          sourceCommitSha: observed.sourceCommitSha,
          workflowId: observed.workflowId,
          sourceReferenceId: observed.sourceReferenceId,
          observedAt: observed.observedAt,
          marketUpload: false,
        })
      : undefined,
  };
}

function collectWorkflowValues(value, keyName, result = []) {
  if (Array.isArray(value)) {
    for (const nested of value) collectWorkflowValues(nested, keyName, result);
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (key === keyName) result.push(nested);
      collectWorkflowValues(nested, keyName, result);
    }
  }
  return result;
}

export function evaluateLegacyWorkflow(text, { scope = "static" } = {}) {
  if (!["static", "android", "ios"].includes(scope)) {
    throw new Error("LEGACY_WORKFLOW_SCOPE_INVALID");
  }
  const parsed = parseCaller(text);
  const diagnostics = [];
  if (parsed.diagnostic) diagnostics.push(parsed.diagnostic);
  const workflow = parsed.value;
  if (workflow) {
    if (containsSecretInheritance(workflow)) {
      diagnostics.push("LEGACY_SECRET_INHERITANCE");
    }
    const usesValues = collectWorkflowValues(workflow, "uses");
    if (
      usesValues.some(
        (uses) =>
          typeof uses === "string" &&
          /^seorilabs\/\.github\/.*@(?![0-9a-f]{40}$).+$/u.test(uses),
      )
    ) {
      diagnostics.push("LEGACY_FLOATING_CENTRAL_WORKFLOW");
    }
    const runners = collectWorkflowValues(workflow, "runs-on");
    if (
      runners.some(
        (runner) =>
          typeof runner !== "string" ||
          /inputs\.|fromJSON|matrix\./u.test(runner),
      )
    ) {
      diagnostics.push("LEGACY_ARBITRARY_RUNNER");
    }
    if (
      scope === "android" &&
      runners.some((runner) =>
        /^(?:ubuntu|macos|windows)-(?:latest|[0-9.]+)$/u.test(runner),
      )
    ) {
      diagnostics.push("LEGACY_GITHUB_HOSTED_ANDROID_BUILD");
    }
    if (
      scope === "ios" &&
      runners.some((runner) => /^macos-/u.test(runner))
    ) {
      diagnostics.push("LEGACY_GITHUB_MACOS_IOS_BUILD");
    }
  }
  return Object.freeze({
    mode: "SHADOW",
    ruleset: "EVALUATE",
    blocking: false,
    diagnostics: [...new Set(diagnostics)].sort(),
  });
}

function platformGateRequest(bundle, manifest, mode, runId) {
  return {
    contract: "platform-release-gate-v1",
    mode,
    runId,
    repositoryId: manifest.repositoryId,
    fullName: manifest.fullName,
    sourceSha: manifest.sourceSha,
    workflowBundleDigest: bundle.integrity.payloadDigest,
    workflowBundleSourceSha: bundle.source.sha,
    platformSourceSha: bundle.platform.sourceSha,
    platformContractRevision: bundle.platform.contractRevision,
  };
}

function platformGateReceiptMatches(receipt, request, nowMs) {
  const expectedKeys = [
    "contract",
    "expiresAt",
    "fullName",
    "generation",
    "manifest",
    "mode",
    "observation",
    "platformContractRevision",
    "platformSourceSha",
    "receiptId",
    "repositoryId",
    "runId",
    "sourceSha",
    "state",
    "workflowBundleDigest",
    "workflowBundleSourceSha",
  ];
  const expiresAtMs = Date.parse(receipt?.expiresAt ?? "");
  const checks = [
    receipt !== null &&
      typeof receipt === "object",
    canonicalJson(Object.keys(receipt).sort()) === canonicalJson(expectedKeys) &&
      receipt.state === "APPROVED",
    Object.entries(request).every(([key, value]) => receipt[key] === value) &&
      Number.isFinite(expiresAtMs),
    expiresAtMs > nowMs &&
      expiresAtMs <= nowMs + 5 * 60 * 1000,
    CONFIG_ID_PATTERN.test(receipt.receiptId ?? "") &&
      Number.isSafeInteger(receipt.generation) &&
      receipt.generation > 0,
    canonicalJson(Object.keys(receipt.manifest ?? {}).sort()) ===
      canonicalJson(["digest", "signatureVerified", "state"]) &&
      receipt.manifest?.state === "FLEET_APPROVED" &&
      receipt.manifest?.signatureVerified === true &&
      SHA256_PATTERN.test(receipt.manifest?.digest ?? ""),
    canonicalJson(Object.keys(receipt.observation ?? {}).sort()) ===
      canonicalJson(["current", "digest", "id"]) &&
      CONFIG_ID_PATTERN.test(receipt.observation?.id ?? "") &&
      receipt.observation?.current === true &&
      SHA256_PATTERN.test(receipt.observation?.digest ?? ""),
  ];
  return checks.every(Boolean);
}

export async function evaluatePlatformReleaseGate(
  {
    mode = "RELEASE",
    runId,
    approvedBundleBinding,
    callerBinding,
    repositoryContext,
  } = {},
  { trustedPlatformGateReadback, now = () => Date.now() } = {},
) {
  if (!["STATIC", "RELEASE"].includes(mode)) {
    throw new Error("PLATFORM_GATE_MODE_INVALID");
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(runId ?? "")) {
    throw new Error("PLATFORM_GATE_RUN_ID_INVALID");
  }
  const enforcement = mode === "RELEASE" ? "FAIL_CLOSED" : "SHADOW";
  const bundleVerification = await verifyBundleBinding(approvedBundleBinding);
  const callerVerification = await verifyCallerBinding(
    callerBinding,
    repositoryContext,
  );
  const diagnostics = [];
  if (!bundleVerification.state) diagnostics.push(bundleVerification.diagnostic);
  if (!callerVerification.state) diagnostics.push(callerVerification.diagnostic);
  const bundle = bundleVerification.state?.bundle;
  const manifest = callerVerification.state?.manifest;
  const expectedPolicy =
    mode === "RELEASE"
      ? { mode: "FAIL_CLOSED", ruleset: undefined }
      : { mode: "SHADOW", ruleset: "EVALUATE" };
  const policy =
    mode === "RELEASE"
      ? bundle?.platformGate?.release
      : bundle?.platformGate?.static;
  if (
    policy?.mode !== expectedPolicy.mode ||
    (expectedPolicy.ruleset !== undefined &&
      policy?.ruleset !== expectedPolicy.ruleset)
  ) {
    diagnostics.push("PLATFORM_GATE_POLICY_REQUIRED");
  }
  if (bundle?.platform?.state !== "RESOLVED") {
    diagnostics.push("PLATFORM_FLEET_APPROVED_MANIFEST_REQUIRED");
  }
  if (typeof trustedPlatformGateReadback !== "function") {
    diagnostics.push("PLATFORM_GATE_READBACK_REQUIRED");
  }
  let receipt;
  let nowMs;
  try {
    nowMs = now();
  } catch {
    diagnostics.push("PLATFORM_GATE_CLOCK_INVALID");
  }
  if (!Number.isFinite(nowMs)) {
    diagnostics.push("PLATFORM_GATE_CLOCK_INVALID");
  }
  if (diagnostics.length === 0) {
    const request = platformGateRequest(bundle, manifest, mode, runId);
    try {
      receipt = structuredClone(
        await trustedPlatformGateReadback(structuredClone(request)),
      );
      const readbackCompletedAtMs = now();
      if (!Number.isFinite(readbackCompletedAtMs)) {
        diagnostics.push("PLATFORM_GATE_CLOCK_INVALID");
      } else if (
        !platformGateReceiptMatches(receipt, request, readbackCompletedAtMs)
      ) {
        diagnostics.push("PLATFORM_GATE_RECEIPT_INVALID");
      }
    } catch {
      diagnostics.push("PLATFORM_GATE_READBACK_FAILED");
    }
  }
  const ok = diagnostics.length === 0;
  if (ok && mode === "RELEASE") {
    const binding = Object.freeze({
      repositoryId: receipt.repositoryId,
      fullName: receipt.fullName,
      runId: receipt.runId,
      receiptId: receipt.receiptId,
      generation: receipt.generation,
      sourceSha: receipt.sourceSha,
      workflowBundleDigest: receipt.workflowBundleDigest,
      platformSourceSha: receipt.platformSourceSha,
      platformContractRevision: receipt.platformContractRevision,
      manifestDigest: receipt.manifest.digest,
      observationId: receipt.observation.id,
      expiresAt: receipt.expiresAt,
    });
    TRUSTED_PLATFORM_GATE_BINDINGS.set(
      binding,
      {
        receipt: deepFreeze(receipt),
        expiresAtMs: Date.parse(receipt.expiresAt),
        phase: "AVAILABLE",
      },
    );
    return { ok, enforcement, blocking: true, diagnostics: [], binding };
  }
  return {
    ok: mode === "STATIC" ? true : ok,
    enforcement,
    blocking: mode === "RELEASE",
    diagnostics: [...new Set(diagnostics)].sort(),
  };
}

export async function consumePlatformReleaseGateBinding(
  binding,
  expected,
  {
    now = () => Date.now(),
    trustedPlatformGateConsume,
    trustedPlatformGateConsumeReadback,
  } = {},
) {
  const state =
    binding !== null && typeof binding === "object"
      ? TRUSTED_PLATFORM_GATE_BINDINGS.get(binding)
      : undefined;
  if (!state) throw new Error("PLATFORM_GATE_BINDING_REQUIRED");
  if (state.phase === "CONSUMED") {
    throw new Error("PLATFORM_GATE_BINDING_CONSUMED");
  }
  if (state.phase === "CONSUMING") {
    throw new Error("PLATFORM_GATE_BINDING_IN_PROGRESS");
  }
  if (typeof trustedPlatformGateConsume !== "function") {
    throw new Error("PLATFORM_GATE_DURABLE_CONSUMER_REQUIRED");
  }
  const wasUncertain = state.phase === "UNCERTAIN";
  state.phase = "CONSUMING";
  const resetLocalPhase = () => {
    state.phase = wasUncertain ? "UNCERTAIN" : "AVAILABLE";
  };
  let nowMs;
  try {
    nowMs = now();
  } catch {
    resetLocalPhase();
    throw new Error("PLATFORM_GATE_CLOCK_INVALID");
  }
  if (!Number.isFinite(nowMs)) {
    resetLocalPhase();
    throw new Error("PLATFORM_GATE_CLOCK_INVALID");
  }
  if (nowMs >= state.expiresAtMs) {
    state.phase = wasUncertain ? "UNCERTAIN" : "CONSUMED";
    throw new Error("PLATFORM_GATE_BINDING_EXPIRED");
  }
  const expectedKeys = [
    "fullName",
    "platformContractRevision",
    "platformSourceSha",
    "repositoryId",
    "runId",
    "sourceSha",
    "workflowBundleDigest",
  ];
  let expectedSnapshot;
  try {
    expectedSnapshot = structuredClone(expected);
  } catch {
    resetLocalPhase();
    throw new Error("PLATFORM_GATE_BINDING_MISMATCH");
  }
  if (
    expectedSnapshot === null ||
    typeof expectedSnapshot !== "object" ||
    canonicalJson(Object.keys(expectedSnapshot).sort()) !==
      canonicalJson(expectedKeys) ||
    expectedKeys.some((key) => expectedSnapshot[key] !== binding[key])
  ) {
    resetLocalPhase();
    throw new Error("PLATFORM_GATE_BINDING_MISMATCH");
  }
  const consumeRequest = {
    contract: "platform-release-gate-consume-v1",
    receiptId: binding.receiptId,
    generation: binding.generation,
    ...expectedSnapshot,
  };
  const availableReadbackMatches = (record) =>
    record !== null &&
    typeof record === "object" &&
    canonicalJson(Object.keys(record).sort()) ===
      canonicalJson(["generation", "receiptId", "runId", "state"]) &&
    record.state === "AVAILABLE" &&
    record.receiptId === binding.receiptId &&
    record.generation === binding.generation &&
    record.runId === binding.runId;
  const validateConsumedRecord = (record, completedAtMs) => {
    const consumedAtMs = Date.parse(record?.consumedAt ?? "");
    const consumedKeys = [
      "consumedAt",
      "generation",
      "receiptId",
      "runId",
      "state",
    ];
    if (
      record === null ||
      typeof record !== "object" ||
      canonicalJson(Object.keys(record).sort()) !== canonicalJson(consumedKeys) ||
      record.state !== "CONSUMED" ||
      record.receiptId !== binding.receiptId ||
      record.generation !== binding.generation ||
      record.runId !== binding.runId ||
      !Number.isFinite(consumedAtMs) ||
      !Number.isFinite(completedAtMs) ||
      consumedAtMs > completedAtMs + 60 * 1000 ||
      consumedAtMs < completedAtMs - APPROVED_BINDING_TTL_MS
    ) {
      return { diagnostic: "PLATFORM_GATE_DURABLE_CONSUME_MISMATCH" };
    }
    if (
      consumedAtMs >= state.expiresAtMs ||
      completedAtMs >= state.expiresAtMs
    ) {
      return { diagnostic: "PLATFORM_GATE_BINDING_EXPIRED" };
    }
    return { consumedAt: record.consumedAt };
  };
  let consumed;
  if (wasUncertain) {
    if (typeof trustedPlatformGateConsumeReadback !== "function") {
      state.phase = "UNCERTAIN";
      throw new Error("PLATFORM_GATE_DURABLE_READBACK_REQUIRED");
    }
    try {
      consumed = structuredClone(
        await trustedPlatformGateConsumeReadback(
          structuredClone(consumeRequest),
        ),
      );
    } catch {
      state.phase = "UNCERTAIN";
      throw new Error("PLATFORM_GATE_DURABLE_READBACK_FAILED");
    }
    if (!availableReadbackMatches(consumed) && consumed?.state !== "CONSUMED") {
      state.phase = "UNCERTAIN";
      throw new Error("PLATFORM_GATE_DURABLE_READBACK_MISMATCH");
    }
  }
  if (consumed?.state !== "CONSUMED") {
    consumed = undefined;
    try {
      consumed = structuredClone(
        await trustedPlatformGateConsume(structuredClone(consumeRequest)),
      );
    } catch {
      state.phase = "UNCERTAIN";
      throw new Error("PLATFORM_GATE_DURABLE_CONSUME_FAILED");
    }
  }
  let completedAtMs;
  try {
    completedAtMs = now();
  } catch {
    state.phase = "UNCERTAIN";
    throw new Error("PLATFORM_GATE_CLOCK_INVALID");
  }
  const validatedConsumed = validateConsumedRecord(consumed, completedAtMs);
  if (validatedConsumed.diagnostic) {
    state.phase =
      validatedConsumed.diagnostic === "PLATFORM_GATE_BINDING_EXPIRED"
        ? "CONSUMED"
        : "UNCERTAIN";
    throw new Error(validatedConsumed.diagnostic);
  }
  state.phase = "CONSUMED";
  return deepFreeze({
    ...expectedSnapshot,
    receiptId: binding.receiptId,
    generation: binding.generation,
    manifestDigest: binding.manifestDigest,
    observationId: binding.observationId,
    expiresAt: binding.expiresAt,
    consumedAt: validatedConsumed.consumedAt,
  });
}

export const fleetContractPaths = Object.freeze({
  source: SOURCE_PATH,
  schema: SCHEMA_PATH,
});
