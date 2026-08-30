import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign as signEd25519,
} from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createFleetMigrationReadOnlyCollector,
  fleetMigrationCollectorContract,
  isFleetGitHubAppCapabilityVerified,
  validateFleetGitHubAppCapability,
  validateFleetMigrationCollection,
} from "../packages/repo-contract/src/fleet-migration-collector.mjs";
import {
  createFleetMigrationInventoryIssuer,
  fleetMigrationInventoryIssuerContract,
  validateFleetMigrationAuthoritativeInventory,
} from "../packages/repo-contract/src/trusted-inventory-issuer.mjs";
import {
  computeFleetEvidenceDigest,
  computeFleetMigrationInventoryDigest,
  computeFleetMigrationLineageChainDigest,
  computeFleetMigrationRatifiedCohortDigest,
  computeFleetMigrationShadowCohortDigest,
  computeFleetRepositoryReadbackDigest,
  createFleetMigrationAttestationPayload,
  deriveFleetMigrationInventoryCheckpoint,
  fleetMigrationContract,
  isFleetMigrationBaselineRatificationBound,
  validateFleetMigrationInventory,
} from "../packages/repo-contract/src/fleet-migration.mjs";
import {
  canonicalJson,
  makeCapability,
  makeCollectorFixture,
  RATIFIED_COHORT,
} from "./helpers/fleet-migration-collector-fixtures.mjs";

const REQUEST = Object.freeze({
  baselineRatification:
    fleetMigrationContract.initialBaseline.ratification,
  deliveryId: "fleet-collector-delivery-0001",
  inventoryId: "fleet-inventory-collector-0001",
  mode: "READ_ONLY_SHADOW",
  requestedRunId: "fleet-collector-run-0001",
});
const inventorySchema = JSON.parse(
  readFileSync(
    new URL("../contracts/fleet-migration-inventory.schema.json", import.meta.url),
    "utf8",
  ),
);

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function refreshCollectionDigests(collection) {
  collection.inventoryDigest = computeFleetMigrationInventoryDigest(
    collection.inventory,
  );
  const { collectionDigest: _collectionDigest, ...unsigned } = collection;
  collection.collectionDigest = sha256(canonicalJson(unsigned));
  return collection;
}

function waveCollectionFromBootstrap(collection, keys) {
  const prior = structuredClone(collection.inventory);
  const inventoryDigest = computeFleetMigrationInventoryDigest(prior);
  const signedAt = new Date(
    Date.parse(prior.capturedAt) + 1000,
  ).toISOString();
  const payload = createFleetMigrationAttestationPayload(prior, {
    keyId: fleetMigrationInventoryIssuerContract.keyId,
    policyRevision: fleetMigrationInventoryIssuerContract.policyRevision,
    signedAt,
  });
  prior.attestation = {
    algorithm: "Ed25519",
    keyId: fleetMigrationInventoryIssuerContract.keyId,
    policyRevision: fleetMigrationInventoryIssuerContract.policyRevision,
    signedAt,
    inventoryDigest,
    value: signEd25519(null, payload, keys.privateKey).toString("base64url"),
  };
  const checkpoint = deriveFleetMigrationInventoryCheckpoint(prior);
  const wave = structuredClone(collection);
  wave.inventory.inventoryId = "fleet-inventory-collector-wave-0001";
  wave.inventory.lineage = {
    mode: "WAVE",
    waveNumber: 1,
    priorInventoryId: prior.inventoryId,
    priorInventoryDigest: inventoryDigest,
    priorCapturedAt: prior.capturedAt,
    priorObservedCounts: structuredClone(prior.expectedCounts),
    rootInventoryId: prior.inventoryId,
    rootInventoryDigest: inventoryDigest,
    chainDigest: computeFleetMigrationLineageChainDigest([checkpoint]),
    ancestry: [structuredClone(checkpoint)],
  };
  return refreshCollectionDigests(wave);
}

function replaceDurableCollection(fixture, collection) {
  const occurrence = fixture.durable.byOccurrence.get(
    collection.occurrence.occurrenceId,
  );
  occurrence.collection = structuredClone(collection);
}

function publicKeyFingerprint(publicKey) {
  return sha256(publicKey.export({ format: "der", type: "spki" }));
}

function makeSigningKeyReadback(keys, nowMs, overrides = {}) {
  const value = {
    contract: "seorilabs-fleet-signing-key-public-identity-v1",
    readbackId: "inventory-signing-key-readback-0001",
    revision: "inventory-signing-key-public-revision-0001",
    observedAt: new Date(nowMs - 20_000).toISOString(),
    algorithm: "Ed25519",
    credentialId: "shared/platform/fleet-release-approval-signing",
    keyId: "platform-fleet-release-20260829-5458c56b",
    keyPurpose: "FLEET_MIGRATION_INVENTORY_ATTESTATION",
    keyFingerprint: publicKeyFingerprint(keys.publicKey),
    state: "ACTIVE",
    ...overrides,
    evidenceDigest: "sha256:" + "0".repeat(64),
  };
  value.evidenceDigest = computeFleetEvidenceDigest(value);
  return value;
}

function signingResult(request, keys, overrides = {}) {
  return {
    algorithm: "Ed25519",
    credentialId: request.credentialId,
    keyFingerprint: publicKeyFingerprint(keys.publicKey),
    keyId: request.keyId,
    value: signEd25519(null, request.payload, keys.privateKey).toString(
      "base64url",
    ),
    ...overrides,
  };
}

function currentCapability(capability, nowMs) {
  const value = structuredClone(capability);
  value.revision = "github-app-capability-current-readback-0002";
  value.observedAt = new Date(nowMs).toISOString();
  value.app.readbackId = "github-app-readback-current-0002";
  value.installation.readbackId =
    "github-installation-readback-current-0002";
  if (value.eventAcceptance.state === "ACCEPTED") {
    value.eventAcceptance.deliveryId =
      "github-delivery-repository-current-0002";
    value.eventAcceptance.acceptedAt = new Date(nowMs - 1_000).toISOString();
  }
  value.eventAcceptance.appReadbackId = value.app.readbackId;
  value.eventAcceptance.installationReadbackId =
    value.installation.readbackId;
  value.eventAcceptance.evidenceDigest = computeFleetEvidenceDigest(
    value.eventAcceptance,
  );
  value.evidenceDigest = computeFleetEvidenceDigest(value);
  return value;
}

async function collect(fixture, request = REQUEST) {
  return createFleetMigrationReadOnlyCollector(
    fixture.configuration,
  ).collect(request);
}

test("collector trusted time은 canonical 정수 밀리초만 허용한다", async () => {
  const fixture = makeCollectorFixture({ count: 2, nowMs: Date.now() });
  fixture.configuration.clock = () => Date.now() + 0.5;

  await assert.rejects(
    collect(fixture),
    /FLEET_MIGRATION_COLLECTOR_TIME_INVALID/u,
  );
});

test("collector evidence schema는 classification decision 계약과 일치한다", () => {
  const properties =
    inventorySchema.$defs.collectorBackofficeEvidence.properties;

  assert.equal(properties.classificationDecisionRevision.minimum, 1);
  assert.deepEqual(properties.classificationDecisionId, {
    $ref: "#/$defs/evidenceId",
  });

  const capability =
    inventorySchema.$defs.collectorGitHubAppCapability.properties;
  assert.equal(capability.app.properties.permissions.uniqueItems, true);
  assert.equal(capability.app.properties.events.uniqueItems, true);
  assert.equal(capability.installation.properties.permissions.uniqueItems, true);

  const ratification = inventorySchema.$defs.baselineRatification;
  assert.deepEqual(ratification.properties.reason.enum, [
    "PRE_AUTHORITATIVE_SECURITY_REMEDIATION",
  ]);
  assert.equal(
    ratification.properties.expectedCounts.properties.workflowSecretsInherit
      .const,
    107,
  );
  assert.equal(
    ratification.properties.expectedCounts.properties.workflowFloatingRef
      .const,
    86,
  );
  const contractRatification =
    fleetMigrationContract.initialBaseline.ratification;
  assert.equal(contractRatification.detector.repositoryId, "1241442018");
  assert.equal(
    contractRatification.detector.sourceSha,
    "cd13b325918cb10401e089074461ba11042c154e",
  );
  assert.equal(
    contractRatification.cohortDigest,
    "6b940f78bf810b5f725ff6c2d71af14fe2127d0de98c893e180594eeae29460d",
  );
  assert.equal(
    contractRatification.platform.remediationCommitSha,
    "c23e7717286bd34c2a89eba2f3f445f3989be6f2",
  );
  assert.equal(
    contractRatification.platform.remediationChecksBlobSha,
    "104d491c6c67d14639d820a9c8839756c24b812f",
  );
  assert.equal(
    contractRatification.platform.remediationPublishBlobSha,
    "4b0eeca5ab83585b9c63f0302218a5c3eb604e25",
  );
  assert.deepEqual(contractRatification.platform.countTransition.ratified, {
    activeRepositories: 38,
    legacyOperationJson: 73,
    workflowSecretsInherit: 107,
    workflowFloatingRef: 86,
  });
});

test("ratified cohort digest는 Backoffice shadow-readiness v2 exact vector에서 재현된다", () => {
  const repositories = RATIFIED_COHORT.map((repository) => ({
    id: repository.id,
    fullName: repository.fullName,
    defaultRef: `refs/heads/${repository.defaultBranch}`,
    sourceSha: repository.sourceSha,
    archived: false,
    private: repository.private,
    fork: false,
  }));
  const cohortDigest = computeFleetMigrationShadowCohortDigest({
    installationId: "142120077",
    repositories,
  });

  assert.equal(
    cohortDigest,
    fleetMigrationContract.initialBaseline.ratification.cohortDigest,
  );
  assert.equal(
    cohortDigest,
    "6b940f78bf810b5f725ff6c2d71af14fe2127d0de98c893e180594eeae29460d",
  );

  const currentRepositories = structuredClone(repositories);
  const detectorRepositoryId =
    fleetMigrationContract.initialBaseline.ratification.detector.repositoryId;
  currentRepositories.find(
    ({ id }) => id === detectorRepositoryId,
  ).sourceSha = "e".repeat(40);
  assert.notEqual(
    computeFleetMigrationShadowCohortDigest({
      installationId: "142120077",
      repositories: currentRepositories,
    }),
    cohortDigest,
  );
  assert.equal(
    computeFleetMigrationRatifiedCohortDigest({
      installationId: "142120077",
      repositories: currentRepositories,
      detectorSourceSha: "e".repeat(40),
    }),
    cohortDigest,
  );
  assert.throws(
    () =>
      computeFleetMigrationRatifiedCohortDigest({
        installationId: "142120077",
        repositories: currentRepositories,
        detectorSourceSha: "f".repeat(40),
      }),
    /FLEET_MIGRATION_DETECTOR_SOURCE_MISMATCH/u,
  );
});

test("shadow bootstrap은 exact public baseline ratification 입력만 허용한다", async () => {
  const fixture = makeCollectorFixture({ count: 38, nowMs: Date.now() });
  const missing = structuredClone(REQUEST);
  delete missing.baselineRatification;
  await assert.rejects(
    collect(fixture, missing),
    /FLEET_MIGRATION_COLLECTION_REQUEST_INVALID/u,
  );

  const tampered = structuredClone(REQUEST);
  tampered.baselineRatification.reason = "MANUAL_COUNT_OVERRIDE";
  await assert.rejects(
    collect(fixture, tampered),
    /FLEET_MIGRATION_COLLECTION_REQUEST_INVALID/u,
  );

  const wrongDetectorRepository = makeCollectorFixture({
    count: 38,
    nowMs: Date.now(),
  });
  wrongDetectorRepository.configuration.detectorRepositoryId = "999999999";
  await assert.rejects(
    collect(wrongDetectorRepository),
    /FLEET_MIGRATION_COLLECTION_REQUEST_INVALID/u,
  );

  const wrongDetectorSource = makeCollectorFixture({
    count: 38,
    nowMs: Date.now(),
  });
  wrongDetectorSource.configuration.detectorSourceSha = "f".repeat(40);
  await assert.rejects(
    collect(wrongDetectorSource),
    /FLEET_MIGRATION_DETECTOR_SOURCE_MISMATCH/u,
  );

  const cohortDrifted = makeCollectorFixture({
    count: 38,
    nowMs: Date.now(),
  });
  cohortDrifted.repositories[0].private =
    !cohortDrifted.repositories[0].private;
  await assert.rejects(
    collect(cohortDrifted),
    /FLEET_MIGRATION_BASELINE_RATIFICATION_MISMATCH/u,
  );

  const drifted = makeCollectorFixture({ count: 38, nowMs: Date.now() });
  const workflow = drifted.blobs
    .flat()
    .find(({ path }) => path.endsWith("fleet-03.yml"));
  workflow.text = workflow.text.replace("    secrets: inherit\n", "");
  await assert.rejects(
    collect(drifted),
    /FLEET_MIGRATION_BASELINE_RATIFICATION_MISMATCH/u,
  );
});

test("detector repo main 이동만 historical ratification에 정규화하고 actual runtime SHA를 inventory에 서명한다", async () => {
  const nowMs = Date.now();
  const fixture = makeCollectorFixture({
    count: 38,
    nowMs,
    verifiedCapability: true,
  });
  const detectorRepositoryId =
    fleetMigrationContract.initialBaseline.ratification.detector.repositoryId;
  const runtimeDetectorSha = "e".repeat(40);
  const detectorRepository = fixture.repositories.find(
    ({ id }) => id === detectorRepositoryId,
  );
  detectorRepository.sourceSha = runtimeDetectorSha;
  fixture.configuration.detectorSourceSha = runtimeDetectorSha;

  const collection = await collect(fixture);
  assert.equal(collection.inventory.detector.sourceSha, runtimeDetectorSha);
  assert.equal(
    collection.inventory.repositories.find(
      ({ repository }) => repository.id === detectorRepository.id,
    ).repository.sourceSha,
    runtimeDetectorSha,
  );
  assert.equal(
    isFleetMigrationBaselineRatificationBound(collection.inventory),
    true,
  );
  const keys = generateKeyPairSync("ed25519");
  const issuance = await makeIssuer(fixture, keys).issueAuthoritative(
    collection,
  );
  assert.equal(issuance.inventory.detector.sourceSha, runtimeDetectorSha);
  assert.equal(
    issuance.inventory.attestation.inventoryDigest,
    issuance.inventoryDigest,
  );
  assert.equal(
    validateFleetMigrationAuthoritativeInventory(
      issuance,
      keys.publicKey,
      { now: nowMs },
    ).ok,
    true,
  );

  const otherRepositoryDrift = makeCollectorFixture({
    count: 38,
    nowMs: Date.now(),
  });
  otherRepositoryDrift.repositories.find(
    ({ id }) => id !== detectorRepository.id,
  ).sourceSha = "e".repeat(40);
  await assert.rejects(
    collect(otherRepositoryDrift),
    /FLEET_MIGRATION_BASELINE_RATIFICATION_MISMATCH/u,
  );
});

function makeIssuer(
  fixture,
  keys,
  {
    clock = fixture.configuration.clock,
    readGitHubAppCapability,
    readOccurrence = fixture.durable.read,
    readSigningKeyPublicIdentity,
    signer,
  } = {},
) {
  const clockValue = clock();
  const nowMs =
    clockValue instanceof Date
      ? clockValue.getTime()
      : typeof clockValue === "number"
        ? clockValue
        : Date.parse(clockValue);
  return createFleetMigrationInventoryIssuer({
    clock,
    inventoryPublicKey: keys.publicKey,
    readGitHubAppCapability:
      readGitHubAppCapability ??
      (async () => currentCapability(fixture.capability, nowMs)),
    readOccurrence,
    readSigningKeyPublicIdentity:
      readSigningKeyPublicIdentity ??
      (async () => makeSigningKeyReadback(keys, nowMs)),
    signInventoryPayload:
      signer ??
      (async (request) => signingResult(request, keys)),
  });
}

test("2-repository fixture는 public evidence만 가진 비권위 collection으로 수렴한다", async () => {
  const nowMs = Date.now();
  const fixture = makeCollectorFixture({ count: 2, nowMs });
  const result = await collect(fixture, {
    ...REQUEST,
    baselineRatification: null,
    mode: "FIXTURE",
  });
  assert.equal(result.state, "FIXTURE_COMPLETE");
  assert.equal(result.authoritative, false);
  assert.equal(result.readyForPlanning, false);
  assert.equal(result.inventory.attestation, null);
  assert.equal(result.inventory.repositories.length, 2);
  assert.deepEqual(
    result.inventory.repositories.map(({ repository }) => repository.fullName),
    ["seorilabs/happy-farm", "seorilabs/lizard-tycoon"],
  );
  assert.deepEqual(result.inventory.expectedCounts, {
    activeRepositories: 2,
    legacyOperationJson: 0,
    workflowSecretsInherit: 0,
    workflowFloatingRef: 0,
  });
  assert.equal(validateFleetMigrationCollection(result).ok, true);
  assert.equal(isFleetGitHubAppCapabilityVerified(fixture.capability), false);
  assert.equal(validateFleetGitHubAppCapability(fixture.capability).ok, true);
});

test("38-repository exact fixture와 verified capability만 authoritative READY를 발급한다", async () => {
  const nowMs = Date.now();
  const fixture = makeCollectorFixture({
    count: 38,
    nowMs,
    verifiedCapability: true,
  });
  let legacyValidationCount = 0;
  let orgContractValidation;
  const validateLegacyDocument = fixture.configuration.validateLegacyDocument;
  fixture.configuration.validateLegacyDocument = async (request) => {
    legacyValidationCount += 1;
    if (request.contract === "ORG_CONTRACT_APP") {
      orgContractValidation = structuredClone(request);
    }
    return validateLegacyDocument(request);
  };
  const collection = await collect(fixture);
  assert.equal(collection.inventory.repositories.length, 38);
  assert.deepEqual(collection.inventory.expectedCounts, {
    activeRepositories: 38,
    legacyOperationJson: 73,
    workflowSecretsInherit: 107,
    workflowFloatingRef: 86,
  });
  assert.deepEqual(
    collection.inventory.baselineRatification,
    fleetMigrationContract.initialBaseline.ratification,
  );
  const ratificationKeys = [];
  const visitRatification = (value) => {
    if (value === null || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      ratificationKeys.push(key);
      visitRatification(nested);
    }
  };
  visitRatification(collection.inventory.baselineRatification);
  for (const generatedKey of [
    "capturedAt",
    "collectionDigest",
    "expiresAt",
    "inventoryDigest",
    "inventoryId",
    "keyId",
    "signature",
    "signedAt",
  ]) {
    assert.equal(ratificationKeys.includes(generatedKey), false);
  }
  assert.equal(legacyValidationCount, 73);
  assert.equal(
    collection.inventory.repositories.every(
      ({ observation }) =>
        observation.treeReadback.blobCount >
        observation.treeReadback.scannedBlobCount,
    ),
    true,
  );
  const platformObservation = collection.inventory.repositories.find(
    ({ repository }) => repository.fullName === "seorilabs/platform",
  ).observation;
  assert.equal(
    platformObservation.treeReadback.blobCount -
      platformObservation.treeReadback.scannedBlobCount >=
      4,
    true,
  );
  assert.equal(
    orgContractValidation.schemaId,
    "https://seorilabs.github.io/contracts/v1/app.schema.json",
  );
  assert.equal(orgContractValidation.path, ".seorilabs/app.yaml");
  assert.equal(orgContractValidation.document.app.id, "app-01");
  assert.equal(isFleetGitHubAppCapabilityVerified(fixture.capability), true);

  const keys = generateKeyPairSync("ed25519");
  const issuedAtMs = nowMs + 60_000;
  let signerRequest;
  let signedPayload;
  const issuer = makeIssuer(fixture, keys, {
    clock: () => issuedAtMs,
    readGitHubAppCapability: async (request) => {
      assert.deepEqual(Object.keys(request).sort(), [
        "contract",
        "installationId",
        "organizationId",
        "readMode",
      ]);
      assert.equal(request.readMode, "CURRENT_PUBLIC_STATE");
      return currentCapability(fixture.capability, issuedAtMs);
    },
    readSigningKeyPublicIdentity: async (request) => {
      assert.deepEqual(Object.keys(request).sort(), [
        "contract",
        "credentialId",
        "keyId",
        "keyPurpose",
        "readMode",
      ]);
      assert.equal(
        request.credentialId,
        "shared/platform/fleet-release-approval-signing",
      );
      assert.equal(
        request.keyId,
        "platform-fleet-release-20260829-5458c56b",
      );
      assert.equal(Object.hasOwn(request, "privateKey"), false);
      assert.equal(Object.hasOwn(request, "secret"), false);
      assert.equal(request.readMode, "CURRENT_PUBLIC_METADATA");
      return makeSigningKeyReadback(keys, issuedAtMs);
    },
    signer: async (request) => {
      signerRequest = request;
      signedPayload = JSON.parse(request.payload.toString("utf8"));
      assert.equal(
        request.credentialId,
        "shared/platform/fleet-release-approval-signing",
      );
      assert.equal(
        request.keyId,
        "platform-fleet-release-20260829-5458c56b",
      );
      assert.equal(
        request.keyPurpose,
        "FLEET_MIGRATION_INVENTORY_ATTESTATION",
      );
      assert.equal(request.payloadDigest, sha256(request.payload));
      assert.equal(
        request.collectionCapabilityEvidenceDigest,
        collection.inventory.collectionEvidence.githubAppCapability
          .evidenceDigest,
      );
      assert.notEqual(
        request.issuanceCapabilityEvidenceDigest,
        request.collectionCapabilityEvidenceDigest,
      );
      assert.equal(Object.hasOwn(request, "privateKey"), false);
      assert.equal(Object.hasOwn(request, "secret"), false);
      return signingResult(request, keys);
    },
  });
  const issuance = await issuer.issueAuthoritative(collection);
  assert.equal(issuance.state, "READY");
  assert.equal(issuance.authoritative, true);
  assert.equal(issuance.readyForPlanning, true);
  assert.deepEqual(
    signedPayload.baselineRatification,
    fleetMigrationContract.initialBaseline.ratification,
  );
  assert.equal(
    issuance.collectionCapabilityEvidenceDigest,
    collection.inventory.collectionEvidence.githubAppCapability
      .evidenceDigest,
  );
  assert.equal(
    issuance.issuanceCapabilityEvidenceDigest,
    issuance.inventory.collectionEvidence.issuanceGitHubAppCapability
      .evidenceDigest,
  );
  assert.notEqual(
    issuance.collectionCapabilityEvidenceDigest,
    issuance.issuanceCapabilityEvidenceDigest,
  );
  assert.equal(
    issuance.inventory.collectionEvidence.issuanceGitHubAppCapability
      .observedAt,
    new Date(issuedAtMs).toISOString(),
  );
  assert.equal(
    issuance.inventory.attestation.signedAt,
    new Date(issuedAtMs).toISOString(),
  );
  assert.equal(
    Date.parse(issuance.inventory.attestation.signedAt) >=
      Date.parse(issuance.inventory.capturedAt),
    true,
  );
  assert.equal(
    validateFleetMigrationAuthoritativeInventory(issuance, keys.publicKey, {
      now: issuedAtMs,
    }).ok,
    true,
  );
  const reusedReadback = structuredClone(issuance);
  const reusedCapability =
    reusedReadback.inventory.collectionEvidence
      .issuanceGitHubAppCapability;
  reusedCapability.app.readbackId =
    collection.inventory.collectionEvidence.githubAppCapability.app.readbackId;
  reusedCapability.eventAcceptance.appReadbackId =
    reusedCapability.app.readbackId;
  reusedCapability.eventAcceptance.evidenceDigest =
    computeFleetEvidenceDigest(reusedCapability.eventAcceptance);
  reusedCapability.evidenceDigest =
    computeFleetEvidenceDigest(reusedCapability);
  reusedReadback.inventory.collectionEvidence.evidenceDigest =
    computeFleetEvidenceDigest(
      reusedReadback.inventory.collectionEvidence,
    );
  reusedReadback.issuanceCapabilityEvidenceDigest =
    reusedCapability.evidenceDigest;
  reusedReadback.inventoryDigest =
    computeFleetMigrationInventoryDigest(reusedReadback.inventory);
  reusedReadback.inventory.attestation.inventoryDigest =
    reusedReadback.inventoryDigest;
  const reusedPayload = createFleetMigrationAttestationPayload(
    reusedReadback.inventory,
    {
      keyId: reusedReadback.inventory.attestation.keyId,
      policyRevision:
        reusedReadback.inventory.attestation.policyRevision,
      signedAt: reusedReadback.inventory.attestation.signedAt,
    },
  );
  reusedReadback.inventory.attestation.value = signEd25519(
    null,
    reusedPayload,
    keys.privateKey,
  ).toString("base64url");
  reusedPayload.fill(0);
  const { issuanceDigest: _issuanceDigest, ...unsignedReusedReadback } =
    reusedReadback;
  reusedReadback.issuanceDigest = sha256(
    canonicalJson(unsignedReusedReadback),
  );
  assert.equal(
    validateFleetMigrationAuthoritativeInventory(
      reusedReadback,
      keys.publicKey,
      { now: issuedAtMs },
    ).ok,
    false,
  );
  assert.equal(
    validateFleetMigrationAuthoritativeInventory(issuance, keys.publicKey).ok,
    false,
  );
  assert.equal(
    validateFleetMigrationAuthoritativeInventory(issuance, keys.publicKey, {
      now: nowMs + 15 * 60_000,
    }).ok,
    false,
  );
  assert.equal(signerRequest.payload.every((byte) => byte === 0), true);
});

test("issuer는 claimed detector와 live repo HEAD mismatch 및 canonical cohort drift를 서명 전에 거부한다", async () => {
  const nowMs = Date.now();
  const fixture = makeCollectorFixture({
    count: 38,
    nowMs,
    verifiedCapability: true,
  });
  const original = await collect(fixture);
  const keys = generateKeyPairSync("ed25519");
  let signerCalled = false;
  const issuer = makeIssuer(fixture, keys, {
    signer: async () => {
      signerCalled = true;
      throw new Error("must not sign");
    },
  });

  for (const [field, value] of [
    ["repositoryId", "999999999"],
    ["sourceSha", "f".repeat(40)],
  ]) {
    const detectorDrifted = structuredClone(original);
    detectorDrifted.inventory.detector[field] = value;
    refreshCollectionDigests(detectorDrifted);
    assert.equal(validateFleetMigrationCollection(detectorDrifted).ok, true);
    replaceDurableCollection(fixture, detectorDrifted);
    await assert.rejects(
      issuer.issueAuthoritative(detectorDrifted),
      /FLEET_MIGRATION_INVENTORY_NOT_AUTHORITATIVE/u,
    );
  }

  const unratified = structuredClone(original);
  delete unratified.inventory.baselineRatification;
  refreshCollectionDigests(unratified);
  assert.equal(validateFleetMigrationCollection(unratified).ok, true);
  replaceDurableCollection(fixture, unratified);
  await assert.rejects(
    issuer.issueAuthoritative(unratified),
    /FLEET_MIGRATION_INVENTORY_NOT_AUTHORITATIVE/u,
  );

  const cohortDrifted = structuredClone(original);
  cohortDrifted.inventory.repositories[0].repository.private =
    !cohortDrifted.inventory.repositories[0].repository.private;
  cohortDrifted.inventory.coverage.repositoriesDigest =
    computeFleetRepositoryReadbackDigest({
      organizationId: cohortDrifted.inventory.organization.id,
      repositories: cohortDrifted.inventory.repositories.map(
        ({ repository }) => repository,
      ),
    });
  refreshCollectionDigests(cohortDrifted);
  assert.equal(validateFleetMigrationCollection(cohortDrifted).ok, true);
  replaceDurableCollection(fixture, cohortDrifted);
  await assert.rejects(
    issuer.issueAuthoritative(cohortDrifted),
    /FLEET_MIGRATION_INVENTORY_NOT_AUTHORITATIVE/u,
  );
  assert.equal(signerCalled, false);
});

test("issuer는 ratified ancestry가 있어도 current WAVE ratification 삭제와 변조를 서명 전에 거부한다", async () => {
  const nowMs = Date.now();
  const fixture = makeCollectorFixture({
    count: 38,
    nowMs,
    verifiedCapability: true,
  });
  const original = await collect(fixture);
  const keys = generateKeyPairSync("ed25519");
  let signerCalled = false;
  const issuer = makeIssuer(fixture, keys, {
    signer: async () => {
      signerCalled = true;
      throw new Error("must not sign");
    },
  });

  for (const mutate of [
    (inventory) => delete inventory.baselineRatification,
    (inventory) => {
      inventory.baselineRatification = null;
    },
  ]) {
    const wave = waveCollectionFromBootstrap(original, keys);
    mutate(wave.inventory);
    refreshCollectionDigests(wave);
    assert.deepEqual(validateFleetMigrationInventory(wave.inventory), {
      ok: true,
      diagnostics: [],
    });
    assert.deepEqual(validateFleetMigrationCollection(wave), {
      ok: true,
      diagnostics: [],
    });
    assert.deepEqual(
      wave.inventory.lineage.ancestry[0].baselineRatification,
      fleetMigrationContract.initialBaseline.ratification,
    );
    replaceDurableCollection(fixture, wave);
    await assert.rejects(
      issuer.issueAuthoritative(wave),
      /FLEET_MIGRATION_INVENTORY_NOT_AUTHORITATIVE/u,
    );
  }
  assert.equal(signerCalled, false);
});

test("collector fixture도 공용 legacy schema validator로 malformed 문서를 거부한다", async () => {
  const fixture = makeCollectorFixture({
    count: 38,
    nowMs: Date.now(),
    verifiedCapability: true,
  });
  const legacyBlob = fixture.blobs[1].find(
    ({ path }) => path === "release/market-launch-state.json",
  );
  legacyBlob.text = `${JSON.stringify({ schemaVersion: 1 })}\n`;

  await assert.rejects(
    collect(fixture),
    /FLEET_MIGRATION_COLLECTOR_LEGACY_SCHEMA_VALIDATION_FAILED/u,
  );
});

test("current live permission/event mismatch는 public shadow까지만 허용한다", async () => {
  const nowMs = Date.now();
  const fixture = makeCollectorFixture({ count: 38, nowMs });
  const collection = await collect(fixture);
  const keys = generateKeyPairSync("ed25519");
  let signerCalled = false;
  const issuer = makeIssuer(fixture, keys, {
    signer: async () => {
      signerCalled = true;
      throw new Error("must not sign");
    },
  });
  await assert.rejects(
    issuer.issueAuthoritative(collection),
    /GITHUB_APP_CAPABILITY_UNVERIFIED/u,
  );
  assert.equal(signerCalled, false);
});

test("같은 provider vector의 duplicate delivery는 동일 durable occurrence와 collection을 replay한다", async () => {
  const fixture = makeCollectorFixture({ count: 2, nowMs: Date.now() });
  const first = await collect(fixture, {
    ...REQUEST,
    baselineRatification: null,
    mode: "FIXTURE",
  });
  const second = await collect(fixture, {
    baselineRatification: null,
    deliveryId: "fleet-collector-delivery-duplicate-0002",
    inventoryId: "fleet-inventory-duplicate-ignored-0002",
    mode: "FIXTURE",
    requestedRunId: "fleet-collector-run-duplicate-0002",
  });
  assert.deepEqual(second, first);
  assert.equal(fixture.durable.byProviderVector.size, 1);
  assert.equal(fixture.durable.byOccurrence.size, 1);
});

test("completion 결과 불명은 재수집 뒤 같은 occurrence/run의 durable result를 읽는다", async () => {
  const fixture = makeCollectorFixture({
    count: 2,
    nowMs: Date.now(),
    failCompletionAfterPersist: true,
  });
  await assert.rejects(
    collect(fixture, {
      ...REQUEST,
      baselineRatification: null,
      mode: "FIXTURE",
    }),
    /FLEET_MIGRATION_COLLECTION_COMPLETION_UNKNOWN/u,
  );
  const resumed = await collect(fixture, {
    baselineRatification: null,
    deliveryId: "fleet-collector-delivery-resume-0002",
    inventoryId: "fleet-inventory-resume-0002",
    mode: "FIXTURE",
    requestedRunId: "fleet-collector-run-resume-0002",
  });
  assert.equal(resumed.occurrence.runId, REQUEST.requestedRunId);
  assert.equal(fixture.durable.byOccurrence.size, 1);
});

test("pagination cursor 단절과 provider permission failure를 absence로 바꾸지 않는다", async () => {
  const broken = makeCollectorFixture({ count: 38, nowMs: Date.now() });
  broken.faults.breakCursor = true;
  await assert.rejects(
    collect(broken),
    /FLEET_MIGRATION_COLLECTOR_PAGINATION_MISMATCH/u,
  );

  const denied = makeCollectorFixture({ count: 2, nowMs: Date.now() });
  denied.faults.permissionDenied = true;
  await assert.rejects(
    collect(denied),
    (error) =>
      error.message ===
        "FLEET_MIGRATION_COLLECTOR_GITHUB_PAGE_READBACK_FAILED" &&
      !error.message.includes("403 provider detail"),
  );
});

test("truncated tree, source drift와 non-canonical base64를 fail-closed한다", async () => {
  const truncated = makeCollectorFixture({ count: 2, nowMs: Date.now() });
  truncated.faults.truncatedTree = true;
  await assert.rejects(
    collect(truncated),
    /FLEET_MIGRATION_COLLECTOR_TREE_READBACK_MISMATCH/u,
  );

  const drifted = makeCollectorFixture({ count: 2, nowMs: Date.now() });
  drifted.faults.sourceDrift = true;
  await assert.rejects(
    collect(drifted),
    /FLEET_MIGRATION_COLLECTOR_SOURCE_DRIFT/u,
  );

  const encoded = makeCollectorFixture({ count: 2, nowMs: Date.now() });
  encoded.blobs[0].push({
    path: ".github/workflows/contract.yml",
    text: "jobs:\n  contract:\n    secrets: inherit\n",
  });
  encoded.faults.nonCanonicalBase64 = true;
  await assert.rejects(
    collect(encoded),
    /FLEET_MIGRATION_COLLECTOR_BLOB_READBACK_MISMATCH/u,
  );

  const symlink = makeCollectorFixture({ count: 2, nowMs: Date.now() });
  const readTree = symlink.configuration.readRepositoryTree;
  symlink.configuration.readRepositoryTree = async (request) => {
    const tree = await readTree(request);
    tree.entries[0].mode = "120000";
    return tree;
  };
  await assert.rejects(
    collect(symlink),
    /FLEET_MIGRATION_COLLECTOR_TREE_ENTRY_UNSAFE/u,
  );
});

test("전체 tree digest는 유지하되 detector 관련 BLOB만 읽는다", async () => {
  const fixture = makeCollectorFixture({ count: 2, nowMs: Date.now() });
  const relevantPath = ".github/workflows/contract.yml";
  const irrelevantPath = "assets/archive-video.bin";
  fixture.blobs[0].push({
    path: relevantPath,
    text: "jobs:\n  contract:\n    secrets: inherit\n",
  });
  const readTree = fixture.configuration.readRepositoryTree;
  fixture.configuration.readRepositoryTree = async (request) => {
    const tree = await readTree(request);
    if (request.repositoryId === fixture.repositories[0].id) {
      tree.entries.push({
        path: irrelevantPath,
        type: "BLOB",
        mode: "100644",
        objectSha: "f".repeat(40),
        size: 512 * 1024 * 1024,
      });
    }
    return tree;
  };
  const blobReads = [];
  const readBlob = fixture.configuration.readBlob;
  fixture.configuration.readBlob = async (request) => {
    blobReads.push(request.path);
    if (request.path === irrelevantPath) {
      throw new Error("irrelevant binary must not be fetched");
    }
    return readBlob(request);
  };
  const collection = await collect(fixture, {
    ...REQUEST,
    baselineRatification: null,
    mode: "FIXTURE",
  });
  const first = collection.inventory.repositories[0].observation.treeReadback;
  const evidence =
    collection.inventory.collectionEvidence.repositoryEvidence[0];
  assert.deepEqual(blobReads, [relevantPath]);
  assert.equal(first.blobCount, 3);
  assert.equal(first.scannedBlobCount, 1);
  assert.equal(evidence.blobReadbacks.length, 1);
  assert.equal(evidence.blobReadbacks[0].path, relevantPath);

  const oversized = makeCollectorFixture({ count: 2, nowMs: Date.now() });
  const oversizedTree = oversized.configuration.readRepositoryTree;
  oversized.configuration.readRepositoryTree = async (request) => {
    const tree = await oversizedTree(request);
    if (request.repositoryId === oversized.repositories[0].id) {
      tree.entries.push({
        path: ".github/workflows/oversized.yml",
        type: "BLOB",
        mode: "100644",
        objectSha: "e".repeat(40),
        size: 10 * 1024 * 1024 + 1,
      });
    }
    return tree;
  };
  oversized.configuration.readBlob = async () => {
    throw new Error("oversized relevant blob must not be fetched");
  };
  await assert.rejects(
    collect(oversized, {
      ...REQUEST,
      baselineRatification: null,
      mode: "FIXTURE",
    }),
    /FLEET_MIGRATION_COLLECTOR_RELEVANT_BLOB_TOO_LARGE/u,
  );
});

test("Git tree의 공백, plus, Unicode와 backslash path를 손실 없이 digest에 반영한다", async () => {
  const fixture = makeCollectorFixture({ count: 2, nowMs: Date.now() });
  const extraPaths = [
    "Assets/Editor Default Resources.meta",
    "addons/FBLPromise+All.h",
    "assets/요약 아이콘.png",
    String.raw`assets/literal\backslash.txt`,
    "assets/\u{e000}.txt",
    "assets/\u{10000}.txt",
  ];
  const readTree = fixture.configuration.readRepositoryTree;
  let expectedEntries;
  fixture.configuration.readRepositoryTree = async (request) => {
    const tree = await readTree(request);
    if (request.repositoryId === fixture.repositories[0].id) {
      tree.entries.push(
        ...extraPaths.map((path, index) => ({
          path,
          type: "BLOB",
          mode: "100644",
          objectSha: String(index + 1).repeat(40),
          size: 1,
        })),
      );
      expectedEntries = structuredClone(tree.entries).sort((left, right) =>
        Buffer.compare(
          Buffer.from(left.path, "utf8"),
          Buffer.from(right.path, "utf8"),
        ),
      );
    }
    return tree;
  };
  const collected = await collect(fixture, {
    ...REQUEST,
    baselineRatification: null,
    mode: "FIXTURE",
  });
  const repository = collected.inventory.repositories[0];
  assert.equal(
    repository.observation.treeReadback.entryCount,
    1 + extraPaths.length,
  );
  assert.equal(
    repository.observation.treeReadback.canonicalEntriesDigest,
    sha256(
      canonicalJson({
        contract: "seorilabs-fleet-migration-tree-entries-v1",
        repositoryId: repository.repository.id,
        sourceSha: repository.repository.sourceSha,
        treeSha: repository.observation.treeSha,
        entries: expectedEntries,
      }),
    ),
  );
});

test("workflow detector는 YAML job semantics만 인식하고 malformed YAML은 닫는다", async () => {
  const incidental = makeCollectorFixture({ count: 2, nowMs: Date.now() });
  incidental.blobs[0].push({
    path: ".github/workflows/incidental.yml",
    text: [
      "# secrets: inherit",
      "env:",
      "  NOTE: seorilabs/.github/.github/workflows/org-contract.yml@main",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: \"echo 'secrets: inherit'\"",
      "",
    ].join("\n"),
  });
  const clean = await collect(incidental, {
    ...REQUEST,
    baselineRatification: null,
    mode: "FIXTURE",
  });
  assert.equal(clean.inventory.expectedCounts.workflowSecretsInherit, 0);
  assert.equal(clean.inventory.expectedCounts.workflowFloatingRef, 0);

  const malformed = makeCollectorFixture({ count: 2, nowMs: Date.now() });
  malformed.blobs[0].push({
    path: ".github/workflows/duplicate.yml",
    text: "jobs:\n  test: {}\n  test: {}\n",
  });
  await assert.rejects(
    collect(malformed, {
      ...REQUEST,
      baselineRatification: null,
      mode: "FIXTURE",
    }),
    /FLEET_MIGRATION_COLLECTOR_WORKFLOW_YAML_INVALID/u,
  );
});

test("candidate substitution과 schema additionalProperties 우회를 거부한다", async () => {
  const substituted = makeCollectorFixture({ count: 38, nowMs: Date.now() });
  const readBackoffice =
    substituted.configuration.readBackofficePublicEvidence;
  substituted.configuration.readBackofficePublicEvidence = async (request) => {
    const result = await readBackoffice(request);
    if (result.candidates.length > 0) {
      result.candidates[0].contentDigest = "sha256:" + "0".repeat(64);
    }
    return result;
  };
  await assert.rejects(
    collect(substituted),
    /FLEET_MIGRATION_COLLECTOR_CANDIDATE_BINDING_MISMATCH/u,
  );

  const extra = makeCollectorFixture({ count: 2, nowMs: Date.now() });
  extra.configuration.readGitHubAppCapability = async () => ({
    ...structuredClone(extra.capability),
    unexpectedGateReference: "legacy-issue-state",
  });
  await assert.rejects(
    collect(extra),
    /FLEET_MIGRATION_GITHUB_APP_CAPABILITY_INVALID/u,
  );

  const staleSnapshot = makeCollectorFixture({ count: 2, nowMs: Date.now() });
  const readBackofficeSnapshot =
    staleSnapshot.configuration.readBackofficePublicEvidence;
  staleSnapshot.configuration.readBackofficePublicEvidence = async (
    request,
  ) => {
    const result = await readBackofficeSnapshot(request);
    result.publicEvidence.activeConfig.signedSnapshotDigest =
      "sha256:" + "0".repeat(64);
    result.publicEvidence.evidenceDigest = computeFleetEvidenceDigest(
      result.publicEvidence,
    );
    return result;
  };
  await assert.rejects(
    collect(staleSnapshot),
    /FLEET_MIGRATION_COLLECTOR_BACKOFFICE_READBACK_MISMATCH/u,
  );

  for (const mutate of [
    (publicEvidence) => {
      publicEvidence.providerObservations[0].provider = "invalid provider";
    },
    (publicEvidence) => {
      publicEvidence.providerObservations[0].publicIdentity = "";
    },
    (publicEvidence) => {
      publicEvidence.credentialBindings[0].logicalCredentialId = "shared/short";
    },
    (publicEvidence) => {
      publicEvidence.credentialBindings[0].capability = "invalid capability";
    },
    (publicEvidence) => {
      publicEvidence.credentialBindings[0].fingerprint = "short";
    },
  ]) {
    const malformed = makeCollectorFixture({ count: 2, nowMs: Date.now() });
    const readBackoffice =
      malformed.configuration.readBackofficePublicEvidence;
    malformed.configuration.readBackofficePublicEvidence = async (request) => {
      const result = await readBackoffice(request);
      mutate(result.publicEvidence);
      result.publicEvidence.evidenceDigest = computeFleetEvidenceDigest(
        result.publicEvidence,
      );
      return result;
    };
    await assert.rejects(
      collect(malformed),
      /FLEET_MIGRATION_COLLECTOR_BACKOFFICE_READBACK_MISMATCH/u,
    );
  }
});

test("secret-shaped public value와 callback exception은 output/error로 유출되지 않는다", async () => {
  const fixture = makeCollectorFixture({ count: 2, nowMs: Date.now() });
  const canary = `github_pat_${"A".repeat(30)}`;
  const readBackoffice = fixture.configuration.readBackofficePublicEvidence;
  fixture.configuration.readBackofficePublicEvidence = async (request) => {
    const result = await readBackoffice(request);
    result.publicEvidence.providerObservations.push({
      observationId: "provider-observation-canary-0001",
      revision: "1",
      digest: "sha256:" + "1".repeat(64),
      provider: "github",
      publicIdentity: canary,
      state: "MATCH",
    });
    result.publicEvidence.providerObservations.sort((left, right) =>
      left.observationId.localeCompare(right.observationId),
    );
    result.publicEvidence.evidenceDigest = computeFleetEvidenceDigest(
      result.publicEvidence,
    );
    return result;
  };
  await assert.rejects(
    collect(fixture),
    (error) =>
      error.message === "FLEET_MIGRATION_COLLECTOR_PRIVATE_SURFACE_REJECTED" &&
      !error.message.includes(canary),
  );

  const failed = makeCollectorFixture({ count: 2, nowMs: Date.now() });
  failed.blobs[0].push({
    path: ".github/workflows/contract.yml",
    text: "jobs:\n  contract:\n    secrets: inherit\n",
  });
  failed.configuration.readBlob = async () => {
    throw new Error(canary);
  };
  await assert.rejects(
    collect(failed),
    (error) =>
      error.message === "FLEET_MIGRATION_COLLECTOR_BLOB_READBACK_FAILED" &&
      !error.message.includes(canary),
  );

  const clockFailed = makeCollectorFixture({ count: 2, nowMs: Date.now() });
  clockFailed.configuration.clock = () => {
    throw new Error(canary);
  };
  await assert.rejects(
    collect(clockFailed),
    (error) =>
      error.message === "FLEET_MIGRATION_COLLECTOR_TIME_INVALID" &&
      !error.message.includes(canary),
  );

  const issuerFixture = makeCollectorFixture({
    count: 38,
    nowMs: Date.now(),
    verifiedCapability: true,
  });
  const collection = await collect(issuerFixture);
  const keys = generateKeyPairSync("ed25519");
  const issuer = createFleetMigrationInventoryIssuer({
    clock: () => {
      throw new Error(canary);
    },
    inventoryPublicKey: keys.publicKey,
    readGitHubAppCapability: async () =>
      currentCapability(issuerFixture.capability, Date.now()),
    readOccurrence: issuerFixture.durable.read,
    readSigningKeyPublicIdentity: async () =>
      makeSigningKeyReadback(keys, Date.now()),
    signInventoryPayload: async (request) => signingResult(request, keys),
  });
  await assert.rejects(
    issuer.issueAuthoritative(collection),
    (error) =>
      error.message === "FLEET_MIGRATION_INVENTORY_ISSUER_TIME_INVALID" &&
      !error.message.includes(canary),
  );
});

test("issuer는 raw key 입력/extra config와 durable occurrence substitution을 거부한다", async () => {
  const fixture = makeCollectorFixture({
    count: 38,
    nowMs: Date.now(),
    verifiedCapability: true,
  });
  const collection = await collect(fixture);
  const keys = generateKeyPairSync("ed25519");
  assert.throws(
    () =>
      createFleetMigrationInventoryIssuer({
        clock: fixture.configuration.clock,
        inventoryPublicKey: keys.publicKey,
        privateKey: keys.privateKey,
        readGitHubAppCapability: async () => fixture.capability,
        readOccurrence: fixture.durable.read,
        readSigningKeyPublicIdentity: async () =>
          makeSigningKeyReadback(keys, Date.now()),
        signInventoryPayload: async () => null,
      }),
    /FLEET_MIGRATION_INVENTORY_ISSUER_CONFIGURATION_INVALID/u,
  );
  assert.throws(
    () =>
      createFleetMigrationInventoryIssuer({
        clock: fixture.configuration.clock,
        inventoryPublicKey: keys.publicKey.export({
          format: "pem",
          type: "spki",
        }),
        readGitHubAppCapability: async () => fixture.capability,
        readOccurrence: fixture.durable.read,
        readSigningKeyPublicIdentity: async () =>
          makeSigningKeyReadback(keys, Date.now()),
        signInventoryPayload: async () => null,
      }),
    /FLEET_MIGRATION_INVENTORY_ISSUER_CONFIGURATION_INVALID/u,
  );
  const issuer = makeIssuer(fixture, keys, {
    readOccurrence: async () => {
      const substituted = structuredClone(collection);
      substituted.inventory.inventoryId = "fleet-inventory-substitution-0001";
      return substituted;
    },
  });
  await assert.rejects(
    issuer.issueAuthoritative(collection),
    /FLEET_MIGRATION_COLLECTION_OCCURRENCE_UNVERIFIED/u,
  );
});

test("issuer durable read는 collector와 동일한 최소 lookup shape만 사용한다", async () => {
  const fixture = makeCollectorFixture({
    count: 38,
    nowMs: Date.now(),
    verifiedCapability: true,
  });
  const collection = await collect(fixture);
  const keys = generateKeyPairSync("ed25519");
  let observedRequest;
  const issuer = makeIssuer(fixture, keys, {
    readOccurrence: async (request) => {
      observedRequest = structuredClone(request);
      assert.deepEqual(Object.keys(request).sort(), [
        "occurrenceId",
        "providerVectorDigest",
        "runId",
      ]);
      return fixture.durable.read(request);
    },
  });

  const result = await issuer.issueAuthoritative(collection);
  assert.equal(result.authoritative, true);
  assert.deepEqual(observedRequest, {
    occurrenceId: collection.occurrence.occurrenceId,
    runId: collection.occurrence.runId,
    providerVectorDigest: collection.occurrence.providerVectorDigest,
  });
});

test("issuer는 payload mutation, wrong key ID와 signer key mismatch를 거부한다", async () => {
  const nowMs = Date.now();
  const fixture = makeCollectorFixture({
    count: 38,
    nowMs,
    verifiedCapability: true,
  });
  const collection = await collect(fixture);
  const keys = generateKeyPairSync("ed25519");

  await assert.rejects(
    makeIssuer(fixture, keys, {
      signer: async (request) => {
        request.payload[0] ^= 1;
        return signingResult(request, keys);
      },
    }).issueAuthoritative(collection),
    /FLEET_MIGRATION_INVENTORY_SIGNING_FAILED/u,
  );

  await assert.rejects(
    makeIssuer(fixture, keys, {
      signer: async (request) => ({
        ...signingResult(request, keys),
        keyId: "platform-fleet-release-attacker-0002",
      }),
    }).issueAuthoritative(collection),
    /FLEET_MIGRATION_INVENTORY_SIGNING_FAILED/u,
  );

  const attacker = generateKeyPairSync("ed25519");
  await assert.rejects(
    makeIssuer(fixture, keys, {
      signer: async (request) => ({
        ...signingResult(request, keys),
        value: signEd25519(null, request.payload, attacker.privateKey).toString(
          "base64url",
        ),
      }),
    }).issueAuthoritative(collection),
    /FLEET_MIGRATION_INVENTORY_SIGNING_FAILED/u,
  );

  await assert.rejects(
    makeIssuer(fixture, keys, {
      signer: async (request) => ({
        ...signingResult(request, keys),
        value: signEd25519(null, request.payload, keys.privateKey).toString(
          "base64",
        ),
      }),
    }).issueAuthoritative(collection),
    /FLEET_MIGRATION_INVENTORY_SIGNING_FAILED/u,
  );
});

test("issuer는 HMAC catalog identity와 public-key fingerprint substitution을 거부한다", async () => {
  const nowMs = Date.now();
  const fixture = makeCollectorFixture({
    count: 38,
    nowMs,
    verifiedCapability: true,
  });
  const collection = await collect(fixture);
  const keys = generateKeyPairSync("ed25519");
  let signerCalled = false;
  const signer = async () => {
    signerCalled = true;
    throw new Error("must not sign");
  };

  await assert.rejects(
    makeIssuer(fixture, keys, {
      readSigningKeyPublicIdentity: async () =>
        makeSigningKeyReadback(keys, nowMs, {
          algorithm: "HMAC-SHA256",
          credentialId: "shared/backoffice/control-plane-snapshot-signing",
          keyId: "backoffice-control-plane-snapshot-hmac-0001",
        }),
      signer,
    }).issueAuthoritative(collection),
    /FLEET_MIGRATION_INVENTORY_SIGNING_KEY_UNVERIFIED/u,
  );

  const substitutedKeys = generateKeyPairSync("ed25519");
  await assert.rejects(
    makeIssuer(fixture, keys, {
      readSigningKeyPublicIdentity: async () =>
        makeSigningKeyReadback(keys, nowMs, {
          keyFingerprint: publicKeyFingerprint(substitutedKeys.publicKey),
        }),
      signer,
    }).issueAuthoritative(collection),
    /FLEET_MIGRATION_INVENTORY_SIGNING_KEY_UNVERIFIED/u,
  );
  assert.equal(signerCalled, false);
});

test("issuer는 expired inventory와 stale/replayed current capability readback을 거부한다", async () => {
  const nowMs = Date.now();
  const fixture = makeCollectorFixture({
    count: 38,
    nowMs,
    verifiedCapability: true,
  });
  const collection = await collect(fixture);
  const keys = generateKeyPairSync("ed25519");
  await assert.rejects(
    makeIssuer(fixture, keys, {
      clock: () => nowMs + 15 * 60_000,
    }).issueAuthoritative(collection),
    /FLEET_MIGRATION_INVENTORY_EXPIRED/u,
  );

  const replayed = makeCapability({ nowMs, verified: true });
  replayed.revision = "github-app-capability-replayed-0002";
  replayed.evidenceDigest = computeFleetEvidenceDigest(replayed);
  await assert.rejects(
    makeIssuer(fixture, keys, {
      readGitHubAppCapability: async () => replayed,
    }).issueAuthoritative(collection),
    /GITHUB_APP_CAPABILITY_UNVERIFIED/u,
  );

  const relabeledReplay = structuredClone(fixture.capability);
  relabeledReplay.revision = "github-app-capability-relabeled-replay-0002";
  relabeledReplay.observedAt = new Date(nowMs + 1_000).toISOString();
  relabeledReplay.evidenceDigest =
    computeFleetEvidenceDigest(relabeledReplay);
  await assert.rejects(
    makeIssuer(fixture, keys, {
      clock: () => nowMs + 1_000,
      readGitHubAppCapability: async () => relabeledReplay,
    }).issueAuthoritative(collection),
    /GITHUB_APP_CAPABILITY_UNVERIFIED/u,
  );
});

test("public contracts에는 authoritative gate와 secret-free issuer 경계를 명시한다", () => {
  assert.equal(
    fleetMigrationCollectorContract.githubApp.installationId,
    "142120077",
  );
  assert.equal(
    Object.hasOwn(fleetMigrationCollectorContract, "githubAppGateIssue"),
    false,
  );
  assert.deepEqual(fleetMigrationCollectorContract.baselineRatification, {
    requiredMode: "READ_ONLY_SHADOW",
    fixtureValue: null,
    reason: "PRE_AUTHORITATIVE_SECURITY_REMEDIATION",
  });
  assert.deepEqual(fleetMigrationCollectorContract.detectorSource, {
    repositoryId: "1241442018",
    fullName: "seorilabs/.github",
    defaultRef: "refs/heads/main",
    runtimeBinding: "TRUSTED_CONFIGURATION_MATCHES_LIVE_DEFAULT_HEAD",
    signedInventoryField: "detector.sourceSha",
    historicalCohortNormalization: "DETECTOR_REPOSITORY_ONLY",
  });
  assert.equal(
    fleetMigrationInventoryIssuerContract.authoritativeIssuanceEnabled,
    true,
  );
  assert.equal(
    fleetMigrationInventoryIssuerContract.signingCredentialId,
    "shared/platform/fleet-release-approval-signing",
  );
  assert.equal(
    fleetMigrationInventoryIssuerContract.keyId,
    "platform-fleet-release-20260829-5458c56b",
  );
  assert.equal(fleetMigrationInventoryIssuerContract.privateKeyInputAllowed, false);
  assert.equal(fleetMigrationInventoryIssuerContract.rawKeyExportAllowed, false);
  assert.equal(
    fleetMigrationInventoryIssuerContract.baselineRatificationRequired,
    true,
  );
  assert.equal(
    fleetMigrationInventoryIssuerContract.actualDetectorCollectionBindingRequired,
    true,
  );
  assert.equal(
    fleetMigrationInventoryIssuerContract.historicalDetectorProvenanceRequired,
    true,
  );
  assert.equal(
    canonicalJson(fleetMigrationCollectorContract.githubApp.requiredEvents),
    canonicalJson([
      "issue_comment",
      "issues",
      "pull_request",
      "push",
      "repository",
      "workflow_run",
    ]),
  );
});
