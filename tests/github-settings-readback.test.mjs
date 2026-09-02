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
  githubProtectionPlanReadback,
  githubProtectionReadback,
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

test("GitHub Team uses the approved read-only SHADOW path without Enterprise Evaluate", () => {
  const result = githubProtectionPlanReadback({
    id: 283115031, login: "seorilabs", plan: { name: "team" },
  }, organization);
  assert.equal(result.identityExact, true);
  assert.equal(result.plan, "team");
  assert.equal(result.protection, "SUPPORTED");
  assert.equal(result.rolloutMode, "SHADOW");
  assert.equal(result.code, null);
});

test("GitHub plan visibility loss does not mean a free plan or a missing resource", () => {
  for (const input of [null, { id: 283115031, login: "seorilabs" },
    { id: 283115031, login: "seorilabs", plan: { name: "future-plan" } }]) {
    const result = githubProtectionPlanReadback(input, organization);
    assert.equal(result.plan, null);
    assert.equal(result.protection, "UNVERIFIED");
    assert.equal(result.code, "P3_GITHUB_PLAN_VISIBILITY_REQUIRED");
  }
});

test("plan changes never silently select another protection provider", () => {
  assert.equal(githubProtectionPlanReadback({
    id: 283115031, login: "seorilabs", plan: { name: "enterprise" },
  }, organization).code, "P3_GITHUB_PROTECTION_PLAN_DRIFT");
  for (const input of [
    { id: 1, login: "seorilabs", plan: { name: "enterprise" } },
    { id: 283115031, login: "other-org", plan: { name: "enterprise" } },
  ]) {
    const result = githubProtectionPlanReadback(input, organization);
    assert.equal(result.protection, "UNVERIFIED");
    assert.equal(result.code, "P3_GITHUB_ORGANIZATION_IDENTITY_MISMATCH");
  }
});

test("P3 CLI observes Team protection and differences without mutating GitHub", async () => {
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
    };
    for (const binding of plan.protection.repositories) {
      const path = `/repos/${binding.fullName}`;
      state[path] = { id: Number(binding.repositoryId), full_name: binding.fullName, default_branch: "main" };
      state[`${path}/branches/main/protection`] = { fixtureStatus: 404, fixtureMessage: "Branch not protected" };
      state[`${path}/rules/branches/main`] = [{ type: "required_status_checks", parameters: {
        required_status_checks: [{ context: "Existing required check", integration_id: 15368 }],
      } }];
    }
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
        ? "P3_GITHUB_PLAN_VISIBILITY_REQUIRED" : "P3_GITHUB_TRUSTED_APP_EXECUTOR_REQUIRED");
      assert.equal(output.protectionCapability.protection, observation.fixtureStatus === 403
        ? "UNVERIFIED" : "SUPPORTED");
      if (observation.fixtureStatus !== 403) {
        assert.equal(output.protection.ready, true);
        assert.equal(output.protection.activationAllowed, false);
        assert.equal(output.protection.existingProtectionChanged, false);
        for (const row of output.protection.repositories) {
          assert.equal(row.branchProtectionPresent, false);
          assert.equal(row.requiredStatusCheckPresent, false);
          assert.deepEqual(row.existingStatusChecks, ["Existing required check"]);
          assert.deepEqual(row.missingStatusChecks, ["Org Contract / Org Contract"]);
          assert.match(row.snapshotDigest, /^sha256:[0-9a-f]{64}$/u);
        }
      }
      for (const key of ["credentialRecovery", "webhook", "trustedExecution"]) {
        assert.equal(output[key].observed, false);
        assert.equal(output[key].observationSource, "CONTRACT_ONLY");
      }
      assert.equal(output.ready, false);
    }
    const requests = (await readFile(requestsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(requests.length >= 18);
    assert.ok(requests.every(({ method }) => method === "GET"));
    assert.ok(requests.every(({ path }) => !path.startsWith("/orgs/seorilabs/rulesets")));
    state["/orgs/seorilabs"] = { id: 283115031, login: "seorilabs", plan: { name: "team" } };
    state["/repos/seorilabs/happy-farm/branches/main/protection"] = { fixtureStatus: 404 };
    await writeFile(statePath, JSON.stringify(state));
    await assert.rejects(execFileAsync(process.execPath,
      ["scripts/fleet/bootstrap-p3-github.mjs", "readback"], { env: environment }),
    (error) => /P3_GITHUB_ORG_ADMIN_REQUIRED/u.test(error.stderr));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SHADOW compares both branch protection and effective rules without dropping existing checks", () => {
  const desiredProtection = { branch: "main", requiredStatusCheck: "Org Contract / Org Contract" };
  const binding = { fullName: "seorilabs/happy-farm", repositoryId: "123" };
  const source = {
    repository: { id: 123, full_name: binding.fullName, default_branch: "main" },
    branchProtection: {
      url: `https://api.github.com/repos/${binding.fullName}/branches/main/protection`,
      required_status_checks: { contexts: ["legacy"], checks: [{ context: "security", app_id: 15368 }] },
      required_pull_request_reviews: { required_approving_review_count: 2 },
    },
    activeRules: [{ type: "required_status_checks", parameters: {
      required_status_checks: [{ context: desiredProtection.requiredStatusCheck, integration_id: 15368 }],
    } }],
  };
  const original = structuredClone(source);
  const readback = githubProtectionReadback(desiredProtection, binding, source, new Date().toISOString());
  assert.equal(readback.state, "OBSERVED");
  assert.equal(readback.requiredStatusCheckPresent, true);
  assert.deepEqual(readback.existingStatusChecks, ["Org Contract / Org Contract", "legacy", "security"]);
  assert.deepEqual(source, original);
  for (const patch of [
    { repository: { ...source.repository, id: 456 } },
    { repository: { ...source.repository, default_branch: "other" } },
    { branchProtection: { url: "https://wrong.invalid" } }, { activeRules: null },
  ]) {
    const invalid = githubProtectionReadback(desiredProtection, binding, { ...source, ...patch }, new Date().toISOString());
    assert.equal(invalid.state, "UNVERIFIED");
    assert.equal(invalid.snapshotDigest, null);
  }
});
