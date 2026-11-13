import test from 'node:test';
import assert from 'node:assert/strict';
import {readV012GoogleFailureLog} from '../scripts/release/betta-v012-artifact-upload.mjs';
test('GitHub job log endpoint receives its JSON media header and preserves raw log bytes',async()=>{
 const expected=Buffer.from('\u001b[31mBETTA_UNTRACKED_SOURCE "tools/__pycache__/pinned_download.cpython-313.pyc"\u001b[0m\n');
 const fetchImpl=async(raw,init)=>{
  assert.equal(new URL(raw).pathname,'/repos/seorilabs/betta-raising/actions/jobs/131906522643/logs');
  if(new Headers(init.headers).get('accept')!=='application/vnd.github+json')return Response.json({message:'Unsupported Accept header: application/octet-stream'},{status:415});
  return new Response(expected,{headers:{'content-type':'text/plain'}});
 };
 assert.deepEqual(await readV012GoogleFailureLog('seorilabs/betta-raising',131906522643,{token:'fixture',fetchImpl}),expected);
});
