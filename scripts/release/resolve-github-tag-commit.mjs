#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import process from "node:process";

import { parseReleaseTagRef } from "./tag-version-authority.mjs";

const SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_TAG_DEPTH = 8;

function fail(code) {
  throw new Error(code);
}

async function responseJson(response, code) {
  if (!response?.ok) fail(`${code}_HTTP_${response?.status ?? "UNKNOWN"}`);
  const contentType = response.headers?.get?.("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) fail(`${code}_CONTENT_TYPE_INVALID`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) fail(`${code}_RESPONSE_TOO_LARGE`);
  try {
    return JSON.parse(text);
  } catch {
    fail(`${code}_RESPONSE_INVALID`);
  }
}

function objectIdentity(value, code) {
  const type = value?.object?.type;
  const sha = value?.object?.sha;
  if (!["commit", "tag"].includes(type) || !SHA.test(sha ?? "")) fail(code);
  return { type, sha };
}

/**
 * GitHub ref를 먼저 읽고 annotated/lightweight tag를 commit까지 peel한다. 반환 SHA는
 * workflow event SHA를 신뢰해 추측한 값이 아니라, 요청 시점의 exact tag ref readback이다.
 */
export async function resolveGitHubTagCommit({
  repository,
  ref,
  token,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!REPOSITORY.test(repository ?? "") || typeof fetchImpl !== "function") {
    fail("RELEASE_TAG_READBACK_INPUT_INVALID");
  }
  let tag;
  try {
    ({ tag } = parseReleaseTagRef(ref));
  } catch {
    fail("RELEASE_TAG_READBACK_REF_INVALID");
  }
  if (typeof token !== "string" || token.length < 1 || /[\r\n\0]/u.test(token)) {
    fail("RELEASE_TAG_READBACK_TOKEN_REQUIRED");
  }
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const base = `https://api.github.com/repos/${repository}`;
  const refValue = await responseJson(
    await fetchImpl(`${base}/git/ref/tags/${encodeURIComponent(tag)}`, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    }),
    "RELEASE_TAG_REF_READBACK",
  );
  if (refValue?.ref !== `refs/tags/${tag}`) fail("RELEASE_TAG_REF_READBACK_MISMATCH");

  let current = objectIdentity(refValue, "RELEASE_TAG_REF_OBJECT_INVALID");
  const visited = new Set();
  for (let depth = 0; depth < MAX_TAG_DEPTH; depth += 1) {
    if (current.type === "commit") {
      return Object.freeze({ tag, sourceSha: current.sha, peelDepth: depth });
    }
    if (visited.has(current.sha)) fail("RELEASE_TAG_OBJECT_CYCLE");
    visited.add(current.sha);
    const tagObject = await responseJson(
      await fetchImpl(`${base}/git/tags/${current.sha}`, {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      }),
      "RELEASE_TAG_OBJECT_READBACK",
    );
    if (tagObject?.sha !== current.sha || (depth === 0 && tagObject?.tag !== tag)) {
      fail("RELEASE_TAG_OBJECT_READBACK_MISMATCH");
    }
    current = objectIdentity(tagObject, "RELEASE_TAG_OBJECT_TARGET_INVALID");
  }
  fail("RELEASE_TAG_OBJECT_DEPTH_EXCEEDED");
}

if (import.meta.main) {
  try {
    const result = await resolveGitHubTagCommit({
      repository: process.env.GITHUB_REPOSITORY,
      ref: process.env.GITHUB_REF,
      token: process.env.GITHUB_TOKEN,
    });
    if (process.argv.includes("--github-output")) {
      if (!process.env.GITHUB_OUTPUT) fail("RELEASE_TAG_READBACK_OUTPUT_REQUIRED");
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `release_tag=${result.tag}\nsource_sha=${result.sourceSha}\npeel_depth=${result.peelDepth}\n`,
      );
    } else {
      process.stdout.write(`${JSON.stringify({ tag: result.tag, sourceSha: result.sourceSha })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error?.message ?? "RELEASE_TAG_READBACK_FAILED"}\n`);
    process.exitCode = 1;
  }
}
