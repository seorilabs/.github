import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  clean,
  generatedRoot,
  packageRoot,
  prepare,
} from "./pack-contracts.mjs";

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(packageRoot, "../..");
const requiredPackageFiles = [
  ".generated/contracts/agent-policy.yaml",
  ".generated/contracts/app.schema.json",
  ".generated/contracts/credential-consumer.schema.json",
  ".generated/contracts/fleet-bootstrap-plan.schema.json",
  ".generated/contracts/markets/app-store.schema.json",
  ".generated/contracts/markets/apps-in-toss.schema.json",
  ".generated/contracts/markets/google-play.schema.json",
  ".generated/contracts/release-policy.yaml",
  ".generated/contracts/review-policy.yaml",
  ".generated/contracts/test-policy.yaml",
  ".generated/profiles/godot.yaml",
  ".generated/profiles/react-native.yaml",
  "README.md",
  "src/cli.mjs",
  "src/bootstrap.mjs",
];

const cacheRoot = await mkdtemp(join(tmpdir(), "repo-contract-pack-cache-"));
let checkError;
try {
  await prepare();
  const sourceModule = await import(`./index.mjs?pack-check=${Date.now()}`);
  if (
    sourceModule.DEFAULT_SCHEMA_PATH !==
      resolve(workspaceRoot, "contracts/app.schema.json") ||
    sourceModule.DEFAULT_PROFILES_ROOT !==
      resolve(workspaceRoot, "profiles")
  ) {
    throw new Error("소스 workspace가 생성된 pack snapshot을 우선했습니다.");
  }
  const { stdout } = await execFileAsync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "pack",
      "--workspace",
      "@seorilabs/repo-contract",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      cacheRoot,
      "--cache",
      cacheRoot,
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const report = JSON.parse(stdout);
  const packageFiles = new Set(
    (report[0]?.files ?? []).map((file) => file.path),
  );
  const missingFiles = requiredPackageFiles.filter(
    (file) => !packageFiles.has(file),
  );
  if (missingFiles.length > 0) {
    throw new Error("repo-contract 배포 패키지에 필수 계약 파일이 없습니다.");
  }

  const tarballPath = resolve(cacheRoot, report[0]?.filename ?? "");
  if (!existsSync(tarballPath)) {
    throw new Error("repo-contract tarball이 생성되지 않았습니다.");
  }
  const consumerRoot = resolve(cacheRoot, "consumer");
  const fixtureRoot = resolve(consumerRoot, "fixture-repository");
  await mkdir(resolve(fixtureRoot, ".seorilabs"), { recursive: true });
  const localRuntimeDependencies = [
    "ajv",
    "fast-deep-equal",
    "fast-uri",
    "json-schema-traverse",
    "require-from-string",
    "yaml",
  ];
  await writeFile(
    resolve(consumerRoot, "package.json"),
    `${JSON.stringify({
      private: true,
      dependencies: Object.fromEntries(
        localRuntimeDependencies.map((name) => [
          name,
          `file:${resolve(workspaceRoot, "node_modules", name)}`,
        ]),
      ),
    })}\n`,
    "utf8",
  );
  await execFileAsync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--offline",
      "--cache",
      resolve(cacheRoot, "install-cache"),
      tarballPath,
    ],
    { cwd: consumerRoot, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );

  const fixtureManifest = {
    schemaVersion: 1,
    app: {
      id: "pack-fixture",
      displayName: "Pack Fixture",
      kind: "app",
      profile: "react-native",
      lifecycle: "prelaunch",
    },
    repository: { defaultBranch: "main" },
    quality: {
      policy: "org-v1",
      commands: {
        core: "pnpm test:core",
        architecture: "pnpm check:architecture",
        release: "pnpm check:release",
      },
    },
    release: { policy: "org-v1", trigger: "explicit-semver-tag" },
    sdk: {
      distribution: "package",
      package: "@seorilabs/platform-sdk",
      version: "1.0.0",
      lockfile: "pnpm-lock.yaml",
      consumers: [{ packageJson: "package.json", lockfileImporter: "." }],
    },
    markets: {},
    credentials: {
      consumersManifest: ".seorilabs/credential-consumers.yaml",
    },
  };
  const fixturePackage = {
    scripts: {
      "test:core": "node --test",
      "check:architecture": "node --check architecture.mjs",
      "check:release": "node --check release.mjs",
    },
    dependencies: { "@seorilabs/platform-sdk": "1.0.0" },
  };
  const fixtureLockfile = {
    lockfileVersion: "9.0",
    importers: {
      ".": {
        dependencies: {
          "@seorilabs/platform-sdk": {
            specifier: "1.0.0",
            version: "1.0.0",
          },
        },
      },
    },
    packages: {
      "@seorilabs/platform-sdk@1.0.0": {
        resolution: {
          integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
          tarball:
            `https://npm.pkg.github.com/download/@seorilabs/platform-sdk/1.0.0/${"a".repeat(40)}`,
        },
      },
    },
  };
  await Promise.all([
    writeFile(
      resolve(fixtureRoot, ".seorilabs/app.yaml"),
      `${JSON.stringify(fixtureManifest)}\n`,
      "utf8",
    ),
    writeFile(
      resolve(fixtureRoot, ".seorilabs/credential-consumers.yaml"),
      `${JSON.stringify({
        schemaVersion: 1,
        appId: "pack-fixture",
        consumers: [],
      })}\n`,
      "utf8",
    ),
    writeFile(
      resolve(fixtureRoot, "package.json"),
      `${JSON.stringify(fixturePackage)}\n`,
      "utf8",
    ),
    writeFile(
      resolve(fixtureRoot, "pnpm-lock.yaml"),
      `${JSON.stringify(fixtureLockfile)}\n`,
      "utf8",
    ),
  ]);
  const executable = process.platform === "win32"
    ? resolve(consumerRoot, "node_modules/.bin/repo-contract.cmd")
    : resolve(consumerRoot, "node_modules/.bin/repo-contract");
  const installedCheck = await execFileAsync(executable, [fixtureRoot], {
    cwd: consumerRoot,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (!installedCheck.stdout.includes("계약 검증 통과")) {
    throw new Error("설치된 repo-contract CLI가 fixture를 검증하지 못했습니다.");
  }
  const installedBootstrap = await import(
    pathToFileURL(
      resolve(
        consumerRoot,
        "node_modules/@seorilabs/repo-contract/src/bootstrap.mjs",
      ),
    ).href
  );
  if (
    typeof installedBootstrap.createFleetWebhookHandler !== "function" ||
    typeof installedBootstrap.validateFleetBootstrapPlan !== "function" ||
    installedBootstrap.fleetBootstrapContract?.webhookCredentialId !==
      "shared/github/fleet-app-webhook"
  ) {
    throw new Error("배포된 repo-contract에 Fleet bootstrap API가 없습니다.");
  }
} catch (error) {
  checkError = error;
} finally {
  try {
    await clean();
  } finally {
    await rm(cacheRoot, { force: true, recursive: true });
  }
}

if (existsSync(generatedRoot)) {
  throw new Error("repo-contract pack 검증 후 생성물이 남았습니다.");
}
if (checkError) {
  throw checkError;
}

process.stdout.write("repo-contract 배포 패키지 검증 통과\n");
