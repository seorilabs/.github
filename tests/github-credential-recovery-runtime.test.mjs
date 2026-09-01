import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { parse } from "yaml";

import {
  createGithubRecoveryCatalogAdapter,
  runGithubCredentialRecovery,
} from "../scripts/fleet/run-github-credential-recovery.mjs";

const app = { appId: 4124446, installationId: 142120077 };
const execFileAsync = promisify(execFile);
const entries = [
  {
    catalogPath: "github/backoffice-app-private-key.keychain-ref",
    encryptedKey: "GITHUB_PRIVATE_KEY",
    fingerprintSha256: "a".repeat(64),
    keychainService: "com.seorilabs.github.backoffice-app-private-key",
    status: "active",
    targetCredentialId: "shared/github/backoffice-app-private-key",
    targetKind: "macos-keychain-password",
  },
  {
    catalogPath: "github/backoffice-app-webhook.keychain-ref",
    encryptedKey: "GITHUB_WEBHOOK_SECRET",
    fingerprintSha256: "b".repeat(64),
    keychainService: "com.seorilabs.github.backoffice-app-webhook",
    status: "active",
    targetCredentialId: "shared/github/backoffice-app-webhook",
    targetKind: "macos-keychain-password",
  },
];
const targets = entries.map(({ status, fingerprintSha256, ...target }) => target);

async function fixture({ validationExit = 0 } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "github-recovery-catalog-")));
  await mkdir(join(root, "catalog"), { mode: 0o700 });
  await mkdir(join(root, "github"), { mode: 0o700 });
  await mkdir(join(root, "scripts"), { mode: 0o700 });
  await writeFile(join(root, "catalog/existing.yaml"), "version: 1\ncredentials: []\n", { mode: 0o600 });
  const validator = join(root, "scripts/credential-catalog.py");
  await writeFile(
    validator,
    `#!${process.execPath}\nprocess.exit(${validationExit});\n`,
    { mode: 0o700 },
  );
  await chmod(validator, 0o700);
  return root;
}

async function absent(path) {
  await assert.rejects(readFile(path), { code: "ENOENT" });
}

test("복구 등록은 공개 reference와 별도 catalog만 만들고 기존 목록을 보존한다", async () => {
  const root = await fixture();
  try {
    const adapter = createGithubRecoveryCatalogAdapter({ root, app });
    assert.equal(await adapter.targetsAbsent(targets), true);
    await adapter.registerBatch(entries);
    assert.equal(await adapter.targetsAbsent(targets), false);
    const document = parse(await readFile(join(root, "catalog/github-backoffice-app.yaml"), "utf8"));
    assert.deepEqual(document.credentials.map(({ id }) => id), entries.map(({ targetCredentialId }) => targetCredentialId));
    assert.deepEqual(
      document.credentials.map(({ public: identity }) => identity.fingerprintSha256),
      entries.map(({ fingerprintSha256 }) => fingerprintSha256),
    );
    for (const entry of entries) {
      const text = await readFile(join(root, entry.catalogPath), "utf8");
      assert.match(text, new RegExp(`account=${entry.targetCredentialId}`, "u"));
      assert.doesNotMatch(text, /BEGIN PRIVATE|ghp_|github_pat_|secret=/u);
    }
    assert.equal(await readFile(join(root, "catalog/existing.yaml"), "utf8"), "version: 1\ncredentials: []\n");
    await adapter.removeBatch(targets);
    await absent(join(root, "catalog/github-backoffice-app.yaml"));
    for (const entry of entries) await absent(join(root, entry.catalogPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("복구 등록은 경로와 service 치환을 거부한다", async () => {
  const root = await fixture();
  try {
    const adapter = createGithubRecoveryCatalogAdapter({ root, app });
    await assert.rejects(
      adapter.registerBatch([{ ...entries[0], catalogPath: "../escape" }, entries[1]]),
      { code: "P3_GITHUB_RECOVERY_CATALOG_TARGET_MISMATCH" },
    );
    await assert.rejects(
      adapter.registerBatch([{ ...entries[0], keychainService: "other.service" }, entries[1]]),
      { code: "P3_GITHUB_RECOVERY_CATALOG_TARGET_MISMATCH" },
    );
    await absent(join(root, "catalog/github-backoffice-app.yaml"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("중간 등록 실패는 새 reference만 보상하고 기존 대상은 삭제하지 않는다", async () => {
  const root = await fixture();
  try {
    const protectedPath = join(root, entries[1].catalogPath);
    await writeFile(protectedPath, "operator-owned\n", { mode: 0o600 });
    const adapter = createGithubRecoveryCatalogAdapter({ root, app });
    assert.equal(await adapter.targetsAbsent(targets), false);
    await assert.rejects(adapter.registerBatch(entries), { code: "EEXIST" });
    await absent(join(root, entries[0].catalogPath));
    assert.equal(await readFile(protectedPath, "utf8"), "operator-owned\n");
    await absent(join(root, "catalog/github-backoffice-app.yaml"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog 검증 실패는 이번 등록 파일을 모두 제거한다", async () => {
  const root = await fixture({ validationExit: 1 });
  try {
    const adapter = createGithubRecoveryCatalogAdapter({ root, app });
    await assert.rejects(adapter.registerBatch(entries), {
      code: "P3_GITHUB_RECOVERY_CATALOG_VALIDATION_FAILED",
    });
    await adapter.removeBatch(targets);
    await absent(join(root, "catalog/github-backoffice-app.yaml"));
    for (const entry of entries) await absent(join(root, entry.catalogPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("등록 후 바뀐 파일은 보상 과정에서 임의로 삭제하지 않는다", async () => {
  const root = await fixture();
  try {
    const adapter = createGithubRecoveryCatalogAdapter({ root, app });
    await adapter.registerBatch(entries);
    const path = join(root, "catalog/github-backoffice-app.yaml");
    await writeFile(path, "operator-changed\n", { mode: 0o600 });
    await assert.rejects(adapter.removeBatch(targets), {
      code: "P3_GITHUB_RECOVERY_CATALOG_COMPENSATION_FAILED",
    });
    assert.equal(await readFile(path, "utf8"), "operator-changed\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("명시적 복구 승인 없이는 파일과 helper에 접근하지 않는다", async () => {
  await assert.rejects(runGithubCredentialRecovery({ confirmation: "" }), {
    code: "P3_GITHUB_RECOVERY_OPTIONS_INVALID",
  });
});

test("실제 CLI는 SHA256 옵션을 파싱한 뒤 경로 경계를 검사한다", async () => {
  const root = await fixture();
  try {
    await assert.rejects(execFileAsync(process.execPath, [
      "scripts/fleet/run-github-credential-recovery.mjs",
      "--confirmation=GITHUB_APP_CREDENTIAL_OFFLINE_RECOVERY",
      `--credential-root=${join(root, "not-present")}`,
      `--source-repo=${root}`,
      `--helper=${join(root, "helper")}`,
      `--helper-sha256=${"a".repeat(64)}`,
      "--team-id=SEORIFIX01",
      `--process-boundary=${join(root, "boundary.node")}`,
      `--process-boundary-sha256=${"b".repeat(64)}`,
    ]), (error) => {
      assert.equal(error.stdout, "");
      assert.deepEqual(JSON.parse(error.stderr), {
        state: "RECOVERY_FAILED",
        code: "P3_GITHUB_RECOVERY_ROOT_INVALID",
        compensationFailed: false,
      });
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
