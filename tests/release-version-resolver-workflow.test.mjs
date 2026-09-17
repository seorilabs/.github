import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(
  resolve(import.meta.dirname, '../.github/workflows/resolve-release-version.yml'),
  'utf8',
);

test('custom build 경로도 중앙 exact tag binding만 입력으로 받는다', () => {
  assert.match(workflow, /repository: seorilabs\/\.github/u);
  assert.match(workflow, /ref: main/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /checkout "refs\/tags\/\$tag"/u);
  assert.match(workflow, /\[ "\$tag_commit" = "\$head_commit" \]/u);
  assert.match(
    workflow,
    /resolve-release-version\.mjs \\\n {14}--ledger-file "\$RUNNER_TEMP\/release-version-ledger\.json" --github-output/u,
  );
  // hot path는 원장 tip과 대상 태그 ref만 읽는다.
  assert.match(workflow, /fetch-depth: 1/u);
  assert.match(workflow, /fetch-tags: false/u);
  assert.match(workflow, /git ls-remote --exit-code --heads origin "\$LEDGER_BRANCH"/u);
  assert.doesNotMatch(workflow, /git tag --list/u);
  assert.doesNotMatch(workflow, /--tag-list-file/u);
  assert.match(workflow, /tag: \$\{\{ steps\.tag\.outputs\.tag \}\}/u);
  assert.match(workflow, /source_sha: \$\{\{ steps\.release\.outputs\.source_sha \}\}/u);
  assert.match(workflow, /binding_base64=/u);
  assert.match(workflow, /binding_digest: \$\{\{ steps\.release\.outputs\.binding_digest \}\}/u);
  assert.doesNotMatch(workflow, /package\.json|project\.godot|google-play\.config\.json|app-store\.config\.json/u);
  assert.doesNotMatch(workflow, /secrets: inherit|version_name:\s*\n\s*required:\s*true/u);
});
