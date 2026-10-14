// 첫 내부 TestFlight의 검수 시점만 옮긴다. 공개 출시·제품 E2E 통과 판정이 아니다.
import { readFileSync, lstatSync, readdirSync, readlinkSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { githubJson, githubPaginate, githubDownload } from '../github-rest.mjs';
import Ajv2020 from 'ajv/dist/2020.js';
import { createHash } from 'node:crypto';
import { validateDevelopmentEvidence } from './verify-development-evidence.mjs';
export const bootstrapDigest = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const sameIds = (a,b) => Array.isArray(a) && Array.isArray(b) && new Set(a).size === a.length && equal([...a].sort(),[...b].sort());
const SHA = /^[a-f0-9]{40}$/u, DIGEST = /^[a-f0-9]{64}$/u;
const REPO = 'seorilabs/spiritgate-defenders', TAG = 'v1.1.0', BUNDLE = 'com.seorilabs.spiritgatedefenders';
const PROVIDER = {appId:'6792205995',productId:'E5C1A24C-AA05-41B0-B2F6-F1BF0B92D7DB',workflowId:'45B83B98-ABE4-48C1-83FC-09CF3F79651E'};
const MAX_AGE = 168 * 3600000;
const ajv = new Ajv2020({allErrors:true});
const validGrant = ajv.compile(JSON.parse(readFileSync(new URL('../../contracts/internal-testflight-bootstrap-grant.schema.json',import.meta.url))));
const validDocument = ajv.compile(JSON.parse(readFileSync(new URL('../../contracts/internal-testflight-bootstrap.schema.json',import.meta.url))));

export function validateInternalTestflightBootstrapEvidence(document, context) {
  const errors=[];
  const reject = (condition,code) => {if (!condition) errors.push(code);};
  const {grant,providerProof:provider,now:at=new Date().toISOString()}=context;
  const now=Date.parse(at);
  if (!validDocument(document) || !validGrant(grant)) return {ok:false,errors:['TESTFLIGHT_BOOTSTRAP_REQUIRED']};
  reject(Number.isFinite(now),'TESTFLIGHT_TIME');
  reject(document.schemaVersion === 1 && document.scope === 'internal_testflight_only' && document.id === grant.id,'TESTFLIGHT_INTERNAL_SCOPE');
  reject(grant.schemaVersion === 1 && grant.kind === 'first-internal-testflight' && grant.revoked === false,'TESTFLIGHT_GRANT');
  reject(context.repository === REPO && grant.repository === REPO && grant.releaseTag === TAG && context.tag === TAG && grant.packageName === BUNDLE && context.target === 'app-store','TESTFLIGHT_SCOPE');
  reject(['before-build','before-deploy'].includes(context.phase),'TESTFLIGHT_PHASE');
  reject(SHA.test(context.sourceSha ?? '') && context.sourceSha === grant.sourceSha,'TESTFLIGHT_SOURCE');
  reject(DIGEST.test(context.configurationFingerprint ?? '') && context.configurationFingerprint === grant.configurationFingerprint,'TESTFLIGHT_CONFIGURATION');
  const approved=Date.parse(grant.approvedAt),expiry=Date.parse(grant.expiresAt);
  reject(approved <= now && now <= expiry && expiry > approved && expiry-approved <= MAX_AGE,'TESTFLIGHT_EXPIRED');
  for (const [key,bytes] of [['approvalSha256',context.approvalBytes],['inventorySha256',context.inventoryBytes],['evidenceSha256',context.evidenceBytes]]) {
    reject(Buffer.isBuffer(bytes) && DIGEST.test(grant[key] ?? '') && bootstrapDigest(bytes) === grant[key],`TESTFLIGHT_HASH_${key}`);
  }
  let approval,inventory,originalDocument;
  try {approval=JSON.parse(context.approvalBytes);inventory=JSON.parse(context.inventoryBytes);originalDocument=JSON.parse(context.evidenceBytes);} catch {errors.push('TESTFLIGHT_INVALID_JSON');}
  reject(equal(originalDocument,document),'TESTFLIGHT_EVIDENCE_CHANGED');
  reject(approval?.kind === 'human_testflight_timing_approval' && approval.repository === REPO && approval.version === '1.1.0'
    && approval.objective === 'first_internal_testflight_qa' && approval.candidateLimit === 1 && approval.buildUploadLimit === 1
    && approval.maxAgeHours === 168 && approval.approvalRecordedAt === grant.approvedAt && typeof approval.userApprovalVerbatim === 'string' && approval.userApprovalVerbatim.trim().length > 0
    && approval.iphoneQa === 'deferred until internal installation; not waived' && approval.newAppleResourcesAllowed === false
    && approval.publicReleaseRequires === 'normal validator, actual iPhone QA and whole E2E','TESTFLIGHT_HUMAN_APPROVAL_SCOPE');
  reject(inventory?.schemaVersion === 1 && inventory.features?.length === 28,'TESTFLIGHT_INVENTORY');
  reject(context.originalEvidenceVerified === true && sameIds(document.originalObservations?.map(a=>a.sha256),grant.originalObservationAssets?.map(a=>a.sha256)), 'TESTFLIGHT_ORIGINAL_OBSERVATIONS');
  reject(DIGEST.test(context.productTreeSha256 ?? '') && context.productTreeSha256 === grant.productTreeSha256 && context.executionVerified === true,'TESTFLIGHT_PRODUCT_BYTES');
  reject(context.verifierProof?.verified === true && context.verifierProof.reviewedOnCurrentMain === true,'TESTFLIGHT_REVIEWED_VERIFIER');
  const editor = validateDevelopmentEvidence(document.editor,{...context,featureInventory:inventory,requireUi:true});
  if (!editor.ok) errors.push(...editor.errors.map(e=>`TESTFLIGHT_EDITOR ${e}`));
  reject(document.editor?.iterations?.length === 4 && document.editor.e2e.environment.kind === 'godot-editor','TESTFLIGHT_UI4_EDITOR_REQUIRED');
  const fourth=document.editor?.iterations?.[3];
  reject(Date.parse(fourth?.completedAt)-Date.parse(fourth?.startedAt) <= 210*60000,'TESTFLIGHT_UI4_BUDGET');
  const foundation=(inventory?.features ?? []).filter(f=>f.foundation === true).map(f=>f.id);
  const android=document.android,ios=document.ios;
  reject(android?.sourceSha === context.sourceSha && android.target === 'google-play' && android.configurationFingerprint === grant.androidConfigurationFingerprint
    && android.deviceKind === 'physical-android' && DIGEST.test(android.artifactSha256 ?? ''),'TESTFLIGHT_ANDROID_ACTUAL_CANDIDATE');
  reject(sameIds(android?.features?.map(f=>f.id),foundation) && foundation.length > 0 && android.features.every(f=>f.status === 'passed' && Array.isArray(f.evidence) && f.evidence.length > 0 && f.evidence.every(e=>typeof e === 'string' && e.trim())),'TESTFLIGHT_ANDROID_FOUNDATION_REQUIRED');
  reject(Date.parse(android?.plannedAt) <= Date.parse(android?.startedAt) && Date.parse(android.startedAt) <= Date.parse(android.completedAt)
    && Date.parse(android.completedAt) <= now && now-Date.parse(android.completedAt) <= MAX_AGE,'TESTFLIGHT_ANDROID_TIME');
  reject(ios?.sourceSha === context.sourceSha && ios.target === 'app-store' && ios.status === 'deferred' && typeof ios.reason === 'string' && ios.reason.trim()
    && sameIds(ios.featureIds,foundation),'TESTFLIGHT_IOS_ONLY_DEFERRED');
  reject(equal(grant.provider,PROVIDER) && provider?.verified === true && provider.internalOnly === true && provider.sourceSha === context.sourceSha
    && provider.workflowId === PROVIDER.workflowId && provider.productId === PROVIDER.productId && provider.matchingBuildCount === 1
    && typeof provider.buildId === 'string' && provider.buildId.length > 0 && Number.isSafeInteger(provider.buildNumber) && provider.buildNumber > 0,'TESTFLIGHT_PROVIDER_INTERNAL_ONLY');
  if (context.phase === 'before-deploy') {
    const artifact=context.artifactProof,previous=context.beforeBuildReceipt;
    reject(artifact?.verified === true && artifact.sourceSha === context.sourceSha && artifact.buildId === provider?.buildId
      && artifact.buildNumber === provider?.buildNumber && artifact.bundleId === BUNDLE && artifact.version === '1.1.0'
      && DIGEST.test(artifact.sha256 ?? ''),'TESTFLIGHT_ACTUAL_ARTIFACT_REQUIRED');
    reject(previous?.scope === 'internal_testflight_only' && previous.sourceSha === context.sourceSha && previous.buildId === provider?.buildId
      && previous.buildNumber === provider?.buildNumber && previous.configurationFingerprint === context.configurationFingerprint
      && previous.grantSha256 === context.grantSha256,'TESTFLIGHT_SAME_BUILD_RECEIPT');
  }
  if (errors.length) return {ok:false,errors:[...new Set(errors)]};
  return {ok:true,errors:[],decisionStatus:'human_exception',productE2eStatus:'blocked',scope:'internal_testflight_only',repository:REPO,
    sourceSha:context.sourceSha,target:'app-store',phase:context.phase,configurationFingerprint:context.configurationFingerprint,
    grantSha256:context.grantSha256,completedAt:document.editor.e2e.completedAt,verifiedAt:new Date(now).toISOString(),
    buildId:provider.buildId,buildNumber:provider.buildNumber,androidStatus:'passed',iosStatus:'deferred',nativeQaWaived:false};
}

const root=fileURLToPath(new URL('../../',import.meta.url));
const policyPath='contracts/development-workflow.yaml';
const grantPaths=parse(readFileSync(join(root,policyPath),'utf8')).internalTestflightBootstrap?.grantRegistry ?? [];
const fail=code=>{throw new Error(code);};
const safePath=path=>typeof path==='string' && /^[A-Za-z0-9._/-]+$/u.test(path) && !path.split('/').includes('..') && !isAbsolute(path);
const readRemote=async(repository,path,ref,request)=>{
  const file=await githubJson(`/repos/${repository}/contents/${path}?ref=${ref}`,request);
  if(file.type!=='file' || file.encoding!=='base64' || typeof file.content!=='string') fail('TESTFLIGHT_REMOTE_FILE_REQUIRED');
  return Buffer.from(file.content,'base64');
};
const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});

// 임의 파일 경로를 ID로 바꿔 넘길 수 없다. 중앙 main에서 검토한 등록만 쓴다.
async function reviewedBootstrap(id,verifierSha,request){
  const path=grantPaths.find(p=>p===`contracts/internal-testflight-bootstrap/${id}.json`);
  if(!path || !safePath(path) || !SHA.test(verifierSha ?? '')) fail('TESTFLIGHT_REVIEWED_GRANT_REQUIRED');
  const bytes=readFileSync(join(root,path)),grant=JSON.parse(bytes);
  if(!validGrant(grant) || grant.id!==id || grant.revoked) fail('TESTFLIGHT_GRANT');
  const sources=[policyPath,'contracts/development-workflow.schema.json',path,grant.approvalFile,'package.json','package-lock.json',
    'scripts/github-rest.mjs','scripts/trigger-xcode-cloud.mjs','scripts/release/resolve-github-tag-commit.mjs','scripts/release/internal-testflight-bootstrap.mjs','scripts/release/verify-development-evidence.mjs',
    'scripts/release/verify-release-exception.mjs','scripts/release/hosted-godot-ios-exception.mjs',
    'scripts/release/release-promotion-evidence.mjs','scripts/release/tag-version-authority.mjs',
    'contracts/development-evidence.schema.json','contracts/release-exception.schema.json','contracts/release-exception-grant.schema.json',
    'contracts/hosted-godot-ios-exception-grant.schema.json','contracts/internal-testflight-bootstrap.schema.json','contracts/internal-testflight-bootstrap-grant.schema.json'];
  await Promise.all(sources.map(async path=>{
    const remote=await readRemote('seorilabs/.github',path,verifierSha,request);
    if(!readFileSync(join(root,path)).equals(remote)) fail('TESTFLIGHT_VERIFIER_BYTES_CHANGED');
  }));
  const ancestry=await githubJson(`/repos/seorilabs/.github/compare/${verifierSha}...main`,request);
  if(!['ahead','identical'].includes(ancestry.status) || ancestry.base_commit?.sha!==verifierSha) fail('TESTFLIGHT_VERIFIER_NOT_REVIEWED');
  const latestPolicy=parse((await readRemote('seorilabs/.github',policyPath,'main',request)).toString());
  if(!latestPolicy.internalTestflightBootstrap?.grantRegistry?.includes(path)) fail('TESTFLIGHT_GRANT_REVOKED');
  const latest=await readRemote('seorilabs/.github',path,'main',request);
  if(!bytes.equals(latest) || JSON.parse(latest).revoked) fail('TESTFLIGHT_GRANT_REVOKED_OR_CHANGED');
  const approvalBytes=readFileSync(join(root,grant.approvalFile));
  if(bootstrapDigest(approvalBytes)!==grant.approvalSha256) fail('TESTFLIGHT_APPROVAL_CHANGED');
  return {grant,approvalBytes,grantSha256:bootstrapDigest(bytes),verifierProof:{verified:true,revision:verifierSha,reviewedOnCurrentMain:true}};
}

export function verifyBootstrapWorkingTree(repository,grant,phase){
  const dir=realpathSync(repository);
  if(git(dir,'rev-parse','HEAD^{commit}').toString().trim()!==grant.sourceSha) fail('TESTFLIGHT_HEAD_CHANGED');
  const tree=git(dir,'ls-tree','-r','-z',grant.sourceSha);
  if(bootstrapDigest(tree)!==grant.productTreeSha256) fail('TESTFLIGHT_PRODUCT_TREE_CHANGED');
  const overrides=grant.workingOverrides[phase];
  for(const entry of tree.toString().split('\0').filter(Boolean)){
    const match=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(entry);
    if(!match) fail('TESTFLIGHT_UNSUPPORTED_SOURCE_ENTRY');
    const [, ,expected,path]=match,file=join(dir,path),stat=lstatSync(file);
    if(!stat.isFile() || stat.isSymbolicLink()) fail('TESTFLIGHT_WORKING_FILE_CHANGED');
    const bytes=readFileSync(file);
    const actual=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if(overrides[path] ? bootstrapDigest(bytes)!==overrides[path] : actual!==expected) fail('TESTFLIGHT_WORKING_FILE_CHANGED');
  }
  // .gitignore에 숨긴 코드도 검사한다. 생성 위치만 허용하고 전체 폴더 예외는 두지 않는다.
  const extras=git(dir,'ls-files','--others','-z').toString().split('\0').filter(Boolean);
  const generated=p=>p.startsWith('.godot/') || p.startsWith('build/logs/')
    || /^addons\/seorilabs_platform\/.+\.uid$/u.test(p)
    || (phase==='before-deploy' && (/^xcode-cloud\/(?:MoltenVK\.xcframework|SpiritgateDefenders|SpiritgateDefenders\.xcframework|libgodot_camera\.visionos\.(?:debug|release)\.xcframework)\//u.test(p)
      || ['xcode-cloud/PrivacyInfo.xcprivacy','xcode-cloud/SpiritgateDefenders.pck'].includes(p)));
  if(extras.some(p=>!generated(p))) fail('TESTFLIGHT_UNTRACKED_PRODUCT_FILE');
  return {productTreeSha256:bootstrapDigest(tree),executionVerified:true};
}

async function appleRead(path,token,fetchImpl){
  const url=new URL(path,'https://api.appstoreconnect.apple.com');
  if(url.origin!=='https://api.appstoreconnect.apple.com' || !url.pathname.startsWith('/v1/')) fail('TESTFLIGHT_APPLE_URL');
  const response=await fetchImpl(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
  if(!response.ok) fail(`TESTFLIGHT_APPLE_READ_${response.status}`);
  return response.json();
}
async function applePages(path,token,fetchImpl){
  const items=[],seen=new Set();
  while(path){
    if(seen.has(path) || seen.size>=50) fail('TESTFLIGHT_APPLE_PAGINATION');seen.add(path);
    const document=await appleRead(path,token,fetchImpl);
    if(!Array.isArray(document.data)) fail('TESTFLIGHT_APPLE_LIST');
    items.push(...document.data);path=document.links?.next;
  }
  return items;
}
// The existing shared ASC identity is injected by the protected Xcode Cloud consumer.
async function appleToken(env){
  const {makeAppStoreConnectToken}=await import('../trigger-xcode-cloud.mjs');
  for(const key of ['APP_STORE_CONNECT_API_KEY_ID','APP_STORE_CONNECT_ISSUER_ID','APP_STORE_CONNECT_PRIVATE_KEY_BASE64'])
    if(typeof env[key]!=='string' || !env[key].trim()) fail('TESTFLIGHT_REGISTERED_APPLE_IDENTITY_REQUIRED');
  return makeAppStoreConnectToken({keyId:env.APP_STORE_CONNECT_API_KEY_ID,issuerId:env.APP_STORE_CONNECT_ISSUER_ID,privateKeyBase64:env.APP_STORE_CONNECT_PRIVATE_KEY_BASE64});
}

export function validateBootstrapAppleObservation({app,product,workflow,run,runs,tag},grant,env){
  const w=workflow?.attributes,action=w?.actions?.[0],g=grant.provider;
  if(app?.id!==g.appId || app.attributes?.bundleId!==grant.packageName || product?.id!==g.productId
    || product.relationships?.app?.data?.id!==g.appId || workflow?.id!==g.workflowId
    || workflow.relationships?.product?.data?.id!==g.productId) fail('TESTFLIGHT_APPLE_PRODUCT');
  if(w.isEnabled!==true || w.actions?.length!==1 || action.actionType!=='ARCHIVE' || action.platform!=='IOS'
    || action.scheme!=='SpiritgateDefenders' || action.isRequiredToPass!==true || action.buildDistributionAudience!=='INTERNAL_ONLY'
    || !w.manualTagStartCondition || ['branchStartCondition','tagStartCondition','pullRequestStartCondition','scheduledStartCondition','manualBranchStartCondition','manualPullRequestStartCondition'].some(k=>w[k]!=null)) fail('TESTFLIGHT_APPLE_WORKFLOW_NOT_INTERNAL');
  const matches=runs.filter(r=>r.attributes?.sourceCommit?.commitSha===grant.sourceSha);
  if(run?.id!==env.CI_BUILD_ID || run.attributes?.sourceCommit?.commitSha!==grant.sourceSha
    || run.relationships?.workflow?.data?.id!==g.workflowId || run.relationships?.product?.data?.id!==g.productId
    || String(run.attributes?.number)!==env.CI_BUILD_NUMBER || run.attributes?.startReason!=='MANUAL'
    || run.attributes?.isPullRequestBuild!==false || matches.length!==1 || matches[0].id!==run.id
    || tag?.attributes?.kind!=='TAG' || tag.attributes.name!==grant.releaseTag || tag.id!==run.relationships?.sourceBranchOrTag?.data?.id) fail('TESTFLIGHT_APPLE_FIRST_BUILD');
  return {verified:true,internalOnly:true,sourceSha:grant.sourceSha,workflowId:g.workflowId,productId:g.productId,
    buildId:run.id,buildNumber:run.attributes.number,matchingBuildCount:matches.length};
}

async function bootstrapProvider(grant,env,fetchImpl){
  if(env.APP_STORE_CONNECT_API_KEY_ID!=='UHVPXA39JA' || env.CI_TEAM_ID!=='HCDUXX4Z3X' || env.CI_XCODE_CLOUD!=='TRUE' || env.CI_PRODUCT_ID!==PROVIDER.productId || env.CI_WORKFLOW_ID!==PROVIDER.workflowId
    || env.CI_BUNDLE_ID!==BUNDLE || env.CI_XCODE_SCHEME!=='SpiritgateDefenders' || env.CI_TAG!==TAG || env.CI_COMMIT!==grant.sourceSha
    || !/^[A-Za-z0-9-]+$/u.test(env.CI_BUILD_ID ?? '') || !/^[1-9][0-9]*$/u.test(env.CI_BUILD_NUMBER ?? '')) fail('TESTFLIGHT_CI_CONTEXT');
  const token=await appleToken(env),g=grant.provider;
  const [app,product,workflow,run,runs]=await Promise.all([
    appleRead(`/v1/apps/${g.appId}`,token,fetchImpl),appleRead(`/v1/ciProducts/${g.productId}`,token,fetchImpl),
    appleRead(`/v1/ciWorkflows/${g.workflowId}`,token,fetchImpl),appleRead(`/v1/ciBuildRuns/${env.CI_BUILD_ID}`,token,fetchImpl),
    applePages(`/v1/ciWorkflows/${g.workflowId}/buildRuns?limit=200`,token,fetchImpl)]);
  const tagId=run.data?.relationships?.sourceBranchOrTag?.data?.id;
  if(!/^[A-Za-z0-9-]+$/u.test(tagId ?? '')) fail('TESTFLIGHT_PROVIDER_TAG');
  const tag=await appleRead(`/v1/scmGitReferences/${tagId}`,token,fetchImpl);
  return validateBootstrapAppleObservation({app:app.data,product:product.data,workflow:workflow.data,run:run.data,runs,tag:tag.data},grant,env);
}

export async function verifyInternalTestflightBootstrap(options){
  const env=options.env ?? process.env;
  if(options.repository!==REPO || options.target!=='app-store' || options.tag!==TAG || !['before-build','before-deploy'].includes(options.phase)) fail('TESTFLIGHT_SCOPE');
  const request={env:{...env,GITHUB_API_URL:'https://api.github.com'},token:options.token,fetchImpl:options.fetchImpl ?? globalThis.fetch};
  const reviewed=await reviewedBootstrap(options.bootstrapId,options.verifierSha,request),{grant}=reviewed;
  if(options.repository!==REPO || options.target!=='app-store' || options.tag!==TAG || options.sourceSha!==grant.sourceSha) fail('TESTFLIGHT_SCOPE');
  const releases=await githubPaginate(`/repos/${REPO}/releases?per_page=100`,request);
  const archive=releases.filter(r=>r.tag_name==='development-evidence' && r.draft===true);
  if(archive.length!==1) fail('TESTFLIGHT_DURABLE_ARCHIVE_REQUIRED');
  const assets=await githubPaginate(`/repos/${REPO}/releases/${archive[0].id}/assets?per_page=100`,request);
  const download=async asset=>{
    const actual=assets.filter(a=>a.id===asset.id);
    if(actual.length!==1 || actual[0].size>64*1024*1024) fail('TESTFLIGHT_DURABLE_ASSET_REQUIRED');
    const bytes=await githubDownload(`/repos/${REPO}/releases/assets/${asset.id}`,request);
    if(bytes.length>64*1024*1024 || bootstrapDigest(bytes)!==asset.sha256) fail('TESTFLIGHT_DURABLE_ASSET_CHANGED');
    return bytes;
  };
  const evidenceBytes=await download(grant.evidenceAsset);
  if(evidenceBytes.length>2*1024*1024) fail('TESTFLIGHT_EVIDENCE_TOO_LARGE');
  const document=JSON.parse(evidenceBytes);
  await Promise.all(grant.originalObservationAssets.map(download));
  const inventoryBytes=await readRemote(REPO,'docs/qa/feature-inventory.json',grant.sourceSha,request);
  const tree=verifyBootstrapWorkingTree(options.appRepository,grant,options.phase);
  const providerProof=await bootstrapProvider(grant,env,request.fetchImpl);
  const context={...options,...reviewed,...tree,inventoryBytes,evidenceBytes,originalEvidenceVerified:true,providerProof,now:new Date().toISOString()};
  // Signed artifact and prior phase receipt are required by the before-deploy validator.
  if(options.phase==='before-deploy'){
    if(!options.artifactFile || !options.artifactReceipt) fail('TESTFLIGHT_ACTUAL_ARTIFACT_REQUIRED');
    context.artifactProof=inspectBootstrapArtifact(options.artifactFile,providerProof,grant,options.appRepository);
    context.beforeBuildReceipt=JSON.parse(readFileSync(options.artifactReceipt,'utf8'));
  }
  const result=validateInternalTestflightBootstrapEvidence(document,context);
  if(!result.ok) fail(result.errors.join('\n'));
  return result;
}

export function readBootstrapPlist(bytes){
  // Apple 프로필의 Data/Date도 보존한다. plutil의 JSON 변환은 Data를 거부한다.
  const parser='import sys,plistlib,json,base64,datetime\ndef encode(v):\n if isinstance(v,bytes): return base64.b64encode(v).decode("ascii")\n if isinstance(v,(datetime.datetime,datetime.date)): return v.isoformat()\n raise TypeError("unsupported plist value")\njson.dump(plistlib.loads(sys.stdin.buffer.read()),sys.stdout,default=encode)';
  try{return JSON.parse(execFileSync('python3',['-c',parser],{input:bytes,maxBuffer:8*1024*1024,stdio:['pipe','pipe','pipe']}));}
  catch{fail('TESTFLIGHT_PLIST_INVALID');}
}
const plistJson=(file,bytes)=>readBootstrapPlist(bytes ?? readFileSync(file));
export function validateBootstrapProfileSigner(profile,certificate){
  if(!Buffer.isBuffer(certificate) || !certificate.length || !Array.isArray(profile?.DeveloperCertificates)
    || !profile.DeveloperCertificates.some(c=>typeof c==='string' && Buffer.from(c,'base64').equals(certificate))) fail('TESTFLIGHT_PROFILE_SIGNER_MISMATCH');
}
export function validateBootstrapSigningEntitlements(entitlements){
  if(entitlements?.['application-identifier']!==`HCDUXX4Z3X.${BUNDLE}`
    || entitlements['com.apple.developer.team-identifier']!=='HCDUXX4Z3X'
    || entitlements['get-task-allow']!==false) fail('TESTFLIGHT_SIGNED_ENTITLEMENTS_INVALID');
}
export function inspectBootstrapArtifact(directory,provider,grant,repository){
  const app=realpathSync(directory),stat=lstatSync(directory);
  if(!stat.isDirectory() || stat.isSymbolicLink() || !app.endsWith('.app')) fail('TESTFLIGHT_SIGNED_APP_DIRECTORY_REQUIRED');
  try{execFileSync('codesign',['--verify','--deep','--strict','-R','=anchor apple generic and certificate leaf[subject.OU] = "HCDUXX4Z3X"',app],{stdio:'pipe',timeout:30000});}
  catch{fail('TESTFLIGHT_SIGNATURE_INVALID');}
  let signedEntitlements;
  try{signedEntitlements=plistJson(null,execFileSync('codesign',['--display','--entitlements',':-',app],{maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe'],timeout:10000}));}
  catch{fail('TESTFLIGHT_SIGNED_ENTITLEMENTS_INVALID');}
  validateBootstrapSigningEntitlements(signedEntitlements);
  const info=plistJson(join(app,'Info.plist'));
  const profileBytes=readFileSync(join(app,'embedded.mobileprovision'));
  if(bootstrapDigest(profileBytes)!==grant.profileSha256) fail('TESTFLIGHT_EXISTING_PROFILE_REQUIRED');
  let decoded;
  try{decoded=execFileSync('security',['cms','-D','-i',join(app,'embedded.mobileprovision')],{maxBuffer:8*1024*1024,stdio:'pipe',timeout:10000});}
  catch{fail('TESTFLIGHT_PROFILE_INVALID');}
  const profile=plistJson(null,decoded);
  const certificateDir=mkdtempSync(join(tmpdir(),'spiritgate-signature-'));
  try{
    const prefix=join(certificateDir,'certificate-');
    execFileSync('codesign',['--display','--extract-certificates',prefix,app],{stdio:'pipe',timeout:10000});
    validateBootstrapProfileSigner(profile,readFileSync(`${prefix}0`));
  }catch{fail('TESTFLIGHT_PROFILE_SIGNER_MISMATCH');}
  finally{rmSync(certificateDir,{recursive:true,force:true});}
  if(info.CFBundleIdentifier!==BUNDLE || info.CFBundleShortVersionString!=='1.1.0' || String(info.CFBundleVersion)!==String(provider.buildNumber)
    || info.MinimumOSVersion!=='15.0' || !equal(info.UIDeviceFamily,[1]) || info.GADApplicationIdentifier!=='ca-app-pub-9932778305312246~7188570270'
    || !info.NSUserTrackingUsageDescription || !Array.isArray(info.SKAdNetworkItems) || !info.SKAdNetworkItems.length
    || profile.UUID!=='4f3e6181-409d-4651-8187-9700610a0c4e' || !profile.TeamIdentifier?.includes('HCDUXX4Z3X')
    || profile.Entitlements?.['application-identifier']!==`HCDUXX4Z3X.${BUNDLE}` || profile.Entitlements?.['get-task-allow']!==false
    || profile.ProvisionedDevices!==undefined || profile.ProvisionsAllDevices===true) fail('TESTFLIGHT_ARTIFACT_METADATA');
  try{
    execFileSync('python3',[join(repository,'tools/validate_ios_privacy_manifest.py'),'validate-tree',app],{stdio:'pipe',timeout:30000});
    execFileSync('bash',[join(repository,'scripts/validate_admob_artifact.sh')],{env:{...process.env,PROJECT_DIR:repository,ADMOB_TARGET_PLATFORM:'iOS',IOS_APP_PATH:app},stdio:'pipe',timeout:30000});
  }catch{fail('TESTFLIGHT_ARTIFACT_SDK_PRIVACY');}
  const entries=[];
  const walk=path=>{
    for(const name of readdirSync(path).sort()){
      const file=join(path,name),meta=lstatSync(file),local=relative(app,file);
      if(meta.isSymbolicLink()){
        const target=relative(app,realpathSync(file));
        if(target==='..' || target.startsWith('../') || isAbsolute(target)) fail('TESTFLIGHT_ARTIFACT_SYMLINK_ESCAPE');
        entries.push([local,'symlink',readlinkSync(file)]);
      }else if(meta.isDirectory()) walk(file);
      else if(meta.isFile()) entries.push([local,'file',bootstrapDigest(readFileSync(file))]);
      else fail('TESTFLIGHT_ARTIFACT_FILE_TYPE');
    }
  };walk(app);
  return {verified:true,sourceSha:grant.sourceSha,buildId:provider.buildId,buildNumber:provider.buildNumber,
    bundleId:BUNDLE,version:'1.1.0',sha256:bootstrapDigest(Buffer.from(JSON.stringify(entries))),digestScope:'signed-app-tree-files-and-symlinks',profileSha256:grant.profileSha256};
}

// 처리된 내부 전용 빌드만 기존 내부 그룹으로 보낸다. App Review/외부 그룹에는 사용할 수 없다.
export function validateBootstrapProcessedBuild(build,preReleaseVersion,group,receipt,run,runBuildIds){
  if(receipt?.ok!==true || receipt.scope!=='internal_testflight_only' || receipt.productE2eStatus!=='blocked'
    || receipt.repository!==REPO || receipt.target!=='app-store' || receipt.phase!=='before-deploy'
    || build?.attributes?.buildAudienceType!=='INTERNAL_ONLY' || build.attributes.processingState!=='VALID'
    || build.relationships?.app?.data?.id!==PROVIDER.appId || String(build.attributes.version)!==String(receipt.buildNumber)
    || preReleaseVersion?.attributes?.version!=='1.1.0' || preReleaseVersion.id!==build.relationships?.preReleaseVersion?.data?.id
    || run?.id!==receipt.buildId || run.attributes?.completionStatus!=='SUCCEEDED' || run.attributes?.sourceCommit?.commitSha!==receipt.sourceSha
    || !Array.isArray(runBuildIds) || !runBuildIds.includes(build.id)
    || group?.attributes?.isInternalGroup!==true || group.relationships?.app?.data?.id!==PROVIDER.appId)
    fail('TESTFLIGHT_PROCESSED_INTERNAL_BUILD_REQUIRED');
  return {ok:true,scope:'internal_testflight_only',buildId:build.id,groupId:group.id,productE2eStatus:'blocked'};
}
