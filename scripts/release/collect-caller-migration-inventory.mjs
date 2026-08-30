#!/usr/bin/env node
// caller 저장소 하나를 release-version-authority-v1로 옮기기 위한 기계 판독 inventory를 만든다.
// 저장소를 수정하지 않고 읽기만 한다. 결과는 contracts/release-version-authority-migration.schema.json을
// 만족하는 JSON이며, fan-out 단계가 이 결과만 보고 저장소별 변경을 만든다.
//
// 사용법: node collect-caller-migration-inventory.mjs <저장소 경로> [--full-name seorilabs/<repo>]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ReleaseAuthorityError } from './tag-version-authority.mjs';

const MIGRATION_ID = 'release-version-authority-migration-v1';
const AUTHORITY_ID = 'release-version-authority-v1';
const CALLER_USES =
  /^seorilabs\/\.github\/(\.github\/workflows\/[a-z0-9-]+\.yml)@([0-9a-f]{40}|[^\s'"]+)$/u;
const REMOVED_INPUTS = Object.freeze(['version_name', 'version_code', 'version_script']);

/** called workflow 경로 하나가 어떤 caller kind인지 고정한다. */
export const CALLER_KIND_BY_WORKFLOW = Object.freeze({
  '.github/workflows/rn-deploy-google-play.yml': 'rn-deploy-google-play',
  '.github/workflows/godot-deploy-google-play.yml': 'godot-deploy-google-play',
  '.github/workflows/rn-deploy-app-store.yml': 'rn-deploy-app-store',
  '.github/workflows/godot-deploy-app-store.yml': 'godot-deploy-app-store',
  '.github/workflows/rn-deploy-ait.yml': 'rn-deploy-ait',
  '.github/workflows/godot-deploy-ait.yml': 'godot-deploy-ait',
  '.github/workflows/rn-build-android.yml': 'rn-build-android',
  '.github/workflows/release-tag.yml': 'release-tag',
  '.github/workflows/promote-google-play.yml': 'promote-google-play',
  '.github/workflows/ait-build-only-v1.yml': 'workflow-bundle-v5-ait-build-only',
  '.github/workflows/rn-build-android-cloud-v2.yml': 'workflow-bundle-v5-android-build-only',
  '.github/workflows/godot-build-android-cloud-v2.yml': 'workflow-bundle-v5-android-build-only',
});

/** caller 입력을 전혀 받지 않는 v5 정본. 남아 있는 with 입력은 모두 결함이다. */
const NO_INPUT_CALLER_KINDS = Object.freeze([
  'workflow-bundle-v5-ait-build-only',
  'workflow-bundle-v5-android-build-only',
]);

/**
 * 더 이상 존재하지 않는 caller 입력. 권한 있는 job의 러너는 caller가 고를 수 없게 고정했으므로
 * runs_on을 계속 넘기면 workflow_call이 unknown input으로 실패한다.
 */
const OBSOLETE_INPUTS_BY_KIND = Object.freeze({
  'release-tag': Object.freeze(['runs_on']),
  'godot-deploy-google-play': Object.freeze(['runs_on']),
});

const UPLOAD_TOOLS = Object.freeze({
  'rn-deploy-google-play': 'scripts/upload-google-play-internal.py',
  'godot-deploy-google-play': 'tools/upload_google_play_internal.py',
});

const BUILD_SCRIPT_ENVIRONMENT = Object.freeze({
  'workflow-bundle-v5-ait-build-only': {
    path: 'scripts/build-ait.sh',
    variables: ['SEORI_RELEASE_TAG', 'SEORI_RELEASE_VERSION'],
  },
  'workflow-bundle-v5-android-build-only': {
    path: 'scripts/build-android.sh',
    variables: ['SEORI_RELEASE_VERSION_NAME', 'SEORI_RELEASE_VERSION_CODE'],
  },
});

function readTextOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * caller workflow 하나에서 org 정본 호출을 찾는다. YAML 파서 의존을 피하려고 uses/with 줄만
 * 읽는다. caller는 생성기가 만든 thin caller라 구조가 고정돼 있다.
 */
export function collectCallerUses(text) {
  const lines = String(text ?? '').split('\n');
  const found = [];
  let current = null;
  let usesIndent = 0;
  let jobKey = 'unknown';
  for (const line of lines) {
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (job !== null) {
      jobKey = job[1];
      current = null;
      continue;
    }
    const uses = /^(\s*)uses:\s*['"]?([^'"\s#]+)['"]?/u.exec(line);
    if (uses !== null) {
      const match = CALLER_USES.exec(uses[2]);
      usesIndent = uses[1].length;
      current =
        match === null
          ? null
          : {
              jobKey,
              calledWorkflow: match[1],
              calledWorkflowSha: /^[0-9a-f]{40}$/u.test(match[2]) ? match[2] : null,
              inputs: [],
            };
      if (current !== null) {
        found.push(current);
      }
      continue;
    }
    if (current === null || line.trim().length === 0) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= usesIndent) {
      // 같은 job의 다른 key(with, secrets, permissions)까지만 따라간다.
      if (!/^(with|secrets|permissions):\s*$/u.test(line.trim())) {
        current = null;
      }
      continue;
    }
    const input = /^\s+([a-z0-9_]+):/u.exec(line);
    if (input !== null) {
      current.inputs.push(input[1]);
    }
  }
  return found;
}

function workflowFiles(root) {
  const directory = join(root, '.github', 'workflows');
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => name.endsWith('.yml'))
    .sort()
    .map((name) => ({ path: `.github/workflows/${name}`, absolute: join(directory, name) }));
}

/** 저장소 하나의 이관 필요 항목을 판정한다. 저장소를 수정하지 않는다. */
export function collectCallerMigrationInventory(root, fullName) {
  const callers = [];
  const findings = [];
  const kinds = new Set();

  for (const file of workflowFiles(root)) {
    const text = readTextOrNull(file.absolute);
    if (text === null) {
      continue;
    }
    for (const use of collectCallerUses(text)) {
      const callerKind = CALLER_KIND_BY_WORKFLOW[use.calledWorkflow];
      if (callerKind === undefined) {
        continue;
      }
      kinds.add(callerKind);
      callers.push({
        path: file.path,
        callerKind,
        calledWorkflow: use.calledWorkflow,
        calledWorkflowSha: use.calledWorkflowSha,
        jobKey: use.jobKey,
      });
      if (use.calledWorkflowSha === null) {
        findings.push({
          id: 'caller-ref-not-pinned',
          severity: 'blocking',
          path: file.path,
          detail: `${use.calledWorkflow} 호출이 40자리 commit SHA로 고정되지 않았다.`,
        });
      }
      for (const input of use.inputs) {
        if (REMOVED_INPUTS.includes(input)) {
          findings.push({
            id: 'forbidden-version-input',
            severity: 'blocking',
            path: file.path,
            detail: `caller가 제거된 version 입력 ${input}을 넘긴다.`,
          });
        } else if ((OBSOLETE_INPUTS_BY_KIND[callerKind] ?? []).includes(input)) {
          findings.push({
            id: 'obsolete-caller-input',
            severity: 'blocking',
            path: file.path,
            detail: `${use.calledWorkflow}에서 제거된 입력 ${input}을 넘긴다. 러너는 중앙에서 고정한다.`,
          });
        } else if (NO_INPUT_CALLER_KINDS.includes(callerKind)) {
          findings.push({
            id: 'forbidden-caller-input',
            severity: 'blocking',
            path: file.path,
            detail: `${use.calledWorkflow}은 caller 입력을 받지 않는데 ${input}을 넘긴다.`,
          });
        }
      }
      if (callerKind === 'godot-deploy-google-play' && !use.inputs.includes('android_export_preset')) {
        findings.push({
          id: 'godot-export-preset-not-declared',
          severity: 'advisory',
          path: file.path,
          detail: 'export preset 이름이 Android가 아니면 android_export_preset을 명시해야 한다.',
        });
      }
    }
  }

  if (existsSync(join(root, 'scripts', 'resolve-release-version.mjs'))) {
    findings.push({
      id: 'repository-local-version-resolver',
      severity: 'blocking',
      path: 'scripts/resolve-release-version.mjs',
      detail: '저장소 로컬 version resolver는 authority가 아니므로 제거해야 한다.',
    });
  }

  for (const [path, keys] of [
    ['play-store/google-play.config.json', ['versionName', 'versionCode']],
    ['app-store/app-store.config.json', ['version']],
  ]) {
    const text = readTextOrNull(join(root, path));
    if (text === null) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const release = parsed?.release ?? {};
    for (const key of keys) {
      if (release[key] !== undefined) {
        findings.push({
          id: 'market-config-version-authority',
          severity: 'blocking',
          path: `${path}#release.${key}`,
          detail: '마켓 config JSON은 version authority가 아니므로 값을 제거해야 한다.',
        });
      }
    }
  }

  for (const kind of kinds) {
    const tool = UPLOAD_TOOLS[kind];
    if (tool !== undefined) {
      const text = readTextOrNull(join(root, tool));
      if (text === null || !text.includes('--aab-path')) {
        findings.push({
          id: 'upload-tool-missing-verified-path',
          severity: 'blocking',
          path: tool,
          detail: '업로드 도구가 --aab-path로 받은 검증된 파일만 올려야 한다.',
        });
      }
    }
    const script = BUILD_SCRIPT_ENVIRONMENT[kind];
    if (script !== undefined) {
      const text = readTextOrNull(join(root, script.path));
      const missing = script.variables.filter((variable) => !(text ?? '').includes(variable));
      if (missing.length > 0) {
        findings.push({
          id: 'build-script-ignores-release-environment',
          severity: 'blocking',
          path: script.path,
          detail: `build script가 태그 파생 환경변수를 읽지 않는다: ${missing.join(', ')}`,
        });
      }
    }
  }

  findings.sort((left, right) =>
    `${left.id}${left.path}`.localeCompare(`${right.id}${right.path}`),
  );

  return {
    schemaVersion: 1,
    authority: AUTHORITY_ID,
    migration: MIGRATION_ID,
    repository: { fullName, root },
    callers,
    findings,
    status: findings.some(({ severity }) => severity === 'blocking') ? 'NEEDS_CHANGE' : 'READY',
  };
}

function main() {
  const [rootArgument, ...rest] = process.argv.slice(2);
  if (rootArgument === undefined || rootArgument.startsWith('--')) {
    throw new ReleaseAuthorityError('tag-pattern-mismatch', '저장소 경로가 필요하다.');
  }
  const root = resolve(rootArgument);
  let fullName = `seorilabs/${basename(root)}`;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--full-name') {
      fullName = rest[index + 1] ?? fullName;
      index += 1;
    }
  }
  process.stdout.write(
    `${JSON.stringify(collectCallerMigrationInventory(root, fullName), null, 2)}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
