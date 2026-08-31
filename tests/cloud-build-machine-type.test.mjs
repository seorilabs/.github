import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { collectCloudBuildMachineTypeDiagnostics } from "../packages/repo-contract/src/index.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");

async function makeRepo(files) {
  const root = await mkdtemp(resolve(tmpdir(), "cloudbuild-contract-"));
  for (const [path, body] of Object.entries(files)) {
    const absolute = resolve(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, body, "utf8");
  }
  return root;
}

test("machineType 을 생략하면 진단을 만든다", async () => {
  const root = await makeRepo({
    "cloudbuild-android.yaml": "steps: []\noptions:\n  logging: CLOUD_LOGGING_ONLY\n",
  });
  const diagnostics = await collectCloudBuildMachineTypeDiagnostics(root);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "CLOUD_BUILD_MACHINE_TYPE");
  assert.equal(diagnostics[0].path, "$.options.machineType");
  assert.match(diagnostics[0].message, /현재 값 생략됨/);
});

test("E2_STANDARD_2 는 통과한다", async () => {
  const root = await makeRepo({
    "cloudbuild-android.yaml": "steps: []\noptions:\n  machineType: E2_STANDARD_2\n",
  });
  assert.deepEqual(await collectCloudBuildMachineTypeDiagnostics(root), []);
});

test("과금 대상 machineType 은 진단을 만든다", async () => {
  const root = await makeRepo({
    "cloudbuild-android.yaml": "steps: []\noptions:\n  machineType: E2_HIGHCPU_8\n",
    "builders/rn-android/build.cloudbuild.yaml":
      "steps: []\noptions:\n  machineType: N1_HIGHCPU_32\n",
  });
  const diagnostics = await collectCloudBuildMachineTypeDiagnostics(root);
  assert.equal(diagnostics.length, 2);
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.code, "CLOUD_BUILD_MACHINE_TYPE");
    assert.equal(diagnostic.path, "$.options.machineType");
  }
  assert.deepEqual(
    diagnostics.map((d) => d.document).sort(),
    ["builders/rn-android/build.cloudbuild.yaml", "cloudbuild-android.yaml"],
  );
});

test("node_modules 는 검사하지 않는다", async () => {
  const root = await makeRepo({
    "node_modules/pkg/cloudbuild.yaml": "options:\n  machineType: E2_HIGHCPU_32\n",
  });
  assert.deepEqual(await collectCloudBuildMachineTypeDiagnostics(root), []);
});

test("이 저장소의 Cloud Build 설정은 모두 규칙을 지킨다", async () => {
  const diagnostics = await collectCloudBuildMachineTypeDiagnostics(REPO_ROOT);
  assert.deepEqual(diagnostics, []);
});
