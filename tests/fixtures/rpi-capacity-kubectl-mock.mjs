#!/usr/bin/env node

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const scenario = process.env.SEORILABS_RPI_CAPACITY_MOCK_SCENARIO ?? "healthy";
const log = process.env.SEORILABS_RPI_CAPACITY_MOCK_LOG;
if (log) appendFileSync(log, `${JSON.stringify(args)}\n`, "utf8");

function output(value) {
  process.stdout.write(
    typeof value === "string" ? `${value}\n` : `${JSON.stringify(value)}\n`,
  );
  process.exit(0);
}

function conditions() {
  return [
    { type: "Ready", status: "True" },
    { type: "MemoryPressure", status: "False" },
  ];
}

const arcSelector = {
  "kubernetes.io/hostname": "rpi5",
  "kubernetes.io/os": "linux",
  "kubernetes.io/arch": "arm64",
};
const authSelector = { "kubernetes.io/hostname": "rpi5" };

if (args.join("\0") === ["config", "current-context"].join("\0")) {
  output(scenario === "wrong-context" ? "other-cluster" : "vzyx-cluster");
}

if (args[0] === "get" && args[1] === "node") {
  output({
    items: [
      {
        metadata: { name: "rpi4001" },
        spec: {
          unschedulable: scenario !== "rpi4-schedulable",
          taints: [
            {
              key: "node.kubernetes.io/unschedulable",
              effect: "NoSchedule",
              timeAdded:
                scenario === "incomplete-window"
                  ? "2999-08-28T00:01:39Z"
                  : "2025-08-28T00:01:39Z",
            },
          ],
        },
        status: { conditions: conditions() },
      },
      {
        metadata: { name: "rpi5" },
        spec: { unschedulable: false, taints: [] },
        status: { conditions: conditions() },
      },
    ],
  });
}

if (args[0] === "get" && args[1] === "autoscalingrunnersets") {
  const scaleSet = (name, minRunners, maxRunners, currentRunners) => ({
    metadata: { name },
    spec: {
      minRunners,
      maxRunners,
      template: { spec: { nodeSelector: arcSelector } },
      listenerTemplate: { spec: { nodeSelector: arcSelector } },
    },
    status: {
      phase: "Running",
      currentRunners,
      pendingEphemeralRunners: 0,
      runningEphemeralRunners: currentRunners,
    },
  });
  const items = [
    scaleSet(
      "seorilabs-rpi-arm64",
      1,
      3,
      scenario === "arc-over-capacity" ? 4 : 1,
    ),
    scaleSet("seorilabs-rpi-arm64-dind", 0, 1, 0),
  ];
  if (scenario === "unmanaged-arc") {
    items.push(scaleSet("unmanaged", 0, 1, 0));
  }
  output({ items });
}

if (
  args.join("\0") ===
  [
    "get",
    "deployment",
    "arc-gha-rs-controller",
    "-n",
    "arc-system",
    "-o",
    "json",
  ].join("\0")
) {
  output({
    kind: "Deployment",
    metadata: { name: "arc-gha-rs-controller", namespace: "arc-system" },
    spec: { template: { spec: { nodeSelector: arcSelector } } },
  });
}

if (args[0] === "get" && args[1] === "cronjob") {
  output({
    kind: "CronJob",
    metadata: {
      name: "backoffice-automation-scheduler",
      namespace: "platform",
    },
    spec: {
      jobTemplate: {
        spec: { template: { spec: { nodeSelector: authSelector } } },
      },
    },
  });
}

if (args[0] === "get" && args[1] === "deployment,statefulset") {
  if (scenario === "auth-drift") {
    output({
      items: [
        {
          kind: "StatefulSet",
          metadata: { name: "seori-auth-broker", namespace: "auth-broker" },
          spec: {
            template: {
              spec: {
                nodeSelector: { "kubernetes.io/hostname": "rpi4001" },
              },
            },
          },
        },
      ],
    });
  }
  output({ items: [] });
}

if (args[0] === "get" && args[1] === "pods") {
  const items = [
    {
      metadata: {
        namespace: "kube-system",
        name: "existing-system-pod",
        creationTimestamp: "2025-01-01T00:00:00Z",
        ownerReferences: [{ kind: "ReplicaSet" }],
      },
      spec: { nodeName: "rpi4001" },
      status: { phase: "Running", containerStatuses: [] },
    },
    {
      metadata: {
        namespace: "arc-runners",
        name: "seorilabs-rpi-arm64-runner",
        creationTimestamp: "2026-01-01T00:00:00Z",
        ownerReferences: [{ kind: "EphemeralRunner" }],
      },
      spec: { nodeName: "rpi5" },
      status: {
        phase: "Running",
        containerStatuses:
          scenario === "oom"
            ? [
                {
                  lastState: {
                    terminated: {
                      reason: "OOMKilled",
                      finishedAt: "2026-01-01T00:10:00Z",
                    },
                  },
                },
              ]
            : [],
      },
    },
  ];
  if (scenario === "placement-drift") {
    items.push({
      metadata: {
        namespace: "tasks",
        name: "new-general-workload",
        creationTimestamp: "2026-01-01T00:00:00Z",
        ownerReferences: [{ kind: "Job" }],
      },
      spec: { nodeName: "rpi4001" },
      status: { phase: "Running", containerStatuses: [] },
    });
  }
  output({ items });
}

if (args[0] === "get" && args[1] === "events") {
  output({
    items:
      scenario === "oom-event"
        ? [
            {
              metadata: { creationTimestamp: "2026-01-01T00:00:00Z" },
              reason: "SystemOOM",
              message: "System OOM encountered",
            },
          ]
        : [],
  });
}

if (
  args.join("\0") ===
  ["get", "--raw", "/apis/metrics.k8s.io/v1beta1/pods"].join("\0")
) {
  output({
    items: [
      {
        metadata: { namespace: "kube-system", name: "existing-system-pod" },
        containers: [{ usage: { memory: "406Mi" } }],
      },
      {
        metadata: {
          namespace: "arc-runners",
          name: "seorilabs-rpi-arm64-runner",
        },
        containers: [{ usage: { memory: "64Mi" } }],
      },
    ],
  });
}

if (
  args.join("\0") ===
  ["get", "--raw", "/apis/metrics.k8s.io/v1beta1/nodes"].join("\0")
) {
  output({
    items: [
      { metadata: { name: "rpi4001" }, usage: { memory: "4565Mi" } },
      { metadata: { name: "rpi5" }, usage: { memory: "3235Mi" } },
    ],
  });
}

process.stderr.write(`unexpected kubectl arguments: ${JSON.stringify(args)}\n`);
process.exit(2);
