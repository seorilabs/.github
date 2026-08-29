import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parse, stringify } from "yaml";

import { stageExactPlatformDependencyV5 } from "../scripts/fleet/stage-private-package-v5.mjs";

const runColdCache = process.env.WORKFLOW_BUNDLE_V5_COLD_CACHE === "1";
const roots = [];

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function successful(result, label) {
  assert.equal(
    result.status,
    0,
    `${label}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
}

async function localPlatformPackage(root) {
  const packageRoot = join(root, "local-platform-sdk");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
    name: "@seorilabs/platform-sdk",
    version: "1.2.3",
    files: ["index.js"],
  }, null, 2)}\n`);
  await writeFile(join(packageRoot, "index.js"), "export const fixture = true;\n");
  const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts"], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  successful(packed, "local Platform SDK pack failed");
  const metadata = JSON.parse(packed.stdout)[0];
  return {
    path: join(packageRoot, metadata.filename),
    integrity: metadata.integrity,
  };
}

async function fixtureClone(name) {
  const root = await mkdtemp(join(tmpdir(), `workflow-v5-cold-${name}-`));
  roots.push(root);
  await cp(resolve(`fixtures/workflow-bundle-v5/${name}/repository`), root, {
    recursive: true,
  });
  return root;
}

function initializeFixtureGit(root) {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "cold-cache fixture"]);
}

test("Capacitor/AIT npm fixture installs the complete lock from a truly cold staged cache", {
  skip: !runColdCache,
  timeout: 600_000,
}, async () => {
  const root = await fixtureClone("saju-reader");
  const sdk = await localPlatformPackage(root);
  await rm(join(root, "pnpm-lock.yaml"), { force: true });
  const manifestPath = join(root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.packageManager = "npm@11.13.0";
  manifest.dependencies["@seorilabs/platform-sdk"] = `file:${sdk.path}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const lockResult = spawnSync(
    "npm",
    [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--registry=https://registry.npmjs.org",
      "--userconfig=/dev/null",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 },
  );
  successful(lockResult, "npm lock generation failed");
  manifest.dependencies["@seorilabs/platform-sdk"] = "1.2.3";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const lockPath = join(root, "package-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.packages[""].dependencies["@seorilabs/platform-sdk"] = "1.2.3";
  const privateEntry = lock.packages["node_modules/@seorilabs/platform-sdk"];
  privateEntry.resolved =
    "https://npm.pkg.github.com/download/@seorilabs/platform-sdk/1.2.3/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await writeFile(
    join(root, ".npmrc"),
    "@seorilabs:registry=https://runner-metadata.internal\n//runner-metadata.internal/:_authToken=${NODE_AUTH_TOKEN}\n",
  );
  initializeFixtureGit(root);

  const cacheRoot = join(root, ".seorilabs-npm-cache");
  let calls = 0;
  const staged = await stageExactPlatformDependencyV5({
    repoRoot: root,
    dependencyRoot: ".",
    packageManager: "npm",
    cacheRoot,
    token: "cold-cache-token-never-persisted",
    spawn: (command, args, options) => {
      calls += 1;
      if (calls === 2) {
        assert.equal(options.env.NODE_AUTH_TOKEN, undefined);
        return { status: 0, signal: null };
      }
      const seed = spawnSync(
        "npm",
        ["cache", "add", sdk.path, "--cache", cacheRoot, "--ignore-scripts"],
        { ...options, env: { ...options.env, NODE_AUTH_TOKEN: undefined } },
      );
      successful(seed, "npm private cache seed failed");
      return spawnSync(command, args, options);
    },
  });
  assert.equal(staged.tokenPersisted, false);
  assert.equal(calls, 2);
  await rm(join(root, "node_modules"), { recursive: true, force: true });
  await rm(sdk.path, { force: true });
  const offline = spawnSync(
    "npm",
    [
      "ci",
      "--offline",
      "--ignore-scripts",
      "--cache",
      cacheRoot,
      "--registry=https://registry.npmjs.org",
      "--no-audit",
      "--no-fund",
    ],
    {
      cwd: root,
      env: { ...process.env, NODE_AUTH_TOKEN: undefined, NPM_CONFIG_OFFLINE: "true" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    },
  );
  successful(offline, "npm cold-cache offline install failed");
  assert.equal((await readFile(join(root, "node_modules/@seorilabs/platform-sdk/package.json"), "utf8")).includes("1.2.3"), true);
  assert.equal((await readFile(join(root, "node_modules/@capacitor/core/package.json"), "utf8")).includes("8.5.0"), true);
});

test("RN/AIT pnpm workspace fixture installs the complete lock from a truly cold staged store", {
  skip: !runColdCache,
  timeout: 600_000,
}, async () => {
  const root = await fixtureClone("trait-test-hub");
  const sdk = await localPlatformPackage(root);
  initializeFixtureGit(root);
  const cacheRoot = join(root, ".seorilabs-pnpm-store");
  let calls = 0;
  const rewritePrivateTarball = async (targetRoot) => {
    const lockPath = join(targetRoot, "pnpm-lock.yaml");
    const lock = parse(await readFile(lockPath, "utf8"));
    lock.packages["@seorilabs/platform-sdk@1.2.3"].resolution = {
      integrity: sdk.integrity,
      tarball: `file:${sdk.path}`,
    };
    await writeFile(lockPath, stringify(lock, { lineWidth: 0 }));
  };
  const staged = await stageExactPlatformDependencyV5({
    repoRoot: root,
    dependencyRoot: ".",
    packageManager: "pnpm",
    cacheRoot,
    token: "cold-cache-token-never-persisted",
    spawn: (command, args, options) => {
      calls += 1;
      if (calls === 2) {
        assert.equal(options.env.NODE_AUTH_TOKEN, undefined);
        return { status: 0, signal: null };
      }
      const stagingLockPath = join(options.cwd, "pnpm-lock.yaml");
      const stagingLock = parse(readFileSync(stagingLockPath, "utf8"));
      stagingLock.packages["@seorilabs/platform-sdk@1.2.3"].resolution = {
        integrity: sdk.integrity,
        tarball: `file:${sdk.path}`,
      };
      writeFileSync(stagingLockPath, stringify(stagingLock, { lineWidth: 0 }));
      return spawnSync(command, args, options);
    },
  });
  assert.equal(staged.tokenPersisted, false);
  assert.equal(calls, 2);
  await rewritePrivateTarball(root);
  await rm(join(root, "node_modules"), { recursive: true, force: true });
  await rm(join(root, "apps/ait/node_modules"), { recursive: true, force: true });
  await rm(sdk.path, { force: true });
  const offline = spawnSync(
    "pnpm",
    [
      "install",
      "--frozen-lockfile",
      "--trust-lockfile",
      "--offline",
      "--ignore-scripts",
      "--store-dir",
      cacheRoot,
      "--registry=https://registry.npmjs.org",
    ],
    {
      cwd: root,
      env: { ...process.env, NODE_AUTH_TOKEN: undefined, NPM_CONFIG_OFFLINE: "true" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    },
  );
  successful(offline, "pnpm cold-cache offline install failed");
  assert.equal((await readFile(join(root, "node_modules/@seorilabs/platform-sdk/package.json"), "utf8")).includes("1.2.3"), true);
  assert.equal((await readFile(join(root, "apps/ait/node_modules/react-native/package.json"), "utf8")).includes("0.84.0"), true);
});
