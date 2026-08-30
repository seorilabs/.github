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
const x64Selector = {
  "kubernetes.io/hostname": "seori-m6-01",
  "kubernetes.io/os": "linux",
  "kubernetes.io/arch": "amd64",
};
const x64Toleration = [
  { key: "workload", operator: "Equal", value: "ci", effect: "NoSchedule" },
];
const authSelector = { "kubernetes.io/hostname": "rpi5" };
const rpi4Selector = { "kubernetes.io/hostname": "rpi4001" };
const rpi4CordonToleration = [
  {
    key: "node.kubernetes.io/unschedulable",
    operator: "Exists",
    effect: "NoSchedule",
  },
];

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
      {
        metadata: {
          name: "seori-m6-01",
          labels: { "kubernetes.io/arch": "amd64" },
        },
        spec: {
          taints: [
            {
              key: "workload",
              value: "ci",
              effect: scenario === "x64-node-drift" ? "PreferNoSchedule" : "NoSchedule",
            },
          ],
        },
        status: {
          nodeInfo: { architecture: "amd64" },
          allocatable: { cpu: "11500m", memory: "5209412Ki" },
          conditions: conditions(),
        },
      },
    ],
  });
}

if (args[0] === "get" && args[1] === "autoscalingrunnersets") {
  const scaleSet = (
    name,
    minRunners,
    maxRunners,
    currentRunners,
    {
      nodeSelector = arcSelector,
      tolerations = [],
      pendingRunners = 0,
      runningRunners = currentRunners,
    } = {},
  ) => ({
    metadata: { name },
    spec: {
      minRunners,
      maxRunners,
      template: { spec: { nodeSelector, tolerations } },
      listenerTemplate: { spec: { nodeSelector: arcSelector } },
    },
    status: {
      phase: "Running",
      currentRunners,
      pendingEphemeralRunners: pendingRunners,
      runningEphemeralRunners: runningRunners,
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
    scaleSet("seorilabs-x64", 1, 6, 1, {
      nodeSelector: x64Selector,
      tolerations: x64Toleration,
      pendingRunners: scenario === "arc-under-capacity" ? 0 : 1,
      runningRunners: 0,
    }),
    scaleSet("seorilabs-x64-android", 0, 1, 0, {
      nodeSelector: x64Selector,
      tolerations: x64Toleration,
    }),
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
  const items = [
    {
      kind: "Deployment",
      metadata: { name: "registry", namespace: "container-registry" },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: "registry" } },
        template: {
          metadata: { labels: { app: "registry" } },
          spec: {
            nodeSelector: rpi4Selector,
            tolerations: rpi4CordonToleration,
          },
        },
      },
    },
  ];
  items[0].spec.template.metadata.annotations = {
    "seorilabs.dev/rpi4-preserved-workload":
      scenario === "preserved-controller-drift"
        ? "other"
        : "container-registry",
  };
  if (scenario === "auth-drift") {
    items.push({
      kind: "StatefulSet",
      metadata: { name: "seori-auth-broker", namespace: "auth-broker" },
      spec: {
        template: {
          spec: {
            nodeSelector: { "kubernetes.io/hostname": "rpi4001" },
          },
        },
      },
    });
  }
  output({ items });
}

if (args[0] === "get" && args[1] === "replicasets") {
  output({
    items: [
      {
        kind: "ReplicaSet",
        metadata: {
          name: "registry-current",
          namespace: "container-registry",
          ownerReferences: [
            {
              controller: true,
              kind: "Deployment",
              name:
                scenario === "preserved-owner-drift" ? "other" : "registry",
            },
          ],
        },
        spec: {
          template: {
            metadata: {
              labels: { app: "registry", "pod-template-hash": "current" },
              annotations: {
                "seorilabs.dev/rpi4-preserved-workload": "container-registry",
              },
            },
            spec: {
              nodeSelector: rpi4Selector,
              tolerations: rpi4CordonToleration,
            },
          },
        },
      },
    ],
  });
}

if (args[0] === "get" && args[1] === "pods") {
  const items = [
    {
      metadata: {
        namespace: "container-registry",
        name: "registry-current-pod",
        creationTimestamp: "2026-01-01T00:00:00Z",
        labels: { app: "registry", "pod-template-hash": "current" },
        annotations: {
          "seorilabs.dev/rpi4-preserved-workload": "container-registry",
        },
        ownerReferences: [
          { controller: true, kind: "ReplicaSet", name: "registry-current" },
        ],
      },
      spec: { nodeName: "rpi4001" },
      status: { phase: "Running", containerStatuses: [] },
    },
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
        labels: { "actions.github.com/scale-set-name": "seorilabs-rpi-arm64" },
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
    {
      metadata: {
        namespace: "arc-runners",
        name: "seorilabs-x64-runner",
        creationTimestamp: "2026-01-01T00:00:00Z",
        ownerReferences: [{ kind: "EphemeralRunner" }],
        labels: {
          "actions.github.com/scale-set-name":
            scenario === "unlabeled-x64-runner" ? "unmanaged" : "seorilabs-x64",
        },
      },
      spec: { nodeName: "seori-m6-01" },
      status: { phase: "Running", containerStatuses: [] },
    },
  ];
  if (new Set(["placement-drift", "placement-drift-offset", "invalid-pod-timestamp"]).has(scenario)) {
    items.push({
      metadata: {
        namespace: "tasks",
        name: "new-general-workload",
        creationTimestamp:
          scenario === "placement-drift-offset"
            ? "2025-08-27T20:01:39-04:00"
            : scenario === "invalid-pod-timestamp"
              ? "not-a-timestamp"
              : "2026-01-01T00:00:00Z",
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
        metadata: {
          namespace: "container-registry",
          name: "registry-current-pod",
        },
        containers: [{ usage: { memory: "128Mi" } }],
      },
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
