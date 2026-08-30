// Godot App Store 재사용 워크플로우의 실행 경계 계약.
// 릴리즈 태그 version authority와 artifact readback은 release-version-authority.test.mjs가 검증한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parse } from 'yaml';

const workflowPath = '.github/workflows/godot-deploy-app-store.yml';
const workflow = readFileSync(workflowPath, 'utf8');
const parsed = parse(workflow);

test('caller가 필요한 secret만 명시적으로 전달할 수 있다', () => {
  for (const secret of [
    'APPLE_DISTRIBUTION_CERTIFICATE_BASE64',
    'APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD',
    'APPLE_PROVISIONING_PROFILE_BASE64',
    'APPLE_KEYCHAIN_PASSWORD',
    'APPLE_TEAM_ID',
    'APP_STORE_CONNECT_API_KEY_ID',
    'APP_STORE_CONNECT_ISSUER_ID',
    'APP_STORE_CONNECT_PRIVATE_KEY_BASE64',
    'GODOT_ANALYTICS_CONFIG_JSON_BASE64',
  ]) {
    assert.match(workflow, new RegExp(`^      ${secret}:\\n        required: false$`, 'mu'));
  }
  assert.doesNotMatch(workflow, /secrets: inherit/u);
});

test('legacy App Store 경로는 macos-26 app-store environment에서만 실행한다', () => {
  const job = parsed.jobs['archive-upload'];
  assert.equal(job['runs-on'], 'macos-26');
  assert.equal(job.environment, 'app-store');
  assert.deepEqual(parsed.permissions, { contents: 'read' });
});

test('App Store Connect 업로드는 exportArchive와 ASC API key로만 수행한다', () => {
  assert.match(workflow, /xcodebuild -exportArchive/u);
  assert.match(workflow, /-authenticationKeyPath "\$APP_STORE_CONNECT_API_KEY_PATH"/u);
  assert.match(workflow, /<key>manageAppVersionAndBuildNumber<\/key><false\/>/u);
  assert.doesNotMatch(workflow, /^\s+run:.*altool/mu);
});
