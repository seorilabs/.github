#!/usr/bin/env node

// WorkflowBundle v5 승인 운영 도구. CANDIDATE 번들과 증거를 모아 APPROVED로 승격한다.
//
// 이 파일은 일부러 후보 경로 필터(scripts/fleet/**-v5.mjs) 밖에 둔다. 서명자는 자기가 서명할
// artifact 안에 들어가지 않는다. 도구를 고칠 때마다 새 후보가 생기면 승인이 끝나지 않는다.
//
// plan     증거 식별자와 GitHub artifact readback을 대조한다. 비밀값을 쓰지 않는다.
// sign     native launcher 안에서만 실행한다. 승인 서명키로 APPROVED 번들을 만든다.
// publish  control plane에 APPROVED 번들을 올린다. 서버가 trust ConfigMap으로 다시 검증한다.
// readback 승격 결과를 registry에서 다시 읽는다.
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, sign as signPayload } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";

import { promoteWorkflowBundleV5 } from "../../packages/repo-contract/src/workflow-bundle-v5.mjs";

const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_ROOT = join(homedir(), ".config", "seorilabs");
const APPROVAL_CREDENTIAL_ID = "shared/workflow-bundle/approval-signing";
const OPERATOR_CREDENTIAL_ID = "shared/backoffice/operator";
const CONTROL_PLANE = "https://backoffice.vzyx.xyz";
const PRINCIPAL = "backoffice:fleet-operator";
const REGISTRY_REPOSITORY = "seorilabs/.github";

function stop(code) { throw Object.assign(new Error(code), { code }); }

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

const canonicalJson = (value) => JSON.stringify(canonicalize(value));
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const evidenceIdentity = (record) => `${record.target}:${record.profile ?? record.buildProfile ?? ""}`;

// 증거는 계약 스키마가 정의한 필드만 담는다. build provenance는 release 경로 필드를 더
// 싣고 오는데, 승인 증거 스키마는 additionalProperties를 막으므로 그대로 넣으면 거부된다.
// 필드 목록을 스키마에서 읽어 도구와 계약이 갈라지지 않게 한다.
export function evidenceFieldSets(repoRoot) {
  let schema;
  try {
    schema = JSON.parse(
      readFileSync(resolve(repoRoot, "contracts/workflow-bundle-v5.schema.json"), "utf8"),
    );
  } catch {
    stop("WORKFLOW_BUNDLE_APPROVAL_EVIDENCE_SCHEMA_UNREADABLE");
  }
  const definitions = schema?.$defs ?? {};
  const required = (node) => {
    if (node === null || typeof node !== "object") return [];
    const collected = Array.isArray(node.required) ? [...node.required] : [];
    for (const key of ["allOf", "oneOf", "anyOf"]) {
      for (const child of node[key] ?? []) collected.push(...required(child));
    }
    if (typeof node.$ref === "string") {
      collected.push(...required(definitions[node.$ref.split("/").at(-1)] ?? {}));
    }
    return collected;
  };
  const fields = {
    static: new Set(required(definitions.staticEvidence)),
    build: new Set(required(definitions.buildEvidence)),
  };
  if (fields.static.size === 0 || fields.build.size === 0) {
    stop("WORKFLOW_BUNDLE_APPROVAL_EVIDENCE_SCHEMA_UNREADABLE");
  }
  return fields;
}

export function projectEvidence(record, fields) {
  const allowed = fields[record?.target];
  if (allowed === undefined) stop("WORKFLOW_BUNDLE_APPROVAL_EVIDENCE_TARGET_INVALID");
  const missing = [...allowed].filter((field) => record[field] === undefined);
  if (missing.length > 0) stop("WORKFLOW_BUNDLE_APPROVAL_EVIDENCE_FIELD_MISSING");
  return Object.fromEntries([...allowed].sort().map((field) => [field, record[field]]));
}

function readJsonFile(path) {
  const resolved = resolve(path);
  const state = statSync(resolved, { throwIfNoEntry: false });
  if (!state?.isFile()) stop("WORKFLOW_BUNDLE_APPROVAL_INPUT_MISSING");
  return JSON.parse(readFileSync(resolved, "utf8"));
}

// 카탈로그가 자격증명 위치의 정본이다. 경로나 값은 출력하지 않는다.
function catalogEntry(credentialId) {
  const catalogDirectory = join(CONFIG_ROOT, "catalog");
  for (const name of readdirSync(catalogDirectory).filter((file) => file.endsWith(".yaml"))) {
    const document = parse(readFileSync(join(catalogDirectory, name), "utf8"));
    const entry = (document?.credentials ?? []).find((record) => record.id === credentialId);
    if (entry) return entry;
  }
  return stop("WORKFLOW_BUNDLE_APPROVAL_CREDENTIAL_UNREGISTERED");
}

function credentialPath(entry) {
  const path = entry.path?.startsWith("/") ? entry.path : join(CONFIG_ROOT, entry.path ?? "");
  const state = statSync(path, { throwIfNoEntry: false });
  if (!state?.isFile() || state.uid !== process.getuid() || (state.mode & 0o077) !== 0) {
    stop("WORKFLOW_BUNDLE_APPROVAL_CREDENTIAL_UNSAFE");
  }
  return path;
}

function githubJson(path) {
  return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
}

// 증거는 GitHub이 보관한 artifact에서 다시 읽는다. 로컬 파일을 근거로 삼지 않는다.
function readbackProvenance(record) {
  const run = githubJson(`repos/${record.fullName}/actions/runs/${record.runId}`);
  if (run.status !== "completed" || run.conclusion !== "success") stop("WORKFLOW_BUNDLE_EVIDENCE_RUN_NOT_SUCCEEDED");
  if (run.run_attempt !== record.runAttempt) stop("WORKFLOW_BUNDLE_EVIDENCE_RUN_ATTEMPT_MISMATCH");
  if (String(run.repository?.id) !== String(record.repositoryId)) stop("WORKFLOW_BUNDLE_EVIDENCE_REPOSITORY_MISMATCH");
  const directory = mkdtempSync(join(tmpdir(), "workflow-bundle-evidence-"));
  try {
    execFileSync("gh", ["run", "download", String(record.runId), "-R", record.fullName, "-D", directory], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const found = [];
    const walk = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "provenance.json") found.push(full);
      }
    };
    walk(directory);
    const matched = found
      .map((path) => JSON.parse(readFileSync(path, "utf8")))
      .filter((provenance) => evidenceIdentity(provenance) === evidenceIdentity(record));
    if (matched.length !== 1) stop("WORKFLOW_BUNDLE_EVIDENCE_ARTIFACT_AMBIGUOUS");
    return matched[0];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function trustedEvidenceVerifier(record) {
  const provenance = readbackProvenance(record);
  return {
    ...provenance,
    state: "VERIFIED",
    identity: evidenceIdentity(record),
    evidenceDigest: sha256(canonicalJson(record)),
  };
}

function trustedApprovalSigner(request) {
  if (request.algorithm !== "Ed25519" || request.credentialId !== APPROVAL_CREDENTIAL_ID
    || request.keyPurpose !== "WORKFLOW_BUNDLE_V5_APPROVAL") {
    stop("WORKFLOW_BUNDLE_APPROVAL_SIGNER_REQUEST_INVALID");
  }
  const entry = catalogEntry(APPROVAL_CREDENTIAL_ID);
  if (entry.status !== "active" || !entry.public?.keyId || !entry.public?.policyRevision) {
    stop("WORKFLOW_BUNDLE_APPROVAL_KEY_NOT_ACTIVE");
  }
  const material = readFileSync(credentialPath(entry));
  try {
    const value = signPayload(null, request.payload, createPrivateKey(material)).toString("base64url");
    if (value.length !== 86) stop("WORKFLOW_BUNDLE_APPROVAL_SIGNATURE_INVALID");
    return { algorithm: "Ed25519", keyId: entry.public.keyId, policyRevision: entry.public.policyRevision, value };
  } finally {
    material.fill(0);
  }
}

function operatorHeaders() {
  const path = credentialPath(catalogEntry(OPERATOR_CREDENTIAL_ID));
  const contents = readFileSync(path, "utf8");
  const match = /^(?:export\s+)?INTERNAL_ADMIN_TOKEN=(.+)$/mu.exec(contents);
  const token = match?.[1]?.trim().replace(/^['"]|['"]$/gu, "");
  if (!token) stop("WORKFLOW_BUNDLE_APPROVAL_OPERATOR_TOKEN_MISSING");
  return {
    Authorization: `Bearer ${token}`,
    "X-Seori-Principal": PRINCIPAL,
    "Content-Type": "application/json",
  };
}

async function controlPlane(method, path, body) {
  const headers = operatorHeaders();
  const response = await fetch(`${CONTROL_PLANE}${path}`, {
    method,
    headers: method === "POST" ? { ...headers, "Idempotency-Key": randomUUID() } : headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

function loadInputs({ candidate, evidence, repoRoot = TOOL_ROOT }) {
  if (!candidate || !evidence) stop("WORKFLOW_BUNDLE_APPROVAL_ARGUMENT_INVALID");
  const bundle = readJsonFile(candidate);
  const raw = evidence.split(",").filter(Boolean).map((path) => readJsonFile(path));
  const identities = raw.map(evidenceIdentity).sort();
  if (new Set(identities).size !== identities.length) stop("WORKFLOW_BUNDLE_APPROVAL_EVIDENCE_DUPLICATE");
  const fields = evidenceFieldSets(repoRoot);
  const records = raw.map((record) => projectEvidence(record, fields));
  return { bundle, records, identities };
}

export async function planWorkflowBundleApproval({ candidate, evidence, repoRoot }) {
  const { bundle, records, identities } = loadInputs({ candidate, evidence, repoRoot });
  const checked = records.map((record) => {
    const readback = trustedEvidenceVerifier(record);
    const mismatched = Object.keys(record).filter((field) => readback[field] !== record[field]);
    return {
      identity: evidenceIdentity(record),
      runUrl: `https://github.com/${record.fullName}/actions/runs/${record.runId}`,
      configRevision: record.configRevision,
      artifactSha256: record.artifactSha256,
      readback: mismatched.length === 0 ? "MATCHED" : "MISMATCHED",
      mismatched,
    };
  });
  return {
    state: checked.every((entry) => entry.readback === "MATCHED") ? "READY" : "MISMATCHED",
    subject: `workflow-bundle-v5:${bundle.source?.sha}`,
    candidateDigest: bundle.integrity?.payloadDigest,
    identities,
    evidence: checked,
  };
}

export async function signWorkflowBundleApproval({ candidate, evidence, repoRoot, out }) {
  if (process.env.SEORI_AUTH_NATIVE_LAUNCHED !== "1") stop("WORKFLOW_BUNDLE_APPROVAL_NATIVE_LAUNCH_REQUIRED");
  const root = resolve(repoRoot ?? TOOL_ROOT);
  const { bundle, records } = loadInputs({ candidate, evidence, repoRoot: root });
  // 번들이 선언한 runtime asset은 그 SHA의 작업본에서만 그대로 읽힌다.
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== bundle.source?.sha) stop("WORKFLOW_BUNDLE_APPROVAL_REPO_ROOT_MISMATCH");
  const approved = await promoteWorkflowBundleV5(bundle, records, {
    trustedEvidenceVerifier,
    trustedApprovalSigner,
    repoRoot: root,
  });
  if (!out) stop("WORKFLOW_BUNDLE_APPROVAL_ARGUMENT_INVALID");
  writeFileSync(resolve(out), `${JSON.stringify(approved, null, 2)}\n`, { mode: 0o600 });
  return {
    state: "SIGNED",
    subject: `workflow-bundle-v5:${approved.source.sha}`,
    payloadDigest: approved.integrity.payloadDigest,
    approvalKeyId: approved.approval.signature.keyId,
    policyRevision: approved.approval.signature.policyRevision,
    evidence: approved.approval.evidence.map(evidenceIdentity).sort(),
    out: resolve(out),
  };
}

export async function publishWorkflowBundleApproval({ bundle }) {
  if (!bundle) stop("WORKFLOW_BUNDLE_APPROVAL_ARGUMENT_INVALID");
  const approved = readJsonFile(bundle);
  if (approved?.approval?.state !== "APPROVED") stop("WORKFLOW_BUNDLE_APPROVAL_BUNDLE_NOT_APPROVED");
  const result = await controlPlane("POST", "/api/control-plane/workflow-bundles", {
    mode: "APPROVED",
    bundle: approved,
  });
  if (![200, 201].includes(result.status)) {
    return { state: "DENIED", status: result.status, code: result.body?.code ?? result.body?.error ?? null };
  }
  return {
    state: "PUBLISHED",
    status: result.status,
    duplicate: result.body?.duplicate ?? null,
    record: result.body?.record ?? null,
  };
}

export async function readbackWorkflowBundleApproval({ sourceSha }) {
  if (!/^[0-9a-f]{40}$/u.test(sourceSha ?? "")) stop("WORKFLOW_BUNDLE_APPROVAL_ARGUMENT_INVALID");
  const result = await controlPlane("GET", `/api/control-plane/workflow-bundles?sourceSha=${sourceSha}`);
  const records = Array.isArray(result.body?.records) ? result.body.records : [];
  const approved = records.find((record) => record.approvalState === "APPROVED") ?? null;
  return {
    state: approved ? "APPROVED" : "NOT_APPROVED",
    status: result.status,
    repository: REGISTRY_REPOSITORY,
    sourceSha,
    approvalKeyId: approved?.approvalKeyId ?? null,
    approvalPayloadDigest: approved?.approvalPayloadDigest ?? null,
    payloadDigest: approved?.payloadDigest ?? null,
  };
}

const MODES = {
  plan: planWorkflowBundleApproval,
  sign: signWorkflowBundleApproval,
  publish: publishWorkflowBundleApproval,
  readback: readbackWorkflowBundleApproval,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode = "plan", ...args] = process.argv.slice(2);
    if (!Object.hasOwn(MODES, mode)) stop("WORKFLOW_BUNDLE_APPROVAL_OPERATION_INVALID");
    const options = Object.fromEntries(args.map((arg) => {
      const match = /^--(candidate|evidence|repo-root|out|bundle|source-sha)=(.+)$/u.exec(arg);
      if (!match) stop("WORKFLOW_BUNDLE_APPROVAL_ARGUMENT_INVALID");
      return [match[1].replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase()), match[2]];
    }));
    console.log(JSON.stringify(await MODES[mode](options), null, 2));
  } catch (error) {
    const code = /^WORKFLOW_BUNDLE_[A-Z_]+$/u.test(error?.code ?? "") ? error.code : "WORKFLOW_BUNDLE_APPROVAL_OPERATION_FAILED";
    console.error(JSON.stringify({ state: "DENIED", code, detail: error?.message ?? null }));
    process.exitCode = 1;
  }
}
