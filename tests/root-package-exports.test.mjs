import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const pkg = JSON.parse(
  readFileSync(new URL("../packages/repo-contract/package.json", import.meta.url), "utf8"),
);

// 소비자(Backoffice)는 이 저장소를 git dependency로 설치하고 root exports를 통해서만
// 계약 구현에 닿는다. root에 없는 모듈은 소비자가 같은 규칙을 복제하게 만든다.
test("root exports는 repo-contract 모듈을 같은 이름으로 노출한다", () => {
  const rootModules = Object.keys(root.exports)
    .filter((key) => key.startsWith("./repo-contract/"))
    .map((key) => key.replace("./repo-contract/", ""));
  const packageModules = new Set(
    Object.keys(pkg.exports).map((key) => key.replace(/^\.\/?/u, "")).filter(Boolean),
  );

  for (const name of rootModules) {
    const target = root.exports[`./repo-contract/${name}`];
    assert.equal(typeof target, "string", name);
    // github-settings-readback은 scripts/fleet 아래에 있어 repo-contract 패키지에 없다.
    if (target.startsWith("./packages/repo-contract/")) {
      assert.ok(packageModules.has(name), `${name}이 repo-contract exports에 없습니다`);
    }
  }

  assert.ok(rootModules.includes("workflow-bundle-v5"));
});

test("root exports가 가리키는 파일은 실제로 불러올 수 있다", async () => {
  for (const [name, target] of Object.entries(root.exports)) {
    if (!name.startsWith("./repo-contract/")) continue;
    const module = await import(new URL(`../${target.replace(/^\.\//u, "")}`, import.meta.url));
    assert.equal(typeof module, "object", name);
  }
});
