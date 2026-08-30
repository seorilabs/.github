import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign as signEd25519,
} from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  computeFleetCoveragePageDigest,
  computeFleetCredentialBindingScopeDigest,
  computeFleetEvidenceDigest,
  computeFleetFindingsDigest,
  computeFleetMigrationChainHeadDigest,
  computeFleetMigrationInventoryDigest,
  computeFleetMigrationLineageChainDigest,
  computeFleetMigrationOutageRecoveryDigest,
  computeFleetMigrationOwnerScopeDigest,
  computeFleetMigrationReplacementDigest,
  computeFleetPlatformFleetBindingDigest,
  computeFleetRepositoryReadbackDigest,
  createFleetMigrationAttestationPayload,
  createFleetMigrationChainHeadAttestationPayload,
  createFleetMigrationPlan,
  deriveFleetMigrationInventoryCheckpoint,
  fleetMigrationContract,
  loadTrustedFleetMigrationChainHeadBinding,
  loadTrustedFleetMigrationHistoricalInventoryBinding,
  loadTrustedFleetMigrationInventoryBinding,
  validateFleetMigrationInventory,
  validateFleetMigrationPlan,
  validateFleetMigrationPlanStructure,
} from "../packages/repo-contract/src/fleet-migration.mjs";
import { runFleetCli } from "../packages/repo-contract/src/fleet-cli.mjs";

const ORGANIZATION_ID = "123456789";
const DETECTOR_SHA = "e".repeat(40);
const WORKFLOW_BUNDLE_SHA = "d".repeat(40);
const INVENTORY_KEY_ID = "fleet-inventory-key-0001";
const INVENTORY_POLICY_REVISION = "fleet-inventory-policy-0001";
const CHAIN_HEAD_KEY_ID = "fleet-chain-head-key-0001";
const CHAIN_HEAD_POLICY_REVISION = "fleet-chain-head-policy-0001";
const TEST_NOW_MS = Date.now();
const PROOF_BASE_MS = TEST_NOW_MS - 20 * 60 * 1000;
const CAPTURED_AT = new Date(TEST_NOW_MS - 2 * 60 * 1000).toISOString();
const EXPIRES_AT = new Date(TEST_NOW_MS + 10 * 60 * 1000).toISOString();
const EVALUATED_AT = new Date(TEST_NOW_MS).toISOString();
const EXPECTED_COUNTS = Object.freeze({
  activeRepositories: 38,
  legacyOperationJson: 73,
  workflowSecretsInherit: 108,
  workflowFloatingRef: 87,
});
const LEGACY_SCHEMA_IDS = Object.freeze({
  ORG_CONTRACT_APP:
    "https://seorilabs.github.io/contracts/v1/app.schema.json",
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
const CHAIN_HEAD_KEYS = generateKeyPairSync("ed25519");

function proofTime(minutesAfterBase) {
  return new Date(PROOF_BASE_MS + minutesAfterBase * 60 * 1000).toISOString();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) =>
          Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
        )
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
    fork: false,
    classification: index === 0 ? "PLATFORM_PRODUCER" : "PRODUCT_APP",
    classificationDecisionRevision: 1,
    classificationDecisionId: `repository-classification-${String(index).padStart(4, "0")}`,
  };
}

function subjectForRepository(repository, { platformAppId = null } = {}) {
  const appId =
    repository.classification === "PRODUCT_APP"
      ? repository.fullName.slice("seorilabs/".length)
      : null;
  return {
    kind: appId === null ? "REPOSITORY" : "PRODUCT_APP",
    appId,
    repositoryId: repository.id,
    fullName: repository.fullName,
    sourceRef: repository.defaultRef,
    sourceSha: repository.sourceSha,
    platformAppId,
    classificationDecisionRevision: repository.classificationDecisionRevision,
    classificationDecisionId: repository.classificationDecisionId,
  };
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
    configRevisionDigest: digest(`config-revision:${appId}:${snapshotSalt}`),
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
  sourceRepository,
  sourceTreeSha,
  subject,
  path,
  gitEntry,
  contentDigest,
  replacement,
  replacementDigest,
  operation,
  contextOptions,
}) {
  const targetRepository = {
    id: subject.repositoryId,
    fullName: subject.fullName,
    sourceSha: subject.sourceSha,
  };
  const token = `${sourceRepository.id}:${subject.repositoryId}:${subject.appId}:${path}`;
  const context = configContext(
    targetRepository,
    subject.appId,
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
    observedAt: proofTime(1),
    appId: subject.appId,
    repositoryId: subject.repositoryId,
    sourceSha: subject.sourceSha,
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
    observedAt: proofTime(2),
    appId: subject.appId,
    repositoryId: subject.repositoryId,
    sourceSha: subject.sourceSha,
    configRevisionId: context.configRevisionId,
    state: "ACTIVE",
    marketBuildTargets,
  });
  const workflowBundleReadback = evidence({
    observationId: evidenceId("workflow-bundle", token),
    observedAt: proofTime(3),
    appId: subject.appId,
    repositoryId: subject.repositoryId,
    sourceSha: subject.sourceSha,
    workflowBundleSha: WORKFLOW_BUNDLE_SHA,
    state: "APPROVED",
    bindings,
  });
  const platformFleetBindingReadback =
    sourceRepository.id !== subject.repositoryId
      ? (() => {
          const readback = {
            observationId: evidenceId("platform-fleet-binding", token),
            observedAt: proofTime(3.5),
            appId: subject.appId,
            appRevision: "1",
            appDigest: digest(`app:${subject.appId}:revision:1`),
            appRepositoryId: subject.repositoryId,
            appSourceSha: subject.sourceSha,
            platformAppId: subject.platformAppId,
            platformRepositoryId: sourceRepository.id,
            platformSourceSha: sourceRepository.sourceSha,
            classificationDecisionRevision:
              subject.classificationDecisionRevision,
            classificationDecisionId: subject.classificationDecisionId,
            bindingRevision: "1",
            state: "ACTIVE",
          };
          readback.bindingDigest =
            computeFleetPlatformFleetBindingDigest(readback);
          return evidence(readback);
        })()
      : null;
  const parityOne = evidence({
    sequence: 1,
    observationId: evidenceId("parity-one", token),
    previousObservationId: null,
    observedAt: proofTime(4),
    sourceSha: sourceRepository.sourceSha,
    subjectRepositoryId: subject.repositoryId,
    subjectSourceSha: subject.sourceSha,
    appId: subject.appId,
    currentContentDigest: contentDigest,
    replacementDigest,
    state: "MATCH",
  });
  const parityTwo = evidence({
    sequence: 2,
    observationId: evidenceId("parity-two", token),
    previousObservationId: parityOne.observationId,
    observedAt: proofTime(5),
    sourceSha: sourceRepository.sourceSha,
    subjectRepositoryId: subject.repositoryId,
    subjectSourceSha: subject.sourceSha,
    appId: subject.appId,
    currentContentDigest: contentDigest,
    replacementDigest,
    state: "MATCH",
  });
  const buildOnly = targets.map((target, index) => {
    const binding = bindings[index];
    return evidence({
      target,
      runRepositoryId: subject.repositoryId,
      runId: String(BigInt(`0x${sha(`run:${token}:${target}`).slice(0, 14)}`)),
      runAttempt: 1,
      completedAt: index === 0 ? proofTime(6) : proofTime(6.5),
      appId: subject.appId,
      sourceSha: subject.sourceSha,
      configRevisionId: context.configRevisionId,
      configRevisionDigest: context.configRevisionDigest,
      signedSnapshotDigest: context.signedSnapshotDigest,
      signatureKeyId: context.signatureKeyId,
      policyRevision: context.policyRevision,
      replacementDigest,
      workflowBundleSha: WORKFLOW_BUNDLE_SHA,
      workflowRef: binding.workflowRef,
      builderDigest: binding.builderDigest,
      state: "PASSED",
      artifactDigest: digest(`artifact:${token}:${target}`),
    });
  });
  const gitRestore = evidence({
    sourceSha: sourceRepository.sourceSha,
    sourceTreeSha,
    path,
    originalGitEntry: gitEntry,
    originalContentDigest: contentDigest,
    state: "VERIFIED",
    restoreValidationId: evidenceId("git-restore", token),
    verifiedAt: proofTime(7),
  });
  const backofficeOutageRecovery = evidence({
    appId: subject.appId,
    repositoryId: subject.repositoryId,
    sourceSha: subject.sourceSha,
    configRevisionId: context.configRevisionId,
    configRevisionDigest: context.configRevisionDigest,
    signedSnapshotDigest: context.signedSnapshotDigest,
    signatureKeyId: context.signatureKeyId,
    policyRevision: context.policyRevision,
    releaseReproductionDigest: computeFleetMigrationOutageRecoveryDigest({
      appId: subject.appId,
      repositoryId: subject.repositoryId,
      sourceSha: subject.sourceSha,
      configRevisionId: context.configRevisionId,
      configRevisionDigest: context.configRevisionDigest,
      signedSnapshotDigest: context.signedSnapshotDigest,
      signatureKeyId: context.signatureKeyId,
      policyRevision: context.policyRevision,
    }),
    state: "VERIFIED",
    verifiedAt: proofTime(7.5),
  });
  const ownerGate = evidence({
    ownerId: context.ownerId,
    approvalId: evidenceId("owner-approval", token),
    scopeDigest: computeFleetMigrationOwnerScopeDigest({
      repositoryId: sourceRepository.id,
      sourceSha: sourceRepository.sourceSha,
      subjectRepositoryId: subject.repositoryId,
      subjectSourceSha: subject.sourceSha,
      subjectClassificationDecisionRevision:
        subject.classificationDecisionRevision,
      subjectClassificationDecisionId: subject.classificationDecisionId,
      path,
      operation,
      replacementDigest,
      appId: subject.appId,
      configRevisionId: context.configRevisionId,
      configRevisionDigest: context.configRevisionDigest,
      signedSnapshotDigest: context.signedSnapshotDigest,
      signatureKeyId: context.signatureKeyId,
      policyRevision: context.policyRevision,
      ownerId: context.ownerId,
    }),
    state: "APPROVED",
    approvedAt: proofTime(8),
  });
  const controlPlaneReadback = evidence({
    providerObservationId: evidenceId("provider-observation", token),
    providerObservationRevision: "1",
    gateLedgerId: evidenceId("gate-ledger", token),
    gateLedgerRevision: "1",
    observedAt: proofTime(8.5),
    repositoryId: subject.repositoryId,
    appId: subject.appId,
    sourceSha: subject.sourceSha,
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
    observedAt: new Date(TEST_NOW_MS - 4 * 60 * 1000).toISOString(),
    repositoryId: sourceRepository.id,
    sourceRef: sourceRepository.defaultRef,
    sourceSha: sourceRepository.sourceSha,
    treeSha: sourceTreeSha,
    path,
    gitEntry,
    contentDigest,
    state: "MATCH",
  });
  const credentialBindings =
    replacement.type === "EXPLICIT_SECRET_MAPPING"
      ? replacement.namedCredentialBindings.map((binding) => {
          const readback = {
            observationId: evidenceId(
              "credential-binding",
              `${token}:${binding.secretName}`,
            ),
            observedAt: proofTime(8.67),
            appId: subject.appId,
            repositoryId: subject.repositoryId,
            sourceSha: subject.sourceSha,
            secretName: binding.secretName,
            logicalCredentialId: binding.logicalCredentialId,
            provider: binding.provider,
            capability: binding.capability,
            environment: binding.environment,
            publicIdentity: binding.publicIdentity,
            fingerprint: binding.fingerprint,
            consumer: `${subject.fullName}:${path}:${binding.secretName}`,
            status: "ACTIVE",
            credentialGeneration: 1,
            policyGeneration: 1,
            policyRevision: binding.policyRevision,
            replacementBlobDigest: replacement.replacementBlobDigest,
          };
          readback.scopeDigest =
            computeFleetCredentialBindingScopeDigest(readback);
          return evidence(readback);
        })
      : [];
  const consumerReadback = evidence({
    observationId: evidenceId("consumer-readback", token),
    readbackRevision: "1",
    observedAt: proofTime(8.75),
    repositoryId: sourceRepository.id,
    sourceSha: sourceRepository.sourceSha,
    path,
    operation,
    replacementDigest,
    consumerGraphDigest: digest(`consumer-graph:${token}:${operation}`),
    legacyConsumerCount: 0,
    parserFallbackState: operation === "DELETE" ? "DISABLED" : "NOT_APPLICABLE",
    dispatchReadbackState: operation === "REWRITE" ? "MATCH" : "NOT_APPLICABLE",
    state: "MATCH",
  });
  const parityStream = evidence({
    streamId: evidenceId("parity-stream", token),
    readbackRevision: "1",
    readbackAt: new Date(TEST_NOW_MS - 6 * 60 * 1000).toISOString(),
    expiresAt: new Date(TEST_NOW_MS + 6 * 60 * 1000).toISOString(),
    headObservationId: parityTwo.observationId,
    headSequence: 2,
    totalObservations: 2,
    observations: [parityOne, parityTwo],
  });
  return {
    activeConfigReadback,
    marketProfileReadback,
    workflowBundleReadback,
    platformFleetBindingReadback,
    sourceReadback,
    parityStream,
    buildOnly,
    credentialBindings,
    consumerReadback,
    rollback: { gitRestore, backofficeOutageRecovery, ownerGate },
    controlPlaneReadback,
  };
}

function legacyCandidate({
  sourceRepository,
  sourceTreeSha,
  subject,
  contract,
  path,
  contextOptions,
}) {
  const gitEntry = {
    kind: "BLOB",
    mode: "100644",
    objectSha: sha(`blob:${sourceRepository.id}:${path}`),
  };
  const contentDigest = digest(`legacy-content:${sourceRepository.id}:${path}`);
  const context = configContext(
    {
      id: subject.repositoryId,
      sourceSha: subject.sourceSha,
    },
    subject.appId,
    contextOptions,
  );
  const replacement = {
    type: "SIGNED_RESOLVED_MANIFEST",
    appId: subject.appId,
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
    subject,
    detection: {
      type: "LEGACY_OPERATION_JSON",
      contract,
      schemaId: LEGACY_SCHEMA_IDS[contract],
      matchedBy: "SCHEMA_VALIDATION",
      detectorSha: DETECTOR_SHA,
    },
    replacement,
    proofs: completeProofs({
      sourceRepository,
      sourceTreeSha,
      subject,
      path,
      gitEntry,
      contentDigest,
      replacement,
      replacementDigest,
      operation: "DELETE",
      contextOptions,
    }),
  };
}

function workflowCandidates({
  sourceRepository,
  sourceTreeSha,
  subject,
  path,
  includeFloating,
  contextOptions,
}) {
  const gitEntry = {
    kind: "BLOB",
    mode: "100644",
    objectSha: sha(`blob:${sourceRepository.id}:${path}`),
  };
  const contentDigest = digest(
    `workflow-content:${sourceRepository.id}:${path}`,
  );
  const replacementBlobDigest = digest(
    `workflow-replacement:${sourceRepository.id}:${path}`,
  );
  const secretReplacement = {
    type: "EXPLICIT_SECRET_MAPPING",
    replacementBlobDigest,
    workflowBundleSha: WORKFLOW_BUNDLE_SHA,
    namedCredentialBindings: [
      {
        secretName: "FLEET_APP_TOKEN",
        logicalCredentialId: "shared/github/fleet-app",
        provider: "github-actions",
        capability: "workflow-secret-read",
        environment: "production",
        publicIdentity: "github-app:seorilabs-fleet",
        fingerprint: null,
        policyRevision: "credential-policy-0001",
      },
    ],
  };
  const proofs = completeProofs({
    sourceRepository,
    sourceTreeSha,
    subject,
    path,
    gitEntry,
    contentDigest,
    replacement: secretReplacement,
    replacementDigest: replacementBlobDigest,
    operation: "REWRITE",
    contextOptions,
  });
  const secretCandidate = {
    path,
    gitEntry,
    contentDigest,
    subject,
    detection: {
      type: "WORKFLOW_SECRETS_INHERIT",
      detectorSha: DETECTOR_SHA,
      occurrenceLines: [12],
    },
    replacement: secretReplacement,
    proofs,
  };
  if (!includeFloating) return [secretCandidate];
  const calledWorkflow = "seorilabs/.github/.github/workflows/org-contract.yml";
  return [
    secretCandidate,
    {
      path,
      gitEntry: structuredClone(gitEntry),
      contentDigest,
      subject: structuredClone(subject),
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
    redigest(entry.observation.treeReadback);
    for (const candidate of entry.candidates) {
      const stream = candidate.proofs.parityStream;
      if (stream === null) continue;
      const head = stream.observations.at(-1);
      stream.headObservationId = head.observationId;
      stream.headSequence = head.sequence;
      stream.totalObservations = stream.observations.length;
      redigest(stream);
    }
    entry.observation.findingsDigest = computeFleetFindingsDigest({
      repositoryId: entry.repository.id,
      sourceRef: entry.repository.defaultRef,
      sourceSha: entry.repository.sourceSha,
      treeSha: entry.observation.treeSha,
      treeReadback: entry.observation.treeReadback,
      candidates: entry.candidates,
    });
  }
  inventory.coverage.activeRepositoryCount = inventory.repositories.length;
  inventory.coverage.providerTotalCount = inventory.repositories.length;
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
      hasNextPage: hasNext,
      providerTotalCount: inventory.repositories.length,
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

function signInventory(
  inventory,
  {
    keyId = INVENTORY_KEY_ID,
    policyRevision = INVENTORY_POLICY_REVISION,
    keys = INVENTORY_KEYS,
  } = {},
) {
  inventory.attestation = null;
  const inventoryDigest = computeFleetMigrationInventoryDigest(inventory);
  const signedAt = new Date(
    Date.parse(inventory.capturedAt) + 5 * 1000,
  ).toISOString();
  const payload = createFleetMigrationAttestationPayload(inventory, {
    keyId,
    policyRevision,
    signedAt,
  });
  inventory.attestation = {
    algorithm: "Ed25519",
    keyId,
    policyRevision,
    signedAt,
    inventoryDigest,
    value: signEd25519(null, payload, keys.privateKey).toString(
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
  if (inventory.lineage.mode !== "BOOTSTRAP") {
    throw new Error("TEST_WAVE_TRUST_CONTEXT_REQUIRED");
  }
  return loadTrustedFleetMigrationInventoryBinding({
    inventory,
    trustedInventoryKeys: new Map([
      [INVENTORY_KEY_ID, INVENTORY_KEYS.publicKey],
    ]),
    now: EVALUATED_AT,
  });
}

function rootIdentity(inventory) {
  const inventoryDigest = computeFleetMigrationInventoryDigest(inventory);
  return inventory.lineage.mode === "BOOTSTRAP"
    ? {
        inventoryId: inventory.inventoryId,
        inventoryDigest,
      }
    : {
        inventoryId: inventory.lineage.rootInventoryId,
        inventoryDigest: inventory.lineage.rootInventoryDigest,
      };
}

function signChainHead(
  chainHead,
  {
    keyId = CHAIN_HEAD_KEY_ID,
    policyRevision = CHAIN_HEAD_POLICY_REVISION,
    keys = CHAIN_HEAD_KEYS,
  } = {},
) {
  chainHead.attestation = null;
  const chainHeadDigest = computeFleetMigrationChainHeadDigest(chainHead);
  const signedAt = new Date(
    Date.parse(chainHead.observedAt) + 1000,
  ).toISOString();
  const payload = createFleetMigrationChainHeadAttestationPayload(chainHead, {
    keyId,
    policyRevision,
    signedAt,
  });
  chainHead.attestation = {
    algorithm: "Ed25519",
    role: "FLEET_MIGRATION_CHAIN_HEAD_AUTHORITY",
    keyId,
    policyRevision,
    signedAt,
    chainHeadDigest,
    value: signEd25519(null, payload, keys.privateKey).toString("base64url"),
  };
  return chainHead;
}

function makeChainHead(priorInventory, candidateInventory, options = {}) {
  const root = rootIdentity(priorInventory);
  const stateGeneration =
    options.stateGeneration ?? String(priorInventory.lineage.waveNumber + 1);
  const observedAt = new Date(
    Date.parse(candidateInventory.attestation.signedAt) + 5000,
  ).toISOString();
  return signChainHead(
    {
      schemaVersion: 1,
      contract: "seorilabs-fleet-migration-chain-head-v1",
      authorityRole: "FLEET_MIGRATION_CHAIN_HEAD_AUTHORITY",
      organization: structuredClone(priorInventory.organization),
      installationId: priorInventory.coverage.installationId,
      authorityRevision: `fleet-chain-head-revision-${String(candidateInventory.lineage.waveNumber).padStart(4, "0")}`,
      readbackId: `fleet-chain-head-readback-${String(candidateInventory.lineage.waveNumber).padStart(4, "0")}`,
      observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 2 * 60 * 1000).toISOString(),
      head: {
        stateGeneration,
        waveNumber: priorInventory.lineage.waveNumber,
        inventoryId: priorInventory.inventoryId,
        inventoryDigest: computeFleetMigrationInventoryDigest(priorInventory),
        chainDigest: priorInventory.lineage.chainDigest,
        rootInventoryId: root.inventoryId,
        rootInventoryDigest: root.inventoryDigest,
        observedCounts: countFindings(priorInventory.repositories),
        inventoryKeyId: priorInventory.attestation.keyId,
        inventoryPolicyRevision: priorInventory.attestation.policyRevision,
        inventorySignedAt: priorInventory.attestation.signedAt,
      },
      candidate: {
        waveNumber: candidateInventory.lineage.waveNumber,
        inventoryId: candidateInventory.inventoryId,
        inventoryDigest:
          computeFleetMigrationInventoryDigest(candidateInventory),
        inventorySignedAt: candidateInventory.attestation.signedAt,
      },
      reservation: {
        contract:
          "seorilabs-fleet-migration-chain-head-cas-reservation-v1",
        reservationId: evidenceId(
          "fleet-chain-head-reservation",
          `${stateGeneration}:${candidateInventory.inventoryId}`,
        ),
        state: "RESERVED",
        expectedGeneration: stateGeneration,
        reservedGeneration: (BigInt(stateGeneration) + 1n).toString(),
        reservedAt: observedAt,
      },
      attestation: null,
    },
    options,
  );
}

function currentStateAuthorityReadback(chainHead) {
  const current = structuredClone(chainHead);
  return async (request) => {
    assert.equal(
      request.contract,
      "seorilabs-fleet-migration-chain-head-cas-reservation-v1",
    );
    assert.equal(
      request.authorityRole,
      "FLEET_MIGRATION_CHAIN_HEAD_AUTHORITY",
    );
    assert.equal(request.organizationId, current.organization.id);
    assert.equal(request.installationId, current.installationId);
    assert.equal(request.authorityRevision, current.authorityRevision);
    assert.equal(request.reservationId, current.reservation.reservationId);
    assert.equal(
      request.expectedGeneration,
      current.reservation.expectedGeneration,
    );
    assert.equal(
      request.reservedGeneration,
      current.reservation.reservedGeneration,
    );
    assert.equal(
      request.chainHeadDigest,
      computeFleetMigrationChainHeadDigest(current),
    );
    assert.deepEqual(request.head, current.head);
    assert.deepEqual(request.candidate, current.candidate);
    return structuredClone(current);
  };
}

async function trustedChainHeadBinding(chainHead, options = {}) {
  const {
    trustedChainHeadKeys = new Map([
      [CHAIN_HEAD_KEY_ID, CHAIN_HEAD_KEYS.publicKey],
    ]),
    trustedInventoryKeys = new Map([
      [INVENTORY_KEY_ID, INVENTORY_KEYS.publicKey],
    ]),
    trustedStateAuthorityReadback = currentStateAuthorityReadback(chainHead),
    now = EVALUATED_AT,
  } = options;
  return await loadTrustedFleetMigrationChainHeadBinding({
    chainHead,
    trustedChainHeadKeys,
    trustedInventoryKeys,
    trustedStateAuthorityReadback,
    now,
  });
}

async function trustedWaveContext(priorInventory, inventory) {
  const trustedPriorInventoryBinding =
    trustedHistoricalBinding(priorInventory);
  const chainHead = makeChainHead(priorInventory, inventory);
  const chainHeadBinding = await trustedChainHeadBinding(chainHead);
  const trustedInventoryBinding = loadTrustedFleetMigrationInventoryBinding({
    inventory,
    trustedInventoryKeys: new Map([
      [INVENTORY_KEY_ID, INVENTORY_KEYS.publicKey],
    ]),
    priorInventory,
    trustedPriorInventoryBinding,
    chainHead,
    trustedChainHeadBinding: chainHeadBinding,
    now: EVALUATED_AT,
  });
  return {
    trustedInventoryBinding,
    priorInventory,
    trustedPriorInventoryBinding,
    chainHead,
    trustedChainHeadBinding: chainHeadBinding,
  };
}

function trustedHistoricalBinding(inventory) {
  return loadTrustedFleetMigrationHistoricalInventoryBinding({
    inventory,
    trustedInventoryKeys: new Map([
      [INVENTORY_KEY_ID, INVENTORY_KEYS.publicKey],
    ]),
    now: EVALUATED_AT,
  });
}

function makeFleetInventory(contextOptions = {}) {
  const repositories = Array.from({ length: 38 }, (_, index) => {
    const identity = repositoryIdentity(index);
    return {
      repository: identity,
      observation: {
        id: `discovery-observation-${String(index).padStart(4, "0")}`,
        observedAt: proofTime(0.5),
        repositoryId: identity.id,
        sourceRef: identity.defaultRef,
        sourceSha: identity.sourceSha,
        treeSha: sha(`tree:${index}`),
        treeReadback: evidence({
          provider: "GITHUB_GIT_TREE",
          readbackId: `git-tree-readback-${String(index).padStart(4, "0")}`,
          observedAt: proofTime(0.33),
          repositoryId: identity.id,
          sourceSha: identity.sourceSha,
          treeSha: sha(`tree:${index}`),
          recursive: true,
          truncated: false,
          entryCount: 100 + index,
          blobCount: 90 + index,
          scannedBlobCount: 90 + index,
          canonicalEntriesDigest: digest(`tree-entries:${index}`),
        }),
        findingsDigest: digest(`pending-findings:${index}`),
      },
      candidates: [],
    };
  });
  for (let index = 1; index <= 13; index += 1) {
    const platformAppId = `registry-${String(index).padStart(2, "0")}`;
    repositories[0].candidates.push(
      legacyCandidate({
        sourceRepository: repositories[0].repository,
        sourceTreeSha: repositories[0].observation.treeSha,
        subject: subjectForRepository(repositories[index].repository, {
          platformAppId,
        }),
        contract: "PLATFORM_REGISTRY_APP",
        path: `registry/apps/${platformAppId}.json`,
        contextOptions,
      }),
    );
  }
  const legacyGroups = [
    ["GOOGLE_PLAY", "play-store/google-play.config.json", 19],
    ["APP_STORE", "app-store/app-store.config.json", 20],
    ["APPS_IN_TOSS", "apps-in-toss/apps-in-toss.config.json", 11],
    ["MARKET_LAUNCH_STATE", "release/market-launch-state.json", 6],
    ["BACKOFFICE_OPERATIONS", ".seorilabs/backoffice.json", 3],
    ["ORG_CONTRACT_APP", ".seorilabs/app.yaml", 1],
  ];
  for (const [contract, path, count] of legacyGroups) {
    for (let index = 1; index <= count; index += 1) {
      repositories[index].candidates.push(
        legacyCandidate({
          sourceRepository: repositories[index].repository,
          sourceTreeSha: repositories[index].observation.treeSha,
          subject: subjectForRepository(repositories[index].repository),
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
        sourceRepository: repositories[repositoryIndex].repository,
        sourceTreeSha: repositories[repositoryIndex].observation.treeSha,
        subject: subjectForRepository(repositories[repositoryIndex].repository),
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
    expiresAt: EXPIRES_AT,
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
      installationId: "7770001",
      query: {
        organizationLogin: "seorilabs",
        archived: false,
        pageSize: 20,
      },
      readbackId: "github-fleet-readback-20260829-0001",
      snapshotId: "github-fleet-snapshot-20260829-0001",
      observedAt: proofTime(0),
      complete: true,
      nextCursor: null,
      providerTotalCount: 38,
      activeRepositoryCount: 38,
      repositoriesDigest: digest("pending-repositories"),
      pages: [],
    },
    expectedCounts: structuredClone(EXPECTED_COUNTS),
    lineage: {
      mode: "BOOTSTRAP",
      waveNumber: 0,
      priorInventoryId: null,
      priorInventoryDigest: null,
      priorCapturedAt: null,
      priorObservedCounts: null,
      rootInventoryId: null,
      rootInventoryDigest: null,
      chainDigest: null,
      ancestry: [],
    },
    repositories,
    attestation: null,
  };
  assert.deepEqual(countFindings(repositories), EXPECTED_COUNTS);
  return refreshAndSign(inventory);
}

function makeWaveInventory(priorInventory, { removeFinding = true } = {}) {
  const inventory = structuredClone(priorInventory);
  const waveNumber = priorInventory.lineage.waveNumber + 1;
  if (removeFinding) {
    const entry = inventory.repositories.find(({ candidates }) =>
      candidates.some(
        (candidate) =>
          candidate.detection.type === "WORKFLOW_SECRETS_INHERIT" &&
          candidates.filter(({ path }) => path === candidate.path).length === 1,
      ),
    );
    const index = entry.candidates.findIndex(
      (candidate) =>
        candidate.detection.type === "WORKFLOW_SECRETS_INHERIT" &&
        entry.candidates.filter(({ path }) => path === candidate.path)
          .length === 1,
    );
    assert.notEqual(index, -1);
    entry.candidates.splice(index, 1);
  }
  const waveSuffix = removeFinding
    ? String(waveNumber).padStart(4, "0")
    : `${String(waveNumber).padStart(4, "0")}-no-progress`;
  inventory.inventoryId = `fleet-inventory-20260829-wave-${waveSuffix}`;
  const capturedAtMs = TEST_NOW_MS - (120 - waveNumber * 30) * 1000;
  inventory.capturedAt = new Date(capturedAtMs).toISOString();
  inventory.expiresAt = EXPIRES_AT;
  inventory.coverage.readbackId = `github-fleet-readback-20260829-wave-${waveSuffix}`;
  inventory.coverage.snapshotId = `github-fleet-snapshot-20260829-wave-${waveSuffix}`;
  inventory.coverage.observedAt = new Date(
    capturedAtMs - 15 * 1000,
  ).toISOString();
  for (const entry of inventory.repositories) {
    entry.observation.treeReadback.observedAt = new Date(
      capturedAtMs - 25 * 1000,
    ).toISOString();
    entry.observation.observedAt = new Date(
      capturedAtMs - 20 * 1000,
    ).toISOString();
    for (const candidate of entry.candidates) {
      candidate.proofs.sourceReadback.observedAt = new Date(
        capturedAtMs - 10 * 1000,
      ).toISOString();
      redigest(candidate.proofs.sourceReadback);
    }
  }
  inventory.expectedCounts = countFindings(inventory.repositories);
  const ancestry = [
    ...structuredClone(priorInventory.lineage.ancestry),
    structuredClone(deriveFleetMigrationInventoryCheckpoint(priorInventory)),
  ];
  inventory.lineage = {
    mode: "WAVE",
    waveNumber,
    priorInventoryId: priorInventory.inventoryId,
    priorInventoryDigest: computeFleetMigrationInventoryDigest(priorInventory),
    priorCapturedAt: priorInventory.capturedAt,
    priorObservedCounts: countFindings(priorInventory.repositories),
    rootInventoryId: ancestry[0].inventoryId,
    rootInventoryDigest: ancestry[0].inventoryDigest,
    chainDigest: computeFleetMigrationLineageChainDigest(ancestry),
    ancestry,
  };
  return refreshAndSign(inventory);
}

function readyFixture(contextOptions = {}) {
  const inventory = makeFleetInventory(contextOptions);
  const binding = trustedBinding(inventory);
  const plan = createFleetMigrationPlan(inventory, {
    trustedInventoryBinding: binding,
    now: EVALUATED_AT,
  });
  return { inventory, binding, plan };
}

function firstLegacy(inventory) {
  return inventory.repositories[0].candidates[0];
}

function firstAndroidCandidate(inventory) {
  return inventory.repositories[1].candidates[0];
}

function firstWorkflowSecret(inventory) {
  return inventory.repositories
    .flatMap(({ candidates }) => candidates)
    .find(({ detection }) => detection.type === "WORKFLOW_SECRETS_INHERIT");
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
      now: EVALUATED_AT,
    }).ok,
    true,
  );
  assert.deepEqual(validateFleetMigrationPlan(plan), {
    ok: false,
    diagnostics: ["PLAN_TRUSTED_INPUT_REQUIRED"],
  });
  assert.equal(fleetMigrationContract.executionAllowed, false);
});

test("source repository와 PRODUCT_APP subject 및 P5 classification revision을 분리해 결합한다", () => {
  const { plan } = readyFixture();
  const registryChange = plan.repositories[0].changes.find(
    ({ path }) => path === "registry/apps/registry-01.json",
  );
  assert.equal(plan.repositories[0].classification, "PLATFORM_PRODUCER");
  assert.equal(registryChange.subject.kind, "PRODUCT_APP");
  assert.equal(registryChange.subject.repositoryId, "1002");
  assert.equal(registryChange.subject.appId, "app-01");
  assert.equal(registryChange.subject.platformAppId, "registry-01");
  assert.notEqual(
    plan.repositories[0].repositoryId,
    registryChange.subject.repositoryId,
  );

  const staleDecision = structuredClone(makeFleetInventory());
  firstLegacy(staleDecision).subject.classificationDecisionRevision += 1;
  refreshAndSign(staleDecision);
  const stalePlan = createFleetMigrationPlan(staleDecision, {
    trustedInventoryBinding: trustedBinding(staleDecision),
  });
  assert.ok(stalePlan.reasonCodes.includes("SUBJECT_BINDING_MISMATCH"));

  const fork = structuredClone(makeFleetInventory());
  fork.repositories[1].repository.fork = true;
  refreshAndSign(fork);
  assert.throws(
    () => trustedBinding(fork),
    /REPOSITORY_CLASSIFICATION_MISMATCH/u,
  );
});

test("cross-repo는 PLATFORM_REGISTRY_APP의 P5 App/PlatformFleetBinding readback에만 허용한다", () => {
  const missingBinding = structuredClone(makeFleetInventory());
  firstLegacy(missingBinding).proofs.platformFleetBindingReadback = null;
  refreshAndSign(missingBinding);
  const missingPlan = createFleetMigrationPlan(missingBinding, {
    trustedInventoryBinding: trustedBinding(missingBinding),
  });
  assert.ok(missingPlan.reasonCodes.includes("PLATFORM_FLEET_BINDING_MISSING"));

  const crossWorkflow = structuredClone(makeFleetInventory());
  const workflow = firstWorkflowSecret(crossWorkflow);
  workflow.subject = subjectForRepository(
    crossWorkflow.repositories[2].repository,
  );
  refreshAndSign(crossWorkflow);
  const crossWorkflowPlan = createFleetMigrationPlan(crossWorkflow, {
    trustedInventoryBinding: trustedBinding(crossWorkflow),
  });
  assert.ok(crossWorkflowPlan.reasonCodes.includes("SUBJECT_BINDING_MISMATCH"));

  const duplicateApp = structuredClone(makeFleetInventory());
  const first = duplicateApp.repositories[0].candidates[0];
  const second = duplicateApp.repositories[0].candidates[1];
  second.subject = {
    ...structuredClone(first.subject),
    platformAppId: second.subject.platformAppId,
  };
  const binding = second.proofs.platformFleetBindingReadback;
  binding.appId = second.subject.appId;
  binding.appRepositoryId = second.subject.repositoryId;
  binding.appSourceSha = second.subject.sourceSha;
  binding.classificationDecisionRevision =
    second.subject.classificationDecisionRevision;
  binding.classificationDecisionId = second.subject.classificationDecisionId;
  binding.bindingDigest = computeFleetPlatformFleetBindingDigest(binding);
  redigest(binding);
  refreshAndSign(duplicateApp);
  const duplicatePlan = createFleetMigrationPlan(duplicateApp, {
    trustedInventoryBinding: trustedBinding(duplicateApp),
  });
  assert.ok(
    duplicatePlan.reasonCodes.includes("PLATFORM_FLEET_BINDING_MISMATCH"),
  );
});

test("provider total과 canonical tree 및 scoped BLOB 수가 불일치하면 fail-closed한다", () => {
  const wrongTotal = structuredClone(makeFleetInventory());
  wrongTotal.coverage.providerTotalCount += 1;
  signInventory(wrongTotal);
  assert.throws(
    () => trustedBinding(wrongTotal),
    /INVENTORY_PAGINATION_CHAIN_MISMATCH|INVENTORY_PROVIDER_TOTAL_MISMATCH/u,
  );

  const scopedTree = structuredClone(makeFleetInventory());
  scopedTree.repositories[0].observation.treeReadback.scannedBlobCount -= 1;
  refreshAndSign(scopedTree);
  const scopedPlan = createFleetMigrationPlan(scopedTree, {
    trustedInventoryBinding: trustedBinding(scopedTree),
  });
  assert.equal(
    scopedPlan.reasonCodes.includes("OBSERVATION_TREE_READBACK_MISMATCH"),
    false,
  );

  const impossibleTree = structuredClone(makeFleetInventory());
  impossibleTree.repositories[0].observation.treeReadback.scannedBlobCount =
    impossibleTree.repositories[0].observation.treeReadback.blobCount + 1;
  refreshAndSign(impossibleTree);
  const impossiblePlan = createFleetMigrationPlan(impossibleTree, {
    trustedInventoryBinding: trustedBinding(impossibleTree),
  });
  assert.ok(
    impossiblePlan.reasonCodes.includes("OBSERVATION_TREE_READBACK_MISMATCH"),
  );

  const truncatedTree = structuredClone(makeFleetInventory());
  truncatedTree.repositories[0].observation.treeReadback.truncated = true;
  assert.equal(validateFleetMigrationInventory(truncatedTree).ok, false);
});

test("parity authoritative head/total/readback TTL과 inventory TTL을 별도 검증한다", () => {
  const wrongHead = structuredClone(makeFleetInventory());
  const stream = firstLegacy(wrongHead).proofs.parityStream;
  stream.headObservationId = "parity-head-not-authoritative";
  redigest(stream);
  signInventory(wrongHead);
  const wrongHeadPlan = createFleetMigrationPlan(wrongHead, {
    trustedInventoryBinding: trustedBinding(wrongHead),
  });
  assert.ok(wrongHeadPlan.reasonCodes.includes("PARITY_HEAD_MISMATCH"));

  const wrongTotal = structuredClone(makeFleetInventory());
  const totalStream = firstLegacy(wrongTotal).proofs.parityStream;
  totalStream.totalObservations += 1;
  redigest(totalStream);
  signInventory(wrongTotal);
  const wrongTotalPlan = createFleetMigrationPlan(wrongTotal, {
    trustedInventoryBinding: trustedBinding(wrongTotal),
  });
  assert.ok(wrongTotalPlan.reasonCodes.includes("PARITY_STREAM_MISMATCH"));

  const staleReadback = structuredClone(makeFleetInventory());
  const staleStream = firstLegacy(staleReadback).proofs.parityStream;
  staleStream.expiresAt = new Date(TEST_NOW_MS - 60 * 1000).toISOString();
  redigest(staleStream);
  signInventory(staleReadback);
  const stalePlan = createFleetMigrationPlan(staleReadback, {
    trustedInventoryBinding: trustedBinding(staleReadback),
  });
  assert.ok(stalePlan.reasonCodes.includes("PARITY_READBACK_EXPIRED"));

  const timeAdvanced = makeFleetInventory();
  const timeAdvancedBinding = trustedBinding(timeAdvanced);
  const timeAdvancedPlan = createFleetMigrationPlan(timeAdvanced, {
    trustedInventoryBinding: timeAdvancedBinding,
    now: TEST_NOW_MS + 7 * 60 * 1000,
  });
  assert.ok(timeAdvancedPlan.reasonCodes.includes("PARITY_READBACK_EXPIRED"));

  const expired = makeFleetInventory();
  assert.throws(
    () =>
      loadTrustedFleetMigrationInventoryBinding({
        inventory: expired,
        trustedInventoryKeys: new Map([
          [INVENTORY_KEY_ID, INVENTORY_KEYS.publicKey],
        ]),
        now: Date.parse(expired.expiresAt) + 1,
      }),
    /INVENTORY_EXPIRED/u,
  );
  assert.throws(
    () =>
      loadTrustedFleetMigrationInventoryBinding({
        inventory: expired,
        trustedInventoryKeys: new Map([
          [INVENTORY_KEY_ID, INVENTORY_KEYS.publicKey],
        ]),
        now: Date.parse(expired.expiresAt),
      }),
    /INVENTORY_EXPIRED/u,
  );

  const parityBoundary = structuredClone(makeFleetInventory());
  const boundaryStream = firstLegacy(parityBoundary).proofs.parityStream;
  boundaryStream.expiresAt = EVALUATED_AT;
  redigest(boundaryStream);
  signInventory(parityBoundary);
  const parityBoundaryPlan = createFleetMigrationPlan(parityBoundary, {
    trustedInventoryBinding: trustedBinding(parityBoundary),
    now: EVALUATED_AT,
  });
  assert.ok(
    parityBoundaryPlan.reasonCodes.includes("PARITY_READBACK_EXPIRED"),
  );
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

test("후속 wave는 prior trusted inventory digest를 잇고 cleanup count가 단조 감소해야 한다", async () => {
  const priorInventory = makeFleetInventory();
  const inventory = makeWaveInventory(priorInventory);
  const context = await trustedWaveContext(priorInventory, inventory);
  const plan = createFleetMigrationPlan(inventory, {
    ...context,
    now: EVALUATED_AT,
  });
  assert.equal(plan.outcome, "READY_FOR_REVIEW");
  assert.equal(plan.inventory.lineage.mode, "WAVE");
  assert.equal(plan.inventory.lineage.ancestorCount, 1);
  assert.equal(
    plan.inventory.lineage.rootInventoryId,
    priorInventory.inventoryId,
  );
  assert.equal(Object.hasOwn(plan.inventory.lineage, "ancestry"), false);
  assert.equal(
    plan.inventory.observedCounts.workflowSecretsInherit,
    EXPECTED_COUNTS.workflowSecretsInherit - 1,
  );
  assert.equal(
    validateFleetMigrationPlan(plan, {
      inventory,
      ...context,
      now: EVALUATED_AT,
    }).ok,
    true,
  );

  const missingPrior = createFleetMigrationPlan(inventory, {
    trustedInventoryBinding: context.trustedInventoryBinding,
    now: EVALUATED_AT,
  });
  assert.equal(missingPrior.outcome, "NEEDS_INPUT");
  assert.ok(missingPrior.reasonCodes.includes("INVENTORY_LINEAGE_REQUIRED"));
  assert.equal(
    validateFleetMigrationPlan(missingPrior, {
      inventory,
      trustedInventoryBinding: context.trustedInventoryBinding,
      now: EVALUATED_AT,
    }).ok,
    true,
  );
  const otherCurrent = structuredClone(inventory);
  otherCurrent.inventoryId = "fleet-inventory-20260829-wave-other";
  signInventory(otherCurrent);
  const otherContext = await trustedWaveContext(priorInventory, otherCurrent);
  assert.deepEqual(
    validateFleetMigrationPlan(missingPrior, {
      inventory: otherCurrent,
      ...otherContext,
      now: EVALUATED_AT,
    }),
    {
      ok: false,
      diagnostics: ["PLAN_TRUSTED_INPUT_MISMATCH"],
    },
  );

  const wrongDigest = structuredClone(inventory);
  wrongDigest.lineage.priorInventoryDigest = digest("wrong-prior-inventory");
  signInventory(wrongDigest);
  await assert.rejects(
    trustedWaveContext(priorInventory, wrongDigest),
    /FLEET_MIGRATION_INVENTORY_LINEAGE_INVALID/u,
  );

  const replayedProviderEvidence = structuredClone(inventory);
  replayedProviderEvidence.coverage.observedAt =
    priorInventory.coverage.observedAt;
  signInventory(replayedProviderEvidence);
  await assert.rejects(
    trustedWaveContext(priorInventory, replayedProviderEvidence),
    /FLEET_MIGRATION_INVENTORY_LINEAGE_INVALID/u,
  );

  const noProgress = makeWaveInventory(priorInventory, {
    removeFinding: false,
  });
  await assert.rejects(
    trustedWaveContext(priorInventory, noProgress),
    /FLEET_MIGRATION_INVENTORY_LINEAGE_INVALID/u,
  );
});

test("WAVE checkpoint chain은 매 단계 BOOTSTRAP까지 전이적으로 검증한다", async () => {
  const bootstrapInventory = makeFleetInventory();
  const waveOneInventory = makeWaveInventory(bootstrapInventory);
  const waveTwoInventory = makeWaveInventory(waveOneInventory);
  const context = await trustedWaveContext(waveOneInventory, waveTwoInventory);
  const plan = createFleetMigrationPlan(waveTwoInventory, {
    ...context,
    now: EVALUATED_AT,
  });

  assert.equal(plan.outcome, "READY_FOR_REVIEW");
  assert.equal(plan.inventory.lineage.waveNumber, 2);
  assert.equal(plan.inventory.lineage.ancestorCount, 2);
  assert.equal(
    plan.inventory.lineage.rootInventoryId,
    bootstrapInventory.inventoryId,
  );
  assert.equal(
    plan.inventory.lineage.rootInventoryDigest,
    computeFleetMigrationInventoryDigest(bootstrapInventory),
  );
  assert.equal(
    plan.inventory.lineage.chainDigest,
    computeFleetMigrationLineageChainDigest(waveTwoInventory.lineage.ancestry),
  );
});

test("유효한 키로 서명해도 존재하지 않는 parent를 주장한 WAVE는 anchor가 될 수 없다", async () => {
  const bootstrapInventory = makeFleetInventory();
  const arbitraryWave = structuredClone(makeWaveInventory(bootstrapInventory));
  arbitraryWave.inventoryId = "fleet-inventory-20260829-wave-arbitrary";
  arbitraryWave.lineage.priorInventoryId = "fleet-inventory-nonexistent-parent";
  arbitraryWave.lineage.priorInventoryDigest = digest("nonexistent-parent");
  signInventory(arbitraryWave);

  assert.throws(
    () => trustedHistoricalBinding(arbitraryWave),
    /FLEET_MIGRATION_INVENTORY_LINEAGE_INVALID/u,
  );

  const childInventory = makeWaveInventory(arbitraryWave);
  await assert.rejects(
    trustedWaveContext(arbitraryWave, childInventory),
    /FLEET_MIGRATION_INVENTORY_LINEAGE_INVALID/u,
  );
  assert.notEqual(
    createFleetMigrationPlan(childInventory, { now: EVALUATED_AT }).outcome,
    "READY_FOR_REVIEW",
  );
});

test("WAVE는 별도 state authority의 candidate-bound 최신 chain head에만 append한다", async () => {
  const bootstrapInventory = makeFleetInventory();
  const inventory = makeWaveInventory(bootstrapInventory);
  const context = await trustedWaveContext(bootstrapInventory, inventory);
  const first = createFleetMigrationPlan(inventory, {
    ...context,
    now: EVALUATED_AT,
  });
  const replay = createFleetMigrationPlan(inventory, {
    ...context,
    now: EVALUATED_AT,
  });
  assert.equal(first.outcome, "READY_FOR_REVIEW");
  assert.equal(first.inventory.chainHead.state, "VERIFIED");
  assert.equal(
    first.inventory.chainHead.chainHeadDigest,
    computeFleetMigrationChainHeadDigest(context.chainHead),
  );
  assert.deepEqual(replay, first);

  assert.throws(
    () =>
      loadTrustedFleetMigrationInventoryBinding({
        inventory,
        trustedInventoryKeys: new Map([
          [INVENTORY_KEY_ID, INVENTORY_KEYS.publicKey],
        ]),
        priorInventory: bootstrapInventory,
        trustedPriorInventoryBinding:
          context.trustedPriorInventoryBinding,
        now: EVALUATED_AT,
      }),
    /FLEET_MIGRATION_CHAIN_HEAD_REQUIRED/u,
  );
  const missingHeadPlan = createFleetMigrationPlan(inventory, {
    trustedInventoryBinding: context.trustedInventoryBinding,
    priorInventory: bootstrapInventory,
    trustedPriorInventoryBinding: context.trustedPriorInventoryBinding,
    now: EVALUATED_AT,
  });
  assert.equal(missingHeadPlan.outcome, "NEEDS_INPUT");
  assert.ok(missingHeadPlan.reasonCodes.includes("CHAIN_HEAD_REQUIRED"));

  const mixedRoleHead = makeChainHead(bootstrapInventory, inventory, {
    keyId: INVENTORY_KEY_ID,
    policyRevision: INVENTORY_POLICY_REVISION,
    keys: INVENTORY_KEYS,
  });
  await assert.rejects(
    trustedChainHeadBinding(mixedRoleHead, {
      trustedChainHeadKeys: new Map([
        [INVENTORY_KEY_ID, INVENTORY_KEYS.publicKey],
      ]),
    }),
    /FLEET_MIGRATION_CHAIN_HEAD_KEY_ROLE_CONFLICT/u,
  );
  const incompletelyConfiguredMixedBinding = await trustedChainHeadBinding(
    mixedRoleHead,
    {
      trustedChainHeadKeys: new Map([
        [INVENTORY_KEY_ID, INVENTORY_KEYS.publicKey],
      ]),
      trustedInventoryKeys: new Map(),
    },
  );
  assert.throws(
    () =>
      loadTrustedFleetMigrationInventoryBinding({
        inventory,
        trustedInventoryKeys: new Map([
          [INVENTORY_KEY_ID, INVENTORY_KEYS.publicKey],
        ]),
        priorInventory: bootstrapInventory,
        trustedPriorInventoryBinding:
          context.trustedPriorInventoryBinding,
        chainHead: mixedRoleHead,
        trustedChainHeadBinding: incompletelyConfiguredMixedBinding,
        now: EVALUATED_AT,
      }),
    /FLEET_MIGRATION_CHAIN_HEAD_KEY_ROLE_CONFLICT/u,
  );

  const wrongRole = structuredClone(context.chainHead);
  wrongRole.attestation.role = "FLEET_MIGRATION_INVENTORY_SIGNER";
  await assert.rejects(
    trustedChainHeadBinding(wrongRole),
    /FLEET_MIGRATION_CHAIN_HEAD_INVALID/u,
  );

  const expiredHead = structuredClone(context.chainHead);
  expiredHead.expiresAt = new Date(TEST_NOW_MS - 1).toISOString();
  signChainHead(expiredHead);
  await assert.rejects(
    trustedChainHeadBinding(expiredHead),
    /FLEET_MIGRATION_CHAIN_HEAD_STATE_INVALID/u,
  );

  const expiryBoundaryHead = structuredClone(context.chainHead);
  expiryBoundaryHead.expiresAt = EVALUATED_AT;
  signChainHead(expiryBoundaryHead);
  await assert.rejects(
    trustedChainHeadBinding(expiryBoundaryHead),
    /FLEET_MIGRATION_CHAIN_HEAD_STATE_INVALID/u,
  );

  const nonCanonicalSignatureHead = structuredClone(context.chainHead);
  const canonicalSignature = nonCanonicalSignatureHead.attestation.value;
  const prefix = canonicalSignature.slice(0, -1);
  const decodedSignature = Buffer.from(canonicalSignature, "base64url");
  const alternateLastCharacter =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
      .split("")
      .find(
        (character) =>
          character !== canonicalSignature.at(-1) &&
          Buffer.compare(
            Buffer.from(`${prefix}${character}`, "base64url"),
            decodedSignature,
          ) === 0,
      );
  assert.notEqual(alternateLastCharacter, undefined);
  nonCanonicalSignatureHead.attestation.value =
    `${prefix}${alternateLastCharacter}`;
  await assert.rejects(
    trustedChainHeadBinding(nonCanonicalSignatureHead),
    /FLEET_MIGRATION_CHAIN_HEAD_SIGNATURE_INVALID/u,
  );
});

test("WAVE chain head는 durable CAS reservation의 live current readback 없이는 binding을 발급하지 않는다", async () => {
  const bootstrapInventory = makeFleetInventory();
  const firstChild = makeWaveInventory(bootstrapInventory);
  const siblingChild = structuredClone(firstChild);
  siblingChild.inventoryId = "fleet-inventory-20260829-wave-sibling";
  signInventory(siblingChild);
  const firstHead = makeChainHead(bootstrapInventory, firstChild, {
    stateGeneration: "41",
  });
  const siblingHead = makeChainHead(bootstrapInventory, siblingChild, {
    stateGeneration: "41",
  });
  const trustedChainHeadKeys = new Map([
    [CHAIN_HEAD_KEY_ID, CHAIN_HEAD_KEYS.publicKey],
  ]);
  const trustedInventoryKeys = new Map([
    [INVENTORY_KEY_ID, INVENTORY_KEYS.publicKey],
  ]);

  await assert.rejects(
    loadTrustedFleetMigrationChainHeadBinding({
      chainHead: firstHead,
      trustedChainHeadKeys,
      trustedInventoryKeys,
      now: EVALUATED_AT,
    }),
    /FLEET_MIGRATION_STATE_AUTHORITY_READBACK_REQUIRED/u,
  );

  for (const mutate of [
    (head) => {
      head.reservation.expectedGeneration = "40";
    },
    (head) => {
      head.reservation.reservedGeneration = "41";
    },
    (head) => {
      head.reservation.reservedAt = new Date(
        Date.parse(head.candidate.inventorySignedAt) - 1,
      ).toISOString();
    },
  ]) {
    const invalidReservation = structuredClone(firstHead);
    mutate(invalidReservation);
    signChainHead(invalidReservation);
    await assert.rejects(
      trustedChainHeadBinding(invalidReservation),
      /FLEET_MIGRATION_CHAIN_HEAD_STATE_INVALID/u,
    );
  }

  const extendedReservation = structuredClone(firstHead);
  extendedReservation.reservation.untrustedCurrent = true;
  await assert.rejects(
    trustedChainHeadBinding(extendedReservation),
    /FLEET_MIGRATION_CHAIN_HEAD_INVALID/u,
  );

  let currentReservation = structuredClone(firstHead);
  const liveReadback = async () => structuredClone(currentReservation);
  const firstBinding = await trustedChainHeadBinding(firstHead, {
    trustedStateAuthorityReadback: liveReadback,
  });
  assert.ok(firstBinding);
  await assert.rejects(
    trustedChainHeadBinding(siblingHead, {
      trustedStateAuthorityReadback: liveReadback,
    }),
    /FLEET_MIGRATION_STATE_AUTHORITY_READBACK_MISMATCH/u,
  );

  currentReservation = structuredClone(siblingHead);
  await assert.rejects(
    trustedChainHeadBinding(firstHead, {
      trustedStateAuthorityReadback: liveReadback,
    }),
    /FLEET_MIGRATION_STATE_AUTHORITY_READBACK_MISMATCH/u,
  );
  assert.ok(
    await trustedChainHeadBinding(siblingHead, {
      trustedStateAuthorityReadback: liveReadback,
    }),
  );
});

test("current inventory signer는 합쳐진 trust set에서 chain-head authority key alias와 SPKI를 공유할 수 없다", async () => {
  const bootstrapInventory = makeFleetInventory();
  const inventory = makeWaveInventory(bootstrapInventory);
  const currentAliasKeyId = "fleet-inventory-rotated-alias-0002";
  signInventory(inventory, {
    keyId: currentAliasKeyId,
    policyRevision: "fleet-inventory-policy-rotated-0002",
    keys: CHAIN_HEAD_KEYS,
  });
  const chainHead = makeChainHead(bootstrapInventory, inventory);
  const trustedPriorInventoryBinding =
    trustedHistoricalBinding(bootstrapInventory);
  const trustedChainHeadBindingValue = await trustedChainHeadBinding(chainHead, {
    trustedInventoryKeys: new Map([
      [INVENTORY_KEY_ID, INVENTORY_KEYS.publicKey],
    ]),
  });

  assert.throws(
    () =>
      loadTrustedFleetMigrationInventoryBinding({
        inventory,
        trustedInventoryKeys: new Map([
          [INVENTORY_KEY_ID, INVENTORY_KEYS.publicKey],
          [currentAliasKeyId, CHAIN_HEAD_KEYS.publicKey],
        ]),
        priorInventory: bootstrapInventory,
        trustedPriorInventoryBinding,
        chainHead,
        trustedChainHeadBinding: trustedChainHeadBindingValue,
        now: EVALUATED_AT,
      }),
    /FLEET_MIGRATION_CHAIN_HEAD_KEY_ROLE_CONFLICT/u,
  );
});

test("candidate-bound chain head는 truncate 재서명, old head와 숨은 count 증가를 차단한다", async () => {
  const bootstrapInventory = makeFleetInventory();
  const waveOneInventory = makeWaveInventory(bootstrapInventory);
  const rootHead = makeChainHead(bootstrapInventory, waveOneInventory);
  const rootHeadBinding = await trustedChainHeadBinding(rootHead);
  const bootstrapBinding = trustedHistoricalBinding(bootstrapInventory);
  const waveTwoInventory = makeWaveInventory(waveOneInventory);
  const waveOneBinding = trustedHistoricalBinding(waveOneInventory);

  assert.throws(
    () =>
      loadTrustedFleetMigrationInventoryBinding({
        inventory: waveTwoInventory,
        trustedInventoryKeys: new Map([
          [INVENTORY_KEY_ID, INVENTORY_KEYS.publicKey],
        ]),
        priorInventory: waveOneInventory,
        trustedPriorInventoryBinding: waveOneBinding,
        chainHead: rootHead,
        trustedChainHeadBinding: rootHeadBinding,
        now: EVALUATED_AT,
      }),
    /FLEET_MIGRATION_CHAIN_HEAD_MISMATCH/u,
  );

  const truncated = structuredClone(waveTwoInventory);
  const rootCheckpoint = structuredClone(truncated.lineage.ancestry[0]);
  truncated.inventoryId = "fleet-inventory-resigned-truncated-wave-0001";
  truncated.lineage = {
    mode: "WAVE",
    waveNumber: 1,
    priorInventoryId: rootCheckpoint.inventoryId,
    priorInventoryDigest: rootCheckpoint.inventoryDigest,
    priorCapturedAt: rootCheckpoint.capturedAt,
    priorObservedCounts: structuredClone(rootCheckpoint.expectedCounts),
    rootInventoryId: rootCheckpoint.inventoryId,
    rootInventoryDigest: rootCheckpoint.inventoryDigest,
    chainDigest: computeFleetMigrationLineageChainDigest([rootCheckpoint]),
    ancestry: [rootCheckpoint],
  };
  signInventory(truncated);
  assert.throws(
    () =>
      loadTrustedFleetMigrationInventoryBinding({
        inventory: truncated,
        trustedInventoryKeys: new Map([
          [INVENTORY_KEY_ID, INVENTORY_KEYS.publicKey],
        ]),
        priorInventory: bootstrapInventory,
        trustedPriorInventoryBinding: bootstrapBinding,
        chainHead: rootHead,
        trustedChainHeadBinding: rootHeadBinding,
        now: EVALUATED_AT,
      }),
    /FLEET_MIGRATION_CHAIN_HEAD_MISMATCH/u,
  );

  const regressed = structuredClone(waveOneInventory);
  regressed.inventoryId = "fleet-inventory-count-regression-rebased-0001";
  const capturedAtMs = Date.parse(waveTwoInventory.capturedAt) + 30 * 1000;
  regressed.capturedAt = new Date(capturedAtMs).toISOString();
  regressed.coverage.observedAt = new Date(
    capturedAtMs - 5 * 1000,
  ).toISOString();
  for (const entry of regressed.repositories) {
    entry.observation.treeReadback.observedAt = new Date(
      capturedAtMs - 15 * 1000,
    ).toISOString();
    entry.observation.observedAt = new Date(
      capturedAtMs - 10 * 1000,
    ).toISOString();
    for (const candidate of entry.candidates) {
      candidate.proofs.sourceReadback.observedAt = new Date(
        capturedAtMs - 2 * 1000,
      ).toISOString();
      redigest(candidate.proofs.sourceReadback);
    }
  }
  refreshAndSign(regressed);
  assert.equal(
    countFindings(regressed.repositories).workflowSecretsInherit,
    EXPECTED_COUNTS.workflowSecretsInherit - 1,
  );
  assert.equal(
    countFindings(waveTwoInventory.repositories).workflowSecretsInherit,
    EXPECTED_COUNTS.workflowSecretsInherit - 2,
  );
  assert.throws(
    () =>
      loadTrustedFleetMigrationInventoryBinding({
        inventory: regressed,
        trustedInventoryKeys: new Map([
          [INVENTORY_KEY_ID, INVENTORY_KEYS.publicKey],
        ]),
        priorInventory: bootstrapInventory,
        trustedPriorInventoryBinding: bootstrapBinding,
        chainHead: rootHead,
        trustedChainHeadBinding: rootHeadBinding,
        now: EVALUATED_AT,
      }),
    /FLEET_MIGRATION_CHAIN_HEAD_MISMATCH/u,
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

test("BLOCKED와 NEEDS_INPUT plan도 원본 trusted inventory에 결합하고 structural-only 검증을 분리한다", () => {
  const inventory = structuredClone(makeFleetInventory());
  const stream = firstLegacy(inventory).proofs.parityStream;
  stream.expiresAt = new Date(TEST_NOW_MS - 60 * 1000).toISOString();
  redigest(stream);
  signInventory(inventory);
  const binding = trustedBinding(inventory);
  const blockedPlan = createFleetMigrationPlan(inventory, {
    trustedInventoryBinding: binding,
    now: EVALUATED_AT,
  });
  assert.equal(blockedPlan.outcome, "BLOCKED");
  assert.deepEqual(validateFleetMigrationPlanStructure(blockedPlan), {
    ok: true,
    diagnostics: [],
  });
  assert.equal(
    validateFleetMigrationPlan(blockedPlan, {
      inventory,
      trustedInventoryBinding: binding,
      now: EVALUATED_AT,
    }).ok,
    true,
  );

  const otherInventory = structuredClone(makeFleetInventory());
  otherInventory.inventoryId = "fleet-inventory-20260829-other-0001";
  signInventory(otherInventory);
  const otherBinding = trustedBinding(otherInventory);
  assert.deepEqual(
    validateFleetMigrationPlan(blockedPlan, {
      inventory: otherInventory,
      trustedInventoryBinding: otherBinding,
      now: EVALUATED_AT,
    }),
    {
      ok: false,
      diagnostics: ["PLAN_TRUSTED_INPUT_MISMATCH"],
    },
  );
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
  const workflowCandidatesInRepo =
    caseCollision.repositories[1].candidates.filter(
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
    .find(({ detection }) => detection.type === "WORKFLOW_FLOATING_REF");
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
  assert.notEqual(
    initialChange.replacementDigest,
    nextChange.replacementDigest,
  );
  assert.notEqual(initialChange.idempotencyKey, nextChange.idempotencyKey);
});

test("parity는 trusted stream의 최신 contiguous MATCH 두 건과 previous ID chain을 요구한다", () => {
  const missingParity = structuredClone(makeFleetInventory());
  firstLegacy(missingParity).proofs.parityStream = null;
  refreshAndSign(missingParity);
  assert.equal(validateFleetMigrationInventory(missingParity).ok, true);
  const missingParityPlan = createFleetMigrationPlan(missingParity, {
    trustedInventoryBinding: trustedBinding(missingParity),
  });
  const missingParityChange = missingParityPlan.repositories[0].changes[0];
  assert.equal(missingParityChange.evidence.parityStreamId, null);
  assert.equal(missingParityChange.evidence.parityHeadObservationId, null);
  assert.equal(missingParityChange.evidence.parityHeadSequence, null);
  assert.equal(missingParityChange.evidence.parityTotalObservations, null);
  assert.ok(
    missingParityPlan.reasonCodes.includes(
      "PARITY_REQUIRES_LATEST_CONTIGUOUS_MATCHES",
    ),
  );
  assert.notEqual(missingParityPlan.outcome, "READY_FOR_REVIEW");

  const intermediateMismatch = structuredClone(makeFleetInventory());
  const candidate = firstLegacy(intermediateMismatch);
  const first = candidate.proofs.parityStream.observations[0];
  const mismatch = evidence({
    sequence: 2,
    observationId: evidenceId("parity-mismatch", candidate.path),
    previousObservationId: first.observationId,
    observedAt: proofTime(4.5),
    sourceSha: first.sourceSha,
    subjectRepositoryId: first.subjectRepositoryId,
    subjectSourceSha: first.subjectSourceSha,
    appId: first.appId,
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
  const wrongBuild =
    firstAndroidCandidate(wrongRunRepository).proofs.buildOnly[0];
  wrongBuild.runRepositoryId = "999999";
  redigest(wrongBuild);
  refreshAndSign(wrongRunRepository);
  const wrongRunPlan = createFleetMigrationPlan(wrongRunRepository, {
    trustedInventoryBinding: trustedBinding(wrongRunRepository),
  });
  assert.ok(wrongRunPlan.reasonCodes.includes("BUILD_ONLY_MISMATCH"));
});

test("build proof는 ACTIVE config snapshot과 exact replacement digest에 결합된다", () => {
  for (const mutate of [
    (build) => {
      build.configRevisionDigest = digest("stale-active-config");
    },
    (build) => {
      build.signedSnapshotDigest = digest("unsigned-snapshot");
    },
    (build) => {
      build.replacementDigest = digest("different-replacement");
    },
  ]) {
    const inventory = structuredClone(makeFleetInventory());
    const build = firstLegacy(inventory).proofs.buildOnly[0];
    mutate(build);
    redigest(build);
    refreshAndSign(inventory);
    const plan = createFleetMigrationPlan(inventory, {
      trustedInventoryBinding: trustedBinding(inventory),
    });
    assert.ok(plan.reasonCodes.includes("BUILD_ONLY_MISMATCH"));
  }
});

test("CredentialBinding mapping, scope, consumer, generation과 replacement binding이 idempotency에 결합된다", () => {
  const { plan: baseline } = readyFixture();
  const inventory = structuredClone(makeFleetInventory());
  const candidate = firstWorkflowSecret(inventory);
  const sourceEntry = inventory.repositories.find(({ candidates }) =>
    candidates.includes(candidate),
  );
  const siblings = sourceEntry.candidates.filter(
    ({ path }) => path === candidate.path,
  );
  const nextMappings = [
    {
      secretName: "AB_TOKEN",
      logicalCredentialId: "shared/github/fleet-app-ab",
      provider: "github-actions",
      capability: "workflow-secret-read",
      environment: "production",
      publicIdentity: "github-app:seorilabs-fleet-ab",
      fingerprint: null,
      policyRevision: "credential-policy-0002",
    },
    {
      secretName: "AA_TOKEN",
      logicalCredentialId: "shared/github/fleet-app-aa",
      provider: "github-actions",
      capability: "workflow-secret-read",
      environment: "production",
      publicIdentity: "github-app:seorilabs-fleet-aa",
      fingerprint: null,
      policyRevision: "credential-policy-0002",
    },
  ];
  candidate.replacement.namedCredentialBindings = nextMappings;
  const template = candidate.proofs.credentialBindings[0];
  candidate.proofs.credentialBindings = nextMappings.map((mapping, index) => {
    const binding = {
      ...structuredClone(template),
      observationId: evidenceId(
        "credential-remap",
        `${candidate.path}:${mapping.secretName}`,
      ),
      secretName: mapping.secretName,
      logicalCredentialId: mapping.logicalCredentialId,
      provider: mapping.provider,
      capability: mapping.capability,
      environment: mapping.environment,
      publicIdentity: mapping.publicIdentity,
      fingerprint: mapping.fingerprint,
      policyRevision: mapping.policyRevision,
      consumer: `${candidate.subject.fullName}:${candidate.path}:${mapping.secretName}`,
      credentialGeneration: index + 2,
      policyGeneration: index + 3,
    };
    binding.scopeDigest = computeFleetCredentialBindingScopeDigest(binding);
    redigest(binding);
    return binding;
  });
  for (const sibling of siblings) {
    if (sibling !== candidate) {
      sibling.proofs = structuredClone(candidate.proofs);
    }
  }
  refreshAndSign(inventory);
  const plan = createFleetMigrationPlan(inventory, {
    trustedInventoryBinding: trustedBinding(inventory),
  });
  assert.equal(plan.outcome, "READY_FOR_REVIEW");
  const nextChange = plan.repositories
    .flatMap(({ changes }) => changes)
    .find(({ path }) => path === candidate.path);
  const baselineChange = baseline.repositories
    .flatMap(({ changes }) => changes)
    .find(({ path }) => path === candidate.path);
  assert.deepEqual(nextChange.namedCredentialBindings, [
    nextMappings[1],
    nextMappings[0],
  ]);
  assert.notEqual(
    nextChange.replacementBindingDigest,
    baselineChange.replacementBindingDigest,
  );
  assert.notEqual(nextChange.idempotencyKey, baselineChange.idempotencyKey);

  const staleScope = structuredClone(makeFleetInventory());
  const staleCandidate = firstWorkflowSecret(staleScope);
  const staleEntry = staleScope.repositories.find(({ candidates }) =>
    candidates.includes(staleCandidate),
  );
  staleCandidate.proofs.credentialBindings[0].credentialGeneration += 1;
  redigest(staleCandidate.proofs.credentialBindings[0]);
  for (const sibling of staleEntry.candidates.filter(
    ({ path }) => path === staleCandidate.path,
  )) {
    sibling.proofs = structuredClone(staleCandidate.proofs);
  }
  refreshAndSign(staleScope);
  const stalePlan = createFleetMigrationPlan(staleScope, {
    trustedInventoryBinding: trustedBinding(staleScope),
  });
  assert.ok(stalePlan.reasonCodes.includes("CREDENTIAL_BINDING_MISMATCH"));

  const selfRecomputed = structuredClone(makeFleetInventory());
  const recomputedCandidate = firstWorkflowSecret(selfRecomputed);
  const recomputedEntry = selfRecomputed.repositories.find(({ candidates }) =>
    candidates.includes(recomputedCandidate),
  );
  const recomputedBinding = recomputedCandidate.proofs.credentialBindings[0];
  recomputedBinding.provider = "unapproved-provider";
  recomputedBinding.publicIdentity = "github-app:unapproved";
  recomputedBinding.policyRevision = "credential-policy-unapproved";
  recomputedBinding.scopeDigest =
    computeFleetCredentialBindingScopeDigest(recomputedBinding);
  redigest(recomputedBinding);
  for (const sibling of recomputedEntry.candidates.filter(
    ({ path }) => path === recomputedCandidate.path,
  )) {
    sibling.proofs = structuredClone(recomputedCandidate.proofs);
  }
  refreshAndSign(selfRecomputed);
  const recomputedPlan = createFleetMigrationPlan(selfRecomputed, {
    trustedInventoryBinding: trustedBinding(selfRecomputed),
  });
  assert.ok(recomputedPlan.reasonCodes.includes("CREDENTIAL_BINDING_MISMATCH"));
});

test("DELETE 전 consumer 0, parser disabled와 REWRITE dispatch readback을 강제한다", () => {
  const parserEnabled = structuredClone(makeFleetInventory());
  const legacy = firstLegacy(parserEnabled);
  legacy.proofs.consumerReadback.parserFallbackState = "NOT_APPLICABLE";
  redigest(legacy.proofs.consumerReadback);
  refreshAndSign(parserEnabled);
  const parserPlan = createFleetMigrationPlan(parserEnabled, {
    trustedInventoryBinding: trustedBinding(parserEnabled),
  });
  assert.ok(parserPlan.reasonCodes.includes("CONSUMER_READBACK_MISMATCH"));

  const dispatchMissing = structuredClone(makeFleetInventory());
  const workflow = firstWorkflowSecret(dispatchMissing);
  const workflowEntry = dispatchMissing.repositories.find(({ candidates }) =>
    candidates.includes(workflow),
  );
  workflow.proofs.consumerReadback.dispatchReadbackState = "NOT_APPLICABLE";
  redigest(workflow.proofs.consumerReadback);
  for (const sibling of workflowEntry.candidates.filter(
    ({ path }) => path === workflow.path,
  )) {
    sibling.proofs = structuredClone(workflow.proofs);
  }
  refreshAndSign(dispatchMissing);
  const dispatchPlan = createFleetMigrationPlan(dispatchMissing, {
    trustedInventoryBinding: trustedBinding(dispatchMissing),
  });
  assert.ok(dispatchPlan.reasonCodes.includes("CONSUMER_READBACK_MISMATCH"));

  const liveConsumer = structuredClone(makeFleetInventory());
  firstLegacy(liveConsumer).proofs.consumerReadback.legacyConsumerCount = 1;
  assert.equal(validateFleetMigrationInventory(liveConsumer).ok, false);
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
      candidate.proofs.workflowBundleReadback.bindings[0].workflowRef =
        workflowRef;
      candidate.proofs.buildOnly[0].workflowRef = workflowRef;
      redigest(candidate.proofs.workflowBundleReadback);
      redigest(candidate.proofs.buildOnly[0]);
    },
    (candidate) => {
      const builderDigest = digest("new-builder");
      candidate.proofs.workflowBundleReadback.bindings[0].builderDigest =
        builderDigest;
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
  const outage =
    firstLegacy(wrongReproduction).proofs.rollback.backofficeOutageRecovery;
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
        trustedInventoryKeys: new Map([[INVENTORY_KEY_ID, otherKey.publicKey]]),
      }),
    /FLEET_MIGRATION_INVENTORY_SIGNATURE_INVALID/u,
  );
  inventory.repositories[0].repository.sourceSha = sha("tampered-source");
  assert.throws(
    () => trustedBinding(inventory),
    /FLEET_MIGRATION_INVENTORY_UNTRUSTED|FLEET_MIGRATION_INVENTORY_DIGEST_MISMATCH/u,
  );
});

test("migration CLI는 trusted public key로 READY를 만들고 stdout 외 파일을 덮어쓰지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-migration-cli-"));
  try {
    const inventoryPath = join(root, "inventory.json");
    const protectedPath = join(root, "protected.json");
    const symlinkPath = join(root, "plan.json");
    const publicKeyPath = join(root, "inventory-signing-public.pem");
    const emittedPlanPath = join(root, "emitted-plan.json");
    const priorInventoryPath = join(root, "prior-inventory.json");
    const waveInventoryPath = join(root, "wave-inventory.json");
    const chainHeadPath = join(root, "chain-head.json");
    const chainHeadPublicKeyPath = join(
      root,
      "chain-head-signing-public.pem",
    );
    await writeFile(
      inventoryPath,
      `${JSON.stringify(makeFleetInventory())}\n`,
      "utf8",
    );
    await writeFile(protectedPath, "do-not-overwrite\n", "utf8");
    await writeFile(
      publicKeyPath,
      INVENTORY_KEYS.publicKey.export({ type: "spki", format: "pem" }),
      "utf8",
    );
    await writeFile(
      chainHeadPublicKeyPath,
      CHAIN_HEAD_KEYS.publicKey.export({ type: "spki", format: "pem" }),
      "utf8",
    );
    await symlink(protectedPath, symlinkPath);

    const missingInventoryError = captureWriter();
    const missingInventory = await runFleetCli({
      argv: ["plan-migration"],
      stdout: captureWriter().stream,
      stderr: missingInventoryError.stream,
    });
    assert.equal(missingInventory, 1);
    assert.match(
      missingInventoryError.read(),
      /MIGRATION_INVENTORY_REQUIRED/u,
    );

    const missingPlanError = captureWriter();
    const missingPlan = await runFleetCli({
      argv: ["validate-migration-plan", "--inventory", inventoryPath],
      stdout: captureWriter().stream,
      stderr: missingPlanError.stream,
    });
    assert.equal(missingPlan, 1);
    assert.match(missingPlanError.read(), /MIGRATION_PLAN_REQUIRED/u);

    const missingValidationInventoryError = captureWriter();
    const missingValidationInventory = await runFleetCli({
      argv: ["validate-migration-plan", "--plan", protectedPath],
      stdout: captureWriter().stream,
      stderr: missingValidationInventoryError.stream,
    });
    assert.equal(missingValidationInventory, 1);
    assert.match(
      missingValidationInventoryError.read(),
      /MIGRATION_INVENTORY_REQUIRED/u,
    );

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
      argv: [
        "plan-migration",
        "--inventory",
        inventoryPath,
        "--trusted-key-id",
        INVENTORY_KEY_ID,
        "--trusted-public-key",
        publicKeyPath,
      ],
      stdout: emitted.stream,
      stderr: captureWriter().stream,
      clock: () => EVALUATED_AT,
    });
    assert.equal(accepted, 0);
    const plan = JSON.parse(emitted.read());
    assert.equal(plan.mode, "PLAN_ONLY");
    assert.equal(plan.outcome, "READY_FOR_REVIEW");
    await writeFile(emittedPlanPath, emitted.read(), "utf8");
    const validated = captureWriter();
    const validateCode = await runFleetCli({
      argv: [
        "validate-migration-plan",
        "--plan",
        emittedPlanPath,
        "--inventory",
        inventoryPath,
        "--trusted-key-id",
        INVENTORY_KEY_ID,
        "--trusted-public-key",
        publicKeyPath,
      ],
      stdout: validated.stream,
      stderr: captureWriter().stream,
      clock: () => EVALUATED_AT,
    });
    assert.equal(validateCode, 0);
    assert.match(validated.read(), /검증 통과/u);

    const missingTrustError = captureWriter();
    const missingTrust = await runFleetCli({
      argv: ["plan-migration", "--inventory", inventoryPath],
      stdout: captureWriter().stream,
      stderr: missingTrustError.stream,
      clock: () => EVALUATED_AT,
    });
    assert.equal(missingTrust, 1);
    assert.match(missingTrustError.read(), /MIGRATION_TRUST_ROOT_REQUIRED/u);

    const bootstrapInventory = makeFleetInventory();
    const priorInventory = makeWaveInventory(bootstrapInventory);
    const waveInventory = makeWaveInventory(priorInventory);
    const chainHead = makeChainHead(priorInventory, waveInventory);
    await writeFile(
      priorInventoryPath,
      `${JSON.stringify(priorInventory)}\n`,
      "utf8",
    );
    await writeFile(
      waveInventoryPath,
      `${JSON.stringify(waveInventory)}\n`,
      "utf8",
    );
    await writeFile(
      chainHeadPath,
      `${JSON.stringify(chainHead)}\n`,
      "utf8",
    );
    const missingPriorError = captureWriter();
    const missingPrior = await runFleetCli({
      argv: [
        "plan-migration",
        "--inventory",
        waveInventoryPath,
        "--trusted-key-id",
        INVENTORY_KEY_ID,
        "--trusted-public-key",
        publicKeyPath,
        "--chain-head",
        chainHeadPath,
        "--trusted-chain-head-key-id",
        CHAIN_HEAD_KEY_ID,
        "--trusted-chain-head-public-key",
        chainHeadPublicKeyPath,
      ],
      stdout: captureWriter().stream,
      stderr: missingPriorError.stream,
      clock: () => EVALUATED_AT,
    });
    assert.equal(missingPrior, 1);
    assert.match(
      missingPriorError.read(),
      /MIGRATION_PRIOR_INVENTORY_REQUIRED/u,
    );

    const waveArgs = [
      "plan-migration",
      "--inventory",
      waveInventoryPath,
      "--prior-inventory",
      priorInventoryPath,
      "--trusted-key-id",
      INVENTORY_KEY_ID,
      "--trusted-public-key",
      publicKeyPath,
      "--chain-head",
      chainHeadPath,
      "--trusted-chain-head-key-id",
      CHAIN_HEAD_KEY_ID,
      "--trusted-chain-head-public-key",
      chainHeadPublicKeyPath,
    ];
    const missingStateAuthorityError = captureWriter();
    const missingStateAuthority = await runFleetCli({
      argv: waveArgs,
      stdout: captureWriter().stream,
      stderr: missingStateAuthorityError.stream,
      clock: () => EVALUATED_AT,
    });
    assert.equal(missingStateAuthority, 1);
    assert.match(
      missingStateAuthorityError.read(),
      /FLEET_MIGRATION_STATE_AUTHORITY_READBACK_REQUIRED/u,
    );

    const waveOutput = captureWriter();
    const waveAccepted = await runFleetCli({
      argv: waveArgs,
      stdout: waveOutput.stream,
      stderr: captureWriter().stream,
      clock: () => EVALUATED_AT,
      trustedStateAuthorityReadback: currentStateAuthorityReadback(chainHead),
    });
    assert.equal(waveAccepted, 0);
    const wavePlan = JSON.parse(waveOutput.read());
    assert.equal(wavePlan.outcome, "READY_FOR_REVIEW");
    assert.equal(wavePlan.inventory.lineage.waveNumber, 2);
    assert.equal(wavePlan.inventory.lineage.ancestorCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
