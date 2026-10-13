import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyReleaseDevelopmentEvidence } from '../scripts/release/verify-development-evidence.mjs';
import { context, SHA, validEvidence } from './helpers/development-evidence-fixture.mjs';
import { findHumanReleaseException } from '../scripts/release/human-release-exception.mjs';

const ctx = { repository: 'seorilabs/jomul', tag: 'v1.1.2', sourceSha: '975d2e8c555bcb43f37a9034c881bfb17574cfea', target: 'google-play', phase: 'before-build', now: '2026-10-13T09:00:00Z' };
test('the recorded human approval permits only the exact candidate and is a waiver, not E2E proof', () => {
  const result = findHumanReleaseException(ctx);
  assert.equal(result?.id, 'jomul-v1.1.2-review-20261013');
  assert.equal(result?.objective, 'submitted');
  assert.equal(result?.approverKind, 'human');
  assert.match(result?.reason, /4 blocked/);
});
for (const target of ['google-play','app-store']) for (const phase of ['before-build','before-deploy']) {
  test(`the approval covers ${target} ${phase}`, () => assert.ok(findHumanReleaseException({ ...ctx, target, phase })));
}
for (const [name, changes] of [
  ['another repo', {repository:'seorilabs/other'}], ['a case-different repo', {repository:'seorilabs/Jomul'}],
  ['another version', {tag:'v1.1.3'}], ['a draft archive', {tag:'development-evidence'}],
  ['a different SHA', {sourceSha:'f'.repeat(40)}], ['AppsInToss', {target:'apps-in-toss'}],
  ['an unknown phase', {phase:'public-release'}], ['before human approval', {now:'2026-10-13T08:42:24Z'}],
  ['at absolute expiry', {now:'2026-10-20T08:42:25Z'}], ['after expiry', {now:'2026-10-21T00:00:00Z'}],
  ['invalid clock', {now:'not-a-time'}],
]) test(`no exception for ${name}`, () => assert.equal(findHumanReleaseException({...ctx,...changes}), null));

function liveTagApi({ tagSha = ctx.sourceSha, status = 200, type = 'tag', deniedPath } = {}) {
  const calls = [];
  return { calls, fetchImpl: async url => {
    calls.push(url);
    let data;
    if (url.includes('/releases/tags/v1.1.2')) data = { id: 100 };
    else if (url.includes('/git/ref/tags/v1.1.2')) data = { ref: 'refs/tags/v1.1.2', object: { type, sha: 'a'.repeat(40) } };
    else if (url.includes('/git/tags/')) data = { sha: 'a'.repeat(40), tag: 'v1.1.2', object: { type: 'commit', sha: tagSha } };
    else if (url.includes('/releases/100/assets')) data = [];
    else throw new Error('Unexpected URL');
    return new Response(JSON.stringify(data), { status: deniedPath && !url.includes(deniedPath) ? 200 : status, headers: { 'content-type': 'application/json' } });
  }};
}
test('the live exact annotated tag yields an auditable human exception instead of fabricated evidence', async () => {
  const api = liveTagApi();
  const result = await verifyReleaseDevelopmentEvidence({ ...ctx, token: 'fixture-token', fetchImpl: api.fetchImpl });
  assert.equal(result.verificationStatus, 'human-exception');
  assert.equal(result.exceptionId, 'jomul-v1.1.2-review-20261013');
  assert.equal(result.completedAt, new Date(ctx.now).toISOString());
  assert.equal(result.completionKind, 'exception-decision');
  assert.equal(result.productE2eStatus, 'blocked');
  assert.equal(result.assetId, undefined);
  assert.equal(api.calls.length, 3);
});
for (const [name, args, message] of [
  ['moved tag', {tagSha:'f'.repeat(40)}, /EXCEPTION_TAG_BINDING_MISMATCH/],
  ['lightweight tag', {type:'commit'}, /EXCEPTION_TAG_BINDING_MISMATCH/],
  ['denied tag ref', {status:403, deniedPath:'/git/ref/tags/'}, /403/],
  ['denied tag object', {status:403, deniedPath:'/git/tags/'}, /403/],
]) {
  test(`approved exception still blocks ${name}`, async () => {
    const api = liveTagApi(args);
    await assert.rejects(verifyReleaseDevelopmentEvidence({...ctx,token:'fixture-token',fetchImpl:api.fetchImpl}), message);
    if (args.deniedPath) assert.ok(api.calls.some(url => url.includes(args.deniedPath)));
  });
}
test('approval expires if its tag readback finishes at the absolute deadline', async () => {
  let reads = 0;
  const options = {...ctx, token:'fixture-token', fetchImpl:liveTagApi().fetchImpl};
  Object.defineProperty(options, 'now', {get:()=> ++reads === 1 ? '2026-10-20T08:42:24.900Z' : '2026-10-20T08:42:25Z'});
  await assert.rejects(verifyReleaseDevelopmentEvidence(options), /EXCEPTION_EXPIRED_DURING_READBACK/);
});
test('expired approval returns to mandatory normal evidence lookup', async () => {
  await assert.rejects(verifyReleaseDevelopmentEvidence({...ctx,now:'2026-10-20T08:42:25Z',token:'fixture-token',fetchImpl:liveTagApi().fetchImpl}), /REQUIRED_DEVELOPMENT_EVIDENCE_MISSING/);
});
test('CLI preserves the one-row Xcode Cloud receipt and supports the exact build completion bound', () => {
  const dir = mkdtempSync(join(tmpdir(),'development-evidence-receipt-'));
  try {
    const d = validEvidence(), now = Date.now();
    d.iterations.forEach((r,i)=> {r.plannedAt=new Date(now-(6-i)*3600000).toISOString();r.startedAt=new Date(now-(6-i)*3600000+1000).toISOString();r.completedAt=new Date(now-(6-i)*3600000+2000).toISOString();});
    d.e2e.plannedAt=new Date(now-60000).toISOString();d.e2e.startedAt=new Date(now-40000).toISOString();d.e2e.completedAt=new Date(now-20000).toISOString();
    const report=join(dir,'evidence.json'),inventory=join(dir,'inventory.json'),output=join(dir,'output');
    writeFileSync(report,JSON.stringify(d));writeFileSync(inventory,JSON.stringify(context.featureInventory));
    const args=['scripts/release/verify-development-evidence.mjs','--file',report,'--feature-inventory',inventory,'--repo',context.repository,'--sha',SHA,'--target',context.target,'--phase','before-deploy','--after',d.e2e.completedAt];
    const env={...process.env,GITHUB_OUTPUT:output};
    const accepted=spawnSync(process.execPath,args,{env,encoding:'utf8'});assert.equal(accepted.status,0,accepted.stderr);
    assert.equal(readFileSync(output,'utf8'),`completed_at=${d.e2e.completedAt}\n`);
    args[args.length-1]=new Date(now-10000).toISOString();const old=spawnSync(process.execPath,args,{env,encoding:'utf8'});assert.equal(old.status,1);assert.match(old.stderr,/EVIDENCE_COMPLETION_BEFORE_BUILD/);
    assert.equal(readFileSync(output,'utf8'),`completed_at=${d.e2e.completedAt}\n`);
    args[args.length-1]='bad-time';assert.equal(spawnSync(process.execPath,args,{env,encoding:'utf8'}).status,1);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
