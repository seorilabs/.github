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
SOURCE_RELEASE = json.loads(os.environ.get("STUB_SOURCE_RELEASE", "{}"))


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
        release = {"versionCodes": SOURCE_CODES}
        release.update(SOURCE_RELEASE)
        return _Request({"track": track, "releases": [release]})

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

async function runPromote(args, { sourceVersionCodes = [], sourceRelease = {} } = {}) {
  const root = await makeStubRoot();
  const log = join(root, "calls.log");
  const result = spawnSync("python3", [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: root,
      STUB_LOG: log,
      STUB_SOURCE_VERSION_CODES: JSON.stringify(sourceVersionCodes),
      STUB_SOURCE_RELEASE: JSON.stringify(sourceRelease),
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

const SET_STATUS_BASE = [
  "--set-track-status",
  "--package-name",
  "com.seorilabs.example",
  "--track",
  "internal",
  "--version-code",
  "1001000017",
  "--release-status",
  "completed",
];

// draft 로 올라간 build 는 트랙에 있어도 테스터에게 가지 않는다. versionCode 는
// 재사용할 수 없어 다시 업로드할 수도 없다. 이 모드가 유일한 복구 경로다.
test("상태 변경은 AAB 없이 트랙 릴리스 상태만 올린다", async () => {
  const { status, stdout, calls } = await runPromote(SET_STATUS_BASE, {
    sourceVersionCodes: ["1001000017"],
    sourceRelease: { name: "lucid-chess 1.0.17", status: "draft" },
  });
  assert.equal(status, 0, stdout);
  assert.deepEqual(JSON.parse(stdout), {
    packageName: "com.seorilabs.example",
    releaseStatus: "completed",
    track: "internal",
    versionCode: 1001000017,
  });
  assert.deepEqual(
    calls.map(({ call }) => call),
    ["edits.insert", "tracks.get", "tracks.update", "edits.commit"],
  );
  const update = calls.find(({ call }) => call === "tracks.update");
  assert.equal(update.track, "internal");
  assert.equal(update.body.releases[0].status, "completed");
  assert.deepEqual(update.body.releases[0].versionCodes, ["1001000017"]);
});

test("상태 변경은 트랙에 있던 이름과 출시노트를 지우지 않는다", async () => {
  // tracks.update 는 트랙의 releases 를 통째로 교체한다. 빠뜨리면 조용히 사라진다.
  const notes = [{ language: "ko-KR", text: "버그를 고쳤습니다." }];
  const { status, calls } = await runPromote(SET_STATUS_BASE, {
    sourceVersionCodes: ["1001000017"],
    sourceRelease: { name: "lucid-chess 1.0.17", status: "draft", releaseNotes: notes },
  });
  assert.equal(status, 0);
  const release = calls.find(({ call }) => call === "tracks.update").body.releases[0];
  assert.equal(release.name, "lucid-chess 1.0.17");
  assert.deepEqual(release.releaseNotes, notes);
});

test("트랙에 없는 versionCode 는 상태를 바꾸지 않고 edit 를 정리한다", async () => {
  const { status, stderr, calls } = await runPromote(SET_STATUS_BASE, {
    sourceVersionCodes: ["1001000099"],
  });
  assert.equal(status, 1);
  assert.match(stderr, /GOOGLE_PLAY_TRACK_MISSING_VERSION_CODE/);
  assert.ok(!calls.some(({ call }) => call === "tracks.update"));
  assert.ok(calls.some(({ call }) => call === "edits.delete"));
});

test("상태 변경 모드는 업로드·승격 인자와 섞이지 않는다", async () => {
  const withPromote = await runPromote([...SET_STATUS_BASE, "--promote"]);
  assert.equal(withPromote.status, 2);
  assert.match(
    withPromote.stderr,
    /--promote and --set-track-status are mutually exclusive/,
  );

  const withAab = await runPromote([...SET_STATUS_BASE, "--aab-path", "/tmp/none.aab"]);
  assert.equal(withAab.status, 2);
  assert.match(withAab.stderr, /--aab-path is not valid with --set-track-status/);

  const withoutVersionCode = await runPromote([
    "--set-track-status",
    "--package-name",
    "com.seorilabs.example",
    "--track",
    "internal",
  ]);
  assert.equal(withoutVersionCode.status, 2);
  assert.match(withoutVersionCode.stderr, /--set-track-status requires --version-code/);
});

// draft 는 올려두고 잊으면 테스터가 옛 빌드에 묶인다. 실제로 그렇게 묶인 적이 있어
// 기본값을 completed 로 두고, draft 가 필요하면 호출자가 명시하게 한다.
test("release-status 기본값은 completed 다", async () => {
  const args = [...SET_STATUS_BASE];
  args.splice(args.indexOf("--release-status"), 2);
  const { status, stdout } = await runPromote(args, {
    sourceVersionCodes: ["1001000017"],
    sourceRelease: { name: "lucid-chess 1.0.17", status: "draft" },
  });
  assert.equal(status, 0, stdout);
  assert.equal(JSON.parse(stdout).releaseStatus, "completed");
});
