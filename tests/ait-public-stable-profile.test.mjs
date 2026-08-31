import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parse } from "yaml";

import { resolveGitHubTagCommit } from "../scripts/release/resolve-github-tag-commit.mjs";
import { verifyAitBuildEvidence } from "../scripts/release/verify-ait-build-evidence.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const TAG_SHA = "a".repeat(40);
const COMMIT_SHA = "b".repeat(40);
const DIGEST = `sha256:${"c".repeat(64)}`;

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function read(path) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

test("public AIT profile은 stable tag, GitHub-hosted runner, build-only 경계를 고정한다", () => {
  const source = parse(read("contracts/workflow-bundle-v5-source.yaml"));
  assert.deepEqual(source.promotionScope.buildProfiles, [
    "react-native-android",
    "godot-android",
  ]);
  for (const profile of ["ait-granite", "ait-web"]) {
    const contract = source.buildProfiles[profile];
    assert.deepEqual(contract.repositoryVisibility, ["private", "public"]);
    assert.deepEqual(contract.runnerPolicy, {
      private: "seorilabs-rpi-arm64",
      public: "ubuntu-latest",
    });
    assert.deepEqual(contract.publicExecutionPolicy, {
      pullRequest: "forbidden",
      promotionState: "CANDIDATE",
      runtimeState: "RUNTIME_NOT_OPERATIONAL",
      events: ["push-stable-tag", "workflow-dispatch-stable-tag"],
      versionAuthority: "release-version-authority-v1",
      sourceBinding: "exact-peeled-tag-commit",
      blockers: [
        "BACKOFFICE_PUBLIC_GITHUB_HOSTED_AIT_BINDING_REQUIRED",
        "PUBLIC_AIT_GITHUB_CANARY_EVIDENCE_REQUIRED",
      ],
    });
    assert.deepEqual(contract.marketUpload, {
      includedInBuild: false,
      workflow: ".github/workflows/ait-upload-v1.yml",
      promotionState: "CANDIDATE",
      runtimeState: "RUNTIME_NOT_OPERATIONAL",
      transport: "seori-auth-broker-trusted-adapter",
      sameParentRunNeeds: "ait-build",
      artifactBinding: "checksum-provenance-required",
      environment: "apps-in-toss",
      environmentBootstrap: "REQUIRED",
      approval: "environment-protection-required",
      namedSecrets: [],
    });
    assert.equal(source.promotionScope.buildProfiles.includes(profile), false);
  }
  assert.deepEqual(source.callerPolicies.ait, {
    managedCallerPath: ".github/workflows/ait-build-only.yml",
    events: ["push-stable-tag", "workflow-dispatch-stable-tag"],
    permissions: { contents: "read", "id-token": "write", packages: "read" },
    namedSecrets: [],
  });
});

test("AIT upload workflow은 raw secret 없이 RUNTIME_NOT_OPERATIONAL로 fail-closed한다", () => {
  const text = read(".github/workflows/ait-upload-v1.yml");
  const workflow = parse(text);
  assert.deepEqual(workflow.on.workflow_call, {});
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.jobs), ["runtime-gate"]);
  assert.equal(workflow.jobs["runtime-gate"]["runs-on"], "ubuntu-latest");
  assert.match(workflow.jobs["runtime-gate"].if, /github\.event_name != 'pull_request'/u);
  assert.match(text, /test "\$REPOSITORY_PRIVATE" = false/u);
  assert.match(text, /refs\/tags\/v\(0\|\[1-9\]\[0-9\]\*\)/u);
  assert.match(text, /RUNTIME_NOT_OPERATIONAL/u);
  assert.doesNotMatch(
    text,
    /APPS_IN_TOSS_API_KEY|secrets:|--api-key|package\.json|run deploy|seorilabs-rpi-arm64/u,
  );
});

test("AIT reusable workflow은 public PR을 실행하지 않고 public tag를 Ubuntu에서만 처리한다", () => {
  const text = read(".github/workflows/ait-build-only-v1.yml");
  const workflow = parse(text);
  assert.deepEqual(workflow.on.workflow_call, {});
  assert.equal(Object.hasOwn(workflow.on.workflow_call, "inputs"), false);
  assert.equal(Object.hasOwn(workflow.on.workflow_call, "secrets"), false);
  assert.deepEqual(workflow.permissions, {
    contents: "read",
    "id-token": "write",
    packages: "read",
  });
  assert.equal(
    workflow.jobs["resolve-binding"].if,
    "${{ github.event.repository.private || github.event_name != 'pull_request' }}",
  );
  for (const jobName of ["resolve-binding", "build-only", "evidence"]) {
    assert.match(workflow.jobs[jobName]["runs-on"], /ubuntu-latest/u, jobName);
    assert.match(workflow.jobs[jobName]["runs-on"], /seorilabs-rpi-arm64/u, jobName);
  }
  assert.match(workflow.jobs["build-only"].if, /release_mode == 'true'/u);
  assert.match(text, /resolve-github-tag-commit\.mjs --github-output/gu);
  assert.match(text, /RELEASE_TAG_FINAL_READBACK_MISMATCH/u);
  assert.match(text, /runnerRoute: process\.env\.RUNNER_ROUTE/u);
  assert.match(text, /artifactSha256: process\.env\.ARTIFACT_SHA256/u);
  assert.match(text, /marketUpload: false/u);
  assert.doesNotMatch(text, /secrets:\s*inherit|uses:[^\n]+@main\b/u);
  assert.doesNotMatch(text, /ait\s+deploy|apps-in-toss.*upload/iu);
  for (const match of text.matchAll(/uses:\s+([^\s#]+)/gu)) {
    assert.match(match[1], /@[0-9a-f]{40}$/u, match[1]);
  }
});

test("GitHub tag readback은 lightweight tag commit을 그대로 고정한다", async () => {
  const calls = [];
  const result = await resolveGitHubTagCommit({
    repository: "seorilabs/public-fixture",
    ref: "refs/tags/v1.2.3",
    token: "test-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        ref: "refs/tags/v1.2.3",
        object: { type: "commit", sha: COMMIT_SHA },
      });
    },
  });
  assert.deepEqual(result, { tag: "v1.2.3", sourceSha: COMMIT_SHA, peelDepth: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-token");
  assert.equal(calls[0].options.redirect, "error");
});

test("GitHub tag readback은 annotated tag object를 exact commit까지 peel한다", async () => {
  const urls = [];
  const result = await resolveGitHubTagCommit({
    repository: "seorilabs/public-fixture",
    ref: "refs/tags/v1.2.3",
    token: "test-token",
    fetchImpl: async (url) => {
      urls.push(url);
      return urls.length === 1
        ? jsonResponse({
            ref: "refs/tags/v1.2.3",
            object: { type: "tag", sha: TAG_SHA },
          })
        : jsonResponse({
            sha: TAG_SHA,
            tag: "v1.2.3",
            object: { type: "commit", sha: COMMIT_SHA },
          });
    },
  });
  assert.deepEqual(result, { tag: "v1.2.3", sourceSha: COMMIT_SHA, peelDepth: 1 });
  assert.equal(urls.length, 2);
  assert.match(urls[0], /\/git\/ref\/tags\/v1\.2\.3$/u);
  assert.match(urls[1], new RegExp(`/git/tags/${TAG_SHA}$`, "u"));
});

test("GitHub tag readback은 look-alike ref와 mismatched tag object를 거부한다", async () => {
  await assert.rejects(
    resolveGitHubTagCommit({
      repository: "seorilabs/public-fixture",
      ref: "refs/tags/v1.2.3-rc.1",
      token: "test-token",
      fetchImpl: async () => { throw new Error("fetch must not run"); },
    }),
    /RELEASE_TAG_READBACK_REF_INVALID/u,
  );
  await assert.rejects(
    resolveGitHubTagCommit({
      repository: "seorilabs/public-fixture",
      ref: "refs/tags/v1.2.3",
      token: "test-token",
      fetchImpl: async (url) => url.includes("/git/ref/")
        ? jsonResponse({
            ref: "refs/tags/v1.2.3",
            object: { type: "tag", sha: TAG_SHA },
          })
        : jsonResponse({
            sha: TAG_SHA,
            tag: "v9.9.9",
            object: { type: "commit", sha: COMMIT_SHA },
          }),
    }),
    /RELEASE_TAG_OBJECT_READBACK_MISMATCH/u,
  );
});

test("upload evidence verifier는 repo/profile/tag/artifact digest를 exact match한다", () => {
  const root = mkdtempSync(join(tmpdir(), "ait-public-evidence-"));
  try {
    const artifactPath = join(root, "application.ait");
    writeFileSync(artifactPath, "fixture-ait");
    const artifactDigest = createHash("sha256").update("fixture-ait").digest("hex");
    const expected = {
      repositoryId: 7001,
      fullName: "seorilabs/public-fixture",
      sourceSha: COMMIT_SHA,
      bundleSha: TAG_SHA,
      manifestDigest: DIGEST,
      bundlePayloadDigest: DIGEST,
      buildProfile: "ait-web",
      runId: 91,
      runAttempt: 1,
      configRevisionId: "config-public-1",
      configRevision: 1,
      configRevisionDigest: DIGEST,
      signedSnapshotDigest: DIGEST,
      snapshotSignatureKeyId: "snapshot-key-1",
      snapshotSignaturePolicyRevision: "snapshot-policy-1",
      snapshotSignatureDigest: DIGEST,
      releaseTag: "v1.2.3",
      releaseVersionName: "1.2.3",
      releaseAuthorityRevision: "d".repeat(64),
      releaseConfigRevision: "e".repeat(64),
      releaseBindingDigest: "f".repeat(64),
    };
    const evidence = {
      schemaVersion: 2,
      target: "ait",
      buildProfile: expected.buildProfile,
      repositoryId: expected.repositoryId,
      fullName: expected.fullName,
      sourceSha: expected.sourceSha,
      bindingSourceSha: expected.sourceSha,
      callerWorkflowRef: `${expected.fullName}/.github/workflows/ait-build-only.yml@refs/tags/${expected.releaseTag}`,
      manifestDigest: expected.manifestDigest,
      bundlePayloadDigest: expected.bundlePayloadDigest,
      workflowExecutionSha: expected.bundleSha,
      workflowRef: `seorilabs/.github/.github/workflows/ait-build-only-v1.yml@${expected.bundleSha}`,
      runId: expected.runId,
      runAttempt: expected.runAttempt,
      configRevisionId: expected.configRevisionId,
      configRevision: expected.configRevision,
      configRevisionDigest: expected.configRevisionDigest,
      signedSnapshotDigest: expected.signedSnapshotDigest,
      snapshotSignatureKeyId: expected.snapshotSignatureKeyId,
      snapshotSignaturePolicyRevision: expected.snapshotSignaturePolicyRevision,
      snapshotSignatureDigest: expected.snapshotSignatureDigest,
      runnerRoute: "public-github-hosted",
      runnerImage: "github-hosted:ubuntu24@20260831.1.0",
      artifactKind: "ait",
      artifactSha256: `sha256:${artifactDigest}`,
      marketUpload: false,
      bindingMode: "RELEASE",
      releaseTag: expected.releaseTag,
      releaseVersionName: expected.releaseVersionName,
      releaseAuthorityRevision: expected.releaseAuthorityRevision,
      releaseConfigRevision: expected.releaseConfigRevision,
      releaseBindingDigest: expected.releaseBindingDigest,
      releaseMemo: `release:v1.2.3 source:${COMMIT_SHA} artifact:sha256:${artifactDigest}`,
    };
    assert.deepEqual(
      verifyAitBuildEvidence({ evidence, artifactPath, expected }),
      {
        artifactPath,
        artifactDigest,
        releaseMemo: evidence.releaseMemo,
        runnerImage: evidence.runnerImage,
      },
    );
    assert.throws(
      () => verifyAitBuildEvidence({
        evidence: { ...evidence, sourceSha: "9".repeat(40) },
        artifactPath,
        expected,
      }),
      /AIT_BUILD_EVIDENCE_BINDING_MISMATCH/u,
    );
    assert.throws(
      () => verifyAitBuildEvidence({
        evidence: { ...evidence, artifactSha256: `sha256:${"0".repeat(64)}` },
        artifactPath,
        expected,
      }),
      /AIT_BUILD_EVIDENCE_ARTIFACT_DIGEST_MISMATCH/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
