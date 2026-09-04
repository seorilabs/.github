import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

// 소비자는 이 저장소를 git dependency로 설치한다. 그때 받는 파일은 package.json의
// files 목록뿐이다. export가 열려 있어도 그 모듈이 읽는 파일이 목록에 없으면 import가
// 깨진다. 여기서는 files만 복제한 트리를 만들어 실제로 불러본다.
test("published file set만으로 root exports를 불러올 수 있다", async (t) => {
  const staged = mkdtempSync(join(tmpdir(), "org-contracts-package-"));
  t.after(() => rmSync(staged, { recursive: true, force: true }));

  cpSync(join(repoRoot, "package.json"), join(staged, "package.json"));
  for (const entry of manifest.files) {
    const source = join(repoRoot, entry);
    assert.ok(existsSync(source), `files 목록의 ${entry}가 저장소에 없습니다`);
    mkdirSync(dirname(join(staged, entry)), { recursive: true });
    cpSync(source, join(staged, entry), { recursive: true });
  }
  cpSync(join(repoRoot, "node_modules"), join(staged, "node_modules"), { recursive: true });

  for (const [name, target] of Object.entries(manifest.exports)) {
    const path = join(staged, target.replace(/^\.\//u, ""));
    assert.ok(existsSync(path), `${name}이 가리키는 ${target}이 published set에 없습니다`);
    const module = await import(pathToFileURL(path).href);
    assert.equal(typeof module, "object", name);
  }
});
