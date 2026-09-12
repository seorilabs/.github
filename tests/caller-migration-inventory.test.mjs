// caller 저장소가 아직 자기 버전을 들고 있는지 기계적으로 찾아내는 도구의 계약이다.
// 릴리스 태그가 version authority이므로, 저장소 안의 버전 값과 caller가 넘기는 version
// 입력은 전부 결함이다.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { collectCallerMigrationInventory } from '../scripts/release/collect-caller-migration-inventory.mjs';

test('caller migration inventory는 남은 결함을 기계적으로 찾아낸다', () => {
  const root = mkdtempSync(join(tmpdir(), 'caller-migration-'));
  try {
    const write = (path, body) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
    };
    write(
      '.github/workflows/deploy-google-play.yml',
      [
        'name: Deploy Google Play',
        'on:',
        '  workflow_dispatch: {}',
        'jobs:',
        '  deploy:',
        `    uses: seorilabs/.github/.github/workflows/godot-deploy-google-play.yml@${'a'.repeat(40)}`,
        '    with:',
        '      track: internal',
        '      version_name: 1.2.3',
        '      runs_on: ubuntu-latest',
        '',
      ].join('\n'),
    );
    write(
      '.github/workflows/release-tag.yml',
      [
        'name: Release Tag',
        'on:',
        '  workflow_dispatch: {}',
        'jobs:',
        '  tag:',
        '    uses: seorilabs/.github/.github/workflows/release-tag.yml@main',
        '    with:',
        '      runs_on: seorilabs-rpi-arm64',
        '',
      ].join('\n'),
    );
    write('scripts/resolve-release-version.mjs', 'export default 1;\n');
    write(
      'play-store/google-play.config.json',
      `${JSON.stringify({ release: { versionName: '1.2.3', versionCode: 1001002003 } }, null, 2)}\n`,
    );

    const inventory = collectCallerMigrationInventory(root, 'seorilabs/example-app');
    assert.equal(inventory.status, 'NEEDS_CHANGE');
    assert.deepEqual(
      inventory.callers.map(({ callerKind }) => callerKind).sort(),
      ['godot-deploy-google-play', 'release-tag'],
    );
    // 러너를 중앙에서 고정했으므로 남아 있는 runs_on은 workflow_call을 깨뜨리는 결함이다.
    const obsolete = inventory.findings.filter(({ id }) => id === 'obsolete-caller-input');
    assert.deepEqual(
      obsolete.map(({ path: found }) => found).sort(),
      ['.github/workflows/deploy-google-play.yml', '.github/workflows/release-tag.yml'],
    );
    const ids = new Set(inventory.findings.map(({ id }) => id));
    for (const expected of [
      'caller-ref-not-pinned',
      'forbidden-version-input',
      'obsolete-caller-input',
      'repository-local-version-resolver',
      'market-config-version-authority',
    ]) {
      assert.ok(ids.has(expected), expected);
    }
    // 비밀값이나 저장소 내용은 담지 않는다.
    assert.doesNotMatch(JSON.stringify(inventory), /import sys/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
