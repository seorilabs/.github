import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../.github/workflows/rn-deploy-app-store.yml', import.meta.url), 'utf8'));
const step = Object.values(workflow.jobs).flatMap(job => job.steps ?? []).find(item => item.name === 'Archive with Xcode');

// Run the real shell step with only the external Xcode command replaced. No signing
// material, Apple API, simulator or device is used by these workflow regressions.
function execute(projectProfile) {
  const root = mkdtempSync(join(tmpdir(), 'rn-profile-env-'));
  try {
    const workspace = join(root, 'Fixture.xcworkspace');
    mkdirSync(workspace);
    const archive = join(root, 'archives', 'Fixture.xcarchive');
    const calls = join(root, 'archive-calls.json');
    writeFileSync(join(root, 'xcodebuild'), `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('-showBuildSettings')) {
 const profile=process.env.PROJECT_PROFILE==='dynamic' ? (process.env.IOS_PROVISIONING_PROFILE_NAME ?? '') : process.env.PROJECT_PROFILE;
 if(profile) process.stdout.write('    PROVISIONING_PROFILE_SPECIFIER = '+profile+'\\n');
} else if(args[0]==='archive') {
 fs.mkdirSync(process.env.ARCHIVE_PATH,{recursive:true});
 fs.writeFileSync(process.env.CALLS,JSON.stringify(args));
} else process.exit(99);
`, { mode: 0o755 });
    const values = {
      'steps.meta.outputs.workspace': workspace,
      'steps.meta.outputs.scheme': 'Fixture',
      'steps.meta.outputs.archive_path': archive,
      'steps.signing.outputs.profile_name': 'Fixture App Store Profile',
      'steps.release.outputs.apple_marketing_version': '1.2.0',
      'steps.release.outputs.apple_build_number': '1002000',
    };
    const env = { ...process.env, PATH: root + ':' + process.env.PATH, APPLE_TEAM_ID: 'FIXTURETEAM', PROJECT_PROFILE: projectProfile, CALLS: calls };
    delete env.IOS_PROVISIONING_PROFILE_NAME;
    for (const [key, expression] of Object.entries(step.env)) {
      const variable = String(expression).match(/^\$\{\{\s*(.*?)\s*\}\}$/u)?.[1];
      env[key] = variable ? values[variable] : expression;
      assert.equal(typeof env[key], 'string', `unresolved workflow expression ${key}`);
    }
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', step.run], { env, encoding: 'utf8' });
    const archived = result.status === 0 ? JSON.parse(readFileSync(calls, 'utf8')) : null;
    return { status: result.status, output: result.stdout + result.stderr, archived };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('RN caller의 환경 변수 프로파일을 설치한 프로파일 이름으로 해석하고 archive한다', () => {
  const result = execute('dynamic');
  assert.equal(result.status, 0, result.output);
  assert.ok(result.archived.includes('CODE_SIGN_STYLE=Manual'));
  assert.ok(result.archived.includes('CODE_SIGN_IDENTITY=Apple Distribution'));
  assert.ok(!result.archived.some(arg => arg.startsWith('PROVISIONING_PROFILE_SPECIFIER=')), 'Pods 전체에 프로파일을 강제하지 않는다');
});

test('RN caller의 기존 리터럴 프로파일 이름도 그대로 archive한다', () => {
  const result = execute('Fixture App Store Profile');
  assert.equal(result.status, 0, result.output);
  assert.ok(result.archived);
});

test('설치한 프로파일과 다른 caller 프로파일은 archive 전에 거부한다', () => {
  const result = execute('Different Profile');
  assert.equal(result.status, 1);
  assert.match(result.output, /프로파일과 설치된 프로파일이 다르다/u);
  assert.equal(result.archived, null);
});
