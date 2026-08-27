import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { scanTrackedSecrets } from "../scripts/fleet/secret-scan.mjs";
import { runStaticPreflight } from "../scripts/fleet/static-preflight.mjs";
import { writeProvenance } from "../scripts/fleet/write-provenance.mjs";

const execFileAsync = promisify(execFile);
const temporaryRoots = [];

test.afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true }),
    ),
  );
});

async function fixture({ profile = "react-native" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "fleet-static-"));
  temporaryRoots.push(root);
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({
      scripts: {
        "test:core": "node --test",
        "check:architecture": "node --check architecture.mjs",
        "check:release": "node --check release.mjs",
      },
    })}\n`,
  );
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  if (profile === "godot") {
    await writeFile(join(root, "project.godot"), "[application]\n");
  }
  await execFileAsync("git", ["init", "-q", root]);
  await execFileAsync("git", ["-C", root, "add", "."]);
  return root;
}

test("정적 preflight는 로컬 app manifest 없이 canonical 명령만 검증한다", async () => {
  const root = await fixture();
  const result = await runStaticPreflight({
    repoRoot: root,
    profile: "react-native",
    packageManager: "pnpm",
  });

  assert.equal(result.workingDirectory, ".");
  assert.deepEqual(result.commands, [
    "pnpm test:core",
    "pnpm check:architecture",
    "pnpm check:release",
  ]);
});

test("npm preflight는 npm run 형식의 canonical 명령을 반환한다", async () => {
  const root = await fixture();
  await writeFile(join(root, "package-lock.json"), "{}\n");
  const result = await runStaticPreflight({
    repoRoot: root,
    profile: "react-native",
    packageManager: "npm",
  });

  assert.deepEqual(result.commands, [
    "npm run test:core",
    "npm run check:architecture",
    "npm run check:release",
  ]);
});

test("working directory symlink로 저장소 밖을 벗어날 수 없다", async () => {
  const root = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "fleet-outside-"));
  temporaryRoots.push(outside);
  await symlink(outside, join(root, "escaped"));

  await assert.rejects(
    runStaticPreflight({
      repoRoot: root,
      workingDirectory: "escaped",
      profile: "react-native",
    }),
    /WORKING_DIRECTORY_ESCAPE/u,
  );
});

test("secret scan은 값이 아니라 파일과 rule ID만 반환한다", async () => {
  const root = await fixture();
  const canary = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
  await writeFile(join(root, "unsafe.txt"), `${canary}\n`);
  await execFileAsync("git", ["-C", root, "add", "unsafe.txt"]);

  const findings = await scanTrackedSecrets({ repoRoot: root });
  assert.deepEqual(findings, [{ file: "unsafe.txt", rule: "GITHUB_TOKEN" }]);
  assert.doesNotMatch(JSON.stringify(findings), new RegExp(canary, "u"));
});

test("secret scan은 대용량 또는 binary tracked file도 조용히 건너뛰지 않는다", async () => {
  const root = await fixture();
  const canary = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
  await writeFile(
    join(root, "large.bin"),
    Buffer.concat([Buffer.alloc(2 * 1024 * 1024 + 7), Buffer.from(canary)]),
  );
  await execFileAsync("git", ["-C", root, "add", "large.bin"]);

  const findings = await scanTrackedSecrets({ repoRoot: root });
  assert.deepEqual(findings, [{ file: "large.bin", rule: "GITHUB_TOKEN" }]);
  assert.doesNotMatch(JSON.stringify(findings), new RegExp(canary, "u"));
});

test("provenance는 허용된 공개 실행 identity만 기록한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-provenance-"));
  temporaryRoots.push(root);
  const outputPath = join(root, "provenance.json");
  const secret = ["never", "copy", "this"].join("-");
  const provenance = await writeProvenance({
    outputPath,
    profile: "godot",
    environment: {
      QUALITY_RESULT: "success",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_WORKFLOW_SHA: "c".repeat(40),
      GITHUB_REPOSITORY_ID: "123",
      GITHUB_REPOSITORY: "seorilabs/example",
      GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW_REF: "seorilabs/example/.github/workflows/ci.yml@refs/heads/main",
      GITHUB_RUN_ID: "456",
      GITHUB_RUN_ATTEMPT: "1",
      SEORI_WORKFLOW_REPOSITORY: "seorilabs/.github",
      SEORI_WORKFLOW_REF: `seorilabs/.github/.github/workflows/godot-checks-v2.yml@${"b".repeat(40)}`,
      SEORI_WORKFLOW_SHA: "b".repeat(40),
      RUNNER_ENVIRONMENT: "self-hosted",
      RUNNER_ARCH: "ARM64",
      RUNNER_OS: "Linux",
      UNRELATED_SECRET: secret,
    },
  });

  assert.equal(provenance.repository.id, "123");
  assert.equal(provenance.workflow.sha, "b".repeat(40));
  assert.equal(provenance.callerWorkflow.sha, "c".repeat(40));
  assert.equal(provenance.qualityJob.result, "success");
  assert.doesNotMatch(JSON.stringify(provenance), new RegExp(secret, "u"));
});

test("provenance는 분리된 quality job 성공 없이는 생성되지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-provenance-quality-"));
  temporaryRoots.push(root);
  await assert.rejects(
    writeProvenance({
      outputPath: join(root, "provenance.json"),
      profile: "react-native",
      environment: {
        QUALITY_RESULT: "failure",
        GITHUB_SHA: "a".repeat(40),
        SEORI_WORKFLOW_REPOSITORY: "seorilabs/.github",
        SEORI_WORKFLOW_REF: `seorilabs/.github/.github/workflows/rn-static-checks-v2.yml@${"b".repeat(40)}`,
        SEORI_WORKFLOW_SHA: "b".repeat(40),
      },
    }),
    /QUALITY_RESULT_INVALID/u,
  );
});

test("provenance는 caller SHA를 중앙 workflow SHA로 가장할 수 없다", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-provenance-invalid-"));
  temporaryRoots.push(root);
  await assert.rejects(
    writeProvenance({
      outputPath: join(root, "provenance.json"),
      profile: "react-native",
      environment: {
        QUALITY_RESULT: "success",
        GITHUB_SHA: "a".repeat(40),
        GITHUB_WORKFLOW_SHA: "c".repeat(40),
        SEORI_WORKFLOW_REPOSITORY: "seorilabs/.github",
        SEORI_WORKFLOW_REF: `seorilabs/.github/.github/workflows/rn-static-checks-v2.yml@${"c".repeat(40)}`,
        SEORI_WORKFLOW_SHA: "b".repeat(40),
      },
    }),
    /SEORI_WORKFLOW_REF_INVALID/u,
  );
});

test("provenance profile은 exact reusable workflow path와 일치해야 한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-provenance-profile-"));
  temporaryRoots.push(root);
  await assert.rejects(
    writeProvenance({
      outputPath: join(root, "provenance.json"),
      profile: "godot",
      environment: {
        QUALITY_RESULT: "success",
        GITHUB_SHA: "a".repeat(40),
        SEORI_WORKFLOW_REPOSITORY: "seorilabs/.github",
        SEORI_WORKFLOW_REF: `seorilabs/.github/.github/workflows/rn-static-checks-v2.yml@${"b".repeat(40)}`,
        SEORI_WORKFLOW_SHA: "b".repeat(40),
      },
    }),
    /SEORI_WORKFLOW_REF_INVALID/u,
  );
});
