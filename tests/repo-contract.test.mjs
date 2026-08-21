import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse, stringify } from "yaml";

import { runCli } from "../packages/repo-contract/src/cli.mjs";
import {
  computeVendoredTreeChecksum,
  DEFAULT_SCHEMA_PATH,
  validateRepository,
} from "../packages/repo-contract/src/index.mjs";

const temporaryRoots = [];
const WORKSPACE_SCHEMA_PATH = fileURLToPath(
  new URL("../contracts/app.schema.json", import.meta.url),
);
const WORKSPACE_PROFILES_ROOT = fileURLToPath(
  new URL("../profiles", import.meta.url),
);
const WORKSPACE_RELEASE_POLICY_PATH = fileURLToPath(
  new URL("../contracts/release-policy.yaml", import.meta.url),
);
const SENSITIVE_FIXTURE_VALUE = ["do", "not", "print", "fixture"].join("-");
const PROVIDER_TOKEN_FIXTURE = ["ghp", "abcdefghijklmnopqrstuvwxyz"].join("_");

test.afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

function testSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: [
      "schemaVersion",
      "app",
      "repository",
      "quality",
      "release",
      "sdk",
      "markets",
      "credentials",
    ],
    properties: {
      schemaVersion: { const: 1 },
      app: {
        type: "object",
        required: ["id", "displayName", "kind", "profile", "lifecycle"],
        properties: {
          id: { type: "string" },
          displayName: { type: "string" },
          kind: { enum: ["app", "game"] },
          profile: { enum: ["react-native", "godot"] },
          lifecycle: { enum: ["prelaunch", "launched", "archived"] },
        },
      },
      repository: {
        type: "object",
        required: ["defaultBranch"],
        properties: { defaultBranch: { type: "string" } },
      },
      quality: {
        type: "object",
        required: ["policy", "commands"],
        properties: {
          policy: { const: "org-v1" },
          commands: {
            type: "object",
            required: ["core", "architecture", "release"],
            properties: {
              core: { const: "pnpm test:core" },
              architecture: { const: "pnpm check:architecture" },
              release: { const: "pnpm check:release" },
            },
          },
        },
      },
      release: { type: "object" },
      sdk: { type: "object" },
      markets: { type: "object" },
      credentials: { type: "object" },
      operationsManifest: { type: "string" },
    },
  };
}

function validManifest() {
  return {
    schemaVersion: 1,
    app: {
      id: "fixture-app",
      displayName: "Fixture App",
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
      version: "1.2.3",
      lockfile: "pnpm-lock.yaml",
      consumers: [
        {
          packageJson: "package.json",
          lockfileImporter: ".",
        },
      ],
    },
    markets: { googlePlay: { enabled: false } },
    credentials: {
      consumersManifest: ".seorilabs/credential-consumers.yaml",
    },
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createFixture({ manifest = validManifest() } = {}) {
  const root = await mkdtemp(join(tmpdir(), "repo-contract-test-"));
  temporaryRoots.push(root);
  const contractsRoot = join(root, "org-contracts");
  const profilesRoot = join(root, "profiles");
  await Promise.all([
    mkdir(join(root, ".seorilabs"), { recursive: true }),
    mkdir(contractsRoot, { recursive: true }),
    mkdir(profilesRoot, { recursive: true }),
  ]);

  await Promise.all([
    writeFile(
      join(root, ".seorilabs", "app.yaml"),
      stringify(manifest),
      "utf8",
    ),
    writeFile(
      join(root, ".seorilabs", "credential-consumers.yaml"),
      "schemaVersion: 1\nappId: fixture-app\nconsumers: []\n",
      "utf8",
    ),
    writeJson(join(contractsRoot, "app.schema.json"), testSchema()),
    writeJson(join(contractsRoot, "credential-consumer.schema.json"), {
      type: "object",
    }),
    writeFile(
      join(profilesRoot, "react-native.yaml"),
      "requiredFiles:\n  - .seorilabs/app.yaml\n  - package.json\n  - pnpm-lock.yaml\n",
      "utf8",
    ),
    writeJson(join(root, "package.json"), {
      scripts: {
        "test:core": "node --test",
        "check:architecture": "node --check architecture.mjs",
        "check:release": "node --check release.mjs",
      },
      dependencies:
        manifest.sdk?.distribution === "package" &&
          manifest.sdk.consumers?.some(
            (consumer) => consumer.packageJson === "package.json",
          )
          ? { [manifest.sdk.package]: manifest.sdk.version }
          : {},
    }),
    writeFile(
      join(root, "pnpm-lock.yaml"),
      stringify({
        lockfileVersion: "9.0",
        importers:
          manifest.sdk?.distribution === "package"
            ? Object.fromEntries(
                manifest.sdk.consumers.map((consumer) => [
                  consumer.lockfileImporter,
                  {
                    dependencies: {
                      [manifest.sdk.package]: {
                        specifier: manifest.sdk.version,
                        version: manifest.sdk.version,
                      },
                    },
                  },
                ]),
              )
            : { ".": {} },
        packages:
          manifest.sdk?.distribution === "package"
            ? {
                [`${manifest.sdk.package}@${manifest.sdk.version}`]: {
                  resolution: {
                    integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
                    tarball:
                      `https://npm.pkg.github.com/download/${manifest.sdk.package}/${manifest.sdk.version}/${"a".repeat(40)}`,
                  },
                },
              }
            : {},
      }),
      "utf8",
    ),
  ]);

  return {
    root,
    schemaPath: join(contractsRoot, "app.schema.json"),
    profilesRoot,
  };
}

async function createGodotFixture() {
  const manifest = validManifest();
  manifest.app.kind = "game";
  manifest.app.profile = "godot";
  manifest.sdk = {
    distribution: "vendored",
    root: "addons/seorilabs-sdk",
    provenance: {
      source: "addons/seorilabs-sdk/SOURCE",
      version: "addons/seorilabs-sdk/VERSION",
      checksum: "addons/seorilabs-sdk/CHECKSUM",
    },
  };
  const fixture = await createFixture({ manifest });
  const sdkRoot = join(fixture.root, "addons", "seorilabs-sdk");
  await mkdir(sdkRoot, { recursive: true });
  await Promise.all([
    writeFile(join(fixture.root, "project.godot"), "[application]\n", "utf8"),
    writeFile(join(sdkRoot, "plugin.gd"), "extends Node\n", "utf8"),
    writeFile(
      join(sdkRoot, "SOURCE"),
      "https://github.com/seorilabs/platform/releases/tag/v1.2.3\n",
      "utf8",
    ),
    writeFile(join(sdkRoot, "VERSION"), "1.2.3\n", "utf8"),
    writeFile(join(sdkRoot, "CHECKSUM"), `${"0".repeat(64)}\n`, "utf8"),
  ]);
  const { checksum } = await computeVendoredTreeChecksum(sdkRoot);
  await writeFile(join(sdkRoot, "CHECKSUM"), `${checksum}\n`, "utf8");
  return { ...fixture, sdkRoot };
}

function hasCode(result, code) {
  return result.diagnostics.some((diagnostic) => diagnostic.code === code);
}

test("유효한 앱 계약을 통과시킨다", async () => {
  const fixture = await createFixture();
  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: fixture.schemaPath,
    profilesRoot: fixture.profilesRoot,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics, []);
});

test("workspace의 실제 v1 스키마와 프로필로 통합 검증한다", async () => {
  assert.equal(DEFAULT_SCHEMA_PATH, WORKSPACE_SCHEMA_PATH);
  const fixture = await createFixture();
  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: WORKSPACE_SCHEMA_PATH,
    profilesRoot: WORKSPACE_PROFILES_ROOT,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics, []);
});

test("마켓이 없거나 web만 활성화된 저장소도 v1 계약을 통과시킨다", async () => {
  for (const markets of [{}, { web: { enabled: true } }]) {
    const manifest = validManifest();
    manifest.markets = markets;
    const fixture = await createFixture({ manifest });
    const result = await validateRepository({
      repoRoot: fixture.root,
      schemaPath: WORKSPACE_SCHEMA_PATH,
      profilesRoot: WORKSPACE_PROFILES_ROOT,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.diagnostics, []);
  }
});

test("SDK exact SemVer와 release tagPattern이 같은 선행 0 규칙을 사용한다", async () => {
  const acceptedVersions = ["1.0.0-0", "1.0.0-alpha.1", "1.0.0+build.01"];
  const rejectedVersions = ["1.0.0-01", "1.0.0-alpha.01"];

  for (const version of [...acceptedVersions, ...rejectedVersions]) {
    const manifest = validManifest();
    manifest.sdk.version = version;
    const fixture = await createFixture({ manifest });
    await writeJson(join(fixture.root, "package.json"), {
      scripts: {
        "test:core": "node --test",
        "check:architecture": "node --check architecture.mjs",
        "check:release": "node --check release.mjs",
      },
      dependencies: { "@seorilabs/platform-sdk": version },
    });
    const result = await validateRepository({
      repoRoot: fixture.root,
      schemaPath: WORKSPACE_SCHEMA_PATH,
      profilesRoot: WORKSPACE_PROFILES_ROOT,
    });

    assert.equal(
      result.ok,
      acceptedVersions.includes(version),
      `SDK version contract mismatch: ${version}`,
    );
  }

  const releasePolicy = parse(
    await readFile(WORKSPACE_RELEASE_POLICY_PATH, "utf8"),
  );
  const tagPattern = new RegExp(releasePolicy.releaseTrigger.tagPattern, "u");
  for (const version of acceptedVersions) {
    assert.equal(tagPattern.test(`v${version}`), true, `tag rejected: v${version}`);
  }
  for (const version of rejectedVersions) {
    assert.equal(tagPattern.test(`v${version}`), false, `tag accepted: v${version}`);
  }
  assert.equal(tagPattern.test("1.0.0"), false);
});

test("활성 마켓 manifest를 실제 마켓 스키마로 검증한다", async () => {
  const manifest = validManifest();
  manifest.markets.googlePlay = {
    enabled: true,
    manifest: "store/google-play/manifest.yaml",
  };
  const fixture = await createFixture({ manifest });
  await mkdir(join(fixture.root, "store", "google-play"), { recursive: true });
  await writeFile(
    join(fixture.root, "store", "google-play", "manifest.yaml"),
    "schemaVersion: 1\nappId: fixture-app\n",
    "utf8",
  );

  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: WORKSPACE_SCHEMA_PATH,
    profilesRoot: WORKSPACE_PROFILES_ROOT,
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.document === "googlePlay manifest" &&
        diagnostic.code === "SCHEMA_REQUIRED" &&
        diagnostic.path === "$.packageName",
    ),
    true,
  );
  assert.equal(hasCode(result, "PROFILE_MARKET_REQUIRED_FILE_MISSING"), true);
  assert.equal(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.document === "profiles/react-native.yaml" &&
        diagnostic.code === "FILE_MISSING" &&
        diagnostic.path ===
          "$.marketRequirements.googlePlay.requiredFiles[0]",
    ),
    true,
  );
});

test("스키마 오류에 실제 값 없이 JSON path를 표시한다", async () => {
  const manifest = validManifest();
  delete manifest.app.kind;
  const fixture = await createFixture({ manifest });
  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: fixture.schemaPath,
    profilesRoot: fixture.profilesRoot,
  });

  assert.equal(result.ok, false);
  assert.equal(hasCode(result, "SCHEMA_REQUIRED"), true);
  assert.equal(
    result.diagnostics.some((diagnostic) => diagnostic.path === "$.app.kind"),
    true,
  );
});

test("기본 브랜치가 main이 아니면 거부한다", async () => {
  const manifest = validManifest();
  manifest.repository.defaultBranch = "develop";
  const fixture = await createFixture({ manifest });
  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: fixture.schemaPath,
    profilesRoot: fixture.profilesRoot,
  });

  assert.equal(result.ok, false);
  assert.equal(hasCode(result, "DEFAULT_BRANCH_NOT_MAIN"), true);
});

test("예외 ID가 중복되면 semantic 오류로 거부한다", async () => {
  const manifest = validManifest();
  manifest.exceptions = [
    {
      id: "legacy-build",
      scope: "quality",
      owner: "platform",
      reason: "temporary migration exception",
      expiresOn: "2026-12-31",
    },
    {
      id: "legacy-build",
      scope: "release",
      owner: "platform",
      reason: "temporary migration exception",
      expiresOn: "2026-12-31",
    },
  ];
  const fixture = await createFixture({ manifest });
  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: WORKSPACE_SCHEMA_PATH,
    profilesRoot: WORKSPACE_PROFILES_ROOT,
  });

  assert.equal(result.ok, false);
  assert.equal(hasCode(result, "EXCEPTION_ID_DUPLICATE"), true);
});

test("표준 품질 명령이 바뀌면 거부한다", async () => {
  const manifest = validManifest();
  manifest.quality.commands.core = "npm test";
  const fixture = await createFixture({ manifest });
  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: fixture.schemaPath,
    profilesRoot: fixture.profilesRoot,
  });

  assert.equal(result.ok, false);
  assert.equal(hasCode(result, "CANONICAL_COMMAND_MISMATCH"), true);
});

test("자격증명 값 필드를 거부하고 진단에 값을 출력하지 않는다", async () => {
  const manifest = validManifest();
  manifest.credentials.token = SENSITIVE_FIXTURE_VALUE;
  manifest.credentials[PROVIDER_TOKEN_FIXTURE] = "redacted";
  const fixture = await createFixture({ manifest });
  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: fixture.schemaPath,
    profilesRoot: fixture.profilesRoot,
  });
  const rendered = result.diagnostics.map((diagnostic) =>
    `${diagnostic.code} ${diagnostic.document} ${diagnostic.path} ${diagnostic.message}`
  ).join("\n");

  assert.equal(result.ok, false);
  assert.equal(hasCode(result, "CREDENTIAL_VALUE_FIELD_FORBIDDEN"), true);
  assert.equal(rendered.includes(SENSITIVE_FIXTURE_VALUE), false);
  assert.equal(rendered.includes(PROVIDER_TOKEN_FIXTURE), false);
});

test("민감 문자열이 포함된 파일 경로도 진단에서 redaction한다", async () => {
  const manifest = validManifest();
  const sensitiveDirectory = PROVIDER_TOKEN_FIXTURE;
  manifest.sdk.consumers = [
    {
      packageJson: `${sensitiveDirectory}/package.json`,
      lockfileImporter: sensitiveDirectory,
    },
  ];
  const fixture = await createFixture({ manifest });
  await mkdir(join(fixture.root, sensitiveDirectory), { recursive: true });
  await writeJson(join(fixture.root, sensitiveDirectory, "package.json"), {
    dependencies: {
      "@seorilabs/platform-sdk": "1.2.2",
    },
  });
  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: WORKSPACE_SCHEMA_PATH,
    profilesRoot: WORKSPACE_PROFILES_ROOT,
  });
  const rendered = JSON.stringify(result.diagnostics);

  assert.equal(result.ok, false);
  assert.equal(rendered.includes(PROVIDER_TOKEN_FIXTURE), false);
  assert.equal(rendered.includes("<redacted>"), true);
});

test("자격증명 consumer ID와 실행 binding 충돌을 거부한다", async () => {
  const fixture = await createFixture();
  await writeFile(
    join(fixture.root, ".seorilabs", "credential-consumers.yaml"),
    stringify({
      schemaVersion: 1,
      appId: "fixture-app",
      consumers: [
        {
          id: "publisher",
          bindings: [
            {
              target: "github-actions",
              environment: "google-play",
              name: "GOOGLE_PLAY_PUBLISHER",
            },
          ],
        },
        {
          id: "publisher",
          bindings: [
            {
              target: "github-actions",
              environment: "google-play",
              name: "GOOGLE_PLAY_PUBLISHER",
            },
          ],
        },
      ],
    }),
    "utf8",
  );
  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: fixture.schemaPath,
    profilesRoot: fixture.profilesRoot,
  });

  assert.equal(result.ok, false);
  assert.equal(hasCode(result, "CREDENTIAL_CONSUMER_ID_DUPLICATE"), true);
  assert.equal(hasCode(result, "CREDENTIAL_BINDING_DUPLICATE"), true);
});

test("앱 전용 credential ID가 다른 app namespace를 가리키면 거부한다", async () => {
  const fixture = await createFixture();
  await writeFile(
    join(fixture.root, ".seorilabs", "credential-consumers.yaml"),
    stringify({
      schemaVersion: 1,
      appId: "fixture-app",
      consumers: [
        {
          id: "publisher",
          logicalCredentialId: "app/another-app/google-play-publisher",
          scope: "app",
          purpose: "google-play-upload",
          bindings: [
            {
              target: "github-actions",
              referenceType: "secret",
              name: "GOOGLE_PLAY_PUBLISHER",
            },
          ],
        },
      ],
    }),
    "utf8",
  );
  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: fixture.schemaPath,
    profilesRoot: fixture.profilesRoot,
  });

  assert.equal(result.ok, false);
  assert.equal(hasCode(result, "CREDENTIAL_APP_SCOPE_MISMATCH"), true);
});

test("credential logical ID의 빈 segment와 경로 순회를 거부한다", async () => {
  for (const logicalCredentialId of [
    "app/fixture-app/../../shared/gcp/key",
    "app/fixture-app//key",
    "shared/gcp/../key",
  ]) {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.root, ".seorilabs", "credential-consumers.yaml"),
      stringify({
        schemaVersion: 1,
        appId: "fixture-app",
        consumers: [
          {
            id: "publisher",
            logicalCredentialId,
            scope: logicalCredentialId.startsWith("app/") ? "app" : "shared",
            purpose: "google-play-upload",
            bindings: [
              {
                target: "github-actions",
                referenceType: "secret",
                name: "GOOGLE_PLAY_PUBLISHER",
              },
            ],
          },
        ],
      }),
      "utf8",
    );
    const result = await validateRepository({
      repoRoot: fixture.root,
      schemaPath: WORKSPACE_SCHEMA_PATH,
      profilesRoot: WORKSPACE_PROFILES_ROOT,
    });

    assert.equal(result.ok, false, logicalCredentialId);
    assert.equal(hasCode(result, "SCHEMA_PATTERN"), true, logicalCredentialId);
  }
});

test("RN SDK lockfile이 다른 version을 resolve하면 거부한다", async () => {
  const fixture = await createFixture();
  await writeFile(
    join(fixture.root, "pnpm-lock.yaml"),
    stringify({
      lockfileVersion: "9.0",
      importers: {
        ".": {
          dependencies: {
            "@seorilabs/platform-sdk": {
              specifier: "1.2.3",
              version: "1.2.2",
            },
          },
        },
      },
      packages: {
        "@seorilabs/platform-sdk@1.2.3": {
          resolution: {
            integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
            tarball:
              `https://npm.pkg.github.com/download/@seorilabs/platform-sdk/1.2.3/${"a".repeat(40)}`,
          },
        },
      },
    }),
    "utf8",
  );
  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: fixture.schemaPath,
    profilesRoot: fixture.profilesRoot,
  });

  assert.equal(result.ok, false);
  assert.equal(hasCode(result, "SDK_LOCKFILE_RESOLUTION_MISMATCH"), true);
});

test("RN SDK package는 GitHub Packages tarball과 SHA-512 integrity를 요구한다", async () => {
  for (const resolution of [
    {
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      tarball:
        `https://evil.example/download/@seorilabs/platform-sdk/1.2.3/${"a".repeat(40)}`,
    },
    {
      integrity: "sha256-invalid",
      tarball:
        `https://npm.pkg.github.com/download/@seorilabs/platform-sdk/1.2.3/${"a".repeat(40)}`,
    },
    {
      integrity: "sha512-A",
      tarball:
        `https://npm.pkg.github.com/download/@seorilabs/platform-sdk/1.2.3/${"a".repeat(40)}`,
    },
  ]) {
    const fixture = await createFixture();
    const lockfilePath = join(fixture.root, "pnpm-lock.yaml");
    const lockfile = parse(await readFile(lockfilePath, "utf8"));
    lockfile.packages["@seorilabs/platform-sdk@1.2.3"].resolution = resolution;
    await writeFile(lockfilePath, stringify(lockfile), "utf8");
    const result = await validateRepository({
      repoRoot: fixture.root,
      schemaPath: WORKSPACE_SCHEMA_PATH,
      profilesRoot: WORKSPACE_PROFILES_ROOT,
    });

    assert.equal(result.ok, false);
    assert.equal(
      hasCode(result, "SDK_LOCKFILE_TARBALL_INVALID") ||
        hasCode(result, "SDK_LOCKFILE_INTEGRITY_INVALID"),
      true,
    );
  }
});

test("RN monorepo의 모든 SDK consumer package와 importer를 검증한다", async () => {
  const manifest = validManifest();
  manifest.sdk.consumers = [
    {
      packageJson: "apps/mobile/package.json",
      lockfileImporter: "apps/mobile",
    },
    {
      packageJson: "apps/ait/package.json",
      lockfileImporter: "apps/ait",
    },
  ];
  const fixture = await createFixture({ manifest });
  await Promise.all([
    mkdir(join(fixture.root, "apps", "mobile"), { recursive: true }),
    mkdir(join(fixture.root, "apps", "ait"), { recursive: true }),
  ]);
  for (const consumerRoot of ["mobile", "ait"]) {
    await writeJson(join(fixture.root, "apps", consumerRoot, "package.json"), {
      dependencies: {
        "@seorilabs/platform-sdk": "1.2.3",
      },
    });
  }

  const validResult = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: WORKSPACE_SCHEMA_PATH,
    profilesRoot: WORKSPACE_PROFILES_ROOT,
  });
  assert.equal(validResult.ok, true);

  const incompleteManifest = structuredClone(manifest);
  incompleteManifest.sdk.consumers = [manifest.sdk.consumers[0]];
  await writeFile(
    join(fixture.root, ".seorilabs", "app.yaml"),
    stringify(incompleteManifest),
    "utf8",
  );
  const undeclaredImporterResult = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: WORKSPACE_SCHEMA_PATH,
    profilesRoot: WORKSPACE_PROFILES_ROOT,
  });
  assert.equal(undeclaredImporterResult.ok, false);
  assert.equal(
    hasCode(undeclaredImporterResult, "SDK_CONSUMER_UNDECLARED_IMPORTER"),
    true,
  );

  await writeFile(
    join(fixture.root, ".seorilabs", "app.yaml"),
    stringify(manifest),
    "utf8",
  );

  await writeJson(join(fixture.root, "apps", "mobile", "package.json"), {
    dependencies: {
      "@seorilabs/platform-sdk": "1.2.2",
    },
  });
  const staleConsumerResult = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: WORKSPACE_SCHEMA_PATH,
    profilesRoot: WORKSPACE_PROFILES_ROOT,
  });
  assert.equal(staleConsumerResult.ok, false);
  assert.equal(hasCode(staleConsumerResult, "SDK_PACKAGE_VERSION_MISMATCH"), true);
});

test("마켓 manifest의 metadata와 asset 디렉터리 실체를 확인한다", async () => {
  const manifest = validManifest();
  manifest.markets.googlePlay = {
    enabled: true,
    manifest: "store/google-play/manifest.yaml",
  };
  const fixture = await createFixture({ manifest });
  await Promise.all([
    mkdir(join(fixture.root, "store", "google-play", "metadata"), {
      recursive: true,
    }),
    mkdir(join(fixture.root, "store", "google-play", "assets"), {
      recursive: true,
    }),
    mkdir(join(fixture.root, "scripts"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(fixture.root, "store", "google-play", "manifest.yaml"),
      stringify({
        schemaVersion: 1,
        appId: "fixture-app",
        packageName: "com.seorilabs.fixture",
        listing: {
          defaultLocale: "ko-KR",
          metadataDirectory: "store/google-play/metadata",
          assetsDirectory: "store/google-play/assets",
        },
        release: {
          artifact: "android-app-bundle",
          defaultTrack: "internal",
        },
      }),
      "utf8",
    ),
    writeFile(join(fixture.root, "build.env"), "NODE_VERSION=24\n", "utf8"),
    writeFile(
      join(fixture.root, "scripts", "build-android.sh"),
      "#!/bin/sh\nexit 0\n",
      "utf8",
    ),
  ]);

  const validResult = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: WORKSPACE_SCHEMA_PATH,
    profilesRoot: WORKSPACE_PROFILES_ROOT,
  });
  assert.equal(validResult.ok, true);

  await rm(join(fixture.root, "store", "google-play", "assets"), {
    recursive: true,
  });
  await symlink(
    tmpdir(),
    join(fixture.root, "store", "google-play", "assets"),
    "dir",
  );
  const escapedResult = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: WORKSPACE_SCHEMA_PATH,
    profilesRoot: WORKSPACE_PROFILES_ROOT,
  });
  assert.equal(escapedResult.ok, false);
  assert.equal(hasCode(escapedResult, "FILE_REFERENCE_OUTSIDE_REPOSITORY"), true);
});

test("참조 문서의 appId가 앱 계약과 다르면 거부한다", async () => {
  const manifest = validManifest();
  manifest.markets.googlePlay = {
    enabled: true,
    manifest: "store/google-play/manifest.yaml",
  };
  const fixture = await createFixture({ manifest });
  await Promise.all([
    mkdir(join(fixture.root, "store", "google-play"), { recursive: true }),
    mkdir(join(fixture.root, "scripts"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(fixture.root, ".seorilabs", "credential-consumers.yaml"),
      "schemaVersion: 1\nappId: another-app\nconsumers: []\n",
      "utf8",
    ),
    writeFile(
      join(fixture.root, "store", "google-play", "manifest.yaml"),
      stringify({
        schemaVersion: 1,
        appId: "another-app",
        packageName: "com.seorilabs.fixture",
        listing: {
          defaultLocale: "ko-KR",
          metadataDirectory: "store/google-play/metadata",
          assetsDirectory: "store/google-play/assets",
        },
        release: {
          artifact: "android-app-bundle",
          defaultTrack: "internal",
        },
      }),
      "utf8",
    ),
    writeFile(join(fixture.root, "build.env"), "NODE_VERSION=24\n", "utf8"),
    writeFile(
      join(fixture.root, "scripts", "build-android.sh"),
      "#!/bin/sh\nexit 0\n",
      "utf8",
    ),
  ]);
  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: WORKSPACE_SCHEMA_PATH,
    profilesRoot: WORKSPACE_PROFILES_ROOT,
  });
  const mismatches = result.diagnostics.filter(
    (diagnostic) => diagnostic.code === "REFERENCED_APP_ID_MISMATCH",
  );

  assert.equal(result.ok, false);
  assert.deepEqual(
    mismatches.map((diagnostic) => diagnostic.document),
    ["credentials manifest", "googlePlay manifest"],
  );
});

test("손상된 package.json을 명시적 파싱 오류로 거부한다", async () => {
  const fixture = await createFixture();
  await writeFile(
    join(fixture.root, "package.json"),
    `{"token":"${SENSITIVE_FIXTURE_VALUE}",`,
    "utf8",
  );
  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: fixture.schemaPath,
    profilesRoot: fixture.profilesRoot,
  });
  const rendered = result.diagnostics.map((diagnostic) =>
    `${diagnostic.code} ${diagnostic.document} ${diagnostic.path} ${diagnostic.message}`
  ).join("\n");

  assert.equal(result.ok, false);
  assert.equal(hasCode(result, "PARSE_JSON"), true);
  assert.equal(rendered.includes(SENSITIVE_FIXTURE_VALUE), false);
});

test("프로필 필수 파일이 없으면 파일 계약 오류로 거부한다", async () => {
  const fixture = await createFixture();
  await rm(join(fixture.root, "pnpm-lock.yaml"));
  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: fixture.schemaPath,
    profilesRoot: fixture.profilesRoot,
  });

  assert.equal(result.ok, false);
  assert.equal(hasCode(result, "PROFILE_REQUIRED_FILE_MISSING"), true);
  assert.equal(hasCode(result, "FILE_MISSING"), true);
});

test("프로필 필수 파일 경로를 디렉터리로 대체해도 거부한다", async () => {
  const fixture = await createFixture();
  await rm(join(fixture.root, "pnpm-lock.yaml"));
  await mkdir(join(fixture.root, "pnpm-lock.yaml"));
  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: fixture.schemaPath,
    profilesRoot: fixture.profilesRoot,
  });

  assert.equal(result.ok, false);
  assert.equal(hasCode(result, "PROFILE_REQUIRED_FILE_MISSING"), true);
  assert.equal(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.document === "profiles/react-native.yaml" &&
        diagnostic.code === "FILE_TYPE_MISMATCH" &&
        diagnostic.path === "$.requiredFiles[2]",
    ),
    true,
  );
});

test("운영 manifest에도 credential 값 필드를 허용하지 않는다", async () => {
  const manifest = validManifest();
  manifest.operationsManifest = ".seorilabs/backoffice.json";
  const fixture = await createFixture({ manifest });
  await writeFile(
    join(fixture.root, ".seorilabs", "backoffice.json"),
    `${JSON.stringify({ token: SENSITIVE_FIXTURE_VALUE })}\n`,
    "utf8",
  );
  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: fixture.schemaPath,
    profilesRoot: fixture.profilesRoot,
  });
  const rendered = result.diagnostics.map((diagnostic) =>
    `${diagnostic.code} ${diagnostic.document} ${diagnostic.path} ${diagnostic.message}`
  ).join("\n");

  assert.equal(result.ok, false);
  assert.equal(hasCode(result, "CREDENTIAL_VALUE_FIELD_FORBIDDEN"), true);
  assert.equal(rendered.includes(SENSITIVE_FIXTURE_VALUE), false);
});

test("Godot provenance 파일은 SDK 루트 바로 아래에 있어야 한다", async () => {
  const manifest = validManifest();
  manifest.app.kind = "game";
  manifest.app.profile = "godot";
  manifest.sdk = {
    distribution: "vendored",
    root: "addons/seorilabs-sdk",
    provenance: {
      source: "addons/seorilabs-sdk/meta/SOURCE",
      version: "addons/seorilabs-sdk/VERSION",
      checksum: "addons/seorilabs-sdk/CHECKSUM",
    },
  };
  const fixture = await createFixture({ manifest });
  await Promise.all([
    writeFile(
      join(fixture.profilesRoot, "godot.yaml"),
      "requiredFiles:\n  - .seorilabs/app.yaml\n  - project.godot\n  - package.json\n  - pnpm-lock.yaml\n",
      "utf8",
    ),
    writeFile(join(fixture.root, "project.godot"), "[application]\n", "utf8"),
    mkdir(join(fixture.root, "addons", "seorilabs-sdk", "meta"), {
      recursive: true,
    }),
  ]);
  await Promise.all([
    writeFile(
      join(fixture.root, "addons", "seorilabs-sdk", "meta", "SOURCE"),
      "release\n",
      "utf8",
    ),
    writeFile(
      join(fixture.root, "addons", "seorilabs-sdk", "VERSION"),
      "1.2.3\n",
      "utf8",
    ),
    writeFile(
      join(fixture.root, "addons", "seorilabs-sdk", "CHECKSUM"),
      "0".repeat(64) + "\n",
      "utf8",
    ),
  ]);
  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: fixture.schemaPath,
    profilesRoot: fixture.profilesRoot,
  });

  assert.equal(result.ok, false);
  assert.equal(hasCode(result, "SDK_PROVENANCE_OUTSIDE_ROOT"), true);
});

test("Godot SDK provenance와 vendored tree checksum을 결정적으로 검증한다", async () => {
  const fixture = await createGodotFixture();
  const validResult = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: WORKSPACE_SCHEMA_PATH,
    profilesRoot: WORKSPACE_PROFILES_ROOT,
  });
  assert.equal(validResult.ok, true);

  await writeFile(join(fixture.sdkRoot, "plugin.gd"), "extends RefCounted\n", "utf8");
  const driftedResult = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: WORKSPACE_SCHEMA_PATH,
    profilesRoot: WORKSPACE_PROFILES_ROOT,
  });
  assert.equal(driftedResult.ok, false);
  assert.equal(hasCode(driftedResult, "SDK_CHECKSUM_MISMATCH"), true);
});

test("Godot SDK VERSION은 조직 SemVer 계약을 따른다", async () => {
  const fixture = await createGodotFixture();
  await writeFile(join(fixture.sdkRoot, "VERSION"), "1.2.3-01\n", "utf8");
  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: WORKSPACE_SCHEMA_PATH,
    profilesRoot: WORKSPACE_PROFILES_ROOT,
  });

  assert.equal(result.ok, false);
  assert.equal(hasCode(result, "SDK_VERSION_INVALID"), true);
});

test("Godot SDK SOURCE는 platform release와 VERSION에 결합한다", async () => {
  for (const [source, expectedCode] of [
    ["https://evil.example/releases/tag/v1.2.3", "SDK_SOURCE_INVALID"],
    [
      "https://github.com/seorilabs/platform/releases/tag/v9.9.9",
      "SDK_SOURCE_VERSION_MISMATCH",
    ],
  ]) {
    const fixture = await createGodotFixture();
    await writeFile(join(fixture.sdkRoot, "SOURCE"), `${source}\n`, "utf8");
    const { checksum } = await computeVendoredTreeChecksum(fixture.sdkRoot);
    await writeFile(join(fixture.sdkRoot, "CHECKSUM"), `${checksum}\n`, "utf8");
    const result = await validateRepository({
      repoRoot: fixture.root,
      schemaPath: WORKSPACE_SCHEMA_PATH,
      profilesRoot: WORKSPACE_PROFILES_ROOT,
    });

    assert.equal(result.ok, false);
    assert.equal(hasCode(result, expectedCode), true);
  }
});

test("Godot vendored SDK tree의 symlink를 거부한다", async () => {
  const fixture = await createGodotFixture();
  await symlink(tmpdir(), join(fixture.sdkRoot, "external"), "dir");
  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: WORKSPACE_SCHEMA_PATH,
    profilesRoot: WORKSPACE_PROFILES_ROOT,
  });

  assert.equal(result.ok, false);
  assert.equal(hasCode(result, "SDK_TREE_ENTRY_INVALID"), true);
});

test("Godot SDK 경로의 상위 디렉터리 symlink도 거부한다", async () => {
  const fixture = await createGodotFixture();
  await rename(
    join(fixture.root, "addons"),
    join(fixture.root, "shared-addons"),
  );
  await symlink("shared-addons", join(fixture.root, "addons"), "dir");
  const result = await validateRepository({
    repoRoot: fixture.root,
    schemaPath: WORKSPACE_SCHEMA_PATH,
    profilesRoot: WORKSPACE_PROFILES_ROOT,
  });

  assert.equal(result.ok, false);
  assert.equal(hasCode(result, "FILE_SYMLINK_FORBIDDEN"), true);
});

test("CLI는 파싱 오류에서 비영 종료하고 원문을 출력하지 않는다", async () => {
  const fixture = await createFixture();
  await writeFile(
    join(fixture.root, ".seorilabs", "app.yaml"),
    `credentials: [${SENSITIVE_FIXTURE_VALUE}\n`,
    "utf8",
  );
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli({
    argv: [fixture.root],
    schemaPath: fixture.schemaPath,
    profilesRoot: fixture.profilesRoot,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /오류 \[PARSE_YAML\] \.seorilabs\/app\.yaml \$/u);
  assert.equal(stderr.includes(SENSITIVE_FIXTURE_VALUE), false);
});
