import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

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
  ".generated/contracts/fleet-cleanup-execution-receipt.schema.json",
  ".generated/contracts/fleet-migration-chain-head.schema.json",
  ".generated/contracts/fleet-migration-inventory.schema.json",
  ".generated/contracts/fleet-migration-plan.schema.json",
  ".generated/contracts/markets/app-store.schema.json",
  ".generated/contracts/markets/apps-in-toss.schema.json",
  ".generated/contracts/markets/google-play.schema.json",
  ".generated/contracts/release-policy.yaml",
  ".generated/contracts/review-policy.yaml",
  ".generated/contracts/test-policy.yaml",
  ".generated/contracts/workflow-bundle.schema.json",
  ".generated/contracts/workflow-bundle-source.yaml",
  ".generated/contracts/workflow-bundle-v5-resolved-binding.schema.json",
  ".generated/contracts/workflow-bundle-v5-static-runtime-readback.schema.json",
  ".generated/contracts/workflow-bundle-v5-source.yaml",
  ".generated/contracts/workflow-bundle-v5.schema.json",
  ".generated/contracts/xcode-cloud-run-v5.schema.json",
  ".generated/contracts/xcode-cloud-run.schema.json",
  ".generated/profiles/godot.yaml",
  ".generated/profiles/react-native.yaml",
  ".generated/profiles/ait-granite-v5.yaml",
  ".generated/profiles/ait-web-build-v5.yaml",
  ".generated/profiles/ait-web-v5.yaml",
  ".generated/profiles/capacitor-android-v5.yaml",
  ".generated/profiles/capacitor-ios-xcode-cloud-v5.yaml",
  ".generated/profiles/capacitor-v5.yaml",
  "README.md",
  "src/cli.mjs",
  "src/bootstrap.mjs",
  "src/fleet-migration-collector.mjs",
  "src/fleet-migration.mjs",
  "src/trusted-cleanup-executor.mjs",
  "src/workflow-bundle-v5.mjs",
  "src/trusted-inventory-issuer.mjs",
];

const cacheRoot = await mkdtemp(join(tmpdir(), "repo-contract-pack-cache-"));
let checkError;
try {
  await prepare();
  const sourceModule = await import(`./index.mjs?pack-check=${Date.now()}`);
  if (
    sourceModule.DEFAULT_SCHEMA_PATH !==
      resolve(workspaceRoot, "contracts/app.schema.json") ||
    sourceModule.DEFAULT_PROFILES_ROOT !== resolve(workspaceRoot, "profiles")
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
          tarball: `https://npm.pkg.github.com/download/@seorilabs/platform-sdk/1.0.0/${"a".repeat(40)}`,
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
  const executable =
    process.platform === "win32"
      ? resolve(consumerRoot, "node_modules/.bin/repo-contract.cmd")
      : resolve(consumerRoot, "node_modules/.bin/repo-contract");
  const installedCheck = await execFileAsync(executable, [fixtureRoot], {
    cwd: consumerRoot,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (!installedCheck.stdout.includes("계약 검증 통과")) {
    throw new Error(
      "설치된 repo-contract CLI가 fixture를 검증하지 못했습니다.",
    );
  }
  const installedBootstrapCheck = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'const installed = await import("@seorilabs/repo-contract/bootstrap");',
        'if (typeof installed.createFleetWebhookHandler !== "function") process.exit(1);',
        'if (typeof installed.attachFleetProvisioningOperations !== "function") process.exit(1);',
        'if (typeof installed.validateFleetBootstrapPlan !== "function") process.exit(1);',
        'if (installed.fleetBootstrapContract?.webhookCredentialId !== "shared/github/backoffice-app-webhook") process.exit(1);',
        'process.stdout.write("Fleet bootstrap public export 검증 통과\\n");',
      ].join("\n"),
    ],
    {
      cwd: consumerRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (!installedBootstrapCheck.stdout.includes("public export 검증 통과")) {
    throw new Error("배포된 repo-contract에 Fleet bootstrap API가 없습니다.");
  }
  const installedExecutorCheck = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'const installed = await import("@seorilabs/repo-contract/trusted-executor");',
        'if (typeof installed.createGitHubAppTrustedAdapter !== "function") process.exit(1);',
        'if (typeof installed.createTrustedFleetExecutor !== "function") process.exit(1);',
        'if (installed.trustedFleetExecutorContract?.githubAppCredentialId !== "shared/github/fleet-app") process.exit(1);',
        'process.stdout.write("Fleet trusted executor public export 검증 통과\\n");',
      ].join("\n"),
    ],
    {
      cwd: consumerRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (!installedExecutorCheck.stdout.includes("public export 검증 통과")) {
    throw new Error(
      "배포된 repo-contract에 Fleet trusted executor API가 없습니다.",
    );
  }
  const installedMigrationCheck = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'const installed = await import("@seorilabs/repo-contract/fleet-migration");',
        'if (typeof installed.createFleetMigrationPlan !== "function") process.exit(1);',
        'if (typeof installed.validateFleetMigrationChainHead !== "function") process.exit(1);',
        'if (typeof installed.validateFleetMigrationPlan !== "function") process.exit(1);',
        'if (typeof installed.validateFleetMigrationPlanStructure !== "function") process.exit(1);',
        'if (typeof installed.computeFleetRepositoryReadbackDigest !== "function") process.exit(1);',
        'if (typeof installed.computeFleetFindingsDigest !== "function") process.exit(1);',
        'if (typeof installed.computeFleetMigrationInventoryDigest !== "function") process.exit(1);',
        'if (typeof installed.computeFleetMigrationChainHeadDigest !== "function") process.exit(1);',
        'if (typeof installed.computeFleetMigrationLineageChainDigest !== "function") process.exit(1);',
        'if (typeof installed.deriveFleetMigrationInventoryCheckpoint !== "function") process.exit(1);',
        'if (typeof installed.createFleetMigrationAttestationPayload !== "function") process.exit(1);',
        'if (typeof installed.createFleetMigrationChainHeadAttestationPayload !== "function") process.exit(1);',
        'if (typeof installed.loadTrustedFleetMigrationChainHeadBinding !== "function") process.exit(1);',
        'if (typeof installed.loadTrustedFleetMigrationInventoryBinding !== "function") process.exit(1);',
        'if (typeof installed.loadTrustedFleetMigrationHistoricalInventoryBinding !== "function") process.exit(1);',
        'if (typeof installed.computeFleetMigrationReplacementDigest !== "function") process.exit(1);',
        'if (typeof installed.computeFleetMigrationOutageRecoveryDigest !== "function") process.exit(1);',
        'if (typeof installed.computeFleetMigrationOwnerScopeDigest !== "function") process.exit(1);',
        "if (installed.fleetMigrationContract?.executionAllowed !== false) process.exit(1);",
        'if (installed.fleetMigrationContract?.mode !== "PLAN_ONLY") process.exit(1);',
        'if (installed.fleetMigrationContract?.inventoryAttestation?.contract !== "seorilabs-fleet-migration-inventory-attestation-v2") process.exit(1);',
        'if (installed.fleetMigrationContract?.chainHeadAttestation?.role !== "FLEET_MIGRATION_CHAIN_HEAD_AUTHORITY") process.exit(1);',
        "if (installed.fleetMigrationContract?.initialBaseline?.expectedCounts?.legacyOperationJson !== 73) process.exit(1);",
        'process.stdout.write("Fleet migration planner public export 검증 통과\\n");',
      ].join("\n"),
    ],
    {
      cwd: consumerRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (!installedMigrationCheck.stdout.includes("public export 검증 통과")) {
    throw new Error(
      "배포된 repo-contract에 Fleet migration planner API가 없습니다.",
    );
  }
  const installedCollectorCheck = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'const installed = await import("@seorilabs/repo-contract/fleet-migration-collector");',
        'if (typeof installed.createFleetMigrationReadOnlyCollector !== "function") process.exit(1);',
        'if (typeof installed.validateFleetMigrationCollection !== "function") process.exit(1);',
        'if (typeof installed.validateFleetGitHubAppCapability !== "function") process.exit(1);',
        'if (typeof installed.isFleetGitHubAppCapabilityVerified !== "function") process.exit(1);',
        'if (installed.fleetMigrationCollectorContract?.githubApp?.installationId !== "142120077") process.exit(1);',
        'if (Object.hasOwn(installed.fleetMigrationCollectorContract ?? {}, "githubAppGateIssue")) process.exit(1);',
        'process.stdout.write("Fleet migration collector public export 검증 통과\\n");',
      ].join("\n"),
    ],
    {
      cwd: consumerRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (!installedCollectorCheck.stdout.includes("public export 검증 통과")) {
    throw new Error(
      "배포된 repo-contract에 Fleet migration collector API가 없습니다.",
    );
  }
  const installedIssuerCheck = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'const installed = await import("@seorilabs/repo-contract/trusted-inventory-issuer");',
        'if (typeof installed.createFleetMigrationInventoryIssuer !== "function") process.exit(1);',
        'if (typeof installed.validateFleetMigrationAuthoritativeInventory !== "function") process.exit(1);',
        'if (installed.fleetMigrationInventoryIssuerContract?.signingCredentialId !== "shared/platform/fleet-release-approval-signing") process.exit(1);',
        'if (installed.fleetMigrationInventoryIssuerContract?.keyId !== "platform-fleet-release-20260829-5458c56b") process.exit(1);',
        'if (installed.fleetMigrationInventoryIssuerContract?.authoritativeIssuanceEnabled !== true) process.exit(1);',
        'if (installed.fleetMigrationInventoryIssuerContract?.privateKeyInputAllowed !== false) process.exit(1);',
        'process.stdout.write("Fleet migration inventory issuer public export 검증 통과\\n");',
      ].join("\n"),
    ],
    {
      cwd: consumerRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (!installedIssuerCheck.stdout.includes("public export 검증 통과")) {
    throw new Error(
      "배포된 repo-contract에 Fleet migration inventory issuer API가 없습니다.",
    );
  }
  const installedCleanupExecutorCheck = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'const installed = await import("@seorilabs/repo-contract/trusted-cleanup-executor");',
        'if (typeof installed.createTrustedFleetCleanupGitHubAdapter !== "function") process.exit(1);',
        'if (typeof installed.createTrustedFleetCleanupStateStore !== "function") process.exit(1);',
        'if (typeof installed.createTrustedFleetCleanupExecutor !== "function") process.exit(1);',
        'if (typeof installed.computeFleetCleanupApprovalScopeDigest !== "function") process.exit(1);',
        'if (typeof installed.validateFleetCleanupExecutionReceipt !== "function") process.exit(1);',
        'if (installed.trustedFleetCleanupExecutorContract?.mode !== "READY_PR_ONLY") process.exit(1);',
        'if (installed.trustedFleetCleanupExecutorContract?.repositoryReadyPullRequestLimit !== 1) process.exit(1);',
        'if (installed.trustedFleetCleanupExecutorContract?.directDefaultBranchMutationAllowed !== false) process.exit(1);',
        'if (installed.trustedFleetCleanupExecutorContract?.resultUnknownRetryAllowed !== false) process.exit(1);',
        'process.stdout.write("Fleet cleanup executor public export 검증 통과\\n");',
      ].join("\n"),
    ],
    {
      cwd: consumerRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (
    !installedCleanupExecutorCheck.stdout.includes("public export 검증 통과")
  ) {
    throw new Error(
      "배포된 repo-contract에 Fleet cleanup executor API가 없습니다.",
    );
  }
  const installedCandidateCanaryCheck = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'const installed = await import("@seorilabs/repo-contract/trusted-candidate-canary");',
        'if (typeof installed.loadTrustedCandidateBundle !== "function") process.exit(1);',
        'if (typeof installed.createTrustedCandidateCanaryPlan !== "function") process.exit(1);',
        'if (typeof installed.createTrustedCandidateCanaryExecutor !== "function") process.exit(1);',
        'if (installed.trustedCandidateCanaryContract?.operationKind !== "github.candidate-canary-pull-request.ensure") process.exit(1);',
        'if (installed.trustedCandidateCanaryContract?.wifApprovalPurpose !== "CANDIDATE_WIF_PREBIND") process.exit(1);',
        'if (installed.trustedCandidateCanaryContract?.wifLogicalCredentialId !== "shared/gcp/cloud-build") process.exit(1);',
        'process.stdout.write("WorkflowBundle candidate canary public export 검증 통과\\n");',
      ].join("\n"),
    ],
    {
      cwd: consumerRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (
    !installedCandidateCanaryCheck.stdout.includes("public export 검증 통과")
  ) {
    throw new Error("배포된 repo-contract에 candidate canary API가 없습니다.");
  }
  const installedPublisherCheck = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'const installed = await import("@seorilabs/repo-contract/trusted-publisher");',
        'if (typeof installed.createTrustedWorkflowBundlePublisher !== "function") process.exit(1);',
        'if (installed.trustedWorkflowBundlePublisherContract?.signingCredentialId !== "shared/workflow-bundle/approval-signing") process.exit(1);',
        'process.stdout.write("WorkflowBundle trusted publisher public export 검증 통과\\n");',
      ].join("\n"),
    ],
    {
      cwd: consumerRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (!installedPublisherCheck.stdout.includes("public export 검증 통과")) {
    throw new Error(
      "배포된 repo-contract에 WorkflowBundle trusted publisher API가 없습니다.",
    );
  }
  const installedV5Check = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'const installed = await import("@seorilabs/repo-contract/workflow-bundle-v5");',
        'if (typeof installed.createWorkflowBundleV5 !== "function") process.exit(1);',
        'if (typeof installed.generateStaticCallerV5 !== "function") process.exit(1);',
        'if (typeof installed.generateCandidateStaticCallerV5 !== "function") process.exit(1);',
        'if (typeof installed.generateCandidateBuildCallerV5 !== "function") process.exit(1);',
        'if (installed.workflowBundleV5Contract?.bundleVersion !== "5.0.0") process.exit(1);',
        'process.stdout.write("WorkflowBundle v5 public export 검증 통과\\n");',
      ].join("\n"),
    ],
    {
      cwd: consumerRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (!installedV5Check.stdout.includes("v5 public export 검증 통과")) {
    throw new Error("배포된 repo-contract에 WorkflowBundle v5 API가 없습니다.");
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
