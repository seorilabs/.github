import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { scanTrackedSecrets } from "../scripts/fleet/secret-scan.mjs";
import { runStaticPreflight } from "../scripts/fleet/static-preflight.mjs";

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

test("preflight는 존재하지 않는 root와 working directory를 안정된 code로 거부한다", async () => {
  const root = await fixture();
  await assert.rejects(
    runStaticPreflight({
      repoRoot: join(root, "missing-root"),
      profile: "react-native",
    }),
    /REPO_ROOT_INVALID/u,
  );
  await assert.rejects(
    runStaticPreflight({
      repoRoot: root,
      workingDirectory: "missing-directory",
      profile: "react-native",
    }),
    /WORKING_DIRECTORY_MISSING/u,
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

test("Firebase 클라이언트 API key는 비밀값으로 오탐하지 않는다", async () => {
  const root = await fixture();
  const firebaseClientKey = `AIza${"a".repeat(35)}`;
  await writeFile(
    join(root, "firebase-client.json"),
    `${JSON.stringify({ apiKey: firebaseClientKey })}\n`,
  );
  await execFileAsync("git", ["-C", root, "add", "firebase-client.json"]);

  assert.deepEqual(await scanTrackedSecrets({ repoRoot: root }), []);
});

test("service account private key 필드는 계속 차단한다", async () => {
  const root = await fixture();
  const canary = "not-a-real-private-key-material";
  await writeFile(
    join(root, "service-account.json"),
    `${JSON.stringify({ private_key: canary })}\n`,
  );
  await execFileAsync("git", ["-C", root, "add", "service-account.json"]);

  const findings = await scanTrackedSecrets({ repoRoot: root });
  assert.deepEqual(findings, [
    { file: "service-account.json", rule: "SERVICE_ACCOUNT_PRIVATE_KEY" },
  ]);
  assert.doesNotMatch(JSON.stringify(findings), new RegExp(canary, "u"));
});

test("secret scan은 존재하지 않는 root를 안정된 code로 거부한다", async () => {
  const root = await fixture();
  await assert.rejects(
    scanTrackedSecrets({ repoRoot: join(root, "missing-root") }),
    /REPO_ROOT_INVALID/u,
  );
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
