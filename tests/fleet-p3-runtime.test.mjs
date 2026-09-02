import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  constants as cryptoConstants,
  createCipheriv,
  createHash,
  generateKeyPairSync,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { fileURLToPath } from "node:url";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";
import { parse, stringify } from "yaml";

import { githubAppReadback } from "../scripts/fleet/github-app-readback.mjs";
import { recoverGithubAppCredentials } from "../scripts/fleet/github-credential-recovery.mjs";
import { openGithubKeychainCredentialStore } from "../scripts/fleet/github-keychain-native-store.mjs";
import {
  createTrustedWifAdapter,
  createTrustedWifProviderPolicy,
  trustedFleetExecutorContract,
} from "../packages/repo-contract/src/trusted-executor.mjs";

const execFileAsync = promisify(execFile);
const script = "scripts/fleet/render-p3-runtime.mjs";
const gcpBootstrap = "scripts/fleet/bootstrap-p3-gcp.mjs";
const secretManagerBootstrap = "scripts/fleet/bootstrap-p3-secret-manager.mjs";
const gcloudMock = fileURLToPath(
  new URL("./fixtures/p3-gcloud-mock.mjs", import.meta.url),
);
const contract = parse(await readFile("contracts/fleet-p3-runtime.yaml", "utf8"));
const schema = JSON.parse(
  await readFile("contracts/fleet-p3-runtime.schema.json", "utf8"),
);
const recoveryModuleSource = await readFile(
  "scripts/fleet/github-credential-recovery.mjs",
  "utf8",
);
const activeBackofficeInstallation = {
  app_id: 4124446,
  app_slug: "seorilabs-backoffice",
  id: 142120077,
  target_type: "Organization",
  repository_selection: "all",
  suspended_at: null,
  permissions: {
    actions: "write",
    checks: "read",
    contents: "write",
    issues: "write",
    members: "read",
    metadata: "read",
    pull_requests: "read",
  },
  events: ["issues", "issue_comment", "pull_request", "push", "workflow_run"],
};

async function render(command) {
  const result = await execFileAsync(process.execPath, [script, command]);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

test("P3 runtime public contract는 strict schema와 고정 pilot을 사용한다", () => {
  const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(
    schema,
  );
  assert.equal(validate(contract), true, JSON.stringify(validate.errors));
  assert.equal(
    schema.$id,
    "https://seorilabs.github.io/contracts/v4/fleet-p3-runtime.schema.json",
  );
  const legacyMajor = structuredClone(contract);
  legacyMajor.schemaVersion = 2;
  assert.equal(validate(legacyMajor), false);
  assert.equal(
    trustedFleetExecutorContract.githubApiVersion,
    contract.github.apiVersion,
  );
  assert.deepEqual(
    contract.github.pilotValues.map(({ repository }) => repository),
    ["happy-farm", "lizard-tycoon"],
  );
  assert.equal(contract.schemaVersion, 4);
  assert.deepEqual(contract.cloudBuild.wif.supersededWorkflowExecutionShas, [
    "7790257716bca71ae865aa11274803520adf13e3",
  ]);
  assert.deepEqual(contract.authBroker.kubernetesApi, {
    server: "https://kubernetes.default.svc",
    egressCidr: "10.152.183.1/32",
    port: 443,
    audience: "https://kubernetes.default.svc",
    caConfigMapName: "kube-root-ca.crt",
    tokenExpirationSeconds: 600,
  });
  assert.equal(contract.authBroker.state.protection.mode, "APPLICATION_ENVELOPE");
  assert.equal(contract.authBroker.state.protection.status, "blocked_unverified");
  assert.deepEqual(contract.authBroker.state.hostEncryption, {
    schemaVersion: 1,
    mode: "LUKS2_DM_CRYPT",
    status: "verified",
    luksType: "LUKS2",
    filesystemType: "ext4",
    mapperPath: "/dev/mapper/seori-auth-state",
    sourcePath: "/data/seori-auth/seori-auth-state.luks",
    markerPath: "/var/lib/seori-auth/.seorilabs-host-encrypted-mount.json",
    digestAlgorithm: "SHA256_CANONICAL_JSON",
    missingPolicy: "FAIL_CLOSED",
    verification: {
      verifierSourceSha: "3640229983eb27505e9edbc136654f0c9a5da1d5",
      receipt: {
        schemaVersion: 1,
        state: "HOST_ENCRYPTED_MOUNT_REBOOT_VERIFIED",
        nodeName: "rpi5",
        contractDigest: "06368f5a09faf6b76510ee2b1e04217e765783010c7bcdc06839f51a1df6cc4b",
        previousBootId: "13550044-568d-4cca-81f9-d9649a565113",
        currentBootId: "83492a7b-8171-4f72-b865-d2ac9b6df0ca",
        provisionedDigest: "3b45e051747ea55a179becbb9176c08d83359a1dccca855b4305ee9f78ec3737",
        hostEncryptionDigest: "b9641e773e5a27b2a16c522dc232830a7e3a5ce9435ba5acd4a3b6ba2f2d3101",
        observedDigest: "1395adf535b12060963d2cb9b84cf7d8df1279968d0d0e813ecc204d37813444",
      },
    },
  });
  assert.equal(
    contract.authBroker.state.protection.secretPersistencePolicy,
    "ENCRYPTED_ENVELOPE_ONLY",
  );
  assert.deepEqual(contract.authBroker.state.protection.journal, {
    schemaVersion: 2,
    contentPolicy: "SECRET_FREE_PUBLIC_CONTROL_AND_AUDIT_ONLY",
    integrity: "HMAC_SHA256_CHAIN",
    writeValidation: "FAIL_CLOSED_BEFORE_SERIALIZATION",
    logicalCredentialId: "shared/seori-auth/journal-mac",
    checkpoint: {
      schemaVersion: 1,
      journalId: "seori-auth-production",
      authoritySpiffeId:
        "spiffe://seorilabs.local/ns/platform/sa/provider-execution-signer",
      mode: "TRUSTED_CONTROL_PLANE_CAS",
      persistence: "BACKOFFICE_DURABLE_CAS",
      commitOrder: "JOURNAL_FSYNC_THEN_CHECKPOINT_CAS",
      unknownOutcomePolicy: "READBACK_FIRST",
    },
  });
  assert.deepEqual(contract.authBroker.state.protection.browserVault, {
    envelopeVersion: 1,
    algorithm: "aes-256-gcm",
    logicalCredentialId: "shared/seori-auth/browser-vault",
    plaintextAtRestAllowed: false,
  });
  assert.deepEqual(
    {
      ...contract.authBroker.state.volume,
    },
    {
      kubernetesContext: "vzyx-cluster",
      namespace: "auth-broker",
      claimName: "seori-auth-state",
      volumeName: "seori-auth-state-rpi5",
      nodeName: "rpi5",
      localPath: "/var/lib/seori-auth",
      size: "10Gi",
      storageClassName: "microk8s-hostpath",
      accessModes: ["ReadWriteOnce"],
      volumeMode: "Filesystem",
      reclaimPolicy: "Retain",
      readbackPolicy: "EXACT_READBACK_ONLY",
      mutationPolicy: "SEPARATE_APPROVAL",
      deletionPolicy: "FORBIDDEN",
      unknownOutcomePolicy: "READBACK_FIRST",
      readbackAttestation: {
        schemaVersion: 1,
        digestAlgorithm: "SHA256_CANONICAL_JSON",
        startupGate: "INIT_CONTAINER_EXACT_READBACK",
        postStartGate: "READINESS_MARKER_EXACT_DIGEST",
      },
    },
  );
  assert.equal(contract.authBroker.registry.mode, "PUBLIC");
  assert.equal(contract.authBroker.registry.packageVisibilityStatus, "verified_public");
  assert.equal(contract.authBroker.registry.personalOperatorReuseAllowed, false);
  for (const field of ["credentialId", "imagePullSecretName", "catalogStatus", "kubernetesStatus"]) {
    assert.equal(field in contract.authBroker.registry, false);
  }
  assert.equal(contract.github.credentialRecovery.approvalGate.state, "HUMAN_REAUTH_REQUIRED");
  const expectedGithubProvider =
    "projects/321365398093/locations/global/workloadIdentityPools/fleet-p3/providers/github-cloud-build";
  assert.equal(contract.cloudBuild.provider, expectedGithubProvider);
  assert.equal(
    contract.cloudBuild.wif.githubAudience,
    `https://iam.googleapis.com/${expectedGithubProvider}`,
  );
  for (const [field, value] of [
    ["provider", `${expectedGithubProvider}-lookalike`],
    ["githubAudience", `https://iam.googleapis.com/${expectedGithubProvider}-lookalike`],
  ]) {
    const drifted = structuredClone(contract);
    if (field === "provider") drifted.cloudBuild.provider = value;
    else drifted.cloudBuild.wif.githubAudience = value;
    assert.equal(validate(drifted), false);
  }
  assert.doesNotMatch(
    recoveryModuleSource,
    /\/usr\/bin\/security|add-generic-password|find-generic-password/u,
  );
  assert.deepEqual(
    contract.authBroker.secretManager.provisioning.values.map(
      ({ secretId, encoding, entropyBytes }) => ({ secretId, encoding, entropyBytes }),
    ),
    [
      { secretId: "seori-auth-journal-mac", encoding: "raw", entropyBytes: 32 },
      { secretId: "seori-auth-browser-vault", encoding: "raw", entropyBytes: 32 },
      { secretId: "seori-auth-canary-password", encoding: "base64url", entropyBytes: 32 },
      { secretId: "seori-auth-canary-totp-seed", encoding: "base32-no-padding", entropyBytes: 20 },
    ],
  );
});

test("GitHub App bootstrap은 active Backoffice App을 재사용하고 새 App을 등록하지 않는다", async () => {
  const output = await render("github-app");
  assert.equal("registrationUrl" in output, false);
  assert.equal(output.reuseExisting, true);
  assert.deepEqual(output.identity, {
    appId: 4124446,
    slug: "seorilabs-backoffice",
    installationId: 142120077,
    targetType: "Organization",
    repositorySelection: "all",
  });
  assert.equal(output.requiredPermissions.organization_custom_properties, "admin");
  assert.equal(output.requiredPermissions.organization_administration, "write");
  assert.equal(output.requiredPermissions.members, "read");
  assert.deepEqual(output.requiredEvents, ["repository", "push"]);
  assert.deepEqual(output.permissionExpansionGate, {
    type: "approval",
    state: "HUMAN_REAUTH_REQUIRED",
    operation: "GITHUB_APP_PERMISSION_EXPANSION_AND_INSTALLATION_ACCEPTANCE",
    requiredRole: "organization_owner",
    automaticRetry: false,
    requiredReadback: [
      "app_id",
      "slug",
      "installation_id",
      "repository_selection",
      "suspended_at",
      "permissions",
      "events",
    ],
  });
  assert.equal(output.webhook.appPrivateKeyCredentialId, "shared/github/backoffice-app-private-key");
  assert.equal(output.webhook.credentialId, "shared/github/backoffice-app-webhook");
  assert.equal(output.webhook.url, "https://backoffice.vzyx.xyz/api/webhooks");
  assert.equal(output.credentialRecovery.trustedAdapter.state, "blocked_unverified");
  assert.equal(
    output.credentialRecovery.trustedAdapter.credentialStore,
    "security-framework-native-helper",
  );
  assert.deepEqual(
    {
      nativeModule: output.credentialRecovery.trustedAdapter.nativeModule,
      nativeEntrypoint: output.credentialRecovery.trustedAdapter.nativeEntrypoint,
      helperIdentifier: output.credentialRecovery.trustedAdapter.helperIdentifier,
      binaryProtocol: output.credentialRecovery.trustedAdapter.binaryProtocol,
    },
    {
      nativeModule: "scripts/fleet/github-keychain-native-store.mjs",
      nativeEntrypoint: "openGithubKeychainCredentialStore",
      helperIdentifier: "com.seorilabs.fleet.github-keychain-helper",
      binaryProtocol: "binary-stdin-v1",
    },
  );
  assert.equal(output.credentialRecovery.plaintextPolicy.newKeyGenerationAllowed, false);
  assert.deepEqual(
    output.credentialRecovery.mappings.map(({ targetCredentialId }) => targetCredentialId),
    [
      "shared/github/backoffice-app-private-key",
      "shared/github/backoffice-app-webhook",
    ],
  );
  assert.equal(output.credentialRecovery.approvalGate.automaticRetry, false);
  assert.equal(output.staticKeysCreated, false);
  assert.doesNotMatch(JSON.stringify(output), /-----BEGIN|gh[opusr]_|github_pat_/u);
});

test("GitHub App readback은 기존 permission/event를 보존한 최소 union만 계산한다", () => {
  const state = githubAppReadback(
    {
      ...contract.github.app,
    },
    [activeBackofficeInstallation],
  );
  assert.equal(state.identityExact, true);
  assert.equal(state.ready, false);
  assert.deepEqual(state.permissionChanges, [
    { permission: "administration", current: null, required: "write" },
    { permission: "environments", current: null, required: "write" },
    { permission: "organization_administration", current: null, required: "write" },
    { permission: "organization_custom_properties", current: null, required: "admin" },
    { permission: "pull_requests", current: "read", required: "write" },
    { permission: "repository_custom_properties", current: null, required: "write" },
    { permission: "workflows", current: null, required: "write" },
  ]);
  assert.equal(state.permissionUnion.actions, "write");
  assert.equal(state.permissionUnion.checks, "read");
  assert.equal(state.permissionUnion.issues, "write");
  assert.equal(state.permissionUnion.members, "read");
  assert.deepEqual(state.eventAdditions, ["repository"]);
  assert.deepEqual(state.eventUnion, [
    "issue_comment",
    "issues",
    "pull_request",
    "push",
    "repository",
    "workflow_run",
  ]);

  const accepted = githubAppReadback(
    { ...contract.github.app },
    [{
      ...activeBackofficeInstallation,
      permissions: state.permissionUnion,
      events: state.eventUnion,
    }],
  );
  assert.equal(accepted.ready, true);
  assert.equal(accepted.installationAcceptanceRequired, false);
});

function sealForRecovery(plaintext, publicKey, label) {
  const sessionKey = randomBytes(32);
  const nonce = Buffer.alloc(12);
  try {
    const rsa = publicEncrypt(
      {
        key: publicKey,
        oaepHash: "sha256",
        oaepLabel: label,
        padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      },
      sessionKey,
    );
    const cipher = createCipheriv("aes-256-gcm", sessionKey, nonce);
    const encrypted = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const size = Buffer.alloc(2);
    size.writeUInt16BE(rsa.length);
    return Buffer.concat([size, rsa, encrypted]).toString("base64");
  } finally {
    sessionKey.fill(0);
    nonce.fill(0);
  }
}

function tamperSealedPayload(ciphertextBase64) {
  const bytes = Buffer.from(ciphertextBase64, "base64");
  const rsaLength = bytes.readUInt16BE(0);
  bytes[2 + rsaLength] ^= 0x01;
  return bytes.toString("base64");
}

test("GitHub credential recovery는 ciphertext를 memory에서 분리 복구하고 backup/readback을 강제한다", async (context) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "p3-github-keychain-fixture-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const fixtureSource = await readFile(
    "tests/fixtures/github-keychain-helper-fixture.mjs",
    "utf8",
  );
  async function openFixtureStore(name) {
    const fixturePath = join(fixtureRoot, name);
    await writeFile(
      fixturePath,
      fixtureSource.replace(/^#![^\n]*/u, `#!${process.execPath}`),
      { mode: 0o755 },
    );
    await chmod(fixturePath, 0o755);
    const fixtureBytes = await readFile(fixturePath);
    try {
      return await openGithubKeychainCredentialStore({
        helperPath: await realpath(fixturePath),
        helperSha256: createHash("sha256").update(fixtureBytes).digest("hex"),
        teamIdentifier: "SEORIFIX01",
      });
    } finally {
      fixtureBytes.fill(0);
    }
  }
  const credentialStore = await openFixtureStore("github-keychain-helper-fixture.mjs");
  const recoveryPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const appPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const appPrivateKey = Buffer.from(
    appPair.privateKey.export({ format: "pem", type: "pkcs8" }),
  );
  const webhook = randomBytes(48);
  const label = Buffer.from("platform/backoffice-secrets");
  const source = {
    apiVersion: "bitnami.com/v1alpha1",
    kind: "SealedSecret",
    metadata: { name: "backoffice-secrets", namespace: "platform" },
    spec: {
      template: {
        metadata: { name: "backoffice-secrets", namespace: "platform" },
      },
      encryptedData: {
        GITHUB_PRIVATE_KEY: sealForRecovery(
          appPrivateKey,
          recoveryPair.publicKey,
          label,
        ),
        GITHUB_WEBHOOK_SECRET: sealForRecovery(
          webhook,
          recoveryPair.publicKey,
          label,
        ),
      },
    },
  };
  const sourceBytes = Buffer.from(stringify(source));
  const recoveryDocument = {
    apiVersion: "v1",
    kind: "List",
    items: [{
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "recovery", namespace: "kube-system" },
      data: {
        "tls.key": Buffer.from(
          recoveryPair.privateKey.export({ format: "pem", type: "pkcs8" }),
        ).toString("base64"),
      },
    }],
  };
  const recoveryBytes = Buffer.from(stringify(recoveryDocument));
  const syntheticContract = structuredClone(contract);
  syntheticContract.github.credentialRecovery.trustedAdapter.state = "ready";
  syntheticContract.github.credentialRecovery.source.manifestSha256 =
    createHash("sha256").update(sourceBytes).digest("hex");
  const phases = [];
  const registered = [];
  const result = await recoverGithubAppCredentials({
    contract: syntheticContract,
    sourceBytes,
    recoveryBytes,
    adapters: {
      approval: { authorize: async () => true },
      appIdentity: {
        read: async () => ({
          appId: 4124446,
          slug: "seorilabs-backoffice",
          installationId: 142120077,
          targetType: "Organization",
          repositorySelection: "all",
          suspendedAt: null,
        }),
      },
      backupRestore: {
        verify: async (phase) => {
          phases.push(phase);
          return true;
        },
      },
      catalog: {
        targetsAbsent: async () => true,
        registerBatch: async (entries) => registered.push(...entries),
        removeBatch: async () => assert.fail("successful recovery must not rollback catalog"),
      },
      credentialStore,
    },
  });
  assert.equal(result.state, "RECOVERED");
  assert.deepEqual(phases, ["pre-recovery", "post-recovery"]);
  assert.deepEqual(
    result.logicalCredentials.map(({ id }) => id),
    [
      "shared/github/backoffice-app-private-key",
      "shared/github/backoffice-app-webhook",
    ],
  );
  assert.equal(registered.length, 2);
  assert.deepEqual(
    registered.map(({ fingerprintSha256 }) => fingerprintSha256),
    [result.appPublicKeyFingerprintSha256, result.webhookFingerprintSha256],
  );
  const appPublicKey = Buffer.from(
    appPair.publicKey.export({ format: "der", type: "spki" }),
  );
  try {
    assert.equal(
      result.appPublicKeyFingerprintSha256,
      createHash("sha256").update(appPublicKey).digest("hex"),
    );
  } finally {
    appPublicKey.fill(0);
  }
  assert.equal(
    result.webhookFingerprintSha256,
    createHash("sha256").update(webhook).digest("hex"),
  );
  assert.ok(sourceBytes.every((byte) => byte === 0));
  assert.ok(recoveryBytes.every((byte) => byte === 0));
  assert.doesNotMatch(JSON.stringify(result), /BEGIN PRIVATE|github_pat_|webhook-secret/u);

  const tamperedSource = structuredClone(source);
  tamperedSource.spec.encryptedData.GITHUB_WEBHOOK_SECRET = tamperSealedPayload(
    tamperedSource.spec.encryptedData.GITHUB_WEBHOOK_SECRET,
  );
  const tamperedBytes = Buffer.from(stringify(tamperedSource));
  const tamperedContract = structuredClone(syntheticContract);
  tamperedContract.github.credentialRecovery.source.manifestSha256 =
    createHash("sha256").update(tamperedBytes).digest("hex");
  await assert.rejects(
    recoverGithubAppCredentials({
      contract: tamperedContract,
      sourceBytes: tamperedBytes,
      recoveryBytes: Buffer.from(stringify(recoveryDocument)),
      adapters: {
        approval: { authorize: async () => true },
        appIdentity: { read: async () => result.appIdentity },
        backupRestore: { verify: async () => true },
        catalog: {
          targetsAbsent: async () => true,
          registerBatch: async () => assert.fail("tampered payload must not register"),
          removeBatch: async () => assert.fail("tampered payload must not rollback catalog"),
        },
        credentialStore,
      },
    }),
    (error) => {
      assert.equal(error.code, "P3_GITHUB_CIPHERTEXT_DECRYPT_FAILED");
      return true;
    },
  );

  const blockedSource = Buffer.from("not-read");
  const blockedRecovery = Buffer.from("not-read");
  await assert.rejects(
    recoverGithubAppCredentials({
      contract,
      sourceBytes: blockedSource,
      recoveryBytes: blockedRecovery,
      adapters: {
        approval: { authorize: async () => true },
        appIdentity: { read: async () => result.appIdentity },
        backupRestore: { verify: async () => true },
        catalog: {
          targetsAbsent: async () => true,
          registerBatch: async () => {},
          removeBatch: async () => {},
        },
        credentialStore,
      },
    }),
    (error) => {
      assert.equal(error.code, "P3_GITHUB_RECOVERY_NATIVE_HELPER_REQUIRED");
      return true;
    },
  );
  assert.ok(blockedSource.every((byte) => byte === 0));
  assert.ok(blockedRecovery.every((byte) => byte === 0));

  const untrustedSource = Buffer.from("not-read");
  const untrustedRecovery = Buffer.from("not-read");
  await assert.rejects(
    recoverGithubAppCredentials({
      contract: syntheticContract,
      sourceBytes: untrustedSource,
      recoveryBytes: untrustedRecovery,
      adapters: {
        approval: { authorize: async () => true },
        appIdentity: { read: async () => result.appIdentity },
        backupRestore: { verify: async () => true },
        catalog: {
          targetsAbsent: async () => true,
          registerBatch: async () => {},
          removeBatch: async () => {},
        },
        credentialStore: { writeBatch: async () => {}, removeBatch: async () => {} },
      },
    }),
    (error) => error.code === "P3_GITHUB_RECOVERY_TRUSTED_ADAPTERS_REQUIRED",
  );
  assert.ok(untrustedSource.every((byte) => byte === 0));
  assert.ok(untrustedRecovery.every((byte) => byte === 0));

  const failedCredentialStore = await openFixtureStore(
    "github-keychain-compensation-failed.mjs",
  );
  await assert.rejects(
    recoverGithubAppCredentials({
      contract: syntheticContract,
      sourceBytes: Buffer.from(stringify(source)),
      recoveryBytes: Buffer.from(stringify(recoveryDocument)),
      adapters: {
        approval: { authorize: async () => true },
        appIdentity: { read: async () => result.appIdentity },
        backupRestore: { verify: async () => true },
        catalog: {
          targetsAbsent: async () => true,
          registerBatch: async () => assert.fail("failed native write must not register"),
          removeBatch: async () => assert.fail("failed native write must not remove catalog"),
        },
        credentialStore: failedCredentialStore,
      },
    }),
    (error) => {
      assert.equal(error.code, "P3_GITHUB_KEYCHAIN_BATCH_COMPENSATION_FAILED");
      assert.equal(error.compensationFailed, true);
      return true;
    },
  );

  const cleanup = { catalog: 0 };
  await assert.rejects(
    recoverGithubAppCredentials({
      contract: syntheticContract,
      sourceBytes: Buffer.from(stringify(source)),
      recoveryBytes: Buffer.from(stringify(recoveryDocument)),
      adapters: {
        approval: { authorize: async () => true },
        appIdentity: { read: async () => result.appIdentity },
        backupRestore: { verify: async () => true },
        catalog: {
          targetsAbsent: async () => true,
          registerBatch: async () => {
            throw new Error("provider detail must not escape");
          },
          removeBatch: async () => {
            cleanup.catalog += 1;
            throw new Error("cleanup detail must not escape");
          },
        },
        credentialStore,
      },
    }),
    (error) => {
      assert.equal(error.code, "P3_GITHUB_RECOVERY_TRUSTED_ADAPTER_FAILED");
      assert.equal(error.compensationFailed, true);
      assert.doesNotMatch(error.message, /provider detail|cleanup detail/u);
      return true;
    },
  );
  assert.deepEqual(cleanup, { catalog: 1 });
  appPrivateKey.fill(0);
  webhook.fill(0);
  label.fill(0);
});

test("custom property와 읽기 전용 SHADOW는 pilot 두 repo만 겨냥한다", async () => {
  const properties = await render("custom-properties");
  const values = await render("pilot-values");
  const protection = await render("protection");
  assert.equal(properties.length, 4);
  assert.ok(properties.every(({ method }) => method === "PUT"));
  assert.deepEqual(
    properties
      .map(({ path }) => path.split("/").at(-1))
      .toSorted(),
    ["fleet-managed", "fleet-profile", "fleet-ruleset", "fleet-state"],
  );
  assert.deepEqual(
    values.map(({ body }) => body.repository_names[0]),
    ["happy-farm", "lizard-tycoon"],
  );
  assert.equal(protection.providerMode, "REPO_BRANCH_PROTECTION");
  assert.equal(protection.rolloutMode, "SHADOW");
  assert.equal(protection.observationMode, "READ_ONLY");
  assert.equal(protection.preserveExisting, true);
  assert.equal(protection.activationRequiresApproval, true);
  assert.deepEqual(protection.repositories.map(({ fullName }) => fullName), [
    "seorilabs/happy-farm",
    "seorilabs/lizard-tycoon",
  ]);
  assert.equal(protection.requiredStatusCheck, "Org Contract / Org Contract");
  assert.equal(Object.hasOwn(protection, "method"), false);
});

test("GitHub bootstrap 기본 실행은 App 재사용 gate와 additive org dry-run만 출력한다", async () => {
  const result = await execFileAsync(process.execPath, [
    "scripts/fleet/bootstrap-p3-github.mjs",
  ]);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, "DRY_RUN");
  assert.equal(output.organization, "seorilabs");
  assert.equal(output.app.reuseExisting, true);
  assert.equal(output.app.identity.appId, 4124446);
  assert.equal(output.app.permissionExpansionGate.state, "HUMAN_REAUTH_REQUIRED");
  assert.equal(output.app.permissionExpansionGate.automaticRetry, false);
  assert.equal(output.app.trustedExecution.state, "blocked_unverified");
  assert.equal(output.app.trustedExecution.ambientPersonalTokenAllowed, false);
  assert.equal("registrationUrl" in output.app, false);
  assert.match(output.contractPlanDigest, /^[a-f0-9]{64}$/u);
  assert.match(
    output.apply,
    new RegExp(`fleet-github-${output.contractPlanDigest.slice(0, 12)}$`, "u"),
  );
  assert.doesNotMatch(output.apply, /c328d9bf55f3/u);
  assert.equal(output.operations.filter(({ method }) => method === "PUT").length, 4);
  assert.equal(output.operations.filter(({ method }) => method === "PATCH").length, 2);
  assert.equal(output.operations.filter(({ method }) => method === "POST").length, 0);
  assert.equal(output.protection.rolloutMode, "SHADOW");
  assert.doesNotMatch(JSON.stringify(output), /"enforcement":"(?:evaluate|active)"/u);
  assert.doesNotMatch(
    JSON.stringify(output),
    /-----BEGIN|gh[opusr]_|github_pat_|access.?token.?value|refresh.?token.?value/iu,
  );
});

test("GitHub bootstrap apply는 exact 공개 confirmation 없이는 실패한다", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["scripts/fleet/bootstrap-p3-github.mjs", "apply"]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /P3_GITHUB_APPLY_CONFIRMATION_REQUIRED/u);
      assert.doesNotMatch(error.stderr, /token|password|private.?key/iu);
      return true;
    },
  );
});

test("GitHub bootstrap은 valid confirmation도 trusted App executor 전에는 mutation 없이 거부한다", async () => {
  const planResult = await execFileAsync(process.execPath, [
    "scripts/fleet/bootstrap-p3-github.mjs",
  ]);
  const plan = JSON.parse(planResult.stdout);
  const confirmation = plan.apply.split(" ").at(-1);
  await assert.rejects(
    execFileAsync(process.execPath, [
      "scripts/fleet/bootstrap-p3-github.mjs",
      "apply",
      confirmation,
    ]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /P3_GITHUB_TRUSTED_APP_EXECUTOR_REQUIRED/u);
      assert.doesNotMatch(error.stderr, /token|password|private.?key/iu);
      return true;
    },
  );
});

test("Cloud Build identity는 앱별 canary/release executor와 secret 경계를 분리한다", async () => {
  const output = await render("cloud-build");
  assert.equal(output.executors.length, 8);
  assert.equal(
    new Set(output.executors.map(({ serviceAccountEmail }) =>
      serviceAccountEmail,
    )).size,
    8,
  );
  const canaries = output.executors.filter(
    ({ capability }) => capability === "ANDROID_CANARY_BUILD_ONLY",
  );
  const releases = output.executors.filter(
    ({ capability }) =>
      capability === "ANDROID_PLAY_PROMOTABLE_SIGNED_BUILD",
  );
  assert.equal(canaries.length, 4);
  assert.equal(releases.length, 4);
  assert.ok(canaries.every(({ secretBindings }) => secretBindings.length === 0));
  assert.ok(releases.every(({ secretBindings }) => secretBindings.length > 0));
  assert.equal(
    releases.find(({ fullName }) => fullName === "seorilabs/lizard-tycoon")
      .state,
    "blocked_unverified",
  );
  assert.deepEqual(
    releases
      .find(({ fullName }) => fullName === "seorilabs/lizard-tycoon")
      .secretBindings.find(({ resource }) =>
        resource.endsWith("/lizard-play-keystore-password"),
      ).usages,
    ["KEYSTORE_PASSWORD", "KEY_PASSWORD"],
  );
  assert.ok(
    output.submitter.bindings.some(
      ({ resource, role }) =>
        resource === "projects/seorilabs-ci" &&
        role === "roles/storage.bucketViewer",
    ),
  );
  assert.ok(
    output.executionPolicy.baseBindings.some(
      ({ resource, role }) =>
        resource === "gs://seorilabs-ci-build-artifacts" &&
        role === "roles/storage.objectAdmin",
    ),
  );
  const serialized = JSON.stringify(output);
  assert.doesNotMatch(serialized, /roles\/(?:owner|editor|viewer)"/u);
  assert.doesNotMatch(serialized, /private.?key|service.?account.?key/iu);
  assert.deepEqual(output.approval.supersededPlan, {
    state: "SUPERSEDED_DO_NOT_APPLY",
    contractDigest:
      "8302531fff6496917951122b6a97a0c372902aa4309ab87afa8b8a4aa83bea48",
    confirmation: "fleet-p3-8302531fff64",
    applyCount: 0,
    reason: "SHARED_EXECUTOR_COULD_READ_MULTIPLE_APP_SECRETS",
  });
});

test("GCP bootstrap 기본 실행은 exact source와 12개 keyless identity의 dry-run만 출력한다", async () => {
  const result = await execFileAsync(process.execPath, [
    "scripts/fleet/bootstrap-p3-gcp.mjs",
  ]);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, "DRY_RUN");
  assert.equal(output.project.id, "seorilabs-ci");
  assert.equal(output.project.number, "321365398093");
  assert.deepEqual(output.requiredServices, contract.cloudBuild.requiredServices);
  assert.equal(output.serviceAccounts.length, 12);
  assert.equal(new Set(output.serviceAccounts.map(({ email }) => email)).size, 12);
  assert.equal(output.staticKeysCreated, false);
  assert.match(output.contractDigest, /^[a-f0-9]{64}$/u);
  assert.match(
    output.confirmation,
    new RegExp(`fleet-p3-${output.contractDigest.slice(0, 12)}$`, "u"),
  );
  assert.doesNotMatch(output.confirmation, /e86018971183/u);
  assert.equal(
    output.workflowBundleSourceSha,
    "5159ca37fde9306e6b5da265f6889ae5782b03bd",
  );
  assert.equal(
    output.workflowExecutionSha,
    "5159ca37fde9306e6b5da265f6889ae5782b03bd",
  );
  assert.deepEqual(output.supersededWorkflowExecutionShas, [
    "7790257716bca71ae865aa11274803520adf13e3",
  ]);
  assert.deepEqual(
    output.workloadIdentity.github.supersededAttributeConditions.map(
      ({ executionSha }) => executionSha,
    ),
    ["7790257716bca71ae865aa11274803520adf13e3"],
  );
  assert.equal(
    output.workloadIdentity.github.supersededAttributeConditions[0].condition,
    output.workloadIdentity.github.attributeCondition.replaceAll(
      "5159ca37fde9306e6b5da265f6889ae5782b03bd",
      "7790257716bca71ae865aa11274803520adf13e3",
    ),
  );
  assert.equal(
    output.workloadIdentity.github.audience,
    `https://iam.googleapis.com/${contract.cloudBuild.provider}`,
  );
  assert.deepEqual(output.githubActions, contract.cloudBuild.githubActions);
  assert.deepEqual(
    contract.cloudBuild.wif.repositories.map(({ sha256 }) => sha256),
    [
      "20b971230510eb39f500c1c81ee655a744e3bf1c436c7cbff3b02e3d52b787c3",
      "5b1da48888609c0a0cc045f0130556867f37577f7b49a309d4ed575dd8e6d99c",
      "20b971230510eb39f500c1c81ee655a744e3bf1c436c7cbff3b02e3d52b787c3",
      "20b971230510eb39f500c1c81ee655a744e3bf1c436c7cbff3b02e3d52b787c3",
    ],
  );
  assert.equal(
    output.workloadIdentity.github.attributeCondition,
    "assertion.repository_owner_id == '283115031' && " +
      "((assertion.repository_id == '1250442131' && assertion.job_workflow_ref == 'seorilabs/.github/.github/workflows/rn-build-android-cloud-v2.yml@5159ca37fde9306e6b5da265f6889ae5782b03bd') || " +
      "(assertion.repository_id == '1265192029' && assertion.job_workflow_ref == 'seorilabs/.github/.github/workflows/godot-build-android-cloud-v2.yml@5159ca37fde9306e6b5da265f6889ae5782b03bd') || " +
      "(assertion.repository_id == '1298244321' && assertion.job_workflow_ref == 'seorilabs/.github/.github/workflows/rn-build-android-cloud-v2.yml@5159ca37fde9306e6b5da265f6889ae5782b03bd') || " +
      "(assertion.repository_id == '1298264957' && assertion.job_workflow_ref == 'seorilabs/.github/.github/workflows/rn-build-android-cloud-v2.yml@5159ca37fde9306e6b5da265f6889ae5782b03bd'))",
  );
  const capabilities = contract.cloudBuild.wif.repositories.map(
    ({ repositoryId, workflow }) => ({
      environment: contract.cloudBuild.githubActions.environment,
      repositoryId,
      jobWorkflowRef:
        `seorilabs/.github/${workflow}@${contract.cloudBuild.wif.workflowExecutionSha}`,
    }),
  );
  const providerPolicy = createTrustedWifProviderPolicy({
    organizationId: contract.cloudBuild.wif.organizationId,
    capabilities,
  });
  assert.equal(
    providerPolicy.attributeCondition,
    output.workloadIdentity.github.attributeCondition,
  );
  assert.deepEqual(
    providerPolicy.attributeMapping,
    Object.fromEntries(
      output.workloadIdentity.github.attributeMapping
        .split(",")
        .map((entry) => entry.split(/=(.*)/su).slice(0, 2)),
    ),
  );
  const trustedWifAdapter = createTrustedWifAdapter({
    organizationId: contract.cloudBuild.wif.organizationId,
    bindings: contract.cloudBuild.githubActions.repositoryBindings.map(
      (binding) => ({
        bindingRevision: binding.bindingRevision,
        capabilities,
        logicalCredentialId: binding.logicalCredentialId,
        providerResourceName: `//iam.googleapis.com/${contract.cloudBuild.provider}`,
        serviceAccountEmail:
          contract.cloudBuild.submitter.serviceAccountEmail,
      }),
    ),
    provider: {
      async applyBinding() {
        throw new Error("unused");
      },
      async readBinding({ expected }) {
        return {
          ...structuredClone(expected),
          providerEtag: "provider-etag-p3",
          serviceAccountPolicyEtag: "policy-etag-p3",
          state: "BOUND",
        };
      },
    },
  });
  for (const [index, capability] of capabilities.entries()) {
    const environmentBinding =
      contract.cloudBuild.githubActions.repositoryBindings[index];
    const observation = await trustedWifAdapter.readOperation(
      {
        kind: "gcp.wif-binding.ensure",
        payload: {
          approvedBundleDigest: `sha256:${"1".repeat(64)}`,
          bindingRevision: environmentBinding.bindingRevision,
          environment: capability.environment,
          jobWorkflowRef: capability.jobWorkflowRef,
          logicalCredentialId: environmentBinding.logicalCredentialId,
          organizationId: contract.cloudBuild.wif.organizationId,
          repositoryId: capability.repositoryId,
        },
      },
      { id: capability.repositoryId },
    );
    assert.equal(
      observation.providerAttributeCondition,
      output.workloadIdentity.github.attributeCondition,
    );
    assert.deepEqual(
      observation.providerAttributeMapping,
      providerPolicy.attributeMapping,
    );
    assert.ok(
      output.iamBindings.some(
        ({ member, resource, role }) =>
          member === observation.principalSetMember &&
          resource === contract.cloudBuild.submitter.serviceAccountEmail &&
          role === "roles/iam.workloadIdentityUser",
      ),
    );
  }
  assert.match(
    output.workloadIdentity.kubernetes.attributeCondition,
    /namespace.*auth-broker/u,
  );
  assert.ok(output.iamBindings.every(({ role }) => !/roles\/(?:owner|editor|viewer)$/u.test(role)));
  const serialized = JSON.stringify(output);
  assert.doesNotMatch(serialized, /private.?key|service.?account.?key|access.?token|refresh.?token/iu);
});

test("GCP bootstrap apply와 rollback은 exact 공개 confirmation 없이는 실패한다", async () => {
  for (const command of ["apply", "rollback"]) {
    await assert.rejects(
      execFileAsync(process.execPath, ["scripts/fleet/bootstrap-p3-gcp.mjs", command]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /P3_GCP_(?:APPLY|ROLLBACK)_CONFIRMATION_REQUIRED/u);
        assert.doesNotMatch(error.stderr, /token|password|private.?key/iu);
        return true;
      },
    );
  }
});

test("GCP apply는 exact legacy GitHub provider만 단조 축소하고 rollback은 IAM을 보존한다", async () => {
  const bootstrapSource = await readFile(gcpBootstrap, "utf8");
  assert.doesNotMatch(bootstrapSource, /remove-iam-policy-binding/u);
  const planResult = await execFileAsync(process.execPath, [gcpBootstrap, "plan"]);
  const plan = JSON.parse(planResult.stdout);
  const directory = await mkdtemp(join(tmpdir(), "seori-p3-gcloud-mock-"));
  const statePath = join(directory, "state.json");
  const mappingObject = (mapping) =>
    Object.fromEntries(
      mapping.split(",").map((entry) => entry.split(/=(.*)/su).slice(0, 2)),
    );
  const providerState = ({
    attributeCondition,
    attributeMapping,
    issuer,
    audience,
    disabled = false,
  }) => ({
    attributeCondition,
    attributeMapping: mappingObject(attributeMapping),
    disabled,
    oidc: { allowedAudiences: [audience], issuerUri: issuer },
  });
  const legacyGithubCondition = [
    `assertion.repository_owner_id == '${contract.cloudBuild.wif.organizationId}'`,
    `(${contract.cloudBuild.wif.repositories
      .map(
        ({ repositoryId }) =>
          `assertion.repository_id == '${repositoryId}'`,
      )
      .join(" || ")})`,
    `(${contract.cloudBuild.wif.repositories
      .map(
        ({ workflow }) =>
          `assertion.job_workflow_ref == 'seorilabs/.github/${workflow}@${contract.cloudBuild.wif.workflowExecutionSha}'`,
      )
      .join(" || ")})`,
  ].join(" && ");
  const initialState = {
    projectNumber: plan.project.number,
    services: plan.requiredServices.filter(
      (service) => service !== "sts.googleapis.com",
    ),
    serviceAccounts: Object.fromEntries(
      plan.serviceAccounts.map(({ email }) => [email, { email, disabled: false }]),
    ),
    pool: {
      name:
        `projects/${plan.project.number}/locations/global/workloadIdentityPools/` +
        plan.workloadIdentity.pool,
      displayName: "Seorilabs Fleet P3",
      description:
        "Dedicated keyless identities for Fleet Cloud Build and Auth Broker",
      disabled: false,
      state: "ACTIVE",
    },
    providers: {
      [plan.workloadIdentity.github.provider]: providerState(
        {
          ...plan.workloadIdentity.github,
          attributeCondition: legacyGithubCondition,
        },
      ),
      [plan.workloadIdentity.kubernetes.provider]: providerState(
        plan.workloadIdentity.kubernetes,
      ),
    },
    bindings: [
      plan.iamBindings[0],
      {
        resourceType: "project",
        resource: "projects/seorilabs-ci",
        role: "roles/logging.viewer",
        member: "serviceAccount:unrelated@seorilabs-ci.iam.gserviceaccount.com",
      },
    ],
    history: [],
  };
  const environment = {
    ...process.env,
    SEORILABS_GCLOUD_CLI: gcloudMock,
    P3_GCLOUD_MOCK_STATE: statePath,
  };
  const bootstrap = async (command, confirmation) => {
    const args = [gcpBootstrap, command];
    if (confirmation) args.push(confirmation);
    const result = await execFileAsync(process.execPath, args, { env: environment });
    return JSON.parse(result.stdout);
  };
  const readState = async () => JSON.parse(await readFile(statePath, "utf8"));
  const writeState = async (state) =>
    writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  try {
    const githubProviderId = plan.workloadIdentity.github.provider;
    const supersededCondition =
      plan.workloadIdentity.github.supersededAttributeConditions[0].condition;
    assert.match(supersededCondition, /@7790257716bca71ae865aa11274803520adf13e3'\)/u);
    const supersededState = structuredClone(initialState);
    supersededState.providers[githubProviderId].attributeCondition =
      supersededCondition;
    await writeState(supersededState);
    const migrated = await bootstrap("apply", plan.confirmation);
    assert.equal(migrated.ready, true);
    const migratedState = await readState();
    assert.deepEqual(
      migratedState.history.filter((entry) => entry.includes(githubProviderId)),
      [
        `provider:disable:${githubProviderId}`,
        `provider:update:${githubProviderId}`,
        `provider:enable:${githubProviderId}`,
      ],
    );
    assert.equal(
      migratedState.providers[githubProviderId].attributeCondition,
      plan.workloadIdentity.github.attributeCondition,
    );

    const unknownShaState = structuredClone(initialState);
    unknownShaState.providers[githubProviderId].attributeCondition =
      supersededCondition.replaceAll("7790257716bca71ae865aa11274803520adf13e3", "f".repeat(40));
    await writeState(unknownShaState);
    await assert.rejects(
      bootstrap("apply", plan.confirmation),
      (error) => {
        assert.match(error.stderr, /P3_GITHUB_WIF_PROVIDER_DRIFT/u);
        return true;
      },
    );
    assert.deepEqual((await readState()).history, []);

    for (const drift of ["condition", "mapping"]) {
      const unknownGithubDrift = structuredClone(initialState);
      const githubState =
        unknownGithubDrift.providers[
          plan.workloadIdentity.github.provider
        ];
      if (drift === "condition") {
        githubState.attributeCondition += " && false";
      } else {
        githubState.attributeMapping["attribute.environment"] =
          "assertion.environment";
      }
      await writeState(unknownGithubDrift);
      await assert.rejects(
        bootstrap("apply", plan.confirmation),
        (error) => {
          assert.match(error.stderr, /P3_GITHUB_WIF_PROVIDER_DRIFT/u);
          return true;
        },
      );
      assert.deepEqual((await readState()).history, []);
    }

    await writeState(initialState);
    const applied = await bootstrap("apply", plan.confirmation);
    assert.equal(applied.ready, true);
    const appliedState = await readState();
    assert.deepEqual(
      appliedState.history.filter((entry) => entry.startsWith("service:enable:")),
      ["service:enable:sts.googleapis.com"],
    );
    const githubProvider = plan.workloadIdentity.github.provider;
    assert.deepEqual(
      appliedState.history.filter((entry) => entry.includes(githubProvider)),
      [
        `provider:disable:${githubProvider}`,
        `provider:update:${githubProvider}`,
        `provider:enable:${githubProvider}`,
      ],
    );
    assert.equal(
      appliedState.providers[githubProvider].attributeCondition,
      plan.workloadIdentity.github.attributeCondition,
    );
    assert.equal(
      appliedState.bindings.filter(
        (item) => JSON.stringify(item) === JSON.stringify(plan.iamBindings[0]),
      ).length,
      1,
    );
    const bindingSnapshot = structuredClone(appliedState.bindings);

    const kubernetesProvider = plan.workloadIdentity.kubernetes.provider;
    appliedState.history = [];
    await writeState(appliedState);
    const rolledBack = await bootstrap("rollback", plan.rollbackConfirmation);
    assert.equal(rolledBack.state, "NEW_TOKEN_EXCHANGE_REVOKED");
    assert.equal(rolledBack.iamBindingsMutated, false);
    assert.equal(rolledBack.existingAccessTokensRevoked, false);
    assert.equal(rolledBack.requiredServicesDisabled, false);
    assert.equal(rolledBack.exactBindingsRemoved, 0);
    assert.equal(rolledBack.exactBindingsPreserved, plan.iamBindings.length);
    const rolledBackState = await readState();
    assert.deepEqual(rolledBackState.bindings, bindingSnapshot);
    assert.equal(rolledBackState.history.includes("iam:remove"), false);
    assert.deepEqual(rolledBackState.services, plan.requiredServices);
    assert.equal(rolledBackState.providers[githubProvider].disabled, true);
    assert.equal(rolledBackState.providers[kubernetesProvider].disabled, false);

    const disabledReadback = await bootstrap("readback");
    assert.equal(disabledReadback.ready, false);
    assert.deepEqual(disabledReadback.workloadIdentityPool, {
      exists: true,
      configurationExact: true,
      disabled: false,
      state: "ACTIVE",
      active: true,
    });
    assert.deepEqual(disabledReadback.providers.github, {
      exists: true,
      configurationExact: true,
      disabled: true,
      active: false,
    });
    assert.deepEqual(disabledReadback.providers.kubernetes, {
      exists: true,
      configurationExact: true,
      disabled: false,
      active: true,
    });

    const applyDriftState = structuredClone(rolledBackState);
    applyDriftState.history = [];
    applyDriftState.providers[kubernetesProvider].attributeCondition += " && false";
    await writeState(applyDriftState);
    await assert.rejects(
      bootstrap("apply", plan.confirmation),
      (error) => {
        assert.match(error.stderr, /P3_KUBERNETES_WIF_PROVIDER_DRIFT/u);
        return true;
      },
    );
    const applyDriftResult = await readState();
    assert.deepEqual(applyDriftResult.history, []);
    assert.equal(
      applyDriftResult.providers[plan.workloadIdentity.github.provider].disabled,
      true,
    );

    rolledBackState.history = [];
    await writeState(rolledBackState);

    const reapplied = await bootstrap("apply", plan.confirmation);
    assert.equal(reapplied.ready, true);
    const reappliedState = await readState();
    assert.deepEqual(reappliedState.bindings, bindingSnapshot);
    assert.ok(
      Object.values(reappliedState.providers).every(
        ({ disabled }) => disabled === false,
      ),
    );

    reappliedState.pool.disabled = true;
    await writeState(reappliedState);
    const poolDisabledReadback = await bootstrap("readback");
    assert.equal(poolDisabledReadback.ready, false);
    assert.equal(poolDisabledReadback.workloadIdentityPool.disabled, true);
    assert.equal(poolDisabledReadback.workloadIdentityPool.active, false);
    await assert.rejects(
      bootstrap("apply", plan.confirmation),
      (error) => {
        assert.match(error.stderr, /P3_GCP_WIF_POOL_DISABLED/u);
        return true;
      },
    );

    reappliedState.pool.disabled = false;
    reappliedState.pool.displayName = "drifted";
    await writeState(reappliedState);
    const poolDriftReadback = await bootstrap("readback");
    assert.equal(poolDriftReadback.ready, false);
    assert.equal(poolDriftReadback.workloadIdentityPool.configurationExact, false);
    await assert.rejects(
      bootstrap("apply", plan.confirmation),
      (error) => {
        assert.match(error.stderr, /P3_GCP_WIF_POOL_DRIFT/u);
        return true;
      },
    );

    reappliedState.pool.displayName = "Seorilabs Fleet P3";
    reappliedState.pool.state = "DELETED";
    await writeState(reappliedState);
    const poolStateReadback = await bootstrap("readback");
    assert.equal(poolStateReadback.ready, false);
    assert.equal(poolStateReadback.workloadIdentityPool.configurationExact, true);
    assert.equal(poolStateReadback.workloadIdentityPool.state, "DELETED");
    assert.equal(poolStateReadback.workloadIdentityPool.active, false);
    await assert.rejects(
      bootstrap("apply", plan.confirmation),
      (error) => {
        assert.match(error.stderr, /P3_GCP_WIF_POOL_STATE_INVALID/u);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Secret Manager bootstrap은 role partition을 two-phase 적용하고 rollback에서 IAM을 보존한다", async () => {
  const [secretPlanResult, gcpPlanResult] = await Promise.all([
    execFileAsync(process.execPath, [secretManagerBootstrap, "plan"]),
    execFileAsync(process.execPath, [gcpBootstrap, "plan"]),
  ]);
  const plan = JSON.parse(secretPlanResult.stdout);
  const gcpPlan = JSON.parse(gcpPlanResult.stdout);
  assert.equal(plan.resources.length, 4);
  assert.equal(plan.secretValuesCreated, false);
  assert.equal(plan.provisioning.state, "blocked_unverified");
  assert.equal(plan.provisioning.plaintextTransport, "fd3");
  assert.equal(
    plan.workflowBundleSourceSha,
    "5159ca37fde9306e6b5da265f6889ae5782b03bd",
  );
  assert.equal(
    plan.workflowExecutionSha,
    "5159ca37fde9306e6b5da265f6889ae5782b03bd",
  );
  assert.match(plan.confirmation, /^fleet-p3-secrets-[a-f0-9]{12}$/u);
  assert.doesNotMatch(plan.confirmation, /e86018971183/u);
  assert.deepEqual(
    plan.resources.map(({ consumerRole }) => consumerRole),
    ["broker", "broker", "password-loader", "totp-signer"],
  );

  const directory = await mkdtemp(join(tmpdir(), "seori-p3-secret-mock-"));
  const statePath = join(directory, "state.json");
  const mappingObject = (mapping) =>
    Object.fromEntries(
      mapping.split(",").map((entry) => entry.split(/=(.*)/su).slice(0, 2)),
    );
  const providerState = ({ attributeCondition, attributeMapping, issuer, audience }) => ({
    attributeCondition,
    attributeMapping: mappingObject(attributeMapping),
    disabled: false,
    oidc: { allowedAudiences: [audience], issuerUri: issuer },
  });
  const initial = {
    projectNumber: plan.project.number,
    serviceAccounts: {},
    providers: {
      [gcpPlan.workloadIdentity.github.provider]: providerState(
        gcpPlan.workloadIdentity.github,
      ),
      [gcpPlan.workloadIdentity.kubernetes.provider]: providerState(
        gcpPlan.workloadIdentity.kubernetes,
      ),
    },
    secrets: Object.fromEntries(
      plan.resources.map(({ secretId, version }) => [secretId, {
        name: `projects/${plan.project.number}/secrets/${secretId}`,
        versions: [{
          name: `projects/${plan.project.number}/secrets/${secretId}/versions/${version}`,
          state: "ENABLED",
        }],
      }]),
    ),
    bindings: [{
      resourceType: "secret",
      resource: "projects/seorilabs-ci/secrets/unrelated",
      role: "roles/secretmanager.secretAccessor",
      member: "serviceAccount:unrelated@seorilabs-ci.iam.gserviceaccount.com",
    }],
    history: [],
  };
  const environment = {
    ...process.env,
    SEORILABS_GCLOUD_CLI: gcloudMock,
    P3_GCLOUD_MOCK_STATE: statePath,
  };
  const bootstrap = async (command, confirmation) => {
    const args = [secretManagerBootstrap, command];
    if (confirmation) args.push(confirmation);
    const result = await execFileAsync(process.execPath, args, { env: environment });
    return JSON.parse(result.stdout);
  };
  const readState = async () => JSON.parse(await readFile(statePath, "utf8"));
  const writeState = async (state) =>
    writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  try {
    const drifted = structuredClone(initial);
    drifted.providers[gcpPlan.workloadIdentity.kubernetes.provider]
      .attributeCondition += " && false";
    await writeState(drifted);
    await assert.rejects(
      bootstrap("apply", plan.confirmation),
      (error) => {
        assert.match(error.stderr, /P3_SECRET_MANAGER_WIF_PROVIDER_DRIFT/u);
        return true;
      },
    );
    assert.deepEqual((await readState()).history, []);

    const projectWide = structuredClone(initial);
    projectWide.bindings.push({
      resourceType: "project",
      resource: "projects/seorilabs-ci",
      role: "roles/secretmanager.secretAccessor",
      member: "serviceAccount:seori-auth-broker@seorilabs-ci.iam.gserviceaccount.com",
    });
    await writeState(projectWide);
    await assert.rejects(
      bootstrap("apply", plan.confirmation),
      (error) => {
        assert.match(error.stderr, /P3_SECRET_MANAGER_PROJECT_ACCESSOR_PRESENT/u);
        return true;
      },
    );
    assert.deepEqual((await readState()).history, []);

    const crossRole = structuredClone(initial);
    crossRole.bindings.push({
      resourceType: "secret",
      resource: "projects/seorilabs-ci/secrets/seori-auth-canary-password",
      role: "roles/secretmanager.secretAccessor",
      member: "serviceAccount:seori-auth-totp-signer@seorilabs-ci.iam.gserviceaccount.com",
    });
    await writeState(crossRole);
    await assert.rejects(
      bootstrap("apply", plan.confirmation),
      (error) => {
        assert.match(error.stderr, /P3_SECRET_MANAGER_UNEXPECTED_ACCESSOR_PRESENT/u);
        return true;
      },
    );
    assert.deepEqual((await readState()).history, []);

    await writeState(initial);
    const applied = await bootstrap("apply", plan.confirmation);
    assert.equal(applied.ready, true);
    assert.ok(applied.resources.every(({ crossRoleAccessDenied }) => crossRoleAccessDenied));
    assert.equal(applied.canary.state, "BLOCKED_LIVE_RUNTIME");
    const appliedState = await readState();
    const bindingSnapshot = structuredClone(appliedState.bindings);
    assert.equal(
      appliedState.history.filter((item) => item === "iam:add").length,
      4,
    );

    appliedState.history = [];
    const emergencyProjectBinding = {
      resourceType: "project",
      resource: "projects/seorilabs-ci",
      role: "roles/secretmanager.secretAccessor",
      member: "serviceAccount:seori-auth-broker@seorilabs-ci.iam.gserviceaccount.com",
    };
    appliedState.bindings.push(emergencyProjectBinding);
    const rollbackBindingSnapshot = structuredClone(appliedState.bindings);
    const missingDuringRollback = plan.resources[0].secretId;
    const restoredSecret = appliedState.secrets[missingDuringRollback];
    delete appliedState.secrets[missingDuringRollback];
    await writeState(appliedState);
    const rolledBack = await bootstrap("rollback", plan.rollbackConfirmation);
    assert.equal(rolledBack.providerDisabled, true);
    assert.equal(rolledBack.iamBindingsMutated, false);
    const rolledBackState = await readState();
    assert.deepEqual(rolledBackState.bindings, rollbackBindingSnapshot);
    assert.deepEqual(rolledBackState.history, [
      `provider:disable:${gcpPlan.workloadIdentity.kubernetes.provider}`,
    ]);

    rolledBackState.history = [];
    rolledBackState.bindings = rolledBackState.bindings.filter(
      (binding) => JSON.stringify(binding) !== JSON.stringify(emergencyProjectBinding),
    );
    rolledBackState.secrets[missingDuringRollback] = restoredSecret;
    await writeState(rolledBackState);
    const reapplied = await bootstrap("apply", plan.confirmation);
    assert.equal(reapplied.ready, true);
    const reappliedState = await readState();
    assert.deepEqual(reappliedState.bindings, bindingSnapshot);
    assert.deepEqual(reappliedState.history, [
      `provider:enable:${gcpPlan.workloadIdentity.kubernetes.provider}`,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GCP bootstrap은 canonical wrapper override를 검증하고 public 오류 code만 사용한다", async () => {
  const source = await readFile("scripts/fleet/bootstrap-p3-gcp.mjs", "utf8");
  assert.doesNotMatch(source, /\/Users\//u);
  assert.match(source, /homedir\(\)/u);
  assert.match(source, /SEORILABS_GCLOUD_CLI/u);
  assert.match(source, /realpathSync\(gcloud\) !== gcloud/u);
  assert.match(source, /P3_GCP_CONTRACT_PARSE_FAILED/u);
  assert.match(source, /P3_GCP_WIF_PROVIDER_RESPONSE_INVALID/u);
  assert.match(source, /P3_GCP_IAM_RESPONSE_INVALID/u);
  assert.match(source, /git", \["show", executionObject\]/u);
  assert.match(source, /git", \["show", provenanceObject\]/u);
  assert.match(source, /P3_WORKFLOW_SOURCE_DIGEST_MISMATCH/u);
  const contractChecks = await readFile(
    ".github/workflows/contract-checks.yml",
    "utf8",
  );
  const candidate = await readFile(
    ".github/workflows/workflow-bundle-candidate.yml",
    "utf8",
  );
  assert.match(contractChecks, /fetch-depth: 0/u);
  assert.match(candidate, /fetch-depth: 0/u);
  assert.match(source, /if \(discoveryRaw === null\)/u);
  assert.match(source, /if \(raw === null\)/u);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/fleet/bootstrap-p3-gcp.mjs", "readback"],
      { env: { ...process.env, SEORILABS_GCLOUD_CLI: "relative-gcloud" } },
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /P3_GCLOUD_WRAPPER_INVALID/u);
      return true;
    },
  );
});

test("GitHub bootstrap은 renderer의 API version과 organization drift를 fail-closed한다", async () => {
  const source = await readFile(
    "scripts/fleet/bootstrap-p3-github.mjs",
    "utf8",
  );
  assert.match(
    source,
    /app\.apiVersion !== apiVersion \|\| app\.organization !== organization/u,
  );
  assert.match(source, /P3_GITHUB_CONTRACT_DRIFT/u);
  assert.match(source, /P3_GITHUB_API_RESPONSE_INVALID/u);
  assert.match(
    source,
    /if \(operation\.method !== "GET"\) \{\s*fail\("P3_GITHUB_AMBIENT_MUTATION_FORBIDDEN"\);/u,
  );
  assert.match(
    source,
    /function apply\(\) \{\s*fail\("P3_GITHUB_TRUSTED_APP_EXECUTOR_REQUIRED"\);\s*\}/u,
  );
  assert.doesNotMatch(source, /for \(const operation of (?:property|value)Operations\) api/u);
});

test("Auth Broker foundation은 RBAC 0권한, exact NetworkPolicy와 cert-manager TLS만 생성한다", async () => {
  const manifest = await render("auth-broker-foundation");
  const serviceAccounts = manifest.items.filter(
    ({ kind }) => kind === "ServiceAccount",
  );
  const role = manifest.items.find(({ kind }) => kind === "Role");
  const certificates = manifest.items.filter(
    ({ kind }) => kind === "Certificate",
  );
  const publicBindings = manifest.items.find(
    ({ kind, metadata }) =>
      kind === "ConfigMap" &&
      metadata.name.startsWith("auth-broker-public-bindings-"),
  );
  const serialized = JSON.stringify(manifest);
  assert.equal(serviceAccounts.length, 3);
  assert.equal(
    new Set(
      serviceAccounts.map(
        ({ metadata }) =>
          metadata.annotations["seorilabs.io/google-service-account"],
      ),
    ).size,
    3,
  );
  assert.ok(
    serviceAccounts.every(
      ({ automountServiceAccountToken, metadata }) =>
        automountServiceAccountToken === false &&
        metadata.annotations["seorilabs.io/workload-identity-status"] ===
          "planned",
    ),
  );
  assert.deepEqual(role.rules, []);
  assert.equal(certificates.length, 8);
  assert.ok(
    certificates.every(({ spec }) =>
      spec.privateKey?.rotationPolicy === "Always",
    ),
  );
  assert.equal(publicBindings.immutable, true);
  assert.match(
    publicBindings.data["bindings.json"],
    /"mode": "APPLICATION_ENVELOPE"/u,
  );
  assert.match(
    publicBindings.data["bindings.json"],
    /"status": "blocked_unverified"/u,
  );
  assert.match(
    publicBindings.data["bindings.json"],
    /"contentPolicy": "SECRET_FREE_PUBLIC_CONTROL_AND_AUDIT_ONLY"/u,
  );
  assert.match(
    publicBindings.data["bindings.json"],
    /"mode": "PUBLIC"/u,
  );
  assert.match(
    publicBindings.data["bindings.json"],
    /"packageVisibilityStatus": "verified_public"/u,
  );
  assert.doesNotMatch(
    publicBindings.data["bindings.json"],
    /"imagePullSecretName"|"credentialId": "shared\/github\/packages-reader"/u,
  );
  assert.match(
    publicBindings.data["bindings.json"],
    /"operation": "AUTH_BROKER_SECRET_MANAGER_ROLE_BINDING"/u,
  );
  assert.doesNotMatch(serialized, /"kind":"Secret"|"stringData"/u);
  assert.doesNotMatch(serialized, /"kind":"(?:Deployment|StatefulSet|PersistentVolumeClaim)"/u);
  assert.doesNotMatch(serialized, /0\.0\.0\.0\/0|"ipBlock"/u);
});

test("Auth Broker rollback manifest는 namespace를 보존하고 foundation 객체만 겨냥한다", async () => {
  const manifest = await render("auth-broker-foundation-rollback");
  assert.equal(manifest.kind, "List");
  assert.ok(manifest.items.length > 0);
  assert.ok(manifest.items.every(({ kind }) => kind !== "Namespace"));
  assert.ok(
    manifest.items.every(({ metadata }) => metadata.namespace === "auth-broker"),
  );
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /"kind":"(?:Secret|PersistentVolumeClaim|StatefulSet|Deployment)"/u,
  );
});

test("알 수 없는 P3 render 명령은 공개 code만 남기고 실패한다", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [script, "apply"]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /P3_COMMAND_INVALID/u);
      assert.doesNotMatch(error.stderr, /token|password|private.?key/iu);
      return true;
    },
  );
});
