#!/usr/bin/env node
// Godot export preset의 version 값을 release tag 파생값으로 주입한다.
// export_presets.cfg와 project.godot은 version authority가 아니라 주입 대상이며,
// 실제 반영 여부는 build 이후 artifact readback에서 다시 검증한다.
import { readFileSync, writeFileSync } from 'node:fs';

import {
  ReleaseAuthorityError,
  applyGodotExportVersion,
  parseReleaseBinding,
} from './tag-version-authority.mjs';

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new ReleaseAuthorityError('artifact-provenance-mismatch', `알 수 없는 인자: ${argument}`);
    }
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ReleaseAuthorityError('artifact-provenance-mismatch', `--${key} 값이 없다.`);
    }
    args.set(key, value);
    index += 1;
  }
  return args;
}

function pick(args, key, envKey, fallback = '') {
  const value = args.get(key) ?? process.env[envKey] ?? fallback;
  return typeof value === 'string' ? value.trim() : value;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const bindingPath = pick(args, 'binding', 'RELEASE_BINDING_PATH');
  if (bindingPath.length === 0) {
    throw new ReleaseAuthorityError('artifact-provenance-mismatch', '--binding release binding 경로가 필요하다.');
  }
  const binding = parseReleaseBinding(readFileSync(bindingPath, 'utf8'));

  const platform = pick(args, 'platform', 'GODOT_EXPORT_PLATFORM');
  const presetsPath = pick(args, 'presets', 'GODOT_EXPORT_PRESETS_PATH');
  if (presetsPath.length === 0) {
    throw new ReleaseAuthorityError('artifact-provenance-mismatch', '--presets export_presets.cfg 경로가 필요하다.');
  }
  // 실제로 export하는 preset 하나만 바꾼다. 선택자가 없으면 같은 platform의 다른 preset을
  // 덮어쓸 수 있으므로 라이브러리가 fail-closed한다.
  const preset = pick(args, 'preset', 'GODOT_EXPORT_PRESET');

  const original = readFileSync(presetsPath, 'utf8');
  const patched = applyGodotExportVersion(original, { platform, binding, preset });
  writeFileSync(presetsPath, patched, 'utf8');

  process.stdout.write(
    `${platform} export preset ${preset} version <- ${binding.tag} ` +
      `(${binding.versionName} / android ${binding.androidVersionCode} / apple ${binding.appleBuildNumber})\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
