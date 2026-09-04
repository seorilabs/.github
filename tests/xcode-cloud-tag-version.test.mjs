import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyXcodeCloudTagBinding,
  resolveXcodeCloudTagBinding,
} from '../scripts/release/xcode-cloud-apply-tag-version.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts/release/xcode-cloud-apply-tag-version.mjs');
const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>
`;

const git = (repository, ...args) =>
  execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();

function repositoryFixture() {
  const repository = mkdtempSync(join(tmpdir(), 'xcode-tag-authority-'));
  git(repository, 'init', '-q');
  git(repository, 'config', 'user.name', 'Test');
  git(repository, 'config', 'user.email', 'test@example.com');
  const infoPlist = join(repository, 'build/ios/FoamParty-Info.plist');
  mkdirSync(dirname(infoPlist), { recursive: true });
  writeFileSync(infoPlist, INFO_PLIST);
  git(repository, 'add', '.');
  git(repository, 'commit', '-q', '-m', 'source');
  git(repository, 'tag', 'v1.2.3');
  return { repository, infoPlist, sourceSha: git(repository, 'rev-parse', 'HEAD') };
}

test('Xcode Cloud는 exact tag commit에서 marketing version을, CI_BUILD_NUMBER에서 build number를 만든다', () => {
  const fixture = repositoryFixture();
  try {
    const binding = resolveXcodeCloudTagBinding({
      tag: 'v1.2.3',
      repository: fixture.repository,
      infoPlist: fixture.infoPlist,
      buildNumber: '42',
      expectedSourceSha: fixture.sourceSha,
    });
    // 태그 파생 encodedVersion(1002003)은 런타임 비교값으로만 남고 Apple build number가 아니다.
    assert.equal(binding.runtimeVersionCode, 1001002003);
    assert.equal(binding.appleMarketingVersion, '1.2.3');
    assert.equal(binding.appleBuildNumber, 42);
    assert.equal(binding.buildNumberAuthority, 'xcode-cloud-ci-build-number');
    assert.equal(binding.sourceSha, fixture.sourceSha);

    writeFileSync(join(fixture.repository, 'next.txt'), 'next');
    git(fixture.repository, 'add', '.');
    git(fixture.repository, 'commit', '-q', '-m', 'next');
    assert.throws(
      () =>
        resolveXcodeCloudTagBinding({
          tag: 'v1.2.3',
          repository: fixture.repository,
          infoPlist: fixture.infoPlist,
          buildNumber: '42',
        }),
      (error) => error.code === 'source-sha-mismatch',
    );
  } finally {
    rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('Xcode Cloud authority는 repository 밖 또는 symlink Info.plist를 거부한다', () => {
  const fixture = repositoryFixture();
  const outside = join(tmpdir(), `outside-${process.pid}.plist`);
  try {
    writeFileSync(outside, INFO_PLIST);
    assert.throws(
      () =>
        resolveXcodeCloudTagBinding({
          tag: 'v1.2.3',
          repository: fixture.repository,
          infoPlist: outside,
          buildNumber: '42',
        }),
      (error) => error.code === 'artifact-provenance-mismatch',
    );
    const link = join(fixture.repository, 'build/ios/link.plist');
    symlinkSync(fixture.infoPlist, link);
    assert.throws(
      () =>
        resolveXcodeCloudTagBinding({
          tag: 'v1.2.3',
          repository: fixture.repository,
          infoPlist: link,
          buildNumber: '42',
        }),
      (error) => error.code === 'artifact-provenance-mismatch',
    );
  } finally {
    rmSync(outside, { force: true });
    rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('Xcode Cloud CLI dry-run은 plist를 바꾸지 않고 공개 binding만 출력한다', () => {
  const fixture = repositoryFixture();
  try {
    const before = readFileSync(fixture.infoPlist, 'utf8');
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        '--tag',
        'v1.2.3',
        '--repository',
        fixture.repository,
        '--info-plist',
        fixture.infoPlist,
        '--source-sha',
        fixture.sourceSha,
        '--dry-run',
        '--json',
      ],
      // build number는 Xcode Cloud가 환경 변수로만 넘긴다.
      { encoding: 'utf8', env: { ...process.env, CI_BUILD_NUMBER: '42' } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      tag: 'v1.2.3',
      sourceSha: fixture.sourceSha,
      runtimeVersionCode: 1001002003,
      appleMarketingVersion: '1.2.3',
      appleBuildNumber: 42,
      buildNumberAuthority: 'xcode-cloud-ci-build-number',
      applied: false,
    });
    assert.equal(readFileSync(fixture.infoPlist, 'utf8'), before);
  } finally {
    rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('macOS에서는 주입할 Apple version을 임시 plist에서 검증한 뒤 원자적으로 반영한다', {
  skip: process.platform !== 'darwin',
}, () => {
  const fixture = repositoryFixture();
  try {
    const binding = resolveXcodeCloudTagBinding({
      tag: 'v1.2.3',
      repository: fixture.repository,
      infoPlist: fixture.infoPlist,
      buildNumber: '42',
    });
    applyXcodeCloudTagBinding(binding);
    assert.equal(
      execFileSync('/usr/bin/plutil', [
        '-extract',
        'CFBundleShortVersionString',
        'raw',
        '-o',
        '-',
        fixture.infoPlist,
      ], { encoding: 'utf8' }).trim(),
      '1.2.3',
    );
    assert.equal(
      execFileSync('/usr/bin/plutil', [
        '-extract',
        'CFBundleVersion',
        'raw',
        '-o',
        '-',
        fixture.infoPlist,
      ], { encoding: 'utf8' }).trim(),
      '42',
    );
  } finally {
    rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('심볼릭 링크 경로로 실행해도 조용히 통과하지 않는다', () => {
  // Xcode Cloud hook은 이 CLI를 mktemp -d 아래로 내려받아 실행한다. macOS에서 그 경로는
  // /var/folders/...이고 /var는 /private/var 심볼릭 링크다. Node는 ESM을 realpath로 정규화하므로
  // main-module 판정이 호출 경로를 그대로 비교하면 영원히 어긋나고, 스크립트는 아무 일도 하지
  // 않은 채 exit 0 + 빈 출력이 된다. 그 fail-open을 여기서 잡는다.
  const fixture = repositoryFixture();
  const linkRoot = mkdtempSync(join(tmpdir(), 'xcode-tag-authority-link-'));
  try {
    const linkedRepository = join(linkRoot, 'central');
    symlinkSync(ROOT, linkedRepository, 'dir');
    const result = spawnSync(
      process.execPath,
      [
        join(linkedRepository, 'scripts/release/xcode-cloud-apply-tag-version.mjs'),
        '--tag',
        'v1.2.3',
        '--repository',
        fixture.repository,
        '--info-plist',
        fixture.infoPlist,
        '--dry-run',
      ],
      { encoding: 'utf8', env: { ...process.env, CI_BUILD_NUMBER: '42' } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(result.stdout.trim(), '', '심볼릭 링크 경로에서 빈 출력으로 통과했다.');
    assert.equal(JSON.parse(result.stdout).appleBuildNumber, 42);
  } finally {
    rmSync(linkRoot, { recursive: true, force: true });
    rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('CI_BUILD_NUMBER가 없거나 양의 정수가 아니면 build를 시작하지 않는다', () => {
  const fixture = repositoryFixture();
  try {
    for (const buildNumber of [undefined, '', '0', '-1', '1.5', '0042', 'abc', '2100000001']) {
      assert.throws(
        () =>
          resolveXcodeCloudTagBinding({
            tag: 'v1.2.3',
            repository: fixture.repository,
            infoPlist: fixture.infoPlist,
            buildNumber,
          }),
        (error) => error.code === 'xcode-cloud-build-number-invalid',
        String(buildNumber),
      );
    }

    // CLI도 CI_BUILD_NUMBER 없이는 plist를 건드리지 않고 실패한다.
    const { CI_BUILD_NUMBER: _ignored, ...env } = process.env;
    const before = readFileSync(fixture.infoPlist, 'utf8');
    const result = spawnSync(
      process.execPath,
      [CLI, '--tag', 'v1.2.3', '--repository', fixture.repository, '--info-plist', fixture.infoPlist],
      { encoding: 'utf8', env },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /xcode-cloud-build-number-invalid/u);
    assert.equal(readFileSync(fixture.infoPlist, 'utf8'), before);
  } finally {
    rmSync(fixture.repository, { recursive: true, force: true });
  }
});
