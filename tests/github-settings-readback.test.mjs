import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  githubCustomPropertyReadback,
  githubRulesetPlanReadback,
} from "../scripts/fleet/github-settings-readback.mjs";

const desired = {
  property_name: "fleet-managed",
  value_type: "single_select",
  required: false,
  description: "Fleet 중앙 관리 대상 여부",
  allowed_values: ["true", "false"],
  values_editable_by: "org_actors",
  require_explicit_values: true,
};
const response = {
  ...desired,
  url: "https://api.github.com/orgs/seorilabs/properties/schema/fleet-managed",
  source_type: "organization",
  default_value: null,
};
const organization = { organization: "seorilabs", organizationId: "283115031" };
const execFileAsync = promisify(execFile);

test("GitHub property readback compares settings without mistaking response metadata for drift", () => {
  assert.deepEqual(githubCustomPropertyReadback(desired, response, "seorilabs"), {
    propertyName: "fleet-managed", exists: true, exact: true,
  });
  assert.equal(githubCustomPropertyReadback(desired, { ...desired }, "seorilabs").exact, true);
  const omittedDefault = { ...response };
  delete omittedDefault.required;
  assert.equal(githubCustomPropertyReadback(desired, omittedDefault, "seorilabs").exact, true);
});

test("GitHub property readback still rejects every changed setting and inherited definition", () => {
  for (const patch of [
    { property_name: "another-property" }, { value_type: "string" }, { required: true }, { required: null },
    { default_value: "true" }, { description: "changed" }, { allowed_values: ["false", "true"] },
    { values_editable_by: "org_and_repo_actors" }, { values_editable_by: null },
    { require_explicit_values: false }, { require_explicit_values: null },
    { source_type: "enterprise" }, { future_behavior: true },
    { url: "https://api.github.com/orgs/another-org/properties/schema/fleet-managed" },
    { url: "https://api.github.com.attacker.invalid/orgs/seorilabs/properties/schema/fleet-managed" },
  ]) {
    assert.equal(githubCustomPropertyReadback(desired, { ...response, ...patch }, "seorilabs").exact,
      false, JSON.stringify(patch));
  }
  assert.deepEqual(githubCustomPropertyReadback(desired, null, "seorilabs"), {
    propertyName: "fleet-managed", exists: false, exact: false,
  });
  for (const invalid of [[], "invalid", true]) {
    assert.equal(githubCustomPropertyReadback(desired, invalid, "seorilabs").exact, false);
  }
});

test("GitHub Team cannot satisfy Evaluate even after App permissions are granted", () => {
  const result = githubRulesetPlanReadback({
    id: 283115031, login: "seorilabs", plan: { name: "team" },
  }, organization);
  assert.equal(result.identityExact, true);
  assert.equal(result.plan, "team");
  assert.equal(result.evaluate, "UNSUPPORTED");
  assert.equal(result.code, "P3_GITHUB_EVALUATE_UNSUPPORTED_BY_PLAN");
});

test("GitHub plan visibility loss does not mean a free plan or a missing resource", () => {
  for (const input of [null, { id: 283115031, login: "seorilabs" },
    { id: 283115031, login: "seorilabs", plan: { name: "future-plan" } }]) {
    const result = githubRulesetPlanReadback(input, organization);
    assert.equal(result.plan, null);
    assert.equal(result.evaluate, "UNVERIFIED");
    assert.equal(result.code, "P3_GITHUB_PLAN_VISIBILITY_REQUIRED");
  }
});

test("GitHub Enterprise Evaluate support requires the exact numeric organization identity", () => {
  assert.equal(githubRulesetPlanReadback({
    id: 283115031, login: "seorilabs", plan: { name: "enterprise" },
  }, organization).evaluate, "SUPPORTED");
  for (const input of [
    { id: 1, login: "seorilabs", plan: { name: "enterprise" } },
    { id: 283115031, login: "other-org", plan: { name: "enterprise" } },
  ]) {
    const result = githubRulesetPlanReadback(input, organization);
    assert.equal(result.evaluate, "UNVERIFIED");
    assert.equal(result.code, "P3_GITHUB_ORGANIZATION_IDENTITY_MISMATCH");
  }
});

test("P3 CLI reports Team limitation separately from exact properties without mutating GitHub", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p3-github-readback-"));
  try {
    const fixture = fileURLToPath(new URL("./fixtures/p3-github-readback-mock.mjs", import.meta.url));
    await chmod(fixture, 0o755);
    await symlink(fixture, join(directory, "gh"));
    const planResult = await execFileAsync(process.execPath, ["scripts/fleet/bootstrap-p3-github.mjs"]);
    const plan = JSON.parse(planResult.stdout);
    const state = {
      "/orgs/seorilabs": { id: 283115031, login: "seorilabs", plan: { name: "team" } },
      "/orgs/seorilabs/installations": { installations: [{
        app_id: plan.app.identity.appId,
        app_slug: plan.app.identity.slug,
        id: plan.app.identity.installationId,
        target_type: "Organization",
        repository_selection: "all",
        suspended_at: null,
        permissions: plan.app.requiredPermissions,
        events: plan.app.requiredEvents,
      }] },
      "/orgs/seorilabs/rulesets?includes_parents=false&targets=branch": [],
    };
    for (const operation of plan.operations) {
      if (operation.method === "PUT") {
        state[operation.path] = {
          ...operation.body,
          property_name: decodeURIComponent(operation.path.split("/").at(-1)),
          url: `https://api.github.com${operation.path}`,
          source_type: "organization",
          default_value: null,
        };
      } else if (operation.method === "PATCH") {
        state[`/repos/seorilabs/${operation.body.repository_names[0]}/properties/values`]
          = operation.body.properties;
      }
    }
    const statePath = join(directory, "public-state.json");
    const requestsPath = join(directory, "requests.jsonl");
    const environment = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      P3_GITHUB_FIXTURE_STATE: statePath,
      P3_GITHUB_FIXTURE_REQUESTS: requestsPath,
    };
    for (const observation of [state["/orgs/seorilabs"], { fixtureStatus: 403 }]) {
      state["/orgs/seorilabs"] = observation;
      await writeFile(statePath, JSON.stringify(state));
      const result = await execFileAsync(process.execPath,
        ["scripts/fleet/bootstrap-p3-github.mjs", "readback"], { env: environment });
      assert.equal(result.stderr, "");
      const output = JSON.parse(result.stdout);
      assert.equal(output.app.ready, true);
      assert.equal(output.properties.length, 4);
      assert.ok(output.properties.every(({ exact }) => exact));
      assert.ok(output.pilots.every(({ exact }) => exact));
      assert.equal(output.blockedBy, observation.fixtureStatus === 403
        ? "P3_GITHUB_PLAN_VISIBILITY_REQUIRED" : "P3_GITHUB_EVALUATE_UNSUPPORTED_BY_PLAN");
      assert.equal(output.rulesetCapability.evaluate, observation.fixtureStatus === 403
        ? "UNVERIFIED" : "UNSUPPORTED");
      for (const key of ["credentialRecovery", "webhook", "trustedExecution"]) {
        assert.equal(output[key].observed, false);
        assert.equal(output[key].observationSource, "CONTRACT_ONLY");
      }
      assert.equal(output.ready, false);
    }
    const requests = (await readFile(requestsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(requests.length >= 18);
    assert.ok(requests.every(({ method }) => method === "GET"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
