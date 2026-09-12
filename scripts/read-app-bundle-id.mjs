#!/usr/bin/env node
/**
 * 앱 저장소 설정 파일에서 iOS bundle id 한 값을 읽는다.
 *
 * 앱 신원은 저장소당 한 파일에만 둔다. 워크플로나 중앙 목록에 같은 값을 다시 적으면
 * 둘이 갈렸을 때 어느 쪽이 맞는지 알 수 없다.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{1,154}[A-Za-z0-9]$/u;

export function pickBundleId(config) {
  const candidates = [config?.bundleId, config?.app?.bundleId, config?.ios?.bundleId];
  const found = candidates.find((value) => typeof value === "string" && BUNDLE_ID.test(value));
  if (!found) throw new Error("설정 파일에서 bundle id를 찾지 못했습니다.");
  const mismatched = candidates.filter(
    (value) => typeof value === "string" && value !== found,
  );
  if (mismatched.length > 0) {
    throw new Error("설정 파일 안에서 bundle id가 서로 다릅니다.");
  }
  return found;
}

// 테스트가 순수 함수만 import할 수 있어야 한다. 직접 실행했을 때만 CLI로 동작한다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  try {
    if (!path) throw new Error("설정 파일 경로가 필요합니다.");
    process.stdout.write(`${pickBundleId(JSON.parse(readFileSync(path, "utf8")))}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
