import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = fileURLToPath(
  new URL("../scripts/fleet/provision-p3-secret-values.mjs", import.meta.url),
);

async function fixtureHome(mode) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "p3-secret-provisioning-")));
  const configRoot = join(root, ".config", "seorilabs");
  const catalogRoot = join(configRoot, "catalog");
  const scriptsRoot = join(configRoot, "scripts");
  await Promise.all([
    mkdir(catalogRoot, { recursive: true }),
    mkdir(scriptsRoot, { recursive: true }),
  ]);
  await writeFile(
    join(catalogRoot, "seori-auth-runtime-secrets.yaml"),
    "credentials: []\n",
    { mode: 0o600 },
  );
  const wrapper = join(scriptsRoot, "gcloud-cli.sh");
  await writeFile(wrapper, `#!/bin/sh
case "$*" in
  *"secrets describe"*)
    secret_id=""
    previous=""
    for argument in "$@"; do
      if [ "$previous" = "describe" ]; then secret_id="$argument"; break; fi
      previous="$argument"
    done
    if [ "${mode}" = "labels" ]; then
      printf '{"name":"projects/321365398093/secrets/%s","replication":{"automatic":{}},"labels":{"managed-by":"someone-else","purpose":"seori-auth"}}\\n' "$secret_id"
    else
      printf '{"name":"projects/321365398093/secrets/%s","replication":{"automatic":{}},"labels":{"managed-by":"fleet-control-plane","purpose":"seori-auth"}}\\n' "$secret_id"
    fi
    ;;
  *"secrets get-iam-policy"*)
    if [ "${mode}" = "iam" ]; then
      printf '{"bindings":[{"role":"roles/secretmanager.secretAccessor","members":["allUsers"]}]}\\n'
    elif [ "${mode}" = "consumer" ]; then
      case "$*" in
        *"seori-auth-journal-mac"*|*"seori-auth-browser-vault"*) account="seori-auth-broker" ;;
        *"seori-auth-canary-password"*) account="seori-auth-password-loader" ;;
        *"seori-auth-canary-totp-seed"*) account="seori-auth-totp-signer" ;;
      esac
      printf '{"bindings":[{"role":"roles/secretmanager.secretAccessor","members":["serviceAccount:%s@seorilabs-ci.iam.gserviceaccount.com"]}]}\\n' "$account"
    else
      printf '{}\\n'
    fi
    ;;
  *"secrets versions list"*) printf '[]\\n' ;;
  *) exit 2 ;;
esac
`, { mode: 0o500 });
  await chmod(wrapper, 0o500);
  return root;
}

function runReadback(home) {
  return spawnSync(process.execPath, [scriptPath, "readback"], {
    env: { HOME: home, LANG: "C.UTF-8", PATH: process.env.PATH },
    encoding: "utf8",
  });
}

test("P3 value provisioner accepts only the managed Secret metadata contract", async () => {
  const home = await fixtureHome("exact");
  try {
    const result = runReadback(home);
    assert.equal(result.status, 0, result.stderr);
    const readback = JSON.parse(result.stdout);
    assert.equal(readback.resources.length, 4);
    assert.equal(readback.resources.every(({ exists }) => exists), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("P3 value provisioner rejects a same-name Secret with foreign management labels", async () => {
  const home = await fixtureHome("labels");
  try {
    const result = runReadback(home);
    assert.equal(result.status, 1);
    assert.equal(
      JSON.parse(result.stderr).code,
      "P3_SECRET_VALUE_RESOURCE_MANAGEMENT_MISMATCH",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("P3 value provisioner accepts the contract-bound single consumer policy", async () => {
  const home = await fixtureHome("consumer");
  try {
    const result = runReadback(home);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("P3 value provisioner rejects a Secret with resource-level IAM bindings", async () => {
  const home = await fixtureHome("iam");
  try {
    const result = runReadback(home);
    assert.equal(result.status, 1);
    assert.equal(
      JSON.parse(result.stderr).code,
      "P3_SECRET_VALUE_RESOURCE_IAM_MISMATCH",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
