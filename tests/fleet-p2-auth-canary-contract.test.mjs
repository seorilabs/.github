import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";

import {
  APPROVED_IMAGE_BINDING,
  canonicalSha256,
} from "../tools/seori-auth/scripts/public-image-binding.mjs";

const execFileAsync = promisify(execFile);
const contract = parse(await readFile("contracts/fleet-p3-runtime.yaml", "utf8"));
const schema = JSON.parse(await readFile("contracts/fleet-p3-runtime.schema.json", "utf8"));

function validator() {
  return new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
}

test("Auth Broker registry mode는 PUBLIC 또는 canonical PACKAGES_READER만 허용한다", () => {
  const validate = validator();
  assert.equal(validate(contract), true, JSON.stringify(validate.errors));
  assert.equal(contract.authBroker.registry.mode, "PUBLIC");
  assert.equal(contract.authBroker.registry.packageVisibilityStatus, "verified_public");
  assert.equal(Object.hasOwn(contract.authBroker.registry, "credentialId"), false);

  const implicit = structuredClone(contract);
  delete implicit.authBroker.registry.mode;
  assert.equal(validate(implicit), false);

  const packagesReaderContract = structuredClone(contract);
  packagesReaderContract.authBroker.registry = {
    mode: "PACKAGES_READER",
    server: "ghcr.io",
    repository: "ghcr.io/seorilabs/seori-auth",
    packageVersionTag: packagesReaderContract.authBroker.imageProvenance.sourceSha,
    imagePullSecretName: "seori-auth-ghcr-pull",
    credentialId: "shared/github/packages-reader",
    credentialKind: "github-pat-classic",
    identityRequirement: "organization-machine-user",
    personalOperatorReuseAllowed: false,
    publicPackageAlternativeAllowed: true,
    requiredScopes: ["read:packages"],
    catalogStatus: "active",
    kubernetesStatus: "verified",
    humanGate: packagesReaderContract.authBroker.registry.humanGate,
  };
  assert.equal(validate(packagesReaderContract), true, JSON.stringify(validate.errors));

  packagesReaderContract.authBroker.registry.credentialId = "shared/github/other-reader";
  assert.equal(validate(packagesReaderContract), false);
});

test("approved image와 source provenance는 immutable public binding 하나로 고정된다", async () => {
  assert.equal(contract.authBroker.image, APPROVED_IMAGE_BINDING.image);
  assert.deepEqual(
    contract.authBroker.imageProvenance,
    APPROVED_IMAGE_BINDING.imageProvenance,
  );
  const result = await execFileAsync(process.execPath, [
    "scripts/fleet/render-p3-runtime.mjs",
    "auth-broker-foundation",
  ]);
  assert.equal(result.stderr, "");
  const manifest = JSON.parse(result.stdout);
  const binding = manifest.items.find(
    ({ kind, metadata }) =>
      kind === "ConfigMap" && metadata.name.startsWith("auth-broker-public-bindings-"),
  );
  const payload = JSON.parse(binding.data["bindings.json"]);
  const { bindingSha256, ...boundContract } = payload;

  assert.equal(binding.immutable, true);
  assert.match(bindingSha256, /^[a-f0-9]{64}$/u);
  assert.equal(canonicalSha256(boundContract), bindingSha256);
  assert.equal(binding.metadata.name, `auth-broker-public-bindings-${bindingSha256.slice(0, 12)}`);
  assert.equal(binding.metadata.annotations["seorilabs.io/binding-sha256"], bindingSha256);
  assert.equal(
    binding.metadata.annotations["seorilabs.io/image-digest"],
    contract.authBroker.imageProvenance.imageDigest,
  );
  assert.equal(
    binding.metadata.annotations["seorilabs.io/image-source-sha"],
    contract.authBroker.imageProvenance.sourceSha,
  );
  assert.equal(
    boundContract.image,
    `${boundContract.registry.repository}@${boundContract.imageProvenance.imageDigest}`,
  );
  assert.equal(
    boundContract.registry.packageVersionTag,
    boundContract.imageProvenance.sourceSha,
  );
  assert.equal(
    canonicalSha256({ z: 1, A: 2, a: { y: 3, B: 4 } }),
    "904c4fcf5a97dc191ba5801fbfa6fb5cffdf67054b99bb4fb40044f24bd9b2af",
  );

  const validate = validator();
  for (const mutate of [
    (changed) => { changed.authBroker.imageProvenance.sourceSha = "c".repeat(40); },
    (changed) => { changed.authBroker.imageProvenance.runId += 1; },
    (changed) => {
      changed.authBroker.imageProvenance.imageDigest = `sha256:${"d".repeat(64)}`;
    },
    (changed) => { changed.authBroker.imageProvenance.workflow = ".github/workflows/other.yml"; },
    (changed) => { changed.authBroker.imageProvenance.platform = "linux/amd64"; },
    (changed) => { changed.authBroker.image = `ghcr.io/seorilabs/seori-auth@sha256:${"e".repeat(64)}`; },
  ]) {
    const changed = structuredClone(contract);
    mutate(changed);
    assert.equal(validate(changed), false);
  }
});

test("non-secret canary 계약은 RPI5, exact output hash와 readback-only marker를 고정한다", () => {
  const canary = contract.authBroker.canary;
  assert.equal(canary.kind, "NON_SECRET_BUILTIN");
  assert.equal(canary.kubernetesContext, "vzyx-cluster");
  assert.equal(canary.serviceAccountName, "seori-auth-canary");
  assert.equal(canary.createPolicy, "SERVER_DRY_RUN_THEN_CREATE_IF_ABSENT");
  assert.equal(canary.publicPullBinding, "NO_IMAGE_PULL_SECRETS");
  assert.equal(canary.packagesReaderPullBinding, "EXACT_CANONICAL_ONE");
  assert.deepEqual(canary.nodeSelector, { "kubernetes.io/hostname": "rpi5" });
  assert.equal(
    canary.expectedOutputSha256,
    "db69575cac8240a6fb6946f05c32a1ad59d6b58b430b62d99fa2dfa1cea05591",
  );
  assert.deepEqual(canary.idempotency, {
    markerKind: "Job",
    key: "image-source-contract-sha256",
    existingPolicy: "READBACK_ONLY",
    unknownOutcomePolicy: "READBACK_FIRST",
  });
});
