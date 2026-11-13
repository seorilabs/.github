#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {recoverBettaExistingIpa} from './betta-existing-ipa-recovery.mjs';
const {values,positionals}=parseArgs({strict:true,allowPositionals:false,options:{
 id:{type:'string'},'app-repository':{type:'string'},'archive-file':{type:'string'},'log-archive-file':{type:'string'},report:{type:'string'},upload:{type:'boolean',default:false},
}});
if(positionals.length || values.id!=='betta-0-1-1-existing-ipa-upload-only'
 || ['app-repository','archive-file','log-archive-file','report'].some(k=>!values[k]))throw new Error('BETTA_IPA_EXPLICIT_CLI_SCOPE_REQUIRED');
const result=await recoverBettaExistingIpa({id:values.id,sourceDirectory:values['app-repository'],archiveFile:values['archive-file'],logArchiveFile:values['log-archive-file'],report:values.report,upload:values.upload});
console.log(JSON.stringify({scope:result.scope,artifact:result.artifact,uploadInvoked:result.uploadInvoked,additionalGameBuilds:result.additionalGameBuilds}));
