import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(
  new URL("../scripts/release/upload-google-play-aab.py", import.meta.url),
);

// Play API 를 대신하는 최소 스텁. 실제 호출 순서와 본문을 파일로 받아 확인한다.
// 승격은 되돌리기 어려운 외부 상태 변경이라, 어떤 body 가 나가는지 눈으로 봐야 한다.
const DISCOVERY_STUB = `import json, os

LOG = os.environ["STUB_LOG"]
SOURCE_CODES = json.loads(os.environ.get("STUB_SOURCE_VERSION_CODES", "[]"))


def _record(entry):
    with open(LOG, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, sort_keys=True) + "\\n")


class _Request:
    def __init__(self, result):
        self._result = result

    def execute(self, num_retries=0):
        return self._result


class _Tracks:
    def get(self, packageName, editId, track):
        _record({"call": "tracks.get", "track": track})
        return _Request({"track": track, "releases": [{"versionCodes": SOURCE_CODES}]})

    def update(self, packageName, editId, track, body):
        _record({"call": "tracks.update", "track": track, "body": body})
        return _Request({})


class _Edits:
    def insert(self, packageName, body):
        _record({"call": "edits.insert", "packageName": packageName})
        return _Request({"id": "edit-1"})

    def tracks(self):
        return _Tracks()

    def commit(self, packageName, editId, **kwargs):
        _record({"call": "edits.commit"})
        return _Request({})

    def delete(self, packageName, editId):
        _record({"call": "edits.delete"})
        return _Request({})


class _Service:
    def edits(self):
        return _Edits()


def build(name, version, http=None, cache_discovery=True):
    return _Service()
`;

async function makeStubRoot() {
  const root = await mkdtemp(join(tmpdir(), "play-promote-stub-"));
  await mkdir(join(root, "google"));
  await mkdir(join(root, "googleapiclient"));
  await writeFile(join(root, "google", "__init__.py"), "");
  await writeFile(
    join(root, "google", "auth.py"),
    "def default(scopes=None):\n    return ('credentials', 'project')\n",
  );
  await writeFile(
    join(root, "google_auth_httplib2.py"),
    "def AuthorizedHttp(credentials, http=None):\n    return http\n",
  );
  await writeFile(
    join(root, "httplib2.py"),
    "class Http:\n    def __init__(self, timeout=None):\n        self.redirect_codes = {301, 302, 308}\n",
  );
  await writeFile(join(root, "googleapiclient", "__init__.py"), "");
  await writeFile(join(root, "googleapiclient", "discovery.py"), DISCOVERY_STUB);
  return root;
}

async function runPromote(args, { sourceVersionCodes = [] } = {}) {
  const root = await makeStubRoot();
  const log = join(root, "calls.log");
  const result = spawnSync("python3", [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: root,
      STUB_LOG: log,
      STUB_SOURCE_VERSION_CODES: JSON.stringify(sourceVersionCodes),
    },
  });
  let calls = [];
  try {
    calls = (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    calls = [];
  }
  return { ...result, calls };
}

const BASE = [
  "--promote",
  "--package-name",
  "com.seorilabs.example",
  "--promote-from-track",
  "internal",
  "--promote-to-track",
  "production",
  "--promote-version-code",
  "1001000017",
  "--release-status",
  "completed",
  "--release-name",
  "v1.0.17",
];

test("승격은 태그가 정한 build 하나만 대상 트랙으로 옮기고 commit 한다", async () => {
  const { status, stdout, calls } = await runPromote(BASE, {
    sourceVersionCodes: ["1001000017"],
  });
  assert.equal(status, 0, stdout);
  assert.deepEqual(JSON.parse(stdout), {
    fromTrack: "internal",
    packageName: "com.seorilabs.example",
    releaseStatus: "completed",
    toTrack: "production",
    versionCode: 1001000017,
  });
  assert.deepEqual(
    calls.map(({ call }) => call),
    ["edits.insert", "tracks.get", "tracks.update", "edits.commit"],
  );
  const update = calls.find(({ call }) => call === "tracks.update");
  assert.deepEqual(update.body.releases[0].versionCodes, ["1001000017"]);
});

test("원본 트랙에 없는 versionCode 는 승격하지 않고 edit 를 정리한다", async () => {
  // 트랙의 최신 build 를 그대로 올리면 의도하지 않은 것이 심사로 나간다.
  const { status, stderr, calls } = await runPromote(BASE, {
    sourceVersionCodes: ["1001000099"],
  });
  assert.equal(status, 1);
  assert.match(stderr, /GOOGLE_PLAY_SOURCE_TRACK_MISSING_VERSION_CODE/);
  assert.ok(!calls.some(({ call }) => call === "tracks.update"));
  assert.ok(calls.some(({ call }) => call === "edits.delete"));
});

test("원본과 대상 트랙이 같으면 거부한다", async () => {
  const args = [...BASE];
  args[args.indexOf("--promote-from-track") + 1] = "production";
  const { status, stderr, calls } = await runPromote(args, {
    sourceVersionCodes: ["1001000017"],
  });
  assert.equal(status, 1);
  assert.match(stderr, /PROMOTE_TRACKS_IDENTICAL/);
  assert.deepEqual(calls, []);
});

test("rollout 을 주면 부분 공개 상태로 나간다", async () => {
  const { status, stdout, calls } = await runPromote([...BASE, "--rollout", "0.1"], {
    sourceVersionCodes: ["1001000017"],
  });
  assert.equal(status, 0, stdout);
  const release = calls.find(({ call }) => call === "tracks.update").body.releases[0];
  assert.equal(release.status, "inProgress");
  assert.equal(release.userFraction, 0.1);
});

test("모드가 섞인 인자는 거부한다", async () => {
  const withAab = await runPromote([...BASE, "--aab-path", "/tmp/none.aab"]);
  assert.equal(withAab.status, 2);
  assert.match(withAab.stderr, /--aab-path is not valid with --promote/);

  const rolloutWithoutPromote = await runPromote([
    "--package-name",
    "com.seorilabs.example",
    "--release-name",
    "v1.0.17",
    "--rollout",
    "0.5",
  ]);
  assert.equal(rolloutWithoutPromote.status, 2);
  assert.match(rolloutWithoutPromote.stderr, /--rollout requires --promote/);
});
