import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { parseDocument } from "yaml";

import {
  computeFleetCoveragePageDigest,
  computeFleetEvidenceDigest,
  computeFleetFindingsDigest,
  computeFleetMigrationInventoryDigest,
  computeFleetRepositoryReadbackDigest,
  validateFleetMigrationInventory,
} from "./fleet-migration.mjs";

const ORGANIZATION_LOGIN = "seorilabs";
const ORGANIZATION_ID = "283115031";
const GITHUB_APP_ID = "4124446";
const GITHUB_APP_SLUG = "seorilabs-backoffice";
const GITHUB_APP_INSTALLATION_ID = "142120077";
const GITHUB_APP_WEBHOOK_URL = "https://backoffice.vzyx.xyz/api/webhooks";
const MAX_INVENTORY_TTL_MS = 15 * 60 * 1000;
const MAX_PAGES = 1000;
const MAX_REPOSITORIES = 10000;
const MAX_TREE_ENTRIES = 1000000;
const MAX_GIT_TREE_PATH_BYTES = 4096;
const MAX_BLOB_BYTES = 10 * 1024 * 1024;
const MAX_SCANNED_BLOBS_PER_REPOSITORY = 10000;
const MAX_SCANNED_BYTES_PER_REPOSITORY = 64 * 1024 * 1024;
const COLLECTION_CONTRACT = "seorilabs-fleet-migration-collection-v1";
const COLLECTION_EVIDENCE_CONTRACT =
  "seorilabs-fleet-migration-collector-evidence-v1";
const CAPABILITY_CONTRACT =
  "seorilabs-fleet-github-app-capability-v1";
const PAGE_CONTRACT =
  "seorilabs-github-installation-repositories-page-v1";
const HEAD_CONTRACT = "seorilabs-github-repository-head-readback-v1";
const TREE_CONTRACT = "seorilabs-github-repository-tree-readback-v1";
const BLOB_CONTRACT = "seorilabs-github-repository-blob-readback-v1";
const BACKOFFICE_CONTRACT =
  "seorilabs-fleet-migration-backoffice-public-evidence-v1";
const MODES = Object.freeze(["FIXTURE", "READ_ONLY_SHADOW"]);
const REQUIRED_GITHUB_APP_PERMISSIONS = deepFreeze([
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
const REQUIRED_GITHUB_APP_EVENTS = deepFreeze([
  "issue_comment",
  "issues",
  "pull_request",
  "push",
  "repository",
  "workflow_run",
]);
const NUMERIC_ID_PATTERN = /^[1-9][0-9]{0,31}$/u;
const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const FULL_NAME_PATTERN = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const SOURCE_REF_PATTERN =
  /^refs\/heads\/[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9._~+/=-]{1,512}$/u;
const WORKFLOW_PATH_PATTERN =
  /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/u;
const CENTRAL_WORKFLOW_PATTERN =
  /^seorilabs\/\.github\/\.github\/workflows\/([a-z0-9-]+\.yml)@([A-Za-z0-9][A-Za-z0-9._/-]{0,127})$/u;
const PRIVATE_SURFACE_KEY_PATTERN =
  /^(?:authorization|bytes|cookie|credentialValue|password|payload|privateKey|privateKeyPem|rawSecret|secret|secretValue|token)$/iu;
const PRIVATE_SURFACE_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /["']private_key["']\s*:/u,
]);
const LEGACY_CONTRACTS = Object.freeze({
  ".seorilabs/app.yaml": Object.freeze({
    contract: "ORG_CONTRACT_APP",
    format: "YAML",
    schemaId: "https://seorilabs.github.io/contracts/v1/app.schema.json",
  }),
  "play-store/google-play.config.json": Object.freeze({
    contract: "GOOGLE_PLAY",
    format: "JSON",
    schemaId:
      "https://seorilabs.github.io/contracts/v1/markets/google-play.schema.json",
  }),
  "app-store/app-store.config.json": Object.freeze({
    contract: "APP_STORE",
    format: "JSON",
    schemaId:
      "https://seorilabs.github.io/contracts/v1/markets/app-store.schema.json",
  }),
  "apps-in-toss/apps-in-toss.config.json": Object.freeze({
    contract: "APPS_IN_TOSS",
    format: "JSON",
    schemaId:
      "https://seorilabs.github.io/contracts/v1/markets/apps-in-toss.schema.json",
  }),
  "release/market-launch-state.json": Object.freeze({
    contract: "MARKET_LAUNCH_STATE",
    format: "JSON",
    schemaId:
      "https://seorilabs.com/contracts/legacy/market-launch-state.v1.schema.json",
  }),
  ".seorilabs/backoffice.json": Object.freeze({
    contract: "BACKOFFICE_OPERATIONS",
    format: "JSON",
    schemaId:
      "https://seorilabs.com/contracts/legacy/backoffice-operations.v1.schema.json",
  }),
});

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

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function gitBlobSha(value) {
  return createHash("sha1")
    .update(`blob ${value.length}\0`)
    .update(value)
    .digest("hex");
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
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

function trustedTime(clock) {
  let value;
  try {
    value = clock();
  } catch {
    throw new Error("FLEET_MIGRATION_COLLECTOR_TIME_INVALID");
  }
  const milliseconds =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : typeof value === "string"
          ? Date.parse(value)
          : Number.NaN;
  if (!Number.isFinite(milliseconds)) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_TIME_INVALID");
  }
  return milliseconds;
}

function assertPublicSurface(value) {
  const visit = (item) => {
    if (Array.isArray(item)) {
      for (const nested of item) visit(nested);
      return;
    }
    if (typeof item === "string") {
      if (PRIVATE_SURFACE_VALUE_PATTERNS.some((pattern) => pattern.test(item))) {
        throw new Error("FLEET_MIGRATION_COLLECTOR_PRIVATE_SURFACE_REJECTED");
      }
      return;
    }
    if (item === null || typeof item !== "object") return;
    for (const [key, nested] of Object.entries(item)) {
      if (PRIVATE_SURFACE_KEY_PATTERN.test(key)) {
        throw new Error("FLEET_MIGRATION_COLLECTOR_PRIVATE_SURFACE_REJECTED");
      }
      visit(nested);
    }
  };
  visit(value);
}

function isSafeGitTreePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    Buffer.byteLength(path, "utf8") > MAX_GIT_TREE_PATH_BYTES ||
    Buffer.from(path, "utf8").toString("utf8") !== path
  ) {
    return false;
  }
  const segments = path.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== "..",
  );
}

async function trustedReadback(callback, request, code) {
  try {
    const result = await callback(deepFreeze(structuredClone(request)));
    return structuredClone(result);
  } catch {
    throw new Error(`${code}_FAILED`);
  }
}

function assertEvidenceDigest(value, code) {
  if (
    !DIGEST_PATTERN.test(value?.evidenceDigest ?? "") ||
    computeFleetEvidenceDigest(value) !== value.evidenceDigest
  ) {
    throw new Error(`${code}_MISMATCH`);
  }
}

function validateCapabilityPermissions(value) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("FLEET_MIGRATION_GITHUB_APP_CAPABILITY_INVALID");
  }
  const names = new Set();
  let priorName = "";
  for (const permission of value) {
    if (
      !exactKeys(permission, ["access", "name"]) ||
      !/^[a-z][a-z0-9_]{1,63}$/u.test(permission.name ?? "") ||
      !["read", "write", "admin"].includes(permission.access) ||
      names.has(permission.name) ||
      (priorName !== "" && compareUtf8(priorName, permission.name) >= 0)
    ) {
      throw new Error("FLEET_MIGRATION_GITHUB_APP_CAPABILITY_INVALID");
    }
    names.add(permission.name);
    priorName = permission.name;
  }
}

function validateCapabilityEvents(value) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("FLEET_MIGRATION_GITHUB_APP_CAPABILITY_INVALID");
  }
  let priorEvent = "";
  const seen = new Set();
  for (const event of value) {
    if (
      !/^[a-z][a-z0-9_]{1,63}$/u.test(event ?? "") ||
      seen.has(event) ||
      (priorEvent !== "" && compareUtf8(priorEvent, event) >= 0)
    ) {
      throw new Error("FLEET_MIGRATION_GITHUB_APP_CAPABILITY_INVALID");
    }
    seen.add(event);
    priorEvent = event;
  }
}

function validateGitHubAppCapability(value, configuration) {
  const app = value?.app;
  const installation = value?.installation;
  const eventAcceptance = value?.eventAcceptance;
  if (
    !exactKeys(value, [
      "app",
      "contract",
      "eventAcceptance",
      "evidenceDigest",
      "installation",
      "observedAt",
      "organization",
      "revision",
    ]) ||
    value.contract !== CAPABILITY_CONTRACT ||
    !EVIDENCE_ID_PATTERN.test(value.revision ?? "") ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    !exactKeys(value.organization, ["id", "login"]) ||
    value.organization.id !== configuration.organizationId ||
    value.organization.login !== ORGANIZATION_LOGIN ||
    !exactKeys(app, [
      "active",
      "events",
      "id",
      "ownerId",
      "ownerLogin",
      "permissions",
      "readbackId",
      "slug",
      "webhookActive",
      "webhookUrl",
    ]) ||
    !EVIDENCE_ID_PATTERN.test(app.readbackId ?? "") ||
    !NUMERIC_ID_PATTERN.test(app.id ?? "") ||
    !NUMERIC_ID_PATTERN.test(app.ownerId ?? "") ||
    !/^[a-z0-9][a-z0-9-]{1,99}$/u.test(app.slug ?? "") ||
    app.ownerLogin !== ORGANIZATION_LOGIN ||
    typeof app.active !== "boolean" ||
    typeof app.webhookActive !== "boolean" ||
    typeof app.webhookUrl !== "string" ||
    app.webhookUrl.length > 512 ||
    !exactKeys(installation, [
      "accountId",
      "accountLogin",
      "appId",
      "id",
      "permissions",
      "readbackId",
      "repositorySelection",
      "suspendedAt",
      "targetType",
      "updatedAt",
    ]) ||
    !EVIDENCE_ID_PATTERN.test(installation.readbackId ?? "") ||
    !NUMERIC_ID_PATTERN.test(installation.id ?? "") ||
    !NUMERIC_ID_PATTERN.test(installation.appId ?? "") ||
    !NUMERIC_ID_PATTERN.test(installation.accountId ?? "") ||
    installation.accountLogin !== ORGANIZATION_LOGIN ||
    installation.targetType !== "Organization" ||
    !["all", "selected"].includes(installation.repositorySelection) ||
    (installation.suspendedAt !== null &&
      !Number.isFinite(Date.parse(installation.suspendedAt))) ||
    !Number.isFinite(Date.parse(installation.updatedAt)) ||
    Date.parse(installation.updatedAt) > Date.parse(value.observedAt) ||
    !exactKeys(eventAcceptance, [
      "acceptedAt",
      "appReadbackId",
      "deliveryId",
      "event",
      "evidenceDigest",
      "handlerRevision",
      "installationReadbackId",
      "state",
    ]) ||
    !["ACCEPTED", "UNVERIFIED"].includes(eventAcceptance.state) ||
    eventAcceptance.event !== "repository" ||
    eventAcceptance.appReadbackId !== app.readbackId ||
    eventAcceptance.installationReadbackId !== installation.readbackId ||
    (eventAcceptance.state === "ACCEPTED" &&
      (!EVIDENCE_ID_PATTERN.test(eventAcceptance.deliveryId ?? "") ||
        !EVIDENCE_ID_PATTERN.test(eventAcceptance.handlerRevision ?? "") ||
        !Number.isFinite(Date.parse(eventAcceptance.acceptedAt)) ||
        Date.parse(eventAcceptance.acceptedAt) > Date.parse(value.observedAt))) ||
    (eventAcceptance.state === "UNVERIFIED" &&
      (eventAcceptance.deliveryId !== null ||
        eventAcceptance.handlerRevision !== null ||
        eventAcceptance.acceptedAt !== null))
  ) {
    throw new Error("FLEET_MIGRATION_GITHUB_APP_CAPABILITY_INVALID");
  }
  validateCapabilityPermissions(app.permissions);
  validateCapabilityPermissions(installation.permissions);
  validateCapabilityEvents(app.events);
  assertEvidenceDigest(
    eventAcceptance,
    "FLEET_MIGRATION_GITHUB_APP_EVENT_ACCEPTANCE",
  );
  assertEvidenceDigest(value, "FLEET_MIGRATION_GITHUB_APP_CAPABILITY");
  assertPublicSurface(value);
  return deepFreeze(value);
}

export function isFleetGitHubAppCapabilityVerified(value) {
  try {
    const capability = structuredClone(value);
    validateGitHubAppCapability(capability, {
      organizationId: ORGANIZATION_ID,
    });
    return (
      capability.organization.id === ORGANIZATION_ID &&
      capability.app.id === GITHUB_APP_ID &&
      capability.app.slug === GITHUB_APP_SLUG &&
      capability.app.ownerId === ORGANIZATION_ID &&
      capability.app.ownerLogin === ORGANIZATION_LOGIN &&
      capability.app.active === true &&
      capability.app.webhookActive === true &&
      capability.app.webhookUrl === GITHUB_APP_WEBHOOK_URL &&
      canonicalJson(capability.app.permissions) ===
        canonicalJson(REQUIRED_GITHUB_APP_PERMISSIONS) &&
      canonicalJson(capability.app.events) ===
        canonicalJson(REQUIRED_GITHUB_APP_EVENTS) &&
      capability.installation.id === GITHUB_APP_INSTALLATION_ID &&
      capability.installation.appId === GITHUB_APP_ID &&
      capability.installation.accountId === ORGANIZATION_ID &&
      capability.installation.accountLogin === ORGANIZATION_LOGIN &&
      capability.installation.targetType === "Organization" &&
      capability.installation.repositorySelection === "all" &&
      capability.installation.suspendedAt === null &&
      canonicalJson(capability.installation.permissions) ===
        canonicalJson(REQUIRED_GITHUB_APP_PERMISSIONS) &&
      capability.eventAcceptance.state === "ACCEPTED" &&
      capability.eventAcceptance.event === "repository" &&
      Date.parse(capability.eventAcceptance.acceptedAt) >=
        Date.parse(capability.installation.updatedAt) &&
      Date.parse(capability.eventAcceptance.acceptedAt) <=
        Date.parse(capability.observedAt)
    );
  } catch {
    return false;
  }
}

export function validateFleetGitHubAppCapability(value) {
  try {
    validateGitHubAppCapability(structuredClone(value), {
      organizationId: ORGANIZATION_ID,
    });
    return deepFreeze({ ok: true, diagnostics: [] });
  } catch (error) {
    return deepFreeze({
      ok: false,
      diagnostics: [
        String(error?.message ?? "FLEET_MIGRATION_GITHUB_APP_CAPABILITY_INVALID"),
      ],
    });
  }
}

function validatePageRepository(value, configuration) {
  if (
    !exactKeys(value, [
      "archived",
      "defaultBranch",
      "fork",
      "fullName",
      "id",
    ]) ||
    !NUMERIC_ID_PATTERN.test(value.id ?? "") ||
    !FULL_NAME_PATTERN.test(value.fullName ?? "") ||
    value.archived !== false ||
    typeof value.fork !== "boolean" ||
    typeof value.defaultBranch !== "string" ||
    !SOURCE_REF_PATTERN.test(`refs/heads/${value.defaultBranch}`) ||
    value.fullName === `${ORGANIZATION_LOGIN}/`
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_REPOSITORY_PAGE_MISMATCH");
  }
  if (
    value.fullName.split("/")[0] !== ORGANIZATION_LOGIN ||
    configuration.organizationId.length === 0
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_REPOSITORY_PAGE_MISMATCH");
  }
  return deepFreeze(value);
}

function validatePage(
  value,
  { configuration, requestCursor, firstPage, pageNumber },
) {
  if (
    !exactKeys(value, [
      "contract",
      "hasNextPage",
      "installationId",
      "nextCursor",
      "observedAt",
      "organization",
      "providerTotalCount",
      "readbackId",
      "repositories",
      "requestCursor",
      "snapshotId",
    ]) ||
    value.contract !== PAGE_CONTRACT ||
    !exactKeys(value.organization, ["id", "login"]) ||
    value.organization.id !== configuration.organizationId ||
    value.organization.login !== ORGANIZATION_LOGIN ||
    value.installationId !== configuration.installationId ||
    value.requestCursor !== requestCursor ||
    !EVIDENCE_ID_PATTERN.test(value.readbackId ?? "") ||
    !EVIDENCE_ID_PATTERN.test(value.snapshotId ?? "") ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    !Number.isSafeInteger(value.providerTotalCount) ||
    value.providerTotalCount < 1 ||
    value.providerTotalCount > MAX_REPOSITORIES ||
    !Array.isArray(value.repositories) ||
    value.repositories.length < 1 ||
    value.repositories.length > configuration.pageSize ||
    typeof value.hasNextPage !== "boolean" ||
    (value.nextCursor !== null &&
      !CURSOR_PATTERN.test(value.nextCursor ?? "")) ||
    value.hasNextPage !== (value.nextCursor !== null) ||
    (value.hasNextPage && value.nextCursor === requestCursor)
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_PAGINATION_MISMATCH");
  }
  if (
    firstPage !== undefined &&
    (value.readbackId !== firstPage.readbackId ||
      value.snapshotId !== firstPage.snapshotId ||
      value.providerTotalCount !== firstPage.providerTotalCount)
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_PAGINATION_MISMATCH");
  }
  const repositories = value.repositories.map((repository) =>
    validatePageRepository(repository, configuration),
  );
  const ids = repositories.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_PAGINATION_MISMATCH");
  }
  return deepFreeze({
    ...value,
    pageNumber,
    repositories,
  });
}

async function collectRepositoryPages(configuration) {
  const pages = [];
  const observedTimes = [];
  const repositories = [];
  const seenCursors = new Set();
  const seenIds = new Set();
  const seenNames = new Set();
  let requestCursor = null;
  let firstPage;
  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
    const raw = await trustedReadback(
      configuration.readInstallationRepositoriesPage,
      {
        contract: PAGE_CONTRACT,
        organizationId: configuration.organizationId,
        organizationLogin: ORGANIZATION_LOGIN,
        installationId: configuration.installationId,
        archived: false,
        pageSize: configuration.pageSize,
        cursor: requestCursor,
      },
      "FLEET_MIGRATION_COLLECTOR_GITHUB_PAGE_READBACK",
    );
    const page = validatePage(raw, {
      configuration,
      requestCursor,
      firstPage,
      pageNumber,
    });
    observedTimes.push(page.observedAt);
    firstPage ??= page;
    for (const repository of page.repositories) {
      const foldedName = repository.fullName.toLowerCase();
      if (seenIds.has(repository.id) || seenNames.has(foldedName)) {
        throw new Error("FLEET_MIGRATION_COLLECTOR_REPOSITORY_DUPLICATE");
      }
      seenIds.add(repository.id);
      seenNames.add(foldedName);
      repositories.push(repository);
    }
    const publicPage = {
      pageNumber,
      requestCursor,
      responseNextCursor: page.nextCursor,
      hasNextPage: page.hasNextPage,
      observedAt: page.observedAt,
      providerTotalCount: page.providerTotalCount,
      repositoryIds: page.repositories.map(({ id }) => id),
      pageDigest: "sha256:" + "0".repeat(64),
    };
    publicPage.pageDigest = computeFleetCoveragePageDigest({
      readbackId: page.readbackId,
      page: publicPage,
    });
    pages.push(publicPage);
    if (!page.hasNextPage) break;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("FLEET_MIGRATION_COLLECTOR_PAGINATION_MISMATCH");
    }
    seenCursors.add(page.nextCursor);
    requestCursor = page.nextCursor;
  }
  if (
    firstPage === undefined ||
    pages.at(-1)?.hasNextPage !== false ||
    repositories.length !== firstPage.providerTotalCount
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_PAGINATION_INCOMPLETE");
  }
  return deepFreeze({ firstPage, observedTimes, pages, repositories });
}

function validateHead(value, repository) {
  const expectedRef = `refs/heads/${repository.defaultBranch}`;
  if (
    !exactKeys(value, [
      "contract",
      "defaultRef",
      "fullName",
      "observedAt",
      "readbackId",
      "repositoryId",
      "sourceSha",
      "treeSha",
    ]) ||
    value.contract !== HEAD_CONTRACT ||
    !EVIDENCE_ID_PATTERN.test(value.readbackId ?? "") ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    value.repositoryId !== repository.id ||
    value.fullName !== repository.fullName ||
    value.defaultRef !== expectedRef ||
    !SHA_PATTERN.test(value.sourceSha ?? "") ||
    !SHA_PATTERN.test(value.treeSha ?? "")
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_SOURCE_READBACK_MISMATCH");
  }
  return deepFreeze(value);
}

function validateTreeEntry(entry) {
  if (
    !exactKeys(entry, ["mode", "objectSha", "path", "size", "type"]) ||
    !isSafeGitTreePath(entry.path) ||
    !SHA_PATTERN.test(entry.objectSha ?? "") ||
    !["BLOB", "TREE"].includes(entry.type) ||
    (entry.type === "BLOB" &&
      (!["100644", "100755"].includes(entry.mode) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0)) ||
    (entry.type === "TREE" && (entry.mode !== "040000" || entry.size !== null))
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_TREE_ENTRY_UNSAFE");
  }
  return deepFreeze(entry);
}

function validateTree(value, repository, head) {
  if (
    !exactKeys(value, [
      "contract",
      "entries",
      "observedAt",
      "readbackId",
      "recursive",
      "repositoryId",
      "sourceSha",
      "treeSha",
      "truncated",
    ]) ||
    value.contract !== TREE_CONTRACT ||
    !EVIDENCE_ID_PATTERN.test(value.readbackId ?? "") ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    value.repositoryId !== repository.id ||
    value.sourceSha !== head.sourceSha ||
    value.treeSha !== head.treeSha ||
    value.recursive !== true ||
    value.truncated !== false ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_TREE_ENTRIES
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_TREE_READBACK_MISMATCH");
  }
  const entries = value.entries
    .map(validateTreeEntry)
    .sort((left, right) => compareUtf8(left.path, right.path));
  const paths = new Set();
  for (const entry of entries) {
    if (paths.has(entry.path)) {
      throw new Error("FLEET_MIGRATION_COLLECTOR_TREE_PATH_COLLISION");
    }
    paths.add(entry.path);
  }
  return deepFreeze({ ...value, entries });
}

function validateBlob(value, repository, head, tree, entry) {
  if (
    !exactKeys(value, [
      "content",
      "contract",
      "encoding",
      "objectSha",
      "observedAt",
      "path",
      "readbackId",
      "repositoryId",
      "size",
      "sourceSha",
      "treeSha",
    ]) ||
    value.contract !== BLOB_CONTRACT ||
    !EVIDENCE_ID_PATTERN.test(value.readbackId ?? "") ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    value.repositoryId !== repository.id ||
    value.sourceSha !== head.sourceSha ||
    value.treeSha !== tree.treeSha ||
    value.path !== entry.path ||
    value.objectSha !== entry.objectSha ||
    value.size !== entry.size ||
    value.encoding !== "base64" ||
    typeof value.content !== "string"
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_BLOB_READBACK_MISMATCH");
  }
  let decoded;
  try {
    decoded = Buffer.from(value.content, "base64");
  } catch {
    throw new Error("FLEET_MIGRATION_COLLECTOR_BLOB_ENCODING_INVALID");
  }
  if (
    decoded.length !== value.size ||
    decoded.toString("base64") !== value.content ||
    gitBlobSha(decoded) !== entry.objectSha
  ) {
    decoded.fill(0);
    throw new Error("FLEET_MIGRATION_COLLECTOR_BLOB_READBACK_MISMATCH");
  }
  return decoded;
}

function lineNumberAtOffset(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle;
  }
  return low + 1;
}

function workflowDetections(path, content, detectorSourceSha) {
  if (!WORKFLOW_PATH_PATTERN.test(path)) return [];
  const text = content.toString("utf8");
  if (text.includes("\0") || Buffer.from(text, "utf8").length !== content.length) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_WORKFLOW_ENCODING_INVALID");
  }
  const document = parseDocument(text, {
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_WORKFLOW_YAML_INVALID");
  }
  let root;
  try {
    root = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new Error("FLEET_MIGRATION_COLLECTOR_WORKFLOW_YAML_INVALID");
  }
  if (
    root === null ||
    typeof root !== "object" ||
    Array.isArray(root)
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_WORKFLOW_YAML_INVALID");
  }
  const secretLines = [];
  const floating = new Map();
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineStarts.push(index + 1);
  }
  const jobs = root.jobs;
  if (jobs !== undefined) {
    if (jobs === null || typeof jobs !== "object" || Array.isArray(jobs)) {
      throw new Error("FLEET_MIGRATION_COLLECTOR_WORKFLOW_YAML_INVALID");
    }
    for (const [jobName, job] of Object.entries(jobs)) {
      if (job === null || typeof job !== "object" || Array.isArray(job)) {
        continue;
      }
      if (job.secrets === "inherit") {
        const node = document.getIn(["jobs", jobName, "secrets"], true);
        if (!Array.isArray(node?.range)) {
          throw new Error("FLEET_MIGRATION_COLLECTOR_WORKFLOW_YAML_INVALID");
        }
        secretLines.push(lineNumberAtOffset(lineStarts, node.range[0]));
      }
      if (typeof job.uses !== "string") continue;
      const match = CENTRAL_WORKFLOW_PATTERN.exec(job.uses);
      if (match === null) continue;
      const calledWorkflow = `seorilabs/.github/.github/workflows/${match[1]}`;
      const ref = match[2];
      if (SHA_PATTERN.test(ref)) continue;
      const node = document.getIn(["jobs", jobName, "uses"], true);
      if (!Array.isArray(node?.range)) {
        throw new Error("FLEET_MIGRATION_COLLECTOR_WORKFLOW_YAML_INVALID");
      }
      const key = `${calledWorkflow}@${ref}`;
      const item = floating.get(key) ?? {
        type: "WORKFLOW_FLOATING_REF",
        detectorSha: detectorSourceSha,
        calledWorkflow,
        ref,
        occurrenceLines: [],
      };
      item.occurrenceLines.push(lineNumberAtOffset(lineStarts, node.range[0]));
      floating.set(key, item);
    }
  }
  return [
    ...(secretLines.length === 0
      ? []
      : [
          {
            type: "WORKFLOW_SECRETS_INHERIT",
            detectorSha: detectorSourceSha,
            occurrenceLines: secretLines,
          },
        ]),
    ...floating.values(),
  ];
}

async function legacyDetections(
  entry,
  content,
  detectorSourceSha,
  repository,
  head,
  configuration,
) {
  const { path } = entry;
  let definition = LEGACY_CONTRACTS[path];
  if (
    definition === undefined &&
    repository.fullName === "seorilabs/platform" &&
    /^registry\/apps\/[a-z0-9][a-z0-9-]{1,62}\.json$/u.test(path)
  ) {
    definition = {
      contract: "PLATFORM_REGISTRY_APP",
      format: "JSON",
      schemaId:
        "https://seorilabs.com/contracts/legacy/platform-registry-app.v1.schema.json",
    };
  }
  if (definition === undefined) return [];
  const text = content.toString("utf8");
  if (text.includes("\0") || Buffer.from(text, "utf8").length !== content.length) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_LEGACY_ENCODING_INVALID");
  }
  let document;
  try {
    if (definition.format === "YAML") {
      const yaml = parseDocument(text, {
        schema: "core",
        strict: true,
        uniqueKeys: true,
      });
      if (yaml.errors.length > 0 || yaml.warnings.length > 0) {
        throw new Error("invalid YAML");
      }
      document = yaml.toJS({ maxAliasCount: 0 });
    } else {
      document = JSON.parse(text);
    }
    if (
      document === null ||
      typeof document !== "object" ||
      Array.isArray(document)
    ) {
      throw new Error("not an object");
    }
  } catch {
    throw new Error("FLEET_MIGRATION_COLLECTOR_LEGACY_DOCUMENT_INVALID");
  }
  const contentDigest = sha256(content);
  const validation = await trustedReadback(
    configuration.validateLegacyDocument,
    {
      contract: definition.contract,
      schemaId: definition.schemaId,
      repositoryId: repository.id,
      fullName: repository.fullName,
      sourceSha: head.sourceSha,
      path,
      objectSha: entry.objectSha,
      contentDigest,
      document,
    },
    "FLEET_MIGRATION_COLLECTOR_LEGACY_SCHEMA_VALIDATION",
  );
  if (
    !exactKeys(validation, [
      "contentDigest",
      "contract",
      "schemaId",
      "state",
      "validatorRevision",
    ]) ||
    validation.state !== "MATCH" ||
    validation.contract !== definition.contract ||
    validation.schemaId !== definition.schemaId ||
    validation.contentDigest !== contentDigest ||
    !EVIDENCE_ID_PATTERN.test(validation.validatorRevision ?? "")
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_LEGACY_SCHEMA_MISMATCH");
  }
  return [
    {
      type: "LEGACY_OPERATION_JSON",
      contract: definition.contract,
      schemaId: definition.schemaId,
      matchedBy: "SCHEMA_VALIDATION",
      detectorSha: detectorSourceSha,
    },
  ];
}

function isDetectorRelevantBlob(entry, repository) {
  return (
    Object.hasOwn(LEGACY_CONTRACTS, entry.path) ||
    WORKFLOW_PATH_PATTERN.test(entry.path) ||
    (repository.fullName === "seorilabs/platform" &&
      /^registry\/apps\/[a-z0-9][a-z0-9-]{1,62}\.json$/u.test(entry.path))
  );
}

async function scanBlob(
  entry,
  blob,
  content,
  detectorSourceSha,
  repository,
  head,
  configuration,
) {
  const contentDigest = sha256(content);
  const detections = [
    ...(await legacyDetections(
      entry,
      content,
      detectorSourceSha,
      repository,
      head,
      configuration,
    )),
    ...workflowDetections(entry.path, content, detectorSourceSha),
  ];
  return {
    publicRecord: {
      readbackId: blob.readbackId,
      observedAt: blob.observedAt,
      path: entry.path,
      mode: entry.mode,
      objectSha: entry.objectSha,
      size: entry.size,
      contentDigest,
    },
    detections: detections.map((detection) => ({
      path: entry.path,
      gitEntry: {
        kind: "BLOB",
        mode: entry.mode,
        objectSha: entry.objectSha,
      },
      contentDigest,
      detection,
    })),
  };
}

function validateEvidenceDigests(value) {
  const visit = (item) => {
    if (Array.isArray(item)) {
      for (const nested of item) visit(nested);
      return;
    }
    if (item === null || typeof item !== "object") return;
    for (const nested of Object.values(item)) visit(nested);
    if (Object.hasOwn(item, "evidenceDigest")) {
      assertEvidenceDigest(
        item,
        "FLEET_MIGRATION_COLLECTOR_BACKOFFICE_EVIDENCE",
      );
    }
  };
  visit(value);
}

function validatePublicEvidence(value, repository, head, organizationId) {
  if (
    !exactKeys(value, [
      "activeConfig",
      "app",
      "classification",
      "classificationDecisionId",
      "classificationDecisionRevision",
      "contract",
      "credentialBindings",
      "evidenceDigest",
      "fullName",
      "observedAt",
      "organizationId",
      "platformFleetBinding",
      "providerObservations",
      "readbackId",
      "repositoryId",
      "signedSnapshot",
      "sourceSha",
    ]) ||
    value.contract !== BACKOFFICE_CONTRACT ||
    !EVIDENCE_ID_PATTERN.test(value.readbackId ?? "") ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    value.organizationId !== organizationId ||
    value.repositoryId !== repository.id ||
    value.fullName !== repository.fullName ||
    value.sourceSha !== head.sourceSha ||
    !["PRODUCT_APP", "INFRA_REPO", "PLATFORM_PRODUCER", "EXCLUDED"].includes(
      value.classification,
    ) ||
    !Number.isSafeInteger(value.classificationDecisionRevision) ||
    value.classificationDecisionRevision < 1 ||
    !EVIDENCE_ID_PATTERN.test(value.classificationDecisionId ?? "") ||
    !Array.isArray(value.providerObservations) ||
    !Array.isArray(value.credentialBindings)
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_BACKOFFICE_READBACK_MISMATCH");
  }
  if (repository.fork && value.classification !== "EXCLUDED") {
    throw new Error("FLEET_MIGRATION_COLLECTOR_BACKOFFICE_READBACK_MISMATCH");
  }
  if (
    value.providerObservations.some(
      (observation) =>
        !exactKeys(observation, [
          "digest",
          "observationId",
          "provider",
          "publicIdentity",
          "revision",
          "state",
        ]) ||
        !EVIDENCE_ID_PATTERN.test(observation.observationId ?? "") ||
        !NUMERIC_ID_PATTERN.test(observation.revision ?? "") ||
        !DIGEST_PATTERN.test(observation.digest ?? "") ||
        observation.state !== "MATCH",
    ) ||
    value.credentialBindings.some(
      (binding) =>
        !exactKeys(binding, [
          "capability",
          "digest",
          "environment",
          "fingerprint",
          "logicalCredentialId",
          "observationId",
          "provider",
          "publicIdentity",
          "revision",
          "status",
        ]) ||
        !EVIDENCE_ID_PATTERN.test(binding.observationId ?? "") ||
        !NUMERIC_ID_PATTERN.test(binding.revision ?? "") ||
        !DIGEST_PATTERN.test(binding.digest ?? "") ||
        binding.status !== "ACTIVE",
    )
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_BACKOFFICE_READBACK_MISMATCH");
  }
  const providerObservationIds = value.providerObservations.map(
    ({ observationId }) => observationId,
  );
  const credentialBindingKeys = value.credentialBindings.map(
    ({ capability, environment, logicalCredentialId, provider }) =>
      canonicalJson({
        capability,
        environment,
        logicalCredentialId,
        provider,
      }),
  );
  if (
    new Set(providerObservationIds).size !== providerObservationIds.length ||
    new Set(credentialBindingKeys).size !== credentialBindingKeys.length ||
    canonicalJson(providerObservationIds) !==
      canonicalJson([...providerObservationIds].sort(compareUtf8)) ||
    canonicalJson(credentialBindingKeys) !==
      canonicalJson([...credentialBindingKeys].sort(compareUtf8))
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_BACKOFFICE_READBACK_MISMATCH");
  }
  if (value.classification === "PRODUCT_APP") {
    if (
      value.app === null ||
      value.activeConfig === null ||
      value.signedSnapshot === null ||
      value.platformFleetBinding === null ||
      value.app.repositoryId !== repository.id ||
      value.app.sourceSha !== head.sourceSha ||
      value.activeConfig.signedSnapshotDigest !==
        value.signedSnapshot.snapshotDigest ||
      value.platformFleetBinding.appId !== value.app.appId
    ) {
      throw new Error("FLEET_MIGRATION_COLLECTOR_BACKOFFICE_READBACK_MISMATCH");
    }
  } else if (
    value.app !== null ||
    value.activeConfig !== null ||
    value.signedSnapshot !== null ||
    value.platformFleetBinding !== null
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_BACKOFFICE_READBACK_MISMATCH");
  }
  assertPublicSurface(value);
  validateEvidenceDigests(value);
  return deepFreeze(value);
}

function detectionKey({ path, contentDigest, detection }) {
  return canonicalJson({ path, contentDigest, detection });
}

function validateCandidateSourceReadback(candidate, scanned, repository, head, tree) {
  const source = candidate.proofs?.sourceReadback;
  if (
    source === null ||
    typeof source !== "object" ||
    source.repositoryId !== repository.id ||
    source.sourceRef !== head.defaultRef ||
    source.sourceSha !== head.sourceSha ||
    source.treeSha !== tree.treeSha ||
    source.path !== scanned.path ||
    canonicalJson(source.gitEntry) !== canonicalJson(scanned.gitEntry) ||
    source.contentDigest !== scanned.contentDigest ||
    source.state !== "MATCH"
  ) {
    throw new Error(
      "FLEET_MIGRATION_COLLECTOR_CANDIDATE_SOURCE_READBACK_MISMATCH",
    );
  }
}

function bindCandidates(
  rawCandidates,
  scannedCandidates,
  repository,
  head,
  tree,
  detectorSourceSha,
) {
  if (!Array.isArray(rawCandidates)) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_CANDIDATE_BINDING_MISMATCH");
  }
  const scannedByKey = new Map();
  for (const scanned of scannedCandidates) {
    const key = detectionKey(scanned);
    if (scannedByKey.has(key)) {
      throw new Error("FLEET_MIGRATION_COLLECTOR_DETECTION_DUPLICATE");
    }
    scannedByKey.set(key, scanned);
  }
  const result = [];
  const seen = new Set();
  for (const raw of rawCandidates) {
    if (
      !exactKeys(raw, [
        "contentDigest",
        "detection",
        "path",
        "proofs",
        "replacement",
        "subject",
      ]) ||
      raw.detection?.detectorSha !== detectorSourceSha
    ) {
      throw new Error("FLEET_MIGRATION_COLLECTOR_CANDIDATE_BINDING_MISMATCH");
    }
    const key = detectionKey(raw);
    const scanned = scannedByKey.get(key);
    if (scanned === undefined || seen.has(key)) {
      throw new Error("FLEET_MIGRATION_COLLECTOR_CANDIDATE_BINDING_MISMATCH");
    }
    seen.add(key);
    const candidate = {
      path: raw.path,
      gitEntry: structuredClone(scanned.gitEntry),
      contentDigest: raw.contentDigest,
      subject: structuredClone(raw.subject),
      detection: structuredClone(raw.detection),
      replacement: structuredClone(raw.replacement),
      proofs: structuredClone(raw.proofs),
    };
    assertPublicSurface(candidate);
    validateEvidenceDigests(candidate.proofs);
    validateCandidateSourceReadback(
      candidate,
      scanned,
      repository,
      head,
      tree,
    );
    result.push(candidate);
  }
  if (seen.size !== scannedByKey.size) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_CANDIDATE_BINDING_MISMATCH");
  }
  return result.sort(
    (left, right) =>
      compareUtf8(left.path, right.path) ||
      compareUtf8(left.detection.type, right.detection.type),
  );
}

function stableBackofficeVector(value, candidates) {
  return {
    classification: value.classification,
    classificationDecisionRevision: value.classificationDecisionRevision,
    classificationDecisionId: value.classificationDecisionId,
    app: structuredClone(value.app),
    activeConfig: structuredClone(value.activeConfig),
    signedSnapshot: structuredClone(value.signedSnapshot),
    platformFleetBinding: structuredClone(value.platformFleetBinding),
    providerObservations: value.providerObservations
      .map(
        ({
          evidenceDigest: _evidenceDigest,
          observationId: _observationId,
          ...item
        }) => item,
      )
      .sort((left, right) => compareUtf8(left.digest, right.digest)),
    credentialBindings: value.credentialBindings
      .map(
        ({
          evidenceDigest: _evidenceDigest,
          observationId: _observationId,
          ...item
        }) => item,
      )
      .sort((left, right) =>
        compareUtf8(left.logicalCredentialId, right.logicalCredentialId),
      ),
    candidates: candidates.map((candidate) => ({
      path: candidate.path,
      contentDigest: candidate.contentDigest,
      detection: structuredClone(candidate.detection),
      subject: structuredClone(candidate.subject),
      replacement: structuredClone(candidate.replacement),
      proofEvidenceDigests: collectEvidenceDigests(candidate.proofs),
    })),
  };
}

function collectEvidenceDigests(value) {
  const digests = [];
  const visit = (item) => {
    if (Array.isArray(item)) {
      for (const nested of item) visit(nested);
      return;
    }
    if (item === null || typeof item !== "object") return;
    if (DIGEST_PATTERN.test(item.evidenceDigest ?? "")) {
      digests.push(item.evidenceDigest);
    }
    for (const nested of Object.values(item)) visit(nested);
  };
  visit(value);
  return [...new Set(digests)].sort(compareUtf8);
}

async function collectRepository(configuration, pageRepository) {
  const headRequest = {
    contract: HEAD_CONTRACT,
    repositoryId: pageRepository.id,
    fullName: pageRepository.fullName,
    defaultRef: `refs/heads/${pageRepository.defaultBranch}`,
  };
  const firstHead = validateHead(
    await trustedReadback(
      configuration.readRepositoryHead,
      headRequest,
      "FLEET_MIGRATION_COLLECTOR_SOURCE_READBACK",
    ),
    pageRepository,
  );
  const tree = validateTree(
    await trustedReadback(
      configuration.readRepositoryTree,
      {
        contract: TREE_CONTRACT,
        repositoryId: pageRepository.id,
        fullName: pageRepository.fullName,
        sourceSha: firstHead.sourceSha,
        treeSha: firstHead.treeSha,
        recursive: true,
      },
      "FLEET_MIGRATION_COLLECTOR_TREE_READBACK",
    ),
    pageRepository,
    firstHead,
  );
  const canonicalEntriesDigest = sha256(
    canonicalJson({
      contract: "seorilabs-fleet-migration-tree-entries-v1",
      repositoryId: pageRepository.id,
      sourceSha: firstHead.sourceSha,
      treeSha: tree.treeSha,
      entries: tree.entries,
    }),
  );
  const allBlobEntries = tree.entries.filter(({ type }) => type === "BLOB");
  const scannedBlobEntries = allBlobEntries.filter((entry) =>
    isDetectorRelevantBlob(entry, pageRepository),
  );
  const scannedBytes = scannedBlobEntries.reduce(
    (total, entry) => total + entry.size,
    0,
  );
  if (
    scannedBlobEntries.length > MAX_SCANNED_BLOBS_PER_REPOSITORY ||
    !Number.isSafeInteger(scannedBytes) ||
    scannedBytes > MAX_SCANNED_BYTES_PER_REPOSITORY
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_SCAN_BUDGET_EXCEEDED");
  }
  const blobRecords = [];
  const blobObservedTimes = [];
  const scannedCandidates = [];
  for (const entry of scannedBlobEntries) {
    if (entry.size > MAX_BLOB_BYTES) {
      throw new Error("FLEET_MIGRATION_COLLECTOR_RELEVANT_BLOB_TOO_LARGE");
    }
    const rawBlob = await trustedReadback(
      configuration.readBlob,
      {
        contract: BLOB_CONTRACT,
        repositoryId: pageRepository.id,
        fullName: pageRepository.fullName,
        sourceSha: firstHead.sourceSha,
        treeSha: tree.treeSha,
        path: entry.path,
        objectSha: entry.objectSha,
      },
      "FLEET_MIGRATION_COLLECTOR_BLOB_READBACK",
    );
    const decoded = validateBlob(
      rawBlob,
      pageRepository,
      firstHead,
      tree,
      entry,
    );
    try {
      const scanned = await scanBlob(
        entry,
        rawBlob,
        decoded,
        configuration.detectorSourceSha,
        pageRepository,
        firstHead,
        configuration,
      );
      blobRecords.push(scanned.publicRecord);
      blobObservedTimes.push(rawBlob.observedAt);
      scannedCandidates.push(...scanned.detections);
    } finally {
      decoded.fill(0);
    }
  }
  if (
    new Set(blobRecords.map(({ readbackId }) => readbackId)).size !==
    blobRecords.length
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_BLOB_READBACK_DUPLICATE");
  }
  const blobInventoryDigest = sha256(
    canonicalJson({
      contract: "seorilabs-fleet-migration-blob-inventory-v1",
      repositoryId: pageRepository.id,
      sourceSha: firstHead.sourceSha,
      treeSha: tree.treeSha,
      canonicalEntriesDigest,
      treeEntryCount: tree.entries.length,
      treeBlobCount: allBlobEntries.length,
      scannedBlobCount: scannedBlobEntries.length,
      blobs: blobRecords,
    }),
  );
  const backofficeRaw = await trustedReadback(
    configuration.readBackofficePublicEvidence,
    {
      contract: BACKOFFICE_CONTRACT,
      organizationId: configuration.organizationId,
      repositoryId: pageRepository.id,
      fullName: pageRepository.fullName,
      sourceRef: firstHead.defaultRef,
      sourceSha: firstHead.sourceSha,
      treeSha: tree.treeSha,
      blobInventoryDigest,
      detections: structuredClone(scannedCandidates),
    },
    "FLEET_MIGRATION_COLLECTOR_BACKOFFICE_READBACK",
  );
  if (!exactKeys(backofficeRaw, ["candidates", "publicEvidence"])) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_BACKOFFICE_READBACK_MISMATCH");
  }
  const publicEvidence = validatePublicEvidence(
    backofficeRaw.publicEvidence,
    pageRepository,
    firstHead,
    configuration.organizationId,
  );
  const candidates = bindCandidates(
    backofficeRaw.candidates,
    scannedCandidates,
    pageRepository,
    firstHead,
    tree,
    configuration.detectorSourceSha,
  );
  const finalHead = validateHead(
    await trustedReadback(
      configuration.readRepositoryHead,
      headRequest,
      "FLEET_MIGRATION_COLLECTOR_SOURCE_READBACK",
    ),
    pageRepository,
  );
  if (
    finalHead.sourceSha !== firstHead.sourceSha ||
    finalHead.treeSha !== firstHead.treeSha ||
    finalHead.readbackId === firstHead.readbackId
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_SOURCE_DRIFT");
  }
  const firstHeadObservedAt = Date.parse(firstHead.observedAt);
  const treeObservedAt = Date.parse(tree.observedAt);
  const finalHeadObservedAt = Date.parse(finalHead.observedAt);
  const backofficeObservedAt = Date.parse(publicEvidence.observedAt);
  const blobObservedAt = blobObservedTimes.map((value) => Date.parse(value));
  if (
    firstHeadObservedAt > treeObservedAt ||
    treeObservedAt > backofficeObservedAt ||
    blobObservedAt.some((value) => value < treeObservedAt) ||
    blobObservedAt.some((value) => value > backofficeObservedAt) ||
    backofficeObservedAt > finalHeadObservedAt
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_READBACK_ORDER_INVALID");
  }
  const treeReadback = {
    provider: "GITHUB_GIT_TREE",
    readbackId: tree.readbackId,
    observedAt: tree.observedAt,
    repositoryId: pageRepository.id,
    sourceSha: firstHead.sourceSha,
    treeSha: tree.treeSha,
    recursive: true,
    truncated: false,
    entryCount: tree.entries.length,
    blobCount: allBlobEntries.length,
    scannedBlobCount: scannedBlobEntries.length,
    canonicalEntriesDigest,
    evidenceDigest: "sha256:" + "0".repeat(64),
  };
  treeReadback.evidenceDigest = computeFleetEvidenceDigest(treeReadback);
  const observation = {
    id: `fleet-discovery-${pageRepository.id}-${firstHead.sourceSha.slice(0, 16)}`,
    observedAt: finalHead.observedAt,
    repositoryId: pageRepository.id,
    sourceRef: firstHead.defaultRef,
    sourceSha: firstHead.sourceSha,
    treeSha: tree.treeSha,
    treeReadback,
    findingsDigest: "sha256:" + "0".repeat(64),
  };
  observation.findingsDigest = computeFleetFindingsDigest({
    repositoryId: observation.repositoryId,
    sourceRef: observation.sourceRef,
    sourceSha: observation.sourceSha,
    treeSha: observation.treeSha,
    treeReadback,
    candidates,
  });
  const repositoryObservation = {
    repository: {
      id: pageRepository.id,
      fullName: pageRepository.fullName,
      defaultRef: firstHead.defaultRef,
      sourceSha: firstHead.sourceSha,
      archived: false,
      fork: pageRepository.fork,
      classification: publicEvidence.classification,
      classificationDecisionRevision:
        publicEvidence.classificationDecisionRevision,
      classificationDecisionId: publicEvidence.classificationDecisionId,
    },
    observation,
    candidates,
  };
  const repositoryEvidence = {
    repositoryId: pageRepository.id,
    fullName: pageRepository.fullName,
    sourceRef: firstHead.defaultRef,
    sourceSha: firstHead.sourceSha,
    treeSha: tree.treeSha,
    sourceReadback: {
      firstReadbackId: firstHead.readbackId,
      firstObservedAt: firstHead.observedAt,
      finalReadbackId: finalHead.readbackId,
      finalObservedAt: finalHead.observedAt,
      sourceRef: firstHead.defaultRef,
      sourceSha: firstHead.sourceSha,
      treeSha: tree.treeSha,
      evidenceDigest: "sha256:" + "0".repeat(64),
    },
    treeReadbackId: tree.readbackId,
    blobReadbacks: structuredClone(blobRecords),
    blobInventoryDigest,
    backoffice: structuredClone(publicEvidence),
    evidenceDigest: "sha256:" + "0".repeat(64),
  };
  repositoryEvidence.sourceReadback.evidenceDigest =
    computeFleetEvidenceDigest(repositoryEvidence.sourceReadback);
  repositoryEvidence.evidenceDigest =
    computeFleetEvidenceDigest(repositoryEvidence);
  return deepFreeze({
    repositoryObservation,
    repositoryEvidence,
    providerVector: {
      repositoryId: pageRepository.id,
      fullName: pageRepository.fullName,
      sourceRef: firstHead.defaultRef,
      sourceSha: firstHead.sourceSha,
      treeSha: tree.treeSha,
      canonicalEntriesDigest,
      blobInventoryDigest,
      backoffice: stableBackofficeVector(publicEvidence, candidates),
    },
    observedTimes: [
      firstHead.observedAt,
      tree.observedAt,
      ...blobObservedTimes,
      finalHead.observedAt,
      publicEvidence.observedAt,
    ],
  });
}

function expectedCounts(repositories) {
  const counts = {
    activeRepositories: repositories.length,
    legacyOperationJson: 0,
    workflowSecretsInherit: 0,
    workflowFloatingRef: 0,
  };
  for (const { candidates } of repositories) {
    for (const { detection } of candidates) {
      if (detection.type === "LEGACY_OPERATION_JSON") {
        counts.legacyOperationJson += 1;
      } else if (detection.type === "WORKFLOW_SECRETS_INHERIT") {
        counts.workflowSecretsInherit += 1;
      } else if (detection.type === "WORKFLOW_FLOATING_REF") {
        counts.workflowFloatingRef += 1;
      }
    }
  }
  return counts;
}

function validateObservationTimes(values, capturedAtMs) {
  for (const value of values) {
    const observedAt = Date.parse(value);
    if (!Number.isFinite(observedAt) || observedAt > capturedAtMs) {
      throw new Error("FLEET_MIGRATION_COLLECTOR_OBSERVATION_TIME_INVALID");
    }
  }
}

function unsignedCollectionDigest(collection) {
  const { collectionDigest: _collectionDigest, ...unsigned } = collection;
  return sha256(canonicalJson(unsigned));
}

function validateCollectionEnvelope(collection) {
  if (
    !exactKeys(collection, [
      "authoritative",
      "collectionDigest",
      "contract",
      "inventory",
      "inventoryDigest",
      "mode",
      "occurrence",
      "readyForPlanning",
      "state",
    ]) ||
    collection.contract !== COLLECTION_CONTRACT ||
    !MODES.includes(collection.mode) ||
    collection.state !==
      (collection.mode === "FIXTURE"
        ? "FIXTURE_COMPLETE"
        : "SHADOW_COMPLETE") ||
    collection.authoritative !== false ||
    collection.readyForPlanning !== false ||
    !exactKeys(collection.occurrence, [
      "occurrenceId",
      "providerVectorDigest",
      "runId",
    ]) ||
    !EVIDENCE_ID_PATTERN.test(collection.occurrence.occurrenceId ?? "") ||
    !EVIDENCE_ID_PATTERN.test(collection.occurrence.runId ?? "") ||
    !DIGEST_PATTERN.test(collection.occurrence.providerVectorDigest ?? "") ||
    collection.inventory?.attestation !== null ||
    collection.inventory?.collectionEvidence?.mode !== collection.mode ||
    collection.inventory?.collectionEvidence
      ?.issuanceGitHubAppCapability !== null ||
    validateFleetGitHubAppCapability(
      collection.inventory?.collectionEvidence?.githubAppCapability,
    ).ok !== true ||
    collection.inventory?.collectionEvidence?.providerVectorDigest !==
      collection.occurrence.providerVectorDigest
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTION_INVALID");
  }
  const inventoryValidation = validateFleetMigrationInventory(
    collection.inventory,
  );
  validateEvidenceDigests(collection.inventory.collectionEvidence);
  const inventoryDigest = computeFleetMigrationInventoryDigest(
    collection.inventory,
  );
  if (
    !inventoryValidation.ok ||
    inventoryDigest !== collection.inventoryDigest ||
    unsignedCollectionDigest(collection) !== collection.collectionDigest
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTION_INVALID");
  }
  assertPublicSurface(collection);
  return deepFreeze(collection);
}

function validateOccurrenceClaim(value, providerVectorDigest, requestedRunId) {
  if (
    !exactKeys(value, [
      "occurrenceId",
      "providerVectorDigest",
      "runId",
      "state",
    ]) ||
    !["CLAIMED", "RESUME", "COMPLETED"].includes(value.state) ||
    !EVIDENCE_ID_PATTERN.test(value.occurrenceId ?? "") ||
    !EVIDENCE_ID_PATTERN.test(value.runId ?? "") ||
    value.providerVectorDigest !== providerVectorDigest ||
    (value.state === "CLAIMED" && value.runId !== requestedRunId)
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTION_OCCURRENCE_CLAIM_INVALID");
  }
  return deepFreeze(value);
}

async function readDurableCollection(configuration, claim) {
  const stored = await trustedReadback(
    configuration.readOccurrence,
    {
      occurrenceId: claim.occurrenceId,
      runId: claim.runId,
      providerVectorDigest: claim.providerVectorDigest,
    },
    "FLEET_MIGRATION_COLLECTION_OCCURRENCE_READBACK",
  );
  const collection = validateCollectionEnvelope(stored);
  if (
    collection.occurrence.occurrenceId !== claim.occurrenceId ||
    collection.occurrence.runId !== claim.runId ||
    collection.occurrence.providerVectorDigest !== claim.providerVectorDigest
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTION_OCCURRENCE_READBACK_MISMATCH");
  }
  return collection;
}

function validateConfiguration(configuration) {
  const requiredKeys = [
    "claimOccurrence",
    "clock",
    "completeOccurrence",
    "detectorRepositoryId",
    "detectorSourceSha",
    "installationId",
    "organizationId",
    "pageSize",
    "readBackofficePublicEvidence",
    "readBlob",
    "readGitHubAppCapability",
    "readInstallationRepositoriesPage",
    "readOccurrence",
    "readRepositoryHead",
    "readRepositoryTree",
    "validateLegacyDocument",
  ];
  if (
    !exactKeys(configuration, requiredKeys) ||
    configuration.organizationId !== ORGANIZATION_ID ||
    configuration.installationId !== GITHUB_APP_INSTALLATION_ID ||
    !NUMERIC_ID_PATTERN.test(configuration.detectorRepositoryId ?? "") ||
    !SHA_PATTERN.test(configuration.detectorSourceSha ?? "") ||
    !Number.isSafeInteger(configuration.pageSize) ||
    configuration.pageSize < 1 ||
    configuration.pageSize > 100 ||
    !requiredKeys
      .filter(
        (key) =>
          ![
            "detectorRepositoryId",
            "detectorSourceSha",
            "installationId",
            "organizationId",
            "pageSize",
          ].includes(key),
      )
      .every((key) => typeof configuration[key] === "function")
  ) {
    throw new Error("FLEET_MIGRATION_COLLECTOR_CONFIGURATION_INVALID");
  }
}

export function createFleetMigrationReadOnlyCollector(configuration = {}) {
  validateConfiguration(configuration);
  const trustedConfiguration = Object.freeze({ ...configuration });
  return Object.freeze({
    async collect(input = {}) {
      if (
        !exactKeys(input, [
          "deliveryId",
          "inventoryId",
          "mode",
          "requestedRunId",
        ]) ||
        !EVIDENCE_ID_PATTERN.test(input.deliveryId ?? "") ||
        !EVIDENCE_ID_PATTERN.test(input.inventoryId ?? "") ||
        !EVIDENCE_ID_PATTERN.test(input.requestedRunId ?? "") ||
        !MODES.includes(input.mode)
      ) {
        throw new Error("FLEET_MIGRATION_COLLECTION_REQUEST_INVALID");
      }
      const githubAppCapability = validateGitHubAppCapability(
        await trustedReadback(
          trustedConfiguration.readGitHubAppCapability,
          {
            contract: CAPABILITY_CONTRACT,
            organizationId: trustedConfiguration.organizationId,
            installationId: trustedConfiguration.installationId,
          },
          "FLEET_MIGRATION_GITHUB_APP_CAPABILITY_READBACK",
        ),
        trustedConfiguration,
      );
      const pageCollection = await collectRepositoryPages(
        trustedConfiguration,
      );
      const collectedRepositories = [];
      for (const repository of pageCollection.repositories) {
        collectedRepositories.push(
          await collectRepository(trustedConfiguration, repository),
        );
      }
      collectedRepositories.sort((left, right) => {
        const leftId = BigInt(left.repositoryObservation.repository.id);
        const rightId = BigInt(right.repositoryObservation.repository.id);
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
      });
      const capturedAtMs = trustedTime(trustedConfiguration.clock);
      validateObservationTimes(
        [
          githubAppCapability.observedAt,
          ...pageCollection.observedTimes,
          ...collectedRepositories.flatMap(({ observedTimes }) => observedTimes),
        ],
        capturedAtMs,
      );
      const repositories = collectedRepositories.map(
        ({ repositoryObservation }) =>
          structuredClone(repositoryObservation),
      );
      const providerVectorDigest = sha256(
        canonicalJson({
          contract: "seorilabs-fleet-migration-provider-vector-v1",
          mode: input.mode,
          organizationId: trustedConfiguration.organizationId,
          installationId: trustedConfiguration.installationId,
          detectorRepositoryId: trustedConfiguration.detectorRepositoryId,
          detectorSourceSha: trustedConfiguration.detectorSourceSha,
          githubAppCapabilityDigest: githubAppCapability.evidenceDigest,
          query: {
            organizationLogin: ORGANIZATION_LOGIN,
            archived: false,
            pageSize: trustedConfiguration.pageSize,
          },
          repositories: collectedRepositories.map(({ providerVector }) =>
            structuredClone(providerVector),
          ),
        }),
      );
      const collectionEvidence = {
        contract: COLLECTION_EVIDENCE_CONTRACT,
        mode: input.mode,
        githubAppCapability: structuredClone(githubAppCapability),
        issuanceGitHubAppCapability: null,
        providerVectorDigest,
        repositoryEvidence: collectedRepositories.map(
          ({ repositoryEvidence }) => structuredClone(repositoryEvidence),
        ),
        evidenceDigest: "sha256:" + "0".repeat(64),
      };
      collectionEvidence.evidenceDigest =
        computeFleetEvidenceDigest(collectionEvidence);
      const coverage = {
        provider: "GITHUB_APP_INSTALLATION_REPOSITORY_READBACK",
        installationId: trustedConfiguration.installationId,
        query: {
          organizationLogin: ORGANIZATION_LOGIN,
          archived: false,
          pageSize: trustedConfiguration.pageSize,
        },
        readbackId: pageCollection.firstPage.readbackId,
        snapshotId: pageCollection.firstPage.snapshotId,
        observedAt: pageCollection.firstPage.observedAt,
        complete: true,
        nextCursor: null,
        providerTotalCount: pageCollection.repositories.length,
        activeRepositoryCount: pageCollection.repositories.length,
        repositoriesDigest: computeFleetRepositoryReadbackDigest({
          organizationId: trustedConfiguration.organizationId,
          repositories: repositories.map(({ repository }) => repository),
        }),
        pages: structuredClone(pageCollection.pages),
      };
      const inventory = {
        schemaVersion: 1,
        inventoryId: input.inventoryId,
        capturedAt: new Date(capturedAtMs).toISOString(),
        expiresAt: new Date(capturedAtMs + MAX_INVENTORY_TTL_MS).toISOString(),
        organization: {
          id: trustedConfiguration.organizationId,
          login: ORGANIZATION_LOGIN,
        },
        detector: {
          repositoryId: trustedConfiguration.detectorRepositoryId,
          fullName: "seorilabs/.github",
          sourceRef: "refs/heads/main",
          sourceSha: trustedConfiguration.detectorSourceSha,
          contract: "fleet-migration-v1",
        },
        coverage,
        expectedCounts: expectedCounts(repositories),
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
        collectionEvidence,
        repositories,
        attestation: null,
      };
      const inventoryValidation = validateFleetMigrationInventory(inventory);
      if (!inventoryValidation.ok) {
        throw new Error(
          `FLEET_MIGRATION_COLLECTED_INVENTORY_INVALID:${inventoryValidation.diagnostics.join(",")}`,
        );
      }
      const inventoryDigest = computeFleetMigrationInventoryDigest(inventory);
      const claim = validateOccurrenceClaim(
        await trustedReadback(
          trustedConfiguration.claimOccurrence,
          {
            contract: COLLECTION_CONTRACT,
            deliveryId: input.deliveryId,
            requestedRunId: input.requestedRunId,
            providerVectorDigest,
            inventoryDigest,
          },
          "FLEET_MIGRATION_COLLECTION_OCCURRENCE_CLAIM",
        ),
        providerVectorDigest,
        input.requestedRunId,
      );
      if (claim.state === "COMPLETED") {
        return readDurableCollection(trustedConfiguration, claim);
      }
      const collection = {
        contract: COLLECTION_CONTRACT,
        state:
          input.mode === "FIXTURE" ? "FIXTURE_COMPLETE" : "SHADOW_COMPLETE",
        authoritative: false,
        readyForPlanning: false,
        mode: input.mode,
        occurrence: {
          occurrenceId: claim.occurrenceId,
          runId: claim.runId,
          providerVectorDigest,
        },
        inventoryDigest,
        inventory,
        collectionDigest: "sha256:" + "0".repeat(64),
      };
      collection.collectionDigest = unsignedCollectionDigest(collection);
      validateCollectionEnvelope(collection);
      let completion;
      try {
        completion = await trustedConfiguration.completeOccurrence(
          deepFreeze({
            occurrenceId: claim.occurrenceId,
            runId: claim.runId,
            deliveryId: input.deliveryId,
            providerVectorDigest,
            inventoryDigest,
            collectionDigest: collection.collectionDigest,
            collection: structuredClone(collection),
          }),
        );
      } catch {
        throw new Error("FLEET_MIGRATION_COLLECTION_COMPLETION_UNKNOWN");
      }
      if (
        !exactKeys(completion, [
          "collectionDigest",
          "occurrenceId",
          "providerVectorDigest",
          "runId",
          "state",
        ]) ||
        completion.state !== "COMPLETED" ||
        completion.occurrenceId !== claim.occurrenceId ||
        completion.runId !== claim.runId ||
        completion.providerVectorDigest !== providerVectorDigest ||
        completion.collectionDigest !== collection.collectionDigest
      ) {
        throw new Error("FLEET_MIGRATION_COLLECTION_COMPLETION_INVALID");
      }
      const persisted = await readDurableCollection(
        trustedConfiguration,
        claim,
      );
      if (persisted.collectionDigest !== collection.collectionDigest) {
        throw new Error("FLEET_MIGRATION_COLLECTION_COMPLETION_MISMATCH");
      }
      return persisted;
    },
  });
}

export function validateFleetMigrationCollection(collection) {
  try {
    const snapshot = structuredClone(collection);
    validateCollectionEnvelope(snapshot);
    return deepFreeze({ ok: true, diagnostics: [] });
  } catch (error) {
    return deepFreeze({
      ok: false,
      diagnostics: [String(error?.message ?? "FLEET_MIGRATION_COLLECTION_INVALID")],
    });
  }
}

export const fleetMigrationCollectorContract = deepFreeze({
  contract: COLLECTION_CONTRACT,
  organizationLogin: ORGANIZATION_LOGIN,
  organizationId: ORGANIZATION_ID,
  githubApp: Object.freeze({
    appId: GITHUB_APP_ID,
    slug: GITHUB_APP_SLUG,
    installationId: GITHUB_APP_INSTALLATION_ID,
    webhookUrl: GITHUB_APP_WEBHOOK_URL,
    requiredPermissions: REQUIRED_GITHUB_APP_PERMISSIONS,
    requiredEvents: REQUIRED_GITHUB_APP_EVENTS,
  }),
  authoritativeIssuanceRequiresSeparateIssuer: true,
  modes: MODES,
  maximumInventoryTtlSeconds: MAX_INVENTORY_TTL_MS / 1000,
  maximumRelevantBlobBytes: MAX_BLOB_BYTES,
  maximumScannedBlobsPerRepository: MAX_SCANNED_BLOBS_PER_REPOSITORY,
  maximumScannedBytesPerRepository: MAX_SCANNED_BYTES_PER_REPOSITORY,
  sourceAccess: "READ_ONLY_GITHUB_APP",
  durableOccurrenceRequired: true,
  output: Object.freeze({
    authoritative: false,
    readyForPlanning: false,
    secretFree: true,
  }),
});
