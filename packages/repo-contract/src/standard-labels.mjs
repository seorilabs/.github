import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKSPACE_CATALOG = resolve(
  PACKAGE_ROOT,
  "../../contracts/fleet-standard-labels.json",
);
const BUNDLED_CATALOG = resolve(
  PACKAGE_ROOT,
  ".generated/contracts/fleet-standard-labels.json",
);
const CATALOG_PATH = existsSync(WORKSPACE_CATALOG)
  ? WORKSPACE_CATALOG
  : BUNDLED_CATALOG;
const REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,31}$/u;
const FULL_NAME_PATTERN = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const COLOR_PATTERN = /^[0-9A-F]{6}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const EXPECTED_LABEL_NAMES = Object.freeze([
  "P1",
  "P2",
  "P3",
  "P4",
  "autopilot",
  "autopilot:local",
  "autopilot:cloud",
  "evidence:ga4",
  "evidence:console",
  "evidence:store",
  "evidence:research",
  "evidence:csv",
  "instrumentation",
  "platform",
  "platform-contract",
  "blocked",
  "no-autopilot",
  "approval:planning",
  "approval:release",
  "approval:security",
]);

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

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function validateCatalog(value) {
  if (
    !exactKeys(value, ["catalogVersion", "labels", "schemaVersion", "strategy"]) ||
    value.schemaVersion !== 1 ||
    value.catalogVersion !== "seorilabs-standard-labels/v2" ||
    value.strategy !== "UPSERT_FIXED_PRESERVE_CUSTOM" ||
    !Array.isArray(value.labels) ||
    value.labels.length !== 20 ||
    value.labels.some(
      (label) =>
        !exactKeys(label, ["color", "description", "name"]) ||
        typeof label.name !== "string" ||
        label.name.length === 0 ||
        label.name.length > 50 ||
        !COLOR_PATTERN.test(label.color ?? "") ||
        typeof label.description !== "string" ||
        label.description.length > 100,
    ) ||
    canonicalJson(value.labels.map(({ name }) => name)) !==
      canonicalJson(EXPECTED_LABEL_NAMES) ||
    new Set(value.labels.map(({ name }) => name.toLocaleLowerCase("en-US")))
      .size !== value.labels.length
  ) {
    throw new Error("FLEET_STANDARD_LABEL_CATALOG_INVALID");
  }
  return deepFreeze(structuredClone(value));
}

const catalog = validateCatalog(
  JSON.parse(await readFile(CATALOG_PATH, "utf8")),
);

export const FLEET_STANDARD_LABEL_CATALOG = catalog;
export const FLEET_STANDARD_LABEL_CATALOG_DIGEST = sha256(
  canonicalJson(catalog),
);

export function fleetStandardLabelsPayload(repository) {
  if (
    repository === null ||
    typeof repository !== "object" ||
    Array.isArray(repository) ||
    !REPOSITORY_ID_PATTERN.test(repository.id ?? "") ||
    !FULL_NAME_PATTERN.test(repository.fullName ?? "")
  ) {
    throw new Error("FLEET_STANDARD_LABEL_REPOSITORY_INVALID");
  }
  return deepFreeze({
    catalogDigest: FLEET_STANDARD_LABEL_CATALOG_DIGEST,
    catalogVersion: catalog.catalogVersion,
    labels: structuredClone(catalog.labels),
    repositoryFullName: repository.fullName,
    repositoryId: repository.id,
    strategy: catalog.strategy,
  });
}

export function validateFleetStandardLabelsOperation(operation, repository) {
  if (
    operation?.kind !== "github.standard-labels.ensure" ||
    !DIGEST_PATTERN.test(operation.idempotencyKey ?? "")
  ) {
    return false;
  }
  let expected;
  try {
    expected = fleetStandardLabelsPayload(repository);
  } catch {
    return false;
  }
  return (
    canonicalJson(operation.payload) === canonicalJson(expected) &&
    operation.idempotencyKey ===
      sha256(
        canonicalJson({
          kind: operation.kind,
          payload: expected,
          repositoryId: repository.id,
        }),
      )
  );
}
