#!/usr/bin/env node
// 빌드된 마켓 artifact의 metadata를 다시 읽어 release tag 파생 binding과 exact match하는지
// 검증한다. 불일치는 업로드 이전에 fail-closed한다.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

import {
  ARTIFACT_KINDS,
  ReleaseAuthorityError,
  assertArtifactVersion,
  bindingDigest,
  canonicalReleaseMemo,
  parseAabManifest,
  parseInfoPlistJson,
  parseReleaseBinding,
  readAitContainer,
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

  const artifactPath = pick(args, 'artifact', 'RELEASE_ARTIFACT_PATH');
  let artifactDigest = '';
  let artifactBytes = null;
  if (artifactPath.length > 0) {
    artifactBytes = readFileSync(artifactPath);
    artifactDigest = createHash('sha256').update(artifactBytes).digest('hex');
  }

  const summary = { kind, artifactPath, artifactDigest };

  if (kind === 'android-app-bundle') {
    const metadataPath = pick(args, 'metadata', 'RELEASE_ARTIFACT_METADATA');
    if (metadataPath.length === 0) {
      throw new ReleaseAuthorityError(
        'artifact-provenance-mismatch',
        'AAB 검증에는 --metadata base/manifest/AndroidManifest.xml 경로가 필요하다.',
      );
    }
    const observed = parseAabManifest(readFileSync(metadataPath));
    assertArtifactVersion({ kind, binding, observed });
    Object.assign(summary, observed);
  } else if (kind === 'xcode-archive') {
    const metadataPath = pick(args, 'metadata', 'RELEASE_ARTIFACT_METADATA');
    if (metadataPath.length === 0) {
      throw new ReleaseAuthorityError(
        'artifact-provenance-mismatch',
        'xcarchive 검증에는 --metadata Info.plist JSON이 필요하다.',
      );
    }
    const observed = parseInfoPlistJson(readFileSync(metadataPath, 'utf8'));
    assertArtifactVersion({ kind, binding, observed });
    Object.assign(summary, observed);
  } else {
    if (artifactBytes === null) {
      throw new ReleaseAuthorityError('artifact-provenance-mismatch', '.ait 검증에는 --artifact 경로가 필요하다.');
    }
    const container = readAitContainer(artifactBytes);
    const note = pick(args, 'note', 'RELEASE_MEMO_NOTE');
    const memo = pick(args, 'memo', 'RELEASE_MEMO', canonicalReleaseMemo(binding, note));
    assertArtifactVersion({ kind, binding, observed: { memo, note, digest: artifactDigest } });
    Object.assign(summary, container, { memo });
  }

  if (args.get('github-output') === true) {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (typeof outputPath !== 'string' || outputPath.length === 0) {
      throw new ReleaseAuthorityError('artifact-provenance-mismatch', '--github-output에는 GITHUB_OUTPUT이 필요하다.');
    }
    const lines = [
      `artifact_kind=${kind}`,
      `artifact_digest=${artifactDigest}`,
      `binding_digest=${bindingDigest(binding)}`,
      `verified_version_name=${binding.versionName}`,
      `verified_version_code=${binding.androidVersionCode}`,
    ];
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
