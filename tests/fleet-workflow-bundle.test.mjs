import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  createWorkflowBundle,
  generateOrgContractCaller,
  loadApprovedWorkflowBundle,
  promoteWorkflowBundle,
  validateOrgContractCaller,
  validateWorkflowBundle,
} from "../packages/repo-contract/src/fleet.mjs";

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
    repositoryId: 123 + index,
    sourceSha: "d".repeat(40),
    runId: 456 + index,
    artifactSha256: DIGEST,
  })),
);
const temporaryRoots = [];

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

async function approvedFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const registry = new Map();
  const candidate = await createWorkflowBundle({
    sourceSha: SOURCE_SHA,
    platformRelease: PLATFORM_RELEASE,
  });
  const approved = await promoteWorkflowBundle(candidate, EVIDENCE, {
    evidenceVerifier: async () => true,
    approvalSigner: { keyId: KEY_ID, privateKey },
    registryPublisher: async (record) => {
      const persisted = structuredClone(record);
      registry.set(record.subject, persisted);
      return persisted;
    },
  });
  const trust = {
    trustedApprovalKeys: new Map([[KEY_ID, publicKey]]),
    trustedRegistryReadback: async ({ subject }) => registry.get(subject),
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

test("candidate bundle은 정적 workflow와 실행 script의 실제 digest만 묶는다", async () => {
  const bundle = await createWorkflowBundle({ sourceSha: SOURCE_SHA });
  const result = await validateWorkflowBundle(bundle);

  assert.equal(result.ok, true, result.diagnostics.join(","));
  assert.equal(bundle.approval.state, "CANDIDATE");
  assert.equal(bundle.platform.state, "UNRESOLVED");
  assert.equal(bundle.buildWorkflows, undefined);
  assert.equal(bundle.builders, undefined);
  assert.deepEqual(Object.keys(bundle.quality.runtimeAssetDigests).sort(), [
    ".github/workflows/godot-checks-v2.yml",
    ".github/workflows/rn-static-checks-v2.yml",
    "scripts/fleet/secret-scan.mjs",
    "scripts/fleet/static-preflight.mjs",
    "scripts/fleet/write-provenance.mjs",
  ]);
  for (const workflow of Object.values(bundle.reusableWorkflows)) {
    assert.equal(workflow.sha, SOURCE_SHA);
  }
  const source = await readFile("contracts/workflow-bundle-source.yaml", "utf8");
  assert.doesNotMatch(source, /buildWorkflows:|android-build-cloud|builders:/u);
});

test("bundle payload 또는 실제 runtime asset 변조를 거부한다", async () => {
  const bundle = await createWorkflowBundle({ sourceSha: SOURCE_SHA });
  bundle.runners.privateGeneral = "ubuntu-latest";
  let result = await validateWorkflowBundle(bundle);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.includes("INTEGRITY_MISMATCH"));

  const root = await mkdtemp(join(tmpdir(), "fleet-bundle-assets-"));
  temporaryRoots.push(root);
  for (const directory of ["contracts", "profiles", "scripts/fleet"]) {
    await cp(directory, join(root, directory), { recursive: true });
  }
  await cp(
    ".github/workflows/rn-static-checks-v2.yml",
    join(root, ".github/workflows/rn-static-checks-v2.yml"),
    { recursive: true },
  );
  await cp(
    ".github/workflows/godot-checks-v2.yml",
    join(root, ".github/workflows/godot-checks-v2.yml"),
    { recursive: true },
  );
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
});

test("APPROVED bundle은 Ed25519 trusted key와 registry readback이 모두 있어야 소비된다", async () => {
  const { approved, trust } = await approvedFixture();
  assert.equal(approved.approval.signature.algorithm, "Ed25519");

  let result = await validateWorkflowBundle(approved);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.includes("APPROVAL_TRUSTED_KEY_REQUIRED"));
  assert.ok(result.diagnostics.includes("APPROVAL_REGISTRY_READBACK_REQUIRED"));

  result = await validateWorkflowBundle(approved, {
    trustedApprovalKeys: trust.trustedApprovalKeys,
  });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.includes("APPROVAL_REGISTRY_READBACK_REQUIRED"));

  result = await validateWorkflowBundle(approved, trust);
  assert.equal(result.ok, true, result.diagnostics.join(","));
});

test("공개 integrity 재계산과 공격자 registry로 APPROVED 상태를 위조할 수 없다", async () => {
  const { approved, trust } = await approvedFixture();
  const forged = structuredClone(approved);
  forged.approval.evidence[0].runId += 1000;
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
  });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.includes("APPROVAL_SIGNATURE_INVALID"));
});

test("registry await 중 원본 bundle을 바꿔도 검증 snapshot과 caller SHA는 변하지 않는다", async () => {
  const { approved, publicKey, registry } = await approvedFixture();
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
  });

  await started;
  approved.reusableWorkflows["react-native"].sha = STALE_SHA;
  releaseReadback();
  const binding = await loading;
  const caller = await generateOrgContractCaller({
    profile: "react-native",
    approvedBundleBinding: binding,
  });
  assert.match(caller, new RegExp(`@${SOURCE_SHA}`, "u"));
  assert.doesNotMatch(caller, new RegExp(`@${STALE_SHA}`, "u"));
});

test("승격은 canary readback, Ed25519 signer, registry publisher를 모두 요구한다", async () => {
  const candidate = await createWorkflowBundle({
    sourceSha: SOURCE_SHA,
    platformRelease: PLATFORM_RELEASE,
  });
  const { privateKey } = generateKeyPairSync("ed25519");

  await assert.rejects(
    promoteWorkflowBundle(candidate, EVIDENCE),
    /CANARY_EVIDENCE_VERIFIER_REQUIRED/u,
  );
  await assert.rejects(
    promoteWorkflowBundle(candidate, EVIDENCE, {
      evidenceVerifier: async () => true,
    }),
    /APPROVAL_SIGNER_REQUIRED/u,
  );
  await assert.rejects(
    promoteWorkflowBundle(candidate, EVIDENCE, {
      evidenceVerifier: async () => true,
      approvalSigner: { keyId: KEY_ID, privateKey },
    }),
    /APPROVAL_REGISTRY_PUBLISHER_REQUIRED/u,
  );
});

test("generator와 validator는 trusted APPROVED bundle의 exact path와 SHA만 허용한다", async () => {
  const { binding } = await approvedFixture();
  for (const profile of ["react-native", "godot"]) {
    const caller = await generateOrgContractCaller({
      profile,
      approvedBundleBinding: binding,
      workingDirectory: "apps/mobile",
      packageManager: "pnpm",
    });
    const result = await validateOrgContractCaller(caller, {
      approvedBundleBinding: binding,
    });
    assert.equal(result.ok, true, `${profile}: ${result.diagnostics}`);
    assert.equal(result.profile, profile);
    assert.equal(result.workflowSha, SOURCE_SHA);
    assert.doesNotMatch(caller, /secrets:|runs-on:/u);

    const stale = caller.replace(`@${SOURCE_SHA}`, `@${STALE_SHA}`);
    const staleResult = await validateOrgContractCaller(stale, {
      approvedBundleBinding: binding,
    });
    assert.equal(staleResult.ok, false);
    assert.ok(
      staleResult.diagnostics.includes("CALLER_APPROVED_WORKFLOW_MISMATCH"),
    );
  }

  await assert.rejects(
    async () =>
      generateOrgContractCaller({
        profile: "react-native",
        workflowSha: SOURCE_SHA,
      }),
    /APPROVED_BUNDLE_BINDING_REQUIRED/u,
  );
});

test("registry 승인 철회와 5분 binding 만료 뒤 caller 생성을 거부한다", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const first = await approvedFixture();
  first.registry.clear();
  await assert.rejects(
    generateOrgContractCaller({
      profile: "react-native",
      approvedBundleBinding: first.binding,
    }),
    /APPROVED_BUNDLE_REGISTRY_REVOKED/u,
  );

  const second = await approvedFixture();
  now += 5 * 60 * 1000;
  await assert.rejects(
    generateOrgContractCaller({
      profile: "godot",
      approvedBundleBinding: second.binding,
    }),
    /APPROVED_BUNDLE_BINDING_EXPIRED/u,
  );
});

test("candidate 또는 구조만 흉내 낸 객체로 caller binding을 만들 수 없다", async () => {
  const candidate = await createWorkflowBundle({ sourceSha: SOURCE_SHA });
  await assert.rejects(
    loadApprovedWorkflowBundle(candidate),
    /APPROVED_BUNDLE_REQUIRED/u,
  );
  await assert.rejects(
    async () =>
      generateOrgContractCaller({
        profile: "react-native",
        approvedBundleBinding: {
          sourceSha: SOURCE_SHA,
          workflowByProfile: candidate.reusableWorkflows,
        },
      }),
    /APPROVED_BUNDLE_BINDING_REQUIRED/u,
  );
});

test("weak caller, secrets inherit, wrong runner와 weak trigger를 차단한다", async () => {
  const { binding } = await approvedFixture();
  const valid = await generateOrgContractCaller({
    profile: "react-native",
    approvedBundleBinding: binding,
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
    validateOrgContractCaller(caller, { approvedBundleBinding: binding });

  assert.ok((await check(inherited)).diagnostics.includes("SECRET_INHERITANCE_FORBIDDEN"));
  assert.ok((await check(arbitraryRunner)).diagnostics.includes("THIN_CALLER_REQUIRED"));
  assert.ok((await check(skipped)).diagnostics.includes("CALLER_JOB_POLICY_INVALID"));
  assert.ok((await check(weakTrigger)).diagnostics.includes("CALLER_EVENTS_INVALID"));
});

test("profile이 모호하면 caller를 추측 생성하지 않는다", async () => {
  const { binding } = await approvedFixture();
  await assert.rejects(
    async () =>
      generateOrgContractCaller({
        profile: "unknown",
        approvedBundleBinding: binding,
      }),
    /PROFILE_NEEDS_INPUT/u,
  );
});
