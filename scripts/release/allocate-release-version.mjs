#!/usr/bin/env node
// 저장소 원장에서 다음 릴리스 번호를 할당하는 org 정본 CLI.
//
// 이 스크립트는 순수 변환이다. git을 호출하지 않고, 앱 저장소의 어떤 파일도 읽지 않으며,
// 원장 JSON 하나를 받아 다음 원장 JSON을 내놓을 뿐이다. ref를 실제로 움직이는 것은
// release-tag.yml의 atomic push 하나뿐이고, 그래야 번호 할당과 태그 생성이 같이 반영되거나
// 같이 반영되지 않는다.
//
// 번호를 만드는 경로는 여기 하나뿐이다. 배포 경로는 재계산하지 않고 tag receipt를 판독한다.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

import {
  ReleaseAuthorityError,
  allocateNextAndroidVersionCode,
  applyAndroidAllocation,
  deriveMarketingVersion,
  parseLedger,
  parseReleaseTag,
  renderLedger,
} from './tag-version-authority.mjs';

const FLAGS = new Set(['print-tag', 'github-output']);
const BUMPS = new Set(['major', 'minor', 'patch']);

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new ReleaseAuthorityError('tag-pattern-mismatch', `알 수 없는 인자: ${argument}`);
    }
    const key = argument.slice(2);
    if (FLAGS.has(key)) {
      args.set(key, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ReleaseAuthorityError('tag-pattern-mismatch', `--${key} 값이 없다.`);
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

/**
 * 태그를 명시하지 않았을 때 다음 태그를 정한다. 기준은 전체 태그 목록이 아니라 원장의
 * release.lastTag 하나다. 원장이 릴리스 이력의 정본이므로 여기서도 그것만 읽는다.
 *
 * lastTag가 null이면 bump하지 않는다. provider readback만으로 초기화한 원장은 번호 baseline은
 * 있어도 태그 이력이 없어서, 없는 값을 v0.0.0으로 대신하면 이미 v1.10.3까지 나간 앱에
 * v0.0.1을 만들어 버린다. 숫자는 원장이 올려주므로 겉으로는 성공한 것처럼 보이고, 그 태그가
 * 다시 lastTag가 되어 이후 bump까지 오염시킨다. 추측하지 않고 운영자에게 태그를 요구한다.
 */
function nextTagFromLedger(ledger, bump) {
  if (!BUMPS.has(bump)) {
    throw new ReleaseAuthorityError('tag-pattern-mismatch', `지원하지 않는 bump 단위다: ${bump || 'missing'}`);
  }
  if (ledger.release.lastTag === null) {
    throw new ReleaseAuthorityError(
      'ledger-last-tag-unknown',
      '원장에 release.lastTag가 없어 bump할 기준이 없다. 이 저장소의 첫 릴리스는 태그를 명시해야 한다.',
    );
  }
  const { major, minor, patch } = parseReleaseTag(ledger.release.lastTag);
  if (bump === 'major') {
    return `v${major + 1}.0.0`;
  }
  if (bump === 'minor') {
    return `v${major}.${minor + 1}.0`;
  }
  return `v${major}.${minor}.${patch + 1}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const ledgerInPath = pick(args, 'ledger-in', 'RELEASE_LEDGER_FILE');
  if (ledgerInPath.length === 0) {
    throw new ReleaseAuthorityError('ledger-missing', '--ledger-in으로 원장 JSON 경로가 필요하다.');
  }
  const ledger = parseLedger(readFileSync(ledgerInPath, 'utf8'));

  const requestedTag = pick(args, 'tag', 'RELEASE_TAG');
  const tag =
    requestedTag.length > 0
      ? parseReleaseTag(requestedTag).tag
      : nextTagFromLedger(ledger, pick(args, 'bump', 'RELEASE_BUMP', 'patch'));

  if (args.get('print-tag') === true) {
    // 번호를 할당하기 전 단계. 대상 태그 ref가 이미 있는지 먼저 확인해야 하므로 이름만 준다.
    process.stdout.write(`${tag}\n`);
    return;
  }

  const sourceSha = pick(args, 'source-sha', 'RELEASE_SOURCE_SHA');
  const androidVersionCode = allocateNextAndroidVersionCode(ledger);
  const nextLedger = applyAndroidAllocation({ ledger, tag, sourceSha, androidVersionCode });
  const version = deriveMarketingVersion(tag);

  const ledgerOutPath = pick(args, 'ledger-out', 'RELEASE_LEDGER_OUT');
  if (ledgerOutPath.length > 0) {
    writeFileSync(ledgerOutPath, renderLedger(nextLedger), 'utf8');
  }

  const lines = [
    `SEORI_RELEASE_TAG=${tag}`,
    `SEORI_RELEASE_VERSION_NAME=${version.versionName}`,
    `SEORI_ANDROID_VERSION_CODE=${androidVersionCode}`,
    `SEORI_ANDROID_VERSION_CODE_SOURCE=github-ledger`,
    `SEORI_LEDGER_PREVIOUS_VERSION_CODE=${ledger.android.lastVersionCode}`,
  ];

  const envOutPath = pick(args, 'env-out', 'RELEASE_ALLOCATION_ENV');
  if (envOutPath.length > 0) {
    // 워크플로가 그대로 source하는 파일이다. 값은 전부 태그·정수라 따옴표가 필요 없다.
    writeFileSync(envOutPath, `${lines.join('\n')}\n`, 'utf8');
  }

  if (args.get('github-output') === true) {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (typeof outputPath !== 'string' || outputPath.length === 0) {
      throw new ReleaseAuthorityError('ledger-malformed', '--github-output에는 GITHUB_OUTPUT이 필요하다.');
    }
    appendFileSync(
      outputPath,
      `${['tag=' + tag, 'android_version_code=' + androidVersionCode].join('\n')}\n`,
      'utf8',
    );
  }

  process.stdout.write(
    `release allocation ${tag} -> androidVersionCode ${androidVersionCode} ` +
      `(previous ${ledger.android.lastVersionCode})\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
