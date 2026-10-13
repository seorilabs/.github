import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import * as trigger from '../scripts/trigger-xcode-cloud.mjs';

test('development workflow v1 still accepts a document without the optional release exception extension', () => {
  const schema = JSON.parse(readFileSync('contracts/development-workflow.schema.json', 'utf8'));
  const document = parse(readFileSync('contracts/development-workflow.yaml', 'utf8'));
  delete document.releaseExceptions;
  assert.equal(new Ajv2020().compile(schema)(document), true);
});

test('Xcode exception rejection writes the requested audit report and rethrows the original rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xcode-rejected-audit-'));
  try {
    const path = join(dir, 'report.json');
    const options = { repository: 'seorilabs/reascend', sourceSha: 'a'.repeat(40), tag: 'v1.1.0',
      target: 'app-store', phase: 'before-build', exceptionId: 'reascend-1.1.0' };
    await assert.rejects(trigger.verifyXcodeReleaseEvidence(options, path, async () => { throw new Error('RELEASE_EXCEPTION_REVOKED'); }), /RELEASE_EXCEPTION_REVOKED/u);
    const report = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(report.ok, false); assert.equal(report.decisionStatus, 'rejected');
    assert.equal(report.productE2eStatus, 'blocked'); assert.equal(report.error, 'RELEASE_EXCEPTION_REVOKED');
    assert.equal(report.sourceSha, options.sourceSha); assert.equal(report.target, options.target);
    assert.equal(report.scope, 'xcode-launch-request'); assert.equal(report.actualCiVerification, 'pending-ci-hook');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
