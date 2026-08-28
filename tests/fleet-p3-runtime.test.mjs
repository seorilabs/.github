import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const script = "scripts/fleet/render-p3-runtime.mjs";
const contract = parse(await readFile("contracts/fleet-p3-runtime.yaml", "utf8"));
const schema = JSON.parse(
  await readFile("contracts/fleet-p3-runtime.schema.json", "utf8"),
);

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

test("GitHub App bootstrap은 secret 없는 사람 전용 등록 URL과 webhook 계약만 만든다", async () => {
  const output = await render("github-app");
  const url = new URL(output.registrationUrl);
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.pathname, "/organizations/seorilabs/settings/apps/new");
  assert.equal(url.searchParams.get("public"), "false");
  assert.equal(url.searchParams.get("webhook_active"), "true");
  assert.equal(url.searchParams.get("request_oauth_on_install"), "false");
  assert.deepEqual(url.searchParams.getAll("events[]"), ["repository", "push"]);
  assert.equal(url.searchParams.get("organization_custom_properties"), "admin");
  assert.equal(url.searchParams.get("organization_administration"), "write");
  assert.equal(url.searchParams.has("webhook_secret"), false);
  assert.equal(output.humanOnly, true);
  assert.deepEqual(output.approvalGate, {
    type: "approval",
    state: "HUMAN_REAUTH_REQUIRED",
    operation: "GITHUB_APP_BOOTSTRAP",
    requiredRole: "organization_owner",
    automaticRetry: false,
    requiredReadback: [
      "app_id",
      "client_id",
      "slug",
      "installation_id",
      "webhook_active",
    ],
  });
  assert.equal(output.webhookSecretRequired, true);
  assert.equal(output.webhookCredentialId, "shared/github/fleet-app-webhook");
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

test("GitHub bootstrap 기본 실행은 사람 전용 App gate와 additive org dry-run만 출력한다", async () => {
  const result = await execFileAsync(process.execPath, [
    "scripts/fleet/bootstrap-p3-github.mjs",
  ]);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, "DRY_RUN");
  assert.equal(output.organization, "seorilabs");
  assert.equal(output.app.approvalGate.state, "HUMAN_REAUTH_REQUIRED");
  assert.equal(output.app.approvalGate.automaticRetry, false);
  assert.equal(output.operations.filter(({ method }) => method === "PUT").length, 4);
  assert.equal(output.operations.filter(({ method }) => method === "PATCH").length, 2);
  assert.equal(output.operations.filter(({ method }) => method === "POST").length, 1);
  assert.doesNotMatch(
    JSON.stringify(output),
    /webhook_secret|private.?key|access.?token|refresh.?token/iu,
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

test("GCP bootstrap은 사용자 홈을 하드코딩하지 않고 public 오류 code만 사용한다", async () => {
  const source = await readFile("scripts/fleet/bootstrap-p3-gcp.mjs", "utf8");
  assert.doesNotMatch(source, /\/Users\//u);
  assert.match(source, /homedir\(\)/u);
  assert.match(source, /P3_GCP_CONTRACT_PARSE_FAILED/u);
  assert.match(source, /if \(discoveryRaw === null\)/u);
  assert.match(source, /if \(raw === null\)/u);
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
