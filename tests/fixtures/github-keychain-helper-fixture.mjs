#!/usr/bin/env node

import { createHash } from "node:crypto";
import { basename } from "node:path";

const identifier = "com.seorilabs.fleet.github-keychain-helper";
const teamIdentifier = "SEORIFIX01";
const targets = [
  {
    credentialId: "shared/github/backoffice-app-private-key",
    service: "com.seorilabs.github.backoffice-app-private-key",
  },
  {
    credentialId: "shared/github/backoffice-app-webhook",
    service: "com.seorilabs.github.backoffice-app-webhook",
  },
];

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function emit(value, status = 0) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(status);
}

async function readFrame(expectedOperation) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  for (const chunk of chunks) chunk.fill(0);
  let offset = 0;
  function read(length) {
    if (offset + length > bytes.length) throw new Error("fixture frame invalid");
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  }
  if (
    read(8).toString("ascii") !== "SEORIKC1" || read(1)[0] !== 1 ||
    read(1)[0] !== expectedOperation || read(1)[0] !== 2 || read(1)[0] !== 0
  ) {
    throw new Error("fixture frame invalid");
  }
  for (const target of targets) {
    const credentialLength = read(2).readUInt16BE();
    const serviceLength = read(2).readUInt16BE();
    const secretLength = read(4).readUInt32BE();
    if (
      read(credentialLength).toString("utf8") !== target.credentialId ||
      read(serviceLength).toString("utf8") !== target.service ||
      (expectedOperation === 1 ? secretLength === 0 : secretLength !== 0)
    ) {
      throw new Error("fixture target invalid");
    }
    read(secretLength);
  }
  if (offset !== bytes.length) throw new Error("fixture frame invalid");
  bytes.fill(0);
}

const command = process.argv[2];
if (command === "attest") {
  const requirement = `identifier "${identifier}" and anchor apple generic and certificate leaf[subject.OU] = "${teamIdentifier}"`;
  emit({
    schemaVersion: 1,
    state: "VERIFIED",
    helper: "seorilabs-github-keychain",
    codeIdentity: {
      identifier,
      teamIdentifier,
      designatedRequirementSha256: digest(Buffer.from(requirement, "utf8")),
      signed: true,
      adHoc: false,
    },
    policy: {
      protocol: "binary-stdin-v1",
      targetSetSha256: digest(Buffer.from(
        targets.map(({ credentialId, service }) => `${credentialId}\0${service}`).join("\0"),
        "utf8",
      )),
      unattendedAcl: "self-designated-requirement-no-prompt-v1",
      authenticationUI: "fail",
    },
  });
}

const operation = new Map([
  ["preflight", [0, "PREFLIGHT"]],
  ["write-batch", [1, "WRITE_BATCH"]],
  ["remove-batch", [2, "REMOVE_BATCH"]],
]).get(command);
if (!operation) process.exit(64);

await readFrame(operation[0]);
if (basename(process.argv[1]).includes("compensation-failed") && command === "write-batch") {
  emit({
    schemaVersion: 1,
    state: "DENIED",
    operation: "WRITE-BATCH",
    code: "BATCH_COMPENSATION_FAILED",
    compensation: { required: true, verified: false },
  }, 70);
}
emit({
  schemaVersion: 1,
  state: "VERIFIED",
  operation: operation[1],
  targets: targets.map((target) => ({ ...target, state: "VERIFIED" })),
  readback: { unattendedAclExact: true, withoutPrompt: true },
  compensation: { required: command === "remove-batch", verified: true },
});
