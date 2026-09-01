import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const bootstrapPath = "scripts/fleet/bootstrap-p3-gcp.mjs";
const secretBootstrapPath = "scripts/fleet/bootstrap-p3-secret-manager.mjs";
const gcloudMock = fileURLToPath(new URL("./fixtures/p3-gcloud-mock.mjs", import.meta.url));
const plan = JSON.parse((await execFileAsync(process.execPath, [bootstrapPath, "plan"])).stdout);
const secretPlan = JSON.parse((await execFileAsync(process.execPath, [secretBootstrapPath, "plan"])).stdout);

function initialState() {
  return {
    projectNumber: plan.project.number,
    services: plan.requiredServices,
    serviceAccounts: Object.fromEntries(
      plan.serviceAccounts.map(({ email }) => [email, { email, disabled: false }]),
    ),
    pool: {
      name: `projects/${plan.project.number}/locations/global/workloadIdentityPools/${plan.workloadIdentity.pool}`,
      displayName: "Seorilabs Fleet P3",
      description: "Dedicated keyless identities for Fleet Cloud Build and Auth Broker",
      disabled: false,
      state: "ACTIVE",
    },
    providers: Object.fromEntries(
      [plan.workloadIdentity.github, plan.workloadIdentity.kubernetes].map((provider) => [
        provider.provider,
        {
          attributeCondition: provider.attributeCondition,
          attributeMapping: Object.fromEntries(
            provider.attributeMapping.split(",").map((entry) => entry.split(/=(.*)/su).slice(0, 2)),
          ),
          disabled: false,
          oidc: { issuerUri: provider.issuer, allowedAudiences: [provider.audience] },
        },
      ]),
    ),
    bindings: structuredClone(plan.iamBindings),
    secrets: Object.fromEntries(secretPlan.resources.map((resource) => [
      resource.secretId,
      {
        name: `projects/${plan.project.number}/secrets/${resource.secretId}`,
        versions: [{
          name: `projects/${plan.project.number}/secrets/${resource.secretId}/versions/${resource.version}`,
          state: "ENABLED",
        }],
      },
    ])),
    history: [],
  };
}

const deniedDiagnostic =
  "ERROR: (gcloud.iam.workload-identity-pools.describe) PERMISSION_DENIED: resource does not exist or access is denied; synthetic-sensitive-diagnostic\n";

for (const { name, prefix, stderr, stdout, code, command = "apply", script = bootstrapPath } of [
  {
    name: "pool 권한 거부를 리소스 부재로 오판하지 않는다",
    prefix: ["iam", "workload-identity-pools", "describe"],
    stderr: deniedDiagnostic,
    code: "P3_GCP_WIF_POOL_READ_FAILED",
  },
  {
    name: "stdout NOT_FOUND가 stderr 권한 거부를 덮어쓰지 않는다",
    prefix: ["iam", "workload-identity-pools", "describe"],
    stderr: "PERMISSION_DENIED: synthetic-sensitive-diagnostic\n",
    stdout: "NOT_FOUND\n",
    code: "P3_GCP_WIF_POOL_READ_FAILED",
  },
  {
    name: "provider 인증 실패 문구의 not found를 부재로 오판하지 않는다",
    prefix: ["iam", "workload-identity-pools", "providers", "describe"],
    stderr: "UNAUTHENTICATED: credential not found; synthetic-sensitive-diagnostic\n",
    code: "P3_GCP_WIF_PROVIDER_READ_FAILED",
  },
  {
    name: "service account 권한 거부 뒤 계정을 생성하지 않는다",
    prefix: ["iam", "service-accounts", "describe"],
    stderr: deniedDiagnostic,
    code: "P3_GCP_SERVICE_ACCOUNT_READ_FAILED",
  },
  {
    name: "project 조회 NOT_FOUND는 필수 사전 검사 실패다",
    prefix: ["projects", "describe"],
    stderr: "NOT_FOUND\n",
    code: "P3_GCP_PROJECT_READ_FAILED",
  },
  {
    name: "API 목록 NOT_FOUND 뒤 enable을 시도하지 않는다",
    prefix: ["services", "list"],
    stderr: "NOT_FOUND\n",
    code: "P3_GCP_REQUIRED_SERVICES_READ_FAILED",
  },
  {
    name: "IAM 변경 NOT_FOUND 뒤 나머지 변경을 계속하지 않는다",
    prefix: ["projects", "add-iam-policy-binding"],
    stderr: "NOT_FOUND\n",
    code: "P3_GCP_IAM_BINDING_APPLY_FAILED",
  },
  {
    name: "IAM 조회 권한 거부를 미설정 binding으로 오판하지 않는다",
    prefix: ["projects", "get-iam-policy"],
    stderr: deniedDiagnostic,
    code: "P3_GCP_PROJECT_IAM_READ_FAILED",
    command: "readback",
  },
  {
    name: "Secret Manager provider 권한 거부를 부재로 오판하지 않는다",
    script: secretBootstrapPath,
    prefix: ["iam", "workload-identity-pools", "providers", "describe"],
    stderr: deniedDiagnostic,
    code: "P3_SECRET_MANAGER_WIF_PROVIDER_READ_FAILED",
  },
  {
    name: "Secret Manager 조회 권한 거부를 부재로 오판하지 않는다",
    script: secretBootstrapPath,
    prefix: ["secrets", "describe"],
    stderr: deniedDiagnostic,
    code: "P3_SECRET_MANAGER_RESOURCE_READ_FAILED",
  },
  {
    name: "Secret Manager 버전 조회 실패를 빈 목록으로 오판하지 않는다",
    script: secretBootstrapPath,
    prefix: ["secrets", "versions", "list"],
    stderr: "NOT_FOUND\n",
    code: "P3_SECRET_MANAGER_VERSION_READ_FAILED",
  },
  {
    name: "Secret Manager IAM 조회 권한 거부 뒤 접근을 부여하지 않는다",
    script: secretBootstrapPath,
    prefix: ["secrets", "get-iam-policy"],
    stderr: deniedDiagnostic,
    code: "P3_SECRET_MANAGER_IAM_READ_FAILED",
  },
  {
    name: "Secret Manager IAM 변경 NOT_FOUND 뒤 나머지 변경을 계속하지 않는다",
    script: secretBootstrapPath,
    prefix: ["secrets", "add-iam-policy-binding"],
    stderr: "NOT_FOUND\n",
    code: "P3_SECRET_MANAGER_IAM_APPLY_FAILED",
  },
]) {
  test(`GCP ${name}`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "seori-p3-read-errors-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const statePath = join(directory, "state.json");
    const state = initialState();
    state.commandFailures = [{ prefix, stderr, stdout }];
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const args = [script, command];
    if (command === "apply") args.push(script === bootstrapPath ? plan.confirmation : secretPlan.confirmation);
    await assert.rejects(
      execFileAsync(process.execPath, args, {
        env: { ...process.env, SEORILABS_GCLOUD_CLI: gcloudMock, P3_GCLOUD_MOCK_STATE: statePath },
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, "");
        assert.deepEqual(JSON.parse(error.stderr), { ok: false, code });
        assert.doesNotMatch(error.stderr, /synthetic-sensitive-diagnostic/u);
        return true;
      },
    );
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).history, []);
  });
}

for (const notFoundDiagnostic of [
  "NOT_FOUND\n",
  "WARNING: diagnostic prefix\nERROR: (gcloud.iam.workload-identity-pools.describe) NOT_FOUND: Requested entity was not found.\n",
]) {
  test(`GCP optional 조회는 명확한 NOT_FOUND만 부재로 기록한다: ${notFoundDiagnostic.split("\n")[0]}`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "seori-p3-confirmed-missing-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const statePath = join(directory, "state.json");
    const state = initialState();
    state.serviceAccounts = {};
    state.pool = null;
    state.providers = {};
    state.bindings = [];
    state.notFoundDiagnostic = notFoundDiagnostic;
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const result = await execFileAsync(process.execPath, [bootstrapPath, "readback"], {
      env: { ...process.env, SEORILABS_GCLOUD_CLI: gcloudMock, P3_GCLOUD_MOCK_STATE: statePath },
    });
    const readback = JSON.parse(result.stdout);
    assert.equal(result.stderr, "");
    assert.equal(readback.ready, false);
    assert.equal(readback.workloadIdentityPool.exists, false);
    assert.equal(readback.providers.github.exists, false);
    assert.equal(readback.providers.kubernetes.exists, false);
    assert.ok(readback.serviceAccounts.every(({ exists }) => exists === false));
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).history, []);
  });
}

for (const script of [bootstrapPath, secretBootstrapPath]) {
  test(`${script}는 binding 없는 정상 IAM 정책을 오류 없이 읽는다`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "seori-p3-empty-policy-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const statePath = join(directory, "state.json");
    const state = initialState();
    state.bindings = [];
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const result = await execFileAsync(process.execPath, [script, "readback"], {
      env: { ...process.env, SEORILABS_GCLOUD_CLI: gcloudMock, P3_GCLOUD_MOCK_STATE: statePath },
    });
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).ready, false);
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).history, []);
  });

  test(`${script}는 기존 기한부 권한을 보존하고 조건 없는 운영 권한을 명시한다`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "seori-p3-conditional-policy-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const statePath = join(directory, "state.json");
    const state = initialState();
    const target = script === bootstrapPath
      ? { resourceType: "project", resource: `projects/${plan.project.id}` }
      : { resourceType: "secret", resource: `projects/${plan.project.id}/secrets/${secretPlan.resources[0].secretId}` };
    state.conditionalPolicies = [{
      ...target,
      bindings: [{
        role: "roles/iam.securityAdmin",
        members: ["serviceAccount:approved-installer@example.iam.gserviceaccount.com"],
        condition: {
          title: "fleet-p3-bootstrap",
          expression: "request.time < timestamp('2026-09-01T15:46:47Z')",
        },
      }],
    }];
    await writeFile(statePath, JSON.stringify(state), "utf8");
    const confirmation = script === bootstrapPath ? plan.confirmation : secretPlan.confirmation;
    const result = await execFileAsync(process.execPath, [script, "apply", confirmation], {
      env: { ...process.env, SEORILABS_GCLOUD_CLI: gcloudMock, P3_GCLOUD_MOCK_STATE: statePath },
    });
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).ready, true);
    const applied = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(applied.conditionalPolicies, state.conditionalPolicies);
    assert.ok(applied.history.includes("iam:add"));
  });
}
