import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  computeFleetFindingsDigest,
  computeFleetRepositoryReadbackDigest,
  createFleetMigrationPlan,
  fleetMigrationContract,
  validateFleetMigrationInventory,
  validateFleetMigrationPlan,
} from "../packages/repo-contract/src/fleet-migration.mjs";
import { runFleetCli } from "../packages/repo-contract/src/fleet-cli.mjs";

const SOURCE_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const BLOB_SHA = "c".repeat(40);
const WORKFLOW_BUNDLE_SHA = "d".repeat(40);
const DETECTOR_SHA = "e".repeat(40);
const ORGANIZATION_ID = "123456789";

function digest(value) {
  return `sha256:${createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex")}`;
}

function repository(overrides = {}) {
  return {
    id: "101",
    fullName: "seorilabs/happy-farm",
    defaultRef: "refs/heads/main",
    sourceSha: SOURCE_SHA,
    archived: false,
    ...overrides,
  };
}

function completeProofs({
  repository: targetRepository,
  path,
  blobSha,
  contentDigest,
  replacementDigest,
  requiredBuildTargets = ["ORG_CONTRACT_STATIC"],
  workflowBundleSha = WORKFLOW_BUNDLE_SHA,
}) {
  return {
    sourceReadback: {
      observationId: "source-readback-0001",
      observedAt: "2026-08-29T00:07:30.000Z",
      repositoryId: targetRepository.id,
      sourceRef: targetRepository.defaultRef,
      sourceSha: targetRepository.sourceSha,
      path,
      blobSha,
      contentDigest,
      state: "MATCH",
      evidenceDigest: digest("source-readback"),
    },
    parity: [
      {
        sequence: 1,
        observationId: "parity-observation-0001",
        observedAt: "2026-08-29T00:02:00.000Z",
        sourceSha: targetRepository.sourceSha,
        currentContentDigest: contentDigest,
        replacementDigest,
        state: "MATCH",
        evidenceDigest: digest("parity-1"),
      },
      {
        sequence: 2,
        observationId: "parity-observation-0002",
        observedAt: "2026-08-29T00:03:00.000Z",
        sourceSha: targetRepository.sourceSha,
        currentContentDigest: contentDigest,
        replacementDigest,
        state: "MATCH",
        evidenceDigest: digest("parity-2"),
      },
    ],
    buildOnly: requiredBuildTargets.map((target, index) => ({
      target,
      runId: String(9000 + index),
      completedAt: `2026-08-29T00:0${4 + index}:00.000Z`,
      sourceSha: targetRepository.sourceSha,
      workflowBundleSha,
      state: "PASSED",
      artifactDigest: digest(`artifact-${target}`),
      evidenceDigest: digest(`build-${target}`),
    })),
    rollback: {
      method: "GIT_REVERT",
      sourceSha: targetRepository.sourceSha,
      path,
      originalBlobSha: blobSha,
      originalContentDigest: contentDigest,
      state: "VERIFIED",
      restoreValidationId: "rollback-check-0001",
      verifiedAt: "2026-08-29T00:06:00.000Z",
      evidenceDigest: digest("rollback"),
    },
    controlPlaneReadback: {
      observationId: "control-plane-readback-0001",
      observedAt: "2026-08-29T00:07:00.000Z",
      repositoryId: targetRepository.id,
      sourceSha: targetRepository.sourceSha,
      replacementDigest,
      state: "MATCH",
      evidenceDigest: digest("control-plane"),
    },
  };
}

function legacyCandidate({ targetRepository = repository() } = {}) {
  const path = "play-store/google-play.config.json";
  const contentDigest = digest("legacy-google-play-config");
  const replacement = {
    type: "SIGNED_RESOLVED_MANIFEST",
    configRevisionId: "config-revision-0001",
    configRevisionDigest: digest("config-revision"),
    signedSnapshotDigest: digest("signed-config-snapshot"),
  };
  return {
    path,
    blobSha: BLOB_SHA,
    contentDigest,
    detection: {
      type: "LEGACY_OPERATION_JSON",
      contract: "GOOGLE_PLAY",
      matchedBy: "SCHEMA_VALIDATION",
      detectorSha: DETECTOR_SHA,
    },
    requiredBuildTargets: ["ORG_CONTRACT_STATIC"],
    replacement,
    proofs: completeProofs({
      repository: targetRepository,
      path,
      blobSha: BLOB_SHA,
      contentDigest,
      replacementDigest: replacement.configRevisionDigest,
    }),
  };
}

function secretsInheritCandidate({ targetRepository = repository() } = {}) {
  const path = ".github/workflows/deploy.yml";
  const blobSha = "f".repeat(40);
  const contentDigest = digest("workflow-with-inherit");
  const replacement = {
    type: "EXPLICIT_SECRET_MAPPING",
    replacementBlobDigest: digest("explicit-secret-workflow"),
    workflowBundleSha: WORKFLOW_BUNDLE_SHA,
    namedCredentialLogicalIds: [
      "shared/google-play/publisher",
      "shared/gcp/cloud-build",
    ],
  };
  return {
    path,
    blobSha,
    contentDigest,
    detection: {
      type: "WORKFLOW_SECRETS_INHERIT",
      detectorSha: DETECTOR_SHA,
      occurrenceLines: [18, 12],
    },
    requiredBuildTargets: ["ANDROID", "ORG_CONTRACT_STATIC"],
    replacement,
    proofs: completeProofs({
      repository: targetRepository,
      path,
      blobSha,
      contentDigest,
      replacementDigest: replacement.replacementBlobDigest,
      requiredBuildTargets: ["ANDROID", "ORG_CONTRACT_STATIC"],
    }),
  };
}

function inventory({
  repositories = [
    {
      repository: repository(),
      observation: {
        id: "discovery-observation-0001",
        observedAt: "2026-08-29T00:00:00.000Z",
        repositoryId: "101",
        sourceRef: "refs/heads/main",
        sourceSha: SOURCE_SHA,
        treeSha: TREE_SHA,
      },
      candidates: [legacyCandidate()],
    },
  ],
  expectedCounts,
  coverage = {},
} = {}) {
  const normalizedRepositories = repositories.map((entry) => {
    const normalized = structuredClone(entry);
    normalized.observation.findingsDigest ??= computeFleetFindingsDigest({
      repositoryId: normalized.repository.id,
      sourceRef: normalized.repository.defaultRef,
      sourceSha: normalized.repository.sourceSha,
      treeSha: normalized.observation.treeSha,
      candidates: normalized.candidates,
    });
    return normalized;
  });
  const identities = normalizedRepositories.map(
    ({ repository: identity }) => identity,
  );
  const counts = normalizedRepositories.reduce(
    (result, { candidates }) => {
      for (const candidate of candidates) {
        if (candidate.detection.type === "LEGACY_OPERATION_JSON") {
          result.legacyOperationJson += 1;
        } else if (candidate.detection.type === "WORKFLOW_SECRETS_INHERIT") {
          result.workflowSecretsInherit += 1;
        } else if (candidate.detection.type === "WORKFLOW_FLOATING_REF") {
          result.workflowFloatingRef += 1;
        }
      }
      return result;
    },
    {
      activeRepositories: normalizedRepositories.length,
      legacyOperationJson: 0,
      workflowSecretsInherit: 0,
      workflowFloatingRef: 0,
    },
  );
  return {
    schemaVersion: 1,
    inventoryId: "fleet-inventory-0001",
    capturedAt: "2026-08-29T00:08:00.000Z",
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
      readbackId: "github-coverage-readback-0001",
      observedAt: "2026-08-29T00:00:00.000Z",
      complete: true,
      nextCursor: null,
      activeRepositoryCount: normalizedRepositories.length,
      repositoriesDigest: computeFleetRepositoryReadbackDigest({
        organizationId: ORGANIZATION_ID,
        repositories: identities,
      }),
      ...coverage,
    },
    expectedCounts: expectedCounts ?? counts,
    repositories: normalizedRepositories,
  };
}

test("모든 증거가 exact match여도 P7 결과는 실행 불가 검토 plan이다", () => {
  const plan = createFleetMigrationPlan(inventory());

  assert.equal(plan.mode, "PLAN_ONLY");
  assert.equal(plan.executionAllowed, false);
  assert.equal(plan.outcome, "READY_FOR_REVIEW");
  assert.deepEqual(plan.reasonCodes, []);
  assert.equal(plan.repositories[0].changes[0].operation, "DELETE");
  assert.equal(plan.repositories[0].changes[0].outcome, "READY_FOR_REVIEW");
  assert.equal(validateFleetMigrationPlan(plan).ok, true);
  assert.equal(fleetMigrationContract.prohibitedOperations.includes("file-delete"), true);
  assert.deepEqual(fleetMigrationContract.initialBaseline.expectedCounts, {
    activeRepositories: 38,
    legacyOperationJson: 73,
    workflowSecretsInherit: 108,
    workflowFloatingRef: 87,
  });
  assert.equal(Object.isFrozen(plan), true);
});

test("parity, build-only, rollback, readback이 빠지면 삭제 후보는 BLOCKED다", () => {
  const value = inventory();
  value.repositories[0].candidates[0].proofs = {
    sourceReadback: null,
    parity: [],
    buildOnly: [],
    rollback: null,
    controlPlaneReadback: null,
  };

  const change = createFleetMigrationPlan(value).repositories[0].changes[0];
  assert.equal(change.outcome, "BLOCKED");
  assert.deepEqual(change.reasonCodes, [
    "BUILD_ONLY_MISSING",
    "CONTROL_PLANE_READBACK_MISSING",
    "PARITY_REQUIRES_TWO_MATCHES",
    "ROLLBACK_MISSING",
    "SOURCE_READBACK_MISSING",
  ]);
});

test("source readback이 repo ID, ref, SHA, blob과 다르면 fail-closed다", () => {
  const value = inventory();
  value.repositories[0].candidates[0].proofs.sourceReadback.sourceSha =
    "9".repeat(40);

  const plan = createFleetMigrationPlan(value);
  assert.equal(plan.outcome, "BLOCKED");
  assert.equal(
    plan.reasonCodes.includes("SOURCE_READBACK_MISMATCH"),
    true,
  );
});

test("source readback이 build와 control-plane 증거보다 오래되면 fail-closed다", () => {
  const value = inventory();
  value.repositories[0].candidates[0].proofs.sourceReadback.observedAt =
    "2026-08-29T00:01:00.000Z";

  const plan = createFleetMigrationPlan(value);
  assert.equal(plan.outcome, "BLOCKED");
  assert.equal(plan.reasonCodes.includes("SOURCE_READBACK_MISMATCH"), true);
});

test("discovery observation 자체가 default ref exact source와 다르면 중단한다", () => {
  const value = inventory();
  value.repositories[0].observation.sourceRef = "refs/heads/develop";

  const plan = createFleetMigrationPlan(value);
  assert.equal(plan.outcome, "BLOCKED");
  assert.equal(
    plan.reasonCodes.includes("OBSERVATION_SOURCE_MISMATCH"),
    true,
  );
});

test("같은 개수를 유지해도 findings path/blob 집합 digest가 다르면 중단한다", () => {
  const value = inventory();
  value.repositories[0].observation.findingsDigest = digest(
    "different-findings",
  );

  const plan = createFleetMigrationPlan(value);
  assert.equal(plan.outcome, "BLOCKED");
  assert.equal(
    plan.reasonCodes.includes("OBSERVATION_FINDINGS_DIGEST_MISMATCH"),
    true,
  );
});

test("후보를 분류한 detector SHA가 중앙 exact source와 다르면 중단한다", () => {
  const value = inventory();
  const repositoryObservation = value.repositories[0];
  repositoryObservation.candidates[0].detection.detectorSha = "9".repeat(40);
  repositoryObservation.observation.findingsDigest = computeFleetFindingsDigest({
    repositoryId: repositoryObservation.repository.id,
    sourceRef: repositoryObservation.repository.defaultRef,
    sourceSha: repositoryObservation.repository.sourceSha,
    treeSha: repositoryObservation.observation.treeSha,
    candidates: repositoryObservation.candidates,
  });

  const plan = createFleetMigrationPlan(value);
  assert.equal(plan.outcome, "BLOCKED");
  assert.equal(plan.reasonCodes.includes("DETECTOR_SOURCE_MISMATCH"), true);
});

test("전체 페이지 coverage와 기대 개수가 맞지 않으면 NEEDS_INPUT이다", () => {
  const value = inventory({
    coverage: { complete: false, nextCursor: "next-page" },
    expectedCounts: {
      activeRepositories: 38,
      legacyOperationJson: 73,
      workflowSecretsInherit: 108,
      workflowFloatingRef: 87,
    },
  });

  const plan = createFleetMigrationPlan(value);
  assert.equal(plan.outcome, "NEEDS_INPUT");
  assert.equal(
    plan.reasonCodes.includes("INVENTORY_COVERAGE_INCOMPLETE"),
    true,
  );
  assert.equal(
    plan.reasonCodes.includes("ACTIVE_REPOSITORY_COUNT_MISMATCH"),
    true,
  );
  assert.equal(plan.reasonCodes.includes("CANDIDATE_COUNT_MISMATCH"), true);
});

test("repository list digest drift는 누락으로 추측하지 않고 BLOCKED다", () => {
  const value = inventory();
  value.coverage.repositoriesDigest = digest("different-repository-list");

  const plan = createFleetMigrationPlan(value);
  assert.equal(plan.outcome, "BLOCKED");
  assert.deepEqual(plan.reasonCodes, [
    "INVENTORY_REPOSITORY_DIGEST_MISMATCH",
  ]);
});

test("분류가 모호한 후보와 path-contract 불일치는 NEEDS_INPUT이다", () => {
  const value = inventory();
  const candidate = value.repositories[0].candidates[0];
  candidate.detection = {
    type: "UNCLASSIFIED",
    detectorSha: DETECTOR_SHA,
    reason: "MULTIPLE_MATCHES",
    candidateKinds: ["LEGACY_OPERATION_JSON", "WORKFLOW_FLOATING_REF"],
  };
  candidate.replacement = null;
  candidate.proofs = {
    sourceReadback: null,
    parity: [],
    buildOnly: [],
    rollback: null,
    controlPlaneReadback: null,
  };
  value.expectedCounts = {
    activeRepositories: 1,
    legacyOperationJson: 0,
    workflowSecretsInherit: 0,
    workflowFloatingRef: 0,
  };

  const plan = createFleetMigrationPlan(value);
  assert.equal(plan.outcome, "NEEDS_INPUT");
  assert.equal(plan.reasonCodes.includes("UNCLASSIFIED_CANDIDATE"), true);
  assert.equal(plan.repositories[0].changes[0].operation, "NONE");
});

test("같은 repo/path/category 후보가 중복되면 idempotent execution으로 오인하지 않는다", () => {
  const value = inventory();
  value.repositories[0].candidates.push(
    structuredClone(value.repositories[0].candidates[0]),
  );
  value.expectedCounts.legacyOperationJson = 2;

  const plan = createFleetMigrationPlan(value);
  assert.equal(plan.outcome, "NEEDS_INPUT");
  assert.equal(plan.reasonCodes.includes("CANDIDATE_DUPLICATE"), true);
  assert.equal(
    new Set(
      plan.repositories[0].changes.map(({ idempotencyKey }) => idempotencyKey),
    ).size,
    1,
  );
});

test("입력 순서와 set 성격 필드 순서가 달라도 plan과 idempotency가 같다", () => {
  const targetRepository = repository();
  const legacy = legacyCandidate({ targetRepository });
  const secrets = secretsInheritCandidate({ targetRepository });
  const first = inventory({
    repositories: [
      {
        repository: targetRepository,
        observation: {
          id: "discovery-observation-0001",
          observedAt: "2026-08-29T00:00:00.000Z",
          repositoryId: targetRepository.id,
          sourceRef: targetRepository.defaultRef,
          sourceSha: targetRepository.sourceSha,
          treeSha: TREE_SHA,
        },
        candidates: [legacy, secrets],
      },
    ],
  });
  const second = structuredClone(first);
  second.repositories[0].candidates.reverse();
  const secretCandidate = second.repositories[0].candidates.find(
    ({ detection }) => detection.type === "WORKFLOW_SECRETS_INHERIT",
  );
  secretCandidate.detection.occurrenceLines.reverse();
  secretCandidate.requiredBuildTargets.reverse();
  secretCandidate.replacement.namedCredentialLogicalIds.reverse();
  secretCandidate.proofs.buildOnly.reverse();
  secretCandidate.proofs.parity.reverse();

  const firstPlan = createFleetMigrationPlan(first);
  const secondPlan = createFleetMigrationPlan(second);
  assert.deepEqual(secondPlan, firstPlan);
});

test("replacement digest가 바뀌면 같은 경로라도 idempotency key가 바뀐다", () => {
  const first = inventory();
  const second = structuredClone(first);
  const candidate = second.repositories[0].candidates[0];
  const nextDigest = digest("next-config-revision");
  candidate.replacement.configRevisionDigest = nextDigest;
  for (const proof of candidate.proofs.parity) {
    proof.replacementDigest = nextDigest;
  }
  candidate.proofs.controlPlaneReadback.replacementDigest = nextDigest;

  const firstChange = createFleetMigrationPlan(first).repositories[0].changes[0];
  const secondChange = createFleetMigrationPlan(second).repositories[0].changes[0];
  assert.notEqual(secondChange.idempotencyKey, firstChange.idempotencyKey);
});

test("plan digest, 실행 가능 flag, idempotency 변조를 검증기가 거부한다", () => {
  const plan = createFleetMigrationPlan(inventory());
  const executionTamper = structuredClone(plan);
  executionTamper.executionAllowed = true;
  assert.equal(validateFleetMigrationPlan(executionTamper).ok, false);

  const digestTamper = structuredClone(plan);
  digestTamper.planDigest = digest("tampered-plan");
  assert.deepEqual(validateFleetMigrationPlan(digestTamper).diagnostics, [
    "PLAN_DIGEST_MISMATCH",
  ]);

  const idempotencyTamper = structuredClone(plan);
  idempotencyTamper.repositories[0].changes[0].idempotencyKey = digest(
    "different-operation",
  );
  idempotencyTamper.planDigest = digest(
    JSON.stringify({ ...idempotencyTamper, planDigest: undefined }),
  );
  assert.equal(
    validateFleetMigrationPlan(idempotencyTamper).diagnostics.includes(
      "PLAN_IDEMPOTENCY_KEY_MISMATCH",
    ),
    true,
  );
});

test("inventory schema는 traversal과 임의 secret 필드를 값 노출 없이 거부한다", () => {
  const value = inventory();
  value.repositories[0].candidates[0].path = "../credential.json";
  value.repositories[0].candidates[0].secret = "must-not-be-reported";

  const result = validateFleetMigrationInventory(value);
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes("must-not-be-reported"), false);
  assert.throws(
    () => createFleetMigrationPlan(value),
    /FLEET_MIGRATION_INVENTORY_INVALID/u,
  );
});

test("fleet CLI는 inventory를 plan으로 만들고 같은 strict validator로 확인한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-migration-cli-"));
  try {
    const inventoryPath = join(root, "inventory.json");
    const planPath = join(root, "plan.json");
    await writeFile(inventoryPath, `${JSON.stringify(inventory())}\n`, "utf8");
    let planOutput = "";
    let planError = "";
    const planExitCode = await runFleetCli({
      argv: ["plan-migration", "--inventory", inventoryPath],
      stdout: { write: (value) => (planOutput += value) },
      stderr: { write: (value) => (planError += value) },
    });
    assert.equal(planExitCode, 0, planError);
    const plan = JSON.parse(planOutput);
    assert.equal(plan.executionAllowed, false);
    await writeFile(planPath, `${JSON.stringify(plan)}\n`, "utf8");

    let validationOutput = "";
    let validationError = "";
    const validationExitCode = await runFleetCli({
      argv: ["validate-migration-plan", "--plan", planPath],
      stdout: { write: (value) => (validationOutput += value) },
      stderr: { write: (value) => (validationError += value) },
    });
    assert.equal(validationExitCode, 0, validationError);
    assert.match(validationOutput, /검증 통과/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
