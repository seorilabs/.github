import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("세 custom legacy schema의 unknown field는 SCHEMA_MISMATCH로 남는다", () => {
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
    // 스키마 위반은 관측 결과로 남긴다. throw하면 아직 이관하지 않은 저장소가 하나만
    // 있어도 inventory 전체가 불가능해진다.
    const request = requestFor(definition, document);
    assert.deepEqual(validateFleetMigrationLegacyDocument(request), {
      state: "SCHEMA_MISMATCH",
      contract: definition.contract,
      schemaId: definition.schemaId,
      contentDigest: request.contentDigest,
      validatorRevision: fleetMigrationLegacyValidatorRevision,
    }, contract);
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

test("목표 스키마와 다른 legacy 문서도 계약·경로 식별은 그대로 돌려준다", () => {
  // 이관 전 저장소의 실제 파일은 목표 스키마와 다르다. 그래도 어떤 계약의 어떤 문서인지는
  // 확정돼야 inventory가 "이 저장소에 이 legacy 문서가 있다"를 기록할 수 있다.
  const definition = DEFINITIONS.find(({ contract }) => contract === "APP_STORE");
  const request = requestFor(definition, { unmigrated: true });
  const result = validateFleetMigrationLegacyDocument(request);
  assert.equal(result.state, "SCHEMA_MISMATCH");
  assert.equal(result.contract, "APP_STORE");
  assert.equal(result.schemaId, definition.schemaId);
  assert.equal(result.contentDigest, request.contentDigest);
});

test("저장소 신원 substitution은 스키마와 무관하게 계속 거부한다", () => {
  // app.repo 불일치는 형태 문제가 아니라 귀속 문제다. 여기까지 완화하면 한 저장소의
  // 문서를 다른 저장소 것으로 제출할 수 있게 된다.
  const definition = DEFINITIONS.find(({ contract }) => contract === "MARKET_LAUNCH_STATE");
  const request = requestFor(definition);
  request.fullName = "seorilabs/other-app";
  assert.throws(
    () => validateFleetMigrationLegacyDocument(request),
    /FLEET_MIGRATION_LEGACY_SCHEMA_VALIDATION_FAILED/u,
  );
});

test("SCHEMA_MISMATCH detection은 계약이 아는 값만 쓴다", () => {
  // collector가 만드는 matchedBy 값은 inventory 계약의 enum에 있어야 한다. 없으면
  // 수집은 통과하고 inventory 검증에서 뒤늦게 깨진다.
  const schema = JSON.parse(
    readFileSync(new URL("../contracts/fleet-migration-inventory.schema.json", import.meta.url), "utf8"),
  );
  const matchedBy = schema.$defs.legacyDetection.properties.matchedBy;
  assert.deepEqual([...matchedBy.enum].sort(), [
    "LEGACY_PATH_SCHEMA_MISMATCH",
    "SCHEMA_VALIDATION",
  ]);
  // 의미가 바뀌었으므로 major가 올라가 있어야 한다(AGENTS.md).
  assert.equal(schema.properties.schemaVersion.const, 2);
});
