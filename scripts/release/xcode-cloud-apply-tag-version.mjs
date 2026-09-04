#!/usr/bin/env node
// Xcode Cloud의 pre-xcodebuild 단계에서 Apple version을 주입한다. marketing version은 exact
// Git tag에서 파생하고, build number는 Xcode Cloud가 발급한 CI_BUILD_NUMBER를 그대로 쓴다
// (contracts/release-version-authority.yaml의 appleBuildNumberExceptions).
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

import { ReleaseAuthorityError, deriveReleaseVersion } from './tag-version-authority.mjs';

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const FLAGS = new Set(['dry-run', 'json']);
// Xcode Cloud build number는 leading zero 없는 양의 정수다. 상한은 계약의 versionCodeMax와 같다.
const BUILD_NUMBER_PATTERN = /^[1-9][0-9]*$/u;
const BUILD_NUMBER_MAX = 2_100_000_000;
const BUILD_NUMBER_AUTHORITY = 'xcode-cloud-ci-build-number';

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

/**
 * Apple build number의 정본은 Xcode Cloud가 발급한 CI_BUILD_NUMBER 하나다. 태그 파생
 * encodedVersion(v0.1.9 -> 1009)은 CFBundleVersion에 쓰지 않는다. 값이 없거나 0이거나
 * 정수가 아니면 build를 시작하지 않고 fail-closed한다.
 */
function requireXcodeCloudBuildNumber(value) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (!BUILD_NUMBER_PATTERN.test(text)) {
    fail(
      'xcode-cloud-build-number-invalid',
      `CI_BUILD_NUMBER는 1 이상의 정수여야 한다: ${text.length > 0 ? text : 'missing'}`,
    );
  }
  const buildNumber = Number(text);
  if (!Number.isSafeInteger(buildNumber) || buildNumber > BUILD_NUMBER_MAX) {
    fail(
      'xcode-cloud-build-number-invalid',
      `CI_BUILD_NUMBER가 상한 ${BUILD_NUMBER_MAX}을 넘는다: ${text}`,
    );
  }
  return buildNumber;
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

export function resolveXcodeCloudTagBinding({
  tag,
  repository,
  infoPlist,
  buildNumber,
  expectedSourceSha = '',
}) {
  const version = deriveReleaseVersion(tag);
  const appleBuildNumber = requireXcodeCloudBuildNumber(buildNumber);
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
    // 태그 파생 encodedVersion은 Apple build number가 아니라 런타임 최소지원버전 비교값이다.
    runtimeVersionCode: version.androidVersionCode,
    appleMarketingVersion: version.appleMarketingVersion,
    appleBuildNumber,
    buildNumberAuthority: BUILD_NUMBER_AUTHORITY,
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
        `Info.plist version readback이 주입값과 다르다: ${marketing}/${build}`,
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
    buildNumber: args.get('build-number') ?? process.env.CI_BUILD_NUMBER,
    expectedSourceSha: String(args.get('source-sha') ?? process.env.CI_COMMIT ?? ''),
  });
  if (args.get('dry-run') !== true) {
    applyXcodeCloudTagBinding(binding);
  }
  const publicResult = {
    tag: binding.tag,
    sourceSha: binding.sourceSha,
    runtimeVersionCode: binding.runtimeVersionCode,
    appleMarketingVersion: binding.appleMarketingVersion,
    appleBuildNumber: binding.appleBuildNumber,
    buildNumberAuthority: binding.buildNumberAuthority,
    applied: args.get('dry-run') !== true,
  };
  process.stdout.write(`${JSON.stringify(publicResult)}\n`);
}

// Node가 ESM 경로를 realpath로 정규화하므로 import.meta.url과 process.argv[1]을 직접 비교하면
// 심볼릭 링크 경로에서 영원히 어긋난다. macOS mktemp -d가 주는 /var/folders/...가 그 경우이고
// (/var는 /private/var 링크), 그때 이 스크립트는 아무 일도 하지 않고 exit 0 하는 fail-open이
// 된다. import.meta.main은 Node가 직접 판정하므로 호출 경로 형태에 영향받지 않는다.
if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'XCODE_CLOUD_TAG_AUTHORITY_FAILED';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
