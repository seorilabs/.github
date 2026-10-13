import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { context, SHA, validEvidence } from './helpers/development-evidence-fixture.mjs';

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
