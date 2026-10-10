import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

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
  assert.ok(steps.findIndex(step => step.name === 'Verify Editor E2E before-deploy') < steps.findIndex(step => step.name === 'Promote track'));
});
test('Xcode Cloud start verifies the exact tag candidate before the mutation', () => {
  const script = readFileSync('scripts/trigger-xcode-cloud.mjs', 'utf8');
  const gate = script.indexOf('await verifyReleaseDevelopmentEvidence');
  assert.ok(gate > script.indexOf('await resolveGitHubTagCommit'));
  assert.ok(gate < script.indexOf('appStoreConnect("/v1/ciBuildRuns"'));
});
