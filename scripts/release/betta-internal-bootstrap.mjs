// 별도 opt-in인 Betta 첫 내부 배포. 일반 v2 품질 판정은 변경하지 않는다.
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { parseAabManifest,parseAabRuntimeSettings,applyGodotExportVersion,applyGodotProjectVersion } from './tag-version-authority.mjs';
import Ajv2020 from 'ajv/dist/2020.js';

export const bettaDigest = bytes => createHash('sha256').update(bytes).digest('hex');
const validateGrant = new Ajv2020({allErrors:true}).compile(JSON.parse(readFileSync(new URL('../../contracts/betta-internal-bootstrap-grant.schema.json',import.meta.url))));
const MAX_AGE=168*3600000;
const QA_ERROR=/^(?:THREE_UI_ROUNDS_REQUIRED|RUN_COVERAGE .+|UNRESOLVED_REVIEW [0-9]+-(?:functional|ux)|PLATFORM_RUN_REQUIRED .+)$/u;
const fail = code => {throw new Error(code);};
export function validateBettaGrant(grant){
  if(!validateGrant(grant) || grant.revoked) fail('BETTA_REVIEWED_GRANT_REQUIRED');
  const overrides=grant.workingOverrides ?? {};
  if(Object.keys(overrides['before-build'] ?? {}).length) fail('BETTA_SOURCE_OVERRIDE_FORBIDDEN');
  for(const path of Object.keys(overrides['before-deploy'] ?? {})){
    if(!/^godot\/android\/build\//u.test(path)
      && !/^godot\/addons\/GodotGooglePlayBilling\/bin\/(debug|release)\/GodotGooglePlayBilling-\1\.aar$/u.test(path)
      && !/^godot\/addons\/admob\/android\/bin\/(?:package\.gd|ads\/poing_godot_admob_ads\.gd|ads\/libs\/poing-godot-admob-(?:ads|core)-(?:debug|release)\.aar)$/u.test(path)
      && !/^godot\/addons\/admob\/internal\/translations\/admob_sample\.(?:en|pt_BR|es|zh_CN|ja)\.translation$/u.test(path)
      && !/^build\/native-downloads\/(?:android-template-v4\.7\.2|godot-google-play-billing-3\.3\.0)\.zip$/u.test(path)) fail('BETTA_SOURCE_OVERRIDE_FORBIDDEN');
  }
  return grant;
}

export function validateBettaInternalContext(grant,context,originalVerdict){
  validateBettaGrant(grant);
  if(context.repository!==grant.repository || context.sourceSha!==grant.sourceSha || context.tag!==grant.releaseTag
    || context.configurationFingerprint!==grant.configurationFingerprint) fail('BETTA_BINDING_MISMATCH');
  if(!['before-build','before-deploy'].includes(context.phase) || !['google-play','app-store'].includes(context.target) || !grant.targets.includes(context.target)) fail('BETTA_INTERNAL_PHASE_REQUIRED');
  if(context.target==='google-play' && (context.playTrack!=='internal' || context.playOperation!=='upload')) fail('BETTA_INTERNAL_UPLOAD_REQUIRED');
  const at=Date.parse(context.now ?? new Date().toISOString()),approved=Date.parse(grant.approvedAt),expires=Date.parse(grant.expiresAt);
  if(![at,approved,expires].every(Number.isFinite) || approved>at || at>=expires || expires<=approved || expires-approved>MAX_AGE) fail('BETTA_EXPIRED');
  if(originalVerdict?.ok!==false || !Array.isArray(originalVerdict.errors) || !originalVerdict.errors.length
    || grant.allowedErrors.some(error=>!QA_ERROR.test(error))
    || originalVerdict.errors.some(error=>!grant.allowedErrors.includes(error))
    || grant.allowedErrors.some(error=>!originalVerdict.errors.includes(error))) fail('BETTA_ORIGINAL_VERDICT_MISMATCH');
  return {ok:true,decisionStatus:'human_exception',productE2eStatus:'blocked',nativeQaWaived:false,publicReleaseAllowed:false,
    exceptionId:grant.id,target:context.target,phase:context.phase,sourceSha:grant.sourceSha,originalVerdict:structuredClone(originalVerdict)};
}

// records는 영속 claim과 실제 provider 조회를 합쳐 만든다. JSON의 자체 verified 값은
// 외부 입력으로 받지 않으며, 실제 소비자 adapter가 조회한 값만 이 함수에 전달한다.
export function chooseBettaAttempt(records,producer){
  if(!Array.isArray(records) || !producer || records.length>2
    || records.some((record,i)=>record.attempt!==i+1) || new Set(records.map(record=>record.producer)).size!==records.length) fail('BETTA_ATTEMPT_HISTORY_INVALID');
  const same=records.find(record=>record.producer===producer);
  if(same) return same.attempt;
  if(records.length===0) return 1;
  if(records.length>=2) fail('BETTA_BUILD_LIMIT');
  const previous=records[0];
  if(previous.state!=='failed' || previous.providerVerified!==true || previous.acceptedUpload!==false) fail('BETTA_PREVIOUS_ATTEMPT_UNRESOLVED');
  return 2;
}

const execute=(program,args,options={})=>execFileSync(program,args,{stdio:['ignore','pipe','pipe'],maxBuffer:64*1024*1024,timeout:30000,...options});
export function inspectBettaAab(file,grant){
  const path=realpathSync(file);
  if(lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() || !path.endsWith('.aab')) fail('BETTA_AAB_REQUIRED');
  const manifest=execute('unzip',['-p',path,'base/manifest/AndroidManifest.xml']);
  const metadata=parseAabManifest(manifest),g=grant.googlePlay;
  if(metadata.packageName!==g.packageName || metadata.versionName!==grant.releaseTag.slice(1) || metadata.versionCode!==g.versionCode) fail('BETTA_AAB_IDENTITY');
  const runtime=parseAabRuntimeSettings(manifest);
  if(runtime.minSdk!==26 || runtime.targetSdk!==36 || !['portrait','1'].includes(runtime.launchOrientation)) fail('BETTA_AAB_SDK_OR_ORIENTATION');
  // AAB는 JAR 서명이다. APK용 apksigner를 대신 사용하지 않는다.
  const signature=execute('jarsigner',['-verify','-verbose','-certs',path]).toString();
  if(!signature.includes('jar verified.') || /jar is unsigned|unsigned entries|signatures missing/iu.test(signature)) fail('BETTA_AAB_SIGNATURE');
  const blocks=execute('unzip',['-Z1',path]).toString().split('\n').filter(name=>/^META-INF\/[A-Za-z0-9_-]+\.(?:RSA|DSA|EC)$/u.test(name));
  if(blocks.length!==1) fail('BETTA_AAB_SIGNER');
  const certificate=execute('openssl',['pkcs7','-inform','DER','-print_certs'],{input:execute('unzip',['-p',path,blocks[0]]),stdio:['pipe','pipe','pipe']}).toString();
  const pems=certificate.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) ?? [];
  if(pems.length!==1) fail('BETTA_AAB_SIGNER');
  const der=Buffer.from(pems[0].replace(/-----[^-]+-----|\s/gu,''),'base64');
  if(bettaDigest(der)!==g.certificateSha256) fail('BETTA_AAB_SIGNER');
  return {kind:'android-app-bundle',...metadata,...runtime,sha256:bettaDigest(readFileSync(path)),certificateSha256:bettaDigest(der)};
}

export function verifyBettaSource(directory,grant,{phase,credentialFile}){
  const workingOverrides=grant.workingOverrides?.[phase] ?? {};
  const root=realpathSync(directory),git=(...args)=>execute('git',['-C',root,...args]);
  if(git('rev-parse','HEAD^{commit}').toString().trim()!==grant.sourceSha) fail('BETTA_SOURCE_HEAD');
  const tree=git('ls-tree','-r','-z',grant.sourceSha);
  if(bettaDigest(tree)!==grant.productTreeSha256) fail('BETTA_SOURCE_TREE');
  for(const entry of tree.toString().split('\0').filter(Boolean)){
    const match=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(entry);
    if(!match) fail('BETTA_SOURCE_ENTRY');
    const [, , expected,path]=match,stat=lstatSync(join(root,path));
    if(!stat.isFile() || stat.isSymbolicLink()) fail('BETTA_SOURCE_FILE');
    const bytes=readFileSync(join(root,path));
    const actual=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if(phase==='before-deploy' && grant.targets?.includes('google-play') && ['godot/export_presets.cfg','godot/project.godot'].includes(path)){
      const original=git('show',`${grant.sourceSha}:${path}`).toString(),binding={versionName:grant.releaseTag.slice(1),androidVersionCode:grant.googlePlay.versionCode};
      const updated=path.endsWith('export_presets.cfg') ? applyGodotExportVersion(original,{platform:'Android',preset:'Android',binding}) : applyGodotProjectVersion(original,{binding});
      if(!bytes.equals(Buffer.from(updated))) fail('BETTA_RELEASE_SETTINGS_CHANGED');
    }else if(actual!==expected) fail('BETTA_SOURCE_CHANGED');
  }
  const extras=git('ls-files','--others','-z').toString().split('\0').filter(Boolean);
  const credentialPath=credentialFile ? relative(root,realpathSync(credentialFile)) : null;
  const generatedAndroid=path=>phase==='before-deploy' && grant.targets?.includes('google-play') && (
    /^native\/android\/seori_account_link\/(?:\.gradle|build)\//u.test(path)
    || /^godot\/android\/build\/(?:\.gradle|build|src\/main\/assets)\//u.test(path)
    || /^godot\/android\/build\/(?:res\/.*\.(?:xml|png|webp)|src\/(?:main|debug|release)\/AndroidManifest\.xml)$/u.test(path)
    || /^godot\/addons\/seori_account_link\/bin\/(debug|release)\/SeoriAccountLink-\1\.aar$/u.test(path)
    || /^build\/android\/[A-Za-z0-9._-]+\.aab$/u.test(path)
    || ['godot/android/.gdignore','godot/android/.build_version'].includes(path));
  // 실행 코드와 네이티브 생성물은 별도 검토된 정확한 digest가 있어야 한다.
  for(const path of extras){
    if(path.startsWith('.seorilabs-release-authority/')) continue;
    if(path.startsWith('godot/.godot/')){
      if(lstatSync(join(root,path)).isSymbolicLink()) fail('BETTA_SOURCE_SYMLINK');
      continue;
    }
    if(path===credentialPath && /^gha-creds-[a-f0-9]+\.json$/u.test(path) && lstatSync(join(root,path)).isFile() && !lstatSync(join(root,path)).isSymbolicLink()) continue;
    if(lstatSync(join(root,path)).isSymbolicLink()) fail('BETTA_SOURCE_SYMLINK');
    if(workingOverrides[path] && bettaDigest(readFileSync(join(root,path)))===workingOverrides[path]) continue;
    if(path.startsWith('godot/') && path.endsWith('.import')){
      const base=path.slice(0,-7),tracked=tree.toString().split('\0').some(entry=>entry.endsWith(`\t${base}`));
      if(tracked || workingOverrides[base]){
        const text=readFileSync(join(root,path),'utf8'),source=`res://${base.slice(6)}`;
        const sections=text.split(/^\[deps\]\r?$/mu),deps=sections.length===2 ? sections[1].split(/^\[[^\]]+\]\r?$/mu)[0] : '';
        const sourceLines=deps.match(/^source_file=.*$/gmu) ?? [];
        const refs=[...text.matchAll(/"(res:\/\/[^"\r\n]+)"/gu)].map(m=>m[1]);
        const translationPrefix=base.endsWith('.csv') ? `res://${base.slice(6,-4)}.` : null;
        const translationRef=ref=>translationPrefix && text.includes('importer="csv_translation"') && ref.startsWith(translationPrefix)
          && /^[A-Za-z]{2,3}(?:_[A-Za-z0-9]{2,8})*\.translation$/u.test(ref.slice(translationPrefix.length))
          && !!workingOverrides[`godot/${ref.slice(6)}`];
        if(text.length>65536 || sourceLines.length!==1 || sourceLines[0]!==`source_file="${source}"` || !/^importer="[a-z0-9_]+"$/mu.test(text)
          || refs.some(ref=>ref!==source && !translationRef(ref) && (!ref.startsWith('res://.godot/imported/') || ref.split('/').includes('..')))
          || /\b(?:ExtResource|SubResource|load|preload)\s*\(/u.test(text)) fail('BETTA_IMPORT_METADATA');
        continue;
      }
    }
    if(path.endsWith('.uid')){
      const base=path.slice(0,-4),tracked=tree.toString().split('\0').some(entry=>entry.endsWith(`\t${base}`));
      if((tracked || workingOverrides[base]) && /^uid:\/\/[a-z0-9]+\s*$/u.test(readFileSync(join(root,path),'utf8'))) continue;
    }
    if(generatedAndroid(path)){
      if(lstatSync(join(root,path)).isSymbolicLink()) fail('BETTA_SOURCE_SYMLINK');
      if(path==='godot/android/.build_version' && readFileSync(join(root,path),'utf8').trim()!=='4.7.2.stable') fail('BETTA_ANDROID_TEMPLATE_VERSION');
      continue;
    }
    fail('BETTA_UNTRACKED_SOURCE');
  }
  return {sourceSha:grant.sourceSha,productTreeSha256:bettaDigest(tree)};
}
