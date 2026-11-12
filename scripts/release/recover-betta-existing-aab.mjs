#!/usr/bin/env node
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {recoverBettaExistingAab} from './betta-existing-aab-recovery.mjs';
if(process.argv.length!==2 || !process.env.BETTA_EXISTING_AAB_ID || !process.env.RUNNER_TEMP)throw new Error('BETTA_RECOVERY_EXPLICIT_CI_REQUIRED');
const result=await recoverBettaExistingAab({id:process.env.BETTA_EXISTING_AAB_ID,report:join(process.env.RUNNER_TEMP,'betta-upload-only-before-upload.json')});
writeFileSync(join(process.env.RUNNER_TEMP,'betta-upload-only-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({scope:result.scope,artifactSourceSha:result.artifactSourceSha,additionalGameBuilds:0,fullWorkingTreeAuditPassed:false,uploadCommand:result.uploadCommand}));
