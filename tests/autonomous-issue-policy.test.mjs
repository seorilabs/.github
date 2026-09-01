import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";

const policy = parse(
  await readFile("contracts/autonomous-issue-policy.yaml", "utf8"),
);
const schema = JSON.parse(
  await readFile("contracts/autonomous-issue-policy.schema.json", "utf8"),
);

const ENABLED = [
  "seorilabs/jomul",
  "seorilabs/crossword-puzzle",
  "seorilabs/saju-reader",
  "seorilabs/lizard-tycoon",
  "seorilabs/immunity-war",
  "seorilabs/alley-market-match",
  "seorilabs/lord-ledger",
  "seorilabs/slotmachine-game",
  "seorilabs/reascend",
  "seorilabs/cycle-pair",
  "seorilabs/foam-party",
  "seorilabs/lucid-reversi",
  "seorilabs/starlit-apprentice",
  "seorilabs/matgo",
  "seorilabs/match-picture-app",
  "seorilabs/daoewo",
  "seorilabs/animal-chess",
  "seorilabs/minimax-defense",
  "seorilabs/merge-battle",
  "seorilabs/spiritgate-defenders",
  "seorilabs/babycare",
  "seorilabs/keeum",
];
const EXCLUDED = [
  "seorilabs/happy-farm",
  "seorilabs/lucid-chess",
  "seorilabs/trait-test-hub",
  "seorilabs/vocab-swipe",
  "seorilabs/periodic-table-app",
  "seorilabs/dpti-app",
];

function repositoryPolicy(repository) {
  return (
    policy.repositories.find((item) => item.repository === repository) ?? {
      repository,
      ...policy.defaults,
    }
  );
}

function titleAllowed(title, repository) {
  if (
    policy.titlePolicy.forbiddenPrefixPatterns.some((pattern) =>
      new RegExp(pattern, "u").test(title),
    ) ||
    new RegExp(policy.titlePolicy.forbiddenAgentOrderPattern, "u").test(title)
  ) {
    return false;
  }
  if (policy.titlePolicy.forbidRepositoryPrefix) {
    const slug = repository.split("/").at(-1);
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (new RegExp(`^\\s*(?:seorilabs/)?${escaped}\\s*[:\\-]`, "iu").test(title)) {
      return false;
    }
  }
  return true;
}

function labelsAreValid(labels) {
  const normalized = new Set(labels);
  const executionCount = policy.labels.executionExactlyOne.filter((label) =>
    normalized.has(label),
  ).length;
  const priorityCount = policy.labels.priorityExactlyOne.filter((label) =>
    normalized.has(label),
  ).length;
  return (
    policy.labels.required.every((label) => normalized.has(label)) &&
    executionCount === 1 &&
    priorityCount === 1
  );
}

function routeFor({ sources = [], requirements = [] }) {
  const localIndicators = new Set(policy.executionRouting.localRequirementIndicators);
  if (requirements.some((requirement) => localIndicators.has(requirement))) {
    return policy.executionRouting.defaultLabel;
  }
  const cloudSources = new Set(policy.executionRouting.cloudAllowedSources);
  if (sources.length > 0 && sources.every((source) => cloudSources.has(source))) {
    return policy.executionRouting.cloudLabel;
  }
  return policy.executionRouting.defaultLabel;
}

function eligible(issue, environment = "local") {
  const repo = repositoryPolicy(issue.repository);
  if (repo.processing !== "ENABLED" || issue.state !== "OPEN") return false;
  if (!labelsAreValid(issue.labels)) return false;
  if (policy.labels.blocking.some((label) => issue.labels.includes(label))) return false;
  if (
    issue.labels.some((label) =>
      policy.labels.blockingPrefixes.some((prefix) => label.startsWith(prefix)),
    )
  ) {
    return false;
  }
  if (issue.hasClosingPullRequest) return false;
  return environment === "local" || issue.labels.includes("autopilot:cloud");
}

function issueAttemptKey(issue) {
  return `${issue.repository}#${issue.number}`;
}

function parseLeaseComment(body) {
  const match = body.match(
    new RegExp(
      `^${policy.lease.claimComment.marker} (claim|renew|release) agent=(\\S+) run=(\\S+)(?: expires=(\\S+))?`,
      "u",
    ),
  );
  if (!match) return null;
  return { action: match[1], agent: match[2], run: match[3], expires: match[4] ?? null };
}

function activeLeaseWinner(comments, now) {
  const events = comments
    .map((comment) => ({ ...comment, lease: parseLeaseComment(comment.body) }))
    .filter((comment) => comment.lease);
  const released = new Set(
    events
      .filter(({ lease }) => lease.action === "release")
      .map(({ lease }) => lease.run),
  );
  const claims = new Map();
  for (const { id, lease } of events) {
    if (lease.action === "release") continue;
    const claim = claims.get(lease.run) ?? { run: lease.run, agent: lease.agent, commentId: id, expires: 0 };
    claim.expires = Math.max(claim.expires, Date.parse(lease.expires));
    claims.set(lease.run, claim);
  }
  const active = [...claims.values()]
    .filter((claim) => !released.has(claim.run) && claim.expires > now)
    .sort((left, right) => left.commentId - right.commentId);
  return active[0] ?? null;
}

function claimableBy(agentId, comments, now) {
  const winner = activeLeaseWinner(comments, now);
  return winner === null || winner.agent === agentId;
}

function ownsAutonomousPullRequest(agentId, headBranch) {
  const prefix = policy.lease.branchOwnership.branchPrefix.replace("<agentId>", agentId);
  return headBranch.startsWith(prefix);
}

function orderedEligibleQueue(issues, environment = "local", attempted = new Set()) {
  const priority = new Map(
    policy.schedules.processing.priorityOrder.map((label, index) => [label, index]),
  );
  return issues
    .filter((issue) => eligible(issue, environment) && !attempted.has(issueAttemptKey(issue)))
    .sort((left, right) => {
      const leftPriority = left.labels.find((label) => priority.has(label));
      const rightPriority = right.labels.find((label) => priority.has(label));
      return (
        priority.get(leftPriority) - priority.get(rightPriority) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.number - right.number
      );
    });
}

test("자율 이슈 정책은 JSON Schema를 통과한다", () => {
  const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(
    schema,
  );
  assert.equal(validate(policy), true, JSON.stringify(validate.errors));
});

test("v2 처리 계약은 등록 1건 상한과 실행당 직렬 drain을 분리한다", () => {
  assert.equal(policy.schemaVersion, 2);
  assert.equal(policy.id, "seorilabs-autonomous-issue-policy-v2");
  assert.equal(policy.schedules.registration.maxIssuesPerRun, 1);
  assert.equal(Object.hasOwn(policy.schedules.processing, "maxIssuesPerRun"), false);
  assert.deepEqual(policy.schedules.processing, {
    localTimes: ["06:25", "09:25", "12:25", "15:25", "18:25", "21:25"],
    mode: "sequential-drain",
    candidateSet: "run-start",
    revalidateBeforeEachAttempt: true,
    maxConcurrentIssues: 1,
    maxAttemptsPerIssuePerRun: 1,
    blockedIssuePolicy: "continue-next-unattempted",
    executionBudgetSource: "automation-occurrence",
    stopConditions: [
      "eligible-queue-exhausted",
      "execution-budget-exhausted",
      "global-safety-blocked",
    ],
    priorityOrder: ["P1", "P2", "P3", "P4"],
    tieBreakers: ["createdAt", "number"],
  });
});

test("22개 제품은 양쪽 ENABLED이고 6개 제외 제품은 양쪽 EXCLUDED다", () => {
  assert.deepEqual(
    policy.repositories
      .filter(({ registration, processing }) =>
        registration === "ENABLED" && processing === "ENABLED",
      )
      .map(({ repository }) => repository),
    ENABLED,
  );
  assert.deepEqual(
    policy.repositories
      .filter(({ registration, processing }) =>
        registration === "EXCLUDED" && processing === "EXCLUDED",
      )
      .map(({ repository }) => repository),
    EXCLUDED,
  );
  assert.deepEqual(repositoryPolicy("seorilabs/new-product"), {
    repository: "seorilabs/new-product",
    registration: "DISABLED",
    processing: "DISABLED",
  });
});

test("제목 말머리와 에이전트 순서 코드를 거부한다", () => {
  const repository = "seorilabs/lizard-tycoon";
  for (const title of [
    "[P1] 저장 오류를 고친다",
    "[BUG] 저장 오류를 고친다",
    "P1: 저장 오류를 고친다",
    "U1 저장 오류를 고친다",
    "저장 오류 N1을 고친다",
    "seorilabs/lizard-tycoon: 저장 오류를 고친다",
    "lizard-tycoon: 저장 오류를 고친다",
  ]) {
    assert.equal(titleAllowed(title, repository), false, title);
  }
  assert.equal(
    titleAllowed(
      "재접속하면 사라지는 튜토리얼 진행을 이어서 할 수 있게 한다",
      repository,
    ),
    true,
  );
});

test("autopilot·실행 환경 하나·우선순위 하나를 모두 요구한다", () => {
  assert.equal(labelsAreValid(["autopilot", "autopilot:cloud", "P2"]), true);
  assert.equal(labelsAreValid(["autopilot", "P2"]), false);
  assert.equal(
    labelsAreValid([
      "autopilot",
      "autopilot:local",
      "autopilot:cloud",
      "P2",
    ]),
    false,
  );
  assert.equal(labelsAreValid(["autopilot", "autopilot:local", "P1", "P2"]), false);
});

test("로컬 의존성은 local, 저장소와 CI만 필요한 작업은 cloud로 판정한다", () => {
  assert.equal(
    routeFor({
      sources: ["target-repository", "repository-ci"],
      requirements: [],
    }),
    "autopilot:cloud",
  );
  for (const requirement of [
    "local-skill",
    "bigquery-or-gcp",
    "signed-in-console",
    "physical-device-or-emulator",
    "obsidian",
  ]) {
    assert.equal(
      routeFor({ sources: ["target-repository"], requirements: [requirement] }),
      "autopilot:local",
      requirement,
    );
  }
  assert.equal(routeFor({ sources: ["unknown-source"], requirements: [] }), "autopilot:local");
});

test("처리 후보 전체를 차단 gate 뒤 P1부터 오래된 순으로 정렬한다", () => {
  const base = {
    repository: "seorilabs/lizard-tycoon",
    state: "OPEN",
    hasClosingPullRequest: false,
  };
  const issues = [
    { ...base, number: 9, createdAt: "2026-08-01T00:00:00Z", labels: ["autopilot", "autopilot:local", "P2"] },
    { ...base, number: 8, createdAt: "2026-08-02T00:00:00Z", labels: ["autopilot", "autopilot:cloud", "P1"] },
    { ...base, number: 7, createdAt: "2026-08-01T00:00:00Z", labels: ["autopilot", "autopilot:cloud", "P1"] },
    { ...base, number: 6, createdAt: "2026-07-01T00:00:00Z", labels: ["autopilot", "autopilot:cloud", "P1", "blocked"] },
    { ...base, number: 5, createdAt: "2026-06-01T00:00:00Z", labels: ["autopilot", "autopilot:cloud", "P1", "approval:planning"] },
  ];
  assert.deepEqual(orderedEligibleQueue(issues).map(({ number }) => number), [7, 8, 9]);
  assert.deepEqual(
    orderedEligibleQueue(issues, "local", new Set(["seorilabs/lizard-tycoon#7"]))
      .map(({ number }) => number),
    [8, 9],
  );
});

test("lease 경합은 가장 낮은 활성 claim comment id가 이긴다", () => {
  const now = Date.parse("2026-09-02T06:30:00Z");
  const comments = [
    { id: 101, body: "autopilot-lease claim agent=claude-cloud run=r-1 expires=2026-09-02T08:00:00Z" },
    { id: 102, body: "autopilot-lease claim agent=codex-cloud run=r-2 expires=2026-09-02T08:00:00Z" },
  ];
  assert.deepEqual(activeLeaseWinner(comments, now), {
    run: "r-1",
    agent: "claude-cloud",
    commentId: 101,
    expires: Date.parse("2026-09-02T08:00:00Z"),
  });
  assert.equal(claimableBy("claude-cloud", comments, now), true);
  assert.equal(claimableBy("codex-cloud", comments, now), false);
});

test("만료·release된 claim은 잠금이 아니고 renew는 만료를 연장한다", () => {
  const now = Date.parse("2026-09-02T06:30:00Z");
  assert.equal(
    activeLeaseWinner(
      [{ id: 1, body: "autopilot-lease claim agent=codex-cloud run=r-1 expires=2026-09-02T05:00:00Z" }],
      now,
    ),
    null,
  );
  assert.equal(
    activeLeaseWinner(
      [
        { id: 1, body: "autopilot-lease claim agent=codex-cloud run=r-1 expires=2026-09-02T08:00:00Z" },
        { id: 2, body: "autopilot-lease release agent=codex-cloud run=r-1" },
      ],
      now,
    ),
    null,
  );
  const renewed = activeLeaseWinner(
    [
      { id: 1, body: "autopilot-lease claim agent=codex-cloud run=r-1 expires=2026-09-02T06:00:00Z" },
      { id: 2, body: "autopilot-lease renew agent=codex-cloud run=r-1 expires=2026-09-02T07:30:00Z" },
    ],
    now,
  );
  assert.equal(renewed?.run, "r-1");
  assert.equal(renewed?.commentId, 1);
  assert.equal(claimableBy("claude-cloud", [], now), true);
});

test("자율 PR은 자기 agentId 접두사 브랜치만 이어받는다", () => {
  assert.equal(ownsAutonomousPullRequest("claude-cloud", "claude-cloud/fix-boot-recovery"), true);
  assert.equal(ownsAutonomousPullRequest("claude-cloud", "codex-cloud/fix-boot-recovery"), false);
  assert.equal(ownsAutonomousPullRequest("claude-cloud", "fix/legacy-branch"), false);
  assert.equal(policy.lease.branchOwnership.foreignAutonomousPrPolicy, "item-blocked");
});

test("클라우드는 cloud 라벨만 선택하고 제외 저장소는 항상 건너뛴다", () => {
  const issues = [
    {
      repository: "seorilabs/jomul",
      number: 1,
      state: "OPEN",
      createdAt: "2026-08-01T00:00:00Z",
      hasClosingPullRequest: false,
      labels: ["autopilot", "autopilot:local", "P1"],
    },
    {
      repository: "seorilabs/jomul",
      number: 2,
      state: "OPEN",
      createdAt: "2026-08-02T00:00:00Z",
      hasClosingPullRequest: false,
      labels: ["autopilot", "autopilot:cloud", "P2"],
    },
    {
      repository: "seorilabs/happy-farm",
      number: 3,
      state: "OPEN",
      createdAt: "2026-07-01T00:00:00Z",
      hasClosingPullRequest: false,
      labels: ["autopilot", "autopilot:cloud", "P1"],
    },
  ];
  assert.deepEqual(orderedEligibleQueue(issues, "cloud").map(({ number }) => number), [2]);
});
