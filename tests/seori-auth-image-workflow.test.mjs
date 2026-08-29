import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

const path = ".github/workflows/seori-auth-image.yml";
const source = await readFile(path, "utf8");
const workflow = parse(source);
const publish = workflow.jobs.publish;

function step(name) {
  return publish.steps.find((candidate) => candidate.name === name);
}

test("Auth Broker image workflow는 PR과 self-hosted runner에서 발행하지 않는다", () => {
  assert.ok(workflow.on.push);
  assert.ok(workflow.on.workflow_dispatch !== undefined);
  assert.equal(workflow.on.pull_request, undefined);
  assert.equal(publish.if, "github.ref == 'refs/heads/main'");
  assert.equal(publish["runs-on"], "ubuntu-24.04-arm");
  assert.doesNotMatch(source, /seorilabs-rpi-arm64/u);
});

test("native ARM64 canary는 network와 쓰기 및 Linux capability 없이 실행된다", () => {
  const canary = step("Run non-secret container canary").run;
  assert.match(canary, /docker run --rm --network none --read-only --cap-drop ALL/u);
  assert.match(canary, /--security-opt no-new-privileges/u);
  assert.match(canary, /--tmpfs \/run\/seori-auth:rw,noexec,nosuid,nodev,mode=0700,uid=65532,gid=65532/u);
  assert.match(canary, /--tmpfs \/var\/lib\/seori-auth:rw,noexec,nosuid,nodev,mode=0700,uid=65532,gid=65532/u);
  assert.match(canary, /\$\{IMAGE\}:\$\{GITHUB_SHA\}-canary/u);
});

test("pushed sha256 digest를 검증하고 같은 digest의 canary를 실행한다", () => {
  const publishStep = step("Publish immutable ARM64 image with provenance");
  const verify = step("Verify the exact pushed digest");
  assert.equal(publishStep.with.push, true);
  assert.equal(publishStep.with.provenance, "mode=max");
  assert.equal(publishStep.with.sbom, true);
  assert.equal(verify.env.IMAGE_DIGEST, "${{ steps.publish.outputs.digest }}");
  assert.match(verify.run, /\^sha256:\[0-9a-f\]\{64\}\$/u);
  assert.match(verify.run, /--tmpfs \/run\/seori-auth:rw,noexec,nosuid,nodev,mode=0700,uid=65532,gid=65532/u);
  assert.match(verify.run, /--tmpfs \/var\/lib\/seori-auth:rw,noexec,nosuid,nodev,mode=0700,uid=65532,gid=65532/u);
  assert.match(verify.run, /"\$\{IMAGE\}@\$\{IMAGE_DIGEST\}"/u);
});

test("registry 정적 자격증명 없이 repository identity만 사용한다", () => {
  assert.deepEqual(workflow.permissions, { contents: "read", packages: "write" });
  const login = step("Log in to GHCR with repository identity");
  assert.equal(login.with.registry, "ghcr.io");
  assert.equal(login.with.username, "${{ github.actor }}");
  assert.equal(login.with.password, "${{ github.token }}");
  assert.doesNotMatch(source, /\$\{\{\s*secrets\./u);
  assert.doesNotMatch(source, /REGISTRY_(?:USERNAME|PASSWORD)|PAT/u);
});

test("발행 tag는 source SHA이고 소비 증거는 exact digest다", () => {
  const publishStep = step("Publish immutable ARM64 image with provenance");
  const verify = step("Verify the exact pushed digest");
  assert.equal(publishStep.with.tags, "${{ env.IMAGE }}:${{ github.sha }}");
  assert.doesNotMatch(publishStep.with.tags, /:latest|:main/u);
  assert.match(verify.run, /image=%s@%s/u);
  assert.match(verify.run, /"\$IMAGE" "\$IMAGE_DIGEST" "\$GITHUB_SHA"/u);
});

test("외부 action은 full SHA로 고정한다", () => {
  const externalActions = publish.steps
    .filter((candidate) => candidate.uses)
    .map((candidate) => candidate.uses);
  assert.ok(externalActions.length >= 5);
  for (const uses of externalActions) {
    assert.match(uses, /@[0-9a-f]{40}$/u, uses);
  }
});
