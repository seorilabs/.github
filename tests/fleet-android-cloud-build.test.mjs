import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parse } from "yaml";

import { verifyAndroidBuild } from "../scripts/fleet/verify-android-build.mjs";
import { createCloudBuildIgnore } from "../scripts/fleet/create-cloudbuild-ignore.mjs";

const workflow = await import("node:fs/promises").then(({ readFile }) =>
  readFile(".github/workflows/android-build-cloud-v2.yml", "utf8"),
);
const cloudBuild = await import("node:fs/promises").then(({ readFile }) =>
  readFile("builders/app-android/build-only.cloudbuild.yaml", "utf8"),
);
const temporaryRoots = [];

test.afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true }),
    ),
  );
});

test("Android workflow는 RPI submit과 repository-scoped WIF 뒤 x64 Cloud Build만 사용한다", () => {
  assert.match(
    workflow,
    /github\.event\.repository\.private && 'seorilabs-rpi-arm64' \|\| 'ubuntu-latest'/u,
  );
  assert.match(workflow, /EXPECTED_ORG_ID: "283115031"/u);
  assert.match(
    workflow,
    /repo-\$REPOSITORY_ID@seorilabs-ci\.iam\.gserviceaccount\.com/u,
  );
  assert.match(workflow, /google-github-actions\/auth@[0-9a-f]{40}/u);
  assert.match(workflow, /--service-account=/u);
  assert.match(workflow, /billing\/quota_project seorilabs-ci/u);
  assert.match(workflow, /version: "578\.0\.0"/u);
  assert.match(workflow, /--ignore-file=\.fleet\.gcloudignore/u);
  assert.match(cloudBuild, /machineType: E2_HIGHCPU_8/u);
  assert.doesNotMatch(workflow, /secrets:|secretmanager|versions\/latest/iu);
});

test("Cloud Build source ignore는 repository negation 뒤에도 credential을 재차 제외한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-cloud-ignore-"));
  temporaryRoots.push(root);
  const repositoryIgnorePath = join(root, ".gitignore");
  const outputPath = join(root, ".fleet.gcloudignore");
  await writeFile(repositoryIgnorePath, "!gha-creds-canary.json\n");

  const content = await createCloudBuildIgnore({
    outputPath,
    repositoryIgnorePath,
  });
  assert.ok(
    content.lastIndexOf("gha-creds-*.json") >
      content.indexOf("!gha-creds-canary.json"),
  );
  assert.match(content, /\.seorilabs-org\/\*\*/u);
  assert.doesNotMatch(content, /credential value|access_token/iu);
});

test("Android build-only 계약은 source와 config revision을 고정하고 signing과 upload 권한이 없다", () => {
  assert.match(workflow, /source_sha:[\s\S]*?required: true/u);
  assert.match(workflow, /config_snapshot_sha256:[\s\S]*?required: true/u);
  assert.match(workflow, /release_candidate_id:[\s\S]*?required: true/u);
  assert.match(cloudBuild, /SEORI_BUILD_MODE=unsigned/u);
  assert.match(cloudBuild, /"signed": false/u);
  assert.doesNotMatch(
    `${workflow}\n${cloudBuild}`,
    /google play|play console|track|review submit|production release/iu,
  );
  assert.match(workflow, /retention-days: 3/u);
});

test("Cloud Build recipe는 digest-pinned builder와 고정 artifact path를 사용한다", () => {
  const parsed = parse(cloudBuild);
  assert.match(
    parsed.substitutions._BUILDER_IMAGE,
    /@sha256:[0-9a-f]{64}$/u,
  );
  assert.equal(parsed.options.machineType, "E2_HIGHCPU_8");
  assert.deepEqual(parsed.artifacts.objects.paths, [
    "fleet-output/android-build.aab",
    "fleet-output/provenance.json",
  ]);
  assert.match(cloudBuild, /unzip -tqq/u);
});

test("artifact digest 또는 identity가 다르면 readback 검증을 거부한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-android-build-"));
  temporaryRoots.push(root);
  const artifactPath = join(root, "app.aab");
  const provenancePath = join(root, "provenance.json");
  const artifact = Buffer.from("fixture-aab");
  const sourceSha = "a".repeat(40);
  const configSnapshotSha256 = `sha256:${"b".repeat(64)}`;
  const artifactSha256 = `sha256:${createHash("sha256").update(artifact).digest("hex")}`;
  const provenance = {
    schemaVersion: 1,
    kind: "android-build-only",
    signed: false,
    sourceSha,
    configSnapshotSha256,
    profile: "react-native",
    releaseCandidateId: "rc-123",
    artifactSha256,
  };
  await writeFile(artifactPath, artifact);
  await writeFile(provenancePath, `${JSON.stringify(provenance)}\n`);

  assert.deepEqual(
    await verifyAndroidBuild({
      artifactPath,
      provenancePath,
      sourceSha,
      configSnapshotSha256,
      releaseCandidateId: "rc-123",
      profile: "react-native",
    }),
    { artifactSha256, signed: false },
  );
  await assert.rejects(
    verifyAndroidBuild({
      artifactPath,
      provenancePath,
      sourceSha: "c".repeat(40),
      configSnapshotSha256,
      releaseCandidateId: "rc-123",
      profile: "react-native",
    }),
    /PROVENANCE_IDENTITY_MISMATCH/u,
  );
});
