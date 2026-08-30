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

test('Xcode Cloud는 exact tag commit에서만 Apple version binding을 만든다', () => {
  const fixture = repositoryFixture();
  try {
    const binding = resolveXcodeCloudTagBinding({
      tag: 'v1.2.3',
      repository: fixture.repository,
      infoPlist: fixture.infoPlist,
      expectedSourceSha: fixture.sourceSha,
    });
    assert.equal(binding.appleMarketingVersion, '1.2.3');
    assert.equal(binding.appleBuildNumber, 1002003);
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
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      tag: 'v1.2.3',
      sourceSha: fixture.sourceSha,
      appleMarketingVersion: '1.2.3',
      appleBuildNumber: 1002003,
      applied: false,
    });
    assert.equal(readFileSync(fixture.infoPlist, 'utf8'), before);
  } finally {
    rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('macOS에서는 태그 파생 Apple version을 임시 plist에서 검증한 뒤 원자적으로 반영한다', {
  skip: process.platform !== 'darwin',
}, () => {
  const fixture = repositoryFixture();
  try {
    const binding = resolveXcodeCloudTagBinding({
      tag: 'v1.2.3',
      repository: fixture.repository,
      infoPlist: fixture.infoPlist,
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
      '1002003',
    );
  } finally {
    rmSync(fixture.repository, { recursive: true, force: true });
  }
});
