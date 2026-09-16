#!/usr/bin/env node
// Xcode Cloud가 발급한 iOS build number를 App Store Connect readback으로 확인한 뒤 원장에
// 관측값으로 기록한다.
//
// 이 경로는 번호를 할당하지 않는다. CFBundleVersion의 정본은 여전히 Xcode Cloud의
// CI_BUILD_NUMBER이고, 원장은 "무엇이 관측됐는지"만 남긴다. 그래서 iOS 재빌드나 실패가
// Android versionCode를 소비하지 않는다(contracts/release-version-authority.yaml iosObservation).
import { readFileSync, writeFileSync } from 'node:fs';

import {
  ReleaseAuthorityError,
  applyIosObservation,
  deriveMarketingVersion,
  parseLedger,
  parseReleaseTag,
  renderLedger,
} from './tag-version-authority.mjs';

const READBACK_KIND = 'xcode-cloud-build-readback';
const FLAGS = new Set(['json']);

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new ReleaseAuthorityError('ios-observation-unverified', `알 수 없는 인자: ${argument}`);
    }
    const key = argument.slice(2);
    if (FLAGS.has(key)) {
      args.set(key, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ReleaseAuthorityError('ios-observation-unverified', `--${key} 값이 없다.`);
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
 * App Store Connect readback 결과에서 관측값을 꺼낸다. 형태가 조금이라도 다르면 기록하지 않는다.
 * 확인되지 않은 값을 원장에 넣으면 이후 어떤 판정도 신뢰할 수 없다.
 */
export function parseIosReadback(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReleaseAuthorityError('ios-observation-unverified', 'iOS readback JSON을 파싱하지 못했다.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ReleaseAuthorityError('ios-observation-unverified', 'iOS readback은 객체여야 한다.');
  }
  if (parsed.kind !== READBACK_KIND) {
    throw new ReleaseAuthorityError(
      'ios-observation-unverified',
      `iOS readback kind가 ${READBACK_KIND} 이어야 한다: ${parsed.kind ?? 'missing'}`,
    );
  }
  if (parsed.buildNumberAuthority !== 'xcode-cloud-ci-build-number') {
    throw new ReleaseAuthorityError(
      'ios-observation-unverified',
      `build number 정본이 xcode-cloud-ci-build-number 여야 한다: ${parsed.buildNumberAuthority ?? 'missing'}`,
    );
  }
  const tag = parseReleaseTag(parsed.tag).tag;
  // 마케팅 버전의 정본은 여전히 태그 하나다. readback이 다른 값을 말하면 그 build는 다른 것이다.
  const expected = deriveMarketingVersion(tag).versionName;
  if (parsed.marketingVersion !== expected) {
    throw new ReleaseAuthorityError(
      'ios-observation-unverified',
      `readback의 marketing version이 태그 파생값과 다르다: ${parsed.marketingVersion ?? 'missing'} != ${expected}`,
    );
  }
  return { tag, buildNumber: parsed.buildNumber };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const ledgerInPath = pick(args, 'ledger-in', 'RELEASE_LEDGER_FILE');
  if (ledgerInPath.length === 0) {
    throw new ReleaseAuthorityError('ledger-missing', '--ledger-in 으로 원장 JSON 경로가 필요하다.');
  }
  const ledger = parseLedger(readFileSync(ledgerInPath, 'utf8'));

  const readbackPath = pick(args, 'readback', 'RELEASE_IOS_READBACK');
  if (readbackPath.length === 0) {
    // 값을 인자로 직접 받지 않는다. 관측 증거 파일이 있어야 기록한다.
    throw new ReleaseAuthorityError('ios-observation-unverified', '--readback 으로 App Store Connect readback 파일이 필요하다.');
  }
  const { tag, buildNumber } = parseIosReadback(readFileSync(readbackPath, 'utf8'));

  const next = applyIosObservation({ ledger, tag, buildNumber });

  const ledgerOutPath = pick(args, 'ledger-out', 'RELEASE_LEDGER_OUT');
  if (ledgerOutPath.length > 0) {
    writeFileSync(ledgerOutPath, renderLedger(next), 'utf8');
  }

  if (args.get('json') === true) {
    process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
  } else {
    process.stdout.write(
      `ios observation ${tag} -> CFBundleVersion ${buildNumber} ` +
        `(androidVersionCode unchanged at ${next.android.lastVersionCode})\n`,
    );
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
