#!/usr/bin/env node
// Xcode Cloud의 pre-xcodebuild 단계에서 exact Git tag를 Apple version으로 주입한다.
// 이 파일과 tag-version-authority.mjs는 caller가 같은 불변 central commit SHA에서 내려받아
// checksum을 검증한 뒤 실행한다. 앱 저장소의 package/project/config 값은 읽지 않는다.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ReleaseAuthorityError, deriveReleaseVersion } from './tag-version-authority.mjs';

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const FLAGS = new Set(['dry-run', 'json']);

function fail(code, message) {
  throw new ReleaseAuthorityError(code, message);
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      fail('tag-pattern-mismatch', `알 수 없는 인자: ${argument}`);
    }
    const key = argument.slice(2);
    if (FLAGS.has(key)) {
      args.set(key, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      fail('tag-pattern-mismatch', `--${key} 값이 없다.`);
    }
    args.set(key, value);
    index += 1;
  }
  return args;
}

function required(args, key, envKey = '') {
  const value = args.get(key) ?? (envKey.length > 0 ? process.env[envKey] : '');
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('tag-pattern-mismatch', `${key} 값이 필요하다.`);
  }
  return value.trim();
}

function git(repository, ...args) {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function confinedRegularFile(repository, candidate) {
  if (!isAbsolute(candidate)) {
    fail('artifact-provenance-mismatch', `Info.plist 경로는 절대경로여야 한다: ${candidate}`);
  }
  const candidateStat = lstatSync(candidate);
  if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
    fail('artifact-provenance-mismatch', 'Info.plist는 symlink가 아닌 regular file이어야 한다.');
  }
  const repositoryRoot = realpathSync(repository);
  const filePath = realpathSync(candidate);
  const repositoryRelative = relative(repositoryRoot, filePath);
  if (
    repositoryRelative.length === 0 ||
    repositoryRelative === '..' ||
    repositoryRelative.startsWith(`..${sep}`) ||
    isAbsolute(repositoryRelative)
  ) {
    fail('artifact-provenance-mismatch', `Info.plist가 repository 밖에 있다: ${candidate}`);
  }
  return { filePath, mode: candidateStat.mode & 0o777 };
}

export function resolveXcodeCloudTagBinding({ tag, repository, infoPlist, expectedSourceSha = '' }) {
  const version = deriveReleaseVersion(tag);
  const repositoryRoot = realpathSync(resolve(repository));
  const { filePath, mode } = confinedRegularFile(repositoryRoot, resolve(infoPlist));
  const headSha = git(repositoryRoot, 'rev-parse', 'HEAD^{commit}');
  const tagSha = git(repositoryRoot, 'rev-parse', `refs/tags/${tag}^{commit}`);
  if (!SHA_PATTERN.test(headSha) || tagSha !== headSha) {
    fail('source-sha-mismatch', `Xcode Cloud HEAD와 exact tag commit이 다르다: ${headSha} != ${tagSha}`);
  }
  const expected = expectedSourceSha.trim();
  if (expected.length > 0 && (!SHA_PATTERN.test(expected) || expected !== headSha)) {
    fail('source-sha-mismatch', `Xcode Cloud source SHA가 exact tag commit과 다르다: ${expected} != ${headSha}`);
  }
  return Object.freeze({
    tag: version.releaseTag,
    sourceSha: headSha,
    infoPlist: filePath,
    mode,
    appleMarketingVersion: version.appleMarketingVersion,
    appleBuildNumber: version.appleBuildNumber,
  });
}

function plutil(...args) {
  return execFileSync('/usr/bin/plutil', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function applyXcodeCloudTagBinding(binding) {
  if (process.platform !== 'darwin') {
    fail('artifact-provenance-mismatch', 'Xcode Cloud version 주입은 macOS에서만 실행할 수 있다.');
  }
  const temporaryDirectory = mkdtempSync(join(dirname(binding.infoPlist), '.seori-xcode-version-'));
  const candidate = join(temporaryDirectory, 'Info.plist');
  try {
    copyFileSync(binding.infoPlist, candidate);
    chmodSync(candidate, binding.mode);
    plutil('-lint', candidate);
    plutil('-replace', 'CFBundleShortVersionString', '-string', binding.appleMarketingVersion, candidate);
    plutil('-replace', 'CFBundleVersion', '-string', String(binding.appleBuildNumber), candidate);
    const marketing = plutil('-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', candidate);
    const build = plutil('-extract', 'CFBundleVersion', 'raw', '-o', '-', candidate);
    if (marketing !== binding.appleMarketingVersion || build !== String(binding.appleBuildNumber)) {
      fail(
        'artifact-provenance-mismatch',
        `Info.plist version readback이 태그 파생값과 다르다: ${marketing}/${build}`,
      );
    }
    renameSync(candidate, binding.infoPlist);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  return binding;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const binding = resolveXcodeCloudTagBinding({
    tag: required(args, 'tag', 'CI_TAG'),
    repository: required(args, 'repository', 'CI_PRIMARY_REPOSITORY_PATH'),
    infoPlist: required(args, 'info-plist'),
    expectedSourceSha: String(args.get('source-sha') ?? process.env.CI_COMMIT ?? ''),
  });
  if (args.get('dry-run') !== true) {
    applyXcodeCloudTagBinding(binding);
  }
  const publicResult = {
    tag: binding.tag,
    sourceSha: binding.sourceSha,
    appleMarketingVersion: binding.appleMarketingVersion,
    appleBuildNumber: binding.appleBuildNumber,
    applied: args.get('dry-run') !== true,
  };
  process.stdout.write(`${JSON.stringify(publicResult)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'XCODE_CLOUD_TAG_AUTHORITY_FAILED';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
