#!/usr/bin/env node
// 저장소의 모든 릴리스 태그와 원장을 대조하는 진단 명령.
//
// 릴리스 hot path에서는 실행하지 않는다(contracts/release-version-ledger.yaml audit.forbiddenIn).
// 태그가 수백 개인 저장소가 있고, 감사는 legacy 드리프트를 blocking으로 보고해야 의미가 있는데
// 같은 판정을 배포 경로에 넣으면 receipt 없는 앱이 전부 배포 불가가 된다.
// 진단은 문제를 말하고, gate는 배포를 막는다. 두 역할을 한 경로에 합치면 둘 다 못 한다.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RELEASE_TAG_PATTERN,
  ReleaseAuthorityError,
  computeAuthorityRevision,
  extractSupersededRevisions,
  parseLedger,
  parseTagReceipt,
} from './tag-version-authority.mjs';

const AUTHORITY_ID = 'release-version-authority-v1';
const LEDGER_ID = 'release-version-ledger-v1';
const LEDGER_BRANCH = 'release-version-ledger';
const LEDGER_FILE = 'release-version-ledger.json';
const FLAGS = new Set(['fetch']);
const BLOCKING = new Set([
  'tag-receipt-malformed',
  'tag-receipt-source-mismatch',
  'duplicate-android-version-code',
  'ledger-missing',
  'ledger-schema-invalid',
  'ledger-behind-latest-tag',
  'tag-version-code-above-ledger',
]);
const DEFAULT_AUTHORITY_CONTRACT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../contracts/release-version-authority.yaml',
);

function parseArgs(argv) {
  const args = new Map();
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
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
  return { args, positional };
}

function git(root, ...rest) {
  return execFileSync('git', ['-C', root, ...rest], { encoding: 'utf8' }).trim();
}

function gitOrNull(root, ...rest) {
  try {
    return git(root, ...rest);
  } catch {
    return null;
  }
}

function compareTags(left, right) {
  const parse = (tag) => RELEASE_TAG_PATTERN.exec(tag).slice(1, 4).map(Number);
  const [lm, ln, lp] = parse(left);
  const [rm, rn, rp] = parse(right);
  return lm - rm || ln - rn || lp - rp;
}

export function auditReleaseTags({ root, fullName, observedAt, authorityContract }) {
  const authorityRevision = computeAuthorityRevision(authorityContract);
  const supersededRevisions = extractSupersededRevisions(authorityContract);
  const findings = [];
  const add = (id, detail, ref) => {
    findings.push({ id, severity: BLOCKING.has(id) ? 'blocking' : 'advisory', detail, ...(ref === undefined ? {} : { ref }) });
  };

  const ledgerTip = { present: false };
  const ledgerRef = gitOrNull(root, 'rev-parse', '--verify', `refs/remotes/origin/${LEDGER_BRANCH}^{commit}`)
    ?? gitOrNull(root, 'rev-parse', '--verify', `refs/heads/${LEDGER_BRANCH}^{commit}`);
  let ledger = null;
  if (ledgerRef === null) {
    add('ledger-missing', `refs/heads/${LEDGER_BRANCH} 를 찾지 못했다. 초기화되지 않은 저장소다.`);
  } else {
    ledgerTip.present = true;
    ledgerTip.commit = ledgerRef;
    const text = gitOrNull(root, 'show', `${ledgerRef}:${LEDGER_FILE}`);
    try {
      ledger = parseLedger(text ?? '');
      ledgerTip.schemaValid = true;
      ledgerTip.lastTag = ledger.release.lastTag;
      ledgerTip.lastSourceSha = ledger.release.lastSourceSha;
      ledgerTip.androidLastVersionCode = ledger.android.lastVersionCode;
      ledgerTip.legacyFallbackSealed = ledger.android.legacyFallbackSealed;
      ledgerTip.iosLastObservedBuildNumber = ledger.ios.lastObservedBuildNumber;
    } catch (error) {
      ledgerTip.schemaValid = false;
      add('ledger-schema-invalid', `원장 tip JSON이 계약을 만족하지 않는다: ${error.message}`);
    }
  }

  const listed = gitOrNull(root, 'for-each-ref', '--format=%(refname:short)%09%(objecttype)%09%(objectname)', 'refs/tags/');
  const tags = [];
  for (const line of (listed ?? '').split('\n').filter((entry) => entry.length > 0)) {
    const [tag, objectType, objectName] = line.split('\t');
    if (RELEASE_TAG_PATTERN.exec(tag) === null) {
      continue;
    }
    const commit = gitOrNull(root, 'rev-parse', `refs/tags/${tag}^{commit}`);
    const refType = objectType === 'tag' ? 'annotated' : 'lightweight';
    const entry = {
      tag,
      refType,
      commit,
      receipt: 'absent',
      authorityRevision: null,
      authorityRevisionKnown: null,
      versionName: null,
      androidVersionCode: null,
      androidVersionCodeSource: null,
      sourceShaMatchesTag: null,
    };

    if (refType === 'lightweight') {
      add('tag-lightweight', `${tag}: lightweight 태그라 binding receipt를 담을 수 없다`, `refs/tags/${tag}`);
      tags.push(entry);
      continue;
    }

    const message = gitOrNull(root, 'for-each-ref', '--format=%(contents)', `refs/tags/${tag}`);
    const receipt = message === null ? null : parseTagReceipt(message);
    if (receipt === null) {
      add('tag-receipt-absent', `${tag}: receipt 없는 annotated 태그다`, `refs/tags/${tag}`);
      tags.push(entry);
      continue;
    }
    if (receipt.tag !== tag || receipt.sourceSha.length === 0 || receipt.androidVersionCode.length === 0) {
      entry.receipt = 'malformed';
      add('tag-receipt-malformed', `${tag}: receipt 필드가 비었거나 태그 이름이 다르다`, `refs/tags/${tag}`);
      tags.push(entry);
      continue;
    }

    entry.receipt = 'present';
    entry.authorityRevision = receipt.authorityRevision;
    entry.versionName = receipt.versionName;
    entry.androidVersionCode = Number(receipt.androidVersionCode);
    entry.androidVersionCodeSource = receipt.androidVersionCodeSource.length > 0 ? receipt.androidVersionCodeSource : null;
    entry.sourceShaMatchesTag = receipt.sourceSha === commit;
    if (entry.sourceShaMatchesTag === false) {
      add('tag-receipt-source-mismatch', `${tag}: receipt의 source SHA가 태그 commit과 다르다`, `refs/tags/${tag}`);
    }
    entry.authorityRevisionKnown =
      receipt.authorityRevision === authorityRevision
        ? 'current'
        : supersededRevisions.some((item) => item.revision === receipt.authorityRevision)
          ? 'superseded'
          : 'unknown';
    if (entry.authorityRevisionKnown !== 'current') {
      add(
        'authority-revision-stale',
        `${tag}: ${entry.authorityRevisionKnown === 'superseded' ? '등록된 구' : '등록되지 않은'} 계약 revision의 receipt다`,
        `refs/tags/${tag}`,
      );
    }
    tags.push(entry);
  }

  tags.sort((left, right) => compareTags(left.tag, right.tag));

  const byCode = new Map();
  for (const entry of tags) {
    if (entry.androidVersionCode === null) {
      continue;
    }
    const bucket = byCode.get(entry.androidVersionCode) ?? [];
    bucket.push(entry.tag);
    byCode.set(entry.androidVersionCode, bucket);
  }
  const duplicateAndroidVersionCodes = [...byCode.entries()]
    .filter(([, bucket]) => bucket.length > 1)
    .map(([androidVersionCode, bucket]) => ({ androidVersionCode, tags: bucket }))
    .sort((left, right) => left.androidVersionCode - right.androidVersionCode);
  for (const duplicate of duplicateAndroidVersionCodes) {
    add(
      'duplicate-android-version-code',
      `versionCode ${duplicate.androidVersionCode} 가 태그 ${duplicate.tags.join(', ')} 에 중복됐다`,
    );
  }

  const ledgerDrift = [];
  if (ledger !== null) {
    const latestTag = tags.at(-1)?.tag ?? null;
    if (latestTag !== null && ledger.release.lastTag !== null && compareTags(ledger.release.lastTag, latestTag) < 0) {
      ledgerDrift.push({ id: 'ledger-behind-latest-tag', ledgerValue: ledger.release.lastTag, observedValue: latestTag });
      add('ledger-behind-latest-tag', `원장의 lastTag(${ledger.release.lastTag})가 실제 최신 태그(${latestTag})보다 뒤다`);
    }
    if (latestTag === null && ledger.release.lastTag !== null) {
      ledgerDrift.push({ id: 'ledger-ahead-of-tags', ledgerValue: ledger.release.lastTag, observedValue: null });
      add('ledger-ahead-of-tags', `원장에는 lastTag가 있는데 저장소에 stable 태그가 없다`);
    }
    for (const entry of tags) {
      if (entry.androidVersionCodeSource === 'github-ledger' && entry.androidVersionCode > ledger.android.lastVersionCode) {
        ledgerDrift.push({
          id: 'tag-version-code-above-ledger',
          ledgerValue: ledger.android.lastVersionCode,
          observedValue: entry.androidVersionCode,
          tag: entry.tag,
        });
        add(
          'tag-version-code-above-ledger',
          `${entry.tag}: 원장이 할당했다는 번호가 원장 최신값보다 크다`,
          `refs/tags/${entry.tag}`,
        );
      }
    }
  }

  findings.sort((left, right) => `${left.id}${left.ref ?? ''}`.localeCompare(`${right.id}${right.ref ?? ''}`));
  const hasBlocking = findings.some(({ severity }) => severity === 'blocking');

  return {
    schemaVersion: 1,
    authority: AUTHORITY_ID,
    ledger: LEDGER_ID,
    repository: { fullName, root },
    observedAt,
    currentAuthorityRevision: authorityRevision,
    ledgerTip,
    tagCount: tags.length,
    tags,
    duplicateAndroidVersionCodes,
    tagsWithoutReceipt: tags.filter(({ receipt }) => receipt !== 'present').map(({ tag }) => tag),
    staleAuthorityRevisions: tags
      .filter(({ authorityRevisionKnown }) => authorityRevisionKnown === 'superseded' || authorityRevisionKnown === 'unknown')
      .map(({ tag, authorityRevision: revision, authorityRevisionKnown }) => ({
        tag,
        authorityRevision: revision,
        known: authorityRevisionKnown,
      })),
    ledgerDrift,
    findings,
    status: ledgerTip.present === false ? 'NEEDS_INPUT' : hasBlocking ? 'NEEDS_CHANGE' : 'READY',
  };
}

function main() {
  const { args, positional } = parseArgs(process.argv.slice(2));
  const root = resolve(positional[0] ?? '.');
  const fullName = args.get('full-name') ?? process.env.RELEASE_REPOSITORY_FULL_NAME ?? '';
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(fullName)) {
    throw new ReleaseAuthorityError('tag-pattern-mismatch', `--full-name 이 owner/repo 형식이어야 한다: ${fullName || 'missing'}`);
  }
  if (args.get('fetch') === true) {
    // 진단 명령에서만 전수 조회를 한다. 읽기 전용이다.
    execFileSync('git', ['-C', root, 'fetch', '--force', 'origin', '+refs/tags/*:refs/tags/*'], { stdio: 'ignore' });
    execFileSync(
      'git',
      ['-C', root, 'fetch', '--no-tags', '--force', 'origin', `+refs/heads/${LEDGER_BRANCH}:refs/remotes/origin/${LEDGER_BRANCH}`],
      { stdio: 'ignore' },
    );
  }

  const report = auditReleaseTags({
    root,
    fullName,
    observedAt: (args.get('observed-at') ?? new Date().toISOString()).replace(/\.\d+Z$/u, 'Z'),
    authorityContract: readFileSync(args.get('authority-contract') ?? DEFAULT_AUTHORITY_CONTRACT, 'utf8'),
  });

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const outPath = args.get('out') ?? '';
  if (outPath.length > 0) {
    writeFileSync(outPath, serialized, 'utf8');
  }
  process.stdout.write(serialized);
  return report.status === 'READY' ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
