import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, realpathSync, readdirSync, readlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { bettaDigest } from './betta-internal-bootstrap.mjs';
const fail=code=>{throw new Error(code);};
const exec=(program,args,options={})=>execFileSync(program,args,{stdio:['pipe','pipe','pipe'],maxBuffer:16*1024*1024,timeout:30000,...options});
const plist=bytes=>JSON.parse(exec('python3',['-c','import plistlib,json,sys,base64,datetime; print(json.dumps(plistlib.loads(sys.stdin.buffer.read()),default=lambda v:base64.b64encode(v).decode() if isinstance(v,bytes) else v.isoformat()))'],{input:bytes}));
export function inspectBettaAppleApp(directory,grant,provider){
  const root=realpathSync(directory),g=grant.appStore;
  if(lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory() || !root.endsWith('.app')) fail('BETTA_SIGNED_APP_REQUIRED');
  try{exec('codesign',['--verify','--deep','--strict','-R',`=anchor apple generic and certificate leaf[subject.OU] = "${g.teamId}"`,root]);}
  catch{fail('BETTA_APPLE_SIGNATURE');}
  const info=plist(readFileSync(join(root,'Info.plist'))),rawProfile=readFileSync(join(root,'embedded.mobileprovision'));
  if(bettaDigest(rawProfile)!==g.profileSha256) fail('BETTA_APPLE_PROFILE_CHANGED');
  const profile=plist(exec('security',['cms','-D','-i',join(root,'embedded.mobileprovision')]));
  const entitlements=plist(exec('codesign',['--display','--entitlements',':-',root]));
  const identifier=`${g.teamId}.${g.bundleId}`;
  if(!Number.isSafeInteger(provider?.number) || provider.number<Number(g.initialBuildNumber) || provider.number>=Number(g.initialBuildNumber)+2
    || info.CFBundleIdentifier!==g.bundleId || info.CFBundleShortVersionString!==grant.releaseTag.slice(1) || String(info.CFBundleVersion)!==String(provider.number)
    || info.ITSAppUsesNonExemptEncryption!==false || !/^iphoneos(?:2[6-9]|[3-9][0-9])(?:\.|$)/u.test(info.DTSDKName ?? '')
    || JSON.stringify(info.UIDeviceFamily)!=='[1]' || profile.UUID!==g.profileUuid || !profile.TeamIdentifier?.includes(g.teamId)
    || profile.Entitlements?.['application-identifier']!==identifier || profile.Entitlements?.['get-task-allow']!==false
    || profile.ProvisionedDevices!==undefined || profile.ProvisionsAllDevices===true
    || entitlements['application-identifier']!==identifier || entitlements['get-task-allow']!==false
    || entitlements['com.apple.developer.team-identifier']!==g.teamId
    || entitlements['com.apple.developer.devicecheck.appattest-environment']!=='production'
    || JSON.stringify(entitlements['com.apple.developer.applesignin'])!=='["Default"]') fail('BETTA_APPLE_ARTIFACT_METADATA');
  const certDir=mkdtempSync(join(tmpdir(),'betta-signer-'));
  try{
    const prefix=join(certDir,'certificate-');exec('codesign',['--display','--extract-certificates',prefix,root]);
    const digest=bettaDigest(readFileSync(`${prefix}0`));
    if(digest!==g.certificateSha256 || profile.DeveloperCertificates?.length!==1
      || bettaDigest(Buffer.from(profile.DeveloperCertificates[0],'base64'))!==digest) fail('BETTA_APPLE_SIGNER');
  }finally{rmSync(certDir,{recursive:true,force:true});}
  if(!lstatSync(join(root,'PrivacyInfo.xcprivacy')).isFile()) fail('BETTA_PRIVACY_MANIFEST_REQUIRED');
  const entries=[];
  const walk=dir=>{
    for(const name of readdirSync(dir).sort()){
      const file=join(dir,name),stat=lstatSync(file),path=relative(root,file);
      if(stat.isSymbolicLink()){
        const destination=relative(root,realpathSync(file));
        if(destination==='..' || destination.startsWith('../') || isAbsolute(destination)) fail('BETTA_APPLE_SYMLINK_ESCAPE');
        entries.push([path,'symlink',readlinkSync(file)]);
      }else if(stat.isDirectory())walk(file);
      else if(stat.isFile()){
        if(name==='PrivacyInfo.xcprivacy'){
          const privacy=plist(readFileSync(file));
          if(typeof privacy.NSPrivacyTracking!=='boolean') fail('BETTA_PRIVACY_MANIFEST_INVALID');
        }
        entries.push([path,'file',bettaDigest(readFileSync(file))]);
      }else fail('BETTA_APPLE_FILE_TYPE');
    }
  };walk(root);
  return {kind:'signed-ios-app',bundleId:g.bundleId,version:info.CFBundleShortVersionString,buildNumber:String(info.CFBundleVersion),
    sha256:bettaDigest(Buffer.from(JSON.stringify(entries))),digestScope:'signed-app-tree-files-and-symlinks',profileSha256:g.profileSha256,certificateSha256:g.certificateSha256};
}
