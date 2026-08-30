import assert from "node:assert/strict";
import test from "node:test";

import {
  fleetMigrationLegacyValidatorRevision,
  validateFleetMigrationLegacyDocument,
} from "../packages/repo-contract/src/fleet-migration-legacy-validator.mjs";
import {
  digest,
  legacyDocumentForPath,
  sha,
} from "./helpers/fleet-migration-collector-fixtures.mjs";

const DEFINITIONS = Object.freeze([
  {
    contract: "ORG_CONTRACT_APP",
    schemaId: "https://seorilabs.github.io/contracts/v1/app.schema.json",
    path: ".seorilabs/app.yaml",
  },
  {
    contract: "GOOGLE_PLAY",
    schemaId:
      "https://seorilabs.github.io/contracts/v1/markets/google-play.schema.json",
    path: "play-store/google-play.config.json",
  },
  {
    contract: "APP_STORE",
    schemaId:
      "https://seorilabs.github.io/contracts/v1/markets/app-store.schema.json",
    path: "app-store/app-store.config.json",
  },
  {
    contract: "APPS_IN_TOSS",
    schemaId:
      "https://seorilabs.github.io/contracts/v1/markets/apps-in-toss.schema.json",
    path: "apps-in-toss/apps-in-toss.config.json",
  },
  {
    contract: "MARKET_LAUNCH_STATE",
    schemaId:
      "https://seorilabs.com/contracts/legacy/market-launch-state.v1.schema.json",
    path: "release/market-launch-state.json",
  },
  {
    contract: "PLATFORM_REGISTRY_APP",
    schemaId:
      "https://seorilabs.com/contracts/legacy/platform-registry-app.v1.schema.json",
    path: "registry/apps/registry-01.json",
    fullName: "seorilabs/platform",
  },
  {
    contract: "BACKOFFICE_OPERATIONS",
    schemaId:
      "https://seorilabs.com/contracts/legacy/backoffice-operations.v1.schema.json",
    path: ".seorilabs/backoffice.json",
  },
]);

function requestFor(definition, document = legacyDocumentForPath(definition.path)) {
  return {
    contract: definition.contract,
    schemaId: definition.schemaId,
    repositoryId: "1000001",
    fullName: definition.fullName ?? "seorilabs/app-01",
    sourceSha: sha("source:1"),
    path: definition.path,
    objectSha: "a".repeat(40),
    contentDigest: digest(document),
    document,
  };
}

test("공용 legacy validator는 7개 exact contract/schema/path만 MATCH한다", () => {
  assert.match(
    fleetMigrationLegacyValidatorRevision,
    /^fleet-legacy-schema-validator-v1-[0-9a-f]{16}$/u,
  );
  for (const definition of DEFINITIONS) {
    const request = requestFor(definition);
    assert.deepEqual(validateFleetMigrationLegacyDocument(request), {
      state: "MATCH",
      contract: definition.contract,
      schemaId: definition.schemaId,
      contentDigest: request.contentDigest,
      validatorRevision: fleetMigrationLegacyValidatorRevision,
    });
  }
});

test("세 custom legacy schema는 최상위와 중첩 unknown field를 거부한다", () => {
  const mutations = [
    [
      "MARKET_LAUNCH_STATE",
      (document) => {
        document.commonGates.candidate.untrusted = true;
      },
    ],
    [
      "PLATFORM_REGISTRY_APP",
      (document) => {
        document.ga4.untrusted = true;
      },
    ],
    [
      "BACKOFFICE_OPERATIONS",
      (document) => {
        document.tools = [
          {
            id: "status",
            section: "operations",
            title: "상태",
            description: "상태를 조회합니다.",
            untrusted: true,
          },
        ];
      },
    ],
  ];
  for (const [contract, mutate] of mutations) {
    const definition = DEFINITIONS.find((item) => item.contract === contract);
    const document = legacyDocumentForPath(definition.path);
    mutate(document);
    assert.throws(
      () => validateFleetMigrationLegacyDocument(requestFor(definition, document)),
      /FLEET_MIGRATION_LEGACY_SCHEMA_VALIDATION_FAILED/u,
      contract,
    );
  }
});

test("contract/schema/path와 Platform repository/filename identity substitution을 거부한다", () => {
  const market = DEFINITIONS.find(
    ({ contract }) => contract === "MARKET_LAUNCH_STATE",
  );
  for (const mutate of [
    (request) => {
      request.schemaId =
        "https://seorilabs.com/contracts/legacy/platform-registry-app.v1.schema.json";
    },
    (request) => {
      request.path = ".seorilabs/backoffice.json";
    },
    (request) => {
      request.fullName = "seorilabs/other-app";
    },
  ]) {
    const request = requestFor(market);
    mutate(request);
    assert.throws(
      () => validateFleetMigrationLegacyDocument(request),
      /FLEET_MIGRATION_LEGACY_(?:VALIDATION_REQUEST_INVALID|SCHEMA_VALIDATION_FAILED)/u,
    );
  }

  const platform = DEFINITIONS.find(
    ({ contract }) => contract === "PLATFORM_REGISTRY_APP",
  );
  for (const mutate of [
    (request) => {
      request.fullName = "seorilabs/app-01";
    },
    (request) => {
      request.path = "registry/apps/lookalike.json";
    },
  ]) {
    const request = requestFor(platform);
    mutate(request);
    assert.throws(
      () => validateFleetMigrationLegacyDocument(request),
      /FLEET_MIGRATION_LEGACY_VALIDATION_REQUEST_INVALID/u,
    );
  }
});
