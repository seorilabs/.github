import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';

// 세 워크플로우가 같은 출시노트 해석 경로를 쓴다. 한 곳만 고치면 나머지가 조용히 어긋난다.
const TARGETS = [
  { file: 'promote-google-play.yml', job: 'promote', consumer: 'Promote track' },
  { file: 'rn-deploy-google-play.yml', job: 'build-aab', consumer: 'Upload AAB to Google Play' },
  { file: 'godot-deploy-google-play.yml', job: 'build-aab', consumer: 'Upload to Google Play' },
];

const RESOLVER = '.seorilabs-release-authority/scripts/release/resolve-release-notes.mjs';

async function loadSteps({ file, job }) {
  const source = await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
  return parse(source).jobs[job].steps;
}

for (const target of TARGETS) {
  test(`${target.file}은 중앙 해석기로 출시노트를 받는다`, async () => {
    const steps = await loadSteps(target);
    const notesIndex = steps.findIndex(({ name }) => name === 'Resolve store release notes');
    assert.ok(notesIndex >= 0, '출시노트 해석 스텝이 필요하다.');

    const notes = steps[notesIndex];
    assert.equal(notes.id, 'notes');
    assert.match(notes.run, new RegExp(`node ${RESOLVER.replace(/[./]/gu, '\\$&')} --github-output`, 'u'));

    // 실패 사유를 버리면 「자산 없음」과 「자산은 있는데 못 읽음」을 가릴 수 없다(#166).
    assert.doesNotMatch(notes.run, /2>\s*\/dev\/null/u);
    assert.doesNotMatch(notes.run, /\bgh\s+release\b/u);

    assert.equal(notes.env.GH_TOKEN, '${{ github.token }}');
    assert.equal(notes.env.RELEASE_TAG, '${{ steps.tag.outputs.tag }}');
    assert.equal(notes.env.RELEASE_NOTES_OUTPUT, '${{ runner.temp }}/release-notes.json');
  });

  test(`${target.file}은 해석기보다 먼저 중앙 번들을 체크아웃한다`, async () => {
    const steps = await loadSteps(target);
    const notesIndex = steps.findIndex(({ name }) => name === 'Resolve store release notes');
    const checkoutIndex = steps.findIndex(
      (step) => step.with?.path === '.seorilabs-release-authority',
    );
    assert.ok(checkoutIndex >= 0, '중앙 release authority 체크아웃이 필요하다.');
    assert.ok(
      checkoutIndex < notesIndex,
      '해석기 스크립트는 체크아웃 뒤에만 존재한다.',
    );
  });

  test(`${target.file}은 해석 결과를 업로드 스텝에 넘긴다`, async () => {
    const steps = await loadSteps(target);
    const consumer = steps.find(({ name }) => name === target.consumer);
    assert.ok(consumer, `${target.consumer} 스텝이 필요하다.`);
    assert.equal(
      consumer.env.RELEASE_NOTES_JSON,
      "${{ steps.notes.outputs.found == 'true' && steps.notes.outputs.path || '' }}",
    );
  });
}

test('cleanup-actions-storage는 중앙 REST 스크립트로 정리한다', async () => {
  const source = await readFile(
    new URL('../.github/workflows/cleanup-actions-storage.yml', import.meta.url),
    'utf8',
  );
  const steps = parse(source).jobs.cleanup.steps;
  const checkoutIndex = steps.findIndex(
    (step) => step.with?.path === '.seorilabs-actions-storage',
  );
  assert.ok(checkoutIndex >= 0, '중앙 스크립트 체크아웃이 필요하다.');
  // 삭제 권한이 있는 job도 중앙 정본 main에서 스크립트를 받는다.
  assert.equal(steps[checkoutIndex].with.repository, 'seorilabs/.github');
  assert.equal(steps[checkoutIndex].with.ref, 'main');

  for (const [kind, name] of [
    ['artifacts', 'Delete workflow artifacts'],
    ['caches', 'Delete Actions caches'],
  ]) {
    const index = steps.findIndex((step) => step.name === name);
    assert.ok(index > checkoutIndex, `${name}은 체크아웃 뒤에 온다.`);
    assert.match(
      steps[index].run,
      new RegExp(`node \\.seorilabs-actions-storage/scripts/cleanup-actions-storage\\.mjs --kind ${kind}`, 'u'),
    );
  }
});
