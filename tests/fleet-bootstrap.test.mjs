import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  createFleetWebhookHandler,
  fleetBootstrapContract,
  validateFleetBootstrapPlan,
} from "../packages/repo-contract/src/bootstrap.mjs";
import {
  createWorkflowBundle,
  loadApprovedWorkflowBundle,
  loadResolvedCallerBinding,
  promoteWorkflowBundle,
} from "../packages/repo-contract/src/fleet.mjs";

const ORGANIZATION_ID = "4242";
const INSTALLATION_ID = "9001";
const REPOSITORY_ID = "7001";
const SOURCE_SHA = "d".repeat(40);
const BUNDLE_SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const SECRET = Buffer.from("fleet-webhook-secret-material-00001", "utf8");
const PLATFORM_RELEASE = Object.freeze({
  sourceSha: "c".repeat(40),
  contractRevision: DIGEST,
  typescript: { version: "1.2.3", digest: DIGEST },
  gdscript: { version: "1.2.3", digest: DIGEST },
});
const EVIDENCE = Object.freeze(
  ["react-native", "godot"].map((profile, index) => ({
    profile,
    repositoryId: 123 + index,
    sourceSha: "e".repeat(40),
    runId: 456 + index,
    artifactSha256: DIGEST,
  })),
);

let approvedBundleBinding;
let validatePlan;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function textDigest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function trustedSourceReadbackFor(bundle) {
  return async ({ repository, sourceSha }) => ({
    repository,
    sourceSha,
    contractDigests: structuredClone(bundle.quality.contractDigests),
    runtimeAssetDigests: structuredClone(bundle.quality.runtimeAssetDigests),
    workflowBundleSchemaText: await readFile(
      "contracts/workflow-bundle.schema.json",
      "utf8",
    ),
    runtimeAssetContents: Object.fromEntries(
      await Promise.all(
        Object.keys(bundle.quality.runtimeAssetDigests).map(async (path) => [
          path,
          await readFile(path, "utf8"),
        ]),
      ),
    ),
  });
}

test.before(async () => {
  const planSchema = JSON.parse(
    await readFile("contracts/fleet-bootstrap-plan.schema.json", "utf8"),
  );
  validatePlan = new Ajv2020({
    strict: true,
    validateFormats: false,
  }).compile(planSchema);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const registry = new Map();
  const candidate = await createWorkflowBundle({
    sourceSha: BUNDLE_SHA,
    platformRelease: PLATFORM_RELEASE,
  });
  const trustedWorkflowSourceReadback = trustedSourceReadbackFor(candidate);
  const approved = await promoteWorkflowBundle(candidate, EVIDENCE, {
    evidenceVerifier: async () => true,
    approvalSigner: { keyId: "fleet-bootstrap-test", privateKey },
    trustedWorkflowSourceReadback,
    registryPublisher: async (record) => {
      registry.set(record.subject, structuredClone(record));
      return record;
    },
  });
  approvedBundleBinding = await loadApprovedWorkflowBundle(approved, {
    trustedApprovalKeys: new Map([["fleet-bootstrap-test", publicKey]]),
    trustedRegistryReadback: async ({ subject }) => registry.get(subject),
    trustedWorkflowSourceReadback,
  });
});

function repositoryPayload({
  action = "created",
  archived = false,
  defaultBranch = "main",
  isPrivate = true,
  fullName = "seorilabs/example-app",
} = {}) {
  return {
    action,
    installation: { id: Number(INSTALLATION_ID) },
    organization: { id: Number(ORGANIZATION_ID), login: "seorilabs" },
    repository: {
      id: Number(REPOSITORY_ID),
      full_name: fullName,
      private: isPrivate,
      archived,
      default_branch: defaultBranch,
      owner: { id: Number(ORGANIZATION_ID), login: "seorilabs" },
    },
  };
}

async function callerBinding({
  fullName = "seorilabs/example-app",
  profile = "react-native",
} = {}) {
  const repositoryContext = {
    repositoryId: REPOSITORY_ID,
    fullName,
    sourceSha: SOURCE_SHA,
  };
  return loadResolvedCallerBinding(repositoryContext, {
    trustedResolvedManifestReadback: async () => ({
      state: "ACTIVE",
      repositoryId: REPOSITORY_ID,
      fullName,
      sourceSha: SOURCE_SHA,
      sourceRef: "refs/heads/main",
      observationId: "cm-observation-1",
      sourcePayloadDigest: DIGEST,
      profile,
      packageManager: "pnpm",
      workingDirectory: ".",
      configId: "cm1234567890",
      configRevision: 1,
      snapshotDigest: "f".repeat(64),
      configSignatureDigest: `sha256:${"1".repeat(64)}`,
    }),
  });
}

function signedRequest(payload, {
  deliveryId = "delivery-0001",
  eventName = "repository",
  secret = SECRET,
} = {}) {
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    eventName,
    deliveryId,
    rawBody,
    signature: `sha256=${createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex")}`,
    approvedBundleBinding,
  };
}

async function harness({
  payload = repositoryPayload(),
  resolution,
  readback,
  readRepository,
  observed,
  claimDelivery,
  completeDelivery,
  loadWebhookSecret,
} = {}) {
  const binding = resolution ? undefined : await callerBinding({
    fullName: payload.repository.full_name,
  });
  const claims = new Map();
  let loadedSecret;
  const rawHandler = createFleetWebhookHandler({
    organizationId: ORGANIZATION_ID,
    installationId: INSTALLATION_ID,
    loadWebhookSecret:
      loadWebhookSecret ??
      (async ({ credentialId }) => {
        assert.equal(credentialId, fleetBootstrapContract.webhookCredentialId);
        loadedSecret = Buffer.from(SECRET);
        return loadedSecret;
      }),
    claimDelivery:
      claimDelivery ??
      (async ({ deliveryId, payloadDigest: digest }) => {
        if (!claims.has(deliveryId)) {
          claims.set(deliveryId, { digest, state: "CLAIMED" });
          return "CLAIMED";
        }
        const claim = claims.get(deliveryId);
        if (claim.digest !== digest) return "CONFLICT";
        return claim.state === "COMPLETED" ? "COMPLETED" : "RESUME";
      }),
    completeDelivery:
      completeDelivery ??
      (async ({ deliveryId, payloadDigest: digest, planDigest, plan }) => {
        const claim = claims.get(deliveryId);
        assert.equal(claim?.digest, digest);
        assert.equal(planDigest, textDigest(JSON.stringify(canonicalize(plan))));
        claims.set(deliveryId, { digest, state: "COMPLETED", planDigest });
        return { state: "COMPLETED", planDigest };
      }),
    readRepository:
      readRepository ??
      (async () =>
        readback ?? {
          repositoryId: Number(REPOSITORY_ID),
          fullName: payload.repository.full_name,
          organizationId: Number(ORGANIZATION_ID),
          private: payload.repository.private,
          archived: payload.repository.archived,
          defaultBranch: payload.repository.default_branch,
          sourceSha: payload.repository.default_branch === null ? null : SOURCE_SHA,
        }),
    resolveCallerBinding: async () =>
      resolution ?? { status: "ACTIVE", binding },
    readObservedState: async () =>
      observed ?? {
        customProperties: {},
        environments: [],
        callerDigest: null,
        bootstrapPullRequest: null,
        autonomousOpenPullRequestCount: 0,
      },
  });
  const handler = async (request) => {
    const result = await rawHandler(request);
    assert.equal(validatePlan(result), true, JSON.stringify(validatePlan.errors));
    return result;
  };
  return { handler, claims, getLoadedSecret: () => loadedSecret };
}

test("서명된 신규 private repo는 중앙 caller bootstrap 계획을 만든다", async () => {
  const payload = repositoryPayload();
  const { handler, getLoadedSecret } = await harness({ payload });
  const result = await handler(signedRequest(payload));

  assert.equal(result.outcome, "READY");
  assert.equal(result.repository.id, REPOSITORY_ID);
  assert.deepEqual(
    result.operations.map(({ kind }) => kind),
    [
      "control-plane.repository.observe",
      "github.custom-properties.ensure",
      "github.environment.ensure",
      "github.bootstrap-pull-request.ensure",
    ],
  );
  const pullRequest = result.operations.at(-1).payload;
  assert.equal(pullRequest.maximumOpenAutonomousPullRequests, 1);
  assert.equal(pullRequest.baseRef, "main");
  assert.match(
    pullRequest.content,
    /seorilabs\/\.github\/\.github\/workflows\/rn-static-checks-v2\.yml@[0-9a-f]{40}/u,
  );
  assert.doesNotMatch(pullRequest.content, /secrets:\s*inherit/u);
  assert.equal(textDigest(pullRequest.content), pullRequest.contentDigest);
  assert.ok(getLoadedSecret().every((value) => value === 0));
  assert.doesNotMatch(JSON.stringify(result), /fleet-webhook-secret/u);
});

test("위조 서명은 payload 파싱과 provider readback 전에 거부된다", async () => {
  const payload = repositoryPayload();
  let readCount = 0;
  const { handler } = await harness({
    payload,
    loadWebhookSecret: async () => Buffer.from(SECRET),
    readRepository: async () => {
      readCount += 1;
      throw new Error("must not run");
    },
  });
  const request = signedRequest(payload);
  request.signature = `sha256=${"0".repeat(64)}`;
  await assert.rejects(handler(request), /WEBHOOK_AUTH_FAILED/u);
  assert.equal(readCount, 0);
});

test("trusted adapter 오류 상세는 public error로 전파되지 않는다", async () => {
  const payload = repositoryPayload();
  const invalidSecret = await harness({
    payload,
    loadWebhookSecret: async () => "sensitive-loader-detail",
  });
  await assert.rejects(
    invalidSecret.handler(signedRequest(payload)),
    (error) =>
      error.message === "WEBHOOK_AUTH_FAILED" &&
      !error.message.includes("sensitive-loader-detail"),
  );

  const failedReadback = await harness({
    payload,
    readRepository: async () => {
      throw new Error("provider-token-sensitive-detail");
    },
  });
  await assert.rejects(
    failedReadback.handler(
      signedRequest(payload, { deliveryId: "delivery-readback-error" }),
    ),
    (error) =>
      error.message === "REPOSITORY_READBACK_FAILED" &&
      !error.message.includes("provider-token-sensitive-detail"),
  );
});

test("같은 delivery는 provider readback 뒤에도 한 번만 계획된다", async () => {
  const payload = repositoryPayload();
  const { handler } = await harness({ payload });
  const request = signedRequest(payload);
  const first = await handler(request);
  const second = await handler(request);

  assert.equal(first.outcome, "READY");
  assert.equal(second.outcome, "DUPLICATE");
  assert.deepEqual(second.operations, []);
});

test("durable plan 저장 실패 뒤 같은 delivery를 RESUME한다", async () => {
  const payload = repositoryPayload();
  let completionAttempts = 0;
  const { handler } = await harness({
    payload,
    completeDelivery: async ({ planDigest }) => {
      completionAttempts += 1;
      if (completionAttempts === 1) throw new Error("TRANSIENT_STORE_FAILURE");
      return { state: "COMPLETED", planDigest };
    },
  });
  const request = signedRequest(payload);

  await assert.rejects(handler(request), /WEBHOOK_DELIVERY_COMPLETION_FAILED/u);
  const resumed = await handler(request);
  assert.equal(resumed.outcome, "READY");
  assert.equal(completionAttempts, 2);
});

test("여러 discovery 후보는 추측 없이 needs_input으로 중단된다", async () => {
  const payload = repositoryPayload();
  const { handler } = await harness({
    payload,
    resolution: { status: "NEEDS_INPUT", reason: "MULTIPLE_CANDIDATES" },
  });
  const result = await handler(signedRequest(payload));

  assert.equal(result.outcome, "NEEDS_INPUT");
  assert.equal(result.reason, "MULTIPLE_CANDIDATES");
  assert.deepEqual(result.operations.map(({ kind }) => kind), [
    "control-plane.repository.observe",
  ]);
});

test("main이 아닌 기본 브랜치와 empty repo는 caller PR을 만들지 않는다", async () => {
  const developPayload = repositoryPayload({ defaultBranch: "develop" });
  const develop = await harness({ payload: developPayload });
  const developResult = await develop.handler(signedRequest(developPayload));
  assert.equal(developResult.reason, "DEFAULT_BRANCH_NOT_MAIN");
  assert.doesNotMatch(JSON.stringify(developResult), /bootstrap-pull-request/u);

  const emptyPayload = repositoryPayload({ defaultBranch: null });
  const empty = await harness({ payload: emptyPayload });
  const emptyResult = await empty.handler(
    signedRequest(emptyPayload, { deliveryId: "delivery-empty" }),
  );
  assert.equal(emptyResult.reason, "EMPTY_REPOSITORY");
  assert.doesNotMatch(JSON.stringify(emptyResult), /bootstrap-pull-request/u);
});

test("archive 이벤트는 Backoffice archive만 계획하고 GitHub를 수정하지 않는다", async () => {
  const payload = repositoryPayload({ action: "archived", archived: true });
  const { handler } = await harness({ payload });
  const result = await handler(signedRequest(payload));

  assert.equal(result.outcome, "ARCHIVED");
  assert.deepEqual(result.operations.map(({ kind }) => kind), [
    "control-plane.repository.archive",
  ]);
});

test("repo당 자율 PR 슬롯이 차면 caller PR을 추가하지 않는다", async () => {
  const payload = repositoryPayload();
  const { handler } = await harness({
    payload,
    observed: {
      customProperties: {
        "fleet-managed": "true",
        "fleet-ruleset": "evaluate",
        "fleet-profile": "react-native",
        "fleet-state": "active",
      },
      environments: ["internal"],
      callerDigest: null,
      bootstrapPullRequest: null,
      autonomousOpenPullRequestCount: 1,
    },
  });
  const result = await handler(signedRequest(payload));

  assert.equal(result.outcome, "WAITING_FOR_PR_SLOT");
  assert.equal(result.reason, "AUTONOMOUS_PR_LIMIT_REACHED");
  assert.doesNotMatch(JSON.stringify(result), /bootstrap-pull-request/u);
});

test("기존 bootstrap PR은 새 PR 대신 같은 번호를 update한다", async () => {
  const payload = repositoryPayload();
  const { handler } = await harness({
    payload,
    observed: {
      customProperties: {},
      environments: [],
      callerDigest: null,
      bootstrapPullRequest: {
        number: 17,
        headRef: `seori/fleet-bootstrap/${REPOSITORY_ID}`,
        sourceSha: "9".repeat(40),
        contentDigest: `sha256:${"8".repeat(64)}`,
      },
      autonomousOpenPullRequestCount: 1,
    },
  });
  const result = await handler(signedRequest(payload));
  const pullRequestOperations = result.operations.filter(({ kind }) =>
    kind.startsWith("github.bootstrap-pull-request"),
  );

  assert.equal(pullRequestOperations.length, 1);
  assert.equal(pullRequestOperations[0].kind, "github.bootstrap-pull-request.update");
  assert.equal(pullRequestOperations[0].payload.number, 17);
});

test("numeric org/repo/install identity와 push SHA readback은 exact match다", async () => {
  const wrongOrg = repositoryPayload();
  wrongOrg.organization.id += 1;
  const wrongOrgHarness = await harness({ payload: wrongOrg });
  await assert.rejects(
    wrongOrgHarness.handler(signedRequest(wrongOrg)),
    /WEBHOOK_REPOSITORY_IDENTITY_INVALID/u,
  );

  const pushPayload = repositoryPayload();
  delete pushPayload.action;
  pushPayload.ref = "refs/heads/main";
  pushPayload.after = "1".repeat(40);
  const push = await harness({ payload: pushPayload });
  await assert.rejects(
    push.handler(
      signedRequest(pushPayload, {
        deliveryId: "delivery-push",
        eventName: "push",
      }),
    ),
    /REPOSITORY_READBACK_MISMATCH/u,
  );
});

test("public repo는 ARC bootstrap 없이 명시적 정책 입력을 요구한다", async () => {
  const payload = repositoryPayload({ isPrivate: false });
  const { handler } = await harness({ payload });
  const result = await handler(signedRequest(payload));

  assert.equal(result.outcome, "NEEDS_INPUT");
  assert.equal(result.reason, "PUBLIC_REPOSITORY_REQUIRES_POLICY");
  assert.doesNotMatch(JSON.stringify(result), /bootstrap-pull-request/u);
});

test("public output은 logical credential ID만 가지며 secret export API가 없다", () => {
  assert.equal(
    fleetBootstrapContract.webhookCredentialId,
    "shared/github/fleet-app-webhook",
  );
  assert.deepEqual(Object.keys(fleetBootstrapContract).sort(), [
    "defaultBranch",
    "defaultRef",
    "maximumWebhookBytes",
    "organizationLogin",
    "webhookCredentialId",
  ]);
  assert.equal(Object.hasOwn(fleetBootstrapContract, "secret"), false);
});

test("완료 plan과 nested operation payload는 불변이다", async () => {
  const payload = repositoryPayload();
  const { handler } = await harness({ payload });
  const result = await handler(signedRequest(payload));

  assert.throws(() => result.operations.push({}), TypeError);
  assert.throws(
    () => {
      result.operations[0].payload.state = "mutated";
    },
    TypeError,
  );
});

test("plan validator는 unknown field와 secret-shaped 확장을 거부한다", async () => {
  const payload = repositoryPayload();
  const { handler } = await harness({ payload });
  const valid = await handler(signedRequest(payload));
  const forged = structuredClone(valid);
  forged.secret = "not-allowed";

  assert.deepEqual(await validateFleetBootstrapPlan(valid), {
    ok: true,
    diagnostics: [],
  });
  const rejected = await validateFleetBootstrapPlan(forged);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.diagnostics.includes("PLAN_SCHEMA_ADDITIONALPROPERTIES"));
  assert.doesNotMatch(JSON.stringify(rejected), /not-allowed/u);
});
