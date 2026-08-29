import { Buffer } from "node:buffer";
import {
  createHash,
  createPublicKey,
  verify as verifyEd25519,
} from "node:crypto";

import {
  fleetMigrationCollectorContract,
  isFleetGitHubAppCapabilityVerified,
  validateFleetGitHubAppCapability,
  validateFleetMigrationCollection,
} from "./fleet-migration-collector.mjs";
import {
  computeFleetEvidenceDigest,
  computeFleetMigrationInventoryDigest,
  createFleetMigrationAttestationPayload,
  fleetMigrationContract,
  loadTrustedFleetMigrationInventoryBinding,
  validateFleetMigrationInventory,
} from "./fleet-migration.mjs";

const ISSUER_CONTRACT =
  "seorilabs-fleet-migration-authoritative-inventory-v1";
const CAPABILITY_CONTRACT =
  "seorilabs-fleet-github-app-capability-v1";
const SIGNING_KEY_READBACK_CONTRACT =
  "seorilabs-fleet-signing-key-public-identity-v1";
const INVENTORY_KEY_ID = "platform-fleet-release-20260829-5458c56b";
const INVENTORY_POLICY_REVISION = "fleet-inventory-policy-0001";
const INVENTORY_SIGNING_CREDENTIAL_ID =
  "shared/platform/fleet-release-approval-signing";
const INVENTORY_KEY_PURPOSE = "FLEET_MIGRATION_INVENTORY_ATTESTATION";
const MAX_CAPABILITY_AGE_MS = 5 * 60 * 1000;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalize(value) {
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

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    canonicalJson(Object.keys(value).sort(compareUtf8)) ===
      canonicalJson([...keys].sort(compareUtf8))
  );
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deepFreeze(value) {
  if (
    value !== null &&
    typeof value === "object" &&
    !Buffer.isBuffer(value) &&
    !Object.isFrozen(value)
  ) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function trustedTime(clock) {
  let value;
  try {
    value = clock();
  } catch {
    throw new Error("FLEET_MIGRATION_INVENTORY_ISSUER_TIME_INVALID");
  }
  const milliseconds =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : typeof value === "string"
          ? Date.parse(value)
          : Number.NaN;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("FLEET_MIGRATION_INVENTORY_ISSUER_TIME_INVALID");
  }
  return milliseconds;
}

function snapshotPublicKey(key) {
  if (key?.type !== "public" || key?.asymmetricKeyType !== "ed25519") {
    throw new Error("FLEET_MIGRATION_INVENTORY_ISSUER_CONFIGURATION_INVALID");
  }
  try {
    const spki = key.export({ format: "der", type: "spki" });
    const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
    const fingerprint = sha256(spki);
    spki.fill(0);
    return Object.freeze({ publicKey, fingerprint });
  } catch {
    throw new Error("FLEET_MIGRATION_INVENTORY_ISSUER_CONFIGURATION_INVALID");
  }
}

function validateConfiguration(configuration) {
  if (
    !exactKeys(configuration, [
      "clock",
      "inventoryPublicKey",
      "readGitHubAppCapability",
      "readOccurrence",
      "readSigningKeyPublicIdentity",
      "signInventoryPayload",
    ]) ||
    typeof configuration.clock !== "function" ||
    typeof configuration.readGitHubAppCapability !== "function" ||
    typeof configuration.readOccurrence !== "function" ||
    typeof configuration.readSigningKeyPublicIdentity !== "function" ||
    typeof configuration.signInventoryPayload !== "function"
  ) {
    throw new Error("FLEET_MIGRATION_INVENTORY_ISSUER_CONFIGURATION_INVALID");
  }
}

async function readSigningKeyPublicIdentity(
  configuration,
  expectedFingerprint,
) {
  let value;
  try {
    value = structuredClone(
      await configuration.readSigningKeyPublicIdentity(
        deepFreeze({
          contract: SIGNING_KEY_READBACK_CONTRACT,
          credentialId: INVENTORY_SIGNING_CREDENTIAL_ID,
          keyId: INVENTORY_KEY_ID,
          keyPurpose: INVENTORY_KEY_PURPOSE,
          readMode: "CURRENT_PUBLIC_METADATA",
        }),
      ),
    );
  } catch {
    throw new Error("FLEET_MIGRATION_INVENTORY_SIGNING_KEY_UNVERIFIED");
  }
  const observedAtMs = Date.parse(value?.observedAt);
  if (
    !exactKeys(value, [
      "algorithm",
      "contract",
      "credentialId",
      "evidenceDigest",
      "keyFingerprint",
      "keyId",
      "keyPurpose",
      "observedAt",
      "readbackId",
      "revision",
      "state",
    ]) ||
    value.contract !== SIGNING_KEY_READBACK_CONTRACT ||
    value.algorithm !== "Ed25519" ||
    value.credentialId !== INVENTORY_SIGNING_CREDENTIAL_ID ||
    value.keyId !== INVENTORY_KEY_ID ||
    value.keyPurpose !== INVENTORY_KEY_PURPOSE ||
    value.keyFingerprint !== expectedFingerprint ||
    value.state !== "ACTIVE" ||
    !DIGEST_PATTERN.test(value.keyFingerprint ?? "") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value.readbackId ?? "") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value.revision ?? "") ||
    !Number.isFinite(observedAtMs) ||
    new Date(observedAtMs).toISOString() !== value.observedAt ||
    computeFleetEvidenceDigest(value) !== value.evidenceDigest
  ) {
    throw new Error("FLEET_MIGRATION_INVENTORY_SIGNING_KEY_UNVERIFIED");
  }
  return deepFreeze(value);
}

async function readDurableCollection(configuration, collection) {
  let stored;
  try {
    stored = structuredClone(
      await configuration.readOccurrence(
        deepFreeze({
          occurrenceId: collection.occurrence.occurrenceId,
          runId: collection.occurrence.runId,
          providerVectorDigest:
            collection.occurrence.providerVectorDigest,
          collectionDigest: collection.collectionDigest,
          inventoryDigest: collection.inventoryDigest,
        }),
      ),
    );
  } catch {
    throw new Error("FLEET_MIGRATION_COLLECTION_OCCURRENCE_UNVERIFIED");
  }
  if (
    !validateFleetMigrationCollection(stored).ok ||
    canonicalJson(stored) !== canonicalJson(collection)
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTION_OCCURRENCE_UNVERIFIED");
  }
  return deepFreeze(stored);
}

function capabilitySemanticState(value) {
  const app = structuredClone(value.app);
  const installation = structuredClone(value.installation);
  delete app.readbackId;
  delete installation.readbackId;
  delete installation.updatedAt;
  return {
    contract: value.contract,
    organization: structuredClone(value.organization),
    app,
    installation,
    eventAcceptance: {
      state: value.eventAcceptance.state,
      event: value.eventAcceptance.event,
    },
  };
}

function hasFreshCapabilityReadback(value, expectedCapability) {
  return (
    value.revision !== expectedCapability.revision &&
    Date.parse(value.observedAt) > Date.parse(expectedCapability.observedAt) &&
    value.app.readbackId !== expectedCapability.app.readbackId &&
    value.installation.readbackId !==
      expectedCapability.installation.readbackId &&
    value.evidenceDigest !== expectedCapability.evidenceDigest
  );
}

async function readCurrentCapability(configuration, expectedCapability) {
  let value;
  try {
    value = structuredClone(
      await configuration.readGitHubAppCapability(
        deepFreeze({
          contract: CAPABILITY_CONTRACT,
          organizationId: fleetMigrationCollectorContract.organizationId,
          installationId:
            fleetMigrationCollectorContract.githubApp.installationId,
          readMode: "CURRENT_PUBLIC_STATE",
        }),
      ),
    );
  } catch {
    throw new Error("GITHUB_APP_CAPABILITY_UNVERIFIED");
  }
  if (
    !validateFleetGitHubAppCapability(value).ok ||
    canonicalJson(capabilitySemanticState(value)) !==
      canonicalJson(capabilitySemanticState(expectedCapability)) ||
    !hasFreshCapabilityReadback(value, expectedCapability) ||
    !isFleetGitHubAppCapabilityVerified(value)
  ) {
    throw new Error("GITHUB_APP_CAPABILITY_UNVERIFIED");
  }
  return deepFreeze(value);
}

function assertAuthoritativeBaseline(collection) {
  const expected = fleetMigrationContract.initialBaseline.expectedCounts;
  if (
    collection.mode !== "READ_ONLY_SHADOW" ||
    collection.state !== "SHADOW_COMPLETE" ||
    collection.authoritative !== false ||
    collection.readyForPlanning !== false ||
    collection.inventory.lineage.mode !== "BOOTSTRAP" ||
    collection.inventory.attestation !== null ||
    canonicalJson(collection.inventory.expectedCounts) !==
      canonicalJson(expected) ||
    collection.inventory.repositories.length !== expected.activeRepositories
  ) {
    throw new Error("FLEET_MIGRATION_INVENTORY_NOT_AUTHORITATIVE");
  }
}

function decodeSignature(value) {
  if (!SIGNATURE_PATTERN.test(value ?? "")) return null;
  try {
    const signature = Buffer.from(value, "base64url");
    if (
      signature.length !== 64 ||
      signature.toString("base64url") !== value
    ) {
      signature.fill(0);
      return null;
    }
    return signature;
  } catch {
    return null;
  }
}

function unsignedIssuanceDigest(issuance) {
  const { issuanceDigest: _issuanceDigest, ...unsigned } = issuance;
  return sha256(canonicalJson(unsigned));
}

function validateIssuanceEnvelope(
  issuance,
  publicKey,
  expectedFingerprint,
  nowMs,
) {
  if (
    !exactKeys(issuance, [
      "authoritative",
      "collectionCapabilityEvidenceDigest",
      "contract",
      "inventory",
      "inventoryDigest",
      "issuanceCapabilityEvidenceDigest",
      "issuanceDigest",
      "keyFingerprint",
      "readyForPlanning",
      "state",
    ]) ||
    issuance.contract !== ISSUER_CONTRACT ||
    issuance.state !== "READY" ||
    issuance.authoritative !== true ||
    issuance.readyForPlanning !== true ||
    !DIGEST_PATTERN.test(
      issuance.collectionCapabilityEvidenceDigest ?? "",
    ) ||
    !DIGEST_PATTERN.test(
      issuance.issuanceCapabilityEvidenceDigest ?? "",
    ) ||
    !DIGEST_PATTERN.test(issuance.inventoryDigest ?? "") ||
    !DIGEST_PATTERN.test(issuance.issuanceDigest ?? "") ||
    !DIGEST_PATTERN.test(issuance.keyFingerprint ?? "") ||
    !Number.isSafeInteger(nowMs) ||
    issuance.keyFingerprint !== expectedFingerprint ||
    issuance.inventory?.attestation?.keyId !== INVENTORY_KEY_ID ||
    issuance.inventory?.attestation?.policyRevision !==
      INVENTORY_POLICY_REVISION ||
    computeFleetMigrationInventoryDigest(issuance.inventory) !==
      issuance.inventoryDigest ||
    issuance.inventory.attestation.inventoryDigest !==
      issuance.inventoryDigest ||
    issuance.inventory.collectionEvidence.githubAppCapability.evidenceDigest !==
      issuance.collectionCapabilityEvidenceDigest ||
    issuance.inventory.collectionEvidence.issuanceGitHubAppCapability
      ?.evidenceDigest !== issuance.issuanceCapabilityEvidenceDigest ||
    unsignedIssuanceDigest(issuance) !== issuance.issuanceDigest
  ) {
    throw new Error("FLEET_MIGRATION_AUTHORITATIVE_INVENTORY_INVALID");
  }
  const inventoryValidation = validateFleetMigrationInventory(
    issuance.inventory,
  );
  const capturedAtMs = Date.parse(issuance.inventory?.capturedAt);
  const signedAtMs = Date.parse(issuance.inventory?.attestation?.signedAt);
  const expiresAtMs = Date.parse(issuance.inventory?.expiresAt);
  const collectionEvidence = issuance.inventory?.collectionEvidence;
  const collectionCapability = collectionEvidence?.githubAppCapability;
  const issuanceCapability =
    collectionEvidence?.issuanceGitHubAppCapability;
  const issuanceCapabilityObservedAtMs = Date.parse(
    issuanceCapability?.observedAt,
  );
  if (
    !inventoryValidation.ok ||
    !validateFleetGitHubAppCapability(collectionCapability).ok ||
    !validateFleetGitHubAppCapability(issuanceCapability).ok ||
    !isFleetGitHubAppCapabilityVerified(issuanceCapability) ||
    canonicalJson(capabilitySemanticState(collectionCapability)) !==
      canonicalJson(capabilitySemanticState(issuanceCapability)) ||
    !hasFreshCapabilityReadback(
      issuanceCapability,
      collectionCapability,
    ) ||
    computeFleetEvidenceDigest(collectionCapability) !==
      collectionCapability.evidenceDigest ||
    computeFleetEvidenceDigest(issuanceCapability) !==
      issuanceCapability.evidenceDigest ||
    computeFleetEvidenceDigest(collectionEvidence) !==
      collectionEvidence.evidenceDigest ||
    !Number.isFinite(capturedAtMs) ||
    !Number.isFinite(signedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    !Number.isFinite(issuanceCapabilityObservedAtMs) ||
    new Date(signedAtMs).toISOString() !==
      issuance.inventory.attestation.signedAt ||
    signedAtMs < capturedAtMs ||
    signedAtMs >= expiresAtMs ||
    issuanceCapabilityObservedAtMs < capturedAtMs ||
    issuanceCapabilityObservedAtMs > signedAtMs ||
    signedAtMs - issuanceCapabilityObservedAtMs > MAX_CAPABILITY_AGE_MS
  ) {
    throw new Error("FLEET_MIGRATION_AUTHORITATIVE_INVENTORY_INVALID");
  }
  loadTrustedFleetMigrationInventoryBinding({
    inventory: issuance.inventory,
    trustedInventoryKeys: { [INVENTORY_KEY_ID]: publicKey },
    now: new Date(nowMs).toISOString(),
  });
  return deepFreeze(issuance);
}

export function createFleetMigrationInventoryIssuer(configuration = {}) {
  validateConfiguration(configuration);
  const { publicKey, fingerprint } = snapshotPublicKey(
    configuration.inventoryPublicKey,
  );
  const trustedConfiguration = Object.freeze({
    clock: configuration.clock,
    readGitHubAppCapability: configuration.readGitHubAppCapability,
    readOccurrence: configuration.readOccurrence,
    readSigningKeyPublicIdentity:
      configuration.readSigningKeyPublicIdentity,
    signInventoryPayload: configuration.signInventoryPayload,
  });
  return Object.freeze({
    async issueAuthoritative(collectionInput) {
      let collection = structuredClone(collectionInput);
      if (!validateFleetMigrationCollection(collection).ok) {
        throw new Error("FLEET_MIGRATION_COLLECTION_INVALID");
      }
      collection = await readDurableCollection(
        trustedConfiguration,
        collection,
      );
      assertAuthoritativeBaseline(collection);
      const capability = await readCurrentCapability(
        trustedConfiguration,
        collection.inventory.collectionEvidence.githubAppCapability,
      );
      const signingKeyReadback = await readSigningKeyPublicIdentity(
        trustedConfiguration,
        fingerprint,
      );
      const nowMs = trustedTime(trustedConfiguration.clock);
      const capturedAtMs = Date.parse(collection.inventory.capturedAt);
      const expiresAtMs = Date.parse(collection.inventory.expiresAt);
      const capabilityObservedAtMs = Date.parse(capability.observedAt);
      const signingKeyObservedAtMs = Date.parse(
        signingKeyReadback.observedAt,
      );
      if (
        !Number.isFinite(capturedAtMs) ||
        !Number.isFinite(expiresAtMs) ||
        nowMs < capturedAtMs ||
        nowMs >= expiresAtMs
      ) {
        throw new Error("FLEET_MIGRATION_INVENTORY_EXPIRED");
      }
      if (
        !Number.isFinite(capabilityObservedAtMs) ||
        capabilityObservedAtMs < capturedAtMs ||
        capabilityObservedAtMs > nowMs ||
        nowMs - capabilityObservedAtMs > MAX_CAPABILITY_AGE_MS
      ) {
        throw new Error("GITHUB_APP_CAPABILITY_UNVERIFIED");
      }
      if (
        !Number.isFinite(signingKeyObservedAtMs) ||
        signingKeyObservedAtMs > nowMs ||
        nowMs - signingKeyObservedAtMs > MAX_CAPABILITY_AGE_MS
      ) {
        throw new Error("FLEET_MIGRATION_INVENTORY_SIGNING_KEY_UNVERIFIED");
      }
      const collectedInventoryDigest = computeFleetMigrationInventoryDigest(
        collection.inventory,
      );
      if (collectedInventoryDigest !== collection.inventoryDigest) {
        throw new Error("FLEET_MIGRATION_COLLECTION_INVALID");
      }
      const inventory = structuredClone(collection.inventory);
      inventory.collectionEvidence.issuanceGitHubAppCapability =
        structuredClone(capability);
      inventory.collectionEvidence.evidenceDigest =
        computeFleetEvidenceDigest(inventory.collectionEvidence);
      const inventoryDigest = computeFleetMigrationInventoryDigest(inventory);
      const signedAt = new Date(nowMs).toISOString();
      if (
        Date.parse(signedAt) !== nowMs ||
        nowMs < capturedAtMs ||
        Date.parse(signedAt) >= expiresAtMs
      ) {
        throw new Error("FLEET_MIGRATION_INVENTORY_EXPIRED");
      }
      let payload;
      let signerPayload;
      let signature;
      try {
        payload = createFleetMigrationAttestationPayload(inventory, {
          keyId: INVENTORY_KEY_ID,
          policyRevision: INVENTORY_POLICY_REVISION,
          signedAt,
        });
        signerPayload = Buffer.from(payload);
        const payloadDigest = sha256(payload);
        let result;
        try {
          result = structuredClone(
            await trustedConfiguration.signInventoryPayload(
              Object.freeze({
                algorithm: "Ed25519",
                credentialId: INVENTORY_SIGNING_CREDENTIAL_ID,
                keyId: INVENTORY_KEY_ID,
                keyPurpose: INVENTORY_KEY_PURPOSE,
                policyRevision: INVENTORY_POLICY_REVISION,
                signedAt,
                inventoryId: inventory.inventoryId,
                inventoryDigest,
                collectionCapabilityEvidenceDigest:
                  collection.inventory.collectionEvidence.githubAppCapability
                    .evidenceDigest,
                issuanceCapabilityEvidenceDigest: capability.evidenceDigest,
                collectionDigest: collection.collectionDigest,
                payloadDigest,
                payload: signerPayload,
              }),
            ),
          );
        } catch {
          throw new Error("FLEET_MIGRATION_INVENTORY_SIGNING_FAILED");
        }
        if (
          !exactKeys(result, [
            "algorithm",
            "credentialId",
            "keyFingerprint",
            "keyId",
            "value",
          ]) ||
          result.algorithm !== "Ed25519" ||
          result.credentialId !== INVENTORY_SIGNING_CREDENTIAL_ID ||
          result.keyId !== INVENTORY_KEY_ID ||
          result.keyFingerprint !== fingerprint
        ) {
          throw new Error("FLEET_MIGRATION_INVENTORY_SIGNING_FAILED");
        }
        signature = decodeSignature(result.value);
        if (
          signature === null ||
          sha256(payload) !== payloadDigest ||
          !verifyEd25519(null, payload, publicKey, signature)
        ) {
          throw new Error("FLEET_MIGRATION_INVENTORY_SIGNING_FAILED");
        }
        inventory.attestation = {
          algorithm: "Ed25519",
          keyId: INVENTORY_KEY_ID,
          policyRevision: INVENTORY_POLICY_REVISION,
          signedAt,
          inventoryDigest,
          value: result.value,
        };
      } finally {
        if (Buffer.isBuffer(signature)) signature.fill(0);
        if (Buffer.isBuffer(signerPayload)) signerPayload.fill(0);
        if (Buffer.isBuffer(payload)) payload.fill(0);
      }
      const issuance = {
        contract: ISSUER_CONTRACT,
        state: "READY",
        authoritative: true,
        readyForPlanning: true,
        collectionCapabilityEvidenceDigest:
          collection.inventory.collectionEvidence.githubAppCapability
            .evidenceDigest,
        issuanceCapabilityEvidenceDigest: capability.evidenceDigest,
        keyFingerprint: fingerprint,
        inventoryDigest,
        inventory,
        issuanceDigest: "sha256:" + "0".repeat(64),
      };
      issuance.issuanceDigest = unsignedIssuanceDigest(issuance);
      return validateIssuanceEnvelope(
        issuance,
        publicKey,
        fingerprint,
        nowMs,
      );
    },
  });
}

export function validateFleetMigrationAuthoritativeInventory(
  issuance,
  inventoryPublicKey,
  options = {},
) {
  try {
    if (!exactKeys(options, ["now"])) {
      throw new Error(
        "FLEET_MIGRATION_AUTHORITATIVE_INVENTORY_TIME_REQUIRED",
      );
    }
    const nowMs = trustedTime(() => options.now);
    const { publicKey, fingerprint } = snapshotPublicKey(inventoryPublicKey);
    validateIssuanceEnvelope(
      structuredClone(issuance),
      publicKey,
      fingerprint,
      nowMs,
    );
    return deepFreeze({ ok: true, diagnostics: [] });
  } catch (error) {
    return deepFreeze({
      ok: false,
      diagnostics: [
        String(
          error?.message ?? "FLEET_MIGRATION_AUTHORITATIVE_INVENTORY_INVALID",
        ),
      ],
    });
  }
}

export const fleetMigrationInventoryIssuerContract = deepFreeze({
  contract: ISSUER_CONTRACT,
  algorithm: "Ed25519",
  keyId: INVENTORY_KEY_ID,
  policyRevision: INVENTORY_POLICY_REVISION,
  signingCredentialId: INVENTORY_SIGNING_CREDENTIAL_ID,
  keyPurpose: INVENTORY_KEY_PURPOSE,
  capabilityContract: CAPABILITY_CONTRACT,
  signingKeyReadbackContract: SIGNING_KEY_READBACK_CONTRACT,
  maximumCapabilityAgeSeconds: MAX_CAPABILITY_AGE_MS / 1000,
  maximumSigningKeyReadbackAgeSeconds: MAX_CAPABILITY_AGE_MS / 1000,
  authoritativeIssuanceEnabled: true,
  liveCapabilityReadbackRequired: true,
  durableCollectionReadbackRequired: true,
  privateKeyInputAllowed: false,
  rawKeyExportAllowed: false,
});
