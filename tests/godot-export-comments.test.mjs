import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyGodotExportVersion, createReleaseBinding } from '../scripts/release/tag-version-authority.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceSha = 'a'.repeat(40);
const binding = createReleaseBinding({ tag: 'v1.1.7', sourceSha, configRevision: 'b'.repeat(64),
  authorityRevision: 'c'.repeat(64), androidVersionCode: 24, androidVersionCodeSource: 'github-ledger' });
const original = '[preset.0]\nname="Android"\nplatform="Android"\n[preset.0.options]\n# leave other preset\nversion/code=1\nversion/name="old"\n[preset.2]\nname="iOS"\nplatform="iOS"\n[preset.2.options]\napplication/short_version=""\napplication/version=""\n# SDK tracking declaration\n  # SDK owns its manifest\nprivacy/tracking_enabled=true\nprivacy/camera_usage_description="literal # stays"\n';
const frozen = readFileSync(join(root, 'tests/fixtures/godot/match-picture-1.1.7-export-presets.cfg'), 'utf8');

test('explicit comment canonicalization restores the selected ConfigFile key without changing settings or other presets', () => {
  const result = applyGodotExportVersion(original, { platform: 'iOS', preset: 'iOS', binding, canonicalizeComments: true });
  assert.match(result, /; SDK tracking declaration\n  ; SDK owns its manifest\nprivacy\/tracking_enabled=true/u);
  assert.match(result, /# leave other preset/u);
  assert.match(result, /privacy\/camera_usage_description="literal # stays"/u);
  assert.match(result, /application\/version="1001007"/u);
  const normal = applyGodotExportVersion(original, { platform: 'iOS', preset: 'iOS', binding });
  assert.match(normal, /# SDK tracking declaration/u);
  assert.equal(result, normal.replace(/^([ \t]*)#(?= (?:SDK tracking declaration|SDK owns its manifest))/gmu, '$1;'));
});

test('one-release CLI rejects another candidate, tag, repository or source bytes before writing either input file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'godot-comment-cli-'));
  const presets = join(dir, 'export_presets.cfg'), project = join(dir, 'project.godot'), bindingPath = join(dir, 'binding.json');
  try {
    for (const changes of [{ GITHUB_SHA: 'd'.repeat(40) }, { GITHUB_REPOSITORY: 'seorilabs/another-app' },
      { binding: createReleaseBinding({ ...binding, tag: 'v1.1.8' }) }, { original }]) {
      const input = changes.original ?? frozen;
      writeFileSync(presets, input); writeFileSync(project, '[application]\nconfig/version="old"\n');
      writeFileSync(bindingPath, JSON.stringify(changes.binding ?? binding));
      const run = spawnSync(process.execPath, [join(root, 'scripts/release/apply-godot-export-version.mjs'),
        '--binding', bindingPath, '--platform', 'iOS', '--preset', 'iOS', '--presets', presets, '--project', project,
        '--release-exception-id', 'match-picture-1.1.7'], {
        encoding: 'utf8', env: { ...process.env,
          GITHUB_REPOSITORY: changes.GITHUB_REPOSITORY ?? 'seorilabs/match-picture-app',
          GITHUB_SHA: changes.GITHUB_SHA ?? sourceSha },
      });
      assert.equal(run.status, 1, run.stdout);
      assert.match(run.stderr, /RELEASE_EXCEPTION_COMMENT_SCOPE_CHANGED/u);
      assert.equal(readFileSync(presets, 'utf8'), input);
      assert.equal(readFileSync(project, 'utf8'), '[application]\nconfig/version="old"\n');
    }
  } finally { rmSync(dir, { recursive: true }); }
});

test('one-release CLI derives only the granted iOS comment syntax and tag versions from frozen source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'godot-comment-cli-'));
  const presets = join(dir, 'export_presets.cfg'), bindingPath = join(dir, 'binding.json');
  try {
    writeFileSync(presets, frozen); writeFileSync(bindingPath, JSON.stringify(binding));
    const run = spawnSync(process.execPath, [join(root, 'scripts/release/apply-godot-export-version.mjs'),
      '--binding', bindingPath, '--platform', 'iOS', '--preset', 'iOS', '--presets', presets,
      '--release-exception-id', 'match-picture-1.1.7'], {
      encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: 'seorilabs/match-picture-app', GITHUB_SHA: sourceSha },
    });
    assert.equal(run.status, 0, run.stderr);
    const actual = readFileSync(presets, 'utf8');
    assert.match(actual, /; SDK 광고 식별자/u);
    assert.match(actual, /; Google\/UMP SDK/u);
    assert.match(actual, /^privacy\/tracking_enabled=true$/mu);
    assert.match(actual, /^# 앱인토스 WebView/mu);
    assert.equal(actual, applyGodotExportVersion(frozen, { platform: 'iOS', preset: 'iOS', binding })
      .replace(/^# SDK 광고/mu, '; SDK 광고').replace(/^# Google\/UMP/mu, '; Google/UMP'));
  } finally { rmSync(dir, { recursive: true }); }
});
