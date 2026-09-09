import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

for (const projectDir of ['.', 'game', 'nested game/project']) {
  test(`Godot export는 프로젝트 위치 ${projectDir}와 무관하게 업로드 대상에 AAB를 만든다`, async () => {
    const workflow = parse(await readFile(workflowPath, 'utf8'));
    const step = workflow.jobs['build-aab'].steps.find(
      ({ name }) => name === 'Export signed Android AAB',
    );
    const workspace = await mkdtemp(join(tmpdir(), 'godot aab workspace '));
    try {
      await mkdir(join(workspace, projectDir), { recursive: true });
      // Godot CLI처럼 상대 출력 경로를 --path 프로젝트 디렉터리에서 해석한다.
      const commands = `
        keytool() { printf 'Alias name: fixture\\n'; }
        godot() {
          local project output
          while [ "$#" -gt 0 ]; do
            case "$1" in
              --path) project="$2"; shift 2 ;;
              --export-release) output="$3"; shift 3 ;;
              *) shift ;;
            esac
          done
          (cd "$project" && printf 'fixture AAB' > "$output")
        }
      `;
      const result = spawnSync('bash', ['-c', commands + step.run], {
        cwd: workspace,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_WORKSPACE: workspace,
          PROJECT_DIR: projectDir,
          ANDROID_EXPORT_PRESET: 'Android',
          AAB_PATH: 'build/android/moonlight-matgo.aab',
          GODOT_ANDROID_KEYSTORE_RELEASE_PATH: '/unused/fixture.jks',
          GOOGLE_PLAY_UPLOAD_KEYSTORE_PASSWORD: 'fixture-only',
          GOOGLE_PLAY_UPLOAD_KEY_PASSWORD: '',
          GOOGLE_PLAY_UPLOAD_KEY_ALIAS: '',
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        await readFile(join(workspace, 'build/android/moonlight-matgo.aab'), 'utf8'),
        'fixture AAB',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
}
