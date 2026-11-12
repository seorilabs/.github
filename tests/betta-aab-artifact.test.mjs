import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseAabRuntimeSettings} from '../scripts/release/tag-version-authority.mjs';
import {inspectBettaAab,bettaDigest} from '../scripts/release/betta-internal-bootstrap.mjs';
const ns='http://schemas.android.com/apk/res/android';
const varint=n=>{const bytes=[];do{const b=n&127;n=Math.floor(n/128);bytes.push(b|(n?128:0));}while(n);return Buffer.from(bytes);};
const field=(n,value)=>{const b=Buffer.isBuffer(value)?value:Buffer.from(value);return Buffer.concat([varint((n<<3)|2),varint(b.length),b]);};
const attr=(name,value,namespace=ns)=>Buffer.concat([field(1,namespace),field(2,name),field(3,String(value))]);
const element=(name,attributes=[],children=[])=>field(1,Buffer.concat([field(3,name),...attributes.map(a=>field(4,a)),...children.map(c=>field(5,c))]));
const manifest=({minSdk=26,targetSdk=36,orientation='portrait'}={})=>element('manifest',[
  attr('package','com.seorilabs.bettaraising',''),attr('versionName','0.1.0'),attr('versionCode',1)],
  [element('uses-sdk',[attr('minSdkVersion',minSdk),attr('targetSdkVersion',targetSdk)]),element('application',[],[
    element('activity',[attr('screenOrientation',orientation)],[element('intent-filter',[],[
      element('action',[attr('name','android.intent.action.MAIN')]),element('category',[attr('name','android.intent.category.LAUNCHER')])])])])]);
test('real protobuf runtime metadata distinguishes portrait from landscape and SDK drift',()=>{
  assert.deepEqual(parseAabRuntimeSettings(manifest()),{minSdk:26,targetSdk:36,launchOrientation:'portrait'});
  assert.equal(parseAabRuntimeSettings(manifest({orientation:'landscape'})).launchOrientation,'landscape');
  assert.equal(parseAabRuntimeSettings(manifest({targetSdk:35})).targetSdk,35);
});
const available=['keytool','jarsigner','zip','unzip','openssl'].every(command=>spawnSync('sh',['-c',`command -v ${command}`],{stdio:'ignore'}).status===0);
test('actual JAR signatures reject unsigned, wrong signer, wrong SDK and landscape AAB fixtures',{skip:!available},()=>{
  const root=mkdtempSync(join(tmpdir(),'betta-aab-fixture-')),keystore=join(root,'fixture.jks');
  const run=(cmd,args,options={})=>execFileSync(cmd,args,{stdio:['ignore','pipe','pipe'],timeout:30000,...options});
  const password='fixture-only-password';
  try{
    run('keytool',['-genkeypair','-alias','fixture','-keystore',keystore,'-storepass',password,'-keypass',password,'-keyalg','RSA','-keysize','2048','-validity','2','-dname','CN=Ephemeral Test Fixture']);
    const certificate=run('keytool',['-exportcert','-alias','fixture','-keystore',keystore,'-storepass',password]);
    const grant={releaseTag:'v0.1.0',googlePlay:{packageName:'com.seorilabs.bettaraising',versionCode:1,certificateSha256:bettaDigest(certificate)}};
    const make=(name,settings,sign=true)=>{
      const dir=join(root,name);mkdirSync(join(dir,'base/manifest'),{recursive:true});writeFileSync(join(dir,'base/manifest/AndroidManifest.xml'),manifest(settings));
      const aab=join(root,`${name}.aab`);run('zip',['-q','-r',aab,'base'],{cwd:dir});
      if(sign)run('jarsigner',['-keystore',keystore,'-storepass',password,'-keypass',password,aab,'fixture']);
      return aab;
    };
    const valid=make('valid',{});assert.equal(inspectBettaAab(valid,grant).launchOrientation,'portrait');
    assert.throws(()=>inspectBettaAab(make('unsigned',{},false),grant),/BETTA_AAB_SIGNATURE/u);
    assert.throws(()=>inspectBettaAab(valid,{...grant,googlePlay:{...grant.googlePlay,certificateSha256:'0'.repeat(64)}}),/BETTA_AAB_SIGNER/u);
    assert.throws(()=>inspectBettaAab(make('sdk',{targetSdk:35}),grant),/BETTA_AAB_SDK_OR_ORIENTATION/u);
    assert.throws(()=>inspectBettaAab(make('landscape',{orientation:'landscape'}),grant),/BETTA_AAB_SDK_OR_ORIENTATION/u);
  }finally{rmSync(root,{recursive:true,force:true});}
});
