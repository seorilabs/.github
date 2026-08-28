import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";

import { githubAppReadback } from "../scripts/fleet/github-app-readback.mjs";

const execFileAsync = promisify(execFile);
const script = "scripts/fleet/render-p3-runtime.mjs";
const gcpBootstrap = "scripts/fleet/bootstrap-p3-gcp.mjs";
const gcloudMock = fileURLToPath(
  new URL("./fixtures/p3-gcloud-mock.mjs", import.meta.url),
);
const contract = parse(await readFile("contracts/fleet-p3-runtime.yaml", "utf8"));
const schema = JSON.parse(
  await readFile("contracts/fleet-p3-runtime.schema.json", "utf8"),
);
const activeBackofficeInstallation = {
  app_id: 4124446,
  app_slug: "seorilabs-backoffice",
  id: 142120077,
  target_type: "Organization",
  repository_selection: "all",
  suspended_at: null,
  permissions: {
    actions: "write",
    checks: "read",
    contents: "write",
    issues: "write",
    members: "read",
    metadata: "read",
    pull_requests: "read",
  },
  events: ["issues", "issue_comment", "pull_request", "push", "workflow_run"],
};

async function render(command) {
  const result = await execFileAsync(process.execPath, [script, command]);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

test("P3 runtime public contract는 strict schema와 고정 pilot을 사용한다", () => {
  const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(
    schema,
  );
  assert.equal(validate(contract), true, JSON.stringify(validate.errors));
  assert.deepEqual(
    contract.github.pilotValues.map(({ repository }) => repository),
    ["happy-farm", "lizard-tycoon"],
  );
  assert.equal(contract.authBroker.state.encryptionRequired, true);
  assert.equal(contract.authBroker.state.encryptionStatus, "blocked_unverified");
});

test("GitHub App bootstrap은 active Backoffice App을 재사용하고 새 App을 등록하지 않는다", async () => {
  const output = await render("github-app");
  assert.equal("registrationUrl" in output, false);
  assert.equal(output.reuseExisting, true);
  assert.deepEqual(output.identity, {
    appId: 4124446,
    slug: "seorilabs-backoffice",
    installationId: 142120077,
    targetType: "Organization",
    repositorySelection: "all",
  });
  assert.equal(output.requiredPermissions.organization_custom_properties, "admin");
  assert.equal(output.requiredPermissions.organization_administration, "write");
  assert.deepEqual(output.requiredEvents, ["repository", "push"]);
  assert.deepEqual(output.permissionExpansionGate, {
    type: "approval",
    state: "HUMAN_REAUTH_REQUIRED",
    operation: "GITHUB_APP_PERMISSION_EXPANSION_AND_INSTALLATION_ACCEPTANCE",
    requiredRole: "organization_owner",
    automaticRetry: false,
    requiredReadback: [
      "app_id",
      "slug",
      "installation_id",
      "repository_selection",
      "suspended_at",
      "permissions",
      "events",
    ],
  });
  assert.equal(output.webhook.appPrivateKeyCredentialId, "shared/github/backoffice-app-private-key");
  assert.equal(output.webhook.credentialId, "shared/github/backoffice-app-webhook");
  assert.equal(output.credentialRecovery.plaintextPolicy.newKeyGenerationAllowed, false);
  assert.deepEqual(
    output.credentialRecovery.mappings.map(({ targetCredentialId }) => targetCredentialId),
    [
      "shared/github/backoffice-app-private-key",
      "shared/github/backoffice-app-webhook",
    ],
  );
  assert.equal(output.credentialRecovery.approvalGate.automaticRetry, false);
  assert.equal(output.staticKeysCreated, false);
  assert.doesNotMatch(JSON.stringify(output), /-----BEGIN|gh[opusr]_|github_pat_/u);
});

test("GitHub App readback은 기존 permission/event를 보존한 최소 union만 계산한다", () => {
  const state = githubAppReadback(
    {
      ...contract.github.app,
    },
    [activeBackofficeInstallation],
  );
  assert.equal(state.identityExact, true);
  assert.equal(state.ready, false);
  assert.deepEqual(state.permissionChanges, [
    { permission: "pull_requests", current: "read", required: "write" },
    { permission: "workflows", current: null, required: "write" },
    { permission: "repository_custom_properties", current: null, required: "write" },
    { permission: "environments", current: null, required: "write" },
    { permission: "administration", current: null, required: "write" },
    { permission: "organization_administration", current: null, required: "write" },
    { permission: "organization_custom_properties", current: null, required: "admin" },
  ]);
  assert.equal(state.permissionUnion.actions, "write");
  assert.equal(state.permissionUnion.checks, "read");
  assert.equal(state.permissionUnion.issues, "write");
  assert.equal(state.permissionUnion.members, "read");
  assert.deepEqual(state.eventAdditions, ["repository"]);
  assert.deepEqual(state.eventUnion, [
    "issue_comment",
    "issues",
    "pull_request",
    "push",
    "repository",
    "workflow_run",
  ]);

  const accepted = githubAppReadback(
    { ...contract.github.app },
    [{
      ...activeBackofficeInstallation,
      permissions: state.permissionUnion,
      events: state.eventUnion,
    }],
  );
  assert.equal(accepted.ready, true);
  assert.equal(accepted.installationAcceptanceRequired, false);
});

test("custom property와 Evaluate ruleset payload는 pilot 두 repo만 겨냥한다", async () => {
  const properties = await render("custom-properties");
  const values = await render("pilot-values");
  const rule = await render("ruleset");
  assert.equal(properties.length, 4);
  assert.ok(properties.every(({ method }) => method === "PUT"));
  assert.deepEqual(
    properties
      .map(({ path }) => path.split("/").at(-1))
      .toSorted(),
    ["fleet-managed", "fleet-profile", "fleet-ruleset", "fleet-state"],
  );
  assert.deepEqual(
    values.map(({ body }) => body.repository_names[0]),
    ["happy-farm", "lizard-tycoon"],
  );
  assert.equal(rule.body.enforcement, "evaluate");
  assert.deepEqual(rule.body.conditions.repository_name.include, [
    "happy-farm",
    "lizard-tycoon",
  ]);
  const required = rule.body.rules.find(
    ({ type }) => type === "required_status_checks",
  );
  assert.equal(
    required.parameters.required_status_checks[0].context,
    "Org Contract / Org Contract",
  );
});

test("GitHub bootstrap 기본 실행은 App 재사용 gate와 additive org dry-run만 출력한다", async () => {
  const result = await execFileAsync(process.execPath, [
    "scripts/fleet/bootstrap-p3-github.mjs",
  ]);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, "DRY_RUN");
  assert.equal(output.organization, "seorilabs");
  assert.equal(output.app.reuseExisting, true);
  assert.equal(output.app.identity.appId, 4124446);
  assert.equal(output.app.permissionExpansionGate.state, "HUMAN_REAUTH_REQUIRED");
  assert.equal(output.app.permissionExpansionGate.automaticRetry, false);
  assert.equal("registrationUrl" in output.app, false);
  assert.equal(output.operations.filter(({ method }) => method === "PUT").length, 4);
  assert.equal(output.operations.filter(({ method }) => method === "PATCH").length, 2);
  assert.equal(output.operations.filter(({ method }) => method === "POST").length, 1);
  assert.doesNotMatch(
    JSON.stringify(output),
    /-----BEGIN|gh[opusr]_|github_pat_|access.?token.?value|refresh.?token.?value/iu,
  );
});

test("GitHub bootstrap apply는 exact 공개 confirmation 없이는 실패한다", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["scripts/fleet/bootstrap-p3-github.mjs", "apply"]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /P3_GITHUB_APPLY_CONFIRMATION_REQUIRED/u);
      assert.doesNotMatch(error.stderr, /token|password|private.?key/iu);
      return true;
    },
  );
});

test("Cloud Build identity는 submitter와 executor를 분리하고 resource 단위 IAM만 선언한다", async () => {
  const output = await render("cloud-build");
  assert.notEqual(
    output.submitter.serviceAccountEmail,
    output.executor.serviceAccountEmail,
  );
  assert.ok(
    output.submitter.bindings.some(
      ({ resource, role }) =>
        resource === output.executor.serviceAccountEmail &&
        role === "roles/iam.serviceAccountUser",
    ),
  );
  assert.ok(
    output.executor.bindings.some(
      ({ resource, role }) =>
        resource === "gs://seorilabs-ci-build-artifacts" &&
        role === "roles/storage.objectAdmin",
    ),
  );
  const serialized = JSON.stringify(output);
  assert.doesNotMatch(serialized, /roles\/(?:owner|editor|viewer)"/u);
  assert.doesNotMatch(serialized, /play|app.?store|publisher|private.?key|service.?account.?key/iu);
});

test("GCP bootstrap 기본 실행은 exact source와 5개 keyless identity의 dry-run만 출력한다", async () => {
  const result = await execFileAsync(process.execPath, [
    "scripts/fleet/bootstrap-p3-gcp.mjs",
  ]);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, "DRY_RUN");
  assert.equal(output.project.id, "seorilabs-ci");
  assert.equal(output.project.number, "321365398093");
  assert.equal(output.serviceAccounts.length, 5);
  assert.equal(new Set(output.serviceAccounts.map(({ email }) => email)).size, 5);
  assert.equal(output.staticKeysCreated, false);
  assert.deepEqual(
    contract.cloudBuild.wif.repositories.map(({ sha256 }) => sha256),
    [
      "c5263a9521a398f5c5ae17b692e22be67dc2feeb9b7da4f8758622c7a29f4bd0",
      "372b565a69de01e59a0570b05e8b49c681abd02114df8e7ba9c29c98c0807db3",
    ],
  );
  assert.equal(
    output.workloadIdentity.github.attributeCondition,
    "assertion.repository_owner_id == '283115031' && " +
      "(assertion.repository_id == '1250442131' || assertion.repository_id == '1265192029') && " +
      "(assertion.job_workflow_ref == 'seorilabs/.github/.github/workflows/rn-build-android-cloud-v1.yml@c328d9bf55f31ba11f53ef06071cc7b76d283617' || " +
      "assertion.job_workflow_ref == 'seorilabs/.github/.github/workflows/godot-build-android-cloud-v1.yml@c328d9bf55f31ba11f53ef06071cc7b76d283617')",
  );
  assert.match(
    output.workloadIdentity.kubernetes.attributeCondition,
    /namespace.*auth-broker/u,
  );
  assert.ok(output.iamBindings.every(({ role }) => !/roles\/(?:owner|editor|viewer)$/u.test(role)));
  const serialized = JSON.stringify(output);
  assert.doesNotMatch(serialized, /private.?key|service.?account.?key|access.?token|refresh.?token/iu);
});

test("GCP bootstrap apply와 rollback은 exact 공개 confirmation 없이는 실패한다", async () => {
  for (const command of ["apply", "rollback"]) {
    await assert.rejects(
      execFileAsync(process.execPath, ["scripts/fleet/bootstrap-p3-gcp.mjs", command]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /P3_GCP_(?:APPLY|ROLLBACK)_CONFIRMATION_REQUIRED/u);
        assert.doesNotMatch(error.stderr, /token|password|private.?key/iu);
        return true;
      },
    );
  }
});

test("GCP apply와 rollback은 두 provider를 preflight하고 기존 IAM을 보존한다", async () => {
  const bootstrapSource = await readFile(gcpBootstrap, "utf8");
  assert.doesNotMatch(bootstrapSource, /remove-iam-policy-binding/u);
  const planResult = await execFileAsync(process.execPath, [gcpBootstrap, "plan"]);
  const plan = JSON.parse(planResult.stdout);
  const directory = await mkdtemp(join(tmpdir(), "seori-p3-gcloud-mock-"));
  const statePath = join(directory, "state.json");
  const mappingObject = (mapping) =>
    Object.fromEntries(
      mapping.split(",").map((entry) => entry.split(/=(.*)/su).slice(0, 2)),
    );
  const providerState = ({
    attributeCondition,
    attributeMapping,
    issuer,
    audience,
    disabled = false,
  }) => ({
    attributeCondition,
    attributeMapping: mappingObject(attributeMapping),
    disabled,
    oidc: { allowedAudiences: [audience], issuerUri: issuer },
  });
  const initialState = {
    projectNumber: plan.project.number,
    serviceAccounts: Object.fromEntries(
      plan.serviceAccounts.map(({ email }) => [email, { email, disabled: false }]),
    ),
    pool: {
      name:
        `projects/${plan.project.number}/locations/global/workloadIdentityPools/` +
        plan.workloadIdentity.pool,
      displayName: "Seorilabs Fleet P3",
      description:
        "Dedicated keyless identities for Fleet Cloud Build and Auth Broker",
      disabled: false,
      state: "ACTIVE",
    },
    providers: {
      [plan.workloadIdentity.github.provider]: providerState(
        plan.workloadIdentity.github,
      ),
      [plan.workloadIdentity.kubernetes.provider]: providerState(
        plan.workloadIdentity.kubernetes,
      ),
    },
    bindings: [
      plan.iamBindings[0],
      {
        resourceType: "project",
        resource: "projects/seorilabs-ci",
        role: "roles/logging.viewer",
        member: "serviceAccount:unrelated@seorilabs-ci.iam.gserviceaccount.com",
      },
    ],
    history: [],
  };
  const environment = {
    ...process.env,
    SEORILABS_GCLOUD_CLI: gcloudMock,
    P3_GCLOUD_MOCK_STATE: statePath,
  };
  const bootstrap = async (command, confirmation) => {
    const args = [gcpBootstrap, command];
    if (confirmation) args.push(confirmation);
    const result = await execFileAsync(process.execPath, args, { env: environment });
    return JSON.parse(result.stdout);
  };
  const readState = async () => JSON.parse(await readFile(statePath, "utf8"));
  const writeState = async (state) =>
    writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  try {
    await writeState(initialState);
    const applied = await bootstrap("apply", plan.confirmation);
    assert.equal(applied.ready, true);
    const appliedState = await readState();
    assert.equal(
      appliedState.bindings.filter(
        (item) => JSON.stringify(item) === JSON.stringify(plan.iamBindings[0]),
      ).length,
      1,
    );
    const bindingSnapshot = structuredClone(appliedState.bindings);

    const kubernetesProvider = plan.workloadIdentity.kubernetes.provider;
    const rollbackDriftState = structuredClone(appliedState);
    rollbackDriftState.history = [];
    rollbackDriftState.providers[kubernetesProvider].attributeCondition +=
      " && false";
    await writeState(rollbackDriftState);
    await assert.rejects(
      bootstrap("rollback", plan.rollbackConfirmation),
      (error) => {
        assert.match(error.stderr, /P3_KUBERNETES_WIF_PROVIDER_DRIFT/u);
        return true;
      },
    );
    const rollbackDriftResult = await readState();
    assert.deepEqual(rollbackDriftResult.history, []);
    assert.equal(
      rollbackDriftResult.providers[plan.workloadIdentity.github.provider]
        .disabled,
      false,
    );

    appliedState.history = [];
    await writeState(appliedState);
    const rolledBack = await bootstrap("rollback", plan.rollbackConfirmation);
    assert.equal(rolledBack.state, "NEW_TOKEN_EXCHANGE_REVOKED");
    assert.equal(rolledBack.iamBindingsMutated, false);
    assert.equal(rolledBack.existingAccessTokensRevoked, false);
    assert.equal(rolledBack.exactBindingsRemoved, 0);
    assert.equal(rolledBack.exactBindingsPreserved, plan.iamBindings.length);
    const rolledBackState = await readState();
    assert.deepEqual(rolledBackState.bindings, bindingSnapshot);
    assert.equal(rolledBackState.history.includes("iam:remove"), false);
    assert.ok(
      Object.values(rolledBackState.providers).every(
        ({ disabled }) => disabled === true,
      ),
    );

    const disabledReadback = await bootstrap("readback");
    assert.equal(disabledReadback.ready, false);
    assert.deepEqual(disabledReadback.workloadIdentityPool, {
      exists: true,
      configurationExact: true,
      disabled: false,
      state: "ACTIVE",
      active: true,
    });
    assert.ok(
      Object.values(disabledReadback.providers).every(
        ({ configurationExact, disabled, active }) =>
          configurationExact === true && disabled === true && active === false,
      ),
    );

    const applyDriftState = structuredClone(rolledBackState);
    applyDriftState.history = [];
    applyDriftState.providers[kubernetesProvider].attributeCondition += " && false";
    await writeState(applyDriftState);
    await assert.rejects(
      bootstrap("apply", plan.confirmation),
      (error) => {
        assert.match(error.stderr, /P3_KUBERNETES_WIF_PROVIDER_DRIFT/u);
        return true;
      },
    );
    const applyDriftResult = await readState();
    assert.deepEqual(applyDriftResult.history, []);
    assert.equal(
      applyDriftResult.providers[plan.workloadIdentity.github.provider].disabled,
      true,
    );

    rolledBackState.history = [];
    await writeState(rolledBackState);

    const reapplied = await bootstrap("apply", plan.confirmation);
    assert.equal(reapplied.ready, true);
    const reappliedState = await readState();
    assert.deepEqual(reappliedState.bindings, bindingSnapshot);
    assert.ok(
      Object.values(reappliedState.providers).every(
        ({ disabled }) => disabled === false,
      ),
    );

    reappliedState.pool.disabled = true;
    await writeState(reappliedState);
    const poolDisabledReadback = await bootstrap("readback");
    assert.equal(poolDisabledReadback.ready, false);
    assert.equal(poolDisabledReadback.workloadIdentityPool.disabled, true);
    assert.equal(poolDisabledReadback.workloadIdentityPool.active, false);
    await assert.rejects(
      bootstrap("apply", plan.confirmation),
      (error) => {
        assert.match(error.stderr, /P3_GCP_WIF_POOL_DISABLED/u);
        return true;
      },
    );

    reappliedState.pool.disabled = false;
    reappliedState.pool.displayName = "drifted";
    await writeState(reappliedState);
    const poolDriftReadback = await bootstrap("readback");
    assert.equal(poolDriftReadback.ready, false);
    assert.equal(poolDriftReadback.workloadIdentityPool.configurationExact, false);
    await assert.rejects(
      bootstrap("apply", plan.confirmation),
      (error) => {
        assert.match(error.stderr, /P3_GCP_WIF_POOL_DRIFT/u);
        return true;
      },
    );

    reappliedState.pool.displayName = "Seorilabs Fleet P3";
    reappliedState.pool.state = "DELETED";
    await writeState(reappliedState);
    const poolStateReadback = await bootstrap("readback");
    assert.equal(poolStateReadback.ready, false);
    assert.equal(poolStateReadback.workloadIdentityPool.configurationExact, true);
    assert.equal(poolStateReadback.workloadIdentityPool.state, "DELETED");
    assert.equal(poolStateReadback.workloadIdentityPool.active, false);
    await assert.rejects(
      bootstrap("apply", plan.confirmation),
      (error) => {
        assert.match(error.stderr, /P3_GCP_WIF_POOL_STATE_INVALID/u);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GCP bootstrap은 canonical wrapper override를 검증하고 public 오류 code만 사용한다", async () => {
  const source = await readFile("scripts/fleet/bootstrap-p3-gcp.mjs", "utf8");
  assert.doesNotMatch(source, /\/Users\//u);
  assert.match(source, /homedir\(\)/u);
  assert.match(source, /SEORILABS_GCLOUD_CLI/u);
  assert.match(source, /realpathSync\(gcloud\) !== gcloud/u);
  assert.match(source, /P3_GCP_CONTRACT_PARSE_FAILED/u);
  assert.match(source, /P3_GCP_WIF_PROVIDER_RESPONSE_INVALID/u);
  assert.match(source, /P3_GCP_IAM_RESPONSE_INVALID/u);
  assert.match(source, /git", \["show", object\]/u);
  assert.match(source, /P3_WORKFLOW_SOURCE_DIGEST_MISMATCH/u);
  const contractChecks = await readFile(
    ".github/workflows/contract-checks.yml",
    "utf8",
  );
  const candidate = await readFile(
    ".github/workflows/workflow-bundle-candidate.yml",
    "utf8",
  );
  assert.match(contractChecks, /fetch-depth: 0/u);
  assert.match(candidate, /fetch-depth: 0/u);
  assert.match(source, /if \(discoveryRaw === null\)/u);
  assert.match(source, /if \(raw === null\)/u);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/fleet/bootstrap-p3-gcp.mjs", "readback"],
      { env: { ...process.env, SEORILABS_GCLOUD_CLI: "relative-gcloud" } },
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /P3_GCLOUD_WRAPPER_INVALID/u);
      return true;
    },
  );
});

test("GitHub bootstrap은 renderer의 API version과 organization drift를 fail-closed한다", async () => {
  const source = await readFile(
    "scripts/fleet/bootstrap-p3-github.mjs",
    "utf8",
  );
  assert.match(
    source,
    /app\.apiVersion !== apiVersion \|\| app\.organization !== organization/u,
  );
  assert.match(source, /P3_GITHUB_CONTRACT_DRIFT/u);
  assert.match(source, /P3_GITHUB_API_RESPONSE_INVALID/u);
});

test("Auth Broker foundation은 RBAC 0권한, exact NetworkPolicy와 cert-manager TLS만 생성한다", async () => {
  const manifest = await render("auth-broker-foundation");
  const serviceAccounts = manifest.items.filter(
    ({ kind }) => kind === "ServiceAccount",
  );
  const role = manifest.items.find(({ kind }) => kind === "Role");
  const certificates = manifest.items.filter(
    ({ kind }) => kind === "Certificate",
  );
  const publicBindings = manifest.items.find(
    ({ kind, metadata }) =>
      kind === "ConfigMap" && metadata.name === "auth-broker-public-bindings",
  );
  const serialized = JSON.stringify(manifest);
  assert.equal(serviceAccounts.length, 3);
  assert.equal(
    new Set(
      serviceAccounts.map(
        ({ metadata }) =>
          metadata.annotations["seorilabs.io/google-service-account"],
      ),
    ).size,
    3,
  );
  assert.ok(
    serviceAccounts.every(
      ({ automountServiceAccountToken, metadata }) =>
        automountServiceAccountToken === false &&
        metadata.annotations["seorilabs.io/workload-identity-status"] ===
          "planned",
    ),
  );
  assert.deepEqual(role.rules, []);
  assert.equal(certificates.length, 8);
  assert.ok(
    certificates.every(({ spec }) =>
      spec.privateKey?.rotationPolicy === "Always",
    ),
  );
  assert.equal(publicBindings.immutable, true);
  assert.match(
    publicBindings.data["bindings.json"],
    /"encryptionStatus": "blocked_unverified"/u,
  );
  assert.match(
    publicBindings.data["bindings.json"],
    /"imagePullSecretName": "seori-auth-ghcr-pull"/u,
  );
  assert.match(
    publicBindings.data["bindings.json"],
    /"credentialId": "shared\/github\/operator"/u,
  );
  assert.doesNotMatch(serialized, /"kind":"Secret"|"stringData"/u);
  assert.doesNotMatch(serialized, /"kind":"(?:Deployment|StatefulSet|PersistentVolumeClaim)"/u);
  assert.doesNotMatch(serialized, /0\.0\.0\.0\/0|"ipBlock"/u);
});

test("Auth Broker rollback manifest는 namespace를 보존하고 foundation 객체만 겨냥한다", async () => {
  const manifest = await render("auth-broker-foundation-rollback");
  assert.equal(manifest.kind, "List");
  assert.ok(manifest.items.length > 0);
  assert.ok(manifest.items.every(({ kind }) => kind !== "Namespace"));
  assert.ok(
    manifest.items.every(({ metadata }) => metadata.namespace === "auth-broker"),
  );
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /"kind":"(?:Secret|PersistentVolumeClaim|StatefulSet|Deployment)"/u,
  );
});

test("알 수 없는 P3 render 명령은 공개 code만 남기고 실패한다", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [script, "apply"]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /P3_COMMAND_INVALID/u);
      assert.doesNotMatch(error.stderr, /token|password|private.?key/iu);
      return true;
    },
  );
});
