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

test("provenance는 허용된 공개 실행 identity만 기록한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-provenance-"));
  temporaryRoots.push(root);
  const outputPath = join(root, "provenance.json");
  const secret = ["never", "copy", "this"].join("-");
  const provenance = await writeProvenance({
    outputPath,
    profile: "godot",
    environment: {
      GITHUB_SHA: "a".repeat(40),
      GITHUB_WORKFLOW_SHA: "b".repeat(40),
      GITHUB_REPOSITORY_ID: "123",
      GITHUB_REPOSITORY: "seorilabs/example",
      GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW_REF: "seorilabs/.github/.github/workflows/godot-checks-v2.yml@refs/heads/main",
      GITHUB_RUN_ID: "456",
      GITHUB_RUN_ATTEMPT: "1",
      RUNNER_ENVIRONMENT: "self-hosted",
      RUNNER_ARCH: "ARM64",
      RUNNER_OS: "Linux",
      UNRELATED_SECRET: secret,
    },
  });

  assert.equal(provenance.repository.id, "123");
  assert.doesNotMatch(JSON.stringify(provenance), new RegExp(secret, "u"));
});
