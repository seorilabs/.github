import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parse } from "yaml";

import { resolveGitHubTagCommit } from "../scripts/release/resolve-github-tag-commit.mjs";

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
