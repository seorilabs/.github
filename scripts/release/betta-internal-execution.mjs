import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { githubJson, githubPaginate, githubDownload } from '../github-rest.mjs';
import { parseTagReceipt, AUTHORITY_ID, computeAuthorityRevision } from './tag-version-authority.mjs';
import { validateBettaInternalContext, chooseBettaAttempt, bettaDigest, verifyBettaSource, inspectBettaAab } from './betta-internal-bootstrap.mjs';
import { inspectBettaAppleApp } from './betta-internal-apple-artifact.mjs';
import { readReviewedBettaGrant, readBettaFile, readBettaClaims, createBettaClaim } from './betta-internal-grant-store.mjs';
import { observeBettaProvider } from './betta-internal-provider.mjs';
const fail=code=>{throw new Error(code);};

export function bettaConfigurationFingerprint(root,grant,target){
  const files=['godot/project.godot','godot/export_presets.cfg','app-store/app-store.config.json','play-store/google-play.config.json'];
  const entries=files.map(path=>[path,bettaDigest(execFileSync('git',['-C',root,'show',`${grant.sourceSha}:${path}`],{maxBuffer:4*1024*1024}))]);
  return bettaDigest(Buffer.from(JSON.stringify({files:entries,target,signing:target==='google-play'?grant.googlePlay:grant.appStore})));
}

export async function verifyBettaInternalBootstrap(options){
  const {env=process.env,fetchImpl=globalThis.fetch}=options,request={env,token:options.token,fetchImpl};
  if(env.GITHUB_API_URL && env.GITHUB_API_URL!=='https://api.github.com') fail('BETTA_GITHUB_ORIGIN');
  const reviewed=await readReviewedBettaGrant(options.bettaBootstrapId,request),{grant:g}=reviewed;
  const root=realpathSync(options.appRepository ?? env.CI_PRIMARY_REPOSITORY_PATH ?? env.GITHUB_WORKSPACE ?? '.');
  const ownedRoot=env.CI_PRIMARY_REPOSITORY_PATH ?? env.GITHUB_WORKSPACE;
  const postSource=options.target==='app-store' && options.phase==='before-deploy' && env.CI_XCODE_CLOUD==='TRUE';
  if(!postSource && ownedRoot && root!==realpathSync(ownedRoot)) fail('BETTA_WORKSPACE_MISMATCH');
  const sourceVerificationMode=postSource ? 'provider-bound-original-checkout':'actual-working-tree';
  const fingerprint=bettaConfigurationFingerprint(root,g,options.target);
  if(options.configurationFingerprint && options.configurationFingerprint!==fingerprint) fail('BETTA_CONFIGURATION_CHANGED');
  const context={...options,configurationFingerprint:fingerprint};
  const ref=await githubJson(`/repos/${g.repository}/git/ref/tags/${g.releaseTag}`,request);
  if(ref.object?.type!=='tag') fail('BETTA_LEDGER_TAG_REQUIRED');
  const tag=await githubJson(`/repos/${g.repository}/git/tags/${ref.object.sha}`,request),receipt=parseTagReceipt(tag.message);
  const ledger=JSON.parse(await readBettaFile(g.repository,'release-version-ledger.json','release-version-ledger',request));
  const authorityRevision=computeAuthorityRevision(readFileSync(new URL('../../contracts/release-version-authority.yaml',import.meta.url),'utf8'));
  if(tag.object?.type!=='commit' || tag.object.sha!==g.sourceSha || !receipt || receipt.authority!==AUTHORITY_ID || receipt.authorityRevision!==authorityRevision
    || receipt.versionName!==g.releaseTag.slice(1) || receipt.sourceSha!==g.sourceSha || receipt.tag!==g.releaseTag
    || receipt.androidVersionCodeSource!=='github-ledger' || Number(receipt.androidVersionCode)!==g.googlePlay.versionCode
    || ledger.release?.lastTag!==g.releaseTag || ledger.release?.lastSourceSha!==g.sourceSha || ledger.android?.lastVersionCode!==g.googlePlay.versionCode) fail('BETTA_RELEASE_RECEIPT_MISMATCH');
  const ci=await githubJson(`/repos/${g.repository}/actions/runs/${g.ciRunId}`,request);
  const inventory=JSON.parse(await readBettaFile(g.repository,'docs/qa/feature-inventory.json',g.sourceSha,request));
  if(String(ci.id)!==g.ciRunId || ci.repository?.full_name!==g.repository || ci.head_sha!==g.sourceSha || ci.status!=='completed' || ci.conclusion!=='success'
    || ci.path?.split('@')[0]!==inventory.e2e?.workflow || !Number.isFinite(Date.parse(ci.updated_at))
    || Date.parse(ci.updated_at)>Date.now() || Date.now()-Date.parse(ci.updated_at)>168*3600000) fail('BETTA_CURRENT_CI_REQUIRED');
  const release=await githubJson(`/repos/${g.repository}/releases/tags/${g.releaseTag}`,request);
  const assets=await githubPaginate(`/repos/${g.repository}/releases/${release.id}/assets?per_page=100`,request);
  const readAsset=async name=>{
    const matches=assets.filter(a=>a.name===name);
    if(matches.length!==1 || matches[0].size>2*1024*1024) fail('BETTA_EVIDENCE_ASSET');
    return githubDownload(`/repos/${g.repository}/releases/assets/${matches[0].id}`,request);
  };
  const phaseName=`development-evidence.${options.target}.${options.phase}.json`,baseName=`development-evidence.${options.target}.before-build.json`;
  const evidence=await readAsset(assets.some(a=>a.name===phaseName)?phaseName:baseName);
  if(bettaDigest(evidence)!==g.evidenceSha256) fail('BETTA_ORIGINAL_EVIDENCE_CHANGED');
  for(const observation of g.originalObservationAssets){
    if(bettaDigest(await readAsset(observation.name))!==observation.sha256) fail('BETTA_ORIGINAL_OBSERVATION_CHANGED');
  }
  const {verifyReleaseDevelopmentEvidence}=await import('./verify-development-evidence.mjs');
  let originalVerdict;
  try{await verifyReleaseDevelopmentEvidence({...options,bettaBootstrapId:undefined});originalVerdict={ok:true,errors:[]};}
  catch(error){originalVerdict={ok:false,errors:error.message.split('\n')};}
  const decision=validateBettaInternalContext(g,context,originalVerdict);
  verifyBettaSource(root,g,{phase:options.phase,credentialFile:env.GOOGLE_APPLICATION_CREDENTIALS});
  const claims=await readBettaClaims(release,g,options.target,request);
  if(claims.some(c=>c.grantSha256!==reviewed.grantSha256 || c.configurationFingerprint!==fingerprint
    || Date.parse(c.recordedAt)<Date.parse(g.approvedAt) || Date.parse(c.recordedAt)>Date.now())) fail('BETTA_CLAIM_CHANGED_OR_CLOCK_REVERSED');
  const provider=await observeBettaProvider(g,options,claims,request),attempt=chooseBettaAttempt(provider.attempts,provider.producer,g.maxBuildsPerMarket);
  let artifact;
  if(options.phase==='before-deploy'){
    const buildClaim=claims.find(c=>c.phase==='before-build' && c.attempt===attempt && c.producer===provider.producer);
    if(!buildClaim || !options.artifactFile) fail('BETTA_BEFORE_BUILD_CLAIM_REQUIRED');
    artifact=options.target==='google-play' ? inspectBettaAab(options.artifactFile,g) : inspectBettaAppleApp(options.artifactFile,g,provider);
    if(options.target==='google-play' && env.GITHUB_ACTIONS!=='true') fail('BETTA_LOCAL_UPLOAD_PROVENANCE_REQUIRED');
  }
  const claim={schemaVersion:1,kind:'betta-internal-claim',id:g.id,target:options.target,phase:options.phase,attempt,producer:provider.producer,sourceSha:g.sourceSha,
    grantSha256:reviewed.grantSha256,configurationFingerprint:fingerprint,recordedAt:new Date().toISOString(),...(artifact?{artifactSha256:artifact.sha256}: {})};
  const stored=await createBettaClaim(release,claim,request);
  return {...decision,scope:g.kind==='betta-internal-update'?'betta_single_internal_update':'betta_first_internal_only',releaseTag:g.releaseTag,configurationFingerprint:fingerprint,
    producer:provider.producer,attempt,claimAssetId:stored.assetId,grantSha256:reviewed.grantSha256,sourceVerificationMode,...(artifact?{artifact}: {})};
}
