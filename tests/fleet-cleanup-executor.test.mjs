import assert from "node:assert/strict";
import { before, test } from "node:test";

import {
  computeFleetCleanupApprovalScopeDigest,
  createTrustedFleetCleanupExecutor,
  createTrustedFleetCleanupGitHubAdapter,
  trustedFleetCleanupExecutorContract,
  validateFleetCleanupExecutionReceipt,
} from "../packages/repo-contract/src/trusted-cleanup-executor.mjs";
import {
  INSTALLATION_ID,
  ORGANIZATION_ID,
  canonicalJson,
  cleanupExecutionRequest,
  digest,
  makeAuthoritativeCleanupFixture,
  makeCleanupGitHubProvider,
  makeCleanupStateProvider,
} from "./helpers/fleet-cleanup-executor-fixtures.mjs";

let base;

before(async () => {
  base = await makeAuthoritativeCleanupFixture({ count: 38 });
});

function targetRepository(classification = "PRODUCT_APP") {
  return base.plan.repositories.find(
    (repository) =>
      repository.classification === classification &&
      repository.changes.length > 0,
  );
}

function runtime({
  repository = targetRepository(),
  githubFault,
  stateFault,
  clock = () => base.executionNowMs,
} = {}) {
  const github = makeCleanupGitHubProvider({
    plan: base.plan,
    issuance: base.issuance,
    repositoryId: repository.repositoryId,
    now: clock,
    fault: githubFault,
  });
  const durable = makeCleanupStateProvider({ now: clock, fault: stateFault });
  const executor = createTrustedFleetCleanupExecutor({
    organizationId: ORGANIZATION_ID,
    installationId: INSTALLATION_ID,
    inventoryPublicKey: base.keys.publicKey,
    githubAdapter: github.adapter,
    stateStore: durable.store,
    clock,
  });
  return { clock, durable, executor, github, repository };
}

function recomputeReceiptDigest(receipt) {
  const durable = structuredClone(receipt);
  delete durable.receiptDigest;
  delete durable.replayed;
  return digest(canonicalJson(durable));
}

function recomputeLedgerDigest(receipt) {
  return digest(
    canonicalJson({
      contract: "seorilabs-fleet-cleanup-ledger-steps-v1",
      steps: receipt.ledger.steps.map(
        ({ kind, operationId, receiptDigest }) => ({
          kind,
          operationId,
          receiptDigest,
        }),
      ),
    }),
  );
}

test("2-repo fixture는 PLAN_ONLY 비권위 상태라 mutation adapter 호출 전에 차단한다", async () => {
  const small = await makeAuthoritativeCleanupFixture({ count: 2 });
  assert.equal(small.plan.mode, "PLAN_ONLY");
  assert.equal(small.plan.executionAllowed, false);
  assert.equal(small.plan.repositories.length, 2);
  assert.notEqual(small.plan.outcome, "READY_FOR_REVIEW");

  const current = runtime();
  await assert.rejects(
    current.executor.execute(
      small.collection,
      small.plan,
      cleanupExecutionRequest(current.repository.repositoryId),
    ),
    /FLEET_CLEANUP_AUTHORITATIVE_INVENTORY_INVALID/u,
  );
  assert.equal(current.github.state.calls.readMutationGuard, 0);
  assert.equal(current.durable.state.reserveCalls, 0);
});

test("38-repo authoritative plan에서 repo 하나만 새 branch의 Ready PR 하나로 만든다", async () => {
  const current = runtime();
  assert.equal(base.plan.mode, "PLAN_ONLY");
  assert.equal(base.plan.executionAllowed, false);
  assert.equal(base.plan.outcome, "READY_FOR_REVIEW");
  assert.equal(base.plan.repositories.length, 38);

  const request = cleanupExecutionRequest(current.repository.repositoryId);
  const receipt = await current.executor.execute(
    base.issuance,
    base.plan,
    request,
  );

  assert.equal(receipt.state, "READY_PR_CREATED");
  assert.equal(receipt.replayed, false);
  assert.equal(receipt.repository.id, current.repository.repositoryId);
  assert.match(
    receipt.branch.ref,
    /^refs\/heads\/seori\/fleet-cleanup\/[1-9][0-9]+\/[0-9a-f]{12}$/u,
  );
  assert.equal(receipt.repository.defaultRef, "refs/heads/main");
  assert.equal(receipt.pullRequest.state, "OPEN");
  assert.equal(receipt.pullRequest.isDraft, false);
  assert.equal(current.github.state.calls.createCommit, 1);
  assert.equal(current.github.state.calls.createRef, 1);
  assert.equal(current.github.state.calls.createPullRequest, 1);
  assert.equal(
    current.github.state.commit.changes.length,
    current.repository.changes.length,
  );
  assert.equal(validateFleetCleanupExecutionReceipt(receipt).ok, true);
  assert.equal(current.durable.authority.generation, 2);
  assert.equal(
    current.durable.state.issuedLeaseBuffers.every((buffer) =>
      buffer.every((byte) => byte === 0),
    ),
    true,
  );

  const replay = await current.executor.execute(
    base.issuance,
    base.plan,
    request,
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.receiptDigest, receipt.receiptDigest);
  assert.equal(current.github.state.calls.createCommit, 1);
  assert.equal(current.github.state.calls.createRef, 1);
  assert.equal(current.github.state.calls.createPullRequest, 1);

  const forgedRelationship = structuredClone(receipt);
  forgedRelationship.branch.commitSha = "f".repeat(40);
  forgedRelationship.receiptDigest = recomputeReceiptDigest(
    forgedRelationship,
  );
  assert.equal(
    validateFleetCleanupExecutionReceipt(forgedRelationship).ok,
    false,
  );

  const forgedOperationIds = structuredClone(receipt);
  forgedOperationIds.ledger.steps.forEach((step, index) => {
    step.operationId = digest(`forged-cleanup-operation-${index}`);
  });
  forgedOperationIds.ledger.digest = recomputeLedgerDigest(
    forgedOperationIds,
  );
  forgedOperationIds.receiptDigest = recomputeReceiptDigest(
    forgedOperationIds,
  );
  assert.equal(
    validateFleetCleanupExecutionReceipt(forgedOperationIds).ok,
    false,
  );
});

test("platform registry cross-repo subject도 source platform repo 하나의 PR로만 처리한다", async () => {
  const repository = targetRepository("PLATFORM_PRODUCER");
  const crossRepositoryChanges = repository.changes.filter(
    (change) => change.subject.repositoryId !== repository.repositoryId,
  );
  assert.ok(crossRepositoryChanges.length > 0);
  assert.equal(
    crossRepositoryChanges.every(
      (change) =>
        change.operation === "DELETE" &&
        change.path.startsWith("registry/apps/"),
    ),
    true,
  );
  const current = runtime({ repository });
  const receipt = await current.executor.execute(
    base.issuance,
    base.plan,
    cleanupExecutionRequest(repository.repositoryId, {
      runId: "fleet-cleanup-platform-run-0001",
    }),
  );
  assert.equal(receipt.repository.id, repository.repositoryId);
  assert.equal(current.github.state.calls.createPullRequest, 1);
});

test("동시 duplicate claim은 하나만 성공하고 Ready PR은 하나만 생성한다", async () => {
  const current = runtime();
  const first = cleanupExecutionRequest(current.repository.repositoryId, {
    runId: "fleet-cleanup-concurrent-run-0001",
  });
  const second = cleanupExecutionRequest(current.repository.repositoryId, {
    runId: "fleet-cleanup-concurrent-run-0002",
  });
  const settled = await Promise.allSettled([
    current.executor.execute(base.issuance, base.plan, first),
    current.executor.execute(base.issuance, base.plan, second),
  ]);
  assert.equal(
    settled.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  assert.equal(
    settled.filter(({ status }) => status === "rejected").length,
    1,
  );
  assert.equal(current.github.state.calls.createCommit, 1);
  assert.equal(current.github.state.calls.createRef, 1);
  assert.equal(current.github.state.calls.createPullRequest, 1);
});

test("CREATE_REF 결과 불명 crash는 readback-first로 재개하고 mutation을 반복하지 않는다", async () => {
  const current = runtime({
    githubFault: { crashAfterPersist: ["CREATE_REF"] },
  });
  const request = cleanupExecutionRequest(current.repository.repositoryId, {
    runId: "fleet-cleanup-partial-crash-run-0001",
  });
  await assert.rejects(
    current.executor.execute(base.issuance, base.plan, request),
    /FLEET_CLEANUP_CREATE_REF_RESULT_UNKNOWN/u,
  );
  assert.equal(current.github.state.calls.createCommit, 1);
  assert.equal(current.github.state.calls.createRef, 1);
  assert.equal(current.github.state.calls.createPullRequest, 0);

  const receipt = await current.executor.execute(
    base.issuance,
    base.plan,
    request,
  );
  assert.equal(receipt.state, "READY_PR_CREATED");
  assert.equal(current.github.state.calls.createCommit, 1);
  assert.equal(current.github.state.calls.createRef, 1);
  assert.equal(current.github.state.calls.createPullRequest, 1);
});

test("CREATE_PR 결과 불명 crash는 기존 Ready PR을 검증해 mutation 없이 재개한다", async () => {
  const current = runtime({
    githubFault: { crashAfterPersist: ["CREATE_PR"] },
  });
  const request = cleanupExecutionRequest(current.repository.repositoryId, {
    runId: "fleet-cleanup-pr-crash-run-0001",
  });
  await assert.rejects(
    current.executor.execute(base.issuance, base.plan, request),
    /FLEET_CLEANUP_CREATE_PR_RESULT_UNKNOWN/u,
  );
  assert.equal(current.github.state.calls.createCommit, 1);
  assert.equal(current.github.state.calls.createRef, 1);
  assert.equal(current.github.state.calls.createPullRequest, 1);

  const receipt = await current.executor.execute(
    base.issuance,
    base.plan,
    request,
  );
  assert.equal(receipt.state, "READY_PR_CREATED");
  assert.equal(current.github.state.calls.createCommit, 1);
  assert.equal(current.github.state.calls.createRef, 1);
  assert.equal(current.github.state.calls.createPullRequest, 1);
});

test("최종 consume 전에 cleanup branch ref를 exact commit으로 다시 확인한다", async () => {
  const current = runtime({
    githubFault: { dropRefAfterPullRequest: true },
  });
  await assert.rejects(
    current.executor.execute(
      base.issuance,
      base.plan,
      cleanupExecutionRequest(current.repository.repositoryId, {
        runId: "fleet-cleanup-final-ref-readback-run-0001",
      }),
    ),
    /FLEET_CLEANUP_CONFIRMED_STEP_MISSING/u,
  );
  assert.equal(current.github.state.calls.createPullRequest, 1);
  assert.equal(current.durable.state.completionCalls, 0);
});

test("최종 consume 전에 Ready PR이 여전히 열려 있는지 다시 확인한다", async () => {
  const current = runtime({
    githubFault: { dropPullRequestAfterReadback: true },
  });
  await assert.rejects(
    current.executor.execute(
      base.issuance,
      base.plan,
      cleanupExecutionRequest(current.repository.repositoryId, {
        runId: "fleet-cleanup-final-pr-readback-run-0001",
      }),
    ),
    /FLEET_CLEANUP_MUTATION_GUARD_MISMATCH/u,
  );
  assert.equal(current.github.state.calls.createPullRequest, 1);
  assert.equal(current.durable.state.completionCalls, 0);
});

test("mutation guard 대기 중 plan currentness가 만료되면 provider mutation 전에 중단한다", async () => {
  let nowMs = base.executionNowMs + 260_000;
  const current = runtime({
    clock: () => nowMs,
    githubFault: {
      afterMutationGuard({ callCount }) {
        if (callCount === 3) nowMs += 20_000;
      },
    },
  });
  await assert.rejects(
    current.executor.execute(
      base.issuance,
      base.plan,
      cleanupExecutionRequest(current.repository.repositoryId, {
        runId: "fleet-cleanup-plan-currentness-run-0001",
      }),
    ),
    /FLEET_CLEANUP_PLAN_INVALID/u,
  );
  assert.equal(current.github.state.calls.createCommit, 0);
  assert.equal(current.github.state.calls.createRef, 0);
  assert.equal(current.github.state.calls.createPullRequest, 0);
});

test("mutation guard 대기 중 approval TTL이 만료되면 provider mutation 전에 중단한다", async () => {
  let nowMs = base.executionNowMs;
  const current = runtime({
    clock: () => nowMs,
    githubFault: {
      approvalTtlMs: 1,
      afterMutationGuard() {
        nowMs += 2;
      },
    },
  });
  await assert.rejects(
    current.executor.execute(
      base.issuance,
      base.plan,
      cleanupExecutionRequest(current.repository.repositoryId, {
        runId: "fleet-cleanup-guard-approval-expiry-run-0001",
      }),
    ),
    /FLEET_CLEANUP_MUTATION_GUARD_MISMATCH/u,
  );
  assert.equal(current.github.state.calls.createCommit, 0);
  assert.equal(current.github.state.calls.createRef, 0);
  assert.equal(current.github.state.calls.createPullRequest, 0);
});

test("state authority 대기 중 plan currentness가 만료되면 claim 전에 중단한다", async () => {
  let nowMs = base.executionNowMs + 260_000;
  const current = runtime({
    clock: () => nowMs,
    stateFault: {
      afterAuthorityRead() {
        nowMs += 20_000;
      },
    },
  });
  await assert.rejects(
    current.executor.execute(
      base.issuance,
      base.plan,
      cleanupExecutionRequest(current.repository.repositoryId, {
        runId: "fleet-cleanup-authority-plan-expiry-run-0001",
      }),
    ),
    /FLEET_CLEANUP_PLAN_INVALID/u,
  );
  assert.equal(current.durable.state.reserveCalls, 0);
  assert.equal(current.github.state.calls.createCommit, 0);
  assert.equal(current.github.state.calls.createRef, 0);
  assert.equal(current.github.state.calls.createPullRequest, 0);
});

test("state authority 대기 중 approval TTL이 만료되면 fresh guard로 claim 전에 중단한다", async () => {
  let nowMs = base.executionNowMs;
  const current = runtime({
    clock: () => nowMs,
    githubFault: { approvalTtlMs: 1 },
    stateFault: {
      afterAuthorityRead() {
        nowMs += 2;
      },
    },
  });
  await assert.rejects(
    current.executor.execute(
      base.issuance,
      base.plan,
      cleanupExecutionRequest(current.repository.repositoryId, {
        runId: "fleet-cleanup-authority-approval-expiry-run-0001",
      }),
    ),
    /FLEET_CLEANUP_MUTATION_GUARD_MISMATCH/u,
  );
  assert.equal(current.durable.state.reserveCalls, 0);
  assert.equal(current.github.state.calls.createCommit, 0);
  assert.equal(current.github.state.calls.createRef, 0);
  assert.equal(current.github.state.calls.createPullRequest, 0);
});

test("state authority 대기 중 GitHub gate가 바뀌면 fresh guard로 claim 전에 중단한다", async () => {
  const githubFault = {};
  const current = runtime({
    githubFault,
    stateFault: {
      afterAuthorityRead() {
        githubFault.labels = ["autopilot", "blocked"];
      },
    },
  });
  await assert.rejects(
    current.executor.execute(
      base.issuance,
      base.plan,
      cleanupExecutionRequest(current.repository.repositoryId, {
        runId: "fleet-cleanup-authority-github-gate-drift-run-0001",
      }),
    ),
    /FLEET_CLEANUP_MUTATION_GUARD_MISMATCH/u,
  );
  assert.equal(current.github.state.calls.readMutationGuard, 2);
  assert.equal(current.durable.state.reserveCalls, 0);
  assert.equal(current.github.state.calls.createCommit, 0);
  assert.equal(current.github.state.calls.createRef, 0);
  assert.equal(current.github.state.calls.createPullRequest, 0);
});

test("claim용 fresh guard가 지연돼 cached authority가 만료되면 claim 전에 중단한다", async () => {
  let nowMs = base.executionNowMs;
  const current = runtime({
    clock: () => nowMs,
    githubFault: {
      beforeMutationGuard({ callCount }) {
        if (callCount === 2) nowMs += 2 * 60_000 + 1;
      },
    },
  });
  await assert.rejects(
    current.executor.execute(
      base.issuance,
      base.plan,
      cleanupExecutionRequest(current.repository.repositoryId, {
        runId: "fleet-cleanup-claim-guard-authority-expiry-run-0001",
      }),
    ),
    /FLEET_CLEANUP_STATE_AUTHORITY_MISMATCH/u,
  );
  assert.equal(current.github.state.calls.readMutationGuard, 2);
  assert.equal(current.durable.state.reserveCalls, 0);
  assert.equal(current.github.state.calls.createCommit, 0);
  assert.equal(current.github.state.calls.createRef, 0);
  assert.equal(current.github.state.calls.createPullRequest, 0);
});

test("provider readback이 UNKNOWN이면 결과 불명 mutation을 절대 재시도하지 않는다", async () => {
  const current = runtime({
    githubFault: { failBeforePersist: ["CREATE_COMMIT"] },
  });
  const request = cleanupExecutionRequest(current.repository.repositoryId, {
    runId: "fleet-cleanup-result-unknown-run-0001",
  });
  await assert.rejects(
    current.executor.execute(base.issuance, base.plan, request),
    /FLEET_CLEANUP_CREATE_COMMIT_RESULT_UNKNOWN/u,
  );
  await assert.rejects(
    current.executor.execute(base.issuance, base.plan, request),
    /FLEET_CLEANUP_CREATE_COMMIT_RESULT_UNKNOWN/u,
  );
  current.github.state.unknownReadbacks.delete("CREATE_COMMIT");
  await assert.rejects(
    current.executor.execute(base.issuance, base.plan, request),
    /FLEET_CLEANUP_CREATE_COMMIT_RESULT_UNKNOWN/u,
  );
  assert.equal(current.github.state.calls.createCommit, 1);
  assert.equal(current.github.state.calls.createRef, 0);
  assert.equal(current.github.state.calls.createPullRequest, 0);
  assert.equal(
    current.durable.state.issuedLeaseBuffers.every((buffer) =>
      buffer.every((byte) => byte === 0),
    ),
    true,
  );
});

for (const [name, githubFault] of [
  ["default head drift", { headDrift: true }],
  ["existing autonomous Ready PR", { existingPullRequest: true }],
  ["cross-repository readback", { crossRepository: true }],
  ["source blob drift", { blobDrift: true }],
  ["replacement digest drift", { replacementTamper: true }],
]) {
  test(`${name}는 commit 생성 전에 fail-closed한다`, async () => {
    const current = runtime({ githubFault });
    await assert.rejects(
      current.executor.execute(
        base.issuance,
        base.plan,
        cleanupExecutionRequest(current.repository.repositoryId, {
          runId: `fleet-cleanup-${name.replaceAll(" ", "-")}-run-0001`,
        }),
      ),
      /FLEET_CLEANUP_/u,
    );
    assert.equal(current.github.state.calls.createCommit, 0);
    assert.equal(current.github.state.calls.createRef, 0);
    assert.equal(current.github.state.calls.createPullRequest, 0);
  });
}

for (const [name, githubFault] of [
  ["approval denial", { approvalDenied: true }],
  ["no-autopilot", { labels: ["autopilot", "no-autopilot"] }],
  ["blocked", { labels: ["autopilot", "blocked"] }],
  ["approval label", { labels: ["approval:required", "autopilot"] }],
]) {
  test(`${name} gate는 state authority claim 전에 차단한다`, async () => {
    const current = runtime({ githubFault });
    await assert.rejects(
      current.executor.execute(
        base.issuance,
        base.plan,
        cleanupExecutionRequest(current.repository.repositoryId, {
          runId: `fleet-cleanup-${name.replaceAll(" ", "-")}-run-0001`,
        }),
      ),
      /FLEET_CLEANUP_MUTATION_GUARD_MISMATCH/u,
    );
    assert.equal(current.durable.state.reserveCalls, 0);
    assert.equal(current.github.state.calls.createCommit, 0);
  });
}

test("stale generation completion 응답은 Ready PR 생성 후에도 완료로 수락하지 않는다", async () => {
  const current = runtime({ stateFault: { staleCompletion: true } });
  await assert.rejects(
    current.executor.execute(
      base.issuance,
      base.plan,
      cleanupExecutionRequest(current.repository.repositoryId, {
        runId: "fleet-cleanup-stale-completion-run-0001",
      }),
    ),
    /FLEET_CLEANUP_COMPLETION_INVALID/u,
  );
  assert.equal(current.github.state.calls.createPullRequest, 1);
  assert.equal(current.durable.state.completionCalls, 1);
});

test("state authority의 plan binding drift는 reservation 전에 차단한다", async () => {
  const current = runtime({ stateFault: { authorityPlanDrift: true } });
  await assert.rejects(
    current.executor.execute(
      base.issuance,
      base.plan,
      cleanupExecutionRequest(current.repository.repositoryId, {
        runId: "fleet-cleanup-authority-plan-drift-run-0001",
      }),
    ),
    /FLEET_CLEANUP_STATE_AUTHORITY_MISMATCH/u,
  );
  assert.equal(current.durable.state.reserveCalls, 0);
  assert.equal(current.github.state.calls.createCommit, 0);
});

test("state authority 대기 중 readback freshness가 만료되면 reservation 전에 차단한다", async () => {
  let nowMs = base.executionNowMs;
  const current = runtime({
    clock: () => nowMs,
    stateFault: {
      afterAuthorityRead() {
        nowMs += 2 * 60_000 + 1;
      },
    },
  });
  await assert.rejects(
    current.executor.execute(
      base.issuance,
      base.plan,
      cleanupExecutionRequest(current.repository.repositoryId, {
        runId: "fleet-cleanup-authority-freshness-run-0001",
      }),
    ),
    /FLEET_CLEANUP_STATE_AUTHORITY_MISMATCH/u,
  );
  assert.equal(current.durable.state.reserveCalls, 0);
  assert.equal(current.github.state.calls.createCommit, 0);
  assert.equal(current.github.state.calls.createRef, 0);
  assert.equal(current.github.state.calls.createPullRequest, 0);
});

test("durable ledger가 다른 단계 receipt를 바꾸면 다음 mutation 전에 차단한다", async () => {
  const current = runtime({ stateFault: { tamperPriorStep: true } });
  await assert.rejects(
    current.executor.execute(
      base.issuance,
      base.plan,
      cleanupExecutionRequest(current.repository.repositoryId, {
        runId: "fleet-cleanup-ledger-tamper-run-0001",
      }),
    ),
    /FLEET_CLEANUP_LEDGER_TRANSITION_INVALID/u,
  );
  assert.equal(current.github.state.calls.createCommit, 1);
  assert.equal(current.github.state.calls.createRef, 0);
  assert.equal(current.github.state.calls.createPullRequest, 0);
});

test("lease가 step dispatch 뒤 만료되면 provider mutation 전에 중단한다", async () => {
  let nowMs = base.executionNowMs;
  const current = runtime({
    clock: () => nowMs,
    stateFault: {
      afterTransition({ kind, nextStepState }) {
        if (kind === "CREATE_COMMIT" && nextStepState === "DISPATCHED") {
          nowMs += 5 * 60_000 + 1;
        }
      },
    },
  });
  await assert.rejects(
    current.executor.execute(
      base.issuance,
      base.plan,
      cleanupExecutionRequest(current.repository.repositoryId, {
        runId: "fleet-cleanup-expired-lease-run-0001",
      }),
    ),
    /FLEET_CLEANUP_EXECUTION_LEASE_EXPIRED/u,
  );
  assert.equal(current.github.state.calls.createCommit, 0);
  assert.equal(current.github.state.calls.createRef, 0);
  assert.equal(current.github.state.calls.createPullRequest, 0);
});

test("approval scope digest는 누락·추가·잘못된 공개 binding을 거부한다", () => {
  assert.throws(
    () => computeFleetCleanupApprovalScopeDigest({}),
    /FLEET_CLEANUP_APPROVAL_SCOPE_INVALID/u,
  );
  assert.throws(
    () =>
      computeFleetCleanupApprovalScopeDigest({
        organizationId: ORGANIZATION_ID,
        installationId: INSTALLATION_ID,
        issuanceDigest: base.issuance.issuanceDigest,
        inventoryDigest: base.issuance.inventoryDigest,
        planDigest: base.plan.planDigest,
        repositoryId: targetRepository().repositoryId,
        fullName: targetRepository().fullName,
        sourceSha: targetRepository().sourceSha,
        issueNumber: 7001,
        extra: true,
      }),
    /FLEET_CLEANUP_APPROVAL_SCOPE_INVALID/u,
  );
});

test("secret-shaped provider public readback은 값 노출 없이 거부한다", async () => {
  const canary = `github_pat_${"A".repeat(30)}`;
  const current = runtime({
    githubFault: { labels: ["autopilot", canary] },
  });
  let message = "";
  try {
    await current.executor.execute(
      base.issuance,
      base.plan,
      cleanupExecutionRequest(current.repository.repositoryId, {
        runId: "fleet-cleanup-secret-surface-run-0001",
      }),
    );
    assert.fail("secret-shaped readback must fail");
  } catch (error) {
    message = String(error.message);
  }
  assert.match(message, /FLEET_CLEANUP_MUTATION_GUARD_READBACK_FAILED/u);
  assert.equal(message.includes(canary), false);
});

test("replacement provider 실행 복제본은 성공과 metadata 거부 경로에서 모두 zeroize한다", async () => {
  const callback = async () => undefined;
  const buildAdapter = (readReplacementBlob) =>
    createTrustedFleetCleanupGitHubAdapter({
      provider: {
        readMutationGuard: callback,
        readReplacementBlob,
        readCommit: callback,
        createCommit: callback,
        readRef: callback,
        createRef: callback,
        readPullRequest: callback,
        createPullRequest: callback,
      },
    });

  const source = Buffer.from("replacement-provider-copy", "utf8");
  const adapter = buildAdapter(async () => ({
    contract: "replacement-readback-v1",
    content: source,
  }));
  const readback = await adapter.readReplacementBlob({});
  assert.equal(readback.content.toString("utf8"), "replacement-provider-copy");
  assert.deepEqual(source, Buffer.alloc(source.length));
  readback.content.fill(0);

  const rejected = Buffer.from("rejected-provider-copy", "utf8");
  const canary = `github_pat_${"B".repeat(30)}`;
  const rejectedAdapter = buildAdapter(async () => ({
    contract: canary,
    content: rejected,
  }));
  await assert.rejects(
    () => rejectedAdapter.readReplacementBlob({}),
    /FLEET_CLEANUP_REPLACEMENT_READBACK_FAILED/u,
  );
  assert.deepEqual(rejected, Buffer.alloc(rejected.length));
});

test("trusted adapter surface에는 direct main update나 ref delete가 존재할 수 없다", () => {
  const callback = async () => undefined;
  assert.throws(
    () =>
      createTrustedFleetCleanupGitHubAdapter({
        provider: {
          readMutationGuard: callback,
          readReplacementBlob: callback,
          readCommit: callback,
          createCommit: callback,
          readRef: callback,
          createRef: callback,
          readPullRequest: callback,
          createPullRequest: callback,
          deleteRef: callback,
        },
      }),
    /FLEET_CLEANUP_GITHUB_ADAPTER_CONFIGURATION_INVALID/u,
  );
  assert.deepEqual(trustedFleetCleanupExecutorContract.stepOrder, [
    "CREATE_COMMIT",
    "CREATE_REF",
    "CREATE_PR",
  ]);
  assert.equal(
    trustedFleetCleanupExecutorContract.directDefaultBranchMutationAllowed,
    false,
  );
  assert.equal(trustedFleetCleanupExecutorContract.refDeletionAllowed, false);
  assert.equal(trustedFleetCleanupExecutorContract.publicFieldsOnly, true);
  assert.equal(trustedFleetCleanupExecutorContract.resultUnknownRetryAllowed, false);
  assert.equal(
    trustedFleetCleanupExecutorContract
      .stateAuthorityRepositoryPlanBindingRequired,
    true,
  );
  assert.equal(
    trustedFleetCleanupExecutorContract.leaseExpiryRevalidatedBeforeMutation,
    true,
  );
});
