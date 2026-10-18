import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveGitHubTagCommit } from '../scripts/release/resolve-github-tag-commit.mjs';

const sha = 'a'.repeat(40);
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type':'application/json' } });

test('approved external Today Challenger consumer resolves its exact annotated tag', async () => {
  const urls = [];
  const result = await resolveGitHubTagCommit({
    repository:'seoleeapps/today-challenger', ref:'refs/tags/v0.1.0', token:'fixture-only',
    fetchImpl:async url => {
      urls.push(url);
      return response(urls.length === 1
        ? {ref:'refs/tags/v0.1.0',object:{type:'tag',sha:'b'.repeat(40)}}
        : {sha:'b'.repeat(40),tag:'v0.1.0',object:{type:'commit',sha}});
    }
  });
  assert.equal(result.sourceSha,sha);
  assert.deepEqual(urls,[
    'https://api.github.com/repos/seoleeapps/today-challenger/git/ref/tags/v0.1.0',
    'https://api.github.com/repos/seoleeapps/today-challenger/git/tags/'+ 'b'.repeat(40)
  ]);
});

for (const repository of ['seoleeapps/other-app','another/today-challenger','seoleeapps/today-challenger-copy','seoleeapps/today-challenger/extra','seoleeapps/today-challenger?other=repo']) {
  test('unapproved repository is rejected before credentials are sent: '+repository, async () => {
    let called=false;
    await assert.rejects(resolveGitHubTagCommit({repository,ref:'refs/tags/v0.1.0',token:'fixture-only',fetchImpl:async()=>{called=true;throw new Error('must not fetch');}}), /RELEASE_TAG_READBACK_INPUT_INVALID/);
    assert.equal(called,false);
  });
}
