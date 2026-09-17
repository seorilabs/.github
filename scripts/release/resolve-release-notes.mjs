#!/usr/bin/env node
// 태그 Release에 붙은 정형 출시노트(release-notes.json)를 마켓 업로드 스텝에 넘긴다.
//
// 이 스크립트가 생긴 이유는 gh CLI다. 워크플로는 `gh release download ... 2>/dev/null` 로
// 자산을 받았는데 ARC 러너 이미지에 gh가 없어 exit 127로 죽었고, `2>/dev/null` 이 그 사유를
// 지워 「자산 없음」처럼 보이게 만들었다. 승격은 성공으로 끝나고 스토어에는 출시노트 없는
// 릴리스가 나갔다(seorilabs/.github#166).
//
// 그래서 두 가지를 지킨다.
//   1. 실패 사유를 버리지 않는다. REST 응답의 status와 본문을 그대로 로그에 남긴다.
//   2. 「자산이 없다」와 「자산은 있는데 못 읽었다」를 가른다. 후자는 그 자리에서 멈춘다.
//      출시노트 없이 조용히 승격하는 것보다 실패하는 편이 낫다.
import { appendFileSync, writeFileSync } from 'node:fs';

import { GitHubRestError, githubDownload, githubJson } from '../github-rest.mjs';

const DEFAULT_ASSET_NAME = 'release-notes.json';
const FLAGS = new Set(['github-output', 'json']);

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new GitHubRestError(`알 수 없는 인자: ${argument}`);
    }
    const key = argument.slice(2);
    if (FLAGS.has(key)) {
      args.set(key, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new GitHubRestError(`--${key} 값이 없다.`);
    }
    args.set(key, value);
    index += 1;
  }
  return args;
}

function pick(args, key, envKey, env, fallback = '') {
  const value = args.get(key) ?? env[envKey] ?? fallback;
  return typeof value === 'string' ? value.trim() : value;
}

// notes가 하나라도 있어야 쓸모가 있다. 자산은 받았는데 비어 있으면 업로더가 releaseNotes 키를
// 아예 붙이지 않아 결과가 「노트 없음」과 같아진다. 그 상태를 성공으로 넘기지 않는다.
function countNotes(document) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return -1;
  }
  const notes = document.notes;
  if (notes === null || typeof notes !== 'object' || Array.isArray(notes)) {
    return -1;
  }
  return Object.keys(notes).length;
}

export async function resolveReleaseNotes(options = {}) {
  const {
    repository,
    tag,
    outputPath,
    assetName = DEFAULT_ASSET_NAME,
    token,
    env = process.env,
    fetchImpl = globalThis.fetch,
    log = (line) => process.stdout.write(`${line}\n`),
  } = options;

  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository ?? '')) {
    throw new GitHubRestError(`저장소 형식이 owner/name이 아니다: ${repository ?? '(없음)'}`);
  }
  if (typeof tag !== 'string' || tag.length === 0) {
    throw new GitHubRestError('릴리스 태그가 필요하다.');
  }
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    throw new GitHubRestError('출시노트를 기록할 경로가 필요하다.');
  }

  const request = { token, env, fetchImpl };
  let release;
  try {
    release = await githubJson(
      `/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
      request,
    );
  } catch (error) {
    // Release 자체가 없는 태그는 자산도 없다. 그 밖의 실패(권한·네트워크·5xx)는 삼키지 않는다.
    if (error instanceof GitHubRestError && error.status === 404) {
      log(`태그 ${tag}에 GitHub Release가 없다 → 출시노트 없이 진행한다.`);
      return { found: false, reason: 'release-not-found' };
    }
    throw error;
  }

  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset = assets.find((candidate) => candidate?.name === assetName);
  if (asset === undefined) {
    log(`Release ${tag}에 ${assetName} 자산이 없다 → 출시노트 없이 진행한다.`);
    return { found: false, reason: 'asset-not-attached' };
  }

  // 여기부터는 자산이 실제로 붙어 있다. 무엇이 실패하든 조용히 넘어가지 않는다.
  const bytes = await githubDownload(`/repos/${repository}/releases/assets/${asset.id}`, request);

  let document;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new GitHubRestError(
      `${assetName} 자산(${bytes.length} bytes)이 Release에 붙어 있는데 JSON으로 읽히지 않는다: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const locales = countNotes(document);
  if (locales <= 0) {
    throw new GitHubRestError(
      `${assetName} 자산은 붙어 있는데 notes가 ${locales < 0 ? '객체가 아니다' : '비어 있다'}. ` +
        '출시노트 없이 승격하지 않는다.',
    );
  }

  // 업로더가 같은 원문을 검증하도록 받은 바이트를 그대로 기록한다.
  writeFileSync(outputPath, bytes);
  log(
    `${assetName} 로드(${bytes.length} bytes): ${Object.keys(document.notes).sort().join(', ')}`,
  );
  return { found: true, path: outputPath, locales, bytes: bytes.length, schema: document.schema };
}

async function main() {
  const env = process.env;
  const args = parseArgs(process.argv.slice(2));
  const result = await resolveReleaseNotes({
    repository: pick(args, 'repo', 'GITHUB_REPOSITORY', env),
    tag: pick(args, 'tag', 'RELEASE_TAG', env),
    outputPath: pick(args, 'output', 'RELEASE_NOTES_OUTPUT', env),
    assetName: pick(args, 'asset-name', 'RELEASE_NOTES_ASSET_NAME', env, DEFAULT_ASSET_NAME),
    env,
  });

  if (args.get('github-output') === true) {
    const outputPath = env.GITHUB_OUTPUT;
    if (typeof outputPath !== 'string' || outputPath.length === 0) {
      throw new GitHubRestError('--github-output에는 GITHUB_OUTPUT이 필요하다.');
    }
    const lines = [`found=${result.found}`];
    if (result.found) {
      lines.push(`path=${result.path}`, `locales=${result.locales}`);
    }
    appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
  }

  if (args.get('json') === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
