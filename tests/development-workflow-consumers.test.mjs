import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
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
  assert.ok(steps.findIndex(step => step.name === 'Verify Editor E2E before-deploy') < steps.findIndex(step => step.name === 'Promote track'));
});
test('Xcode Cloud start verifies the exact tag candidate before the mutation', () => {
  const script = readFileSync('scripts/trigger-xcode-cloud.mjs', 'utf8');
  const gate = script.indexOf('await verifyXcodeReleaseEvidence');
  assert.ok(gate > script.indexOf('await resolveGitHubTagCommit'));
  assert.ok(gate < script.indexOf('appStoreConnect("/v1/ciBuildRuns"'));
});
test('Godot Android exception is explicit and keeps both central gates and actual deploy artifact binding', () => {
  const workflow = read('godot-deploy-google-play');
  assert.equal(workflow.on.workflow_call.inputs.release_exception_id.default, '');
  assert.equal(workflow.on.workflow_call.inputs.configuration_fingerprint.default, '');
  assert.equal(workflow.on.workflow_call.inputs.release_verifier_sha.default, '');
  const steps = Object.values(workflow.jobs).find(job => job.steps?.some(step => step.name === 'Upload to Google Play')).steps;
  const build = steps.find(step => step.name === 'Verify Editor E2E before-build');
  const deploy = steps.find(step => step.name === 'Verify Editor E2E before-deploy');
  for (const step of [build, deploy]) {
    assert.match(step.run, /if \[ -n "\$RELEASE_EXCEPTION_ID" \]/u);
    assert.match(step.run, /--configuration-fingerprint "\$CONFIGURATION_FINGERPRINT"/u);
    assert.match(step.run, /--verifier-sha/u);
    assert.match(step.run, /--report/u);
    assert.match(step.run, /--app-repository "\$GITHUB_WORKSPACE"/u);
    assert.equal(step.env.SEORI_EXCEPTION_PACKAGE_NAME, '${{ inputs.package_name }}');
    assert.equal(step.env.SEORI_EXCEPTION_TRACK, '${{ inputs.track }}');
    assert.equal(step.env.SEORI_EXCEPTION_RELEASE_STATUS, '${{ inputs.release_status }}');
    assert.equal(step.env.FIREBASE_ANDROID_GOOGLE_SERVICES_JSON_BASE64, '${{ secrets.FIREBASE_ANDROID_GOOGLE_SERVICES_JSON_BASE64 }}');
  }
  const checkout = steps.find(step => step.name === 'Checkout release version authority');
  assert.equal(checkout.with.ref, "${{ inputs.release_exception_id != '' && inputs.release_verifier_sha || 'main' }}");
  assert.ok(steps.findIndex(step => step.name === 'Validate release exception verifier pin') < steps.indexOf(checkout));
  assert.doesNotMatch(build.run, /--artifact/u);
  assert.match(deploy.run, /--artifact-receipt/u); assert.match(deploy.run, /--artifact-file "\$VERIFIED_AAB_PATH"/u);
  const preserve = steps.findIndex(step => step.name === 'Preserve release exception verdicts');
  assert.ok(preserve > steps.indexOf(deploy)); assert.ok(preserve < steps.findIndex(step => step.name === 'Upload to Google Play'));
});
test('Xcode trigger requires exception fingerprint and verifier SHA without changing normal arguments', () => {
  const base = ['--tag', 'v1.1.0', '--bundle-id', 'com.seorilabs.reascend'];
  assert.deepEqual(parseXcodeArgs(base), { tag: 'v1.1.0', bundleId: 'com.seorilabs.reascend', workflowName: '', start: true });
  assert.throws(() => parseXcodeArgs([...base, '--release-exception-id', 'reascend-1.1.0']));
  const parsed = parseXcodeArgs([...base, '--release-exception-id', 'reascend-1.1.0', '--configuration-fingerprint', 'a'.repeat(64), '--verifier-sha', 'b'.repeat(40)]);
  assert.equal(parsed.exceptionId, 'reascend-1.1.0');
  const script = readFileSync('scripts/trigger-xcode-cloud.mjs', 'utf8');
  assert.match(script, /exceptionId, configurationFingerprint, verifierSha/u);
});

test('hosted iOS exception pins reviewed source and preserves reports before upload without Actions permission', () => {
  const workflow = read('godot-deploy-app-store');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  for (const key of ['release_exception_id', 'configuration_fingerprint', 'release_verifier_sha']) assert.equal(workflow.on.workflow_call.inputs[key].default, '');
  const steps = workflow.jobs['build-archive'].steps, index = name => steps.findIndex(step => step.name === name);
  for (const name of ['Require reviewed exception verifier before executing its source', 'Checkout release version authority', 'Verify Editor E2E before-build', 'Verify Editor E2E before-deploy', 'Require all verified exception reports before preservation', 'Preserve verified exception reports before upload', 'Export and upload to App Store Connect', 'Preserve failed exception reports']) assert.ok(index(name) >= 0, name);
  assert.ok(index('Require reviewed exception verifier before executing its source') < index('Checkout release version authority'));
  const failure = steps[index('Preserve failed exception reports')];
  assert.equal(failure.if, "${{ failure() && inputs.release_exception_id != '' }}");
  assert.match(failure.with.name, /app-store-failed-/u);
  const build = steps[index('Verify Editor E2E before-build')], deploy = steps[index('Verify Editor E2E before-deploy')];
  assert.doesNotMatch(build.run, /--artifact/u);
  for (const flag of ['--artifact-file', '--artifact-receipt', '--release-binding', '--app-repository', '--report']) assert.ok(deploy.run.includes(flag));
  for (const step of [build, deploy]) {
    assert.equal(step.env.SEORI_ANALYTICS_SECRET_PRESENT, "${{ secrets.GODOT_ANALYTICS_CONFIG_JSON_BASE64 != '' }}");
    assert.equal(step.env.GODOT_ANALYTICS_CONFIG_JSON_BASE64, undefined);
  }
  const preserve = steps[index('Preserve verified exception reports before upload')];
  assert.ok(index('Require all verified exception reports before preservation') > steps.indexOf(deploy));
  assert.ok(index('Require all verified exception reports before preservation') < steps.indexOf(preserve));
  assert.ok(steps.indexOf(preserve) > steps.indexOf(deploy));
  assert.ok(steps.indexOf(preserve) < index('Export and upload to App Store Connect'));
  assert.equal(preserve.with['if-no-files-found'], 'error'); assert.equal(preserve.with['retention-days'], 3);
});
