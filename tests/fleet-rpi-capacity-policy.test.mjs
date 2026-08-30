import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { parse, stringify } from "yaml";

const execFileAsync = promisify(execFile);
const verifier = fileURLToPath(
  new URL("../scripts/fleet/verify-rpi-capacity-policy.mjs", import.meta.url),
);
const kubectlMock = fileURLToPath(
  new URL("./fixtures/rpi-capacity-kubectl-mock.mjs", import.meta.url),
);
const contract = parse(
  await readFile("contracts/fleet-rpi-capacity-policy.yaml", "utf8"),
);
const schema = JSON.parse(
  await readFile("contracts/fleet-rpi-capacity-policy.schema.json", "utf8"),
);

const arcSelector = {
  "kubernetes.io/hostname": "rpi5",
  "kubernetes.io/os": "linux",
  "kubernetes.io/arch": "arm64",
};
const x64Selector = {
  "kubernetes.io/hostname": "seori-m6-01",
  "kubernetes.io/os": "linux",
  "kubernetes.io/arch": "amd64",
};
const x64Toleration = [
  { key: "workload", operator: "Equal", value: "ci", effect: "NoSchedule" },
];

function globalVersions() {
  return {
    version: 1,
    cluster: { context: "vzyx-cluster" },
    runners: {
      general: {
        scale_set_name: "seorilabs-rpi-arm64",
        values_file: "github-actions-runners/rpi-arm64-values.yaml",
        node: "rpi5",
        min_runners: 1,
        max_runners: 3,
      },
      dind: {
        scale_set_name: "seorilabs-rpi-arm64-dind",
        values_file: "github-actions-runners/rpi-arm64-dind-values.yaml",
        node: "rpi5",
        min_runners: 0,
        max_runners: 1,
      },
    },
  };
}

function scaleSetValues(
  name,
  minRunners,
  maxRunners,
  { nodeSelector = arcSelector, tolerations = [] } = {},
) {
  return {
    runnerScaleSetName: name,
    minRunners,
    maxRunners,
    listenerTemplate: { spec: { nodeSelector: { ...arcSelector } } },
    template: { spec: { nodeSelector: { ...nodeSelector }, tolerations } },
  };
}

async function fixtureWorkspace({ generalMax = 3, generalNode = "rpi5" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "fleet-rpi-capacity-"));
  const configRoot = join(root, "github-actions-runners");
  await mkdir(configRoot);
  const global = globalVersions();
  global.runners.general.max_runners = generalMax;
  global.runners.general.node = generalNode;
  const general = scaleSetValues("seorilabs-rpi-arm64", 1, generalMax);
  if (generalNode !== "rpi5") {
    general.listenerTemplate.spec.nodeSelector["kubernetes.io/hostname"] =
      generalNode;
    general.template.spec.nodeSelector["kubernetes.io/hostname"] = generalNode;
  }
  await Promise.all([
    writeFile(join(configRoot, "global-versions.yaml"), stringify(global)),
    writeFile(
      join(configRoot, "arc-controller-values.yaml"),
      stringify({ nodeSelector: { ...arcSelector } }),
    ),
    writeFile(join(configRoot, "rpi-arm64-values.yaml"), stringify(general)),
    writeFile(
      join(configRoot, "rpi-arm64-dind-values.yaml"),
      stringify(
        scaleSetValues("seorilabs-rpi-arm64-dind", 0, 1),
      ),
    ),
    writeFile(
      join(configRoot, "x64-values.yaml"),
      stringify(
        scaleSetValues("seorilabs-x64", 1, 6, {
          nodeSelector: x64Selector,
          tolerations: x64Toleration,
        }),
      ),
    ),
    writeFile(
      join(configRoot, "x64-android-values.yaml"),
      stringify(
        scaleSetValues("seorilabs-x64-android", 0, 1, {
          nodeSelector: x64Selector,
          tolerations: x64Toleration,
        }),
      ),
    ),
  ]);
  return realpath(root);
}

async function verify(mode, root, scenario = "healthy", log = undefined) {
  return execFileAsync(process.execPath, [verifier, mode], {
    env: {
      ...process.env,
      SEORILABS_ARC_WORKSPACE: root,
      SEORILABS_KUBECTL: kubectlMock,
      SEORILABS_RPI_CAPACITY_MOCK_SCENARIO: scenario,
      ...(log === undefined ? {} : { SEORILABS_RPI_CAPACITY_MOCK_LOG: log }),
    },
  });
}

test("RPI capacity contract는 exact node, 보존 controller와 ARC 상한을 strict schema로 고정한다", () => {
  const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(
    schema,
  );
  assert.equal(validate(contract), true, JSON.stringify(validate.errors));
  assert.equal(contract.schemaVersion, 3);
  assert.equal(contract.cluster.nodes.quarantined.hostname, "rpi4001");
  assert.equal(contract.cluster.nodes.workload.hostname, "rpi5");
  assert.equal(contract.cluster.nodes.x64.hostname, "seori-m6-01");
  assert.deepEqual(
    contract.cluster.nodes.quarantined.allowedPreservedControllers.map(
      ({ namespace, kind, name, replicas }) => ({
        namespace,
        kind,
        name,
        replicas,
      }),
    ),
    [
      {
        namespace: "container-registry",
        kind: "Deployment",
        name: "registry",
        replicas: 1,
      },
    ],
  );
  assert.deepEqual(
    contract.workloads.arc.scaleSets.map(
      ({ name, minRunners, maxRunners }) => ({
        name,
        minRunners,
        maxRunners,
      }),
    ),
    [
      { name: "seorilabs-rpi-arm64", minRunners: 1, maxRunners: 3 },
      { name: "seorilabs-rpi-arm64-dind", minRunners: 0, maxRunners: 1 },
      { name: "seorilabs-x64", minRunners: 1, maxRunners: 6 },
      { name: "seorilabs-x64-android", minRunners: 0, maxRunners: 1 },
    ],
  );
  assert.equal(contract.observation.minimumHours, 24);
  assert.equal(contract.rollback.gate.automaticRetry, false);
});

test("운영 복제본은 exact RPI5 selector와 일반 1/3, DIND 0/1일 때만 통과한다", async () => {
  const root = await fixtureWorkspace();
  try {
    const result = await verify("files", `${root}/`);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.policyVersion, 3);
    assert.equal(output.workloadNode, "rpi5");
    assert.deepEqual(output.arc, [
      { name: "seorilabs-rpi-arm64", minRunners: 1, maxRunners: 3 },
      { name: "seorilabs-rpi-arm64-dind", minRunners: 0, maxRunners: 1 },
      { name: "seorilabs-x64", minRunners: 1, maxRunners: 6 },
      { name: "seorilabs-x64-android", minRunners: 0, maxRunners: 1 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("운영 복제본의 ARC 상한 초과와 RPI4 selector는 fail-closed된다", async () => {
  for (const fixture of [{ generalMax: 4 }, { generalNode: "rpi4001" }]) {
    const root = await fixtureWorkspace(fixture);
    try {
      await assert.rejects(verify("files", root), (error) => {
        assert.equal(error.code, 1);
        assert.match(
          error.stderr,
          /RPI_CAPACITY_(?:GLOBAL_CONFIG|ARC_VALUES)_DRIFT/u,
        );
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("live readback은 mutation 없이 cordon, selector, ARC와 메모리 evidence를 검증한다", async () => {
  const root = await fixtureWorkspace();
  const log = join(root, "kubectl.log");
  try {
    const result = await verify("readback", root, "healthy", log);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.policyVersion, 3);
    assert.equal(output.evidence.rpi4NodeWorkingSetMi, 4565);
    assert.equal(output.evidence.rpi4RunningPodWorkingSetMi, 534);
    assert.equal(output.evidence.rpi5NodeWorkingSetMi, 3235);
    assert.equal(output.evidence.authBrokerState, "not_deployed");
    assert.deepEqual(output.evidence.preservedControllers, [
      "container-registry/Deployment/registry",
    ]);
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(calls.length > 0);
    assert.ok(calls.every(([verb]) => verb === "config" || verb === "get"));
    assert.doesNotMatch(
      JSON.stringify(calls),
      /apply|patch|cordon|uncordon|taint|delete/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("24시간 미만 관찰, ARC 실동작 초과와 RPI4 신규 Pod를 거부한다", async () => {
  const cases = [
    ["incomplete-window", "RPI_CAPACITY_OBSERVATION_WINDOW_INCOMPLETE"],
    ["rpi4-schedulable", "RPI_CAPACITY_RPI4_QUARANTINE_DRIFT"],
    ["x64-node-drift", "RPI_CAPACITY_X64_NODE_DRIFT"],
    ["arc-over-capacity", "RPI_CAPACITY_ARC_LIVE_DRIFT"],
    ["arc-under-capacity", "RPI_CAPACITY_ARC_LIVE_DRIFT"],
    ["unmanaged-arc", "RPI_CAPACITY_ARC_LIVE_DRIFT"],
    ["placement-drift", "RPI_CAPACITY_WORKLOAD_PLACEMENT_DRIFT"],
    ["placement-drift-offset", "RPI_CAPACITY_WORKLOAD_PLACEMENT_DRIFT"],
    ["unlabeled-x64-runner", "RPI_CAPACITY_WORKLOAD_PLACEMENT_DRIFT"],
    ["invalid-pod-timestamp", "RPI_CAPACITY_POD_TIMESTAMP_INVALID"],
  ];
  for (const [scenario, code] of cases) {
    const root = await fixtureWorkspace();
    try {
      await assert.rejects(verify("readback", root, scenario), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, new RegExp(code, "u"));
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Auth Broker selector drift와 OOM evidence는 live gate를 닫지 못한다", async () => {
  const cases = [
    ["auth-drift", "RPI_CAPACITY_AUTH_BROKER_LIVE_DRIFT"],
    ["oom", "RPI_CAPACITY_MEMORY_EVENT_DETECTED"],
    ["oom-event", "RPI_CAPACITY_MEMORY_EVENT_DETECTED"],
  ];
  for (const [scenario, code] of cases) {
    const root = await fixtureWorkspace();
    try {
      await assert.rejects(verify("readback", root, scenario), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, new RegExp(code, "u"));
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("RPI4 보존 예외는 exact registry controller와 owner chain만 허용한다", async () => {
  const cases = [
    ["preserved-controller-drift", "RPI_CAPACITY_PRESERVED_CONTROLLER_DRIFT"],
    ["preserved-owner-drift", "RPI_CAPACITY_WORKLOAD_PLACEMENT_DRIFT"],
  ];
  for (const [scenario, code] of cases) {
    const root = await fixtureWorkspace();
    try {
      await assert.rejects(verify("readback", root, scenario), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, new RegExp(code, "u"));
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
