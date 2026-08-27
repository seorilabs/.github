#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export async function verifyAndroidBuild({
  artifactPath,
  provenancePath,
  sourceSha,
  configSnapshotSha256,
  releaseCandidateId,
  profile,
} = {}) {
  if (
    !SHA_PATTERN.test(sourceSha ?? "") ||
    !SHA256_PATTERN.test(configSnapshotSha256 ?? "") ||
    !["react-native", "godot"].includes(profile) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(releaseCandidateId ?? "")
  ) {
    throw new Error("EXPECTED_IDENTITY_INVALID");
  }

  let provenance;
  try {
    provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  } catch {
    throw new Error("PROVENANCE_INVALID");
  }
  if (
    provenance.schemaVersion !== 1 ||
    provenance.kind !== "android-build-only" ||
    provenance.signed !== false ||
    provenance.sourceSha !== sourceSha ||
    provenance.configSnapshotSha256 !== configSnapshotSha256 ||
    provenance.releaseCandidateId !== releaseCandidateId ||
    provenance.profile !== profile
  ) {
    throw new Error("PROVENANCE_IDENTITY_MISMATCH");
  }

  const artifact = await readFile(artifactPath);
  const actualDigest = `sha256:${createHash("sha256").update(artifact).digest("hex")}`;
  if (provenance.artifactSha256 !== actualDigest) {
    throw new Error("ARTIFACT_DIGEST_MISMATCH");
  }
  return { artifactSha256: actualDigest, signed: false };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [
    artifactPath,
    provenancePath,
    sourceSha,
    configSnapshotSha256,
    releaseCandidateId,
    profile,
  ] = process.argv.slice(2);
  try {
    const result = await verifyAndroidBuild({
      artifactPath,
      provenancePath,
      sourceSha,
      configSnapshotSha256,
      releaseCandidateId,
      profile,
    });
    process.stdout.write(`${result.artifactSha256}\n`);
  } catch (error) {
    const code = String(error?.message ?? "ANDROID_BUILD_INVALID").split(":")[0];
    process.stderr.write(`오류 [${code}] Android build-only 검증 실패\n`);
    process.exitCode = 1;
  }
}

