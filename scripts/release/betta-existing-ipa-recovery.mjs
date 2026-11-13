// 실패한 Cloud #3의 정확한 App Store export만 재사용한다. 빌드·재서명·재시도는 없다.
import {readFileSync,writeFileSync,mkdtempSync,rmSync,realpathSync,readdirSync,lstatSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {githubJson,githubDownload,githubPaginate} from '../github-rest.mjs';
import {readReviewedBettaGrant,readBettaFile} from './betta-internal-grant-store.mjs';
import {bettaDigest,verifyBettaSource,validateBettaIpaRecoveryContext} from './betta-internal-bootstrap.mjs';
import {bettaConfigurationFingerprint} from './betta-internal-execution.mjs';
import {appleGet,appleList} from './betta-internal-provider.mjs';
import {inspectBettaAppleApp} from './betta-internal-apple-artifact.mjs';
import {postUnique} from './betta-existing-aab-recovery.mjs';
import {parseTagReceipt,AUTHORITY_ID,computeAuthorityRevision} from './tag-version-authority.mjs';
const fail=code=>{throw new Error(code);};
export const IPA_RECOVERY=Object.freeze({
 sourceGrantId:'betta-0-1-1-apple-sdk-download-recovery',sourceGrantCommit:'cd6f1a8092799d813e36a862af15f9a930d25fef',sourceGrantSha256:'b1ff3b8c80afe485d9be130f71f8e7c9a58ab53d87498a4e53da397207ef1038',
 previousSourceSha:'bd78bd996987481d668185da815c6853c4e99a4b',
 runs:['19199616-067d-4497-9289-4b9bb628f0aa','064ecfc0-bcbb-470a-8fe2-0348534a4b5b','845f07b9-5601-4e01-993c-e67285709dec'],
 archiveActionId:'bd3ff4c0-2f4d-44db-8ae9-f4a6802fbacd',postActionId:'8cc45633-9eef-4966-8b59-5c016c787712',
 sourceTagId:'042b7d78-8f70-4e0c-a024-359e1ac3540e',
 artifactId:'50b289bc-ba5f-4b1e-b488-e2e0877354d9',archiveSize:111239439,archiveSha256:'30ef369ae59db71cf803215c2e83d628f19c6d0ae890cabad48ee920d91aa274',
 ipaSize:111349261,ipaSha256:'5ef31cb02850d4de737ac869344f5107ae9ec1b6996859850fa7736159ae4533',
 buildClaimSha256:'5eb5e9641240683b9c0cbd788693e7f5d4bbcde4d45b2b0c15661bfc78b1db18',
 logArtifactId:'e9779afd-1a31-446b-a631-9a068b98d316',logArchiveSha256:'fa98ede3782ce665f16ee3c298fe521db5afdac810227370f02ed9dcadfc11ef',
 additionalGameBuilds:0,cumulativeNativeBuilds:3,cumulativeNativeLimit:4,acceptedUploadLimit:1,
});
export function assertIpaHistory(g,{runs,actions,builds,uploads,workflow}){
 const r=IPA_RECOVERY;
 if(workflow?.id!==g.appStore.workflowId || workflow.attributes?.isEnabled!==false || builds.length || uploads.length || runs.length!==3
  || r.runs.some((id,i)=>runs.filter(x=>x.id===id && x.attributes?.number===i+1 && x.attributes.sourceCommit?.commitSha===(i===2?g.sourceSha:r.previousSourceSha)
    && x.attributes.executionProgress==='COMPLETE' && x.attributes.completionStatus==='FAILED'
    && x.attributes.startReason==='MANUAL' && x.attributes.isPullRequestBuild===false
    && x.relationships?.workflow?.data?.id===g.appStore.workflowId && x.relationships?.product?.data?.id===g.appStore.productId
    && (i!==2 || x.relationships?.sourceBranchOrTag?.data?.id===r.sourceTagId)).length!==1)
  || actions.length!==2 || !actions.some(a=>a.id===r.archiveActionId && a.attributes.actionType==='ARCHIVE' && a.attributes.executionProgress==='COMPLETE' && a.attributes.completionStatus==='FAILED')
  || !actions.some(a=>a.id===r.postActionId && a.attributes.actionType==='TEST' && a.attributes.executionProgress==='COMPLETE' && a.attributes.completionStatus==='SKIPPED' && a.attributes.startedDate===null))fail('BETTA_IPA_HISTORY_OR_MARKET');
}
export function assertIpaArtifact(a){
 if(a?.id!==IPA_RECOVERY.artifactId || a.attributes?.fileType!=='ARCHIVE_EXPORT' || a.attributes.fileName!=='BettaAtelier 0.1.1 app-store.zip' || a.attributes.fileSize!==IPA_RECOVERY.archiveSize)fail('BETTA_IPA_PROVIDER_ARTIFACT');
}
export async function reserveIpaUpload(g,release,identity,request){
 const binding={...identity,sourceSha:g.sourceSha,releaseTag:g.releaseTag,ipaSha256:IPA_RECOVERY.ipaSha256,recordedAt:new Date().toISOString()};
 const global=await postUnique(release,'com.seorilabs.bettaraising.0.1.1.3.upload-intent.json',{kind:'betta-existing-ipa-upload-intent',...binding},request),fences=[];
 for(const attempt of [1,2])fences.push(await postUnique(release,`${IPA_RECOVERY.sourceGrantId}.app-store.${attempt}.before-deploy.json`,{kind:'betta-recovery-upload-fence',...binding,globalUploadIntentAssetId:global.assetId},request));
 return {global,fences};
}
export function assertIpaUploadCredentials(env){
 if(env.APP_STORE_CONNECT_API_KEY_ID!=='UHVPXA39JA' || !env.API_PRIVATE_KEYS_DIR || !env.APP_STORE_CONNECT_ISSUER_ID || !env.APP_STORE_CONNECT_PRIVATE_KEY_BASE64)fail('BETTA_APPLE_UPLOAD_CREDENTIAL_REQUIRED');
 const key=join(env.API_PRIVATE_KEYS_DIR,`AuthKey_${env.APP_STORE_CONNECT_API_KEY_ID}.p8`);
 if(!lstatSync(key).isFile() || lstatSync(key).isSymbolicLink() || !readFileSync(key).equals(Buffer.from(env.APP_STORE_CONNECT_PRIVATE_KEY_BASE64,'base64')))fail('BETTA_APPLE_UPLOAD_KEY_MISMATCH');
}
export async function recoverBettaExistingIpa({id,sourceDirectory,archiveFile,logArchiveFile,report,upload=false,env=process.env,fetchImpl=globalThis.fetch}){
 if(existsSync(report) || existsSync(report+'.upload-result.json'))fail('BETTA_IPA_REPORT_ALREADY_EXISTS');
 if(upload && (env.GITHUB_ACTIONS==='true' || env.CI_XCODE_CLOUD==='TRUE' || !process.argv[1]
  || realpathSync(process.argv[1])!==realpathSync(fileURLToPath(new URL('./recover-betta-existing-ipa.mjs',import.meta.url)))))fail('BETTA_IPA_REVIEWED_LOCAL_CLI_REQUIRED');
 const request={env,fetchImpl},reviewed=await readReviewedBettaGrant(id,request),g=reviewed.grant,r=IPA_RECOVERY;
 if(!isDeepStrictEqual(g.existingIpaRecovery,r))fail('BETTA_IPA_REVIEWED_BINDING');
 const originalBytes=await readBettaFile('seorilabs/.github',`contracts/betta-internal-bootstrap/${r.sourceGrantId}.json`,r.sourceGrantCommit,request);
 if(bettaDigest(originalBytes)!==r.sourceGrantSha256)fail('BETTA_IPA_ORIGINAL_GRANT');
 const original=JSON.parse(originalBytes);
 for(const key of Object.keys(original).filter(k=>!['id','revoked','verifierCommit','originalObservationAssets'].includes(k)))if(!isDeepStrictEqual(original[key],g[key]))fail('BETTA_IPA_SCOPE_CHANGED');
 for(const o of original.originalObservationAssets)if(!g.originalObservationAssets.some(a=>a.name===o.name && a.sha256===o.sha256))fail('BETTA_IPA_HISTORY_REMOVED');
 for(const oldId of ['betta-0-1-0-apple-first-internal',r.sourceGrantId]){
  const old=JSON.parse(await readBettaFile('seorilabs/.github',`contracts/betta-internal-bootstrap/${oldId}.json`,'main',request));if(old.revoked!==true)fail('BETTA_IPA_OLD_ADMISSION_ACTIVE');
 }
 const root=realpathSync(sourceDirectory),fingerprint=bettaConfigurationFingerprint(root,g,'app-store');
 if(fingerprint!==g.configurationFingerprint)fail('BETTA_CONFIGURATION_CHANGED');
 verifyBettaSource(root,g,{phase:'before-build'});
 const ref=await githubJson(`/repos/${g.repository}/git/ref/tags/${g.releaseTag}`,request);if(ref.object?.type!=='tag')fail('BETTA_LEDGER_TAG_REQUIRED');
 const tag=await githubJson(`/repos/${g.repository}/git/tags/${ref.object.sha}`,request),receipt=parseTagReceipt(tag.message);
 const ledger=JSON.parse(await readBettaFile(g.repository,'release-version-ledger.json','release-version-ledger',request));
 if(tag.object?.type!=='commit' || tag.object.sha!==g.sourceSha || receipt?.authority!==AUTHORITY_ID || receipt.authorityRevision!==computeAuthorityRevision(readFileSync(new URL('../../contracts/release-version-authority.yaml',import.meta.url),'utf8'))
  || receipt.tag!==g.releaseTag || receipt.sourceSha!==g.sourceSha || receipt.versionName!=='0.1.1' || Number(receipt.androidVersionCode)!==2 || receipt.androidVersionCodeSource!=='github-ledger'
  || ledger.release?.lastTag!==g.releaseTag || ledger.release?.lastSourceSha!==g.sourceSha || ledger.android?.lastVersionCode!==2)fail('BETTA_RELEASE_RECEIPT_MISMATCH');
 const ci=await githubJson(`/repos/${g.repository}/actions/runs/${g.ciRunId}`,request);
 if(ci.id!==43359608916 || ci.head_sha!==g.sourceSha || ci.repository?.full_name!==g.repository || ci.run_attempt!==2 || ci.status!=='completed' || ci.conclusion!=='success'
  || ci.path?.split('@')[0]!=='.github/workflows/godot-checks.yml' || !Number.isFinite(Date.parse(ci.updated_at)) || Date.parse(ci.updated_at)>Date.now() || Date.now()-Date.parse(ci.updated_at)>168*3600000)fail('BETTA_CURRENT_CI_REQUIRED');
 const release=await githubJson(`/repos/${g.repository}/releases/tags/${g.releaseTag}`,request);if(release.id!==443800221)fail('BETTA_IPA_RELEASE');
 const assets=await githubPaginate(`/repos/${g.repository}/releases/${release.id}/assets?per_page=100`,request);
 const readAsset=async(name,sha)=>{
  const a=assets.filter(a=>a.name===name);if(a.length!==1 || a[0].size>2*1024*1024)fail('BETTA_IPA_EVIDENCE_ASSET');
  const bytes=await githubDownload(`/repos/${g.repository}/releases/assets/${a[0].id}`,request);if(sha && bettaDigest(bytes)!==sha)fail('BETTA_IPA_EVIDENCE_CHANGED');return bytes;
 };
 await readAsset('development-evidence.app-store.before-build.json',g.evidenceSha256);
 for(const o of g.originalObservationAssets)await readAsset(o.name,o.sha256);
 const c=JSON.parse(await readAsset(`${r.sourceGrantId}.app-store.1.before-build.json`,r.buildClaimSha256));
 if(c.kind!=='betta-internal-claim' || c.id!==r.sourceGrantId || c.target!=='app-store' || c.phase!=='before-build' || c.attempt!==1 || c.sourceSha!==g.sourceSha
  || c.producer!==`xcode-cloud:${r.runs[2]}` || c.grantSha256!==r.sourceGrantSha256 || c.configurationFingerprint!==fingerprint
  || !Number.isFinite(Date.parse(c.recordedAt)) || Date.parse(c.recordedAt)<Date.parse(g.approvedAt) || Date.parse(c.recordedAt)>Date.now())fail('BETTA_IPA_BUILD_CLAIM');
 if(assets.some(a=>a.name==='com.seorilabs.bettaraising.0.1.1.3.upload-intent.json' || a.name.startsWith(r.sourceGrantId+'.app-store.') && a.name.endsWith('.before-deploy.json')))fail('BETTA_UPLOAD_SLOT_CONSUMED');
 const {verifyReleaseDevelopmentEvidence}=await import('./verify-development-evidence.mjs');
 const options={repository:g.repository,sourceSha:g.sourceSha,tag:g.releaseTag,target:'app-store',phase:'before-deploy',env,fetchImpl};
 let verdict;try{await verifyReleaseDevelopmentEvidence(options);verdict={ok:true,errors:[]};}catch(e){verdict={ok:false,errors:e.message.split('\n')};}
 const decision=validateBettaIpaRecoveryContext(g,{...options,configurationFingerprint:fingerprint},verdict);
 const get=p=>appleGet(p,env,fetchImpl),list=p=>appleList(p,env,fetchImpl);
 const market=async()=>{
  const sparseRuns=await list(`/v1/ciProducts/${g.appStore.productId}/buildRuns?limit=100`);
  if(sparseRuns.length!==3 || sparseRuns.some(x=>!r.runs.includes(x.id)))fail('BETTA_IPA_HISTORY_OR_MARKET');
  return {workflow:(await get(`/v1/ciWorkflows/${g.appStore.workflowId}`)).data,
   runs:await Promise.all(sparseRuns.map(async x=>(await get(`/v1/ciBuildRuns/${x.id}?include=workflow,product,sourceBranchOrTag`)).data)),
   actions:await list(`/v1/ciBuildRuns/${r.runs[2]}/actions?limit=100`),builds:await list(`/v1/apps/${g.appStore.appId}/builds?limit=100`),uploads:await list(`/v1/apps/${g.appStore.appId}/buildUploads?limit=100`)};
 };
 const before=await market();assertIpaHistory(g,before);
 const app=(await get(`/v1/apps/${g.appStore.appId}`)).data,product=(await get(`/v1/ciProducts/${g.appStore.productId}?include=app`)).data;
 if(app.id!==g.appStore.appId || app.attributes?.bundleId!==g.appStore.bundleId || product.id!==g.appStore.productId || product.relationships?.app?.data?.id!==app.id)fail('BETTA_APPLE_PRODUCT');
 const links=await list(`/v1/ciBuildActions/${r.archiveActionId}/relationships/artifacts?limit=100`);
 if(!links.some(a=>a.id===r.artifactId) || !links.some(a=>a.id===r.logArtifactId))fail('BETTA_IPA_ARTIFACT_RELATIONSHIP');
 assertIpaArtifact((await get(`/v1/ciArtifacts/${r.artifactId}`)).data);
 const bytes=readFileSync(archiveFile),logs=readFileSync(logArchiveFile);
 if(bytes.length!==r.archiveSize || bettaDigest(bytes)!==r.archiveSha256 || bettaDigest(logs)!==r.logArchiveSha256)fail('BETTA_IPA_ARCHIVE_CHANGED');
 const temp=mkdtempSync(join(tmpdir(),'betta-existing-ipa-'));
 try{
  const zip=join(temp,'app-store.zip'),logZip=join(temp,'logs.zip');writeFileSync(zip,bytes,{flag:'wx'});writeFileSync(logZip,logs,{flag:'wx'});
  const exec=(cmd,args)=>execFileSync(cmd,args,{stdio:['ignore','pipe','pipe'],maxBuffer:128*1024*1024,timeout:60000});
  exec('unzip',['-tq',zip]);exec('unzip',['-tq',logZip]);
  const names=exec('unzip',['-Z1',logZip]).toString().split('\n').filter(n=>n.endsWith('/ci_post_xcodebuild.log'));
  if(names.length!==1)fail('BETTA_IPA_FAILURE_LOG');
  const log=exec('unzip',['-p',logZip,names[0]]).toString();
  if(!log.includes('npm error code EUSAGE') || !log.includes('Missing: authority@0.5.0 from lock file') || !log.includes('Missing: @seorilabs/repo-contract@0.5.0 from lock file'))fail('BETTA_IPA_FAILURE_LOG');
  exec('ditto',['-x','-k',zip,join(temp,'export')]);
  const ipa=join(temp,'export','BettaAtelier 0.1.1 app-store','BettaAtelier.ipa'),ipaBytes=readFileSync(ipa);
  if(ipaBytes.length!==r.ipaSize || bettaDigest(ipaBytes)!==r.ipaSha256)fail('BETTA_IPA_CHANGED');
  exec('unzip',['-tq',ipa]);exec('ditto',['-x','-k',ipa,join(temp,'signed')]);
  const payload=join(temp,'signed','Payload');if(JSON.stringify(readdirSync(payload))!=='["BettaAtelier.app"]')fail('BETTA_IPA_PAYLOAD');
  const inspected=inspectBettaAppleApp(join(payload,'BettaAtelier.app'),g,{number:3});
  const producer=`local-existing-ipa:${r.runs[2]}`,identity={producer,grantId:g.id,grantSha256:reviewed.grantSha256,artifact:inspected,
   uploaderRuntime:'local-reviewed-cli',uploaderEntrySha256:bettaDigest(readFileSync(new URL('./recover-betta-existing-ipa.mjs',import.meta.url)))};
  const result={...decision,scope:'betta_existing_ipa_upload_only',...identity,additionalGameBuilds:0,cumulativeNativeBuilds:3,originalPostHookPassed:false,fullCloudWorkingTreeAuditPassed:false,
   sourceVerificationMode:'fresh-original-checkout-and-exact-provider-export',ipaSha256:r.ipaSha256,archiveSha256:r.archiveSha256,providerBeforeUpload:before,uploadInvoked:false};
  if(upload){
   assertIpaUploadCredentials(env);
   assertIpaHistory(g,await market());
   result.reservation=await reserveIpaUpload(g,release,identity,request);
  }
  writeFileSync(report,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  if(upload){
   const outcome=spawnSync('xcrun',['altool','--upload-app','--type','ios','--file',ipa,'--apiKey',env.APP_STORE_CONNECT_API_KEY_ID,'--apiIssuer',env.APP_STORE_CONNECT_ISSUER_ID,'--output-format','json'],{env,stdio:'inherit',timeout:1200000});
   writeFileSync(report+'.upload-result.json',JSON.stringify({...result,uploadInvoked:true,uploadCommandExit:outcome.status,uploadCommand:outcome.status===0?'succeeded; processing and internal availability require provider readback':'failed or unknown; no automatic retry'},null,2)+'\n',{flag:'wx'});
   if(outcome.status!==0)fail('BETTA_IPA_UPLOAD_FAILED_OR_UNKNOWN');
   return {...result,uploadInvoked:true,uploadCommand:'succeeded; processing and internal availability require provider readback'};
  }
  return result;
 }finally{rmSync(temp,{recursive:true,force:true});}
}
