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

function orderedQueue(issues, environment = "local") {
  const priority = new Map(
    policy.schedules.processing.priorityOrder.map((label, index) => [label, index]),
  );
  return issues
    .filter((issue) => eligible(issue, environment))
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

test("처리는 실행당 건수 상한 없이 한 항목씩 직렬로 큐를 소진한다", () => {
  assert.equal(policy.schemaVersion, 2);
  assert.equal(policy.id, "seorilabs-autonomous-issue-policy-v2");
  assert.equal("maxIssuesPerRun" in policy.schedules.processing, false);
  assert.equal(policy.schedules.processing.mode, "sequential-drain");
  assert.equal(policy.schedules.processing.workItemConcurrency, 1);
  assert.equal(policy.schedules.processing.workItemAttemptsPerRun, 1);
  assert.equal(policy.schedules.processing.continueAfterItemBlocker, true);
  assert.deepEqual(policy.schedules.processing.stopConditions, [
    "no-unattempted-eligible-work",
    "execution-budget-exhausted",
    "global-safety-blocker",
  ]);
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

test("처리 큐는 차단 gate 뒤 P1부터 오래된 순으로 모든 적격 항목을 정렬한다", () => {
  const base = {
    repository: "seorilabs/lizard-tycoon",
    state: "OPEN",
    hasClosingPullRequest: false,
  };
  const queue = orderedQueue([
    { ...base, number: 9, createdAt: "2026-08-01T00:00:00Z", labels: ["autopilot", "autopilot:local", "P2"] },
    { ...base, number: 8, createdAt: "2026-08-02T00:00:00Z", labels: ["autopilot", "autopilot:cloud", "P1"] },
    { ...base, number: 7, createdAt: "2026-08-01T00:00:00Z", labels: ["autopilot", "autopilot:cloud", "P1"] },
    { ...base, number: 6, createdAt: "2026-07-01T00:00:00Z", labels: ["autopilot", "autopilot:cloud", "P1", "blocked"] },
    { ...base, number: 5, createdAt: "2026-06-01T00:00:00Z", labels: ["autopilot", "autopilot:cloud", "P1", "approval:planning"] },
  ]);
  assert.deepEqual(queue.map(({ number }) => number), [7, 8, 9]);
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
  assert.deepEqual(orderedQueue(issues, "cloud").map(({ number }) => number), [2]);
});
