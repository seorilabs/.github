import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign as signEd25519,
} from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  computeFleetCoveragePageDigest,
  computeFleetEvidenceDigest,
  computeFleetFindingsDigest,
  computeFleetMigrationInventoryDigest,
  computeFleetMigrationOutageRecoveryDigest,
  computeFleetMigrationOwnerScopeDigest,
  computeFleetMigrationReplacementDigest,
  computeFleetRepositoryReadbackDigest,
  createFleetMigrationAttestationPayload,
  createFleetMigrationPlan,
  fleetMigrationContract,
  loadTrustedFleetMigrationInventoryBinding,
  validateFleetMigrationInventory,
  validateFleetMigrationPlan,
} from "../packages/repo-contract/src/fleet-migration.mjs";
import { runFleetCli } from "../packages/repo-contract/src/fleet-cli.mjs";

const ORGANIZATION_ID = "123456789";
const DETECTOR_SHA = "e".repeat(40);
const WORKFLOW_BUNDLE_SHA = "d".repeat(40);
const INVENTORY_KEY_ID = "fleet-inventory-key-0001";
const INVENTORY_POLICY_REVISION = "fleet-inventory-policy-0001";
const CAPTURED_AT = "2026-08-29T00:10:00.000Z";
const SIGNED_AT = "2026-08-29T00:11:00.000Z";
const EXPECTED_COUNTS = Object.freeze({
  activeRepositories: 38,
  legacyOperationJson: 73,
  workflowSecretsInherit: 108,
  workflowFloatingRef: 87,
});
const LEGACY_SCHEMA_IDS = Object.freeze({
  GOOGLE_PLAY:
    "https://seorilabs.github.io/contracts/v1/markets/google-play.schema.json",
  APP_STORE:
    "https://seorilabs.github.io/contracts/v1/markets/app-store.schema.json",
  APPS_IN_TOSS:
    "https://seorilabs.github.io/contracts/v1/markets/apps-in-toss.schema.json",
  MARKET_LAUNCH_STATE:
    "https://seorilabs.com/contracts/legacy/market-launch-state.v1.schema.json",
  PLATFORM_REGISTRY_APP:
    "https://seorilabs.com/contracts/legacy/platform-registry-app.v1.schema.json",
  BACKOFFICE_OPERATIONS:
    "https://seorilabs.com/contracts/legacy/backoffice-operations.v1.schema.json",
});
const INVENTORY_KEYS = generateKeyPairSync("ed25519");

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

function digest(value) {
  return `sha256:${createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex")}`;
}

function sha(value) {
  return createHash("sha1").update(value).digest("hex");
}

function evidence(value) {
  const result = structuredClone(value);
  result.evidenceDigest = computeFleetEvidenceDigest(result);
  return result;
}

function redigest(value) {
  value.evidenceDigest = computeFleetEvidenceDigest(value);
}

function evidenceId(prefix, seed) {
  return `${prefix}-${sha(seed).slice(0, 20)}`;
}

function repositoryIdentity(index) {
  return {
    id: String(1001 + index),
    fullName:
      index === 0
        ? "seorilabs/platform"
        : `seorilabs/app-${String(index).padStart(2, "0")}`,
    defaultRef: "refs/heads/main",
    sourceSha: sha(`source:${index}`),
    archived: false,
  };
}

function appIdForRepository(index) {
  return index === 0
    ? "platform-core"
    : `app-${String(index).padStart(2, "0")}`;
}

function configContext(
  targetRepository,
  appId,
  {
    snapshotSalt = "current",
    signatureKeyId = "snapshot-signing-key-0001",
    configPolicyRevision = "snapshot-policy-0001",
  } = {},
) {
  return {
    appId,
    configRevisionId: `config-revision-${appId}-${snapshotSalt}`,
    configRevisionDigest: digest(
      `config-revision:${appId}:${snapshotSalt}`,
    ),
    signedSnapshotDigest: digest(`signed-snapshot:${appId}:${snapshotSalt}`),
    signatureKeyId,
    policyRevision: configPolicyRevision,
    ownerId: "owner:seorilabs-fleet",
    repositoryId: targetRepository.id,
    sourceSha: targetRepository.sourceSha,
  };
}

function workflowNameForTarget(target) {
  return {
    ORG_CONTRACT_STATIC: "org-contract.yml",
    ANDROID: "build-android.yml",
    IOS: "build-ios.yml",
    APPS_IN_TOSS: "build-apps-in-toss.yml",
    WEB: "build-web.yml",
  }[target];
}

function buildTargetsForRepository(targetRepository) {
  return targetRepository.fullName === "seorilabs/app-01"
    ? ["ORG_CONTRACT_STATIC", "ANDROID"]
    : ["ORG_CONTRACT_STATIC"];
}

function completeProofs({
  targetRepository,
  appId,
  path,
  gitEntry,
  contentDigest,
  replacementDigest,
  operation,
  contextOptions,
}) {
  const token = `${targetRepository.id}:${appId}:${path}`;
  const context = configContext(
    targetRepository,
    appId,
    contextOptions,
  );
  const targets = buildTargetsForRepository(targetRepository);
  const marketBuildTargets = targets.filter(
    (target) => target !== "ORG_CONTRACT_STATIC",
  );
  const bindings = targets.map((target) => ({
    target,
    workflowRef: `seorilabs/.github/.github/workflows/${workflowNameForTarget(
      target,
    )}@${WORKFLOW_BUNDLE_SHA}`,
    builderDigest: digest(`builder:${target}`),
  }));
  const activeConfigReadback = evidence({
    observationId: evidenceId("active-config", token),
    observedAt: "2026-08-29T00:01:00.000Z",
    appId,
    repositoryId: targetRepository.id,
    sourceSha: targetRepository.sourceSha,
    configRevisionId: context.configRevisionId,
    configRevisionDigest: context.configRevisionDigest,
    signedSnapshotDigest: context.signedSnapshotDigest,
    signatureKeyId: context.signatureKeyId,
    policyRevision: context.policyRevision,
    ownerId: context.ownerId,
    state: "ACTIVE",
  });
  const marketProfileReadback = evidence({
    observationId: evidenceId("market-profile", token),
    observedAt: "2026-08-29T00:02:00.000Z",
    appId,
    repositoryId: targetRepository.id,
    sourceSha: targetRepository.sourceSha,
    configRevisionId: context.configRevisionId,
    state: "ACTIVE",
    marketBuildTargets,
  });
  const workflowBundleReadback = evidence({
    observationId: evidenceId("workflow-bundle", token),
    observedAt: "2026-08-29T00:03:00.000Z",
    appId,
    repositoryId: targetRepository.id,
    sourceSha: targetRepository.sourceSha,
    workflowBundleSha: WORKFLOW_BUNDLE_SHA,
    state: "APPROVED",
    bindings,
  });
  const parityOne = evidence({
    sequence: 1,
    observationId: evidenceId("parity-one", token),
    previousObservationId: null,
    observedAt: "2026-08-29T00:04:00.000Z",
    sourceSha: targetRepository.sourceSha,
    currentContentDigest: contentDigest,
    replacementDigest,
    state: "MATCH",
  });
  const parityTwo = evidence({
    sequence: 2,
    observationId: evidenceId("parity-two", token),
    previousObservationId: parityOne.observationId,
    observedAt: "2026-08-29T00:05:00.000Z",
    sourceSha: targetRepository.sourceSha,
    currentContentDigest: contentDigest,
    replacementDigest,
    state: "MATCH",
  });
  const buildOnly = targets.map((target, index) => {
    const binding = bindings[index];
    return evidence({
      target,
      runRepositoryId: targetRepository.id,
      runId: String(
        BigInt(`0x${sha(`run:${token}:${target}`).slice(0, 14)}`),
      ),
      runAttempt: 1,
      completedAt:
        index === 0
          ? "2026-08-29T00:06:00.000Z"
          : "2026-08-29T00:06:30.000Z",
      sourceSha: targetRepository.sourceSha,
      workflowBundleSha: WORKFLOW_BUNDLE_SHA,
      workflowRef: binding.workflowRef,
      builderDigest: binding.builderDigest,
      state: "PASSED",
      artifactDigest: digest(`artifact:${token}:${target}`),
    });
  });
  const gitRestore = evidence({
    sourceSha: targetRepository.sourceSha,
    path,
    originalGitEntry: gitEntry,
    originalContentDigest: contentDigest,
    state: "VERIFIED",
    restoreValidationId: evidenceId("git-restore", token),
    verifiedAt: "2026-08-29T00:07:00.000Z",
  });
  const backofficeOutageRecovery = evidence({
    appId,
    repositoryId: targetRepository.id,
    sourceSha: targetRepository.sourceSha,
    configRevisionId: context.configRevisionId,
    configRevisionDigest: context.configRevisionDigest,
    signedSnapshotDigest: context.signedSnapshotDigest,
    signatureKeyId: context.signatureKeyId,
    policyRevision: context.policyRevision,
    releaseReproductionDigest: computeFleetMigrationOutageRecoveryDigest({
      appId,
      repositoryId: targetRepository.id,
      sourceSha: targetRepository.sourceSha,
      configRevisionId: context.configRevisionId,
      configRevisionDigest: context.configRevisionDigest,
      signedSnapshotDigest: context.signedSnapshotDigest,
      signatureKeyId: context.signatureKeyId,
      policyRevision: context.policyRevision,
    }),
    state: "VERIFIED",
    verifiedAt: "2026-08-29T00:07:30.000Z",
  });
  const ownerGate = evidence({
    ownerId: context.ownerId,
    approvalId: evidenceId("owner-approval", token),
    scopeDigest: computeFleetMigrationOwnerScopeDigest({
      repositoryId: targetRepository.id,
      sourceSha: targetRepository.sourceSha,
      path,
      operation,
      replacementDigest,
      appId,
      configRevisionId: context.configRevisionId,
      configRevisionDigest: context.configRevisionDigest,
      signedSnapshotDigest: context.signedSnapshotDigest,
      signatureKeyId: context.signatureKeyId,
      policyRevision: context.policyRevision,
      ownerId: context.ownerId,
    }),
    state: "APPROVED",
    approvedAt: "2026-08-29T00:08:00.000Z",
  });
  const controlPlaneReadback = evidence({
    providerObservationId: evidenceId("provider-observation", token),
    providerObservationRevision: "1",
    gateLedgerId: evidenceId("gate-ledger", token),
    gateLedgerRevision: "1",
    observedAt: "2026-08-29T00:08:30.000Z",
    repositoryId: targetRepository.id,
    appId,
    sourceSha: targetRepository.sourceSha,
    configRevisionId: context.configRevisionId,
    configRevisionDigest: context.configRevisionDigest,
    signedSnapshotDigest: context.signedSnapshotDigest,
    signatureKeyId: context.signatureKeyId,
    policyRevision: context.policyRevision,
    ownerId: context.ownerId,
    replacementDigest,
    state: "MATCH",
  });
  const sourceReadback = evidence({
    observationId: evidenceId("source-readback", token),
    observedAt: "2026-08-29T00:09:00.000Z",
    repositoryId: targetRepository.id,
    sourceRef: targetRepository.defaultRef,
    sourceSha: targetRepository.sourceSha,
    path,
    gitEntry,
    contentDigest,
    state: "MATCH",
  });
  return {
    activeConfigReadback,
    marketProfileReadback,
    workflowBundleReadback,
    sourceReadback,
    parityStream: {
      streamId: evidenceId("parity-stream", token),
      observations: [parityOne, parityTwo],
    },
    buildOnly,
    rollback: { gitRestore, backofficeOutageRecovery, ownerGate },
    controlPlaneReadback,
  };
}

function legacyCandidate({
  targetRepository,
  appId,
  contract,
  path,
  contextOptions,
}) {
  const gitEntry = {
    kind: "BLOB",
    mode: "100644",
    objectSha: sha(`blob:${targetRepository.id}:${path}`),
  };
  const contentDigest = digest(
    `legacy-content:${targetRepository.id}:${path}`,
  );
  const context = configContext(
    targetRepository,
    appId,
    contextOptions,
  );
  const replacement = {
    type: "SIGNED_RESOLVED_MANIFEST",
    appId,
    configRevisionId: context.configRevisionId,
    configRevisionDigest: context.configRevisionDigest,
    signedSnapshotDigest: context.signedSnapshotDigest,
    signatureKeyId: context.signatureKeyId,
    policyRevision: context.policyRevision,
  };
  const replacementDigest = computeFleetMigrationReplacementDigest(replacement);
  return {
    path,
    gitEntry,
    contentDigest,
    detection: {
      type: "LEGACY_OPERATION_JSON",
      contract,
      schemaId: LEGACY_SCHEMA_IDS[contract],
      matchedBy: "SCHEMA_VALIDATION",
      detectorSha: DETECTOR_SHA,
    },
    replacement,
    proofs: completeProofs({
      targetRepository,
      appId,
      path,
      gitEntry,
      contentDigest,
      replacementDigest,
      operation: "DELETE",
      contextOptions,
    }),
  };
}

function workflowCandidates({
  targetRepository,
  appId,
  path,
  includeFloating,
  contextOptions,
}) {
  const gitEntry = {
    kind: "BLOB",
    mode: "100644",
    objectSha: sha(`blob:${targetRepository.id}:${path}`),
  };
  const contentDigest = digest(
    `workflow-content:${targetRepository.id}:${path}`,
  );
  const replacementBlobDigest = digest(
    `workflow-replacement:${targetRepository.id}:${path}`,
  );
  const proofs = completeProofs({
    targetRepository,
    appId,
    path,
    gitEntry,
    contentDigest,
    replacementDigest: replacementBlobDigest,
    operation: "REWRITE",
    contextOptions,
  });
  const secretCandidate = {
    path,
    gitEntry,
    contentDigest,
    detection: {
      type: "WORKFLOW_SECRETS_INHERIT",
      detectorSha: DETECTOR_SHA,
      occurrenceLines: [12],
    },
    replacement: {
      type: "EXPLICIT_SECRET_MAPPING",
      replacementBlobDigest,
      workflowBundleSha: WORKFLOW_BUNDLE_SHA,
      namedCredentialLogicalIds: ["shared/github/fleet-app"],
    },
    proofs,
  };
  if (!includeFloating) return [secretCandidate];
  const calledWorkflow =
    "seorilabs/.github/.github/workflows/org-contract.yml";
  return [
    secretCandidate,
    {
      path,
      gitEntry: structuredClone(gitEntry),
      contentDigest,
      detection: {
        type: "WORKFLOW_FLOATING_REF",
        detectorSha: DETECTOR_SHA,
        calledWorkflow,
        ref: "main",
        occurrenceLines: [8],
      },
      replacement: {
        type: "PINNED_WORKFLOW_CALLER",
        replacementBlobDigest,
        workflowBundleSha: WORKFLOW_BUNDLE_SHA,
        workflowRef: `${calledWorkflow}@${WORKFLOW_BUNDLE_SHA}`,
      },
      proofs: structuredClone(proofs),
    },
  ];
}

function countFindings(repositories) {
  const counts = {
    activeRepositories: repositories.length,
    legacyOperationJson: 0,
    workflowSecretsInherit: 0,
    workflowFloatingRef: 0,
  };
  for (const { candidates } of repositories) {
    for (const candidate of candidates) {
      if (candidate.detection.type === "LEGACY_OPERATION_JSON") {
        counts.legacyOperationJson += 1;
      } else if (candidate.detection.type === "WORKFLOW_SECRETS_INHERIT") {
        counts.workflowSecretsInherit += 1;
      } else if (candidate.detection.type === "WORKFLOW_FLOATING_REF") {
        counts.workflowFloatingRef += 1;
      }
    }
  }
  return counts;
}

function refreshInventoryReadbacks(inventory) {
  for (const entry of inventory.repositories) {
    entry.observation.findingsDigest = computeFleetFindingsDigest({
      repositoryId: entry.repository.id,
      sourceRef: entry.repository.defaultRef,
      sourceSha: entry.repository.sourceSha,
      treeSha: entry.observation.treeSha,
      candidates: entry.candidates,
    });
  }
  inventory.coverage.activeRepositoryCount = inventory.repositories.length;
  inventory.coverage.repositoriesDigest = computeFleetRepositoryReadbackDigest({
    organizationId: inventory.organization.id,
    repositories: inventory.repositories.map(({ repository }) => repository),
  });
  const pages = [];
  for (let start = 0; start < inventory.repositories.length; start += 20) {
    const pageNumber = pages.length + 1;
    const hasNext = start + 20 < inventory.repositories.length;
    const page = {
      pageNumber,
      requestCursor:
        pageNumber === 1
          ? null
          : `fleet-page-${String(pageNumber).padStart(4, "0")}`,
      responseNextCursor: hasNext
        ? `fleet-page-${String(pageNumber + 1).padStart(4, "0")}`
        : null,
      repositoryIds: inventory.repositories
        .slice(start, start + 20)
        .map(({ repository }) => repository.id),
    };
    page.pageDigest = computeFleetCoveragePageDigest({
      readbackId: inventory.coverage.readbackId,
      page,
    });
    pages.push(page);
  }
  inventory.coverage.pages = pages;
}

function signInventory(inventory) {
  inventory.attestation = null;
  const inventoryDigest = computeFleetMigrationInventoryDigest(inventory);
  const payload = createFleetMigrationAttestationPayload(inventory, {
    keyId: INVENTORY_KEY_ID,
    policyRevision: INVENTORY_POLICY_REVISION,
    signedAt: SIGNED_AT,
  });
  inventory.attestation = {
    algorithm: "Ed25519",
    keyId: INVENTORY_KEY_ID,
    policyRevision: INVENTORY_POLICY_REVISION,
    signedAt: SIGNED_AT,
    inventoryDigest,
    value: signEd25519(null, payload, INVENTORY_KEYS.privateKey).toString(
      "base64url",
    ),
  };
  return inventory;
}

function refreshAndSign(inventory) {
  refreshInventoryReadbacks(inventory);
  return signInventory(inventory);
}

function trustedBinding(inventory) {
  return loadTrustedFleetMigrationInventoryBinding({
    inventory,
    trustedInventoryKeys: new Map([
      [INVENTORY_KEY_ID, INVENTORY_KEYS.publicKey],
    ]),
  });
}

function makeFleetInventory(contextOptions = {}) {
  const repositories = Array.from({ length: 38 }, (_, index) => {
    const identity = repositoryIdentity(index);
    return {
      repository: identity,
      observation: {
        id: `discovery-observation-${String(index).padStart(4, "0")}`,
        observedAt: "2026-08-29T00:00:30.000Z",
        repositoryId: identity.id,
        sourceRef: identity.defaultRef,
        sourceSha: identity.sourceSha,
        treeSha: sha(`tree:${index}`),
        findingsDigest: digest(`pending-findings:${index}`),
      },
      candidates: [],
    };
  });
  for (let index = 1; index <= 13; index += 1) {
    const appId = `registry-${String(index).padStart(2, "0")}`;
    repositories[0].candidates.push(
      legacyCandidate({
        targetRepository: repositories[0].repository,
        appId,
        contract: "PLATFORM_REGISTRY_APP",
        path: `registry/apps/${appId}.json`,
        contextOptions,
      }),
    );
  }
  const legacyGroups = [
    ["GOOGLE_PLAY", "play-store/google-play.config.json", 20],
    ["APP_STORE", "app-store/app-store.config.json", 20],
    ["APPS_IN_TOSS", "apps-in-toss/apps-in-toss.config.json", 11],
    ["MARKET_LAUNCH_STATE", "release/market-launch-state.json", 6],
    ["BACKOFFICE_OPERATIONS", ".seorilabs/backoffice.json", 3],
  ];
  for (const [contract, path, count] of legacyGroups) {
    for (let index = 1; index <= count; index += 1) {
      repositories[index].candidates.push(
        legacyCandidate({
          targetRepository: repositories[index].repository,
          appId: appIdForRepository(index),
          contract,
          path,
          contextOptions,
        }),
      );
    }
  }
  for (let finding = 0; finding < 108; finding += 1) {
    const repositoryIndex = 1 + (finding % 37);
    const sequence = 1 + Math.floor(finding / 37);
    repositories[repositoryIndex].candidates.push(
      ...workflowCandidates({
        targetRepository: repositories[repositoryIndex].repository,
        appId: appIdForRepository(repositoryIndex),
        path: `.github/workflows/fleet-${String(sequence).padStart(2, "0")}.yml`,
        includeFloating: finding < 87,
        contextOptions,
      }),
    );
  }
  const inventory = {
    schemaVersion: 1,
    inventoryId: "fleet-inventory-20260829-0001",
    capturedAt: CAPTURED_AT,
    organization: { id: ORGANIZATION_ID, login: "seorilabs" },
    detector: {
      repositoryId: "999",
      fullName: "seorilabs/.github",
      sourceRef: "refs/heads/main",
      sourceSha: DETECTOR_SHA,
      contract: "fleet-migration-v1",
    },
    coverage: {
      provider: "GITHUB_APP_INSTALLATION_REPOSITORY_READBACK",
      readbackId: "github-fleet-readback-20260829-0001",
      observedAt: "2026-08-29T00:00:00.000Z",
      complete: true,
      nextCursor: null,
      activeRepositoryCount: 38,
      repositoriesDigest: digest("pending-repositories"),
      pages: [],
    },
    expectedCounts: structuredClone(EXPECTED_COUNTS),
    repositories,
    attestation: null,
  };
  assert.deepEqual(countFindings(repositories), EXPECTED_COUNTS);
  return refreshAndSign(inventory);
}

function readyFixture(contextOptions = {}) {
  const inventory = makeFleetInventory(contextOptions);
  const binding = trustedBinding(inventory);
  const plan = createFleetMigrationPlan(inventory, {
    trustedInventoryBinding: binding,
  });
  return { inventory, binding, plan };
}

function firstLegacy(inventory) {
  return inventory.repositories[0].candidates[0];
}

function firstAndroidCandidate(inventory) {
  return inventory.repositories[1].candidates[0];
}

function captureWriter() {
  let output = "";
  return {
    stream: {
      write(chunk) {
        output += String(chunk);
        return true;
      },
    },
    read() {
      return output;
    },
  };
}

test("서명된 전체 38-repo inventory만 READY plan을 만들고 동일 path finding을 하나로 합친다", () => {
  const { inventory, binding, plan } = readyFixture();

  assert.equal(validateFleetMigrationInventory(inventory).ok, true);
  assert.equal(plan.mode, "PLAN_ONLY");
  assert.equal(plan.executionAllowed, false);
  assert.equal(plan.outcome, "READY_FOR_REVIEW");
  assert.deepEqual(plan.reasonCodes, []);
  assert.deepEqual(plan.inventory.observedCounts, {
    ...EXPECTED_COUNTS,
    unclassified: 0,
  });
  assert.equal(plan.inventory.binding.state, "VERIFIED");
  const overlap = plan.repositories
    .flatMap(({ changes }) => changes)
    .find(({ categories }) => categories.length === 2);
  assert.deepEqual(overlap.categories, [
    "WORKFLOW_SECRETS_INHERIT",
    "WORKFLOW_FLOATING_REF",
  ]);
  assert.equal(overlap.findingCounts.workflowSecretsInherit, 1);
  assert.equal(overlap.findingCounts.workflowFloatingRef, 1);
  assert.equal(overlap.operation, "REWRITE");
  assert.match(overlap.replacementDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(
    validateFleetMigrationPlan(plan, {
      inventory,
      trustedInventoryBinding: binding,
    }).ok,
    true,
  );
  assert.deepEqual(validateFleetMigrationPlan(plan), {
    ok: false,
    diagnostics: ["PLAN_TRUSTED_INPUT_REQUIRED"],
  });
  assert.equal(fleetMigrationContract.executionAllowed, false);
});

test("축소 inventory와 끊긴 pagination cursor chain은 서명되어도 trusted binding을 얻지 못한다", () => {
  const shrunken = structuredClone(makeFleetInventory());
  shrunken.repositories = shrunken.repositories.slice(0, 1);
  shrunken.expectedCounts = countFindings(shrunken.repositories);
  refreshAndSign(shrunken);
  assert.throws(
    () => trustedBinding(shrunken),
    /FLEET_MIGRATION_INVENTORY_UNTRUSTED:.*INITIAL_BASELINE_MISMATCH/u,
  );
  const shrunkenPlan = createFleetMigrationPlan(shrunken);
  assert.notEqual(shrunkenPlan.outcome, "READY_FOR_REVIEW");
  assert.ok(shrunkenPlan.reasonCodes.includes("INITIAL_BASELINE_MISMATCH"));

  const brokenPagination = structuredClone(makeFleetInventory());
  brokenPagination.coverage.pages[0].responseNextCursor = "wrong-cursor-0001";
  signInventory(brokenPagination);
  assert.throws(
    () => trustedBinding(brokenPagination),
    /INVENTORY_PAGINATION_CHAIN_MISMATCH/u,
  );
});

test("planDigest를 다시 계산해도 trusted inventory 없이 READY를 자기 승인할 수 없다", () => {
  const { inventory, plan: readyPlan } = readyFixture();
  const blockedPlan = createFleetMigrationPlan(inventory);
  const forged = structuredClone(blockedPlan);
  forged.inventory.binding = structuredClone(readyPlan.inventory.binding);
  forged.outcome = "READY_FOR_REVIEW";
  forged.reasonCodes = [];
  for (let index = 0; index < forged.repositories.length; index += 1) {
    forged.repositories[index].outcome = "READY_FOR_REVIEW";
    forged.repositories[index].reasonCodes = [];
    for (
      let changeIndex = 0;
      changeIndex < forged.repositories[index].changes.length;
      changeIndex += 1
    ) {
      const change = forged.repositories[index].changes[changeIndex];
      const trustedChange = readyPlan.repositories[index].changes[changeIndex];
      change.outcome = "READY_FOR_REVIEW";
      change.reasonCodes = [];
      change.idempotencyKey = trustedChange.idempotencyKey;
    }
  }
  const { planDigest: _oldDigest, ...unsigned } = forged;
  forged.planDigest = digest(unsigned);

  assert.deepEqual(validateFleetMigrationPlan(forged), {
    ok: false,
    diagnostics: ["PLAN_TRUSTED_INPUT_REQUIRED"],
  });
});

test("traversal 및 dot segment path는 schema 단계에서 fail-closed한다", () => {
  for (const unsafePath of [
    "../credential.json",
    "foo/../../bar.json",
    "./play-store/google-play.config.json",
  ]) {
    const inventory = structuredClone(makeFleetInventory());
    firstLegacy(inventory).path = unsafePath;
    assert.equal(validateFleetMigrationInventory(inventory).ok, false);
    assert.throws(
      () => createFleetMigrationPlan(inventory),
      /FLEET_MIGRATION_INVENTORY_INVALID/u,
    );
  }
});

test("symlink과 submodule git entry는 schema 단계에서 fail-closed한다", () => {
  for (const gitEntry of [
    { kind: "BLOB", mode: "120000", objectSha: sha("symlink") },
    { kind: "COMMIT", mode: "160000", objectSha: sha("submodule") },
  ]) {
    const inventory = structuredClone(makeFleetInventory());
    firstLegacy(inventory).gitEntry = gitEntry;
    assert.equal(validateFleetMigrationInventory(inventory).ok, false);
    assert.throws(
      () => createFleetMigrationPlan(inventory),
      /FLEET_MIGRATION_INVENTORY_INVALID/u,
    );
  }
});

test("대소문자 path 충돌과 같은 path의 서로 다른 final digest를 차단한다", () => {
  const caseCollision = structuredClone(makeFleetInventory());
  const workflowCandidatesInRepo = caseCollision.repositories[1].candidates.filter(
    ({ detection }) => detection.type === "WORKFLOW_SECRETS_INHERIT",
  );
  const moved = workflowCandidatesInRepo[1];
  moved.path = ".github/workflows/FLEET-01.yml";
  moved.proofs.sourceReadback.path = moved.path;
  redigest(moved.proofs.sourceReadback);
  moved.proofs.rollback.gitRestore.path = moved.path;
  redigest(moved.proofs.rollback.gitRestore);
  refreshAndSign(caseCollision);
  const casePlan = createFleetMigrationPlan(caseCollision, {
    trustedInventoryBinding: trustedBinding(caseCollision),
  });
  assert.ok(casePlan.reasonCodes.includes("PATH_CANONICAL_COLLISION"));
  assert.notEqual(casePlan.outcome, "READY_FOR_REVIEW");

  const replacementCollision = structuredClone(makeFleetInventory());
  const overlap = replacementCollision.repositories
    .flatMap(({ candidates }) => candidates)
    .find(
      ({ detection }) => detection.type === "WORKFLOW_FLOATING_REF",
    );
  overlap.replacement.replacementBlobDigest = digest("different-final-blob");
  refreshAndSign(replacementCollision);
  const replacementPlan = createFleetMigrationPlan(replacementCollision, {
    trustedInventoryBinding: trustedBinding(replacementCollision),
  });
  assert.ok(replacementPlan.reasonCodes.includes("PATH_REPLACEMENT_COLLISION"));
  assert.notEqual(replacementPlan.outcome, "READY_FOR_REVIEW");
});

test("resolved manifest digest는 revision, signed snapshot, signing key와 policy를 모두 결합한다", () => {
  const { plan: initialPlan } = readyFixture();
  const initialReplacement = firstLegacy(makeFleetInventory()).replacement;
  for (const [field, nextValue] of [
    ["configRevisionId", "config-revision-different-0001"],
    ["configRevisionDigest", digest("different-config-revision")],
    ["signedSnapshotDigest", digest("different-signed-snapshot")],
    ["signatureKeyId", "snapshot-signing-key-0002"],
    ["policyRevision", "snapshot-policy-0002"],
  ]) {
    const changed = { ...initialReplacement, [field]: nextValue };
    assert.notEqual(
      computeFleetMigrationReplacementDigest(changed),
      computeFleetMigrationReplacementDigest(initialReplacement),
      field,
    );
  }

  const { plan: nextPlan } = readyFixture({
    snapshotSalt: "next",
    signatureKeyId: "snapshot-signing-key-0002",
    configPolicyRevision: "snapshot-policy-0002",
  });
  const initialChange = initialPlan.repositories[0].changes[0];
  const nextChange = nextPlan.repositories[0].changes[0];
  assert.notEqual(initialChange.replacementDigest, nextChange.replacementDigest);
  assert.notEqual(initialChange.idempotencyKey, nextChange.idempotencyKey);
});

test("parity는 trusted stream의 최신 contiguous MATCH 두 건과 previous ID chain을 요구한다", () => {
  const intermediateMismatch = structuredClone(makeFleetInventory());
  const candidate = firstLegacy(intermediateMismatch);
  const first = candidate.proofs.parityStream.observations[0];
  const mismatch = evidence({
    sequence: 2,
    observationId: evidenceId("parity-mismatch", candidate.path),
    previousObservationId: first.observationId,
    observedAt: "2026-08-29T00:04:30.000Z",
    sourceSha: first.sourceSha,
    currentContentDigest: first.currentContentDigest,
    replacementDigest: first.replacementDigest,
    state: "MISMATCH",
  });
  const latest = candidate.proofs.parityStream.observations[1];
  latest.sequence = 3;
  latest.previousObservationId = mismatch.observationId;
  redigest(latest);
  candidate.proofs.parityStream.observations = [first, mismatch, latest];
  refreshAndSign(intermediateMismatch);
  const mismatchPlan = createFleetMigrationPlan(intermediateMismatch, {
    trustedInventoryBinding: trustedBinding(intermediateMismatch),
  });
  assert.ok(
    mismatchPlan.reasonCodes.includes(
      "PARITY_REQUIRES_LATEST_CONTIGUOUS_MATCHES",
    ),
  );

  const brokenChain = structuredClone(makeFleetInventory());
  const broken = firstLegacy(brokenChain).proofs.parityStream.observations[1];
  broken.previousObservationId = "parity-observation-missing";
  redigest(broken);
  refreshAndSign(brokenChain);
  const brokenPlan = createFleetMigrationPlan(brokenChain, {
    trustedInventoryBinding: trustedBinding(brokenChain),
  });
  assert.ok(brokenPlan.reasonCodes.includes("PARITY_STREAM_MISMATCH"));
});

test("required build target은 ACTIVE MarketProfile에서 도출하고 approved bundle/run identity를 대조한다", () => {
  const missingIos = structuredClone(makeFleetInventory());
  const candidate = firstAndroidCandidate(missingIos);
  candidate.proofs.marketProfileReadback.marketBuildTargets.push("IOS");
  redigest(candidate.proofs.marketProfileReadback);
  refreshAndSign(missingIos);
  const missingPlan = createFleetMigrationPlan(missingIos, {
    trustedInventoryBinding: trustedBinding(missingIos),
  });
  const changed = missingPlan.repositories[1].changes.find(
    ({ path }) => path === candidate.path,
  );
  assert.deepEqual(changed.requiredBuildTargets, [
    "ORG_CONTRACT_STATIC",
    "ANDROID",
    "IOS",
  ]);
  assert.ok(changed.reasonCodes.includes("WORKFLOW_BUNDLE_READBACK_MISMATCH"));
  assert.ok(changed.reasonCodes.includes("BUILD_ONLY_MISMATCH"));

  const wrongRunRepository = structuredClone(makeFleetInventory());
  const wrongBuild = firstAndroidCandidate(wrongRunRepository).proofs.buildOnly[0];
  wrongBuild.runRepositoryId = "999999";
  redigest(wrongBuild);
  refreshAndSign(wrongRunRepository);
  const wrongRunPlan = createFleetMigrationPlan(wrongRunRepository, {
    trustedInventoryBinding: trustedBinding(wrongRunRepository),
  });
  assert.ok(wrongRunPlan.reasonCodes.includes("BUILD_ONLY_MISMATCH"));
});

test("workflow run attempt, artifact, workflow, builder와 control revisions는 proof/idempotency에 결합된다", () => {
  const { plan: baselinePlan } = readyFixture();
  const baselineChange = baselinePlan.repositories[0].changes[0];
  const mutations = [
    (candidate) => {
      candidate.proofs.buildOnly[0].runAttempt = 2;
      redigest(candidate.proofs.buildOnly[0]);
    },
    (candidate) => {
      candidate.proofs.buildOnly[0].artifactDigest = digest("new-artifact");
      redigest(candidate.proofs.buildOnly[0]);
    },
    (candidate) => {
      const workflowRef = `seorilabs/.github/.github/workflows/check-release.yml@${WORKFLOW_BUNDLE_SHA}`;
      candidate.proofs.workflowBundleReadback.bindings[0].workflowRef = workflowRef;
      candidate.proofs.buildOnly[0].workflowRef = workflowRef;
      redigest(candidate.proofs.workflowBundleReadback);
      redigest(candidate.proofs.buildOnly[0]);
    },
    (candidate) => {
      const builderDigest = digest("new-builder");
      candidate.proofs.workflowBundleReadback.bindings[0].builderDigest = builderDigest;
      candidate.proofs.buildOnly[0].builderDigest = builderDigest;
      redigest(candidate.proofs.workflowBundleReadback);
      redigest(candidate.proofs.buildOnly[0]);
    },
    (candidate) => {
      candidate.proofs.controlPlaneReadback.providerObservationRevision = "2";
      candidate.proofs.controlPlaneReadback.gateLedgerRevision = "2";
      redigest(candidate.proofs.controlPlaneReadback);
    },
  ];
  for (const mutate of mutations) {
    const inventory = structuredClone(makeFleetInventory());
    mutate(firstLegacy(inventory));
    refreshAndSign(inventory);
    const plan = createFleetMigrationPlan(inventory, {
      trustedInventoryBinding: trustedBinding(inventory),
    });
    assert.equal(plan.outcome, "READY_FOR_REVIEW");
    const change = plan.repositories[0].changes[0];
    assert.notEqual(change.proofDigest, baselineChange.proofDigest);
    assert.notEqual(change.idempotencyKey, baselineChange.idempotencyKey);
  }
});

test("Git restore, signed ACTIVE outage recovery, owner gate와 control-plane readback은 독립 gate다", () => {
  const cases = [
    [
      (candidate) => {
        candidate.proofs.rollback.gitRestore = null;
      },
      "GIT_ROLLBACK_MISSING",
    ],
    [
      (candidate) => {
        candidate.proofs.rollback.backofficeOutageRecovery = null;
      },
      "OUTAGE_RECOVERY_MISSING",
    ],
    [
      (candidate) => {
        candidate.proofs.rollback.ownerGate = null;
      },
      "OWNER_GATE_MISSING",
    ],
    [
      (candidate) => {
        candidate.proofs.controlPlaneReadback = null;
      },
      "CONTROL_PLANE_READBACK_MISSING",
    ],
  ];
  for (const [mutate, expectedReason] of cases) {
    const inventory = structuredClone(makeFleetInventory());
    mutate(firstLegacy(inventory));
    refreshAndSign(inventory);
    const plan = createFleetMigrationPlan(inventory, {
      trustedInventoryBinding: trustedBinding(inventory),
    });
    assert.ok(plan.reasonCodes.includes(expectedReason), expectedReason);
    assert.notEqual(plan.outcome, "READY_FOR_REVIEW");
  }

  const wrongReproduction = structuredClone(makeFleetInventory());
  const outage = firstLegacy(wrongReproduction).proofs.rollback
    .backofficeOutageRecovery;
  outage.releaseReproductionDigest = digest("unbound-outage-reproduction");
  redigest(outage);
  refreshAndSign(wrongReproduction);
  const plan = createFleetMigrationPlan(wrongReproduction, {
    trustedInventoryBinding: trustedBinding(wrongReproduction),
  });
  assert.ok(plan.reasonCodes.includes("OUTAGE_RECOVERY_MISMATCH"));
});

test("evidenceDigest가 실제 attested evidence와 다르면 root signature가 유효해도 차단한다", () => {
  const inventory = structuredClone(makeFleetInventory());
  firstLegacy(inventory).proofs.activeConfigReadback.evidenceDigest = digest(
    "forged-evidence-digest",
  );
  refreshAndSign(inventory);
  const plan = createFleetMigrationPlan(inventory, {
    trustedInventoryBinding: trustedBinding(inventory),
  });
  assert.ok(plan.reasonCodes.includes("EVIDENCE_DIGEST_MISMATCH"));
  assert.notEqual(plan.outcome, "READY_FOR_REVIEW");
});

test("legacy JSON은 contract별 exact path와 schema ID만 허용한다", () => {
  const wrongPath = structuredClone(makeFleetInventory());
  const pathCandidate = wrongPath.repositories[1].candidates.find(
    ({ detection }) =>
      detection.type === "LEGACY_OPERATION_JSON" &&
      detection.contract === "GOOGLE_PLAY",
  );
  pathCandidate.path = "play-store/google-play.example.json";
  pathCandidate.proofs.sourceReadback.path = pathCandidate.path;
  redigest(pathCandidate.proofs.sourceReadback);
  pathCandidate.proofs.rollback.gitRestore.path = pathCandidate.path;
  redigest(pathCandidate.proofs.rollback.gitRestore);
  refreshAndSign(wrongPath);
  const wrongPathPlan = createFleetMigrationPlan(wrongPath, {
    trustedInventoryBinding: trustedBinding(wrongPath),
  });
  assert.ok(wrongPathPlan.reasonCodes.includes("DETECTION_PATH_MISMATCH"));

  const wrongSchema = structuredClone(makeFleetInventory());
  const schemaCandidate = firstLegacy(wrongSchema);
  schemaCandidate.detection.schemaId =
    "https://seorilabs.com/contracts/legacy/not-the-contract.schema.json";
  refreshAndSign(wrongSchema);
  const wrongSchemaPlan = createFleetMigrationPlan(wrongSchema, {
    trustedInventoryBinding: trustedBinding(wrongSchema),
  });
  assert.ok(wrongSchemaPlan.reasonCodes.includes("DETECTION_SCHEMA_MISMATCH"));

  const wrongRegistryPath = structuredClone(makeFleetInventory());
  const registryCandidate = firstLegacy(wrongRegistryPath);
  registryCandidate.path = "registry/apps/a-different-app.json";
  registryCandidate.proofs.sourceReadback.path = registryCandidate.path;
  redigest(registryCandidate.proofs.sourceReadback);
  registryCandidate.proofs.rollback.gitRestore.path = registryCandidate.path;
  redigest(registryCandidate.proofs.rollback.gitRestore);
  refreshAndSign(wrongRegistryPath);
  const wrongRegistryPlan = createFleetMigrationPlan(wrongRegistryPath, {
    trustedInventoryBinding: trustedBinding(wrongRegistryPath),
  });
  assert.ok(wrongRegistryPlan.reasonCodes.includes("DETECTION_PATH_MISMATCH"));
});

test("inventory signature와 trusted key가 다르면 binding을 발급하지 않는다", () => {
  const inventory = makeFleetInventory();
  const otherKey = generateKeyPairSync("ed25519");
  assert.throws(
    () =>
      loadTrustedFleetMigrationInventoryBinding({
        inventory,
        trustedInventoryKeys: new Map([
          [INVENTORY_KEY_ID, otherKey.publicKey],
        ]),
      }),
    /FLEET_MIGRATION_INVENTORY_SIGNATURE_INVALID/u,
  );
  inventory.repositories[0].repository.sourceSha = sha("tampered-source");
  assert.throws(
    () => trustedBinding(inventory),
    /FLEET_MIGRATION_INVENTORY_UNTRUSTED|FLEET_MIGRATION_INVENTORY_DIGEST_MISMATCH/u,
  );
});

test("migration CLI는 plan을 stdout으로만 내보내고 symlink/기존 파일을 덮어쓰지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-migration-cli-"));
  try {
    const inventoryPath = join(root, "inventory.json");
    const protectedPath = join(root, "protected.json");
    const symlinkPath = join(root, "plan.json");
    await writeFile(
      inventoryPath,
      `${JSON.stringify(makeFleetInventory())}\n`,
      "utf8",
    );
    await writeFile(protectedPath, "do-not-overwrite\n", "utf8");
    await symlink(protectedPath, symlinkPath);
    const stdout = captureWriter();
    const stderr = captureWriter();
    const rejected = await runFleetCli({
      argv: [
        "plan-migration",
        "--inventory",
        inventoryPath,
        "--output",
        symlinkPath,
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(rejected, 1);
    assert.match(stderr.read(), /MIGRATION_STDOUT_ONLY/u);
    assert.equal(await readFile(protectedPath, "utf8"), "do-not-overwrite\n");

    const emitted = captureWriter();
    const accepted = await runFleetCli({
      argv: ["plan-migration", "--inventory", inventoryPath],
      stdout: emitted.stream,
      stderr: captureWriter().stream,
    });
    assert.equal(accepted, 0);
    const plan = JSON.parse(emitted.read());
    assert.equal(plan.mode, "PLAN_ONLY");
    assert.equal(plan.outcome, "BLOCKED");
    assert.ok(
      plan.reasonCodes.includes("TRUSTED_INVENTORY_BINDING_MISSING"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
