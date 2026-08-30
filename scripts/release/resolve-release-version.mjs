#!/usr/bin/env node
// 조직 정본 release version resolver. GitHub release tag 하나만 읽어 모든 마켓 artifact의
// version metadata를 파생하고, tag/ref/source SHA/config revision을 하나의 binding으로 고정한다.
//
// 저장소 로컬 resolver(scripts/resolve-release-version.mjs)와 마켓 config JSON은 authority가
// 아니므로 이 스크립트는 앱 저장소의 어떤 파일도 읽지 않는다.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  ReleaseAuthorityError,
  assertSourceBinding,
  assertTagReceipt,
  bindingDigest,
  computeAuthorityRevision,
  computeConfigRevision,
  createReleaseBinding,
  githubOutputLines,
  parseReleaseTag,
  parseTagReceipt,
  renderTagReceipt,
  selectLatestStableTag,
} from './tag-version-authority.mjs';

const FLAGS = new Set(['github-output', 'json', 'print-tag']);
const DEFAULT_AUTHORITY_CONTRACT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../contracts/release-version-authority.yaml',
);

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

function main() {
  const args = parseArgs(process.argv.slice(2));

  const tagInput = pick(args, 'tag', 'RELEASE_TAG');
  const tagListFile = pick(args, 'tag-list-file', 'RELEASE_TAG_LIST_FILE');
  const tag =
    tagInput.length > 0
      ? parseReleaseTag(tagInput).tag
      : selectLatestStableTag(readFileSync(tagListFile, 'utf8'));

  if (args.get('print-tag') === true) {
    // exact tag commit을 checkout하기 전 단계. 아직 source SHA를 알 수 없으므로 tag만 확정한다.
    process.stdout.write(`${tag}\n`);
    return;
  }

  const sourceSha = pick(args, 'source-sha', 'RELEASE_SOURCE_SHA');
  const headSha = pick(args, 'head-sha', 'RELEASE_HEAD_SHA', sourceSha);
  const localTagSha = pick(args, 'local-tag-sha', 'RELEASE_LOCAL_TAG_SHA', sourceSha);

  const authorityContractPath = pick(
    args,
    'authority-contract',
    'RELEASE_AUTHORITY_CONTRACT',
    DEFAULT_AUTHORITY_CONTRACT,
  );

  const authorityRevision = computeAuthorityRevision(readFileSync(authorityContractPath, 'utf8'));
  const configRevision = computeConfigRevision({
    calledWorkflowRepository: pick(args, 'called-workflow-repository', 'JOB_WORKFLOW_REPOSITORY'),
    calledWorkflowRef: pick(args, 'called-workflow-ref', 'JOB_WORKFLOW_REF'),
    calledWorkflowSha: pick(args, 'called-workflow-sha', 'JOB_WORKFLOW_SHA'),
    authorityRevision,
  });

  const binding = createReleaseBinding({ tag, sourceSha, configRevision, authorityRevision });

  assertSourceBinding({ binding, headSha, localTagSha });

  const tagMessageFile = pick(args, 'tag-message-file', 'RELEASE_TAG_MESSAGE_FILE');
  if (tagMessageFile.length > 0) {
    assertTagReceipt(binding, parseTagReceipt(readFileSync(tagMessageFile, 'utf8')));
  }

  const tagReceiptPath = pick(args, 'tag-receipt', 'RELEASE_TAG_RECEIPT_PATH');
  if (tagReceiptPath.length > 0) {
    writeFileSync(tagReceiptPath, `${renderTagReceipt(binding)}\n`, 'utf8');
  }

  const bindingPath = pick(args, 'binding', 'RELEASE_BINDING_PATH');
  if (bindingPath.length > 0) {
    writeFileSync(bindingPath, `${JSON.stringify(binding, null, 2)}\n`, 'utf8');
  }

  if (args.get('github-output') === true) {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (typeof outputPath !== 'string' || outputPath.length === 0) {
      throw new ReleaseAuthorityError('config-revision-mismatch', '--github-output에는 GITHUB_OUTPUT이 필요하다.');
    }
    appendFileSync(outputPath, `${githubOutputLines(binding).join('\n')}\n`, 'utf8');
  }

  if (args.get('json') === true) {
    process.stdout.write(`${JSON.stringify(binding, null, 2)}\n`);
  } else {
    process.stdout.write(
      `release binding ${binding.tag} -> ${binding.versionName} (${binding.androidVersionCode}) ` +
        `source=${binding.sourceSha} config=${binding.configRevision} digest=${bindingDigest(binding)}\n`,
    );
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
