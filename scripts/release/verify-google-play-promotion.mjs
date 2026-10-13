#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verifyGooglePlayPromotion } from './verify-release-exception.mjs';

export async function main(argv = process.argv.slice(2)) {
  const keys = { '--repo': 'repository', '--sha': 'sourceSha', '--tag': 'tag', '--release-exception-id': 'exceptionId',
    '--verifier-sha': 'verifierSha', '--configuration-fingerprint': 'configurationFingerprint', '--ci-run-id': 'ciRunId',
    '--ci-run-attempt': 'ciRunAttempt', '--evidence-bundle': 'evidenceBundleFile', '--report': 'reportFile' };
  const options = { target: 'google-play', phase: 'before-deploy' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = keys[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--') || options[key]) throw new Error('RELEASE_PROMOTION_ARGUMENT_INVALID');
    options[key] = argv[i + 1];
  }
  if (!options.reportFile) throw new Error('RELEASE_PROMOTION_REPORT_REQUIRED');
  try {
    const report = await verifyGooglePlayPromotion(options);
    writeFileSync(options.reportFile, `${JSON.stringify(report, null, 2)}\n`);
    console.log('human_exception: promotion-recheck; product E2E blocked; same successful CI artifact verified');
  } catch (error) {
    writeFileSync(options.reportFile, `${JSON.stringify({ ok: false, decisionStatus: 'rejected', productE2eStatus: 'blocked',
      scope: 'promotion-recheck', actualCiVerification: 'unverified', repository: options.repository,
      sourceSha: options.sourceSha, releaseTag: options.tag, error: error.message }, null, 2)}\n`);
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
