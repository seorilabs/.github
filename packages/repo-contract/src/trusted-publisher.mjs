import { Buffer } from "node:buffer";
import { createHash, createPublicKey } from "node:crypto";

import { promoteWorkflowBundle } from "./fleet.mjs";

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SIGNING_CREDENTIAL_ID = "shared/workflow-bundle/approval-signing";

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

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

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function snapshotApprovalKeys(value) {
  const entries =
    value instanceof Map
      ? [...value.entries()]
      : value !== null &&
          typeof value === "object" &&
          Object.getPrototypeOf(value) === Object.prototype
        ? Object.entries(value)
        : undefined;
  if (
    !entries ||
    entries.length === 0 ||
    entries.some(
      ([keyId, key]) =>
        !KEY_ID_PATTERN.test(keyId ?? "") ||
        key?.type !== "public" ||
        key?.asymmetricKeyType !== "ed25519",
    )
  ) {
    throw new Error("TRUSTED_BUNDLE_PUBLISHER_CONFIGURATION_INVALID");
  }
  return Object.freeze(
    Object.fromEntries(
      entries.map(([keyId, key]) => [
        keyId,
        createPublicKey({
          key: key.export({ format: "der", type: "spki" }),
          format: "der",
          type: "spki",
        }),
      ]),
    ),
  );
}

function registryRecordMatches(left, right) {
  return (
    exactKeys(left, [
      "bundleDigest",
      "bundleVersion",
      "registryId",
      "sourceSha",
      "state",
      "subject",
    ]) &&
    JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
  );
}

export function createTrustedWorkflowBundlePublisher({
  approvalKeyId,
  signApprovalPayload,
  publishRegistryRecord,
  readRegistryRecord,
  evidenceVerifier,
  trustedApprovalKeys,
  trustedWorkflowSourceReadback,
  trustedRunnerImageReadback,
} = {}) {
  let trustedApprovalKeySnapshot;
  if (
    !KEY_ID_PATTERN.test(approvalKeyId ?? "") ||
    ![
      signApprovalPayload,
      publishRegistryRecord,
      readRegistryRecord,
      evidenceVerifier,
      trustedWorkflowSourceReadback,
      trustedRunnerImageReadback,
    ].every((callback) => typeof callback === "function") ||
    trustedApprovalKeys === null ||
    typeof trustedApprovalKeys !== "object"
  ) {
    throw new Error("TRUSTED_BUNDLE_PUBLISHER_CONFIGURATION_INVALID");
  }
  try {
    trustedApprovalKeySnapshot = snapshotApprovalKeys(trustedApprovalKeys);
  } catch {
    throw new Error("TRUSTED_BUNDLE_PUBLISHER_CONFIGURATION_INVALID");
  }
  if (!Object.hasOwn(trustedApprovalKeySnapshot, approvalKeyId)) {
    throw new Error("TRUSTED_BUNDLE_PUBLISHER_CONFIGURATION_INVALID");
  }

  return Object.freeze({
    async promote(bundle, evidence, { repoRoot } = {}) {
      return promoteWorkflowBundle(bundle, evidence, {
        ...(repoRoot === undefined ? {} : { repoRoot }),
        evidenceVerifier: async (record, candidate) => {
          try {
            return structuredClone(
              await evidenceVerifier(
                structuredClone(record),
                structuredClone(candidate),
              ),
            );
          } catch {
            throw new Error("TRUSTED_CANARY_EVIDENCE_READBACK_FAILED");
          }
        },
        trustedWorkflowSourceReadback,
        trustedRunnerImageReadback,
        trustedApprovalKeys: trustedApprovalKeySnapshot,
        trustedApprovalSigner: async (request) => {
          let payload;
          try {
            payload = Buffer.from(request.payload);
            const result = await signApprovalPayload({
              algorithm: request.algorithm,
              credentialId: SIGNING_CREDENTIAL_ID,
              keyId: approvalKeyId,
              keyPurpose: request.keyPurpose,
              payload,
              payloadDigest: request.payloadDigest,
              registryId: request.registryId,
              subject: request.subject,
            });
            if (
              !exactKeys(result, ["algorithm", "keyId", "value"]) ||
              result.algorithm !== "Ed25519" ||
              result.keyId !== approvalKeyId
            ) {
              throw new Error("invalid signature");
            }
            return structuredClone(result);
          } catch {
            throw new Error("TRUSTED_APPROVAL_SIGNING_FAILED");
          } finally {
            if (Buffer.isBuffer(payload)) payload.fill(0);
          }
        },
        registryPublisher: async (record, promoted) => {
          const expected = structuredClone(record);
          const recordDigest = sha256(canonicalJson(expected));
          try {
            const lookup = {
              bundleDigest: expected.bundleDigest,
              bundleVersion: expected.bundleVersion,
              registryId: expected.registryId,
              sourceSha: expected.sourceSha,
              subject: expected.subject,
            };
            const before = structuredClone(await readRegistryRecord(lookup));
            if (before !== null && !registryRecordMatches(before, expected)) {
              throw new Error("registry conflict");
            }
            if (before === null) {
              const created = structuredClone(
                await publishRegistryRecord({
                  precondition: {
                    expectedState: "ABSENT",
                    recordDigest,
                  },
                  promoted: structuredClone(promoted),
                  record: structuredClone(expected),
                }),
              );
              if (
                !exactKeys(created, ["recordDigest", "state", "subject"]) ||
                created.state !== "CREATED" ||
                created.subject !== expected.subject ||
                created.recordDigest !== recordDigest
              ) {
                throw new Error("registry create failed");
              }
            }
            const readback = structuredClone(
              await readRegistryRecord(lookup),
            );
            if (!registryRecordMatches(readback, expected)) {
              throw new Error("registry mismatch");
            }
            return readback;
          } catch {
            throw new Error("TRUSTED_APPROVAL_REGISTRY_PUBLISH_FAILED");
          }
        },
      });
    },
  });
}

export const trustedWorkflowBundlePublisherContract = Object.freeze({
  approvalAlgorithm: "Ed25519",
  registryId: "seorilabs-workflow-bundles-v1",
  signingCredentialId: SIGNING_CREDENTIAL_ID,
});
