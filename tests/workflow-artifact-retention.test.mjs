import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

const root = new URL("../", import.meta.url);
const policy = parse(await readFile(new URL("contracts/release-policy.yaml", root), "utf8"));
const retentionDays = policy.artifacts.retentionDays;
const workflowDirectory = new URL(".github/workflows/", root);
const workflows = await Promise.all(
  (await readdir(workflowDirectory))
    .filter((name) => /\.ya?ml$/u.test(name))
    .map(async (name) => ({
      name,
      value: parse(await readFile(new URL(name, workflowDirectory), "utf8")),
    })),
);

test("모든 중앙 artifact upload는 release policy의 보존 기간을 명시한다", () => {
  let uploads = 0;
  for (const { name, value } of workflows) {
    for (const [jobId, job] of Object.entries(value.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (!step.uses?.startsWith("actions/upload-artifact@")) continue;
        uploads += 1;
        assert.equal(
          String(step.with?.["retention-days"]),
          String(retentionDays),
          `${name}: ${jobId}: ${step.name ?? step.uses}`,
        );
      }
    }
  }
  assert.ok(uploads > 0, "실제 artifact upload를 검증해야 한다");
});

test("Docker 자동 build record도 job과 step override를 포함해 중앙 보존 기간을 따른다", () => {
  let builds = 0;
  for (const { name, value } of workflows) {
    for (const [jobId, job] of Object.entries(value.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (!step.uses?.startsWith("docker/build-push-action@")) continue;
        builds += 1;
        const env = { ...value.env, ...job.env, ...step.env };
        if (String(env.DOCKER_BUILD_RECORD_UPLOAD) === "false") continue;
        assert.equal(
          String(env.DOCKER_BUILD_RECORD_RETENTION_DAYS),
          String(retentionDays),
          `${name}: ${jobId}: ${step.name ?? step.uses}`,
        );
      }
    }
  }
  assert.ok(builds > 0, "실제 Docker build record를 검증해야 한다");
});
