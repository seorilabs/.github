import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateBettaGrant,validateBettaInternalContext,validateBettaAabRecoveryContext} from '../scripts/release/betta-internal-bootstrap.mjs';
const original=JSON.parse(readFileSync(new URL('../contracts/betta-internal-bootstrap/betta-0-1-0-google-first-internal.json',import.meta.url)));
const schema=JSON.parse(readFileSync(new URL('../contracts/betta-internal-bootstrap-grant.schema.json',import.meta.url)));
const recovery=()=>Object.fromEntries(Object.entries(schema.properties.existingAabRecovery.properties).filter(([k])=>k!=='preflightRetry').map(([k,v])=>[k,v.const ?? (k==='uploaderCodeSha'?'a'.repeat(40):'b'.repeat(64))]));
const grant=()=>({...original,revoked:false,existingAabRecovery:recovery()});
const context=()=>({repository:original.repository,sourceSha:original.sourceSha,tag:original.releaseTag,configurationFingerprint:original.configurationFingerprint,target:'google-play',phase:'before-deploy',playTrack:'internal',playOperation:'upload',now:'2026-11-13T00:00:00Z'});
test('upload-only grant cannot admit any normal build or normal deploy path',()=>{
 const g=grant();validateBettaGrant(g);
 for(const phase of ['before-build','before-deploy'])assert.throws(()=>validateBettaInternalContext(g,{...context(),phase},{ok:false,errors:g.allowedErrors}),/BETTA_UPLOAD_ONLY_REQUIRED/u);
 const d=validateBettaAabRecoveryContext(g,context(),{ok:false,errors:g.allowedErrors});assert.equal(d.productE2eStatus,'blocked');assert.equal(d.publicReleaseAllowed,false);
 assert.throws(()=>validateBettaAabRecoveryContext(g,{...context(),phase:'before-build'},{ok:false,errors:g.allowedErrors}));
});
for(const patch of [{additionalGameBuilds:1},{fullWorkingTreeAuditPassed:true},{artifactSha256:'a'.repeat(64)},{sourceRunIds:[43286867642]},{maxRecoveryRuns:2},{workflowPath:'.github/workflows/deploy-google-play.yml'},{unknown:true}])test(`reject recovery expansion ${JSON.stringify(patch)}`,()=>assert.throws(()=>validateBettaGrant({...grant(),existingAabRecovery:{...recovery(),...patch}})));
test('upload-only source and release are exact, not a new candidate',()=>{
 for(const patch of [{sourceSha:'d'.repeat(40)},{releaseTag:'v0.1.1'},{targets:['app-store']}])assert.throws(()=>validateBettaGrant({...grant(),...patch}));
});

test('preflight retry contract is closed to the recorded readonly failure',()=>{
 const g=grant(),spec=schema.properties.existingAabRecovery.properties.preflightRetry;
 const retry=Object.fromEntries(Object.entries(spec.properties).map(([k,v])=>[k,v.const]));
 validateBettaGrant({...g,existingAabRecovery:{...g.existingAabRecovery,preflightRetry:retry}});
 for(const patch of [{runId:1},{allowedAttempt:3},{failedAttempt:2},{rawJobLogSha256:'a'.repeat(64)},{originalGrantCommit:'a'.repeat(40)},{extra:true}])assert.throws(()=>validateBettaGrant({...g,existingAabRecovery:{...g.existingAabRecovery,preflightRetry:{...retry,...patch}}}));
});
