import assert from "node:assert/strict";
import test from "node:test";

import { pickBundleId } from "../scripts/read-app-bundle-id.mjs";

test("설정 파일의 bundle id를 읽는다", () => {
  assert.equal(pickBundleId({ bundleId: "com.seorilabs.jomul" }), "com.seorilabs.jomul");
  assert.equal(pickBundleId({ app: { bundleId: "com.etlegame.chess" } }), "com.etlegame.chess");
});

test("같은 파일 안에서 값이 갈리면 거부한다", () => {
  // 한 파일 안에서도 두 자리에 적히는 경우가 있다. 한쪽만 바뀐 채 빌드가 나가면
  // 엉뚱한 Xcode Cloud 제품으로 트리거된다.
  assert.throws(
    () => pickBundleId({ bundleId: "com.seorilabs.a", app: { bundleId: "com.seorilabs.b" } }),
    /서로 다릅니다/u,
  );
});

test("bundle id가 없거나 형식이 아니면 거부한다", () => {
  assert.throws(() => pickBundleId({}), /찾지 못했습니다/u);
  assert.throws(() => pickBundleId({ bundleId: "not a bundle id" }), /찾지 못했습니다/u);
});
