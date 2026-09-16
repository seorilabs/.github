import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { parseDocument } from "yaml";

import {
  APP_MARKETS,
  DIMENSION_SOURCES,
  GA4_READINESS_CHECKS,
  RUNTIME_PLATFORMS,
  buildGa4ReadinessPlan,
  canonicalCustomEventErrors,
  normalizeAnalyticsDimensions,
  renderGa4NormalizedSelect,
  shouldIncludeAnalyticsApp,
} from "../packages/repo-contract/src/analytics-event-contract.mjs";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const schema = JSON.parse(
  await readFile(resolve(ROOT, "contracts/analytics-event-policy.schema.json"), "utf8"),
);
const document = parseDocument(
  await readFile(resolve(ROOT, "contracts/analytics-event-policy.yaml"), "utf8"),
  { strict: true, uniqueKeys: true },
);
assert.deepEqual(document.errors, []);
const policy = document.toJS();

test("Analytics 정책은 strict schema와 canonical enum을 통과한다", () => {
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(policy), true, JSON.stringify(validate.errors));
  assert.deepEqual(policy.customEvents.requiredParameters.app_market.enum, APP_MARKETS);
  assert.deepEqual(policy.customEvents.requiredParameters.runtime_platform.enum, RUNTIME_PLATFORMS);
  assert.deepEqual(policy.normalization.dimensionSources, DIMENSION_SOURCES);
  assert.deepEqual(policy.managementPlan.checks, GA4_READINESS_CHECKS);
});

test("모든 custom event는 canonical 세 파라미터를 요구한다", () => {
  assert.deepEqual(canonicalCustomEventErrors({}), [
    "app_market",
    "runtime_platform",
    "release_version",
  ]);
  assert.deepEqual(canonicalCustomEventErrors({
    app_market: "apps_in_toss",
    runtime_platform: "web",
    release_version: "1.2.3",
  }), []);
});

test("legacy 파라미터는 값과 출처를 함께 보존한다", () => {
  assert.deepEqual(normalizeAnalyticsDimensions({
    eventParams: {
      market: "apps-in-toss",
      platform: "ait",
      app_version: "1.4.0",
    },
    geoCountry: "KR",
  }), {
    app_market: "apps_in_toss",
    runtime_platform: "web",
    release_version: "1.4.0",
    country: "KR",
    dimension_source: {
      app_market: "legacy",
      runtime_platform: "legacy",
      release_version: "legacy",
      country: "observed",
    },
  });
});

test("자동 이벤트는 원시 필드에서만 추론하고 출처를 표시한다", () => {
  assert.deepEqual(normalizeAnalyticsDimensions({
    installSource: "com.android.vending",
    topLevelPlatform: "ANDROID",
    appInfoVersion: "2.0.1",
  }), {
    app_market: "google_play",
    runtime_platform: "android",
    release_version: "2.0.1",
    country: null,
    dimension_source: {
      app_market: "inferred",
      runtime_platform: "inferred",
      release_version: "inferred",
      country: "unknown",
    },
  });
});

test("WEB만으로 AppsInToss와 국가를 생성하지 않는다", () => {
  const normalized = normalizeAnalyticsDimensions({ topLevelPlatform: "WEB" });
  assert.equal(normalized.app_market, "unknown");
  assert.equal(normalized.runtime_platform, "web");
  assert.equal(normalized.country, null);
  assert.equal(normalized.dimension_source.app_market, "unknown");
  assert.equal(normalized.dimension_source.country, "unknown");

  const exactStream = normalizeAnalyticsDimensions({
    topLevelPlatform: "WEB",
    exactStreamMarket: "apps_in_toss",
  });
  assert.equal(exactStream.app_market, "apps_in_toss");
  assert.equal(exactStream.dimension_source.app_market, "inferred");
});

test("BigQuery 정규화 SELECT는 exact stream만 market 추론에 사용한다", () => {
  const sql = renderGa4NormalizedSelect({
    sourceTable: "example-project.analytics_123.events_*",
    streamMarkets: { "456": "apps_in_toss" },
  });
  assert.match(sql, /FROM `example-project\.analytics_123\.events_\*` AS raw/u);
  assert.match(sql, /WHEN stream_id = '456' THEN 'apps_in_toss'/u);
  assert.doesNotMatch(sql, /WHEN UPPER\(platform\) = 'WEB' THEN 'apps_in_toss'/u);
  assert.match(sql, /NULLIF\(TRIM\(geo\.country\), ''\) AS country/u);
  assert.throws(
    () => renderGa4NormalizedSelect({ sourceTable: "example.analytics.events_*;DROP" }),
    /exact project\.dataset\.table/u,
  );
});

test("archived와 unknown 앱은 계획 대상에서 제외한다", () => {
  assert.equal(shouldIncludeAnalyticsApp("archived"), false);
  assert.equal(shouldIncludeAnalyticsApp("unknown"), false);
  assert.equal(shouldIncludeAnalyticsApp(undefined), false);
  assert.equal(shouldIncludeAnalyticsApp("launched"), true);
  assert.equal(buildGa4ReadinessPlan({ appId: "foam-party", lifecycle: "archived" }).eligibility, "excluded");
});

test("GA4 관리 계획은 provider 관측을 네 상태로만 분류한다", () => {
  const desired = Object.fromEntries(GA4_READINESS_CHECKS.map((id) => [id, { expected: id }]));
  const observed = {
    firebase_ga4_link: { state: "present", value: desired.firebase_ga4_link },
    bigquery_export: { state: "absent" },
    custom_dimension_app_market: { state: "unknown" },
    custom_dimension_runtime_platform: { state: "present", value: { expected: "other" } },
    custom_dimension_release_version: {
      state: "present",
      value: desired.custom_dimension_release_version,
    },
    admob_firebase_link: { state: "absent" },
    impression_level_revenue: { state: "present", value: { expected: "other" } },
  };

  const plan = buildGa4ReadinessPlan({
    appId: "jomul",
    lifecycle: "launched",
    desired,
    observed,
  });
  assert.equal(plan.readOnly, true);
  assert.deepEqual(plan.checks.map(({ status }) => status), [
    "present",
    "planned",
    "unknown",
    "mismatch",
    "present",
    "planned",
    "mismatch",
  ]);
});

test("계획 CLI는 파일을 바꾸지 않고 결정적인 JSON을 출력한다", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ga4-readiness-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const desiredPath = join(directory, "desired.json");
  const observedPath = join(directory, "observed.json");
  const desired = {
    appId: "babycare",
    lifecycle: "launched",
    checks: Object.fromEntries(GA4_READINESS_CHECKS.map((id) => [id, id])),
  };
  const observed = {
    checks: Object.fromEntries(GA4_READINESS_CHECKS.map((id) => [
      id,
      { state: "present", value: id },
    ])),
  };
  await Promise.all([
    writeFile(desiredPath, JSON.stringify(desired)),
    writeFile(observedPath, JSON.stringify(observed)),
  ]);

  const command = resolve(ROOT, "scripts/analytics/plan-ga4-readiness.mjs");
  const first = await execFileAsync(process.execPath, [
    command,
    "--desired",
    desiredPath,
    "--observed",
    observedPath,
  ]);
  const second = await execFileAsync(process.execPath, [
    command,
    "--desired",
    desiredPath,
    "--observed",
    observedPath,
  ]);

  assert.equal(first.stdout, second.stdout);
  assert.deepEqual(
    JSON.parse(first.stdout).checks.map(({ status }) => status),
    Array(GA4_READINESS_CHECKS.length).fill("present"),
  );
  assert.equal(await readFile(desiredPath, "utf8"), JSON.stringify(desired));
  assert.equal(await readFile(observedPath, "utf8"), JSON.stringify(observed));
});
