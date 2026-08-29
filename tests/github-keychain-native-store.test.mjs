import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { openGithubKeychainCredentialStore } from "../scripts/fleet/github-keychain-native-store.mjs";

const execFileAsync = promisify(execFile);
const fixtureSource = resolve("tests/fixtures/github-keychain-helper-fixture.mjs");
const nativeFixture = resolve(".build/github-keychain-helper-fixture");

const targets = [
  {
    encryptedKey: "GITHUB_PRIVATE_KEY",
    targetCredentialId: "shared/github/backoffice-app-private-key",
    targetKind: "macos-keychain-password",
    keychainService: "com.seorilabs.github.backoffice-app-private-key",
    catalogPath: "github/backoffice-app-private-key.keychain-ref",
  },
  {
    encryptedKey: "GITHUB_WEBHOOK_SECRET",
    targetCredentialId: "shared/github/backoffice-app-webhook",
    targetKind: "macos-keychain-password",
    keychainService: "com.seorilabs.github.backoffice-app-webhook",
    catalogPath: "github/backoffice-app-webhook.keychain-ref",
  },
];

async function fixtureHelper(root, name = "github-keychain-helper-fixture.mjs") {
  const path = join(root, name);
  const fixtureText = await readFile(fixtureSource, "utf8");
  await writeFile(path, fixtureText.replace(/^#![^\n]*/u, `#!${process.execPath}`), { mode: 0o755 });
  await chmod(path, 0o755);
  const bytes = await readFile(path);
  const helperSha256 = createHash("sha256").update(bytes).digest("hex");
  bytes.fill(0);
  return { helperPath: await realpath(path), helperSha256 };
}

test("native store는 signed helper 공개 identity와 고정 target set만 수락한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "seori-keychain-store-"));
  const privateKey = Buffer.alloc(512, 0x51);
  const webhook = Buffer.alloc(48, 0x57);
  try {
    const binding = await fixtureHelper(root);
    const store = await openGithubKeychainCredentialStore({
      ...binding,
      teamIdentifier: "SEORIFIX01",
    });
    await store.writeBatch([
      { ...targets[0], secret: privateKey },
      { ...targets[1], secret: webhook },
    ]);
    await store.removeBatch(targets);

    await assert.rejects(
      openGithubKeychainCredentialStore({
        ...binding,
        helperSha256: "0".repeat(64),
        teamIdentifier: "SEORIFIX01",
      }),
      (error) => error.code === "P3_GITHUB_KEYCHAIN_HELPER_BINDING_INVALID",
    );
    await assert.rejects(
      openGithubKeychainCredentialStore({
        ...binding,
        teamIdentifier: "WRONGTEAM1",
      }),
      (error) => error.code === "P3_GITHUB_KEYCHAIN_CODE_IDENTITY_MISMATCH",
    );

    const storeAgain = await openGithubKeychainCredentialStore({
      ...binding,
      teamIdentifier: "SEORIFIX01",
    });
    await assert.rejects(
      storeAgain.writeBatch([
        { ...targets[1], secret: webhook },
        { ...targets[0], secret: privateKey },
      ]),
      (error) => error.code === "P3_GITHUB_KEYCHAIN_TARGET_SET_MISMATCH",
    );
  } finally {
    privateKey.fill(0);
    webhook.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test("native store는 helper batch compensation 실패를 비밀값 없이 보존한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "seori-keychain-compensation-"));
  const privateKey = Buffer.alloc(512, 0x43);
  const webhook = Buffer.alloc(48, 0x44);
  try {
    const binding = await fixtureHelper(root, "github-keychain-compensation-failed.mjs");
    const store = await openGithubKeychainCredentialStore({
      ...binding,
      teamIdentifier: "SEORIFIX01",
    });
    await assert.rejects(
      store.writeBatch([
        { ...targets[0], secret: privateKey },
        { ...targets[1], secret: webhook },
      ]),
      (error) => {
        assert.equal(error.code, "P3_GITHUB_KEYCHAIN_BATCH_COMPENSATION_FAILED");
        assert.equal(error.compensationFailed, true);
        assert.doesNotMatch(error.message, /CCCC|DDDD|51515151|57575757/u);
        return true;
      },
    );
  } finally {
    privateKey.fill(0);
    webhook.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test("Security.framework helper source는 prompt 없는 exact ACL과 자체 보상 경계를 고정한다", async () => {
  const [nativeSource, adapterSource, buildSource] = await Promise.all([
    readFile("scripts/fleet/native/github-keychain-helper.swift", "utf8"),
    readFile("scripts/fleet/github-keychain-native-store.mjs", "utf8"),
    readFile("scripts/fleet/build-github-keychain-helper.mjs", "utf8"),
  ]);
  for (const token of [
    "SecCodeCopySelf",
    "SecCodeCheckValidity",
    "kSecCodeInfoTeamIdentifier",
    "adHocCodeSignatureFlag",
    "SecTrustedApplicationCreateFromPath",
    "SecAccessCreate",
    "SecAccessCopyACLList",
    "SecACLCopyAuthorizations",
    "SecACLCopyContents",
    "interactionNotAllowed = true",
    "SecItemCopyMatching",
    "SecItemAdd",
    "SecItemDelete",
    "errSecItemNotFound",
    "compensationVerified",
  ]) {
    assert.match(nativeSource, new RegExp(token.replaceAll("(", "\\(")));
  }
  assert.doesNotMatch(nativeSource, /\bProcess\s*\(|security\s+-w|add-generic-password/u);
  assert.doesNotMatch(adapterSource, /shell:\s*true|process\.env|secret\.toString/u);
  assert.match(buildSource, /--signing-identity/u);
  assert.match(buildSource, /codesign/u);
  assert.match(buildSource, /--options[\s\S]*runtime/u);
});

test("macOS fixture native helper는 item-not-found와 부분 batch 보상을 실제 binary에서 검증한다", {
  skip: process.platform !== "darwin",
}, async () => {
  const result = await execFileAsync(nativeFixture, ["fixture-self-test"], {
    env: { LANG: "C", PATH: "/usr/bin:/bin" },
  });
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    state: "FIXTURE_VERIFIED",
    itemNotFoundExact: true,
    batchCompensationVerified: true,
    fixtureOnly: true,
  });

  const attestation = await execFileAsync(nativeFixture, ["attest"], {
    env: { LANG: "C", PATH: "/usr/bin:/bin" },
  });
  assert.equal(JSON.parse(attestation.stdout).state, "FIXTURE");
  assert.equal(basename(nativeFixture), "github-keychain-helper-fixture");
});
