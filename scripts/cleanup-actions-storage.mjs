#!/usr/bin/env node
// Actions 스토리지(아티팩트·캐시) 정리. 조직 재사용 워크플로
// `.github/workflows/cleanup-actions-storage.yml` 의 실행부다.
//
// 이 워크플로는 기본 러너가 `seorilabs-rpi-arm64` 인데 gh api로 목록을 받고 삭제했다. ARC 러너
// 이미지에는 gh가 없으므로 첫 실행에서 깨질 자리였다(호출자는 여러 저장소에 active인데 실행
// 이력이 0건이라 아직 드러나지 않았다). 러너 이미지를 건드리지 않고 닫으려고 REST로 옮겼다.
import { appendFileSync } from 'node:fs';

import { GitHubRestError, githubPaginate, githubVoid } from './github-rest.mjs';

const KINDS = {
  artifacts: {
    title: 'Workflow artifacts',
    listPath: (repo) => `/repos/${repo}/actions/artifacts?per_page=100`,
    select: (page) => page?.artifacts,
    deletePath: (repo, id) => `/repos/${repo}/actions/artifacts/${id}`,
    label: (item) => item?.name ?? '',
    emptyMessage: 'No workflow artifacts found.',
  },
  caches: {
    title: 'Actions caches',
    listPath: (repo) => `/repos/${repo}/actions/caches?per_page=100`,
    select: (page) => page?.actions_caches,
    deletePath: (repo, id) => `/repos/${repo}/actions/caches/${id}`,
    label: (item) => item?.key ?? '',
    emptyMessage: 'No Actions caches found.',
  },
};

export function humanBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Number.isFinite(bytes) ? bytes : 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(2)} ${units[unit]}`;
}

export async function cleanupActionsStorage(options = {}) {
  const {
    kind,
    repository,
    dryRun = false,
    token,
    env = process.env,
    fetchImpl = globalThis.fetch,
    log = (line) => process.stdout.write(`${line}\n`),
  } = options;

  const spec = KINDS[kind];
  if (spec === undefined) {
    throw new GitHubRestError(`알 수 없는 정리 대상: ${kind}. artifacts 또는 caches만 쓴다.`);
  }
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository ?? '')) {
    throw new GitHubRestError(`저장소 형식이 owner/name이 아니다: ${repository ?? '(없음)'}`);
  }

  const request = { token, env, fetchImpl };
  const items = await githubPaginate(spec.listPath(repository), {
    ...request,
    select: spec.select,
  });

  const bytes = items.reduce(
    (total, item) => total + (Number.isFinite(item?.size_in_bytes) ? item.size_in_bytes : 0),
    0,
  );

  if (items.length === 0) {
    log(spec.emptyMessage);
    return { title: spec.title, count: 0, bytes: 0, processed: 0, dryRun };
  }

  log(`Found ${items.length} ${spec.title.toLowerCase()} using ${humanBytes(bytes)}.`);

  let processed = 0;
  for (const item of items) {
    const size = Number.isFinite(item?.size_in_bytes) ? item.size_in_bytes : 0;
    if (dryRun) {
      log(`[dry-run] #${item.id} ${spec.label(item)} (${size} bytes)`);
    } else {
      log(`Deleting #${item.id} ${spec.label(item)} (${size} bytes)`);
      await githubVoid(spec.deletePath(repository, item.id), { ...request, method: 'DELETE' });
    }
    processed += 1;
  }

  return { title: spec.title, count: items.length, bytes, processed, dryRun };
}

function writeStepSummary(result, env) {
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (typeof summaryPath !== 'string' || summaryPath.length === 0) {
    return;
  }
  const lines = [`### ${result.title}`, '', `- candidates: ${result.count}`];
  if (result.count > 0) {
    lines.push(`- size: ${humanBytes(result.bytes)} (${result.bytes} bytes)`);
  }
  lines.push(`- processed: ${result.processed}`, `- dry_run: ${result.dryRun}`);
  appendFileSync(summaryPath, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const env = process.env;
  const kindIndex = process.argv.indexOf('--kind');
  const kind = kindIndex >= 0 ? process.argv[kindIndex + 1] : '';
  const result = await cleanupActionsStorage({
    kind,
    repository: (env.GH_REPO ?? env.GITHUB_REPOSITORY ?? '').trim(),
    dryRun: env.DRY_RUN === 'true',
    env,
  });
  writeStepSummary(result, env);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
