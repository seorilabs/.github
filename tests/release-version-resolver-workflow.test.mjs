import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(
  resolve(import.meta.dirname, '../.github/workflows/resolve-release-version.yml'),
  'utf8',
);

test('custom build 경로도 중앙 exact tag binding만 입력으로 받는다', () => {
  assert.match(workflow, /EXPECTED_WORKFLOW_PATH: seorilabs\/\.github\/\.github\/workflows\/resolve-release-version\.yml/u);
  assert.match(workflow, /identity\.workflow_repository !== "seorilabs\/\.github"/u);
  assert.match(workflow, /\/\^\[0-9a-f\]\{40\}\$\/\.test\(identity\.workflow_sha/u);
  assert.match(workflow, /ref: \$\{\{ steps\.authority\.outputs\.sha \}\}/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /checkout "refs\/tags\/\$tag"/u);
  assert.match(workflow, /\[ "\$tag_commit" = "\$head_commit" \]/u);
  assert.match(workflow, /resolve-release-version\.mjs --github-output/u);
  assert.match(workflow, /tag: \$\{\{ steps\.tag\.outputs\.tag \}\}/u);
  assert.match(workflow, /source_sha: \$\{\{ steps\.release\.outputs\.source_sha \}\}/u);
  assert.match(workflow, /binding_base64=/u);
  assert.match(workflow, /binding_digest: \$\{\{ steps\.release\.outputs\.binding_digest \}\}/u);
  assert.doesNotMatch(workflow, /package\.json|project\.godot|google-play\.config\.json|app-store\.config\.json/u);
  assert.doesNotMatch(workflow, /secrets: inherit|@main|version_name:\s*\n\s*required:\s*true/u);
});
