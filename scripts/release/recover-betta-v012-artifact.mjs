import {recoverBettaV012Artifact} from './betta-v012-artifact-upload.mjs';
const allowed=new Set(['id','source-directory','archive-file','failure-log-file','report','upload']),args=new Map();
try{
 for(let i=2;i<process.argv.length;i+=2){
  const key=process.argv[i]?.replace(/^--/u,''),value=process.argv[i+1];
  if(!process.argv[i]?.startsWith('--') || !allowed.has(key) || !value || value.startsWith('--') || args.has(key))throw new Error('BETTA_V012_ARGUMENT');
  args.set(key,value);
 }
 for(const key of ['id','source-directory','archive-file','failure-log-file','report'])if(!args.has(key))throw new Error('BETTA_V012_ARGUMENT');
 if(args.has('upload') && !['true','false'].includes(args.get('upload')))throw new Error('BETTA_V012_ARGUMENT');
 const result=await recoverBettaV012Artifact({id:args.get('id'),sourceDirectory:args.get('source-directory'),archiveFile:args.get('archive-file'),failureLogFile:args.get('failure-log-file'),report:args.get('report'),upload:args.get('upload')==='true'});
 process.stdout.write(JSON.stringify({scope:result.scope,sourceSha:result.sourceSha,target:result.target,additionalGameBuilds:0,uploadInvoked:result.uploadInvoked,productE2eStatus:result.productE2eStatus})+'\n');
}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
