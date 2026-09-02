#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const method = args[args.indexOf("--method") + 1];
const path = args[args.indexOf("--method") + 2];
if (args[0] !== "api" || method !== "GET" || !path?.startsWith("/orgs/seorilabs")
  && !path?.startsWith("/repos/seorilabs/")) {
  process.stderr.write("MOCK_UNEXPECTED_GITHUB_MUTATION\n");
  process.exit(1);
}
appendFileSync(process.env.P3_GITHUB_FIXTURE_REQUESTS, `${JSON.stringify({ method, path })}\n`);
const state = JSON.parse(readFileSync(process.env.P3_GITHUB_FIXTURE_STATE, "utf8"));
const response = state[path];
if (response === undefined) {
  process.stderr.write("HTTP 404\n");
  process.exit(1);
}
if (response.fixtureStatus) {
  process.stdout.write(JSON.stringify({ message: response.fixtureMessage ?? "Not Found", status: String(response.fixtureStatus) }));
  process.stderr.write(`HTTP ${response.fixtureStatus}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(response)}\n`);
