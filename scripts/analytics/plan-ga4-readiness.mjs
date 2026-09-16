#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildGa4ReadinessPlan } from "../../packages/repo-contract/src/analytics-event-contract.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/analytics/plan-ga4-readiness.mjs --desired <json> --observed <json>",
    "",
    "The command only compares provider observations. It never changes GA4, Firebase,",
    "BigQuery, or AdMob resources.",
  ].join("\n");
}

function parseArguments(argv) {
  if (argv.includes("--help")) return { help: true };
  const allowed = new Set(["--desired", "--observed"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined) throw new Error(`invalid argument: ${flag ?? ""}`);
    values[flag.slice(2)] = value;
  }
  if (!values.desired || !values.observed) throw new Error("--desired and --observed are required");
  return values;
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

try {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    const [desiredInput, observedInput] = await Promise.all([
      readJson(args.desired),
      readJson(args.observed),
    ]);
    const plan = buildGa4ReadinessPlan({
      appId: desiredInput.appId,
      lifecycle: desiredInput.lifecycle,
      desired: desiredInput.checks,
      observed: observedInput.checks,
    });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n${usage()}\n`);
  process.exitCode = 1;
}
