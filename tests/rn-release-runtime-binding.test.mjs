import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

for (const [market, preparation, verification, consumer] of [
  ['google-play', 'Prepare native project', 'Verify AAB runtime release version', 'Upload AAB to Google Play'],
  ['app-store', 'Run caller preparation', 'Verify archive runtime release version', 'Export and upload to App Store Connect'],
]) {
  test(`RN ${market} binds the preparation and packaged runtime verification to the release`, () => {
    const url = new URL(`../.github/workflows/rn-deploy-${market}.yml`, import.meta.url);
    const workflow = parse(readFileSync(url, 'utf8'));
    assert.equal(workflow.on.workflow_call.inputs.verify_runtime_release_script.default, '');
    const steps = Object.values(workflow.jobs).find(job => job.steps.some(step => step.name === preparation)).steps;
    const prepare = steps.find(step => step.name === preparation);
    const verify = steps.find(step => step.name === verification);
    for (const key of ['SEORI_RELEASE_TAG', 'SEORI_RELEASE_VERSION', 'SEORI_RELEASE_SOURCE_SHA']) {
      assert.ok(prepare.env[key], key);
      assert.equal(prepare.env[key], verify.env[key], key);
    }
    assert.ok(steps.indexOf(prepare) < steps.indexOf(verify));
    const upload = steps.find(step => step.name === consumer);
    assert.ok(steps.indexOf(verify) < steps.indexOf(upload));
    if (market === 'app-store') {
      assert.match(upload.run, /destination -string export/);
      assert.ok(upload.run.indexOf('--ipa') < upload.run.indexOf('altool --upload-app'));
    }
  });
}
