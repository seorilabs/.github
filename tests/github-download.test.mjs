import test from 'node:test';
import assert from 'node:assert/strict';
import {githubDownload} from '../scripts/github-rest.mjs';

test('Actions ZIP accepts JSON on API request and drops credentials on blob redirect',async()=>{
 const calls=[];
 const fetchImpl=async(url,init)=>{
  calls.push({url,init});
  if(calls.length===1){
   if(init.headers.accept!=='application/vnd.github+json')return new Response('Must accept application/json',{status:415});
   return new Response(null,{status:302,headers:{location:'https://blob.example/artifact.zip'}});
  }
  assert.equal(init.headers.authorization,undefined);
  assert.equal(init.headers.accept,'application/octet-stream');
  return new Response(Buffer.from('exact zip bytes'));
 };
 const bytes=await githubDownload('/repos/seorilabs/betta-raising/actions/artifacts/13975726650/zip',{token:'fixture',accept:'application/vnd.github+json',fetchImpl});
 assert.equal(bytes.toString(),'exact zip bytes');assert.equal(calls.length,2);
 assert.equal(calls[0].init.headers.authorization,'Bearer fixture');
});

test('Release assets retain octet-stream default',async()=>{
 const bytes=await githubDownload('/repos/owner/repo/releases/assets/1',{token:'fixture',fetchImpl:async(_url,init)=>{
  assert.equal(init.headers.accept,'application/octet-stream');return new Response('asset');
 }});assert.equal(bytes.toString(),'asset');
});
