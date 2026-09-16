// caller 저장소가 아직 자기 버전을 들고 있는지 기계적으로 찾아내는 도구의 계약이다.
// 릴리스 태그가 version authority이므로, 저장소 안의 버전 값과 caller가 넘기는 version
// 입력은 전부 결함이다.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  EXCLUSION_REASONS,
  collectCallerMigrationInventory,
  extractPolicyRepositories,
  readFilesystemSnapshot,
  summarizeFleet,
} from '../scripts/release/collect-caller-migration-inventory.mjs';

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

    const inventory = collectCallerMigrationInventory(
      readFilesystemSnapshot(root),
      'seorilabs/example-app',
      { expectedCentralSha: 'b'.repeat(40) },
    );
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
      // 이전 중앙 SHA에 고정된 caller는 이관 대상으로 잡혀야 한다.
      'caller-pinned-to-superseded-sha',
      // 원장 초기화 caller가 없으면 번호를 할당할 수 없다.
      'ledger-caller-missing',
    ]) {
      assert.ok(ids.has(expected), expected);
    }
    assert.deepEqual(
      inventory.callers.map(({ calledWorkflowShaExpected }) => calledWorkflowShaExpected).sort(),
      [false, null],
    );
    // 비밀값이나 저장소 내용은 담지 않는다.
    assert.doesNotMatch(JSON.stringify(inventory), /import sys/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('마켓 caller만 있고 release-tag caller가 없으면 원장을 채울 경로가 없다', () => {
  const root = mkdtempSync(join(tmpdir(), 'caller-migration-no-tag-'));
  try {
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github/workflows/deploy-google-play.yml'),
      [
        'jobs:',
        '  deploy:',
        `    uses: seorilabs/.github/.github/workflows/godot-deploy-google-play.yml@${'a'.repeat(40)}`,
        '',
      ].join('\n'),
    );
    const inventory = collectCallerMigrationInventory(readFilesystemSnapshot(root), 'seorilabs/jomul-like');
    const ids = new Set(inventory.findings.map(({ id }) => id));
    assert.ok(ids.has('release-tag-caller-missing'));
    assert.equal(inventory.status, 'NEEDS_CHANGE');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fleet 요약은 모든 저장소를 세 상태 중 하나로 분류하고 제외 사유를 고정 enum으로 남긴다', () => {
  const inventoryFor = (callers, status = 'READY') => ({
    schemaVersion: 2,
    callers: callers.map((callerKind) => ({ callerKind })),
    findings: status === 'READY' ? [] : [{ id: 'caller-pinned-to-superseded-sha', severity: 'blocking' }],
    status,
  });

  const fleet = summarizeFleet(
    [
      { fullName: 'seorilabs/migrated', inventory: inventoryFor(['release-tag', 'godot-deploy-google-play']) },
      {
        fullName: 'seorilabs/pending',
        inventory: inventoryFor(['release-tag', 'rn-deploy-google-play'], 'NEEDS_CHANGE'),
      },
      { fullName: 'seorilabs/no-caller', inventory: inventoryFor([]) },
      { fullName: 'seorilabs/jomul', inventory: inventoryFor(['godot-deploy-google-play']) },
      { fullName: 'seorilabs/archived', archived: true, inventory: inventoryFor(['release-tag']) },
    ],
    { expectedCentralSha: 'c'.repeat(40), observedAt: '2026-09-16T00:00:00Z' },
  );

  assert.deepEqual(fleet.summary, { migrated: 1, pending: 1, excluded: 3 });
  assert.equal(fleet.status, 'NEEDS_CHANGE');
  for (const row of fleet.repositories) {
    assert.ok(['MIGRATED', 'PENDING', 'EXCLUDED'].includes(row.state), row.fullName);
    if (row.state === 'EXCLUDED') {
      assert.ok(EXCLUSION_REASONS.includes(row.exclusionReason), row.exclusionReason);
    }
  }
  assert.equal(
    fleet.repositories.find(({ fullName }) => fullName === 'seorilabs/jomul').exclusionReason,
    'no-central-release-tag-caller',
  );
});

test('순회 대상 저장소 목록은 정책 계약에서 읽는다', () => {
  const policy = [
    'repositories:',
    '  - repository: seorilabs/jomul',
    '    registration: ENABLED',
    '  - repository: seorilabs/happy-farm',
    '    registration: EXCLUDED',
  ].join('\n');
  assert.deepEqual(extractPolicyRepositories(policy), ['seorilabs/jomul', 'seorilabs/happy-farm']);
});
