import assert from "node:assert/strict";

export const APP_MARKETS = Object.freeze([
  "google_play",
  "app_store",
  "apps_in_toss",
]);
export const RUNTIME_PLATFORMS = Object.freeze(["android", "ios", "web"]);
export const DIMENSION_SOURCES = Object.freeze([
  "observed",
  "legacy",
  "inferred",
  "unknown",
]);
export const GA4_READINESS_CHECKS = Object.freeze([
  "firebase_ga4_link",
  "bigquery_export",
  "custom_dimension_app_market",
  "custom_dimension_runtime_platform",
  "custom_dimension_release_version",
  "admob_firebase_link",
  "impression_level_revenue",
]);

const APP_MARKET_SET = new Set(APP_MARKETS);
const RUNTIME_PLATFORM_SET = new Set(RUNTIME_PLATFORMS);
const EXCLUDED_LIFECYCLES = new Set(["archived", "unknown"]);
const LEGACY_MARKETS = new Map([
  ["google-play", "google_play"],
  ["google_play", "google_play"],
  ["play-store", "google_play"],
  ["app-store", "app_store"],
  ["app_store", "app_store"],
  ["apps-in-toss", "apps_in_toss"],
  ["apps_in_toss", "apps_in_toss"],
  ["ait", "apps_in_toss"],
]);
const INSTALL_SOURCE_MARKETS = new Map([
  ["com.android.vending", "google_play"],
  ["google play store", "google_play"],
  ["google_play", "google_play"],
  ["com.apple.appstore", "app_store"],
  ["apple app store", "app_store"],
  ["app_store", "app_store"],
  ["itunes", "app_store"],
]);
const TOP_LEVEL_PLATFORMS = new Map([
  ["ANDROID", "android"],
  ["IOS", "ios"],
  ["WEB", "web"],
]);
const LEGACY_PLATFORMS = new Map([
  ["android", "android"],
  ["ios", "ios"],
  ["web", "web"],
  ["ait", "web"],
  ["apps_in_toss", "web"],
  ["apps-in-toss", "web"],
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function normalizedLookup(map, value) {
  const stringValue = nonEmptyString(value);
  return stringValue === null ? null : map.get(stringValue.toLowerCase()) ?? null;
}

function resolved(value, source) {
  return { value, source };
}

function normalizeAppMarket({ eventParams, installSource, exactStreamMarket }) {
  const canonical = nonEmptyString(eventParams.app_market);
  if (canonical !== null && APP_MARKET_SET.has(canonical)) {
    return resolved(canonical, "observed");
  }

  for (const candidate of [eventParams.market, eventParams.app_market]) {
    const legacy = normalizedLookup(LEGACY_MARKETS, candidate);
    if (legacy !== null) return resolved(legacy, "legacy");
  }

  const installedFrom = normalizedLookup(INSTALL_SOURCE_MARKETS, installSource);
  if (installedFrom !== null) return resolved(installedFrom, "inferred");

  if (APP_MARKET_SET.has(exactStreamMarket)) {
    return resolved(exactStreamMarket, "inferred");
  }

  return resolved("unknown", "unknown");
}

function normalizeRuntimePlatform({ eventParams, topLevelPlatform }) {
  const canonical = nonEmptyString(eventParams.runtime_platform);
  if (canonical !== null && RUNTIME_PLATFORM_SET.has(canonical)) {
    return resolved(canonical, "observed");
  }

  const legacy = normalizedLookup(LEGACY_PLATFORMS, eventParams.platform);
  if (legacy !== null) return resolved(legacy, "legacy");

  const topLevel = nonEmptyString(topLevelPlatform);
  const inferred = topLevel === null ? null : TOP_LEVEL_PLATFORMS.get(topLevel.toUpperCase());
  return inferred === undefined || inferred === null
    ? resolved("unknown", "unknown")
    : resolved(inferred, "inferred");
}

function normalizeReleaseVersion({ eventParams, appInfoVersion }) {
  const canonical = nonEmptyString(eventParams.release_version);
  if (canonical !== null) return resolved(canonical, "observed");

  const legacy = nonEmptyString(eventParams.app_version);
  if (legacy !== null) return resolved(legacy, "legacy");

  const inferred = nonEmptyString(appInfoVersion);
  return inferred === null
    ? resolved("unknown", "unknown")
    : resolved(inferred, "inferred");
}

export function normalizeAnalyticsDimensions({
  eventParams = {},
  topLevelPlatform = null,
  appInfoVersion = null,
  installSource = null,
  exactStreamMarket = null,
  geoCountry = null,
} = {}) {
  const appMarket = normalizeAppMarket({ eventParams, installSource, exactStreamMarket });
  const runtimePlatform = normalizeRuntimePlatform({ eventParams, topLevelPlatform });
  const releaseVersion = normalizeReleaseVersion({ eventParams, appInfoVersion });
  const country = nonEmptyString(geoCountry);

  return {
    app_market: appMarket.value,
    runtime_platform: runtimePlatform.value,
    release_version: releaseVersion.value,
    country,
    dimension_source: {
      app_market: appMarket.source,
      runtime_platform: runtimePlatform.source,
      release_version: releaseVersion.source,
      country: country === null ? "unknown" : "observed",
    },
  };
}

function sqlLegacyMarket(column) {
  return `CASE LOWER(${column})
      WHEN 'google-play' THEN 'google_play'
      WHEN 'google_play' THEN 'google_play'
      WHEN 'play-store' THEN 'google_play'
      WHEN 'app-store' THEN 'app_store'
      WHEN 'app_store' THEN 'app_store'
      WHEN 'apps-in-toss' THEN 'apps_in_toss'
      WHEN 'apps_in_toss' THEN 'apps_in_toss'
      WHEN 'ait' THEN 'apps_in_toss'
    END`;
}

function sqlInstallMarket(column) {
  return `CASE LOWER(${column})
      WHEN 'com.android.vending' THEN 'google_play'
      WHEN 'google play store' THEN 'google_play'
      WHEN 'google_play' THEN 'google_play'
      WHEN 'com.apple.appstore' THEN 'app_store'
      WHEN 'apple app store' THEN 'app_store'
      WHEN 'app_store' THEN 'app_store'
      WHEN 'itunes' THEN 'app_store'
    END`;
}

export function renderGa4NormalizedSelect({ sourceTable, streamMarkets = {} } = {}) {
  if (typeof sourceTable !== "string" ||
      !/^[a-z][a-z0-9-]{4,29}\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_*]*$/u.test(sourceTable)) {
    throw new Error("sourceTable must be an exact project.dataset.table reference");
  }

  const streamEntries = Object.entries(streamMarkets).sort(([left], [right]) => left.localeCompare(right));
  for (const [streamId, market] of streamEntries) {
    if (!/^[0-9]+$/u.test(streamId) || !APP_MARKET_SET.has(market)) {
      throw new Error("streamMarkets must map numeric stream IDs to canonical app markets");
    }
  }
  const streamValueCases = streamEntries
    .map(([streamId, market]) => `WHEN stream_id = '${streamId}' THEN '${market}'`)
    .join("\n      ");
  const streamSourceCases = streamEntries
    .map(([streamId]) => `WHEN stream_id = '${streamId}' THEN 'inferred'`)
    .join("\n      ");

  return `WITH extracted AS (
  SELECT
    raw.*,
    (SELECT MAX(value.string_value) FROM UNNEST(event_params) WHERE key = 'app_market') AS _app_market,
    (SELECT MAX(value.string_value) FROM UNNEST(event_params) WHERE key = 'runtime_platform') AS _runtime_platform,
    (SELECT MAX(value.string_value) FROM UNNEST(event_params) WHERE key = 'release_version') AS _release_version,
    (SELECT MAX(value.string_value) FROM UNNEST(event_params) WHERE key = 'market') AS _legacy_market,
    (SELECT MAX(value.string_value) FROM UNNEST(event_params) WHERE key = 'platform') AS _legacy_platform,
    (SELECT MAX(value.string_value) FROM UNNEST(event_params) WHERE key = 'app_version') AS _legacy_version
  FROM \`${sourceTable}\` AS raw
), normalized AS (
  SELECT
    extracted.*,
    CASE
      WHEN _app_market IN ('google_play', 'app_store', 'apps_in_toss') THEN _app_market
      WHEN ${sqlLegacyMarket("_legacy_market")} IS NOT NULL THEN ${sqlLegacyMarket("_legacy_market")}
      WHEN ${sqlLegacyMarket("_app_market")} IS NOT NULL THEN ${sqlLegacyMarket("_app_market")}
      WHEN ${sqlInstallMarket("app_info.install_source")} IS NOT NULL THEN ${sqlInstallMarket("app_info.install_source")}
      ${streamValueCases}
      ELSE 'unknown'
    END AS app_market,
    CASE
      WHEN _runtime_platform IN ('android', 'ios', 'web') THEN _runtime_platform
      WHEN LOWER(_legacy_platform) IN ('android', 'ios') THEN LOWER(_legacy_platform)
      WHEN LOWER(_legacy_platform) IN ('web', 'ait', 'apps_in_toss', 'apps-in-toss') THEN 'web'
      WHEN UPPER(platform) = 'ANDROID' THEN 'android'
      WHEN UPPER(platform) = 'IOS' THEN 'ios'
      WHEN UPPER(platform) = 'WEB' THEN 'web'
      ELSE 'unknown'
    END AS runtime_platform,
    COALESCE(NULLIF(TRIM(_release_version), ''), NULLIF(TRIM(_legacy_version), ''),
      NULLIF(TRIM(app_info.version), ''), 'unknown') AS release_version,
    NULLIF(TRIM(geo.country), '') AS country,
    CASE
      WHEN _app_market IN ('google_play', 'app_store', 'apps_in_toss') THEN 'observed'
      WHEN ${sqlLegacyMarket("_legacy_market")} IS NOT NULL OR ${sqlLegacyMarket("_app_market")} IS NOT NULL THEN 'legacy'
      WHEN ${sqlInstallMarket("app_info.install_source")} IS NOT NULL THEN 'inferred'
      ${streamSourceCases}
      ELSE 'unknown'
    END AS _app_market_source,
    CASE
      WHEN _runtime_platform IN ('android', 'ios', 'web') THEN 'observed'
      WHEN LOWER(_legacy_platform) IN ('android', 'ios', 'web', 'ait', 'apps_in_toss', 'apps-in-toss') THEN 'legacy'
      WHEN UPPER(platform) IN ('ANDROID', 'IOS', 'WEB') THEN 'inferred'
      ELSE 'unknown'
    END AS _runtime_platform_source,
    CASE
      WHEN NULLIF(TRIM(_release_version), '') IS NOT NULL THEN 'observed'
      WHEN NULLIF(TRIM(_legacy_version), '') IS NOT NULL THEN 'legacy'
      WHEN NULLIF(TRIM(app_info.version), '') IS NOT NULL THEN 'inferred'
      ELSE 'unknown'
    END AS _release_version_source
  FROM extracted
)
SELECT
  * EXCEPT(
    _app_market,
    _runtime_platform,
    _release_version,
    _legacy_market,
    _legacy_platform,
    _legacy_version,
    _app_market_source,
    _runtime_platform_source,
    _release_version_source
  ),
  STRUCT(
    _app_market_source AS app_market,
    _runtime_platform_source AS runtime_platform,
    _release_version_source AS release_version,
    IF(country IS NULL, 'unknown', 'observed') AS country
  ) AS dimension_source
FROM normalized`;
}

export function canonicalCustomEventErrors(eventParams = {}) {
  const errors = [];
  if (!APP_MARKET_SET.has(eventParams.app_market)) errors.push("app_market");
  if (!RUNTIME_PLATFORM_SET.has(eventParams.runtime_platform)) errors.push("runtime_platform");
  if (nonEmptyString(eventParams.release_version) === null) errors.push("release_version");
  return errors;
}

export function assertCanonicalCustomEvent(eventParams = {}) {
  const missingOrInvalid = canonicalCustomEventErrors(eventParams);
  assert.deepEqual(
    missingOrInvalid,
    [],
    `custom event canonical parameters missing or invalid: ${missingOrInvalid.join(", ")}`,
  );
}

export function shouldIncludeAnalyticsApp(lifecycle) {
  const normalized = nonEmptyString(lifecycle)?.toLowerCase() ?? "unknown";
  return !EXCLUDED_LIFECYCLES.has(normalized);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function sameValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function readinessStatus(expected, observation) {
  if (expected === undefined) return { status: "unknown", reason: "desired_state_missing" };
  if (observation === undefined || observation?.state === "unknown") {
    return { status: "unknown", reason: "provider_state_unreadable" };
  }
  if (observation?.state === "absent") {
    return { status: "planned", reason: "provider_resource_absent" };
  }
  if (observation?.state !== "present") {
    return { status: "unknown", reason: "provider_state_invalid" };
  }
  if (!sameValue(expected, observation.value)) {
    return { status: "mismatch", reason: "provider_state_differs" };
  }
  return { status: "present", reason: "exact_match" };
}

export function buildGa4ReadinessPlan({
  appId,
  lifecycle,
  desired = {},
  observed = {},
} = {}) {
  const normalizedAppId = nonEmptyString(appId);
  if (normalizedAppId === null) throw new Error("appId is required");

  if (!shouldIncludeAnalyticsApp(lifecycle)) {
    return {
      appId: normalizedAppId,
      lifecycle: nonEmptyString(lifecycle)?.toLowerCase() ?? "unknown",
      eligibility: "excluded",
      readOnly: true,
      checks: [],
    };
  }

  return {
    appId: normalizedAppId,
    lifecycle: nonEmptyString(lifecycle)?.toLowerCase() ?? "unknown",
    eligibility: "included",
    readOnly: true,
    checks: GA4_READINESS_CHECKS.map((id) => ({
      id,
      ...readinessStatus(desired[id], observed[id]),
    })),
  };
}
