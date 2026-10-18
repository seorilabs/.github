import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'yaml';

for (const [filename, job] of [
  ['release-tag.yml', 'create'],
  ['init-release-version-ledger.yml', 'initialize'],
]) {
  const workflow = parse(readFileSync(new URL(`../.github/workflows/${filename}`, import.meta.url), 'utf8'));
  const expression = workflow.jobs[job]['runs-on'].replace(/^\$\{\{\s*|\s*\}\}$/gu, '');
  for (const [name, owner, visibility, runner] of [
    ['Seorilabs private', 'seorilabs', 'private', 'seorilabs-x64'],
    ['Seorilabs public', 'seorilabs', 'public', 'ubuntu-latest'],
    ['external private', 'seoleeapps', 'private', 'ubuntu-latest'],
    ['external public', 'seoleeapps', 'public', 'ubuntu-latest'],
    ['missing owner', undefined, 'private', 'ubuntu-latest'],
    ['missing visibility', 'seorilabs', undefined, 'ubuntu-latest'],
  ]) {
    test(`${filename}: ${name} runs where the caller can access a runner`, () => {
      const context = { github: { repository_owner: owner, event: { repository: { visibility } } } };
      assert.equal(vm.runInNewContext(expression, context, { timeout: 100 }), runner);
    });
  }
  test(`${filename}: caller input cannot select a privileged runner`, () => {
    assert.doesNotMatch(expression, /inputs\./u);
    assert.equal(Object.hasOwn(workflow.on.workflow_call.inputs, 'runs_on'), false);
    assert.deepEqual(workflow.permissions, { contents: 'write' });
  });
}
