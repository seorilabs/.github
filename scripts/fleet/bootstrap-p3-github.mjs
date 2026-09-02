#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { githubAppReadback } from "./github-app-readback.mjs";
import {
  githubCustomPropertyReadback,
  githubRulesetPlanReadback,
} from "./github-settings-readback.mjs";

const renderer = fileURLToPath(new URL("./render-p3-runtime.mjs", import.meta.url));
const apiVersion = "2026-03-10";
const organization = "seorilabs";
const organizationId = "283115031";
const mode = process.argv[2] ?? "plan";
const confirmation = process.argv[3] ?? "";

function fail(code) {
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exit(1);
}

if (!["plan", "apply", "readback"].includes(mode) || process.argv.length > 4) {
  fail("P3_GITHUB_COMMAND_INVALID");
}
function run(args, { input, allowMissing = false, allowForbidden = false, code }) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      input,
      maxBuffer: 4 * 1024 * 1024,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const diagnostic = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
    if (allowMissing && /HTTP 404|not found/iu.test(diagnostic)) return null;
    if (allowForbidden && /HTTP 403|Resource not accessible/iu.test(diagnostic)) return null;
    if (/HTTP 403|HTTP 404|Resource not accessible|admin:org/iu.test(diagnostic)) {
      fail("P3_GITHUB_ORG_ADMIN_REQUIRED");
    }
    fail(code);
  }
}

function render(command) {
  try {
    return JSON.parse(
      execFileSync(process.execPath, [renderer, command], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    fail("P3_GITHUB_RENDER_FAILED");
  }
}

function api(operation, { allowMissing = false, allowForbidden = false } = {}) {
  if (operation.method !== "GET") {
    fail("P3_GITHUB_AMBIENT_MUTATION_FORBIDDEN");
  }
  const args = [
    "api",
    "--method",
    operation.method,
    operation.path,
    "-H",
    `X-GitHub-Api-Version: ${apiVersion}`,
    "-H",
    "Accept: application/vnd.github+json",
  ];
  let input;
  if (operation.body !== undefined) {
    args.push("--input", "-");
    input = `${JSON.stringify(operation.body)}\n`;
  }
  const raw = run(args, {
    input,
    allowMissing,
    allowForbidden,
    code: "P3_GITHUB_API_FAILED",
  });
  if (raw === null || raw === "") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    fail("P3_GITHUB_API_RESPONSE_INVALID");
  }
}

const app = render("github-app");
if (app.apiVersion !== apiVersion || app.organization !== organization) {
  fail("P3_GITHUB_CONTRACT_DRIFT");
}
const propertyOperations = render("custom-properties");
const valueOperations = render("pilot-values");
const desiredRuleset = render("ruleset");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

function equal(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

const contractPlanDigest = createHash("sha256")
  .update(
    JSON.stringify(
      canonical({
        app,
        operations: [...propertyOperations, ...valueOperations, desiredRuleset],
      }),
    ),
  )
  .digest("hex");
const expectedConfirmation = `fleet-github-${contractPlanDigest.slice(0, 12)}`;
if (mode === "apply" && confirmation !== expectedConfirmation) {
  fail("P3_GITHUB_APPLY_CONFIRMATION_REQUIRED");
}

function propertyDesired(operation) {
  return {
    property_name: decodeURIComponent(operation.path.split("/").at(-1)),
    ...operation.body,
  };
}

function findRuleset() {
  const list = api({
    method: "GET",
    path: `/orgs/${organization}/rulesets?includes_parents=false&targets=branch`,
  });
  const matches = list.filter(({ name }) => name === desiredRuleset.body.name);
  if (matches.length > 1) fail("P3_GITHUB_RULESET_DUPLICATED");
  return matches[0] ?? null;
}

function rulesetSubset(value) {
  return {
    name: value.name,
    target: value.target,
    enforcement: value.enforcement,
    conditions: value.conditions,
    rules: value.rules,
  };
}

function readbackApp() {
  const response = api({
    method: "GET",
    path: `/orgs/${organization}/installations`,
  });
  if (!Array.isArray(response?.installations)) {
    fail("P3_GITHUB_APP_INSTALLATIONS_INVALID");
  }
  return githubAppReadback(
    {
      ...app.identity,
      permissions: app.requiredPermissions,
      events: app.requiredEvents,
    },
    response.installations,
  );
}

function apply() {
  fail("P3_GITHUB_TRUSTED_APP_EXECUTOR_REQUIRED");
}

function appReadbackResult(appState) {
  return {
    ...appState,
    humanGate: appState.ready
      ? { state: "SATISFIED" }
      : app.permissionExpansionGate,
  };
}

function protectedReadback() {
  return {
    trustedExecution: {
      observed: false,
      observationSource: "CONTRACT_ONLY",
      state: app.trustedExecution.state,
      ambientPersonalTokenAllowed:
        app.trustedExecution.ambientPersonalTokenAllowed,
      ready: app.trustedExecution.state === "ready",
    },
    webhook: {
      observed: false,
      observationSource: "CONTRACT_ONLY",
      url: app.webhook.url,
      state: "BLOCKED_APP_AUTH_READBACK",
      exact: false,
    },
    credentialRecovery: {
      observed: false,
      observationSource: "CONTRACT_ONLY",
      state: app.credentialRecovery.trustedAdapter.state,
      logicalIds: app.credentialRecovery.mappings.map(
        ({ targetCredentialId }) => targetCredentialId,
      ),
      ready: false,
    },
  };
}

function readback() {
  const appState = readbackApp();
  const protectedState = protectedReadback();
  if (!appState.ready) {
    return {
      organization,
      app: appReadbackResult(appState),
      ...protectedState,
      properties: [],
      pilots: [],
      ruleset: { read: false, exists: false, exact: false },
      blockedBy: appState.identityExact
        ? "P3_GITHUB_APP_PERMISSION_EXPANSION_REQUIRED"
        : appState.code ?? "P3_GITHUB_APP_IDENTITY_MISMATCH",
      ready: false,
    };
  }
  const rulesetCapability = githubRulesetPlanReadback(
    api({ method: "GET", path: `/orgs/${organization}` }, {
      allowMissing: true,
      allowForbidden: true,
    }),
    { organization, organizationId },
  );
  const properties = propertyOperations.map((operation) => {
    const desired = propertyDesired(operation);
    const actual = api(
      { method: "GET", path: operation.path },
      { allowMissing: true },
    );
    return githubCustomPropertyReadback(desired, actual, organization);
  });
  const pilots = valueOperations.map((operation) => {
    const repository = operation.body.repository_names[0];
    const actual = api(
      { method: "GET", path: `/repos/${organization}/${repository}/properties/values` },
      { allowMissing: true },
    );
    const expected = operation.body.properties.toSorted(
      ({ property_name: left }, { property_name: right }) => left.localeCompare(right),
    );
    const selected = (actual ?? [])
      .filter(({ property_name }) =>
        expected.some(({ property_name: expectedName }) => property_name === expectedName),
      )
      .map(({ property_name, value }) => ({ property_name, value }))
      .toSorted(({ property_name: left }, { property_name: right }) => left.localeCompare(right));
    return {
      repository,
      exists: actual !== null,
      exact: actual !== null && equal(selected, expected),
    };
  });
  const listed = findRuleset();
  let ruleset = { exists: false, exact: false };
  if (listed !== null) {
    const detail = api({
      method: "GET",
      path: `/orgs/${organization}/rulesets/${listed.id}`,
    });
    ruleset = {
      id: listed.id,
      name: listed.name,
      enforcement: listed.enforcement,
      exists: true,
      exact: equal(rulesetSubset(detail), rulesetSubset(desiredRuleset.body)),
    };
  }
  return {
    organization,
    ...protectedState,
    properties,
    pilots,
    ruleset,
    rulesetCapability,
    app: appReadbackResult(appState),
    blockedBy: rulesetCapability.code ?? "P3_GITHUB_TRUSTED_APP_EXECUTOR_REQUIRED",
    ready:
      appState.ready &&
      rulesetCapability.evaluate === "SUPPORTED" &&
      protectedState.trustedExecution.ready &&
      protectedState.webhook.exact &&
      protectedState.credentialRecovery.ready &&
      properties.every(({ exact }) => exact) &&
      pilots.every(({ exact }) => exact) &&
      ruleset.exact,
  };
}

if (mode === "plan") {
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        mode: "DRY_RUN",
        organization,
        contractPlanDigest,
        app,
        operations: [...propertyOperations, ...valueOperations, desiredRuleset],
        apply: `node scripts/fleet/bootstrap-p3-github.mjs apply ${expectedConfirmation}`,
        readback: "node scripts/fleet/bootstrap-p3-github.mjs readback",
      },
      null,
      2,
    )}\n`,
  );
} else if (mode === "apply") {
  apply();
  process.stdout.write(`${JSON.stringify(readback(), null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(readback(), null, 2)}\n`);
}
