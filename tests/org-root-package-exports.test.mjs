import assert from "node:assert/strict";
import test from "node:test";

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
