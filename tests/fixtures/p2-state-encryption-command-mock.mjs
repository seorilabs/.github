#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";

import { parseAllDocuments } from "yaml";

const args = process.argv.slice(2);
const scenario = process.env.SEORILABS_STATE_FIXTURE_SCENARIO ?? "encrypted";
const log = process.env.SEORILABS_STATE_FIXTURE_LOG;
if (log) appendFileSync(log, `${JSON.stringify(args)}\n`, "utf8");

function output(value) {
  process.stdout.write(
    typeof value === "string" ? `${value}\n` : `${JSON.stringify(value)}\n`,
  );
  process.exit(0);
}

if (args.join("\0") === ["--short"].join("\0")) {
  output(scenario === "wrong-host-node" ? "rpi4001" : "rpi5");
}

function blockDevice({
  name,
  kname = name,
  type,
  fstype = null,
  pkname = null,
  size,
  model = null,
  serial = null,
  wwn = null,
  uuid = null,
  partuuid = null,
  mountpoints = [null],
  children = undefined,
}) {
  return {
    name,
    kname,
    type,
    fstype,
    pkname,
    size,
    model,
    serial,
    wwn,
    uuid,
    partuuid,
    mountpoints,
    ...(children === undefined ? {} : { children }),
  };
}

function encryptedDevices() {
  const mapper = blockDevice({
    name: "seori-auth-state",
    kname: "dm-0",
    type: scenario === "missing-encryption" ? "part" : "crypt",
    fstype: "ext4",
    pkname: "mmcblk0p3",
    size: 10_737_418_240,
    uuid: "fixture-ext4-uuid",
    mountpoints: ["/var/lib/seori-auth"],
  });
  const partition = blockDevice({
    name: "mmcblk0p3",
    type: "part",
    fstype: "crypto_LUKS",
    pkname: "mmcblk0",
    size: 10_737_418_240,
    uuid: scenario === "backing-identity-missing" ? null : "fixture-luks-uuid",
    partuuid: scenario === "backing-identity-missing" ? null : "fixture-partuuid",
    children: [mapper],
  });
  return {
    blockdevices: [blockDevice({
      name: "mmcblk0",
      type: "disk",
      size: 64_000_000_000,
      model: "fixture-rpi-storage",
      serial: scenario === "backing-identity-missing" ? null : "fixture-public-serial",
      children: [partition],
    })],
  };
}

function directDevices() {
  return {
    blockdevices: [blockDevice({
      name: "mmcblk0",
      type: "disk",
      size: 64_000_000_000,
      model: "fixture-rpi-storage",
      serial: "fixture-public-serial",
      children: [blockDevice({
        name: "mmcblk0p3",
        type: "part",
        fstype: "ext4",
        pkname: "mmcblk0",
        size: 10_737_418_240,
        uuid: "fixture-ext4-uuid",
        partuuid: "fixture-partuuid",
        mountpoints: ["/var/lib/seori-auth"],
      })],
    })],
  };
}

if (args.includes("--json") && args.includes("--bytes")) {
  output(scenario === "direct-ext4" ? directDevices() : encryptedDevices());
}

if (args.join("\0") === ["config", "current-context"].join("\0")) {
  output(scenario === "wrong-context" ? "other-cluster" : "vzyx-cluster");
}

if (
  args.join("\0") === [
    "--context",
    "vzyx-cluster",
    "create",
    "--dry-run=server",
    "--validate=strict",
    "--filename=-",
    "--output=json",
  ].join("\0")
) {
  const items = parseAllDocuments(readFileSync(0, "utf8")).map((document) =>
    document.toJSON());
  const pv = items.find(({ kind }) => kind === "PersistentVolume");
  const pvc = items.find(({ kind }) => kind === "PersistentVolumeClaim");
  if (scenario === "wrong-storage-class") {
    pv.spec.storageClassName = "lookalike-hostpath";
  }
  if (scenario === "wrong-pv-node") {
    pv.spec.nodeAffinity.required.nodeSelectorTerms[0]
      .matchExpressions[0].values = ["rpi4001"];
  }
  if (scenario === "destructive-reclaim") {
    pv.spec.persistentVolumeReclaimPolicy = "Delete";
  }
  if (scenario === "volume-drift") {
    pvc.spec.resources.requests.storage = "11Gi";
    pvc.spec.accessModes = ["ReadWriteMany"];
  }
  output({ apiVersion: "v1", kind: "List", items });
}

process.exit(64);
