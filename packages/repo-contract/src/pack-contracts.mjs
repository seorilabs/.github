import { realpathSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const packageRoot = fileURLToPath(new URL("..", import.meta.url));
export const generatedRoot = resolve(packageRoot, ".generated");

export async function clean() {
  await rm(generatedRoot, { force: true, recursive: true });
}

export async function prepare() {
  await clean();
  await mkdir(generatedRoot, { recursive: true });
  await Promise.all([
    cp(resolve(packageRoot, "../../contracts"), resolve(generatedRoot, "contracts"), {
      recursive: true,
    }),
    cp(resolve(packageRoot, "../../profiles"), resolve(generatedRoot, "profiles"), {
      recursive: true,
    }),
    // release version authority는 org 정본 구현 하나뿐이다. 배포 패키지도 같은 파일을 쓴다.
    cp(resolve(packageRoot, "../../scripts/release"), resolve(generatedRoot, "release"), {
      recursive: true,
    }),
  ]);
}

let isEntrypoint = false;
try {
  isEntrypoint =
    Boolean(process.argv[1]) &&
    realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
} catch {
  isEntrypoint = false;
}

if (isEntrypoint) {
  const command = process.argv[2];
  if (command === "prepare") {
    await prepare();
  } else if (command === "clean") {
    await clean();
  } else {
    process.stderr.write("사용법: pack-contracts.mjs prepare|clean\n");
    process.exitCode = 2;
  }
}
