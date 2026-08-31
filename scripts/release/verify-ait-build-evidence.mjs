#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, readFileSync } from "node:fs";
import process from "node:process";

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const FULL_NAME = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const STABLE_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const RUNNER_IMAGE = /^github-hosted:[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/u;
const EVIDENCE_KEYS = Object.freeze([
  "schemaVersion", "target", "buildProfile", "repositoryId", "fullName", "sourceSha",
  "bindingSourceSha", "callerWorkflowRef", "manifestDigest", "bundlePayloadDigest",
  "workflowExecutionSha", "workflowRef", "runId", "runAttempt", "configRevisionId",
  "configRevision", "configRevisionDigest", "signedSnapshotDigest", "snapshotSignatureKeyId",
  "snapshotSignaturePolicyRevision", "snapshotSignatureDigest", "runnerRoute", "runnerImage",
  "artifactKind", "artifactSha256", "marketUpload", "bindingMode", "releaseTag", "releaseVersionName",
  "releaseAuthorityRevision", "releaseConfigRevision", "releaseBindingDigest", "releaseMemo",
]);

function fail(code) {
  throw new Error(code);
}

function exactKeys(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function fileSha256(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1) {
    fail("AIT_BUILD_EVIDENCE_ARTIFACT_INVALID");
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function verifyAitBuildEvidence({ evidence, artifactPath, expected } = {}) {
  if (
    !exactKeys(evidence, EVIDENCE_KEYS)
    || !positiveInteger(expected?.repositoryId)
    || !FULL_NAME.test(expected?.fullName ?? "")
    || !SHA.test(expected?.sourceSha ?? "")
    || !SHA.test(expected?.bundleSha ?? "")
    || !SHA256.test(expected?.manifestDigest ?? "")
    || !SHA256.test(expected?.bundlePayloadDigest ?? "")
    || !["ait-granite", "ait-web"].includes(expected?.buildProfile)
    || !positiveInteger(expected?.runId)
    || !positiveInteger(expected?.runAttempt)
    || !PUBLIC_ID.test(expected?.configRevisionId ?? "")
    || !positiveInteger(expected?.configRevision)
    || !SHA256.test(expected?.configRevisionDigest ?? "")
    || !SHA256.test(expected?.signedSnapshotDigest ?? "")
    || !PUBLIC_ID.test(expected?.snapshotSignatureKeyId ?? "")
    || !PUBLIC_ID.test(expected?.snapshotSignaturePolicyRevision ?? "")
    || !SHA256.test(expected?.snapshotSignatureDigest ?? "")
    || !STABLE_TAG.test(expected?.releaseTag ?? "")
    || !VERSION.test(expected?.releaseVersionName ?? "")
    || !/^[0-9a-f]{64}$/u.test(expected?.releaseAuthorityRevision ?? "")
    || !/^[0-9a-f]{64}$/u.test(expected?.releaseConfigRevision ?? "")
    || !/^[0-9a-f]{64}$/u.test(expected?.releaseBindingDigest ?? "")
  ) {
    fail("AIT_BUILD_EVIDENCE_EXPECTATION_INVALID");
  }
  const expectedWorkflowRef =
    `seorilabs/.github/.github/workflows/ait-build-only-v1.yml@${expected.bundleSha}`;
  const expectedCallerWorkflowRef =
    `${expected.fullName}/.github/workflows/ait-build-only.yml@refs/tags/${expected.releaseTag}`;
  if (
    evidence.schemaVersion !== 2
    || evidence.target !== "ait"
    || evidence.buildProfile !== expected.buildProfile
    || evidence.repositoryId !== expected.repositoryId
    || evidence.fullName !== expected.fullName
    || evidence.sourceSha !== expected.sourceSha
    || evidence.bindingSourceSha !== expected.sourceSha
    || evidence.callerWorkflowRef !== expectedCallerWorkflowRef
    || evidence.manifestDigest !== expected.manifestDigest
    || evidence.bundlePayloadDigest !== expected.bundlePayloadDigest
    || evidence.workflowExecutionSha !== expected.bundleSha
    || evidence.workflowRef !== expectedWorkflowRef
    || evidence.runId !== expected.runId
    || evidence.runAttempt !== expected.runAttempt
    || evidence.configRevisionId !== expected.configRevisionId
    || evidence.configRevision !== expected.configRevision
    || evidence.configRevisionDigest !== expected.configRevisionDigest
    || evidence.signedSnapshotDigest !== expected.signedSnapshotDigest
    || evidence.snapshotSignatureKeyId !== expected.snapshotSignatureKeyId
    || evidence.snapshotSignaturePolicyRevision !== expected.snapshotSignaturePolicyRevision
    || evidence.snapshotSignatureDigest !== expected.snapshotSignatureDigest
    || evidence.runnerRoute !== "public-github-hosted"
    || !RUNNER_IMAGE.test(evidence.runnerImage ?? "")
    || evidence.artifactKind !== "ait"
    || !SHA256.test(evidence.artifactSha256 ?? "")
    || evidence.marketUpload !== false
    || evidence.bindingMode !== "RELEASE"
    || evidence.releaseTag !== expected.releaseTag
    || evidence.releaseVersionName !== expected.releaseVersionName
    || evidence.releaseAuthorityRevision !== expected.releaseAuthorityRevision
    || evidence.releaseConfigRevision !== expected.releaseConfigRevision
    || evidence.releaseBindingDigest !== expected.releaseBindingDigest
    || typeof evidence.releaseMemo !== "string"
    || evidence.releaseMemo.length < 1
    || evidence.releaseMemo.length > 500
    || /[\r\n\0]/u.test(evidence.releaseMemo)
  ) {
    fail("AIT_BUILD_EVIDENCE_BINDING_MISMATCH");
  }
  const artifactDigest = fileSha256(artifactPath);
  if (evidence.artifactSha256 !== `sha256:${artifactDigest}`) {
    fail("AIT_BUILD_EVIDENCE_ARTIFACT_DIGEST_MISMATCH");
  }
  return Object.freeze({
    artifactPath,
    artifactDigest,
    releaseMemo: evidence.releaseMemo,
    runnerImage: evidence.runnerImage,
  });
}

if (import.meta.main) {
  try {
    const evidence = JSON.parse(readFileSync(process.env.AIT_EVIDENCE_PATH, "utf8"));
    const result = verifyAitBuildEvidence({
      evidence,
      artifactPath: process.env.AIT_ARTIFACT_PATH,
      expected: {
        repositoryId: Number(process.env.EXPECTED_REPOSITORY_ID),
        fullName: process.env.EXPECTED_FULL_NAME,
        sourceSha: process.env.EXPECTED_SOURCE_SHA,
        bundleSha: process.env.EXPECTED_BUNDLE_SHA,
        manifestDigest: process.env.EXPECTED_MANIFEST_DIGEST,
        bundlePayloadDigest: process.env.EXPECTED_BUNDLE_PAYLOAD_DIGEST,
        buildProfile: process.env.EXPECTED_BUILD_PROFILE,
        runId: Number(process.env.EXPECTED_RUN_ID),
        runAttempt: Number(process.env.EXPECTED_RUN_ATTEMPT),
        configRevisionId: process.env.EXPECTED_CONFIG_REVISION_ID,
        configRevision: Number(process.env.EXPECTED_CONFIG_REVISION),
        configRevisionDigest: process.env.EXPECTED_CONFIG_REVISION_DIGEST,
        signedSnapshotDigest: process.env.EXPECTED_SIGNED_SNAPSHOT_DIGEST,
        snapshotSignatureKeyId: process.env.EXPECTED_SNAPSHOT_SIGNATURE_KEY_ID,
        snapshotSignaturePolicyRevision: process.env.EXPECTED_SNAPSHOT_SIGNATURE_POLICY_REVISION,
        snapshotSignatureDigest: process.env.EXPECTED_SNAPSHOT_SIGNATURE_DIGEST,
        releaseTag: process.env.EXPECTED_RELEASE_TAG,
        releaseVersionName: process.env.EXPECTED_RELEASE_VERSION_NAME,
        releaseAuthorityRevision: process.env.EXPECTED_RELEASE_AUTHORITY_REVISION,
        releaseConfigRevision: process.env.EXPECTED_RELEASE_CONFIG_REVISION,
        releaseBindingDigest: process.env.EXPECTED_RELEASE_BINDING_DIGEST,
      },
    });
    if (!process.env.GITHUB_OUTPUT) fail("AIT_BUILD_EVIDENCE_OUTPUT_REQUIRED");
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `artifact_path=${result.artifactPath}`,
        `artifact_digest=${result.artifactDigest}`,
        `release_memo=${result.releaseMemo}`,
        `runner_image=${result.runnerImage}`,
      ].join("\n") + "\n",
    );
  } catch (error) {
    process.stderr.write(`${error?.message ?? "AIT_BUILD_EVIDENCE_INVALID"}\n`);
    process.exitCode = 1;
  }
}
