// 승인한 0.1.2 서명 산출물의 업로드만 수행한다. native 생성·export·재서명은 없다.
import {readFileSync,writeFileSync,existsSync,realpathSync,mkdtempSync,rmSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {githubJson,githubPaginate,githubDownload} from '../github-rest.mjs';
import {readReviewedBettaGrant,readBettaFile} from './betta-internal-grant-store.mjs';
import {bettaDigest,verifyBettaSource,validateBettaArtifactUploadContext,inspectBettaAab} from './betta-internal-bootstrap.mjs';
import {bettaConfigurationFingerprint} from './betta-internal-execution.mjs';
import {inspectBettaAppleApp} from './betta-internal-apple-artifact.mjs';
import {appleGet,appleList} from './betta-internal-provider.mjs';
import {validateBettaUpdatePlayMarket,validateBettaUpdateAppleMarket} from './betta-internal-update.mjs';
import {assertV012GoogleHistory,assertV012AppleHistory,assertV012ProviderArtifact} from './betta-v012-artifact-policy.mjs';
import {assertIpaUploadCredentials} from './betta-existing-ipa-recovery.mjs';
import {postUnique} from './betta-existing-aab-recovery.mjs';
import {parseTagReceipt,computeAuthorityRevision,AUTHORITY_ID} from './tag-version-authority.mjs';
const CENTRAL='seorilabs/.github';
const fail=code=>{throw new Error(code);};
const exec=(p,args)=>execFileSync(p,args,{stdio:['ignore','pipe','pipe'],maxBuffer:128*1024*1024,timeout:60000});
export const v012UploadSlot=g=>g.targets[0]==='google-play'?`${g.googlePlay.packageName}.3.upload-intent.json`:`${g.appStore.bundleId}.0.1.2.4.upload-intent.json`;
export async function reserveV012ArtifactUpload(g,release,identity,request){
 const r=g.existingArtifactUpload,binding={...identity,sourceSha:g.sourceSha,artifactSha256:r.artifactSha256,additionalGameBuilds:0,recordedAt:new Date().toISOString()};
 const global=await postUnique(release,v012UploadSlot(g),{kind:'betta-v012-existing-artifact-upload-intent',...binding},request);
 const fence=await postUnique(release,`${r.sourceGrantId}.${r.target}.1.before-deploy.json`,{kind:'betta-recovery-upload-fence',...binding,globalUploadIntentAssetId:global.assetId},request);
 return {global,fence};
}
function assertUploadIdentity(g,env){
 if(g.targets[0]==='app-store')return assertIpaUploadCredentials(env);
 if(!env.GOOGLE_APPLICATION_CREDENTIALS)fail('BETTA_V012_PUBLISHER_REQUIRED');
 const path=env.GOOGLE_APPLICATION_CREDENTIALS;
 if(!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())fail('BETTA_V012_PUBLISHER_REQUIRED');
 const credential=JSON.parse(readFileSync(path));
 if(credential.type!=='service_account' || credential.client_email!=='seorilabs-play-publisher@seorilabs-gws.iam.gserviceaccount.com')fail('BETTA_V012_PUBLISHER_REQUIRED');
}
export async function recoverBettaV012Artifact({id,sourceDirectory,archiveFile,failureLogFile,report,upload=false,env=process.env,fetchImpl=globalThis.fetch}){
 if(existsSync(report) || existsSync(report+'.upload-result.json'))fail('BETTA_V012_REPORT_ALREADY_EXISTS');
 if(upload && (env.GITHUB_ACTIONS==='true' || env.CI_XCODE_CLOUD==='TRUE' || !process.argv[1]
  || realpathSync(process.argv[1])!==realpathSync(fileURLToPath(new URL('./recover-betta-v012-artifact.mjs',import.meta.url)))))fail('BETTA_V012_REVIEWED_LOCAL_CLI_REQUIRED');
 const request={env,fetchImpl},reviewed=await readReviewedBettaGrant(id,request),g=reviewed.grant,r=g.existingArtifactUpload,target=g.targets[0];
 if(g.kind!=='betta-existing-artifact-upload' || !r || r.target!==target || g.maxBuildsPerMarket!==0)fail('BETTA_V012_UPLOAD_ONLY_REQUIRED');
 const originalBytes=await readBettaFile(CENTRAL,`contracts/betta-internal-bootstrap/${r.sourceGrantId}.json`,r.sourceGrantCommit,request);
 if(bettaDigest(originalBytes)!==r.sourceGrantSha256)fail('BETTA_V012_ORIGINAL_GRANT');
 const original=JSON.parse(originalBytes),skip=new Set(['kind','id','revoked','approvedAt','maxBuildsPerMarket','verifierCommit','originalObservationAssets','workingOverrides','internalUpdate']);
 for(const key of Object.keys(original).filter(k=>!skip.has(k)))if(!isDeepStrictEqual(original[key],g[key]))fail('BETTA_V012_SCOPE_CHANGED');
 for(const oldId of ['betta-0-1-2-google-drawer-fit','betta-0-1-2-apple-drawer-fit']){
  if(JSON.parse(await readBettaFile(CENTRAL,`contracts/betta-internal-bootstrap/${oldId}.json`,'main',request)).revoked!==true)fail('BETTA_V012_OLD_ADMISSION_ACTIVE');
 }
 for(const o of original.originalObservationAssets)if(!g.originalObservationAssets.some(x=>x.name===o.name && x.sha256===o.sha256))fail('BETTA_V012_HISTORY_REMOVED');
 if(!g.originalObservationAssets.some(x=>x.name==='historical-android-v012-cache-failure.json') || !g.originalObservationAssets.some(x=>x.name==='historical-apple-v012-posthook-failure.json'))fail('BETTA_V012_FAILURE_PROOF_REQUIRED');
 const root=realpathSync(sourceDirectory),fingerprint=bettaConfigurationFingerprint(root,g,target);
 if(fingerprint!==g.configurationFingerprint)fail('BETTA_CONFIGURATION_CHANGED');
 verifyBettaSource(root,g,{phase:'before-build'});
 const ref=await githubJson(`/repos/${g.repository}/git/ref/tags/${g.releaseTag}`,request);
 if(ref.object?.type!=='tag')fail('BETTA_LEDGER_TAG_REQUIRED');
 const tag=await githubJson(`/repos/${g.repository}/git/tags/${ref.object.sha}`,request),receipt=parseTagReceipt(tag.message);
 const ledger=JSON.parse(await readBettaFile(g.repository,'release-version-ledger.json','release-version-ledger',request));
 if(tag.object?.type!=='commit' || tag.object.sha!==g.sourceSha || receipt?.authority!==AUTHORITY_ID
  || receipt.authorityRevision!==computeAuthorityRevision(readFileSync(new URL('../../contracts/release-version-authority.yaml',import.meta.url),'utf8'))
  || receipt.tag!==g.releaseTag || receipt.sourceSha!==g.sourceSha || receipt.versionName!=='0.1.2' || Number(receipt.androidVersionCode)!==3 || receipt.androidVersionCodeSource!=='github-ledger'
  || ledger.release?.lastTag!==g.releaseTag || ledger.release?.lastSourceSha!==g.sourceSha || ledger.android?.lastVersionCode!==3)fail('BETTA_RELEASE_RECEIPT_MISMATCH');
 const ci=await githubJson(`/repos/${g.repository}/actions/runs/${g.ciRunId}`,request),ciAt=Date.parse(ci.updated_at);
 if(String(ci.id)!==g.ciRunId || ci.head_sha!==g.sourceSha || ci.repository?.full_name!==g.repository || ci.status!=='completed' || ci.conclusion!=='success'
  || ci.path?.split('@')[0]!=='.github/workflows/godot-checks.yml' || !Number.isFinite(ciAt) || ciAt>Date.now() || Date.now()-ciAt>168*3600000)fail('BETTA_CURRENT_CI_REQUIRED');
 const release=await githubJson(`/repos/${g.repository}/releases/tags/${g.releaseTag}`,request);
 if(release.id!==r.sourceReleaseId)fail('BETTA_V012_RELEASE_CHANGED');
 const assets=await githubPaginate(`/repos/${g.repository}/releases/${release.id}/assets?per_page=100`,request);
 const readAsset=async(name,sha)=>{
  const found=assets.filter(x=>x.name===name);if(found.length!==1 || found[0].size>2*1024*1024)fail('BETTA_V012_EVIDENCE_ASSET');
  const bytes=await githubDownload(`/repos/${g.repository}/releases/assets/${found[0].id}`,request);if(bettaDigest(bytes)!==sha)fail('BETTA_V012_EVIDENCE_CHANGED');return bytes;
 };
 await readAsset(`development-evidence.${target}.before-build.json`,g.evidenceSha256);
 for(const o of g.originalObservationAssets)await readAsset(o.name,o.sha256);
 const claim=JSON.parse(await readAsset(`${r.sourceGrantId}.${target}.1.before-build.json`,r.buildClaimSha256));
 if(claim.kind!=='betta-internal-claim' || claim.id!==r.sourceGrantId || claim.target!==target || claim.phase!=='before-build' || claim.attempt!==1
  || claim.sourceSha!==g.sourceSha || claim.configurationFingerprint!==fingerprint || claim.grantSha256!==r.sourceGrantSha256
  || claim.producer!==(target==='google-play'?`github:${r.sourceRunId}:1`:`xcode-cloud:${r.sourceRunId}`)
  || !Number.isFinite(Date.parse(claim.recordedAt)) || Date.parse(claim.recordedAt)<Date.parse(original.approvedAt) || Date.parse(claim.recordedAt)>Date.now())fail('BETTA_V012_BUILD_CLAIM');
 if(assets.some(x=>x.name===v012UploadSlot(g) || x.name===`${r.sourceGrantId}.${target}.1.before-deploy.json`))fail('BETTA_UPLOAD_SLOT_CONSUMED');
 const options={repository:g.repository,sourceSha:g.sourceSha,tag:g.releaseTag,target,phase:'before-deploy',playTrack:'internal',playOperation:'upload',env,fetchImpl};
 const {verifyReleaseDevelopmentEvidence}=await import('./verify-development-evidence.mjs');let verdict;
 try{await verifyReleaseDevelopmentEvidence(options);verdict={ok:true,errors:[]};}catch(e){verdict={ok:false,errors:e.message.split('\n')};}
 const decision=validateBettaArtifactUploadContext(g,{...options,configurationFingerprint:fingerprint},verdict);
 const get=p=>appleGet(p,env,fetchImpl),list=p=>appleList(p,env,fetchImpl);
 const market=async()=>{
  if(target==='google-play'){
   const read=JSON.parse(execFileSync('python3',[fileURLToPath(new URL('./read-google-play-version-codes.py',import.meta.url)),'--package-name',g.googlePlay.packageName,'--api-timeout-seconds','30','--api-retries','0'],{env,stdio:['ignore','pipe','pipe'],timeout:60000}));
   validateBettaUpdatePlayMarket(original,read);
   const runs=await githubPaginate(`/repos/${g.repository}/actions/workflows/deploy-google-play.yml/runs?event=workflow_dispatch&per_page=100`,{...request,select:d=>d.workflow_runs});
   const jobs=await githubPaginate(`/repos/${g.repository}/actions/runs/${r.sourceRunId}/attempts/1/jobs?per_page=100`,{...request,select:d=>d.jobs});
   const log=await githubDownload(`/repos/${g.repository}/actions/jobs/${r.jobId}/logs`,request);
   assertV012GoogleHistory(g,{runs,jobs,log});return {read,runs,jobs,rawJobLogSha256:bettaDigest(log)};
  }
  const [builds,uploads,workflow,sparse,actions]=await Promise.all([list(`/v1/builds?filter[app]=${g.appStore.appId}&limit=200&include=preReleaseVersion`),list(`/v1/apps/${g.appStore.appId}/buildUploads?limit=200`),get(`/v1/ciWorkflows/${g.appStore.workflowId}`),list(`/v1/ciProducts/${g.appStore.productId}/buildRuns?limit=200`),list(`/v1/ciBuildRuns/${r.sourceRunId}/actions?limit=200`)]);
  validateBettaUpdateAppleMarket(original,builds,uploads);
  if(sparse.length!==4)fail('BETTA_V012_APPLE_HISTORY');
  const runs=await Promise.all(sparse.map(async x=>(await get(`/v1/ciBuildRuns/${x.id}?include=workflow,product,sourceBranchOrTag`)).data));
  assertV012AppleHistory(g,{runs,actions,workflow:workflow.data});return {builds,uploads,workflow:workflow.data,runs,actions};
 };
 const before=await market();
 if(target==='google-play')assertV012ProviderArtifact(g,await githubJson(`/repos/${g.repository}/actions/artifacts/${r.sourceArtifactId}`,request));
 else{
  const [app,product,links]=await Promise.all([get(`/v1/apps/${g.appStore.appId}`),get(`/v1/ciProducts/${g.appStore.productId}?include=app`),list(`/v1/ciBuildActions/${r.archiveActionId}/relationships/artifacts?limit=100`)]);
  if(app.data.attributes?.bundleId!==g.appStore.bundleId || product.data.relationships?.app?.data?.id!==g.appStore.appId || !links.some(x=>x.id===r.sourceArtifactId) || !links.some(x=>x.id===r.logArtifactId))fail('BETTA_V012_APPLE_PRODUCT_OR_ARTIFACT');
  assertV012ProviderArtifact(g,(await get(`/v1/ciArtifacts/${r.sourceArtifactId}`)).data);
 }
 const bytes=readFileSync(archiveFile),logs=readFileSync(failureLogFile);
 if(bytes.length!==r.archiveSize || bettaDigest(bytes)!==r.archiveSha256 || bettaDigest(logs)!==(target==='google-play'?r.rawJobLogSha256:r.logArchiveSha256))fail('BETTA_V012_LOCAL_ARTIFACT_CHANGED');
 const temp=mkdtempSync(join(tmpdir(),'betta-v012-upload-'));
 try{
  const archive=join(temp,'artifact.zip'),file=join(temp,target==='google-play'?'betta-raising.aab':'BettaAtelier.ipa');writeFileSync(archive,bytes,{flag:'wx'});
  const member=target==='google-play'?'betta-raising.aab':'BettaAtelier 0.1.2 app-store/BettaAtelier.ipa';
  exec('python3',['-c',"import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1]) as z:\n n=sys.argv[2];i=z.getinfo(n);assert i.file_size==int(sys.argv[4]);assert sys.argv[5]!='aab' or z.namelist()==[n];open(sys.argv[3],'xb').write(z.read(n))",archive,member,file,String(r.artifactSize),target==='google-play'?'aab':'ipa']);
  if(bettaDigest(readFileSync(file))!==r.artifactSha256)fail('BETTA_V012_BINARY_CHANGED');
  let artifact;
  if(target==='google-play')artifact=inspectBettaAab(file,g);
  else{
   exec('ditto',['-x','-k',file,join(temp,'signed')]);artifact=inspectBettaAppleApp(join(temp,'signed','Payload','BettaAtelier.app'),g,{number:4});
   if(artifact.sha256!==r.signedAppTreeSha256)fail('BETTA_V012_SIGNED_APP_CHANGED');
  }
  const notes=await readAsset('release-notes.json',r.releaseNotesSha256),notesPath=join(temp,'release-notes.json');writeFileSync(notesPath,notes,{flag:'wx'});
  const identity={producer:`local-v012-artifact:${g.id}`,grantId:g.id,grantSha256:reviewed.grantSha256,artifact,operatorRevision:g.verifierCommit};
  const result={...decision,...identity,scope:'betta_v012_exact_artifact_upload_only',additionalGameBuilds:0,cumulativeNativeBuilds:r.cumulativeNativeBuilds,fullOriginalWorkingTreeAuditPassed:false,originalPostHookPassed:false,sourceVerificationMode:'fresh-original-checkout-and-exact-provider-artifact',archiveSha256:r.archiveSha256,artifactSha256:r.artifactSha256,providerBeforeUpload:before,uploadInvoked:false};
  if(upload){
   assertUploadIdentity(g,env);
   if((await readReviewedBettaGrant(id,request)).grantSha256!==reviewed.grantSha256)fail('BETTA_V012_GRANT_CHANGED');
   await market();result.reservation=await reserveV012ArtifactUpload(g,release,identity,request);
   await market();
  }
  writeFileSync(report,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  if(!upload)return result;
  const outcome=target==='google-play'
   ?spawnSync('python3',[fileURLToPath(new URL('./upload-google-play-aab.py',import.meta.url)),'--package-name',g.googlePlay.packageName,'--aab-path',file,'--expected-aab-sha256',r.artifactSha256,'--expected-version-code','3','--track','internal','--release-status','completed','--release-name','Betta Atelier 0.1.2 (3)','--release-notes-json',notesPath,'--api-timeout-seconds','120','--api-retries','0'],{env,stdio:'inherit',timeout:600000})
   :spawnSync('xcrun',['altool','--upload-app','--type','ios','--file',file,'--apiKey',env.APP_STORE_CONNECT_API_KEY_ID,'--apiIssuer',env.APP_STORE_CONNECT_ISSUER_ID,'--output-format','json'],{env,stdio:'inherit',timeout:1200000});
  writeFileSync(report+'.upload-result.json',JSON.stringify({...result,uploadInvoked:true,uploadCommandExit:outcome.status,automaticRetry:false},null,2)+'\n',{flag:'wx'});
  if(outcome.status!==0)fail('BETTA_V012_UPLOAD_FAILED_OR_UNKNOWN');
  return {...result,uploadInvoked:true,uploadCommand:'succeeded; provider processing and internal availability require readback'};
 }finally{rmSync(temp,{recursive:true,force:true});}
}
