import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  inspectExactPlatformDependencyV5,
  stageExactPlatformDependencyV5,
} from "../scripts/fleet/stage-private-package-v5.mjs";

// Platform #113 이 @seorilabs/platform-sdk 발행을 GitHub Packages 에서 공개 npm 으로
// 옮겼다. lockfile 해석처를 비공개 레지스트리 URL 로 고정해 두면, 이관한 저장소는
// 새 SDK 를 탑재하는 순간 PLATFORM_PACKAGE_LOCK_RESOLUTION_INVALID 로 막힌다.
// 실제로 happy-farm 과 saju-reader 가 0.5.0 을 올리면서 여기서 멈췄다.
//
// 과거 lockfile 은 여전히 GitHub Packages URL 을 담고 있으므로 양쪽을 모두 받는다.
const VERSION = "1.2.3";
const INTEGRITY = `sha512-${"a".repeat(86)}==`;
const PUBLIC_TARBALL =
  `https://registry.npmjs.org/@seorilabs/platform-sdk/-/platform-sdk-${VERSION}.tgz`;
const PRIVATE_TARBALL =
  `https://npm.pkg.github.com/download/@seorilabs/platform-sdk/${VERSION}/${"b".repeat(40)}`;

const execFileAsync = promisify(execFile);

// inspect 는 git 이 추적하는 package.json 만 후보로 본다. 저장소를 만들어 준다.
async function track(root) {
  await execFileAsync("git", ["init", "-q", root]);
  await execFileAsync("git", ["-C", root, "add", "."]);
}

const roots = [];

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), "platform-sdk-registry-"));
  roots.push(root);
  return root;
}

test.after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function pnpmRepo(resolutionSuffix) {
  const root = await makeRepo();
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({
      private: true,
      packageManager: "pnpm@11.3.0",
      dependencies: { "@seorilabs/platform-sdk": VERSION },
    })}\n`,
  );
  await writeFile(
    join(root, "pnpm-lock.yaml"),
    [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  .:",
      "    dependencies:",
      "      '@seorilabs/platform-sdk':",
      `        specifier: ${VERSION}`,
      `        version: ${VERSION}`,
      "",
      "packages:",
      "",
      `  '@seorilabs/platform-sdk@${VERSION}':`,
      `    resolution: {integrity: ${INTEGRITY}${resolutionSuffix}}`,
      "    engines: {node: '>=20'}",
      "",
    ].join("\n"),
  );
  await track(root);
  return root;
}

async function npmRepo(resolved) {
  const root = await makeRepo();
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({
      packageManager: "npm@11.13.0",
      dependencies: { "@seorilabs/platform-sdk": VERSION },
    })}\n`,
  );
  await writeFile(
    join(root, "package-lock.json"),
    `${JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { "@seorilabs/platform-sdk": VERSION } },
        "node_modules/@seorilabs/platform-sdk": {
          version: VERSION,
          resolved,
          integrity: INTEGRITY,
        },
      },
    })}\n`,
  );
  await track(root);
  return root;
}

test("pnpm: 공개 npm 은 tarball 을 적지 않는다. 그 형태를 받는다", async () => {
  const root = await pnpmRepo("");
  const inspected = await inspectExactPlatformDependencyV5({
    repoRoot: root,
    packageManager: "pnpm",
  });
  assert.equal(inspected.version, VERSION);
  assert.equal(inspected.integrity, INTEGRITY);
  assert.equal(inspected.registry, "public");
});

test("pnpm: 공개 npm tarball 을 적어도 받는다", async () => {
  const root = await pnpmRepo(`, tarball: ${PUBLIC_TARBALL}`);
  const inspected = await inspectExactPlatformDependencyV5({
    repoRoot: root,
    packageManager: "pnpm",
  });
  assert.equal(inspected.registry, "public");
});

test("pnpm: 과거 GitHub Packages lockfile 은 계속 받는다", async () => {
  const root = await pnpmRepo(`, tarball: ${PRIVATE_TARBALL}`);
  const inspected = await inspectExactPlatformDependencyV5({
    repoRoot: root,
    packageManager: "pnpm",
  });
  assert.equal(inspected.registry, "private");
});

test("pnpm: 제3의 레지스트리는 거부한다", async () => {
  const root = await pnpmRepo(
    `, tarball: https://registry.yarnpkg.com/@seorilabs/platform-sdk/-/platform-sdk-${VERSION}.tgz`,
  );
  await assert.rejects(
    () => inspectExactPlatformDependencyV5({ repoRoot: root, packageManager: "pnpm" }),
    /PLATFORM_PACKAGE_LOCK_RESOLUTION_INVALID|LOCKFILE_REGISTRY_FORBIDDEN/u,
  );
});

test("npm: 공개 npm resolved 를 받는다", async () => {
  const root = await npmRepo(PUBLIC_TARBALL);
  const inspected = await inspectExactPlatformDependencyV5({
    repoRoot: root,
    packageManager: "npm",
  });
  assert.equal(inspected.integrity, INTEGRITY);
  assert.equal(inspected.registry, "public");
});

test("npm: 과거 GitHub Packages resolved 는 계속 받는다", async () => {
  const root = await npmRepo(PRIVATE_TARBALL);
  const inspected = await inspectExactPlatformDependencyV5({
    repoRoot: root,
    packageManager: "npm",
  });
  assert.equal(inspected.registry, "private");
});

test("npm: 버전이 다른 tarball 은 거부한다", async () => {
  const root = await npmRepo(
    "https://registry.npmjs.org/@seorilabs/platform-sdk/-/platform-sdk-9.9.9.tgz",
  );
  await assert.rejects(
    () => inspectExactPlatformDependencyV5({ repoRoot: root, packageManager: "npm" }),
    /PLATFORM_PACKAGE_LOCK_RESOLUTION_INVALID/u,
  );
});

test("staging npmrc 는 공개 npm 일 때 스코프 override 와 토큰 줄을 쓰지 않는다", async () => {
  // 필요 없는 인증을 남기면 토큰이 없다는 이유로 설치가 막힌다. 소비자 저장소의
  // Xcode Cloud 스크립트가 실제로 그 상태였다.
  const root = await npmRepo(PUBLIC_TARBALL);
  await execFileAsync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "-qm", "fixture"]);

  const cacheRoot = join(root, ".seorilabs-npm-cache");
  const token = "token-that-must-never-be-persisted";
  const seen = [];
  await stageExactPlatformDependencyV5({
    repoRoot: root,
    dependencyRoot: ".",
    packageManager: "npm",
    cacheRoot,
    token,
    childEnvironment: { HOME: "/tmp/fixture-home", PATH: "/usr/bin:/bin" },
    spawn: (_command, args, options) => {
      const config = readFileSync(options.env.NPM_CONFIG_USERCONFIG, "utf8");
      seen.push({ args: args.join(" "), config, auth: options.env.NODE_AUTH_TOKEN });
      mkdirSync(join(cacheRoot, "content"), { recursive: true });
      writeFileSync(join(cacheRoot, "content", "package.tgz"), "public-package-bytes");
      return { status: 0, signal: null };
    },
  });

  const install = seen.find((entry) => entry.args.startsWith("ci "));
  assert.ok(install, "설치 단계가 실행되지 않았다");
  assert.match(install.config, /@seorilabs:registry=https:\/\/registry\.npmjs\.org/u);
  assert.doesNotMatch(install.config, /npm\.pkg\.github\.com/u);
  assert.doesNotMatch(install.config, /_authToken/u);
  assert.doesNotMatch(install.config, /token-that-must/u);
});

test("staging npmrc 는 과거 GitHub Packages lockfile 에서는 인증을 유지한다", async () => {
  const root = await npmRepo(PRIVATE_TARBALL);
  await execFileAsync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "-qm", "fixture"]);

  const cacheRoot = join(root, ".seorilabs-npm-cache");
  const seen = [];
  await stageExactPlatformDependencyV5({
    repoRoot: root,
    dependencyRoot: ".",
    packageManager: "npm",
    cacheRoot,
    token: "fixture-token-long-enough-for-guard",
    childEnvironment: { HOME: "/tmp/fixture-home", PATH: "/usr/bin:/bin" },
    spawn: (_command, args, options) => {
      seen.push({
        args: args.join(" "),
        config: readFileSync(options.env.NPM_CONFIG_USERCONFIG, "utf8"),
      });
      mkdirSync(join(cacheRoot, "content"), { recursive: true });
      writeFileSync(join(cacheRoot, "content", "package.tgz"), "private-package-bytes");
      return { status: 0, signal: null };
    },
  });

  const install = seen.find((entry) => entry.args.startsWith("ci "));
  assert.match(install.config, /@seorilabs:registry=https:\/\/npm\.pkg\.github\.com/u);
  assert.match(install.config, /_authToken/u);
});
