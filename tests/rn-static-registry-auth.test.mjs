import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parse } from "yaml";

const workflow = parse(await readFile(".github/workflows/rn-static-checks-v2.yml", "utf8"));
const steps = workflow.jobs.quality.steps;
const fetchStep = steps.find((step) => step.name === "Fetch locked dependencies without lifecycle scripts");
const auditStep = steps.find((step) => step.name === "Reject high severity dependency advisories");
const credentialSteps = new Set([fetchStep, auditStep]);
const authTemplate = "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n";

// Child output may contain request diagnostics. Never attach it to test failures.
function run(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 25_000, maxBuffer: 1024 * 1024, ...options }, (error, stdout) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout });
    });
  });
}

test("registry 인증은 호스트별 자리표시자로 만들고 설치와 audit 단계에만 전달한다", () => {
  assert.ok(fetchStep && auditStep);
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.env?.NODE_AUTH_TOKEN, undefined);
    assert.equal(job.env?.NPM_CONFIG_USERCONFIG, undefined);
    for (const step of job.steps) {
      if (step.uses?.startsWith("actions/setup-node@")) {
        assert.equal(step.with?.["registry-url"], undefined);
        assert.equal(step.with?.scope, undefined);
      }
      if (credentialSteps.has(step)) {
        assert.equal(step.env.NODE_AUTH_TOKEN, "${{ github.token }}");
        assert.equal(step.env.NPM_CONFIG_USERCONFIG, "${{ runner.temp }}/seorilabs-npm-auth.npmrc");
      } else {
        assert.equal(step.env?.NODE_AUTH_TOKEN, undefined);
        assert.equal(step.env?.NPM_CONFIG_USERCONFIG, undefined);
      }
    }
  }
  assert.equal(workflow.env?.NODE_AUTH_TOKEN, undefined);
  assert.equal(workflow.env?.NPM_CONFIG_USERCONFIG, undefined);
  assert.ok(fetchStep.run.includes("<<'NPMRC'\n" + authTemplate + "NPMRC\n"));
});

test("실제 npm ci는 공개 tarball에 인증을 보내지 않고 지정한 사설 호스트에만 보낸다", { timeout: 90_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rn-registry-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = randomBytes(24).toString("hex");
  const requests = [];
  const tarballs = new Map();
  const servers = [];
  t.after(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    })));
  });
  async function listen(kind) {
    const server = createServer((request, response) => {
      const hasAuthorization = request.headers.authorization !== undefined;
      const validAuthorization = request.headers.authorization === `Bearer ${token}`;
      const expectedPath = `/${kind}.tgz`;
      // Store booleans only: no header, request body or token is retained in evidence.
      requests.push({ kind, pathMatches: request.url === expectedPath, hasAuthorization, validAuthorization });
      const authorized = kind === "private" ? validAuthorization : !hasAuthorization;
      if (request.url !== expectedPath || !authorized || !tarballs.has(kind)) {
        response.writeHead(403);
        response.end("fixture request rejected");
        return;
      }
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end(tarballs.get(kind));
    });
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return `127.0.0.1:${server.address().port}`;
  }
  const publicHost = await listen("public");
  const privateHost = await listen("private");
  const emptyConfig = join(root, "empty.npmrc");
  const userConfig = join(root, "workflow.npmrc");
  await writeFile(emptyConfig, "", { mode: 0o600 });
  const env = {
    PATH: process.env.PATH,
    NPM_CONFIG_USERCONFIG: emptyConfig,
    NPM_CONFIG_GLOBALCONFIG: join(root, "global.npmrc"),
    NPM_CONFIG_CACHE: join(root, "cache"),
    NPM_CONFIG_REGISTRY: `http://${publicHost}/`,
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_FETCH_RETRIES: "0",
    NPM_CONFIG_FETCH_TIMEOUT: "10000",
  };
  await writeFile(env.NPM_CONFIG_GLOBALCONFIG, "", { mode: 0o600 });
  for (const kind of ["public", "private"]) {
    const fixture = join(root, `package-${kind}`);
    await mkdir(fixture);
    await writeFile(join(fixture, "package.json"), JSON.stringify({
      name: `@seorilabs/${kind}-fixture`, version: "1.0.0", files: ["index.js"],
    }));
    await writeFile(join(fixture, "index.js"), "module.exports = true;\n");
    const packed = await run("npm", ["pack", "--json", "--ignore-scripts", "--offline"], {
      cwd: fixture, env: { ...env, NPM_CONFIG_CACHE: join(fixture, "pack-cache") },
    });
    assert.equal(packed.code, 0, "local fixture npm pack failed; child output withheld");
    const [{ filename }] = JSON.parse(packed.stdout);
    tarballs.set(kind, await readFile(join(fixture, filename)));
  }
  const app = join(root, "app");
  await mkdir(app);
  const projectConfig = `registry=http://${publicHost}/\n`;
  await writeFile(join(app, ".npmrc"), projectConfig);
  const dependencies = {};
  const packages = {};
  for (const [kind, host] of [["public", publicHost], ["private", privateHost]]) {
    const name = `@seorilabs/${kind}-fixture`;
    const resolved = `http://${host}/${kind}.tgz`;
    dependencies[name] = resolved;
    packages[`node_modules/${name}`] = {
      version: "1.0.0", resolved,
      integrity: `sha512-${createHash("sha512").update(tarballs.get(kind)).digest("base64")}`,
    };
  }
  await writeFile(join(app, "package.json"), JSON.stringify({ name: "registry-fixture", version: "1.0.0", dependencies }));
  await writeFile(join(app, "package-lock.json"), JSON.stringify({
    name: "registry-fixture", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: { "": { name: "registry-fixture", version: "1.0.0", dependencies }, ...packages },
  }));
  const workflowEnv = { ...env, NPM_CONFIG_USERCONFIG: userConfig, NODE_AUTH_TOKEN: token };
  delete workflowEnv.NPM_CONFIG_REGISTRY;
  // Run the unchanged workflow first. An invalid manager stops before npm executes,
  // while testing the real shell heredoc, expansion behavior and file permissions.
  const templateRun = await run("bash", ["-euo", "pipefail", "-c", fetchStep.run], {
    cwd: app, env: { ...workflowEnv, PACKAGE_MANAGER: "fixture-no-install" },
  });
  assert.equal(templateRun.code, 1, "unsupported manager must stop before installation");
  const originalConfig = await readFile(userConfig, "utf8");
  assert.equal(originalConfig === authTemplate, true, "workflow must write only the host-scoped literal placeholder");
  assert.equal(originalConfig.includes(token), false, "workflow must not persist a token value");
  assert.equal((await stat(userConfig)).mode & 0o777, 0o600);
  assert.equal(requests.length, 0);
  const registry = await run("npm", ["config", "get", "registry"], { cwd: app, env: workflowEnv });
  assert.equal(registry.code, 0);
  assert.equal(registry.stdout.trim(), `http://${publicHost}/`);
  // Only substitute the external host with a loopback origin. No production host
  // is contacted, and the actual npm ci branch remains byte-for-byte unchanged.
  const loopbackRun = fetchStep.run.replace("//npm.pkg.github.com/", `//${privateHost}/`);
  const installed = await run("bash", ["-euo", "pipefail", "-c", loopbackRun], {
    cwd: app, env: { ...workflowEnv, PACKAGE_MANAGER: "npm" },
  });
  assert.equal(installed.code, 0, "loopback npm ci failed; child output withheld");
  assert.equal(await readFile(join(app, ".npmrc"), "utf8"), projectConfig);
  for (const kind of ["public", "private"]) {
    const observed = requests.filter((request) => request.kind === kind);
    assert.ok(observed.length > 0, `${kind} tarball must be fetched over HTTP`);
    assert.ok(observed.every((request) => request.pathMatches));
    assert.ok(observed.every((request) => request.hasAuthorization === (kind === "private")));
    assert.ok(observed.every((request) => request.validAuthorization === (kind === "private")));
    const installedPackage = JSON.parse(await readFile(join(app, "node_modules", "@seorilabs", `${kind}-fixture`, "package.json"), "utf8"));
    assert.equal(installedPackage.name, `@seorilabs/${kind}-fixture`);
  }
});
