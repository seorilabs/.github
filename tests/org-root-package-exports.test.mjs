import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createFleetWebhookHandler, validateFleetBootstrapPlan } from "seorilabs-org-contracts/repo-contract/bootstrap";
import { createGitHubAppTrustedAdapter, createTrustedFleetExecutor } from "seorilabs-org-contracts/repo-contract/trusted-executor";
import {
  githubProtectionPlanReadback,
  githubProtectionReadback,
} from "seorilabs-org-contracts/repo-contract/github-settings-readback";

import {
  fleetMigrationContract,
  validateFleetMigrationInventory,
} from "seorilabs-org-contracts/repo-contract/fleet-migration";
import {
  fleetMigrationCollectorContract,
  validateFleetMigrationCollection,
} from "seorilabs-org-contracts/repo-contract/fleet-migration-collector";
import { validateFleetMigrationLegacyDocument } from "seorilabs-org-contracts/repo-contract/fleet-migration-legacy-validator";
import {
  createTrustedFleetCleanupExecutor,
  trustedFleetCleanupExecutorContract,
} from "seorilabs-org-contracts/repo-contract/trusted-cleanup-executor";
import {
  createFleetMigrationInventoryIssuer,
  fleetMigrationInventoryIssuerContract,
} from "seorilabs-org-contracts/repo-contract/trusted-inventory-issuer";

test("조직 계약 root package는 Backoffice가 사용하는 안정 subpath만 export한다", () => {
  assert.equal(typeof createFleetWebhookHandler, "function");
  assert.equal(typeof validateFleetBootstrapPlan, "function");
  assert.equal(typeof createGitHubAppTrustedAdapter, "function");
  assert.equal(typeof createTrustedFleetExecutor, "function");
  assert.equal(fleetMigrationContract.schemaVersion, 1);
  assert.equal(
    fleetMigrationCollectorContract.contract,
    "seorilabs-fleet-migration-collection-v1",
  );
  assert.equal(typeof validateFleetMigrationInventory, "function");
  assert.equal(typeof validateFleetMigrationCollection, "function");
  assert.equal(typeof validateFleetMigrationLegacyDocument, "function");
  assert.equal(typeof createTrustedFleetCleanupExecutor, "function");
  assert.equal(typeof createFleetMigrationInventoryIssuer, "function");
  assert.equal(typeof trustedFleetCleanupExecutorContract, "object");
  assert.equal(typeof fleetMigrationInventoryIssuerContract, "object");
});

test("Backoffice가 CLI와 같은 읽기 전용 보호 판정기를 배포 패키지에서 재사용한다", () => {
  const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const entry = metadata.exports["./repo-contract/github-settings-readback"];
  assert.ok(metadata.files.includes(entry.slice(2)), "export된 module이 실제 package에 포함돼야 한다");
  assert.equal(githubProtectionPlanReadback({ id: 283115031, login: "seorilabs", plan: { name: "team" } },
    { organization: "seorilabs", organizationId: "283115031" }).protection, "SUPPORTED");
  const observation = githubProtectionReadback(
    { branch: "main", requiredStatusCheck: "Org Contract / Org Contract" },
    { repositoryId: "1250442131", fullName: "seorilabs/happy-farm" },
    { repository: { id: 1250442131, full_name: "seorilabs/happy-farm", default_branch: "main" },
      branchProtection: null, activeRules: [] }, "2026-09-02T02:30:00.000Z");
  assert.equal(observation.state, "OBSERVED");
  assert.equal(observation.requiredStatusCheckPresent, false);
  assert.match(observation.snapshotDigest, /^sha256:[a-f0-9]{64}$/u);
});
