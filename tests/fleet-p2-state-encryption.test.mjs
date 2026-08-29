import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const verifier = fileURLToPath(
  new URL("../scripts/fleet/verify-p2-state-encryption.mjs", import.meta.url),
);
const commandMock = fileURLToPath(
  new URL("./fixtures/p2-state-encryption-command-mock.mjs", import.meta.url),
);
const fakeSecret = "FAKE_STATE_KEY_MATERIAL_MUST_NOT_APPEAR";

function mountInfo(source = "/dev/mapper/seori-auth-state", fstype = "ext4") {
  return `36 25 253:0 / /var/lib/seori-auth rw,relatime - ${fstype} ${source} rw\n`;
}

async function verify(mode, {
  scenario = "encrypted",
  source,
  fstype,
  withLog = false,
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "p2-state-encryption-")));
  const mountInfoPath = join(root, "mountinfo");
  const log = join(root, "commands.jsonl");
  await writeFile(mountInfoPath, mountInfo(source, fstype), { mode: 0o600 });
  try {
    const result = await execFileAsync(process.execPath, [verifier, mode], {
      env: {
        ...process.env,
        SEORILABS_STATE_MOUNTINFO: mountInfoPath,
        SEORILABS_STATE_LSBLK: commandMock,
        SEORILABS_STATE_HOSTNAME: commandMock,
        SEORILABS_KUBECTL: commandMock,
        SEORILABS_STATE_FIXTURE_RUNTIME: process.execPath,
        SEORILABS_STATE_FIXTURE_SCENARIO: scenario,
        ...(withLog ? { SEORILABS_STATE_FIXTURE_LOG: log } : {}),
        FAKE_STATE_SECRET_CANARY: fakeSecret,
      },
    });
    return {
      ...result,
      calls: withLog
        ? (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
        : [],
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertPublicOnly(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /\/var\/lib\/seori-auth|\/dev\/mapper|mountPoint|mapperName/u);
  assert.doesNotMatch(serialized, /secret|key.?material|FAKE_STATE_KEY/iu);
}

test("RPI5 dm-crypt ext4 attestor는 backing 세부값 대신 공개 fingerprint만 반환한다", async () => {
  const result = await verify("host");
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output).sort(), [
    "backingFingerprintSha256",
    "deviceMapper",
    "fstype",
    "mapperType",
    "nodeName",
    "schemaVersion",
  ]);
  assert.deepEqual(
    {
      schemaVersion: output.schemaVersion,
      nodeName: output.nodeName,
      deviceMapper: output.deviceMapper,
      mapperType: output.mapperType,
      fstype: output.fstype,
    },
    {
      schemaVersion: 1,
      nodeName: "rpi5",
      deviceMapper: true,
      mapperType: "crypt",
      fstype: "ext4",
    },
  );
  assert.match(output.backingFingerprintSha256, /^[0-9a-f]{64}$/u);
  assertPublicOnly(output);
});

test("direct ext4, mapper look-alike, 암호화 누락과 wrong node는 fail-closed한다", async () => {
  const cases = [
    [
      { scenario: "direct-ext4", source: "/dev/mmcblk0p3" },
      "STATE_ENCRYPTION_MAPPER_REQUIRED",
    ],
    [
      { source: "/dev/mapper/seori-auth-state-copy" },
      "STATE_ENCRYPTION_MAPPER_REQUIRED",
    ],
    [
      { scenario: "missing-encryption" },
      "STATE_ENCRYPTION_DM_CRYPT_MISSING",
    ],
    [
      { scenario: "wrong-host-node" },
      "STATE_ENCRYPTION_NODE_MISMATCH",
    ],
    [
      { fstype: "xfs" },
      "STATE_ENCRYPTION_FSTYPE_MISMATCH",
    ],
    [
      { scenario: "backing-identity-missing" },
      "STATE_ENCRYPTION_BACKING_IDENTITY_MISSING",
    ],
  ];
  for (const [fixture, code] of cases) {
    await assert.rejects(verify("host", fixture), (error) => {
      assert.equal(error.code, 1);
      assert.deepEqual(JSON.parse(error.stderr), { ok: false, code });
      assertPublicOnly(error.stderr);
      return true;
    });
  }
});

test("Retain PV/PVC는 exact RPI5 identity와 server dry-run으로만 검증한다", async () => {
  const result = await verify("server-dry-run", { withLog: true });
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output).sort(), [
    "host", "pv", "pvc", "schemaVersion", "serverDryRun", "state",
  ]);
  assert.equal(output.state, "SERVER_DRY_RUN_VERIFIED");
  assert.equal(output.serverDryRun, true);
  assert.deepEqual(output.pv, {
    name: "seori-auth-state-rpi5",
    size: "10Gi",
    accessModes: ["ReadWriteOnce"],
    volumeMode: "Filesystem",
    reclaimPolicy: "Retain",
    storageClassName: "microk8s-hostpath",
    nodeName: "rpi5",
  });
  assert.deepEqual(output.pvc, {
    namespace: "auth-broker",
    name: "seori-auth-state",
    volumeName: "seori-auth-state-rpi5",
    size: "10Gi",
    accessModes: ["ReadWriteOnce"],
    volumeMode: "Filesystem",
    storageClassName: "microk8s-hostpath",
  });
  assertPublicOnly(output);
  assert.deepEqual(result.calls[0], ["--short"]);
  assert.ok(result.calls[1].includes("--json"));
  assert.deepEqual(result.calls[2], ["config", "current-context"]);
  assert.deepEqual(result.calls[3], [
    "--context",
    "vzyx-cluster",
    "create",
    "--dry-run=server",
    "--validate=strict",
    "--filename=-",
    "--output=json",
  ]);
  assert.ok(result.calls.every((args) =>
    !args.some((argument) => ["apply", "delete", "patch", "replace"].includes(argument))));
});

test("wrong node/SC, destructive reclaim policy와 PV/PVC drift를 거부한다", async () => {
  for (const scenario of [
    "wrong-storage-class",
    "wrong-pv-node",
    "destructive-reclaim",
    "volume-drift",
  ]) {
    await assert.rejects(
      verify("server-dry-run", { scenario }),
      (error) => {
        assert.equal(error.code, 1);
        assert.deepEqual(JSON.parse(error.stderr), {
          ok: false,
          code: "STATE_VOLUME_SERVER_DRY_RUN_DRIFT",
        });
        assertPublicOnly(error.stderr);
        return true;
      },
    );
  }
});

test("잘못된 cluster context는 server dry-run 전에 중단한다", async () => {
  await assert.rejects(
    verify("server-dry-run", { scenario: "wrong-context", withLog: true }),
    (error) => {
      assert.equal(error.code, 1);
      assert.deepEqual(JSON.parse(error.stderr), {
        ok: false,
        code: "STATE_VOLUME_CONTEXT_MISMATCH",
      });
      return true;
    },
  );
});
