import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const installerPath = fileURLToPath(
  new URL("../scripts/fleet/install-p3-secret-manager-writer.sh", import.meta.url),
);
const provisionerPath = fileURLToPath(
  new URL("../scripts/fleet/provision-p3-secret-values.mjs", import.meta.url),
);

test("P3 writer images remain root-owned but readable by the unprivileged provisioner", async () => {
  const [installer, provisioner] = await Promise.all([
    readFile(installerPath, "utf8"),
    readFile(provisionerPath, "utf8"),
  ]);

  assert.match(
    installer,
    /chmod 555 "\$\{staging\}\/seori-auth-node" "\$\{staging\}\/seori-auth-native"/u,
  );
  assert.match(installer, /chmod 444 "\$\{staging\}\/secret-manager-writer\.mjs"/u);
  assert.equal((installer.match(/sudo install -o root -g wheel -m 555/gu) ?? []).length, 2);
  assert.equal((installer.match(/sudo install -o root -g wheel -m 444/gu) ?? []).length, 1);
  assert.match(provisioner, /helperPath: 0o555/u);
  assert.match(provisioner, /executablePath: 0o555/u);
  assert.match(provisioner, /childPath: 0o444/u);
});
