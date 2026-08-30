import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const SOURCE_CONTRACTS_ROOT = fileURLToPath(
  new URL("../../../contracts", import.meta.url),
);
const PACKAGED_CONTRACTS_ROOT = fileURLToPath(
  new URL("../.generated/contracts", import.meta.url),
);
const CONTRACTS_ROOT = existsSync(SOURCE_CONTRACTS_ROOT)
  ? SOURCE_CONTRACTS_ROOT
  : PACKAGED_CONTRACTS_ROOT;

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const NUMERIC_ID_PATTERN = /^[1-9][0-9]{0,31}$/u;
const FULL_NAME_PATTERN = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const PLATFORM_REGISTRY_PATH_PATTERN =
  /^registry\/apps\/([a-z0-9][a-z0-9-]{0,63})\.json$/u;

const DEFINITIONS = Object.freeze([
  Object.freeze({
    contract: "ORG_CONTRACT_APP",
    schemaId: "https://seorilabs.github.io/contracts/v1/app.schema.json",
    schemaPath: "app.schema.json",
    path: ".seorilabs/app.yaml",
  }),
  Object.freeze({
    contract: "GOOGLE_PLAY",
    schemaId:
      "https://seorilabs.github.io/contracts/v1/markets/google-play.schema.json",
    schemaPath: "markets/google-play.schema.json",
    path: "play-store/google-play.config.json",
  }),
  Object.freeze({
    contract: "APP_STORE",
    schemaId:
      "https://seorilabs.github.io/contracts/v1/markets/app-store.schema.json",
    schemaPath: "markets/app-store.schema.json",
    path: "app-store/app-store.config.json",
  }),
  Object.freeze({
    contract: "APPS_IN_TOSS",
    schemaId:
      "https://seorilabs.github.io/contracts/v1/markets/apps-in-toss.schema.json",
    schemaPath: "markets/apps-in-toss.schema.json",
    path: "apps-in-toss/apps-in-toss.config.json",
  }),
  Object.freeze({
    contract: "MARKET_LAUNCH_STATE",
    schemaId:
      "https://seorilabs.com/contracts/legacy/market-launch-state.v1.schema.json",
    schemaPath: "legacy/market-launch-state.v1.schema.json",
    path: "release/market-launch-state.json",
  }),
  Object.freeze({
    contract: "PLATFORM_REGISTRY_APP",
    schemaId:
      "https://seorilabs.com/contracts/legacy/platform-registry-app.v1.schema.json",
    schemaPath: "legacy/platform-registry-app.v1.schema.json",
    path: null,
  }),
  Object.freeze({
    contract: "BACKOFFICE_OPERATIONS",
    schemaId:
      "https://seorilabs.com/contracts/legacy/backoffice-operations.v1.schema.json",
    schemaPath: "legacy/backoffice-operations.v1.schema.json",
    path: ".seorilabs/backoffice.json",
  }),
]);

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const ajv = new Ajv2020({
  allErrors: false,
  strict: true,
  validateFormats: false,
});
const rawSchemas = new Map();
const validators = new Map();
for (const definition of DEFINITIONS) {
  const rawSchema = readFileSync(
    resolve(CONTRACTS_ROOT, definition.schemaPath),
    "utf8",
  );
  const schema = JSON.parse(rawSchema);
  if (schema.$id !== definition.schemaId) {
    throw new Error("FLEET_MIGRATION_LEGACY_SCHEMA_ID_MISMATCH");
  }
  rawSchemas.set(definition.contract, rawSchema);
  validators.set(definition.contract, ajv.compile(schema));
}

const validatorDigest = createHash("sha256")
  .update(
    DEFINITIONS.map(
      ({ contract }) => `${contract}\0${rawSchemas.get(contract)}\0`,
    ).join(""),
  )
  .digest("hex")
  .slice(0, 16);

export const fleetMigrationLegacyValidatorRevision =
  `fleet-legacy-schema-validator-v1-${validatorDigest}`;

function definitionForRequest(request) {
  const definition = DEFINITIONS.find(
    ({ contract }) => contract === request.contract,
  );
  if (
    definition === undefined ||
    definition.schemaId !== request.schemaId
  ) {
    throw new Error("FLEET_MIGRATION_LEGACY_VALIDATION_REQUEST_INVALID");
  }
  if (definition.path !== null) {
    if (request.path !== definition.path) {
      throw new Error("FLEET_MIGRATION_LEGACY_VALIDATION_REQUEST_INVALID");
    }
    return definition;
  }
  const registryMatch = PLATFORM_REGISTRY_PATH_PATTERN.exec(request.path);
  if (
    request.fullName !== "seorilabs/platform" ||
    registryMatch === null ||
    request.document.app_id !== registryMatch[1]
  ) {
    throw new Error("FLEET_MIGRATION_LEGACY_VALIDATION_REQUEST_INVALID");
  }
  return definition;
}

export function validateFleetMigrationLegacyDocument(request) {
  if (
    !exactKeys(request, [
      "contract",
      "schemaId",
      "repositoryId",
      "fullName",
      "sourceSha",
      "path",
      "objectSha",
      "contentDigest",
      "document",
    ]) ||
    !NUMERIC_ID_PATTERN.test(request.repositoryId ?? "") ||
    !FULL_NAME_PATTERN.test(request.fullName ?? "") ||
    !SHA_PATTERN.test(request.sourceSha ?? "") ||
    !SHA_PATTERN.test(request.objectSha ?? "") ||
    !DIGEST_PATTERN.test(request.contentDigest ?? "") ||
    typeof request.path !== "string" ||
    request.path !== posix.normalize(request.path) ||
    request.path.startsWith("/") ||
    request.path.includes("\0") ||
    !isRecord(request.document)
  ) {
    throw new Error("FLEET_MIGRATION_LEGACY_VALIDATION_REQUEST_INVALID");
  }
  const definition = definitionForRequest(request);
  if (
    definition.contract === "MARKET_LAUNCH_STATE" &&
    request.document.app?.repo !== request.fullName
  ) {
    throw new Error("FLEET_MIGRATION_LEGACY_SCHEMA_VALIDATION_FAILED");
  }
  if (validators.get(definition.contract)(request.document) !== true) {
    throw new Error("FLEET_MIGRATION_LEGACY_SCHEMA_VALIDATION_FAILED");
  }
  return Object.freeze({
    state: "MATCH",
    contract: definition.contract,
    schemaId: definition.schemaId,
    contentDigest: request.contentDigest,
    validatorRevision: fleetMigrationLegacyValidatorRevision,
  });
}
