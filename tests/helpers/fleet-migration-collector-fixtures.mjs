import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  computeFleetCredentialBindingScopeDigest,
  computeFleetEvidenceDigest,
  computeFleetMigrationOutageRecoveryDigest,
  computeFleetMigrationOwnerScopeDigest,
  computeFleetMigrationReplacementDigest,
  computeFleetPlatformFleetBindingDigest,
} from "../../packages/repo-contract/src/fleet-migration.mjs";

export const ORGANIZATION_ID = "283115031";
export const INSTALLATION_ID = "142120077";
export const APP_ID = "4124446";
export const APP_SLUG = "seorilabs-backoffice";
export const DETECTOR_REPOSITORY_ID = "900000001";
export const DETECTOR_SHA = "e".repeat(40);
export const WORKFLOW_BUNDLE_SHA = "d".repeat(40);
export const REQUIRED_PERMISSIONS = Object.freeze([
  { name: "actions", access: "write" },
  { name: "administration", access: "write" },
  { name: "checks", access: "read" },
  { name: "contents", access: "write" },
  { name: "environments", access: "write" },
  { name: "issues", access: "write" },
  { name: "members", access: "read" },
  { name: "metadata", access: "read" },
  { name: "organization_administration", access: "write" },
  { name: "organization_custom_properties", access: "admin" },
  { name: "pull_requests", access: "write" },
  { name: "repository_custom_properties", access: "write" },
  { name: "workflows", access: "write" },
]);
export const REQUIRED_EVENTS = Object.freeze([
  "issue_comment",
  "issues",
  "pull_request",
  "push",
  "repository",
  "workflow_run",
]);

const LEGACY_DEFINITIONS = Object.freeze({
  ".seorilabs/app.yaml": {
    contract: "ORG_CONTRACT_APP",
    schemaId: "https://seorilabs.github.io/contracts/v1/app.schema.json",
  },
  "play-store/google-play.config.json": {
    contract: "GOOGLE_PLAY",
    schemaId:
      "https://seorilabs.github.io/contracts/v1/markets/google-play.schema.json",
  },
  "app-store/app-store.config.json": {
    contract: "APP_STORE",
    schemaId:
      "https://seorilabs.github.io/contracts/v1/markets/app-store.schema.json",
  },
  "apps-in-toss/apps-in-toss.config.json": {
    contract: "APPS_IN_TOSS",
    schemaId:
      "https://seorilabs.github.io/contracts/v1/markets/apps-in-toss.schema.json",
  },
  "release/market-launch-state.json": {
    contract: "MARKET_LAUNCH_STATE",
    schemaId:
      "https://seorilabs.com/contracts/legacy/market-launch-state.v1.schema.json",
  },
  ".seorilabs/backoffice.json": {
    contract: "BACKOFFICE_OPERATIONS",
    schemaId:
      "https://seorilabs.com/contracts/legacy/backoffice-operations.v1.schema.json",
  },
});

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareUtf8)
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function digest(value) {
  return `sha256:${createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex")}`;
}

export function sha(value) {
  return createHash("sha1").update(value).digest("hex");
}

export function gitBlobSha(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

export function evidence(value) {
  const result = structuredClone(value);
  result.evidenceDigest = computeFleetEvidenceDigest(result);
  return result;
}

function evidenceId(prefix, seed) {
  return `${prefix}-${sha(seed).slice(0, 20)}`;
}

export function makeCapability({ nowMs, verified = true } = {}) {
  const observedAt = new Date(nowMs - 30_000).toISOString();
  const appReadbackId = "github-app-readback-20260829-0001";
  const installationReadbackId =
    "github-installation-readback-20260829-0001";
  const permissions = verified
    ? structuredClone(REQUIRED_PERMISSIONS)
    : REQUIRED_PERMISSIONS.filter(
        ({ name }) => name !== "organization_custom_properties",
      );
  const events = verified
    ? structuredClone(REQUIRED_EVENTS)
    : REQUIRED_EVENTS.filter((event) => event !== "repository");
  const eventAcceptance = evidence({
    state: verified ? "ACCEPTED" : "UNVERIFIED",
    event: "repository",
    deliveryId: verified ? "github-delivery-repository-0001" : null,
    acceptedAt: verified ? new Date(nowMs - 45_000).toISOString() : null,
    handlerRevision: verified ? "backoffice-webhook-handler-0001" : null,
    appReadbackId,
    installationReadbackId,
  });
  return evidence({
    contract: "seorilabs-fleet-github-app-capability-v1",
    revision: verified
      ? "github-app-capability-verified-0001"
      : "github-app-capability-live-unverified-0001",
    observedAt,
    organization: { id: ORGANIZATION_ID, login: "seorilabs" },
    app: {
      readbackId: appReadbackId,
      id: APP_ID,
      slug: APP_SLUG,
      ownerId: ORGANIZATION_ID,
      ownerLogin: "seorilabs",
      active: true,
      webhookActive: true,
      webhookUrl: "https://backoffice.vzyx.xyz/api/webhooks",
      permissions: structuredClone(permissions),
      events: structuredClone(events),
    },
    installation: {
      readbackId: installationReadbackId,
      id: INSTALLATION_ID,
      appId: APP_ID,
      accountId: ORGANIZATION_ID,
      accountLogin: "seorilabs",
      targetType: "Organization",
      repositorySelection: "all",
      suspendedAt: null,
      updatedAt: new Date(nowMs - 60_000).toISOString(),
      permissions: structuredClone(permissions),
    },
    eventAcceptance,
  });
}

export function repositoryIdentity(index) {
  return {
    id: String(1_000_001 + index),
    fullName:
      index === 0
        ? "seorilabs/platform"
        : `seorilabs/app-${String(index).padStart(2, "0")}`,
    defaultRef: "refs/heads/main",
    defaultBranch: "main",
    sourceSha: sha(`source:${index}`),
    treeSha: sha(`tree:${index}`),
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
    classificationDecisionRevision:
      repository.classificationDecisionRevision,
    classificationDecisionId: repository.classificationDecisionId,
  };
}

function configContext(repository, appId) {
  return {
    appId,
    configRevisionId: `config-revision-${appId}-current`,
    configRevisionDigest: digest(`config-revision:${appId}:current`),
    signedSnapshotDigest: digest(`signed-snapshot:${appId}:current`),
    signatureKeyId: "snapshot-signing-key-0001",
    policyRevision: "snapshot-policy-0001",
    ownerId: "owner:seorilabs-fleet",
    repositoryId: repository.id,
    sourceSha: repository.sourceSha,
  };
}

function proofTime(context, minutesAfterBase) {
  return new Date(
    context.proofBaseMs + minutesAfterBase * 60_000,
  ).toISOString();
}

function completeProofs({
  context,
  sourceRepository,
  subject,
  path,
  gitEntry,
  contentDigest,
  replacement,
  replacementDigest,
  operation,
}) {
  const targetRepository = context.repositoriesById.get(subject.repositoryId);
  const token = `${sourceRepository.id}:${subject.repositoryId}:${subject.appId}:${path}`;
  const config = configContext(targetRepository, subject.appId);
  const workflowRef =
    `seorilabs/.github/.github/workflows/org-contract.yml@${WORKFLOW_BUNDLE_SHA}`;
  const builderDigest = digest("builder:ORG_CONTRACT_STATIC");
  const activeConfigReadback = evidence({
    observationId: evidenceId("active-config", token),
    observedAt: proofTime(context, 1),
    appId: subject.appId,
    repositoryId: subject.repositoryId,
    sourceSha: subject.sourceSha,
    configRevisionId: config.configRevisionId,
    configRevisionDigest: config.configRevisionDigest,
    signedSnapshotDigest: config.signedSnapshotDigest,
    signatureKeyId: config.signatureKeyId,
    policyRevision: config.policyRevision,
    ownerId: config.ownerId,
    state: "ACTIVE",
  });
  const marketProfileReadback = evidence({
    observationId: evidenceId("market-profile", token),
    observedAt: proofTime(context, 2),
    appId: subject.appId,
    repositoryId: subject.repositoryId,
    sourceSha: subject.sourceSha,
    configRevisionId: config.configRevisionId,
    state: "ACTIVE",
    marketBuildTargets: [],
  });
  const workflowBundleReadback = evidence({
    observationId: evidenceId("workflow-bundle", token),
    observedAt: proofTime(context, 3),
    appId: subject.appId,
    repositoryId: subject.repositoryId,
    sourceSha: subject.sourceSha,
    workflowBundleSha: WORKFLOW_BUNDLE_SHA,
    state: "APPROVED",
    bindings: [
      {
        target: "ORG_CONTRACT_STATIC",
        workflowRef,
        builderDigest,
      },
    ],
  });
  const platformFleetBindingReadback =
    sourceRepository.id === subject.repositoryId
      ? null
      : (() => {
          const readback = {
            observationId: evidenceId("platform-fleet-binding", token),
            observedAt: proofTime(context, 3.5),
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
        })();
  const parityOne = evidence({
    sequence: 1,
    observationId: evidenceId("parity-one", token),
    previousObservationId: null,
    observedAt: proofTime(context, 4),
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
    observedAt: proofTime(context, 5),
    sourceSha: sourceRepository.sourceSha,
    subjectRepositoryId: subject.repositoryId,
    subjectSourceSha: subject.sourceSha,
    appId: subject.appId,
    currentContentDigest: contentDigest,
    replacementDigest,
    state: "MATCH",
  });
  const buildOnly = [
    evidence({
      target: "ORG_CONTRACT_STATIC",
      runRepositoryId: subject.repositoryId,
      runId: String(BigInt(`0x${sha(`run:${token}`).slice(0, 14)}`)),
      runAttempt: 1,
      completedAt: proofTime(context, 6),
      appId: subject.appId,
      sourceSha: subject.sourceSha,
      configRevisionId: config.configRevisionId,
      configRevisionDigest: config.configRevisionDigest,
      signedSnapshotDigest: config.signedSnapshotDigest,
      signatureKeyId: config.signatureKeyId,
      policyRevision: config.policyRevision,
      replacementDigest,
      workflowBundleSha: WORKFLOW_BUNDLE_SHA,
      workflowRef,
      builderDigest,
      state: "PASSED",
      artifactDigest: digest(`artifact:${token}`),
    }),
  ];
  const gitRestore = evidence({
    sourceSha: sourceRepository.sourceSha,
    sourceTreeSha: sourceRepository.treeSha,
    path,
    originalGitEntry: gitEntry,
    originalContentDigest: contentDigest,
    state: "VERIFIED",
    restoreValidationId: evidenceId("git-restore", token),
    verifiedAt: proofTime(context, 7),
  });
  const backofficeOutageRecovery = evidence({
    appId: subject.appId,
    repositoryId: subject.repositoryId,
    sourceSha: subject.sourceSha,
    configRevisionId: config.configRevisionId,
    configRevisionDigest: config.configRevisionDigest,
    signedSnapshotDigest: config.signedSnapshotDigest,
    signatureKeyId: config.signatureKeyId,
    policyRevision: config.policyRevision,
    releaseReproductionDigest: computeFleetMigrationOutageRecoveryDigest({
      appId: subject.appId,
      repositoryId: subject.repositoryId,
      sourceSha: subject.sourceSha,
      configRevisionId: config.configRevisionId,
      configRevisionDigest: config.configRevisionDigest,
      signedSnapshotDigest: config.signedSnapshotDigest,
      signatureKeyId: config.signatureKeyId,
      policyRevision: config.policyRevision,
    }),
    state: "VERIFIED",
    verifiedAt: proofTime(context, 7.5),
  });
  const ownerGate = evidence({
    ownerId: config.ownerId,
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
      configRevisionId: config.configRevisionId,
      configRevisionDigest: config.configRevisionDigest,
      signedSnapshotDigest: config.signedSnapshotDigest,
      signatureKeyId: config.signatureKeyId,
      policyRevision: config.policyRevision,
      ownerId: config.ownerId,
    }),
    state: "APPROVED",
    approvedAt: proofTime(context, 8),
  });
  const controlPlaneReadback = evidence({
    providerObservationId: evidenceId("provider-observation", token),
    providerObservationRevision: "1",
    gateLedgerId: evidenceId("gate-ledger", token),
    gateLedgerRevision: "1",
    observedAt: proofTime(context, 8.5),
    repositoryId: subject.repositoryId,
    appId: subject.appId,
    sourceSha: subject.sourceSha,
    configRevisionId: config.configRevisionId,
    configRevisionDigest: config.configRevisionDigest,
    signedSnapshotDigest: config.signedSnapshotDigest,
    signatureKeyId: config.signatureKeyId,
    policyRevision: config.policyRevision,
    ownerId: config.ownerId,
    replacementDigest,
    state: "MATCH",
  });
  const sourceReadback = evidence({
    observationId: evidenceId("source-readback", token),
    observedAt: new Date(context.nowMs - 4 * 60_000).toISOString(),
    repositoryId: sourceRepository.id,
    sourceRef: sourceRepository.defaultRef,
    sourceSha: sourceRepository.sourceSha,
    treeSha: sourceRepository.treeSha,
    path,
    gitEntry,
    contentDigest,
    state: "MATCH",
  });
  const credentialBindings =
    replacement.type !== "EXPLICIT_SECRET_MAPPING"
      ? []
      : replacement.namedCredentialBindings.map((binding) => {
          const readback = {
            observationId: evidenceId(
              "credential-binding",
              `${token}:${binding.secretName}`,
            ),
            observedAt: proofTime(context, 8.67),
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
        });
  const consumerReadback = evidence({
    observationId: evidenceId("consumer-readback", token),
    readbackRevision: "1",
    observedAt: proofTime(context, 8.75),
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
  return {
    activeConfigReadback,
    marketProfileReadback,
    workflowBundleReadback,
    platformFleetBindingReadback,
    sourceReadback,
    parityStream: evidence({
      streamId: evidenceId("parity-stream", token),
      readbackRevision: "1",
      readbackAt: new Date(context.nowMs - 6 * 60_000).toISOString(),
      expiresAt: new Date(context.nowMs + 6 * 60_000).toISOString(),
      headObservationId: parityTwo.observationId,
      headSequence: 2,
      totalObservations: 2,
      observations: [parityOne, parityTwo],
    }),
    buildOnly,
    credentialBindings,
    consumerReadback,
    rollback: { gitRestore, backofficeOutageRecovery, ownerGate },
    controlPlaneReadback,
  };
}

function candidateForDetection(context, sourceRepository, scanned) {
  let subject;
  if (
    scanned.detection.type === "LEGACY_OPERATION_JSON" &&
    scanned.detection.contract === "PLATFORM_REGISTRY_APP"
  ) {
    const platformAppId = scanned.path
      .slice("registry/apps/".length)
      .replace(/\.json$/u, "");
    const index = Number(platformAppId.slice("registry-".length));
    subject = subjectForRepository(context.repositories[index], {
      platformAppId,
    });
  } else {
    subject = subjectForRepository(sourceRepository);
  }
  let replacement;
  let replacementDigest;
  let operation;
  if (scanned.detection.type === "LEGACY_OPERATION_JSON") {
    const config = configContext(
      context.repositoriesById.get(subject.repositoryId),
      subject.appId,
    );
    replacement = {
      type: "SIGNED_RESOLVED_MANIFEST",
      appId: subject.appId,
      configRevisionId: config.configRevisionId,
      configRevisionDigest: config.configRevisionDigest,
      signedSnapshotDigest: config.signedSnapshotDigest,
      signatureKeyId: config.signatureKeyId,
      policyRevision: config.policyRevision,
    };
    replacementDigest = computeFleetMigrationReplacementDigest(replacement);
    operation = "DELETE";
  } else if (scanned.detection.type === "WORKFLOW_SECRETS_INHERIT") {
    replacementDigest = digest(
      `workflow-replacement:${sourceRepository.id}:${scanned.path}`,
    );
    replacement = {
      type: "EXPLICIT_SECRET_MAPPING",
      replacementBlobDigest: replacementDigest,
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
    operation = "REWRITE";
  } else {
    replacementDigest = digest(
      `workflow-replacement:${sourceRepository.id}:${scanned.path}`,
    );
    replacement = {
      type: "PINNED_WORKFLOW_CALLER",
      replacementBlobDigest: replacementDigest,
      workflowBundleSha: WORKFLOW_BUNDLE_SHA,
      workflowRef: `${scanned.detection.calledWorkflow}@${WORKFLOW_BUNDLE_SHA}`,
    };
    operation = "REWRITE";
  }
  const gitEntry = {
    kind: "BLOB",
    mode: scanned.gitEntry.mode,
    objectSha: scanned.gitEntry.objectSha,
  };
  return {
    path: scanned.path,
    contentDigest: scanned.contentDigest,
    subject,
    detection: structuredClone(scanned.detection),
    replacement,
    proofs: completeProofs({
      context,
      sourceRepository,
      subject,
      path: scanned.path,
      gitEntry,
      contentDigest: scanned.contentDigest,
      replacement,
      replacementDigest,
      operation,
    }),
  };
}

function publicBackofficeEvidence(context, repository) {
  const isProduct = repository.classification === "PRODUCT_APP";
  const appId = isProduct
    ? repository.fullName.slice("seorilabs/".length)
    : null;
  const config = isProduct ? configContext(repository, appId) : null;
  const platformRepository =
    context.repositories.find(
      ({ classification }) => classification === "PLATFORM_PRODUCER",
    ) ?? {
      id: "800000001",
      sourceSha: sha("source:seorilabs/platform"),
    };
  return evidence({
    contract: "seorilabs-fleet-migration-backoffice-public-evidence-v1",
    readbackId: `backoffice-readback-${repository.id}`,
    observedAt: new Date(context.nowMs - 90_000).toISOString(),
    organizationId: ORGANIZATION_ID,
    repositoryId: repository.id,
    fullName: repository.fullName,
    sourceSha: repository.sourceSha,
    classification: repository.classification,
    classificationDecisionRevision:
      repository.classificationDecisionRevision,
    classificationDecisionId: repository.classificationDecisionId,
    app: isProduct
      ? {
          appId,
          revision: "1",
          digest: digest(`app:${appId}:revision:1`),
          repositoryId: repository.id,
          sourceSha: repository.sourceSha,
          state: "ACTIVE",
        }
      : null,
    activeConfig: isProduct
      ? {
          configRevisionId: config.configRevisionId,
          revision: "1",
          digest: config.configRevisionDigest,
          signedSnapshotDigest: config.signedSnapshotDigest,
          state: "ACTIVE",
        }
      : null,
    signedSnapshot: isProduct
      ? {
          snapshotId: `signed-snapshot-${appId}-current`,
          snapshotDigest: config.signedSnapshotDigest,
          signatureKeyId: config.signatureKeyId,
          policyRevision: config.policyRevision,
          state: "VERIFIED",
        }
      : null,
    platformFleetBinding: isProduct
      ? {
          observationId: `platform-fleet-binding-public-${repository.id}`,
          revision: "1",
          digest: digest(`platform-fleet-binding:${appId}:1`),
          appId,
          platformAppId: `registry-${appId}`,
          platformRepositoryId: platformRepository.id,
          platformSourceSha: platformRepository.sourceSha,
          state: "ACTIVE",
        }
      : null,
    providerObservations: isProduct
      ? [
          {
            observationId: `provider-observation-public-${repository.id}`,
            revision: "1",
            digest: digest(`provider-observation:${appId}:1`),
            provider: "github",
            publicIdentity: `repository:${repository.id}`,
            state: "MATCH",
          },
        ]
      : [],
    credentialBindings: isProduct
      ? [
          {
            observationId: `credential-binding-public-${repository.id}`,
            revision: "1",
            digest: digest(`credential-binding:${appId}:1`),
            logicalCredentialId: "shared/github/fleet-app",
            provider: "github-actions",
            capability: "workflow-secret-read",
            environment: "production",
            publicIdentity: "github-app:seorilabs-fleet",
            fingerprint: null,
            status: "ACTIVE",
          },
        ]
      : [],
  });
}

function addBlob(repositoryBlobs, index, path, text) {
  repositoryBlobs[index].push({ path, text });
}

function fullBlobSet(count) {
  const repositoryBlobs = Array.from({ length: count }, () => []);
  if (count !== 38) {
    for (let index = 0; index < count; index += 1) {
      addBlob(repositoryBlobs, index, "README.md", `fixture ${index}\n`);
    }
    return repositoryBlobs;
  }
  for (let index = 0; index < count; index += 1) {
    addBlob(repositoryBlobs, index, "README.md", `fixture ${index}\n`);
  }
  addBlob(
    repositoryBlobs,
    0,
    "Assets/Editor Default Resources.meta",
    "irrelevant spaced path\n",
  );
  addBlob(
    repositoryBlobs,
    0,
    "Plugins/FBLPromise+All.h",
    "irrelevant plus path\n",
  );
  addBlob(
    repositoryBlobs,
    0,
    "Assets/한글 리소스.txt",
    "irrelevant unicode path\n",
  );
  addBlob(repositoryBlobs, 0, "Assets/Icon.png", "upper-case path\n");
  addBlob(repositoryBlobs, 0, "Assets/icon.png", "lower-case path\n");
  for (let index = 1; index <= 13; index += 1) {
    const appId = `registry-${String(index).padStart(2, "0")}`;
    addBlob(
      repositoryBlobs,
      0,
      `registry/apps/${appId}.json`,
      `${JSON.stringify({ appId })}\n`,
    );
  }
  const legacyGroups = [
    ["play-store/google-play.config.json", 19],
    ["app-store/app-store.config.json", 20],
    ["apps-in-toss/apps-in-toss.config.json", 11],
    ["release/market-launch-state.json", 6],
    [".seorilabs/backoffice.json", 3],
  ];
  for (const [path, total] of legacyGroups) {
    for (let index = 1; index <= total; index += 1) {
      addBlob(repositoryBlobs, index, path, `${JSON.stringify({ index })}\n`);
    }
  }
  addBlob(
    repositoryBlobs,
    1,
    ".seorilabs/app.yaml",
    [
      "schemaVersion: 1",
      "app:",
      "  id: app-01",
      "  displayName: App 01",
      "  kind: app",
      "  profile: react-native",
      "  lifecycle: launched",
      "",
    ].join("\n"),
  );
  for (let finding = 0; finding < 108; finding += 1) {
    const index = 1 + (finding % 37);
    const sequence = 1 + Math.floor(finding / 37);
    const floating = finding < 87;
    addBlob(
      repositoryBlobs,
      index,
      `.github/workflows/fleet-${String(sequence).padStart(2, "0")}.yml`,
      [
        "jobs:",
        "  contract:",
        ...(floating
          ? [
              "    uses: seorilabs/.github/.github/workflows/org-contract.yml@main",
            ]
          : []),
        "    secrets: inherit",
        "",
      ].join("\n"),
    );
  }
  return repositoryBlobs;
}

function makeDurableStore({ failCompletionAfterPersist = false } = {}) {
  const byProviderVector = new Map();
  const byOccurrence = new Map();
  let completionFailureRemaining = failCompletionAfterPersist ? 1 : 0;
  return {
    byProviderVector,
    byOccurrence,
    async claim(request) {
      const existing = byProviderVector.get(request.providerVectorDigest);
      if (existing !== undefined) {
        return {
          state: existing.collection === undefined ? "RESUME" : "COMPLETED",
          occurrenceId: existing.occurrenceId,
          runId: existing.runId,
          providerVectorDigest: request.providerVectorDigest,
        };
      }
      const value = {
        occurrenceId: `fleet-occurrence-${request.providerVectorDigest.slice(7, 27)}`,
        runId: request.requestedRunId,
        collection: undefined,
      };
      byProviderVector.set(request.providerVectorDigest, value);
      byOccurrence.set(value.occurrenceId, value);
      return {
        state: "CLAIMED",
        occurrenceId: value.occurrenceId,
        runId: value.runId,
        providerVectorDigest: request.providerVectorDigest,
      };
    },
    async complete(request) {
      const value = byOccurrence.get(request.occurrenceId);
      if (
        value === undefined ||
        value.runId !== request.runId ||
        value.collection !== undefined
      ) {
        throw new Error("durable conflict");
      }
      value.collection = structuredClone(request.collection);
      if (completionFailureRemaining > 0) {
        completionFailureRemaining -= 1;
        throw new Error("transport uncertain after commit");
      }
      return {
        state: "COMPLETED",
        occurrenceId: request.occurrenceId,
        runId: request.runId,
        providerVectorDigest: request.providerVectorDigest,
        collectionDigest: request.collectionDigest,
      };
    },
    async read(request) {
      const value = byOccurrence.get(request.occurrenceId);
      if (
        value?.collection === undefined ||
        value.runId !== request.runId ||
        value.collection.occurrence.providerVectorDigest !==
          request.providerVectorDigest
      ) {
        throw new Error("not found");
      }
      return structuredClone(value.collection);
    },
  };
}

export function makeCollectorFixture({
  count = 2,
  nowMs = Date.now(),
  verifiedCapability = false,
  failCompletionAfterPersist = false,
  pageSize = 20,
} = {}) {
  const repositories = Array.from({ length: count }, (_, index) => {
    const repository = repositoryIdentity(index);
    if (count === 2) {
      repository.fullName =
        index === 0 ? "seorilabs/happy-farm" : "seorilabs/lizard-tycoon";
      repository.classification = "PRODUCT_APP";
    }
    return repository;
  });
  const repositoriesById = new Map(
    repositories.map((repository) => [repository.id, repository]),
  );
  const blobs = fullBlobSet(count);
  const context = {
    nowMs,
    proofBaseMs: nowMs - 20 * 60_000,
    repositories,
    repositoriesById,
  };
  const capability = makeCapability({
    nowMs,
    verified: verifiedCapability,
  });
  const durable = makeDurableStore({ failCompletionAfterPersist });
  const faults = {
    breakCursor: false,
    permissionDenied: false,
    sourceDrift: false,
    truncatedTree: false,
    nonCanonicalBase64: false,
  };
  const headReads = new Map();
  const configuration = {
    organizationId: ORGANIZATION_ID,
    installationId: INSTALLATION_ID,
    detectorRepositoryId: DETECTOR_REPOSITORY_ID,
    detectorSourceSha: DETECTOR_SHA,
    pageSize,
    clock: () => nowMs,
    readGitHubAppCapability: async () => structuredClone(capability),
    readInstallationRepositoriesPage: async (request) => {
      if (faults.permissionDenied) throw new Error("403 provider detail");
      const pageIndex = request.cursor === null ? 0 : Number(request.cursor);
      const start = pageIndex * pageSize;
      const page = repositories.slice(start, start + pageSize);
      const hasNextPage = start + page.length < repositories.length;
      const nextCursor = hasNextPage
        ? faults.breakCursor
          ? request.cursor
          : String(pageIndex + 1)
        : null;
      return {
        contract: "seorilabs-github-installation-repositories-page-v1",
        organization: { id: ORGANIZATION_ID, login: "seorilabs" },
        installationId: INSTALLATION_ID,
        readbackId: "github-repository-page-readback-0001",
        snapshotId: "github-repository-page-snapshot-0001",
        observedAt: new Date(nowMs - 120_000).toISOString(),
        requestCursor: request.cursor,
        nextCursor,
        hasNextPage,
        providerTotalCount: repositories.length,
        repositories: page.map((repository) => ({
          id: repository.id,
          fullName: repository.fullName,
          defaultBranch: repository.defaultBranch,
          archived: false,
          fork: false,
        })),
      };
    },
    readRepositoryHead: async (request) => {
      const repository = repositoriesById.get(request.repositoryId);
      const reads = (headReads.get(repository.id) ?? 0) + 1;
      headReads.set(repository.id, reads);
      return {
        contract: "seorilabs-github-repository-head-readback-v1",
        readbackId: `github-head-readback-${repository.id}-${reads}`,
        observedAt: new Date(
          nowMs - (reads % 2 === 1 ? 110_000 : 70_000),
        ).toISOString(),
        repositoryId: repository.id,
        fullName: repository.fullName,
        defaultRef: repository.defaultRef,
        sourceSha:
          faults.sourceDrift && reads % 2 === 0
            ? sha(`source-drift:${repository.id}`)
            : repository.sourceSha,
        treeSha: repository.treeSha,
      };
    },
    readRepositoryTree: async (request) => ({
      contract: "seorilabs-github-repository-tree-readback-v1",
      readbackId: `github-tree-readback-${request.repositoryId}`,
      observedAt: new Date(nowMs - 105_000).toISOString(),
      repositoryId: request.repositoryId,
      sourceSha: request.sourceSha,
      treeSha: request.treeSha,
      recursive: true,
      truncated: faults.truncatedTree,
      entries: blobs[
        repositories.findIndex(({ id }) => id === request.repositoryId)
      ].map(({ path, text }) => ({
        path,
        type: "BLOB",
        mode: "100644",
        objectSha: gitBlobSha(text),
        size: Buffer.byteLength(text),
      })),
    }),
    readBlob: async (request) => {
      const index = repositories.findIndex(
        ({ id }) => id === request.repositoryId,
      );
      const blob = blobs[index].find(({ path }) => path === request.path);
      let content = Buffer.from(blob.text, "utf8").toString("base64");
      if (faults.nonCanonicalBase64) content = `${content}\n`;
      return {
        contract: "seorilabs-github-repository-blob-readback-v1",
        readbackId: `github-blob-readback-${request.repositoryId}-${sha(request.path).slice(0, 12)}`,
        observedAt: new Date(nowMs - 100_000).toISOString(),
        repositoryId: request.repositoryId,
        sourceSha: request.sourceSha,
        treeSha: request.treeSha,
        path: request.path,
        objectSha: request.objectSha,
        size: Buffer.byteLength(blob.text),
        encoding: "base64",
        content,
      };
    },
    validateLegacyDocument: async (request) => ({
      state: "MATCH",
      contract: request.contract,
      schemaId: request.schemaId,
      contentDigest: request.contentDigest,
      validatorRevision: "fleet-legacy-schema-validator-0001",
    }),
    readBackofficePublicEvidence: async (request) => {
      const repository = repositoriesById.get(request.repositoryId);
      return {
        publicEvidence: publicBackofficeEvidence(context, repository),
        candidates: request.detections.map((scanned) =>
          candidateForDetection(context, repository, scanned),
        ),
      };
    },
    claimOccurrence: durable.claim,
    completeOccurrence: durable.complete,
    readOccurrence: durable.read,
  };
  return {
    blobs,
    capability,
    configuration,
    context,
    durable,
    faults,
    repositories,
  };
}

export function legacyDefinitionForPath(path, fullName) {
  if (
    fullName === "seorilabs/platform" &&
    /^registry\/apps\/[a-z0-9][a-z0-9-]{1,62}\.json$/u.test(path)
  ) {
    return {
      contract: "PLATFORM_REGISTRY_APP",
      schemaId:
        "https://seorilabs.com/contracts/legacy/platform-registry-app.v1.schema.json",
    };
  }
  return LEGACY_DEFINITIONS[path];
}
