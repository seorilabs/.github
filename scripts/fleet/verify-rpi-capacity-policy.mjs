#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const contractPath = join(
  repositoryRoot,
  "contracts/fleet-rpi-capacity-policy.yaml",
);
const schemaPath = join(
  repositoryRoot,
  "contracts/fleet-rpi-capacity-policy.schema.json",
);
const workspace =
  process.env.SEORILABS_ARC_WORKSPACE ?? join(homedir(), "Workspace/kubectl");
const kubectl = process.env.SEORILABS_KUBECTL ?? "kubectl";
const mode = process.argv[2];

function fail(code, details = undefined) {
  process.stderr.write(
    `${JSON.stringify({ ok: false, code, ...(details ?? {}) })}\n`,
  );
  process.exit(1);
}

if (!new Set(["files", "readback"]).has(mode) || process.argv.length !== 3) {
  fail("RPI_CAPACITY_COMMAND_INVALID");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function loadYaml(path, code) {
  try {
    const entry = lstatSync(path);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      realpathSync(path) !== path
    ) {
      fail(code);
    }
    return parse(readFileSync(path, "utf8"));
  } catch {
    fail(code);
  }
}

let contract;
try {
  contract = parse(readFileSync(contractPath, "utf8"));
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const validate = new Ajv2020({
    strict: true,
    validateFormats: false,
  }).compile(schema);
  if (!validate(contract)) fail("RPI_CAPACITY_CONTRACT_DRIFT");
} catch {
  fail("RPI_CAPACITY_CONTRACT_PARSE_FAILED");
}

function canonicalWorkspace() {
  try {
    const normalized = resolve(workspace);
    const entry = lstatSync(normalized);
    if (
      !isAbsolute(workspace) ||
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      realpathSync(normalized) !== normalized
    ) {
      fail("RPI_CAPACITY_WORKSPACE_INVALID");
    }
    return normalized;
  } catch {
    fail("RPI_CAPACITY_WORKSPACE_INVALID");
  }
}

function workspaceFile(root, ...segments) {
  const path = resolve(root, ...segments);
  const pathRelative = relative(root, path);
  if (
    pathRelative === "" ||
    pathRelative === ".." ||
    pathRelative.startsWith(`..${sep}`) ||
    isAbsolute(pathRelative)
  ) {
    fail("RPI_CAPACITY_WORKSPACE_PATH_INVALID");
  }
  return path;
}

function validateFiles() {
  const root = canonicalWorkspace();
  const arc = contract.workloads.arc;
  const configRoot = workspaceFile(root, arc.configRoot);
  const global = loadYaml(
    workspaceFile(configRoot, "global-versions.yaml"),
    "RPI_CAPACITY_GLOBAL_CONFIG_INVALID",
  );
  const expectedScaleSets = Object.fromEntries(
    arc.scaleSets.map((scaleSet) => [scaleSet.class, scaleSet]),
  );
  if (
    global?.cluster?.context !== contract.cluster.context ||
    !same(
      {
        scaleSetName: global?.runners?.general?.scale_set_name,
        valuesFile: global?.runners?.general?.values_file,
        node: global?.runners?.general?.node,
        minRunners: global?.runners?.general?.min_runners,
        maxRunners: global?.runners?.general?.max_runners,
      },
      {
        scaleSetName: expectedScaleSets.general.name,
        valuesFile: `${arc.configRoot}/${expectedScaleSets.general.valuesFile}`,
        node: contract.cluster.nodes.workload.hostname,
        minRunners: expectedScaleSets.general.minRunners,
        maxRunners: expectedScaleSets.general.maxRunners,
      },
    ) ||
    !same(
      {
        scaleSetName: global?.runners?.dind?.scale_set_name,
        valuesFile: global?.runners?.dind?.values_file,
        node: global?.runners?.dind?.node,
        minRunners: global?.runners?.dind?.min_runners,
        maxRunners: global?.runners?.dind?.max_runners,
      },
      {
        scaleSetName: expectedScaleSets.dind.name,
        valuesFile: `${arc.configRoot}/${expectedScaleSets.dind.valuesFile}`,
        node: contract.cluster.nodes.workload.hostname,
        minRunners: expectedScaleSets.dind.minRunners,
        maxRunners: expectedScaleSets.dind.maxRunners,
      },
    )
  ) {
    fail("RPI_CAPACITY_GLOBAL_CONFIG_DRIFT");
  }

  const controllerValues = loadYaml(
    workspaceFile(configRoot, arc.controller.valuesFile),
    "RPI_CAPACITY_ARC_CONTROLLER_VALUES_INVALID",
  );
  if (!same(controllerValues?.nodeSelector, arc.controller.nodeSelector)) {
    fail("RPI_CAPACITY_ARC_CONTROLLER_VALUES_DRIFT");
  }

  for (const scaleSet of arc.scaleSets) {
    const values = loadYaml(
      workspaceFile(configRoot, scaleSet.valuesFile),
      "RPI_CAPACITY_ARC_VALUES_INVALID",
    );
    if (
      values?.runnerScaleSetName !== scaleSet.name ||
      values?.minRunners !== scaleSet.minRunners ||
      values?.maxRunners !== scaleSet.maxRunners ||
      !same(
        values?.listenerTemplate?.spec?.nodeSelector,
        scaleSet.nodeSelector,
      ) ||
      !same(values?.template?.spec?.nodeSelector, scaleSet.nodeSelector)
    ) {
      fail("RPI_CAPACITY_ARC_VALUES_DRIFT");
    }
  }
  return { root, global };
}

function runKubectl(args, code) {
  try {
    return execFileSync(kubectl, args, {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    fail(code);
  }
}

function kubectlJson(args, code) {
  try {
    return JSON.parse(runKubectl(args, code));
  } catch {
    fail(code);
  }
}

function condition(node, type) {
  return node?.status?.conditions?.find((entry) => entry.type === type)?.status;
}

function nodeByName(nodes, name) {
  return nodes?.items?.find((node) => node?.metadata?.name === name);
}

function podTemplateSelector(resource) {
  if (resource?.kind === "CronJob") {
    return resource?.spec?.jobTemplate?.spec?.template?.spec?.nodeSelector;
  }
  return resource?.spec?.template?.spec?.nodeSelector;
}

function memoryBytes(quantity) {
  const match = /^([0-9]+)(Ki|Mi|Gi|Ti|K|M|G|T|)$/u.exec(quantity ?? "");
  if (!match) fail("RPI_CAPACITY_METRICS_RESPONSE_INVALID");
  const binary = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40 };
  const decimal = { K: 10 ** 3, M: 10 ** 6, G: 10 ** 9, T: 10 ** 12 };
  return Number(match[1]) * (binary[match[2]] ?? decimal[match[2]] ?? 1);
}

function eventTimestamp(event) {
  return (
    event?.eventTime ??
    event?.lastTimestamp ??
    event?.series?.lastObservedTime ??
    event?.metadata?.creationTimestamp ??
    null
  );
}

function isBadMemoryEvent(event) {
  return /OOM|Evict|MemoryPressure|out of memory/iu.test(
    `${event?.reason ?? ""} ${event?.message ?? ""}`,
  );
}

function isRestrictedPod(pod) {
  const namespace = pod?.metadata?.namespace;
  const name = pod?.metadata?.name ?? "";
  return (
    new Set(["arc-system", "arc-runners", "auth-broker"]).has(namespace) ||
    (namespace === "platform" &&
      name.startsWith(`${contract.workloads.scheduler.name}-`))
  );
}

function liveReadback() {
  const context = runKubectl(
    ["config", "current-context"],
    "RPI_CAPACITY_CONTEXT_READ_FAILED",
  );
  if (context !== contract.cluster.context) fail("RPI_CAPACITY_CONTEXT_DRIFT");

  const nodes = kubectlJson(
    [
      "get",
      "node",
      contract.cluster.nodes.quarantined.hostname,
      contract.cluster.nodes.workload.hostname,
      "-o",
      "json",
    ],
    "RPI_CAPACITY_NODE_READ_FAILED",
  );
  const quarantined = nodeByName(
    nodes,
    contract.cluster.nodes.quarantined.hostname,
  );
  const workload = nodeByName(nodes, contract.cluster.nodes.workload.hostname);
  const requiredTaint = contract.cluster.nodes.quarantined.requiredTaint;
  const quarantineConditions =
    contract.cluster.nodes.quarantined.requiredConditions;
  const workloadConditions = contract.cluster.nodes.workload.requiredConditions;
  const taint = quarantined?.spec?.taints?.find(
    (entry) =>
      entry.key === requiredTaint.key && entry.effect === requiredTaint.effect,
  );
  if (
    quarantined?.spec?.unschedulable !==
      contract.cluster.nodes.quarantined.unschedulable ||
    taint === undefined ||
    condition(quarantined, "Ready") !== quarantineConditions.ready ||
    condition(quarantined, "MemoryPressure") !==
      quarantineConditions.memoryPressure
  ) {
    fail("RPI_CAPACITY_RPI4_QUARANTINE_DRIFT");
  }
  if (
    (workload?.spec?.unschedulable ?? false) !==
      !contract.cluster.nodes.workload.schedulable ||
    condition(workload, "Ready") !== workloadConditions.ready ||
    condition(workload, "MemoryPressure") !==
      workloadConditions.memoryPressure
  ) {
    fail("RPI_CAPACITY_RPI5_HEALTH_DRIFT");
  }
  const quarantineStartedAt = Date.parse(taint.timeAdded ?? "");
  if (!Number.isFinite(quarantineStartedAt)) {
    fail("RPI_CAPACITY_RPI4_TAINT_TIME_INVALID");
  }

  const arc = contract.workloads.arc;
  const runnerSets = kubectlJson(
    ["get", "autoscalingrunnersets", "-n", arc.runnerNamespace, "-o", "json"],
    "RPI_CAPACITY_ARC_LIVE_READ_FAILED",
  );
  if (
    !Array.isArray(runnerSets?.items) ||
    runnerSets.items.length !== arc.scaleSets.length
  ) {
    fail("RPI_CAPACITY_ARC_LIVE_DRIFT");
  }
  const arcStatus = [];
  for (const expected of arc.scaleSets) {
    const actual = runnerSets.items.find(
      (item) => item?.metadata?.name === expected.name,
    );
    const current = actual?.status?.currentRunners ?? 0;
    const pending = actual?.status?.pendingEphemeralRunners ?? 0;
    const running = actual?.status?.runningEphemeralRunners ?? 0;
    if (
      actual?.spec?.minRunners !== expected.minRunners ||
      actual?.spec?.maxRunners !== expected.maxRunners ||
      !same(actual?.spec?.template?.spec?.nodeSelector, expected.nodeSelector) ||
      !same(
        actual?.spec?.listenerTemplate?.spec?.nodeSelector,
        expected.nodeSelector,
      ) ||
      actual?.status?.phase !== "Running" ||
      ![current, pending, running].every(
        (value) =>
          Number.isSafeInteger(value) &&
          value >= 0 &&
          value <= expected.maxRunners,
      ) ||
      current < expected.minRunners ||
      running < expected.minRunners
    ) {
      fail("RPI_CAPACITY_ARC_LIVE_DRIFT");
    }
    arcStatus.push({ name: expected.name, current, pending, running });
  }

  const controller = kubectlJson(
    [
      "get",
      "deployment",
      arc.controller.name,
      "-n",
      arc.controller.namespace,
      "-o",
      "json",
    ],
    "RPI_CAPACITY_ARC_CONTROLLER_READ_FAILED",
  );
  if (!same(podTemplateSelector(controller), arc.controller.nodeSelector)) {
    fail("RPI_CAPACITY_ARC_CONTROLLER_LIVE_DRIFT");
  }

  const scheduler = contract.workloads.scheduler;
  const schedulerResource = kubectlJson(
    [
      "get",
      scheduler.kind.toLowerCase(),
      scheduler.name,
      "-n",
      scheduler.namespace,
      "-o",
      "json",
    ],
    "RPI_CAPACITY_SCHEDULER_READ_FAILED",
  );
  if (!same(podTemplateSelector(schedulerResource), scheduler.nodeSelector)) {
    fail("RPI_CAPACITY_SCHEDULER_LIVE_DRIFT");
  }

  const workloadResources = kubectlJson(
    ["get", "deployment,statefulset", "-A", "-o", "json"],
    "RPI_CAPACITY_WORKLOAD_READ_FAILED",
  );
  const auth = contract.workloads.authBroker;
  const authWorkloads = (workloadResources?.items ?? []).filter(
    (item) => item?.metadata?.namespace === auth.namespace,
  );
  if (authWorkloads.length > 0) {
    const actualNames = authWorkloads
      .map((item) => item?.metadata?.name)
      .toSorted();
    if (
      !same(actualNames, auth.workloadNames.toSorted()) ||
      !authWorkloads.every((item) =>
        same(podTemplateSelector(item), auth.nodeSelector),
      )
    ) {
      fail("RPI_CAPACITY_AUTH_BROKER_LIVE_DRIFT");
    }
  }

  const pods = kubectlJson(
    ["get", "pods", "-A", "-o", "json"],
    "RPI_CAPACITY_POD_READ_FAILED",
  );
  const quarantineIso = new Date(quarantineStartedAt).toISOString();
  const newActiveNonDaemonPodsOnRpi4 = (pods?.items ?? []).filter(
    (pod) => {
      if (pod?.spec?.nodeName !== contract.cluster.nodes.quarantined.hostname) {
        return false;
      }
      const createdAt = Date.parse(pod?.metadata?.creationTimestamp ?? "");
      if (!Number.isFinite(createdAt)) {
        fail("RPI_CAPACITY_POD_TIMESTAMP_INVALID");
      }
      return (
        createdAt >= quarantineStartedAt &&
        pod?.metadata?.ownerReferences?.[0]?.kind !== "DaemonSet" &&
        new Set(["Pending", "Running", "Unknown"]).has(pod?.status?.phase)
      );
    },
  );
  const restrictedActivePods = (pods?.items ?? []).filter(
    (pod) =>
      isRestrictedPod(pod) &&
      new Set(["Pending", "Running", "Unknown"]).has(pod?.status?.phase),
  );
  if (
    newActiveNonDaemonPodsOnRpi4.length > 0 ||
    restrictedActivePods.some(
      (pod) =>
        pod?.spec?.nodeName !== undefined &&
        pod.spec.nodeName !== contract.cluster.nodes.workload.hostname,
    )
  ) {
    fail("RPI_CAPACITY_WORKLOAD_PLACEMENT_DRIFT");
  }

  const oomKilled = (pods?.items ?? []).flatMap((pod) =>
    [
      ...(pod?.status?.containerStatuses ?? []),
      ...(pod?.status?.initContainerStatuses ?? []),
    ].filter((status) => {
      const terminated = status?.lastState?.terminated;
      return (
        terminated?.reason === "OOMKilled" &&
        Date.parse(terminated.finishedAt ?? "") >= quarantineStartedAt
      );
    }),
  );
  const events = kubectlJson(
    ["get", "events", "-A", "-o", "json"],
    "RPI_CAPACITY_EVENT_READ_FAILED",
  );
  const badEvents = (events?.items ?? []).filter((event) => {
    const timestamp = Date.parse(eventTimestamp(event) ?? "");
    return (
      Number.isFinite(timestamp) &&
      timestamp >= quarantineStartedAt &&
      isBadMemoryEvent(event)
    );
  });
  if (oomKilled.length > 0 || badEvents.length > 0) {
    fail("RPI_CAPACITY_MEMORY_EVENT_DETECTED");
  }

  const podMetrics = kubectlJson(
    ["get", "--raw", "/apis/metrics.k8s.io/v1beta1/pods"],
    "RPI_CAPACITY_POD_METRICS_READ_FAILED",
  );
  const nodeMetrics = kubectlJson(
    ["get", "--raw", "/apis/metrics.k8s.io/v1beta1/nodes"],
    "RPI_CAPACITY_NODE_METRICS_READ_FAILED",
  );
  const podState = new Map(
    (pods?.items ?? []).map((pod) => [
      `${pod?.metadata?.namespace}/${pod?.metadata?.name}`,
      { nodeName: pod?.spec?.nodeName, phase: pod?.status?.phase },
    ]),
  );
  let rpi4PodWorkingSetBytes = 0;
  for (const item of podMetrics?.items ?? []) {
    const state = podState.get(
      `${item?.metadata?.namespace}/${item?.metadata?.name}`,
    );
    if (
      state?.nodeName === contract.cluster.nodes.quarantined.hostname &&
      state.phase === "Running"
    ) {
      rpi4PodWorkingSetBytes += (item?.containers ?? []).reduce(
        (sum, container) => sum + memoryBytes(container?.usage?.memory),
        0,
      );
    }
  }
  const metricFor = (name) =>
    nodeMetrics?.items?.find((item) => item?.metadata?.name === name);
  const rpi4NodeWorkingSetBytes = memoryBytes(
    metricFor(contract.cluster.nodes.quarantined.hostname)?.usage?.memory,
  );
  const rpi5NodeWorkingSetBytes = memoryBytes(
    metricFor(contract.cluster.nodes.workload.hostname)?.usage?.memory,
  );
  const observedHours = (Date.now() - quarantineStartedAt) / (60 * 60 * 1000);
  const evidence = {
    quarantineStartedAt: quarantineIso,
    observedHours: Number(observedHours.toFixed(2)),
    minimumHours: contract.observation.minimumHours,
    rpi4NodeWorkingSetMi: Math.round(rpi4NodeWorkingSetBytes / 2 ** 20),
    rpi4RunningPodWorkingSetMi: Math.round(
      rpi4PodWorkingSetBytes / 2 ** 20,
    ),
    rpi5NodeWorkingSetMi: Math.round(rpi5NodeWorkingSetBytes / 2 ** 20),
    oomKilled: 0,
    oomEvictionEvents: 0,
    authBrokerState: authWorkloads.length === 0 ? "not_deployed" : "rpi5",
    arc: arcStatus,
  };
  if (observedHours < contract.observation.minimumHours) {
    fail("RPI_CAPACITY_OBSERVATION_WINDOW_INCOMPLETE", evidence);
  }
  return evidence;
}

validateFiles();
const evidence = mode === "readback" ? liveReadback() : undefined;
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    mode,
    policyVersion: contract.schemaVersion,
    quarantinedNode: contract.cluster.nodes.quarantined.hostname,
    workloadNode: contract.cluster.nodes.workload.hostname,
    arc: contract.workloads.arc.scaleSets.map(
      ({ name, minRunners, maxRunners }) => ({
        name,
        minRunners,
        maxRunners,
      }),
    ),
    ...(evidence === undefined ? {} : { evidence }),
  })}\n`,
);
