import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  analyzeGodotDiagnostics,
  runGodotDiagnosticGate,
} from "../scripts/fleet/godot-diagnostic-gate.mjs";
import { scanTrackedSecrets } from "../scripts/fleet/secret-scan.mjs";
import { stagePrivatePnpmStore } from "../scripts/fleet/stage-private-pnpm-store.mjs";
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

async function privatePackageFixture({ version = "0.4.0" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "fleet-private-package-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "apps", "mobile"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ private: true })}\n`,
  );
  await writeFile(
    join(root, "apps", "mobile", "package.json"),
    `${JSON.stringify({ dependencies: { "@seorilabs/platform-sdk": version } })}\n`,
  );
  await writeFile(
    join(root, "pnpm-lock.yaml"),
    [
      "lockfileVersion: '9.0'",
      "",
      `  '@seorilabs/platform-sdk@${version}':`,
      `    resolution: {integrity: sha512-${"a".repeat(86)}==, tarball: https://npm.pkg.github.com/download/@seorilabs/platform-sdk/${version}/${"b".repeat(40)}}`,
      "    engines: {node: '>=20'}",
      "",
    ].join("\n"),
  );
  await execFileAsync("git", ["init", "-q", root]);
  await execFileAsync("git", ["-C", root, "add", "."]);

  const fakePnpm = join(root, "fake-pnpm.mjs");
  await writeFile(
    fakePnpm,
    [
      "#!/usr/bin/env node",
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'const index = process.argv.indexOf("--store-dir");',
      'if (index < 0) process.exit(2);',
      'const store = process.argv[index + 1];',
      'mkdirSync(`${store}/v11/files`, { recursive: true });',
      'const content = process.env.FAKE_PNPM_LEAK === "1" ? process.env.NODE_AUTH_TOKEN : "private-package-content";',
      'writeFileSync(`${store}/v11/files/package`, content);',
      "",
    ].join("\n"),
  );
  await chmod(fakePnpm, 0o755);
  return { fakePnpm, root, storePath: join(root, ".seorilabs-pnpm-store") };
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

test("Godot 진단 gate는 중립 probe와 같은 toolchain 진단을 제품 오류로 오인하지 않는다", () => {
  const toolchainDiagnostic =
    "ERROR: Unable to initialize an optional runner service.";
  const result = analyzeGodotDiagnostics({
    toolchainLog: `Godot Engine\n${toolchainDiagnostic}\n`,
    applicationLog: `Godot Engine\n${toolchainDiagnostic}\n${toolchainDiagnostic}\n`,
  });

  assert.deepEqual(result, {
    applicationDiagnosticCount: 2,
    productDiagnosticCount: 0,
    toolchainDiagnosticCount: 1,
  });
});

test("Godot 진단 gate는 probe에 없던 제품 ERROR와 SCRIPT ERROR를 fail-closed한다", () => {
  const toolchainLog = "ERROR: Runner-only diagnostic.\n";
  assert.throws(
    () =>
      analyzeGodotDiagnostics({
        toolchainLog,
        applicationLog: `${toolchainLog}ERROR: Product import failed.\n`,
      }),
    /GODOT_PRODUCT_DIAGNOSTIC/u,
  );
  assert.throws(
    () =>
      analyzeGodotDiagnostics({
        toolchainLog,
        applicationLog: `${toolchainLog}SCRIPT ERROR: Invalid call.\n`,
      }),
    /GODOT_PRODUCT_DIAGNOSTIC/u,
  );
});

test("Godot 중립 probe 자체의 SCRIPT ERROR는 toolchain 실패로 차단한다", () => {
  assert.throws(
    () =>
      analyzeGodotDiagnostics({
        toolchainLog: "SCRIPT ERROR: Probe must not execute product scripts.\n",
        applicationLog: "",
      }),
    /GODOT_TOOLCHAIN_SCRIPT_ERROR/u,
  );
});

test("Godot 진단 gate는 로그를 제한해 읽고 요약에는 진단 내용 대신 경계별 건수만 쓴다", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-godot-diagnostic-"));
  temporaryRoots.push(root);
  const toolchainLogPath = join(root, "toolchain.log");
  const applicationLogPath = join(root, "application.log");
  const summaryPath = join(root, "summary.md");
  const diagnostic = "ERROR: Runner-only diagnostic.";
  await writeFile(toolchainLogPath, `${diagnostic}\n`);
  await writeFile(applicationLogPath, `${diagnostic}\n`);
  await writeFile(summaryPath, "");

  await runGodotDiagnosticGate({
    toolchainLogPath,
    applicationLogPath,
    summaryPath,
  });
  const summary = await readFile(summaryPath, "utf8");
  assert.match(summary, /고정 toolchain 진단: 1건/u);
  assert.match(summary, /제품 고유 진단: 0건/u);
  assert.doesNotMatch(summary, /Runner-only diagnostic/u);
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

test("private Platform SDK는 exact lockfile에서만 staging하고 token을 저장하지 않는다", async () => {
  const { fakePnpm, root, storePath } = await privatePackageFixture();
  const token = `github_pat_${"x".repeat(64)}`;
  const result = await stagePrivatePnpmStore({
    applicationRoot: root,
    storePath,
    token,
    pnpmCommand: fakePnpm,
    childEnvironment: { PATH: process.env.PATH },
  });

  assert.equal(result.package, "@seorilabs/platform-sdk");
  assert.equal(result.version, "0.4.0");
  assert.equal(result.tokenPersisted, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token, "u"));
  await access(join(storePath, "v11", "files", "package"));
});

test("private package child가 token을 store에 기록하면 staging 전체를 폐기한다", async () => {
  const { fakePnpm, root, storePath } = await privatePackageFixture();
  const token = `github_pat_${"y".repeat(64)}`;
  await assert.rejects(
    stagePrivatePnpmStore({
      applicationRoot: root,
      storePath,
      token,
      pnpmCommand: fakePnpm,
      childEnvironment: {
        FAKE_PNPM_LEAK: "1",
        PATH: process.env.PATH,
      },
    }),
    /PRIVATE_PACKAGE_TOKEN_PERSISTED/u,
  );
  await assert.rejects(access(storePath));
});

test("private Platform SDK의 range 또는 비공식 lockfile URL은 거부한다", async () => {
  const range = await privatePackageFixture({ version: "^0.4.0" });
  await assert.rejects(
    stagePrivatePnpmStore({
      applicationRoot: range.root,
      storePath: range.storePath,
      token: `github_pat_${"z".repeat(64)}`,
      pnpmCommand: range.fakePnpm,
      childEnvironment: { PATH: process.env.PATH },
    }),
    /PLATFORM_PACKAGE_VERSION_NOT_EXACT/u,
  );

  const unofficial = await privatePackageFixture();
  const lockfile = join(unofficial.root, "pnpm-lock.yaml");
  const current = await readFile(lockfile, "utf8");
  await writeFile(lockfile, current.replace("npm.pkg.github.com", "example.com"));
  await execFileAsync("git", ["-C", unofficial.root, "add", "pnpm-lock.yaml"]);
  await assert.rejects(
    stagePrivatePnpmStore({
      applicationRoot: unofficial.root,
      storePath: unofficial.storePath,
      token: `github_pat_${"q".repeat(64)}`,
      pnpmCommand: unofficial.fakePnpm,
      childEnvironment: { PATH: process.env.PATH },
    }),
    /PLATFORM_PACKAGE_LOCKFILE_UNTRUSTED/u,
  );
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
