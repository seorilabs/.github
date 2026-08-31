#!/usr/bin/env node
// 빌드된 마켓 artifact의 metadata를 다시 읽어 release tag 파생 binding과 exact match하는지
// 검증한다. 불일치는 업로드 이전에 fail-closed한다.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

import {
  ARTIFACT_KINDS,
  ReleaseAuthorityError,
  artifactDigestSource,
  assertArtifactVersion,
  bindingDigest,
  canonicalReleaseMemo,
  parseAabManifest,
  parseInfoPlistJson,
  parseReleaseBinding,
  readAitContainer,
  renderArtifactReceipt,
} from './tag-version-authority.mjs';

const FLAGS = new Set(['github-output']);

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new ReleaseAuthorityError('artifact-provenance-mismatch', `알 수 없는 인자: ${argument}`);
    }
    const key = argument.slice(2);
    if (FLAGS.has(key)) {
      args.set(key, true);
      continue;
    }
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

  const kind = pick(args, 'kind', 'RELEASE_ARTIFACT_KIND');
  if (!ARTIFACT_KINDS.includes(kind)) {
    throw new ReleaseAuthorityError(
      'artifact-provenance-mismatch',
      `--kind는 ${ARTIFACT_KINDS.join('|')} 중 하나여야 한다: ${kind || 'missing'}`,
    );
  }

  const bindingPath = pick(args, 'binding', 'RELEASE_BINDING_PATH');
  if (bindingPath.length === 0) {
    throw new ReleaseAuthorityError('artifact-provenance-mismatch', '--binding release binding 경로가 필요하다.');
  }
  const binding = parseReleaseBinding(readFileSync(bindingPath, 'utf8'));

  const metadataPath = pick(args, 'metadata', 'RELEASE_ARTIFACT_METADATA');
  const artifactPath = pick(args, 'artifact', 'RELEASE_ARTIFACT_PATH');
  const digestSource = artifactDigestSource(kind);

  // digest 출처는 kind가 결정한다. AAB와 .ait은 업로드 대상 파일 자체를, xcarchive는 디렉터리
  // 번들이라 파일 하나로 잡을 수 없으므로 readback한 archive Info.plist를 쓴다. 이 digest가
  // receipt와 provider memo에 그대로 들어가므로, 검증한 대상과 다른 파일을 올리면 어긋난다.
  if (digestSource === 'artifact-file' && artifactPath.length === 0) {
    throw new ReleaseAuthorityError(
      'artifact-digest-mismatch',
      '--artifact 업로드 대상 파일 경로가 필요하다.',
    );
  }
  if (digestSource === 'archive-info-plist' && artifactPath.length > 0) {
    throw new ReleaseAuthorityError(
      'artifact-digest-mismatch',
      'xcarchive는 디렉터리 번들이므로 --artifact 파일 digest를 쓰지 않는다.',
    );
  }
  // .ait 컨테이너는 내부 version 기록이 없어 별도 metadata readback 대상이 없다.
  if (kind !== 'ait' && metadataPath.length === 0) {
    throw new ReleaseAuthorityError(
      'artifact-provenance-mismatch',
      kind === 'android-app-bundle'
        ? 'AAB 검증에는 --metadata base/manifest/AndroidManifest.xml 경로가 필요하다.'
        : 'xcarchive 검증에는 --metadata Info.plist JSON이 필요하다.',
    );
  }
  const digestBytes =
    digestSource === 'artifact-file' ? readFileSync(artifactPath) : readFileSync(metadataPath);
  const artifactDigest = createHash('sha256').update(digestBytes).digest('hex');

  const summary = { kind, artifactPath, artifactDigest, digestSource };
  let memo = '';

  if (kind === 'android-app-bundle') {
    const observed = parseAabManifest(readFileSync(metadataPath));
    assertArtifactVersion({ kind, binding, observed });
    Object.assign(summary, observed);
  } else if (kind === 'xcode-archive') {
    const observed = parseInfoPlistJson(readFileSync(metadataPath, 'utf8'));
    assertArtifactVersion({ kind, binding, observed });
    Object.assign(summary, observed);
  } else {
    const container = readAitContainer(digestBytes);
    const note = pick(args, 'note', 'RELEASE_MEMO_NOTE');
    memo = pick(
      args,
      'memo',
      'RELEASE_MEMO',
      canonicalReleaseMemo(binding, { artifactDigest, note }),
    );
    assertArtifactVersion({
      kind,
      binding,
      observed: { memo, note, digest: artifactDigest, versionFields: container.versionFields },
    });
    Object.assign(summary, container, { memo });
  }

  // artifact receipt는 binding·kind·digest·memo를 한 파일로 묶는다. 업로드 스텝은 이 receipt의
  // 경로와 digest만 신뢰하고, 다른 파일을 올릴 수 없다.
  const receipt = renderArtifactReceipt({ binding, kind, artifactDigest, memo });
  const receiptPath = pick(args, 'receipt', 'RELEASE_ARTIFACT_RECEIPT_PATH');
  if (receiptPath.length > 0) {
    writeFileSync(receiptPath, `${receipt}\n`, 'utf8');
  }

  if (args.get('github-output') === true) {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (typeof outputPath !== 'string' || outputPath.length === 0) {
      throw new ReleaseAuthorityError('artifact-provenance-mismatch', '--github-output에는 GITHUB_OUTPUT이 필요하다.');
    }
    const lines = [
      `artifact_kind=${kind}`,
      `artifact_path=${artifactPath}`,
      `artifact_digest=${artifactDigest}`,
      `artifact_digest_source=${digestSource}`,
      `binding_digest=${bindingDigest(binding)}`,
      `verified_version_name=${binding.versionName}`,
      `verified_version_code=${binding.androidVersionCode}`,
    ];
    if (kind === 'android-app-bundle') {
      lines.push(`package_name=${summary.packageName}`);
    }
    if (receiptPath.length > 0) {
      lines.push(`artifact_receipt_path=${receiptPath}`);
    }
    if (kind === 'ait') {
      lines.push(`release_memo=${summary.memo}`, `ait_format=${summary.format}`);
    }
    appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
  }

  process.stdout.write(`${JSON.stringify({ binding, observed: summary }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
