import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';

const workflowPath = new URL(
  '../.github/workflows/godot-deploy-google-play.yml',
  import.meta.url,
);

test('Godot Play 업로드는 pip가 있는 고정 Python을 설치한 뒤 API client를 준비한다', async () => {
  const source = await readFile(workflowPath, 'utf8');
  const workflow = parse(source);
  const steps = workflow.jobs['build-aab'].steps;
  const authIndex = steps.findIndex(({ name }) => name === 'Authenticate to Google Cloud');
  const setupIndex = steps.findIndex(
    ({ name }) => name === 'Setup Python for Google Play API client',
  );
  const installIndex = steps.findIndex(
    ({ name }) => name === 'Install Google Play API client',
  );

  assert.ok(authIndex >= 0, 'Google Cloud 인증 step이 필요합니다.');
  assert.ok(setupIndex > authIndex, 'Python은 Google Cloud 인증 뒤에 준비해야 합니다.');
  assert.ok(installIndex > setupIndex, 'API client 설치 전에 Python을 준비해야 합니다.');

  const setup = steps[setupIndex];
  assert.equal(setup.if, '${{ inputs.upload }}');
  assert.equal(
    setup.uses,
    'actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97',
  );
  assert.deepEqual(setup.with, {
    'python-version': '3.13.15',
    'check-latest': false,
  });
  assert.match(
    source,
    /actions\/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7\.0\.0/u,
  );

  const install = steps[installIndex];
  assert.equal(install.if, '${{ inputs.upload }}');
  assert.match(install.run, /python3 -m pip install --upgrade pip/u);
  assert.match(install.run, /google-api-python-client/u);
});
