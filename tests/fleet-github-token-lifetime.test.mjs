import assert from "node:assert/strict";
import test from "node:test";

import { createGitHubAppTrustedAdapter } from "../packages/repo-contract/src/trusted-executor.mjs";

const NOW = Date.parse("2026-09-02T03:00:00.000Z");
const CONTEXT = Object.freeze({
  fullName: "seorilabs/example-app",
  repositoryId: "7001",
  sourceSha: "a".repeat(40),
});

function harness({ mutateLease, failProvider = false, failRevoke = false, beforeRevoke } = {}) {
  const token = Buffer.from("test-only-scoped-installation-credential-0001");
  const events = [];
  let live = false;
  const options = {
    organizationId: "283115031",
    installationId: "142120077",
    now: () => NOW,
    async issueInstallationToken(request) {
      events.push("issued");
      live = true;
      const lease = {
        accountId: "283115031",
        accountLogin: "seorilabs",
        installationId: request.installationId,
        repositoryIds: request.repositoryIds,
        permissions: request.permissions,
        expiresAt: new Date(NOW + 60_000).toISOString(),
        token,
      };
      mutateLease?.(lease);
      return lease;
    },
    async revokeInstallationToken(credential) {
      assert.ok(credential === token);
      assert.ok(credential.some((byte) => byte !== 0));
      events.push("revoking");
      await beforeRevoke?.();
      if (failRevoke) throw new Error("test-only-scoped-installation-credential-0001");
      live = false;
      events.push("revoked");
    },
    provider: {
      addSecretRepositoryAccess() {},
      applyOperation() {},
      applyProtection() {},
      readOperation() {},
      readProtection() {},
      readProtectionCapability() {},
      readProvisioningGate() {},
      readSecretRepositoryAccess() {},
      async readIdentity({ credential }) {
        events.push("provider");
        assert.ok(credential === token && live);
        if (failProvider) throw new Error("test-only-scoped-installation-credential-0001");
        return { repositoryId: CONTEXT.repositoryId };
      },
    },
  };
  return { options, token, events, isLive: () => live };
}

test("token은 provider 폐기 완료 뒤에만 결과를 반환하고 메모리를 지운다", async () => {
  const state = harness();
  const result = await createGitHubAppTrustedAdapter(state.options).readIdentity(CONTEXT);
  assert.deepEqual(result, { repositoryId: CONTEXT.repositoryId });
  assert.deepEqual(state.events, ["issued", "provider", "revoking", "revoked"]);
  assert.equal(state.isLive(), false);
  assert.ok(state.token.every((byte) => byte === 0));
});

test("provider 오류에서도 token을 폐기하고 원문 오류를 반환하지 않는다", async () => {
  const state = harness({ failProvider: true });
  await assert.rejects(createGitHubAppTrustedAdapter(state.options).readIdentity(CONTEXT),
    { message: "GITHUB_REPOSITORY_READBACK_FAILED" });
  assert.deepEqual(state.events, ["issued", "provider", "revoking", "revoked"]);
  assert.equal(state.isLive(), false);
  assert.ok(state.token.every((byte) => byte === 0));
});

for (const [name, mutateLease] of [
  ["다른 repository", (lease) => { lease.repositoryIds = ["7002"]; }],
  ["확대 permission", (lease) => { lease.permissions.contents = "write"; }],
  ["다른 installation", (lease) => { lease.installationId = "142120078"; }],
  ["다른 account", (lease) => { lease.accountId = "283115032"; }],
  ["만료", (lease) => { lease.expiresAt = new Date(NOW).toISOString(); }],
  ["1시간 초과", (lease) => { lease.expiresAt = new Date(NOW + 3_600_001).toISOString(); }],
]) {
  test(`${name} token은 provider 호출 전에 거부하고 폐기한다`, async () => {
    const state = harness({ mutateLease });
    await assert.rejects(createGitHubAppTrustedAdapter(state.options).readIdentity(CONTEXT),
      { message: "GITHUB_REPOSITORY_READBACK_FAILED" });
    assert.deepEqual(state.events, ["issued", "revoking", "revoked"]);
    assert.equal(state.isLive(), false);
    assert.ok(state.token.every((byte) => byte === 0));
  });
}

for (const failProvider of [false, true]) {
  test(`폐기 실패는 provider 성공 여부 ${!failProvider}와 관계없이 완료를 거부한다`, async () => {
    const state = harness({ failProvider, failRevoke: true });
    await assert.rejects(createGitHubAppTrustedAdapter(state.options).readIdentity(CONTEXT),
      { message: "GITHUB_INSTALLATION_TOKEN_REVOKE_FAILED" });
    assert.deepEqual(state.events, ["issued", "provider", "revoking"]);
    assert.equal(state.isLive(), true);
    assert.ok(state.token.every((byte) => byte === 0));
  });
}

test("비동기 token 폐기가 끝나기 전에 operation을 성공 처리하지 않는다", async () => {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let reached;
  const revoking = new Promise((resolve) => { reached = resolve; });
  const state = harness({ beforeRevoke: async () => { reached(); await released; } });
  let finished = false;
  const operation = createGitHubAppTrustedAdapter(state.options).readIdentity(CONTEXT)
    .then(() => { finished = true; });
  await revoking;
  assert.equal(finished, false);
  assert.equal(state.isLive(), true);
  release();
  await operation;
  assert.equal(finished, true);
  assert.equal(state.isLive(), false);
  assert.ok(state.token.every((byte) => byte === 0));
});

test("provider 폐기 callback 없는 adapter를 허용하지 않는다", () => {
  const { revokeInstallationToken, ...options } = harness().options;
  assert.equal(typeof revokeInstallationToken, "function");
  assert.throws(() => createGitHubAppTrustedAdapter(options),
    { message: "GITHUB_APP_ADAPTER_CONFIGURATION_INVALID" });
});
