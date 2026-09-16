#!/usr/bin/env node
// 저장소의 release-version-ledger 브랜치를 초기화할 수 있는지 읽기 전용으로 판정한다.
//
// 이 스크립트는 저장소를 바꾸지 않는다. 기준 번호를 추측하지도 않는다. 검증된 근거가 없으면
// NEEDS_INPUT으로 멈추고 사람에게 정확히 무엇이 필요한지 기계 판독 가능한 형태로 남긴다.
// 잘못된 기준 번호는 이후 모든 릴리스 번호를 오염시키므로 여기서만큼은 추정을 허용하지 않는다.
//
// 태그 전수 조회는 여기서만 한다. 초기화는 저장소당 한 번뿐이고, 릴리스 hot path는
// 원장 tip과 대상 태그 ref 두 개만 읽는다(contracts/release-version-ledger.yaml).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RELEASE_TAG_PATTERN,
  ReleaseAuthorityError,
  computeAuthorityRevision,
  createInitialLedger,
  extractSupersededRevisions,
  legacyAndroidVersionCode,
  parseLedger,
  parseTagReceipt,
  renderLedger,
} from './tag-version-authority.mjs';

const AUTHORITY_ID = 'release-version-authority-v1';
const LEDGER_ID = 'release-version-ledger-v1';
const LEDGER_BRANCH = 'release-version-ledger';
const LEDGER_FILE = 'release-version-ledger.json';
const FLAGS = new Set(['accept-attestation', 'json']);
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
      throw new ReleaseAuthorityError('ledger-initialization-needs-input', `--${key} 값이 없다.`);
    }
    args.set(key, value);
    index += 1;
  }
  return { args, positional };
}

function pick(args, key, envKey, fallback = '') {
  const value = args.get(key) ?? process.env[envKey] ?? fallback;
  return typeof value === 'string' ? value.trim() : value;
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

/** 원격 원장 브랜치 tip을 읽는다. 로컬 복제본이 stale이어도 원격이 정본이다. */
function readRemoteLedger(root) {
  const listed = gitOrNull(root, 'ls-remote', '--exit-code', '--heads', 'origin', LEDGER_BRANCH);
  if (listed === null || listed.length === 0) {
    return { present: false };
  }
  git(root, 'fetch', '--no-tags', '--depth=1', '--force', 'origin', `+refs/heads/${LEDGER_BRANCH}:refs/remotes/origin/${LEDGER_BRANCH}`);
  const commit = git(root, 'rev-parse', `refs/remotes/origin/${LEDGER_BRANCH}^{commit}`);
  const text = gitOrNull(root, 'show', `${commit}:${LEDGER_FILE}`);
  if (text === null) {
    return { present: true, commit, schemaValid: false };
  }
  try {
    const ledger = parseLedger(text);
    return { present: true, commit, schemaValid: true, ledger };
  } catch {
    return { present: true, commit, schemaValid: false };
  }
}

/** 원격의 stable 태그를 전부 받아 receipt를 읽는다. 초기화 경로에서만 허용되는 전수 조회다. */
function readStableTagReceipts(root) {
  git(root, 'fetch', '--force', 'origin', '+refs/tags/*:refs/tags/*');
  const listed = gitOrNull(root, 'for-each-ref', '--format=%(refname:short)%09%(objecttype)%09%(objectname)', 'refs/tags/');
  if (listed === null || listed.length === 0) {
    return [];
  }
  const entries = [];
  for (const line of listed.split('\n')) {
    const [tag, objectType, objectName] = line.split('\t');
    if (RELEASE_TAG_PATTERN.exec(tag ?? '') === null) {
      continue;
    }
    const commit = gitOrNull(root, 'rev-parse', `refs/tags/${tag}^{commit}`);
    const message = objectType === 'tag' ? gitOrNull(root, 'for-each-ref', '--format=%(contents)', `refs/tags/${tag}`) : null;
    entries.push({
      tag,
      objectType,
      objectName,
      commit,
      receipt: message === null ? null : parseTagReceipt(message),
    });
  }
  return entries;
}

function readJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ReleaseAuthorityError('ledger-initialization-needs-input', `${label} JSON을 읽지 못했다: ${path}`);
  }
}

function playStorePackageName(root) {
  const configPath = join(root, 'play-store/google-play.config.json');
  if (!existsSync(configPath)) {
    return null;
  }
  // packageName은 authority가 아니라 provider readback 대상 식별자다.
  const config = readJsonFile(configPath, 'google-play.config.json');
  const name = config?.packageName ?? config?.app?.packageName ?? null;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

function evidenceCommand(packageName) {
  return [
    {
      kind: 'google-play-bundles-list',
      how: 'Android Publisher read-only 조회를 한 번 실행한다. edit을 commit하지 않고 항상 삭제한다.',
      command: `python3 scripts/release/read-google-play-version-codes.py --package-name ${packageName ?? '<packageName>'} --out play-readback.json`,
      then: 'init-release-version-ledger.mjs 를 --play-readback play-readback.json 으로 다시 실행한다',
    },
    {
      kind: 'human-attestation',
      how: 'Play Console > 릴리스 > App bundle explorer 에서 관측한 최대 versionCode를 적는다.',
      fileShape: {
        kind: 'human-attestation',
        packageName: packageName ?? '<packageName>',
        maxVersionCode: 0,
        observedAt: '<ISO8601 UTC>',
        observedBy: '<github login>',
        evidenceUrl: '<Play Console URL>',
      },
      then: 'init-release-version-ledger.mjs 를 --attestation attest.json --accept-attestation 으로 다시 실행한다',
    },
  ];
}

function main() {
  const { args, positional } = parseArgs(process.argv.slice(2));
  const root = resolve(positional[0] ?? '.');
  const fullName = pick(args, 'full-name', 'RELEASE_REPOSITORY_FULL_NAME');
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(fullName)) {
    throw new ReleaseAuthorityError('ledger-initialization-needs-input', `--full-name 이 owner/repo 형식이어야 한다: ${fullName || 'missing'}`);
  }
  const observedAt = pick(args, 'observed-at', 'RELEASE_OBSERVED_AT', new Date().toISOString().replace(/\.\d+Z$/u, 'Z'));
  // provenance는 "어느 중앙 SHA가 이 원장을 만들었는가"를 남겨야 한다. 워크플로에서는
  // JOB_WORKFLOW_SHA가 주고, 로컬 판정에서는 --workflow-sha 로 준다.
  const workflowSha = pick(args, 'workflow-sha', 'JOB_WORKFLOW_SHA');
  if (!/^[0-9a-f]{40}$/u.test(workflowSha)) {
    throw new ReleaseAuthorityError(
      'ledger-initialization-needs-input',
      `--workflow-sha(또는 JOB_WORKFLOW_SHA)로 중앙 워크플로의 40자리 commit SHA가 필요하다: ${workflowSha || 'missing'}`,
    );
  }
  const authorityContract = readFileSync(
    pick(args, 'authority-contract', 'RELEASE_AUTHORITY_CONTRACT', DEFAULT_AUTHORITY_CONTRACT),
    'utf8',
  );
  const authorityRevision = computeAuthorityRevision(authorityContract);
  const supersededRevisions = extractSupersededRevisions(authorityContract);

  const findings = [];
  const required = [];
  const packageName = playStorePackageName(root);
  const remote = readRemoteLedger(root);

  const report = {
    schemaVersion: 1,
    authority: AUTHORITY_ID,
    ledger: LEDGER_ID,
    repository: { fullName, source: 'github', root, playStorePackageName: packageName },
    observedAt,
    path: 'new-repository',
    ledgerBranch: { present: remote.present },
    baseline: null,
    proposedLedger: null,
    required,
    findings,
    status: 'NEEDS_INPUT',
  };

  if (remote.present) {
    report.ledgerBranch.commit = remote.commit;
    report.ledgerBranch.schemaValid = remote.schemaValid === true;
    if (remote.schemaValid === true) {
      report.path = 'already-initialized';
      report.status = 'ALREADY_INITIALIZED';
      report.ledgerBranch.androidLastVersionCode = remote.ledger.android.lastVersionCode;
      findings.push({
        id: 'ledger-already-initialized',
        severity: 'advisory',
        detail: `이미 초기화된 원장이다. lastVersionCode=${remote.ledger.android.lastVersionCode}`,
      });
      return report;
    }
    // 훼손된 원장을 덮어쓰지 않는다. 사람이 먼저 판단해야 한다.
    report.path = 'already-initialized';
    findings.push({
      id: 'ledger-schema-invalid',
      severity: 'blocking',
      detail: '원장 브랜치는 있지만 tip JSON이 계약을 만족하지 않는다. 덮어쓰지 않는다.',
      ref: `refs/heads/${LEDGER_BRANCH}`,
    });
    required.push({
      id: 'ledger-schema-repair',
      platform: 'android',
      reason: 'ledger-schema-invalid',
      packageName,
      acceptedEvidence: evidenceCommand(packageName),
    });
    return report;
  }

  const tags = readStableTagReceipts(root);
  report.repository.stableTagCount = tags.length;

  const sources = [];
  for (const entry of tags) {
    if (entry.receipt === null) {
      findings.push({
        id: 'tag-receipt-absent',
        severity: 'advisory',
        detail: `${entry.tag}: ${entry.objectType === 'tag' ? 'receipt 없는 annotated 태그' : 'lightweight 태그'}`,
        ref: `refs/tags/${entry.tag}`,
      });
      continue;
    }
    if (entry.receipt.sourceSha !== entry.commit) {
      findings.push({
        id: 'tag-receipt-source-mismatch',
        severity: 'blocking',
        detail: `${entry.tag}: receipt의 source SHA가 태그 commit과 다르다`,
        ref: `refs/tags/${entry.tag}`,
      });
      continue;
    }
    const known =
      entry.receipt.authorityRevision === authorityRevision
        ? 'current'
        : supersededRevisions.find((item) => item.revision === entry.receipt.authorityRevision) ?? null;
    if (known === null) {
      findings.push({
        id: 'authority-revision-stale',
        severity: 'advisory',
        detail: `${entry.tag}: 등록되지 않은 계약 revision의 receipt라 baseline 근거로 쓰지 않는다`,
        ref: `refs/tags/${entry.tag}`,
      });
      continue;
    }
    if (known !== 'current') {
      // 구 계약 receipt는 그 계약의 공식으로 재현될 때만 믿는다.
      const expected = legacyAndroidVersionCode(entry.tag, known.androidVersionCodeFormula);
      if (entry.receipt.androidVersionCode !== String(expected)) {
        findings.push({
          id: 'tag-receipt-source-mismatch',
          severity: 'blocking',
          detail: `${entry.tag}: 구 계약 공식으로 receipt 번호가 재현되지 않는다`,
          ref: `refs/tags/${entry.tag}`,
        });
        continue;
      }
      findings.push({
        id: 'authority-revision-stale',
        severity: 'advisory',
        detail: `${entry.tag}: 구 계약 revision이지만 값이 재현되어 baseline 근거로 쓴다`,
        ref: `refs/tags/${entry.tag}`,
      });
    }
    sources.push({
      kind: 'tag-receipt',
      androidVersionCode: Number(entry.receipt.androidVersionCode),
      tag: entry.tag,
      tagObject: entry.objectName,
      sourceSha: entry.receipt.sourceSha,
      receiptAuthorityRevision: entry.receipt.authorityRevision,
    });
  }

  const playReadbackPath = pick(args, 'play-readback', 'RELEASE_PLAY_READBACK');
  if (playReadbackPath.length > 0) {
    const readback = readJsonFile(playReadbackPath, 'Play readback');
    if (readback.kind !== 'google-play-version-code-readback' || readback.status !== 'READY') {
      findings.push({
        id: 'provider-readback-unavailable',
        severity: 'blocking',
        detail: 'Play readback 결과가 READY가 아니다. 값을 추정하지 않는다.',
      });
    } else {
      sources.push({
        kind: readback.apkVersionCodes?.length > 0 && readback.bundleVersionCodes?.length === 0 ? 'google-play-apks-list' : 'google-play-bundles-list',
        androidVersionCode: Number(readback.maxVersionCode ?? 0),
        packageName: readback.packageName,
        observedAt: readback.observedAt,
        evidenceDigest: `sha256:${readback.evidenceDigest ?? ''}`.replace(/^sha256:sha256:/u, 'sha256:'),
      });
    }
  }

  const attestationPath = pick(args, 'attestation', 'RELEASE_LEDGER_ATTESTATION');
  if (attestationPath.length > 0) {
    if (args.get('accept-attestation') !== true) {
      findings.push({
        id: 'attestation-not-accepted',
        severity: 'blocking',
        detail: '--attestation 만으로는 baseline을 정하지 않는다. --accept-attestation 을 명시해야 한다.',
      });
    } else {
      const attestation = readJsonFile(attestationPath, 'attestation');
      sources.push({
        kind: 'human-attestation',
        androidVersionCode: Number(attestation.maxVersionCode ?? 0),
        packageName: attestation.packageName,
        observedAt: attestation.observedAt,
        observedBy: attestation.observedBy,
        evidenceUrl: attestation.evidenceUrl,
      });
    }
  }

  const hasBlocking = findings.some(({ severity }) => severity === 'blocking');
  const providerEvidence = sources.some(({ kind }) => kind !== 'tag-receipt');

  if (tags.length === 0 && sources.length === 0) {
    // 태그가 없다고 Play 이력이 없다는 뜻은 아니다. packageName이 선언돼 있으면 readback을 요구한다.
    if (packageName !== null) {
      report.path = 'legacy-repository';
      findings.push({
        id: 'play-store-package-declared-without-readback',
        severity: 'blocking',
        detail: `태그는 없지만 ${packageName} 이 선언돼 있다. 1부터 시작하면 기존 업로드와 충돌할 수 있다.`,
      });
      required.push({
        id: 'android-baseline-readback',
        platform: 'android',
        reason: 'play-store-package-declared-without-readback',
        packageName,
        acceptedEvidence: evidenceCommand(packageName),
      });
      return report;
    }
    report.path = 'new-repository';
    sources.push({ kind: 'no-prior-release', androidVersionCode: 0 });
  } else if (sources.length === 0) {
    report.path = 'legacy-repository';
    required.push({
      id: 'android-baseline-readback',
      platform: 'android',
      reason: 'no-verified-tag-receipt',
      packageName,
      acceptedEvidence: evidenceCommand(packageName),
    });
    return report;
  } else {
    report.path = providerEvidence && !sources.some(({ kind }) => kind === 'tag-receipt')
      ? 'legacy-repository'
      : 'existing-repository-with-receipt';
  }

  if (hasBlocking) {
    return report;
  }

  // baseline은 검증된 소스의 최댓값이다. 단조 증가를 보장하는 유일한 안전 선택이다.
  const baselineAndroidVersionCode = Math.max(...sources.map(({ androidVersionCode }) => androidVersionCode));
  const latest = sources
    .filter(({ kind }) => kind === 'tag-receipt')
    .sort((a, b) => a.androidVersionCode - b.androidVersionCode)
    .at(-1);

  const ledger = createInitialLedger({
    baselineAndroidVersionCode,
    baselineSources: sources,
    authorityRevision,
    initializedFromWorkflowSha: workflowSha,
    initializedAt: observedAt,
    lastTag: latest?.tag ?? null,
    lastSourceSha: latest?.sourceSha ?? null,
  });

  report.baseline = ledger.provenance.baseline;
  report.proposedLedger = ledger;
  report.status = 'READY';
  return report;
}

function emit(report, args) {
  report.findings.sort((a, b) => `${a.id}${a.ref ?? ''}`.localeCompare(`${b.id}${b.ref ?? ''}`));
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const outPath = pick(args, 'out', 'RELEASE_LEDGER_INIT_OUT');
  if (outPath.length > 0) {
    writeFileSync(outPath, serialized, 'utf8');
  }
  process.stdout.write(serialized);
  const ledgerOut = pick(args, 'ledger-out', 'RELEASE_LEDGER_OUT');
  if (ledgerOut.length > 0 && report.proposedLedger !== null) {
    writeFileSync(ledgerOut, renderLedger(report.proposedLedger), 'utf8');
  }
}

try {
  const { args } = parseArgs(process.argv.slice(2));
  const report = main();
  emit(report, args);
  // NEEDS_INPUT은 사람이 개입해야 한다는 뜻이므로 0으로 끝내지 않는다.
  process.exit(report.status === 'NEEDS_INPUT' ? 1 : 0);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
