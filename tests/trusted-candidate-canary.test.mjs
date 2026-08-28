import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { parseDocument } from "yaml";

import { createWorkflowBundle } from "../packages/repo-contract/src/fleet.mjs";
import { createTrustedWifAdapter } from "../packages/repo-contract/src/trusted-executor.mjs";
import {
  createTrustedCandidateCanaryExecutionStore,
  createTrustedCandidateCanaryExecutor,
  createTrustedCandidateCanaryGitHubAdapter,
  createTrustedCandidateCanaryPlan,
  loadTrustedCandidateBundle,
  loadTrustedCandidateCanaryCaller,
  trustedCandidateCanaryContract,
} from "../packages/repo-contract/src/trusted-candidate-canary.mjs";

const ORGANIZATION_ID = "1001";
const INSTALLATION_ID = "2001";
const CANDIDATE_SOURCE_SHA = "a".repeat(40);
const APP_SOURCE_SHA = "d".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const TOKEN_TEXT = "candidate-canary-token-must-not-escape";
const LEASE_TEXT = "candidate-canary-lease-must-not-escape";
const STATIC_CALLER_PATH = ".github/workflows/org-contract.yml";
const ANDROID_CALLER_PATH = ".github/workflows/android-build-only.yml";
const NOW_MS = Date.parse("2026-08-28T01:00:00.000Z");
const WIF_LOGICAL_CREDENTIAL_ID = "shared/gcp/cloud-build";
const WIF_PROVIDER_RESOURCE_NAME =
  "//iam.googleapis.com/projects/123456789/locations/global/" +
  "workloadIdentityPools/seori-pool/providers/github-actions";
const WIF_SERVICE_ACCOUNT_EMAIL =
  "seorilabs-ci@seorilabs-gws.iam.gserviceaccount.com";

const PLATFORM_RELEASE = Object.freeze({
  sourceSha: "c".repeat(40),
  contractRevision: DIGEST,
  typescript: { version: "1.2.3", digest: DIGEST },
  gdscript: { version: "1.2.3", digest: DIGEST },
});

const REPOSITORIES = Object.freeze({
  "react-native": Object.freeze({
    repositoryId: "1250442131",
    fullName: "seorilabs/happy-farm",
    sourceSha: APP_SOURCE_SHA,
    packageManager: "pnpm",
    workingDirectory: "apps/mobile",
  }),
  godot: Object.freeze({
    repositoryId: "1265192029",
    fullName: "seorilabs/lizard-tycoon",
    sourceSha: "e".repeat(40),
    packageManager: "npm",
    workingDirectory: ".",
  }),
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

function digest(value) {
  return `sha256:${createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(canonicalize(value)))
    .digest("hex")}`;
}

function manifestFor(profile, overrides = {}) {
  const repository = REPOSITORIES[profile];
  return {
    state: "ACTIVE",
    repositoryId: repository.repositoryId,
    fullName: repository.fullName,
    sourceSha: repository.sourceSha,
    sourceRef: "refs/heads/main",
    observationId: "candidate-observation-0001",
    sourcePayloadDigest: DIGEST,
    profile,
    packageManager: repository.packageManager,
    workingDirectory: repository.workingDirectory,
    configId: "candidate-config-0001",
    configRevision: 7,
    snapshotDigest: "f".repeat(64),
    configSignatureDigest: `sha256:${"9".repeat(64)}`,
    ...overrides,
  };
}

function wifBindingFor(repository) {
  return {
    approvalReceiptId: `candidate-wif-${repository.repositoryId}`,
    bindingRevision: 3,
    logicalCredentialId: WIF_LOGICAL_CREDENTIAL_ID,
    organizationId: ORGANIZATION_ID,
  };
}

function sourceReadbackFor(bundle, state = {}) {
  return async ({ repository, sourceSha }) => ({
    repository,
    sourceSha: state.sourceSha ?? sourceSha,
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
          await readFile(join(".", path), "utf8"),
        ]),
      ),
    ),
    runtimeAssetContents: Object.fromEntries(
      await Promise.all(
        Object.keys(bundle.quality.runtimeAssetDigests).map(async (path) => [
          path,
          await readFile(join(".", path), "utf8"),
        ]),
      ),
    ),
  });
}

async function planFixture(profile = "react-native") {
  const candidate = await createWorkflowBundle({
    sourceSha: CANDIDATE_SOURCE_SHA,
    platformRelease: PLATFORM_RELEASE,
  });
  const sourceState = {};
  const trustedWorkflowSourceReadback = sourceReadbackFor(candidate, sourceState);
  const candidateBundleBinding = await loadTrustedCandidateBundle(candidate, {
    repoRoot: ".",
    trustedWorkflowSourceReadback,
    now: () => NOW_MS,
  });
  const repository = REPOSITORIES[profile];
  const manifestState = { value: manifestFor(profile) };
  const trustedResolvedManifestReadback = async () =>
    structuredClone(manifestState.value);
  const callerBinding = await loadTrustedCandidateCanaryCaller(
    {
      repositoryId: repository.repositoryId,
      fullName: repository.fullName,
      sourceSha: repository.sourceSha,
    },
    {
      trustedResolvedManifestReadback,
      now: () => NOW_MS,
    },
  );
  const planBinding = await createTrustedCandidateCanaryPlan({
    candidateBundleBinding,
    callerBinding,
    wifBinding: wifBindingFor(repository),
  });
  return {
    callerBinding,
    candidate,
    candidateBundleBinding,
    manifestState,
    planBinding,
    repository,
    sourceState,
    trustedResolvedManifestReadback,
    trustedWorkflowSourceReadback,
  };
}

function appliedObservation(operation, repository, number = 17) {
  return {
    kind: operation.kind,
    idempotencyKey: operation.idempotencyKey,
    repositoryId: repository.repositoryId,
    sourceSha: repository.sourceSha,
    candidateSourceSha: operation.payload.candidateSourceSha,
    candidateBundleDigest: operation.payload.candidateBundleDigest,
    headRef: operation.payload.headRef,
    baseRef: operation.payload.baseRef,
    number,
    state: "OPEN",
    files: operation.payload.files.map(({ contentDigest, path }) => ({
      contentDigest,
      path,
    })),
  };
}

async function androidWorkflow(profile) {
  const path =
    profile === "react-native"
      ? ".github/workflows/rn-build-android-cloud-v1.yml"
      : ".github/workflows/godot-build-android-cloud-v1.yml";
  const document = parseDocument(await readFile(path, "utf8"), {
    strict: true,
    uniqueKeys: true,
  });
  assert.equal(document.errors.length, 0);
  return { path, workflow: document.toJS() };
}

function runGuard(script, environment) {
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...environment },
  });
}

function executorHarness(
  repository,
  {
    identitySourceSha = repository.sourceSha,
    providerApplyError,
    invalidCompletion = false,
    tokenRepositoryIds,
    wifApprovalOverride = {},
    wifApplyError,
    wifReadbackMismatch = false,
  } = {},
) {
  const issuedTokenBuffers = [];
  const issuedLeaseBuffers = [];
  const permissionRequests = [];
  const capturedOperations = [];
  let currentObservation;
  let completed;
  let applyCount = 0;
  let wifApplyCount = 0;
  let wifApprovalConsumeCount = 0;
  let wifApproval;
  let wifBound = false;
  let providerEtag = "provider-etag-before";
  let serviceAccountPolicyEtag = "policy-etag-before";

  const githubAppAdapter = createTrustedCandidateCanaryGitHubAdapter({
    organizationId: ORGANIZATION_ID,
    installationId: INSTALLATION_ID,
    now: () => NOW_MS,
    issueInstallationToken: async (request) => {
      permissionRequests.push(structuredClone(request));
      const token = Buffer.from(TOKEN_TEXT.repeat(2), "utf8");
      issuedTokenBuffers.push(token);
      return {
        token,
        accountId: ORGANIZATION_ID,
        accountLogin: "seorilabs",
        installationId: INSTALLATION_ID,
        repositoryIds: tokenRepositoryIds ?? [repository.repositoryId],
        permissions: structuredClone(request.permissions),
        expiresAt: new Date(NOW_MS + 30 * 60 * 1000).toISOString(),
      };
    },
    provider: {
      async readIdentity({ apiOrigin, apiVersion, context, credential }) {
        assert.equal(apiOrigin, "https://api.github.com");
        assert.equal(apiVersion, "2022-11-28");
        assert.equal(credential.includes(Buffer.from("candidate-canary-token")), true);
        assert.equal(context.repositoryId, repository.repositoryId);
        return {
          organizationId: ORGANIZATION_ID,
          installationId: INSTALLATION_ID,
          repositoryId: repository.repositoryId,
          fullName: repository.fullName,
          sourceSha: identitySourceSha,
          private: true,
          archived: false,
          defaultBranch: "main",
        };
      },
      async readOperation({ context, credential, operation }) {
        assert.equal(credential.includes(Buffer.from("candidate-canary-token")), true);
        assert.equal(context.repositoryId, repository.repositoryId);
        if (currentObservation) return structuredClone(currentObservation);
        return {
          kind: operation.kind,
          idempotencyKey: operation.idempotencyKey,
          repositoryId: repository.repositoryId,
          state: "NOT_APPLIED",
        };
      },
      async applyOperation({ context, credential, operation }) {
        assert.equal(credential.includes(Buffer.from("candidate-canary-token")), true);
        assert.equal(context.repositoryId, repository.repositoryId);
        if (providerApplyError) throw new Error(providerApplyError);
        applyCount += 1;
        capturedOperations.push(structuredClone(operation));
        currentObservation = appliedObservation(operation, repository);
        return {
          kind: operation.kind,
          idempotencyKey: operation.idempotencyKey,
          repositoryId: repository.repositoryId,
          headRef: operation.payload.headRef,
          number: 17,
          state: "UPDATED",
        };
      },
    },
  });

  const wifAdapter = createTrustedWifAdapter({
    organizationId: ORGANIZATION_ID,
    bindings: [
      {
        bindingRevision: 3,
        logicalCredentialId: WIF_LOGICAL_CREDENTIAL_ID,
        providerResourceName: WIF_PROVIDER_RESOURCE_NAME,
        serviceAccountEmail: WIF_SERVICE_ACCOUNT_EMAIL,
      },
    ],
    provider: {
      async readBinding({ apiOrigin, apiVersion, expected, operation }) {
        assert.equal(apiOrigin, "https://iam.googleapis.com");
        assert.equal(apiVersion, "v1");
        assert.equal(operation.kind, "gcp.wif-binding.ensure");
        return {
          ...structuredClone(expected),
          providerEtag,
          serviceAccountPolicyEtag,
          state:
            wifReadbackMismatch && wifBound ? "NOT_APPLIED" :
              wifBound ? "BOUND" : "NOT_APPLIED",
        };
      },
      async applyBinding({
        expected,
        expectedProviderEtag,
        expectedServiceAccountPolicyEtag,
      }) {
        if (wifApplyError) throw new Error(wifApplyError);
        assert.equal(expectedProviderEtag, providerEtag);
        assert.equal(
          expectedServiceAccountPolicyEtag,
          serviceAccountPolicyEtag,
        );
        wifApplyCount += 1;
        const previousProviderEtag = providerEtag;
        const previousServiceAccountPolicyEtag = serviceAccountPolicyEtag;
        providerEtag = "provider-etag-after";
        serviceAccountPolicyEtag = "policy-etag-after";
        wifBound = true;
        return {
          bindingRevision: expected.bindingRevision,
          logicalCredentialId: expected.logicalCredentialId,
          previousProviderEtag,
          previousServiceAccountPolicyEtag,
          providerEtag,
          providerResourceName: expected.providerResourceName,
          repositoryId: expected.repositoryId,
          serviceAccountEmail: expected.serviceAccountEmail,
          serviceAccountPolicyEtag,
          state: "UPDATED",
        };
      },
    },
  });

  const executionStore = createTrustedCandidateCanaryExecutionStore({
    async readExecutablePlan(request) {
      return {
        ...request,
        state: "EXECUTABLE",
        generation: 11,
        expiresAt: new Date(NOW_MS + 4 * 60 * 1000).toISOString(),
      };
    },
    async claimOperation(request) {
      if (completed) {
        return {
          ...request,
          state: "COMPLETED",
          generation: completed.generation,
          receiptDigest: completed.receiptDigest,
        };
      }
      const leaseToken = Buffer.from(LEASE_TEXT.repeat(2), "utf8");
      issuedLeaseBuffers.push(leaseToken);
      return {
        ...request,
        state: "CLAIMED",
        generation: 23,
        leaseToken,
        expiresAt: new Date(NOW_MS + 4 * 60 * 1000).toISOString(),
      };
    },
    async readWifApproval(request) {
      if (!wifApproval) {
        wifApproval = {
          ...structuredClone(request),
          consumedUses: 0,
          expiresAt: new Date(NOW_MS + 4 * 60 * 1000).toISOString(),
          generation: 31,
          maxUses: 1,
          state: "AUTHORIZED",
          ...structuredClone(wifApprovalOverride),
        };
      }
      return structuredClone(wifApproval);
    },
    async consumeWifApproval(request) {
      assert.equal(request.expectedGeneration, wifApproval.generation);
      wifApprovalConsumeCount += 1;
      const { expectedGeneration: _expectedGeneration, ...expected } = request;
      wifApproval = {
        ...expected,
        consumedUses: 1,
        expiresAt: wifApproval.expiresAt,
        generation: wifApproval.generation + 1,
        maxUses: 1,
        state: "CONSUMED",
      };
      return structuredClone(wifApproval);
    },
    async completeOperation(request) {
      assert.equal(request.leaseToken.includes(Buffer.from("candidate-canary-lease")), true);
      completed = {
        generation: request.generation,
        receiptDigest: request.receiptDigest,
      };
      const {
        leaseToken: _leaseToken,
        receipt: _receipt,
        ...completion
      } = request;
      return {
        ...completion,
        generation: invalidCompletion
          ? request.generation + 1
          : request.generation,
        state: "COMPLETED",
      };
    },
  });

  const execute = createTrustedCandidateCanaryExecutor({
    organizationId: ORGANIZATION_ID,
    installationId: INSTALLATION_ID,
    githubAppAdapter,
    wifAdapter,
    executionStore,
    now: () => NOW_MS,
  });
  return {
    capturedOperations,
    execute,
    githubAppAdapter,
    issuedLeaseBuffers,
    issuedTokenBuffers,
    permissionRequests,
    get applyCount() {
      return applyCount;
    },
    get wifApplyCount() {
      return wifApplyCount;
    },
    get wifApprovalConsumeCount() {
      return wifApprovalConsumeCount;
    },
    rotateWifEtags() {
      providerEtag = "provider-etag-rotated";
      serviceAccountPolicyEtag = "policy-etag-rotated";
    },
    revokeWifBinding() {
      wifBound = false;
    },
  };
}

for (const profile of ["react-native", "godot"]) {
  test(`${profile} 고정 canary만 candidate SHA의 두 thin caller를 설치한다`, async () => {
    const fixture = await planFixture(profile);
    const harness = executorHarness(fixture.repository);

    const first = await harness.execute(fixture.planBinding);
    harness.rotateWifEtags();
    const second = await harness.execute(fixture.planBinding);

    assert.equal(first.state, "COMPLETED");
    assert.equal(first.operation.outcome, "APPLIED");
    assert.equal(second.operation.outcome, "REPLAYED");
    assert.equal(harness.applyCount, 1);
    assert.equal(harness.wifApplyCount, 1);
    assert.equal(harness.wifApprovalConsumeCount, 1);
    assert.equal(harness.capturedOperations.length, 1);
    assert.equal(first.wif.state, "BOUND");
    assert.equal(
      first.wif.jobWorkflowRef,
      `seorilabs/.github/${
        profile === "react-native"
          ? ".github/workflows/rn-build-android-cloud-v1.yml"
          : ".github/workflows/godot-build-android-cloud-v1.yml"
      }@${CANDIDATE_SOURCE_SHA}`,
    );

    const operation = harness.capturedOperations[0];
    assert.equal(operation.kind, trustedCandidateCanaryContract.operationKind);
    assert.equal(operation.payload.repositoryId, fixture.repository.repositoryId);
    assert.equal(operation.payload.fullName, fixture.repository.fullName);
    assert.equal(operation.payload.maximumOpenAutonomousPullRequests, 1);
    assert.equal(operation.payload.files.length, 2);
    assert.equal(
      operation.idempotencyKey,
      digest({
        kind: operation.kind,
        payload: operation.payload,
        repositoryId: fixture.repository.repositoryId,
      }),
    );

    for (const file of operation.payload.files) {
      assert.equal(file.contentDigest, digest(file.content));
      assert.equal(file.content.includes(`@${CANDIDATE_SOURCE_SHA}`), true);
      assert.equal(/secrets\s*:/u.test(file.content), false);
      assert.equal(/\binherit\b/u.test(file.content), false);
      assert.equal(/runs-on\s*:/u.test(file.content), false);
      assert.equal(/^\s*steps\s*:/mu.test(file.content), false);
      const document = parseDocument(file.content, {
        strict: true,
        uniqueKeys: true,
      });
      assert.equal(document.errors.length, 0);
      const caller = document.toJS();
      const jobs = Object.values(caller.jobs);
      assert.equal(jobs.length, 1);
      assert.deepEqual(Object.keys(jobs[0]).sort(), ["name", "uses", "with"]);
      assert.deepEqual(
        caller.permissions,
        profile === "react-native"
          ? file.path === ANDROID_CALLER_PATH
            ? { contents: "read", "id-token": "write", packages: "read" }
            : { contents: "read", packages: "read" }
          : file.path === ANDROID_CALLER_PATH
            ? { contents: "read", "id-token": "write" }
            : { contents: "read" },
      );
    }
    assert.deepEqual(
      operation.payload.files.map(({ path }) => path),
      [STATIC_CALLER_PATH, ANDROID_CALLER_PATH],
    );
    const androidCaller = parseDocument(
      operation.payload.files.find(({ path }) => path === ANDROID_CALLER_PATH)
        .content,
    ).toJS();
    assert.deepEqual(androidCaller.on.pull_request.paths, [ANDROID_CALLER_PATH]);
    assert.deepEqual(androidCaller.on.workflow_dispatch, {});
    assert.equal(
      JSON.stringify(first).includes(TOKEN_TEXT) ||
        JSON.stringify(first).includes(LEASE_TEXT) ||
        JSON.stringify(first).includes("content:"),
      false,
    );
    assert.deepEqual(Object.keys(harness.githubAppAdapter).sort(), [
      "contract",
      "installationId",
      "organizationId",
    ]);
    assert.equal(
      harness.issuedTokenBuffers.every((buffer) =>
        buffer.every((byte) => byte === 0),
      ),
      true,
    );
    assert.equal(
      harness.issuedLeaseBuffers.every((buffer) =>
        buffer.every((byte) => byte === 0),
      ),
      true,
    );
    assert.equal(
      harness.permissionRequests.every(
        ({ repositoryIds }) =>
          JSON.stringify(repositoryIds) ===
          JSON.stringify([fixture.repository.repositoryId]),
      ),
      true,
    );
  });
}

test("allowlist 밖 repo와 canary profile 바꿔치기를 거부한다", async () => {
  await assert.rejects(
    loadTrustedCandidateCanaryCaller(
      {
        repositoryId: "7001",
        fullName: "seorilabs/example-app",
        sourceSha: APP_SOURCE_SHA,
      },
      { trustedResolvedManifestReadback: async () => undefined },
    ),
    /CANDIDATE_CANARY_REPOSITORY_NOT_ALLOWED/u,
  );

  const repository = REPOSITORIES["react-native"];
  await assert.rejects(
    loadTrustedCandidateCanaryCaller(
      {
        repositoryId: repository.repositoryId,
        fullName: repository.fullName,
        sourceSha: repository.sourceSha,
      },
      {
        trustedResolvedManifestReadback: async () =>
          manifestFor("react-native", { profile: "godot" }),
      },
    ),
    /CANDIDATE_CANARY_CALLER_MISMATCH/u,
  );
});

test("임의 YAML, secrets inherit, arbitrary runner와 steps를 모두 거부한다", async () => {
  const fixture = await planFixture();
  const attacks = [
    "name: arbitrary\njobs:\n  pwn:\n    uses: attacker/workflow@main\n",
    "name: Org Contract\njobs:\n  pwn:\n    secrets: inherit\n",
    "name: Org Contract\njobs:\n  pwn:\n    runs-on: private-root-runner\n",
    "name: Org Contract\njobs:\n  pwn:\n    steps:\n      - run: printenv\n",
  ];
  for (const malicious of attacks) {
    await assert.rejects(
      createTrustedCandidateCanaryPlan({
        candidateBundleBinding: fixture.candidateBundleBinding,
        callerBinding: fixture.callerBinding,
        wifBinding: wifBindingFor(fixture.repository),
        callerDocuments: {
          [STATIC_CALLER_PATH]: malicious,
          [ANDROID_CALLER_PATH]: malicious,
        },
      }),
      /CANDIDATE_CANARY_CALLER_UNTRUSTED/u,
    );
  }
});

test("candidate 중앙 source SHA와 asset integrity mismatch를 fail-closed 한다", async () => {
  const candidate = await createWorkflowBundle({
    sourceSha: CANDIDATE_SOURCE_SHA,
    platformRelease: PLATFORM_RELEASE,
  });
  await assert.rejects(
    loadTrustedCandidateBundle(candidate, {
      repoRoot: ".",
      trustedWorkflowSourceReadback: sourceReadbackFor(candidate, {
        sourceSha: "8".repeat(40),
      }),
    }),
    /CANDIDATE_CANARY_SOURCE_MISMATCH/u,
  );

  const exact = sourceReadbackFor(candidate);
  await assert.rejects(
    loadTrustedCandidateBundle(candidate, {
      repoRoot: ".",
      trustedWorkflowSourceReadback: async (request) => {
        const snapshot = await exact(request);
        snapshot.runtimeAssetContents[
          ".github/workflows/rn-static-checks-v2.yml"
        ] += "\n# drift\n";
        return snapshot;
      },
    }),
    /CANDIDATE_CANARY_SOURCE_MISMATCH/u,
  );
});

test("plan 생성과 실행 직전에 source 및 Backoffice manifest를 다시 읽는다", async () => {
  const sourceDrift = await planFixture();
  sourceDrift.sourceState.sourceSha = "7".repeat(40);
  await assert.rejects(
    createTrustedCandidateCanaryPlan({
      candidateBundleBinding: sourceDrift.candidateBundleBinding,
      callerBinding: sourceDrift.callerBinding,
      wifBinding: wifBindingFor(sourceDrift.repository),
    }),
    /CANDIDATE_CANARY_SOURCE_MISMATCH/u,
  );

  const manifestDrift = await planFixture();
  manifestDrift.manifestState.value = {
    ...manifestDrift.manifestState.value,
    sourceSha: "6".repeat(40),
  };
  await assert.rejects(
    createTrustedCandidateCanaryPlan({
      candidateBundleBinding: manifestDrift.candidateBundleBinding,
      callerBinding: manifestDrift.callerBinding,
      wifBinding: wifBindingFor(manifestDrift.repository),
    }),
    /CANDIDATE_CANARY_CALLER_MISMATCH/u,
  );

  const executionDrift = await planFixture();
  const harness = executorHarness(executionDrift.repository);
  executionDrift.manifestState.value = {
    ...executionDrift.manifestState.value,
    configRevision: executionDrift.manifestState.value.configRevision + 1,
  };
  await assert.rejects(
    harness.execute(executionDrift.planBinding),
    /CANDIDATE_CANARY_CALLER_MISMATCH/u,
  );
  assert.equal(harness.applyCount, 0);
});

test("GitHub exact repo/source/install readback과 단일 repo token scope를 강제한다", async () => {
  const fixture = await planFixture();
  const wrongSource = executorHarness(fixture.repository, {
    identitySourceSha: "5".repeat(40),
  });
  await assert.rejects(
    wrongSource.execute(fixture.planBinding),
    /CANDIDATE_CANARY_IDENTITY_MISMATCH/u,
  );
  assert.equal(wrongSource.applyCount, 0);

  const fanoutToken = executorHarness(fixture.repository, {
    tokenRepositoryIds: [fixture.repository.repositoryId, "7002"],
  });
  await assert.rejects(
    fanoutToken.execute(fixture.planBinding),
    /CANDIDATE_CANARY_IDENTITY_READBACK_FAILED/u,
  );
  assert.equal(fanoutToken.applyCount, 0);
});

test("provider 비밀 오류를 정규화하고 token과 lease를 노출하지 않는다", async () => {
  const fixture = await planFixture();
  const harness = executorHarness(fixture.repository, {
    providerApplyError: `${TOKEN_TEXT}:${LEASE_TEXT}`,
  });
  await assert.rejects(
    harness.execute(fixture.planBinding),
    (error) => {
      assert.equal(error.message, "CANDIDATE_CANARY_OPERATION_APPLY_FAILED");
      assert.equal(error.message.includes(TOKEN_TEXT), false);
      assert.equal(error.message.includes(LEASE_TEXT), false);
      return true;
    },
  );
  assert.equal(
    harness.issuedTokenBuffers.every((buffer) =>
      buffer.every((byte) => byte === 0),
    ),
    true,
  );
  assert.equal(
    harness.issuedLeaseBuffers.every((buffer) =>
      buffer.every((byte) => byte === 0),
    ),
    true,
  );
});

test("completion은 generation을 echo하지 않으면 stale completion으로 거부한다", async () => {
  const fixture = await planFixture();
  const harness = executorHarness(fixture.repository, {
    invalidCompletion: true,
  });
  await assert.rejects(
    harness.execute(fixture.planBinding),
    /CANDIDATE_CANARY_OPERATION_COMPLETION_INVALID/u,
  );
  assert.equal(harness.applyCount, 1);
  assert.equal(
    harness.issuedLeaseBuffers.every((buffer) =>
      buffer.every((byte) => byte === 0),
    ),
    true,
  );
});

test("candidate WIF prebind는 exact 5분 1회 승인 뒤에만 PR보다 먼저 실행된다", async () => {
  const fixture = await planFixture();
  const wrongOrganizationPlan = await createTrustedCandidateCanaryPlan({
    candidateBundleBinding: fixture.candidateBundleBinding,
    callerBinding: fixture.callerBinding,
    wifBinding: {
      ...wifBindingFor(fixture.repository),
      organizationId: "9999",
    },
  });
  const wrongOrganization = executorHarness(fixture.repository);
  await assert.rejects(
    wrongOrganization.execute(wrongOrganizationPlan),
    /CANDIDATE_CANARY_PLAN_MISMATCH/u,
  );
  assert.equal(wrongOrganization.issuedLeaseBuffers.length, 0);
  assert.equal(wrongOrganization.wifApplyCount, 0);
  assert.equal(wrongOrganization.applyCount, 0);

  const expired = executorHarness(fixture.repository, {
    wifApprovalOverride: {
      expiresAt: new Date(NOW_MS - 1).toISOString(),
    },
  });
  await assert.rejects(
    expired.execute(fixture.planBinding),
    /CANDIDATE_CANARY_WIF_APPROVAL_MISMATCH/u,
  );
  assert.equal(expired.wifApplyCount, 0);
  assert.equal(expired.applyCount, 0);
  assert.equal(
    expired.issuedLeaseBuffers.every((buffer) =>
      buffer.every((byte) => byte === 0),
    ),
    true,
  );

  const wrongPurpose = executorHarness(fixture.repository, {
    wifApprovalOverride: { purpose: "PROVISION_CREDENTIAL_BINDINGS" },
  });
  await assert.rejects(
    wrongPurpose.execute(fixture.planBinding),
    /CANDIDATE_CANARY_WIF_APPROVAL_MISMATCH/u,
  );
  assert.equal(wrongPurpose.wifApplyCount, 0);
  assert.equal(wrongPurpose.applyCount, 0);

  for (const override of [
    {
      jobWorkflowRef:
        "seorilabs/.github/.github/workflows/rn-build-android-cloud-v1.yml@" +
        "0".repeat(40),
    },
    { planDigest: `sha256:${"0".repeat(64)}` },
    { sourceSha: "0".repeat(40) },
  ]) {
    const mismatched = executorHarness(fixture.repository, {
      wifApprovalOverride: override,
    });
    await assert.rejects(
      mismatched.execute(fixture.planBinding),
      /CANDIDATE_CANARY_WIF_APPROVAL_MISMATCH/u,
    );
    assert.equal(mismatched.wifApplyCount, 0);
    assert.equal(mismatched.applyCount, 0);
  }
});

test("candidate WIF exact readback 실패는 GitHub PR mutation 전에 중단한다", async () => {
  const fixture = await planFixture();
  const harness = executorHarness(fixture.repository, {
    wifReadbackMismatch: true,
  });
  await assert.rejects(
    harness.execute(fixture.planBinding),
    /CANDIDATE_CANARY_WIF_RECONCILIATION_FAILED/u,
  );
  assert.equal(harness.wifApplyCount, 1);
  assert.equal(harness.applyCount, 0);
  assert.equal(harness.wifApprovalConsumeCount, 1);
  assert.equal(
    harness.issuedLeaseBuffers.every((buffer) =>
      buffer.every((byte) => byte === 0),
    ),
    true,
  );
});

test("완료된 candidate replay는 사라진 WIF binding을 승인 없이 복원하지 않는다", async () => {
  const fixture = await planFixture();
  const harness = executorHarness(fixture.repository);
  await harness.execute(fixture.planBinding);
  harness.revokeWifBinding();
  await assert.rejects(
    harness.execute(fixture.planBinding),
    /CANDIDATE_CANARY_WIF_READBACK_FAILED/u,
  );
  assert.equal(harness.wifApplyCount, 1);
  assert.equal(harness.applyCount, 1);
  assert.equal(harness.wifApprovalConsumeCount, 1);
});

test("중앙 Android reusable workflow는 main과 두 exact same-repo canary PR만 허용한다", async () => {
  for (const profile of ["react-native", "godot"]) {
    const repository = REPOSITORIES[profile];
    const { path, workflow } = await androidWorkflow(profile);
    const steps = workflow.jobs["submit-build-only"].steps;
    const inputGuard = steps.find(
      ({ name }) => name === "Validate immutable inputs",
    ).run;
    const identityGuard = steps.find(
      ({ name }) => name === "Resolve immutable workflow identity",
    ).run;
    const candidateHead =
      `seori/workflow-bundle-canary/${repository.repositoryId}/` +
      CANDIDATE_SOURCE_SHA.slice(0, 12);
    const common = {
      SOURCE_SHA: repository.sourceSha,
      WORKING_DIRECTORY: repository.workingDirectory,
      GITHUB_REPOSITORY: repository.fullName,
      REPOSITORY_ID: repository.repositoryId,
    };
    const main = runGuard(inputGuard, {
      ...common,
      CALLER_WORKFLOW_REF:
        `${repository.fullName}/.github/workflows/android-build-only.yml@` +
        "refs/heads/main",
      EVENT_NAME: "push",
      EVENT_REF: "refs/heads/main",
      PR_BASE_REF: "",
      PR_BASE_SHA: "",
      PR_HEAD_REF: "",
      PR_HEAD_REPOSITORY: "",
      PR_NUMBER: "",
    });
    assert.equal(main.status, 0, main.stderr);

    const pullRequestEnvironment = {
      ...common,
      CALLER_WORKFLOW_REF:
        `${repository.fullName}/.github/workflows/android-build-only.yml@` +
        "refs/pull/17/merge",
      EVENT_NAME: "pull_request",
      EVENT_REF: "refs/pull/17/merge",
      PR_BASE_REF: "main",
      PR_BASE_SHA: repository.sourceSha,
      PR_HEAD_REF: candidateHead,
      PR_HEAD_REPOSITORY: repository.fullName,
      PR_NUMBER: "17",
    };
    const exactCanary = runGuard(inputGuard, pullRequestEnvironment);
    assert.equal(exactCanary.status, 0, exactCanary.stderr);
    for (const attack of [
      { PR_BASE_SHA: "1".repeat(40) },
      { PR_HEAD_REPOSITORY: "attacker/fork" },
      { PR_HEAD_REF: `${candidateHead}-attacker` },
      { REPOSITORY_ID: "9999" },
    ]) {
      assert.notEqual(
        runGuard(inputGuard, {
          ...pullRequestEnvironment,
          ...attack,
        }).status,
        0,
        JSON.stringify(attack),
      );
    }

    const workflowRef = `seorilabs/.github/${path}@${CANDIDATE_SOURCE_SHA}`;
    const exactIdentity = runGuard(identityGuard, {
      EVENT_NAME: "pull_request",
      GITHUB_OUTPUT: "/dev/null",
      JOB_CONTEXT_JSON: JSON.stringify({
        workflow_ref: workflowRef,
        workflow_repository: "seorilabs/.github",
        workflow_sha: CANDIDATE_SOURCE_SHA,
      }),
      PR_HEAD_REF: candidateHead,
    });
    assert.equal(exactIdentity.status, 0, exactIdentity.stderr);
    assert.notEqual(
      runGuard(identityGuard, {
        EVENT_NAME: "pull_request",
        GITHUB_OUTPUT: "/dev/null",
        JOB_CONTEXT_JSON: JSON.stringify({
          workflow_ref: workflowRef,
          workflow_repository: "seorilabs/.github",
          workflow_sha: CANDIDATE_SOURCE_SHA,
        }),
        PR_HEAD_REF:
          `seori/workflow-bundle-canary/${repository.repositoryId}/` +
          "0".repeat(12),
      }).status,
      0,
    );
  }
});
