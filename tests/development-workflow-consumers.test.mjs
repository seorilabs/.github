import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { runDevelopmentEvidenceCli } from '../scripts/release/verify-development-evidence.mjs';
import { parseArgs as parseXcodeArgs } from '../scripts/trigger-xcode-cloud.mjs';

const read = name => parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'));
const entries = [
  ['rn-deploy-ait', 'Build .ait bundle (custom)', 'Deploy to AppsInToss'],
  ['godot-deploy-ait', 'Export Godot Web', 'Deploy to AppsInToss'],
  ['rn-deploy-google-play', 'Build signed Android AAB', 'Upload AAB to Google Play'],
  ['godot-deploy-google-play', 'Run caller Android build script', 'Upload to Google Play'],
  ['rn-deploy-app-store', 'Archive with Xcode', 'Export and upload to App Store Connect'],
  ['godot-deploy-app-store', 'Export Xcode project', 'Export and upload to App Store Connect'],
];
for (const [name, build, deploy] of entries) {
  test(`${name} checks current evidence before build and market mutation`, () => {
    const steps = Object.values(read(name).jobs).find(job => job.steps?.some(step => step.name === build)).steps;
    const index = label => steps.findIndex(step => step.name === label);
    assert.ok(index('Verify Editor E2E before-build') >= 0);
    assert.ok(index('Verify Editor E2E before-build') < index(build));
    assert.ok(index('Verify Editor E2E before-deploy') > index(build));
    assert.ok(index('Verify Editor E2E before-deploy') < index(deploy));
    for (const phase of ['before-build', 'before-deploy']) {
      const step = steps[index(`Verify Editor E2E ${phase}`)];
      assert.equal(step.if, undefined); assert.equal(step['continue-on-error'], undefined);
      assert.match(step.run, /--sha "\$\(git rev-parse HEAD\)"/u);
    }
    // 같은 후보의 빌드 직전 E2E를 다시 쓰므로 별도 실행 시각을 넘기지 않는다.
    assert.doesNotMatch(steps[index('Verify Editor E2E before-deploy')].run, /--after/u);
  });
}
test('Pages does not turn a push to main into an automatic production build/deploy', () => {
  const workflow = read('godot-pages');
  assert.match(workflow.jobs.build.if, /workflow_dispatch/u);
  assert.match(workflow.jobs.build.if, /refs\/tags\//u);
  assert.equal(workflow.jobs.deploy.needs, 'build');
  for (const [job, phase] of [['build', 'before-build'], ['deploy', 'before-deploy']]) assert.ok(workflow.jobs[job].steps.some(step => step.name === `Verify Editor E2E ${phase}`));
  assert.equal(workflow.jobs.build.outputs?.editor_e2e_completed_at, undefined);
  const deployGate = workflow.jobs.deploy.steps.find(step => step.name === 'Verify Editor E2E before-deploy');
  assert.doesNotMatch(deployGate.run, /--after/u);
});
test('private Apple requests fail before allocating the public macOS archive', () => {
  for (const name of ['rn-deploy-app-store', 'godot-deploy-app-store']) {
    const workflow = read(name);
    const route = workflow.jobs['verify-apple-route'];
    assert.match(route['runs-on'], /seorilabs-x64/u); assert.match(route.steps[0].run, /exit 1/u);
    const archive = Object.values(workflow.jobs).find(job => job.needs === 'verify-apple-route');
    assert.equal(archive.if, 'github.event.repository.private == false');
  }
});
test('build-only and track promotion keep their own required phase', () => {
  assert.ok(Object.values(read('rn-build-ait').jobs).some(job => job.steps?.some(step => step.name === 'Verify Editor E2E before-build')));
  const steps = Object.values(read('promote-google-play').jobs)[0].steps;
  const gate = steps.find(step => step.name === 'Verify development evidence before promotion');
  assert.ok(steps.indexOf(gate) >= 0 && steps.indexOf(gate) < steps.findIndex(step => step.name === 'Promote track'));
  // production 승격은 출시 단계 검사, 테스트 트랙 사이의 승격은 업로드 단계 검사다.
  assert.equal(gate.env.TO_TRACK, '${{ inputs.to_track }}');
  assert.match(gate.run, /\[ "\$TO_TRACK" = production \] && phase=before-release/u);
  assert.match(gate.run, /--phase "\$phase" --rollout "\$\{ROLLOUT:-1\}"/u);
  assert.equal(gate.env.ROLLOUT, '${{ inputs.rollout }}');
  assert.equal(gate.if, undefined); assert.equal(gate['continue-on-error'], undefined);
});
test('Play 업로드와 승격은 실제 목적 트랙과 작업 종류를 근거 검증기에 전달한다', () => {
  const upload = read('godot-deploy-google-play').jobs['build-aab'].steps
    .find(step => step.name === 'Verify Editor E2E before-deploy');
  assert.equal(upload.env.RELEASE_TRACK, '${{ inputs.track }}');
  for (const track of ['', 'internal', 'production']) {
    const capture = 'node() { printf "%s\\n" "$@"; }; git() { printf "fixture-source"; };\n';
    const result = spawnSync('bash', ['-c', capture + upload.run], { encoding: 'utf8',
      env: { ...process.env, RELEASE_TRACK: track, GITHUB_REPOSITORY: 'seorilabs/fixture', EVIDENCE_TAG: 'v1.9.0' } });
    assert.equal(result.status, 0, result.stderr);
    const args = result.stdout.trim().split('\n');
    assert.equal(args[args.indexOf('--play-operation') + 1], 'upload');
    if (track) assert.equal(args[args.indexOf('--play-track') + 1], track);
    else assert.equal(args.includes('--play-track'), false);
  }
  assert.doesNotMatch(upload.run, /--play-track ["']?internal/u);
  const promotion = Object.values(read('promote-google-play').jobs)[0].steps
    .find(step => step.name === 'Verify development evidence before promotion');
  assert.equal(promotion.env.TO_TRACK, '${{ inputs.to_track }}');
  assert.match(promotion.run, /--play-track "\$TO_TRACK" --play-operation promote/u);
});
test('Xcode Cloud start verifies the exact tag candidate before the mutation', () => {
  const script = readFileSync('scripts/trigger-xcode-cloud.mjs', 'utf8');
  const gate = script.indexOf('await verifyReleaseDevelopmentEvidence');
  assert.ok(gate > script.indexOf('await resolveGitHubTagCommit'));
  assert.ok(gate < script.indexOf('appStoreConnect("/v1/ciBuildRuns"'));
});
// 앱 릴리스 예외는 등급제(설계 2026-10-14-test-levels 순서 3)에서 지웠다. 입력·인자·비밀값 전달이 되살아나지 않게 한다.
const EXCEPTION_INPUTS = ['release_exception_id', 'configuration_fingerprint', 'release_verifier_sha'];
for (const [name, upload] of [['godot-deploy-google-play', 'Upload to Google Play'], ['godot-deploy-app-store', 'Export and upload to App Store Connect']]) {
  test(`${name} has no release exception path and always runs the central main verifier`, () => {
    const workflow = read(name);
    for (const key of EXCEPTION_INPUTS) assert.equal(workflow.on.workflow_call.inputs[key], undefined, key);
    const steps = Object.values(workflow.jobs).find(job => job.steps?.some(step => step.name === upload)).steps;
    assert.equal(steps.find(step => step.name === 'Checkout release version authority').with.ref, 'main');
    for (const phase of ['before-build', 'before-deploy']) {
      const step = steps.find(item => item.name === `Verify Editor E2E ${phase}`);
      assert.doesNotMatch(step.run, /exception|--verifier-sha|--report|--artifact|--release-binding/u);
      const keys = ['EVIDENCE_TAG', 'GH_TOKEN'];
      if (name === 'godot-deploy-google-play' && phase === 'before-deploy') keys.push('RELEASE_TRACK');
      assert.deepEqual(Object.keys(step.env).sort(), keys.sort());
    }
    assert.ok(steps.every(step => !/exception|promotion evidence/iu.test(step.name ?? '')));
    assert.doesNotMatch(readFileSync(`.github/workflows/${name}.yml`, 'utf8'), /RELEASE_EXCEPTION|SEORI_EXCEPTION|release-exception/u);
  });
}
test('Xcode trigger and the evidence CLI no longer accept release exception arguments', async () => {
  const base = ['--tag', 'v1.1.0', '--bundle-id', 'com.seorilabs.reascend'];
  assert.deepEqual(parseXcodeArgs(base), { tag: 'v1.1.0', bundleId: 'com.seorilabs.reascend', workflowName: '', start: true });
  assert.deepEqual(parseXcodeArgs([...base, '--release-exception-id', 'reascend-1.1.0']), parseXcodeArgs(base));
  for (const flag of ['--release-exception-id', '--release-binding', '--exception-file', '--preflight', '--risk-notes-file', '--original-evidence-dir', '--xcode-build-number']) {
    await assert.rejects(runDevelopmentEvidenceCli(['--repo', 'seorilabs/example', '--sha', 'a'.repeat(40), '--target', 'google-play', '--phase', 'before-build', flag, 'x']), /INVALID_EVIDENCE_ARGUMENT/u, flag);
  }
  await assert.rejects(runDevelopmentEvidenceCli(['--repo', 'seorilabs/example', '--sha', 'a'.repeat(40), '--target', 'app-store', '--phase', 'before-build', '--verifier-sha', 'b'.repeat(40)]), /INTERNAL_TESTFLIGHT_BOOTSTRAP_ID_REQUIRED/u);
});
