// WorkflowBundle v5 정본 경로가 release tag를 유일한 version authority로 쓰는지 검증한다.
// 실제 artifact fixture(.aab 컨테이너, .ait 컨테이너)와 실제 워크플로우 파일을 그대로 읽는다.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import {
  buildRuntimeBindingV5Contract,
  resolveBuildRuntimeBindingV5,
} from '../scripts/fleet/static-runtime-binding-v5.mjs';
import {
  bindingDigest,
  computeAuthorityRevision,
  computeConfigRevision,
  createReleaseBinding,
} from '../scripts/release/tag-version-authority.mjs';
import { collectCallerMigrationInventory } from '../scripts/release/collect-caller-migration-inventory.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = resolve(REPOSITORY_ROOT, 'fixtures/release-version-authority');
const AUTHORITY_CONTRACT = resolve(REPOSITORY_ROOT, 'contracts/release-version-authority.yaml');
const VERIFY_CLI = resolve(REPOSITORY_ROOT, 'scripts/release/verify-release-artifact.mjs');
const BUNDLE_SHA = 'c'.repeat(40);
const SOURCE_SHA = 'd'.repeat(40);
const DIGEST = `sha256:${'3'.repeat(64)}`;
const RELEASE_TAG = 'v1.2.3';
const RELEASE_REF = `refs/tags/${RELEASE_TAG}`;

const V5_WORKFLOWS = Object.freeze({
  'react-native-android': '.github/workflows/rn-build-android-cloud-v2.yml',
  'godot-android': '.github/workflows/godot-build-android-cloud-v2.yml',
  'ait-granite': '.github/workflows/ait-build-only-v1.yml',
  'ait-web': '.github/workflows/ait-build-only-v1.yml',
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function workflowText(path) {
  return readFileSync(resolve(REPOSITORY_ROOT, path), 'utf8');
}

function releaseContext({
  profile = 'react-native-android',
  target = 'android',
  eventName = 'push',
  eventRef = RELEASE_REF,
  eventSourceSha = SOURCE_SHA,
  repositoryId = '7001',
  fullName = 'seorilabs/runtime-canary',
} = {}) {
  const caller = target === 'android'
    ? '.github/workflows/android-build-only.yml'
    : '.github/workflows/ait-build-only.yml';
  return {
    eventName,
    eventRef,
    eventSourceSha,
    pullRequestBaseSha: '',
    pullRequestHeadRef: '',
    pullRequestHeadRepository: '',
    repositoryPrivate: 'true',
    repositoryId,
    fullName,
    callerWorkflowRef: `${fullName}/${caller}@${eventRef}`,
    jobWorkflowRepository: 'seorilabs/.github',
    jobWorkflowSha: BUNDLE_SHA,
    jobWorkflowRef: `seorilabs/.github/${V5_WORKFLOWS[profile]}@${BUNDLE_SHA}`,
    runId: '1234',
    runAttempt: '1',
    bindingTarget: target,
  };
}

function releaseResponse(request, profile, overrides = {}) {
  const android = request.bindingTarget === 'android';
  const manifest = {
    schemaVersion: 1,
    lifecycleState: 'ACTIVE',
    repositoryId: request.repositoryId,
    fullName: request.fullName,
    sourceSha: request.applicationSourceSha,
    sourceRef: overrides.sourceRef ?? RELEASE_REF,
    observationId: 'observation-release-1',
    observationDigest: `sha256:${'4'.repeat(64)}`,
    configRevisionId: 'config-release-1',
    configRevision: 11,
    configRevisionDigest: `sha256:${'5'.repeat(64)}`,
    signedSnapshotDigest: `sha256:${'6'.repeat(64)}`,
    snapshotSignature: {
      keyId: 'snapshot-runtime-key',
      policyRevision: 'snapshot-runtime-policy-v1',
      digest: `sha256:${'7'.repeat(64)}`,
    },
    workflowBundle: {
      sourceSha: request.workflowExecutionSha,
      payloadDigest: DIGEST,
      approvalState: overrides.approvalState ?? 'APPROVED',
      buildProfiles: ['react-native-android', 'godot-android'],
    },
    buildBinding: {
      target: request.bindingTarget,
      buildProfile: profile,
      packageManager: android
        ? profile === 'react-native-android' ? 'pnpm' : null
        : profile === 'ait-granite' ? 'pnpm' : 'npm',
      executionRoot: '.',
      dependencyRoot: '.',
      scriptPath: android ? 'scripts/build-android.sh' : 'scripts/build-ait.sh',
      artifactKind: android ? 'android-aab' : 'ait',
    },
  };
  return {
    schemaVersion: 1,
    state: 'VERIFIED',
    mode: request.mode,
    repositoryId: request.repositoryId,
    fullName: request.fullName,
    applicationSourceSha: request.applicationSourceSha,
    eventSourceSha: request.eventSourceSha,
    manifestDigest: sha256(JSON.stringify(canonicalize(manifest))),
    manifest,
  };
}

function expectedReleaseBinding(profile) {
  const authorityRevision = computeAuthorityRevision(readFileSync(AUTHORITY_CONTRACT, 'utf8'));
  return createReleaseBinding({
    tag: RELEASE_TAG,
    sourceSha: SOURCE_SHA,
    authorityRevision,
    configRevision: computeConfigRevision({
      calledWorkflowRepository: 'seorilabs/.github',
      calledWorkflowRef: `seorilabs/.github/${V5_WORKFLOWS[profile]}@${BUNDLE_SHA}`,
      calledWorkflowSha: BUNDLE_SHA,
      authorityRevision,
    }),
  });
}

test('v5 정본 계약이 release tag를 build source/version authority로 선언한다', () => {
  assert.equal(
    buildRuntimeBindingV5Contract.sourceStrategy,
    'exact-main-or-fixed-canary-pr-base-or-exact-release-tag',
  );
  assert.equal(
    buildRuntimeBindingV5Contract.releaseVersionAuthority,
    'release-version-authority-v1',
  );
  assert.deepEqual([...buildRuntimeBindingV5Contract.targets], ['android', 'ait']);
  assert.deepEqual(
    Object.values(buildRuntimeBindingV5Contract.calledWorkflows)
      .map(({ calledWorkflowPath }) => calledWorkflowPath)
      .sort()
      .filter((path, index, all) => all.indexOf(path) === index),
    [
      '.github/workflows/ait-build-only-v1.yml',
      '.github/workflows/godot-build-android-cloud-v2.yml',
      '.github/workflows/rn-build-android-cloud-v2.yml',
    ],
  );
});

test('v5 release 실행은 태그에서 version을 파생하고 source SHA와 config revision을 고정한다', async () => {
  for (const [profile, target] of [
    ['react-native-android', 'android'],
    ['godot-android', 'android'],
  ]) {
    const binding = await resolveBuildRuntimeBindingV5(releaseContext({ profile, target }), {
      trustedManifestReadback: async (request) => {
        assert.equal(request.mode, 'RELEASE');
        assert.equal(request.releaseRef, RELEASE_REF);
        assert.equal(request.releaseTag, RELEASE_TAG);
        assert.equal(request.schema, 'workflow-bundle-v5-build-release');
        assert.equal(request.bindingTarget, target);
        return releaseResponse(request, profile);
      },
    });

    const expected = expectedReleaseBinding(profile);
    assert.equal(binding.mode, 'RELEASE');
    assert.equal(binding.bindingTarget, target);
    assert.equal(binding.applicationSourceSha, SOURCE_SHA);
    assert.equal(binding.release.tag, RELEASE_TAG);
    assert.equal(binding.release.sourceSha, SOURCE_SHA);
    assert.equal(binding.release.versionName, '1.2.3');
    assert.equal(binding.release.androidVersionCode, 1001002003);
    assert.equal(binding.release.appleBuildNumber, 1002003);
    assert.equal(binding.release.configRevision, expected.configRevision);
    assert.equal(binding.release.authorityRevision, expected.authorityRevision);
    assert.equal(binding.release.bindingDigest, bindingDigest(expected));
    assert.equal(
      binding.releaseArtifactKind,
      target === 'android' ? 'android-app-bundle' : 'ait',
    );
    assert.equal(binding.buildProfile, profile);
  }
});

test('승격되지 않은 AIT build profile은 release 실행에서도 fail-closed다', async () => {
  // ait-granite / ait-web은 promotionScope에도 canary에도 없다. Backoffice가 서명된 manifest를
  // 내려주더라도 승격 전에는 어떤 artifact도 만들지 않는다.
  const bundleSource = parse(
    readFileSync(resolve(REPOSITORY_ROOT, 'contracts/workflow-bundle-v5-source.yaml'), 'utf8'),
  );
  assert.deepEqual(bundleSource.promotionScope.buildProfiles, [
    'react-native-android',
    'godot-android',
  ]);
  for (const profile of ['ait-granite', 'ait-web']) {
    assert.equal(bundleSource.promotionScope.buildProfiles.includes(profile), false, profile);
    for (const eventRef of [RELEASE_REF, 'refs/heads/main']) {
      await assert.rejects(
        resolveBuildRuntimeBindingV5(
          releaseContext({
            profile,
            target: 'ait',
            eventRef,
            eventName: eventRef === RELEASE_REF ? 'push' : 'workflow_dispatch',
          }),
          {
            trustedManifestReadback: async (request) =>
              releaseResponse(request, profile, {
                sourceRef: eventRef === RELEASE_REF ? RELEASE_REF : 'refs/heads/main',
              }),
          },
        ),
        /BUILD_PROFILE_NOT_PROMOTED/u,
        `${profile}@${eventRef}`,
      );
    }
  }
});

test('v5 non-release 실행에는 태그 파생값이 없다', async () => {
  const context = releaseContext({ eventName: 'workflow_dispatch', eventRef: 'refs/heads/main' });
  const binding = await resolveBuildRuntimeBindingV5(context, {
    trustedManifestReadback: async (request) => {
      assert.equal(request.mode, 'APPROVED');
      assert.equal(request.releaseRef, undefined);
      return releaseResponse(request, 'react-native-android', {
        sourceRef: 'refs/heads/main',
        approvalState: 'APPROVED',
      });
    },
  });
  assert.equal(binding.mode, 'APPROVED');
  assert.equal(binding.release, null);
});

test('v5 release 실행은 태그 ref, manifest ref, 번들 승인 상태를 모두 fail-closed로 대조한다', async () => {
  const readback = (profile, overrides) => async (request) =>
    releaseResponse(request, profile, overrides);

  // prerelease와 중첩 태그 ref는 마켓 artifact를 만들지 않는다.
  for (const eventRef of ['refs/tags/v1.2.3-rc.1', 'refs/tags/release/v1.2.3', 'refs/tags/1.2.3']) {
    await assert.rejects(
      resolveBuildRuntimeBindingV5(releaseContext({ eventRef }), {
        trustedManifestReadback: readback('react-native-android'),
      }),
      /BUILD_RUNTIME_RELEASE_TAG_INVALID/u,
      eventRef,
    );
  }

  // pull_request로는 release 실행을 만들 수 없다.
  await assert.rejects(
    resolveBuildRuntimeBindingV5(
      { ...releaseContext(), eventName: 'pull_request', pullRequestBaseSha: 'e'.repeat(40) },
      { trustedManifestReadback: readback('react-native-android') },
    ),
    /BUILD_RUNTIME_RELEASE_IDENTITY_INVALID/u,
  );

  // manifest가 main을 가리키면 태그 실행에 재사용할 수 없다.
  await assert.rejects(
    resolveBuildRuntimeBindingV5(releaseContext(), {
      trustedManifestReadback: readback('react-native-android', { sourceRef: 'refs/heads/main' }),
    }),
    /BUILD_RUNTIME_READBACK_INVALID/u,
  );

  // CANDIDATE 번들로는 마켓 artifact를 만들지 않는다.
  await assert.rejects(
    resolveBuildRuntimeBindingV5(releaseContext(), {
      trustedManifestReadback: readback('react-native-android', { approvalState: 'CANDIDATE' }),
    }),
    /BUILD_RUNTIME_READBACK_INVALID/u,
  );

  // profile은 caller가 아니라 서명된 manifest가 정한다. target이 다르면 계약이 없다.
  await assert.rejects(
    resolveBuildRuntimeBindingV5(releaseContext({ profile: 'ait-granite', target: 'ait' }), {
      trustedManifestReadback: readback('react-native-android'),
    }),
    /BUILD_RUNTIME_READBACK_INVALID/u,
  );
});

test('v5 정본 워크플로우는 caller 입력 없이 태그 파생값과 artifact readback을 강제한다', () => {
  for (const path of [
    '.github/workflows/rn-build-android-cloud-v2.yml',
    '.github/workflows/godot-build-android-cloud-v2.yml',
    '.github/workflows/ait-build-only-v1.yml',
  ]) {
    const text = workflowText(path);
    const workflow = parse(text);

    // 권한 있는 job이 caller 입력을 신뢰하지 않는다.
    assert.equal(Object.hasOwn(workflow.on.workflow_call ?? {}, 'inputs'), false, path);
    assert.doesNotMatch(text, /inputs\./u, path);
    assert.doesNotMatch(text, /secrets:\s*inherit|uses:.*@main\b/u, path);
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (job['runs-on'] === 'seorilabs-rpi-arm64') {
        assert.equal(job.if, '${{ github.event.repository.private }}', `${path}:${name}`);
      }
    }

    // 태그 실행에서만 release binding을 만들고, 그 binding으로 artifact를 다시 읽는다.
    assert.match(text, /release_mode == 'true'/u, path);
    assert.match(text, /resolve-release-version\.mjs --github-output/u, path);
    assert.match(text, /verify-release-artifact\.mjs/u, path);
    assert.match(text, /EXPECTED_BINDING_DIGEST/u, path);
    assert.match(text, /release-artifact-receipt\.txt/u, path);
    assert.match(text, /releaseBindingDigest/u, path);

    // 외부 action은 모두 immutable SHA로 고정한다.
    for (const uses of text.matchAll(/uses:\s+([^\s#]+)/gu)) {
      assert.match(uses[1], /@[0-9a-f]{40}$/u, `${path}: ${uses[1]}`);
    }
  }

  for (const path of [
    '.github/workflows/rn-build-android-cloud-v2.yml',
    '.github/workflows/godot-build-android-cloud-v2.yml',
  ]) {
    const text = workflowText(path);
    assert.match(text, /_SEORI_RELEASE_VERSION_NAME=\$\{RELEASE_VERSION_NAME\}/u, path);
    assert.match(text, /_SEORI_RELEASE_VERSION_CODE=\$\{RELEASE_VERSION_CODE\}/u, path);
    assert.match(text, /--kind android-app-bundle/u, path);
  }
  assert.match(workflowText('.github/workflows/ait-build-only-v1.yml'), /--kind ait/u);
});

test('v5 Cloud Build 설정은 태그 파생 version만 주입하고 기본값은 비어 있다', () => {
  for (const path of [
    '.github/cloud-build/rn-android-build-only-v2.yaml',
    '.github/cloud-build/godot-android-build-only-v2.yaml',
  ]) {
    const config = parse(workflowText(path));
    assert.deepEqual(config.substitutions, {
      _SEORI_RELEASE_TAG: '',
      _SEORI_RELEASE_VERSION_NAME: '',
      _SEORI_RELEASE_VERSION_CODE: '',
    });
    const script = config.steps[0].args[1];
    assert.match(script, /export SEORI_RELEASE_VERSION_NAME=\$\{_SEORI_RELEASE_VERSION_NAME\}/u, path);
    assert.match(script, /export SEORI_RELEASE_VERSION_CODE=\$\{_SEORI_RELEASE_VERSION_CODE\}/u, path);
    assert.match(config.steps[0].name, /@sha256:[0-9a-f]{64}$/u, path);
  }
});

test('실제 AAB fixture는 태그 파생값과 다르면 업로드 전에 fail-closed된다', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-v5-'));
  try {
    const authorityRevision = computeAuthorityRevision(readFileSync(AUTHORITY_CONTRACT, 'utf8'));
    const bindingPath = join(root, 'binding.json');
    writeFileSync(
      bindingPath,
      `${JSON.stringify(
        createReleaseBinding({
          tag: RELEASE_TAG,
          sourceSha: SOURCE_SHA,
          authorityRevision,
          configRevision: computeConfigRevision({
            calledWorkflowRepository: 'seorilabs/.github',
            calledWorkflowRef: `seorilabs/.github/${V5_WORKFLOWS['react-native-android']}@${BUNDLE_SHA}`,
            calledWorkflowSha: BUNDLE_SHA,
            authorityRevision,
          }),
        }),
        null,
        2,
      )}\n`,
    );

    for (const [fixture, shouldPass] of [
      ['react-native/android/app-release.aab', true],
      ['react-native/android/app-release-package-json-authority.aab', false],
      ['godot/android/app-release-config-json-authority.aab', false],
    ]) {
      const artifact = join(FIXTURES, fixture);
      const manifest = join(root, 'manifest.pb');
      // 워크플로우와 같은 방식으로 zip 컨테이너에서 protobuf manifest를 꺼낸다.
      writeFileSync(
        manifest,
        execFileSync('unzip', ['-p', artifact, 'base/manifest/AndroidManifest.xml'], {
          maxBuffer: 8 * 1024 * 1024,
        }),
      );
      const receipt = join(root, 'receipt.txt');
      const result = spawnSync(
        process.execPath,
        [
          VERIFY_CLI,
          '--kind',
          'android-app-bundle',
          '--binding',
          bindingPath,
          '--artifact',
          artifact,
          '--metadata',
          manifest,
          '--receipt',
          receipt,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.status === 0, shouldPass, `${fixture}: ${result.stderr}`);
      if (shouldPass) {
        assert.match(readFileSync(receipt, 'utf8'), /^artifact-kind: android-app-bundle$/mu);
        assert.match(
          readFileSync(receipt, 'utf8'),
          new RegExp(
            `^artifact-sha256: ${createHash('sha256').update(readFileSync(artifact)).digest('hex')}$`,
            'mu',
          ),
        );
      } else {
        assert.match(result.stderr, /artifact-provenance-mismatch/u, fixture);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('caller migration inventory는 남은 결함을 기계적으로 찾아낸다', () => {
  const root = mkdtempSync(join(tmpdir(), 'caller-migration-'));
  try {
    const write = (path, body) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
    };
    write(
      '.github/workflows/deploy-google-play.yml',
      [
        'name: Deploy Google Play',
        'on:',
        '  workflow_dispatch: {}',
        'jobs:',
        '  deploy:',
        `    uses: seorilabs/.github/.github/workflows/godot-deploy-google-play.yml@${'a'.repeat(40)}`,
        '    with:',
        '      track: internal',
        '      version_name: 1.2.3',
        '      runs_on: ubuntu-latest',
        '',
      ].join('\n'),
    );
    write(
      '.github/workflows/release-tag.yml',
      [
        'name: Release Tag',
        'on:',
        '  workflow_dispatch: {}',
        'jobs:',
        '  tag:',
        `    uses: seorilabs/.github/.github/workflows/release-tag.yml@${'b'.repeat(40)}`,
        '    with:',
        '      runs_on: seorilabs-rpi-arm64',
        '',
      ].join('\n'),
    );
    write(
      '.github/workflows/ait-build-only.yml',
      [
        'name: AIT Build-only',
        'on:',
        '  workflow_dispatch: {}',
        'jobs:',
        '  build:',
        '    uses: seorilabs/.github/.github/workflows/ait-build-only-v1.yml@main',
        '    with:',
        '      source_sha: deadbeef',
        '',
      ].join('\n'),
    );
    write('scripts/resolve-release-version.mjs', 'export default 1;\n');
    write('tools/upload_google_play_internal.py', 'import sys\n');
    write('scripts/build-ait.sh', '#!/usr/bin/env bash\nset -euo pipefail\n');
    write(
      'play-store/google-play.config.json',
      `${JSON.stringify({ release: { versionName: '1.2.3', versionCode: 1001002003 } }, null, 2)}\n`,
    );

    const inventory = collectCallerMigrationInventory(root, 'seorilabs/example-app');
    assert.equal(inventory.status, 'NEEDS_CHANGE');
    assert.deepEqual(
      inventory.callers.map(({ callerKind }) => callerKind).sort(),
      ['godot-deploy-google-play', 'release-tag', 'workflow-bundle-v5-ait-build-only'],
    );
    // 러너를 중앙에서 고정했으므로 남아 있는 runs_on은 workflow_call을 깨뜨리는 결함이다.
    const obsolete = inventory.findings.filter(({ id }) => id === 'obsolete-caller-input');
    assert.deepEqual(
      obsolete.map(({ path: found }) => found).sort(),
      ['.github/workflows/deploy-google-play.yml', '.github/workflows/release-tag.yml'],
    );
    const ids = new Set(inventory.findings.map(({ id }) => id));
    for (const expected of [
      'caller-ref-not-pinned',
      'forbidden-version-input',
      'forbidden-caller-input',
      'obsolete-caller-input',
      'repository-local-version-resolver',
      'market-config-version-authority',
      'upload-tool-missing-verified-path',
      'build-script-ignores-release-environment',
    ]) {
      assert.ok(ids.has(expected), expected);
    }
    // 비밀값이나 저장소 내용은 담지 않는다.
    assert.doesNotMatch(JSON.stringify(inventory), /deadbeef|import sys/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Xcode Cloud v5 envelope는 태그 하나를 version authority로 고정한다', async () => {
  const Ajv2020 = (await import('ajv/dist/2020.js')).default;
  const schema = JSON.parse(
    readFileSync(resolve(REPOSITORY_ROOT, 'contracts/xcode-cloud-run-v5.schema.json'), 'utf8'),
  );
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const envelope = JSON.parse(
    readFileSync(join(FIXTURES, 'xcode-cloud/release-run.json'), 'utf8'),
  );
  assert.equal(validate(envelope), true, JSON.stringify(validate.errors));

  // fixture의 version 값은 태그 파생값과 정확히 같아야 한다. authorityRevision/configRevision은
  // 계약 본문에서 파생되므로, 계약이 바뀌면 이 fixture도 다시 만들어야 한다(= 같은 태그를
  // 다른 계약 revision으로 재사용할 수 없다는 성질을 그대로 드러낸다).
  const authorityRevision = computeAuthorityRevision(readFileSync(AUTHORITY_CONTRACT, 'utf8'));
  const expected = createReleaseBinding({
    tag: envelope.release.tag,
    sourceSha: envelope.sourceSha,
    authorityRevision,
    configRevision: computeConfigRevision({
      calledWorkflowRepository: 'seorilabs/.github',
      calledWorkflowRef:
        `seorilabs/.github/.github/workflows/capacitor-build-android-cloud-v1.yml@${envelope.bundleSourceSha}`,
      calledWorkflowSha: envelope.bundleSourceSha,
      authorityRevision,
    }),
  });
  assert.equal(envelope.release.appleMarketingVersion, expected.appleMarketingVersion);
  assert.equal(envelope.release.appleBuildNumber, expected.appleBuildNumber);
  assert.equal(envelope.release.configRevision, expected.configRevision);
  assert.equal(envelope.release.authorityRevision, expected.authorityRevision);
  assert.equal(envelope.release.bindingDigest, bindingDigest(expected));
  // exact stable tag가 가리키는 commit만 build한다.
  assert.equal(envelope.sourceRef, `refs/tags/${envelope.release.tag}`);
  assert.equal(envelope.sourceReference.kind, 'TAG');
  assert.equal(envelope.sourceReference.commitSha, envelope.sourceSha);
  assert.equal(envelope.sourceReference.immutable, true);

  // branch ref, prerelease 태그, 이동 가능한 reference는 계약이 거부한다.
  for (const broken of [
    { ...envelope, sourceRef: 'refs/heads/main' },
    { ...envelope, sourceRef: 'refs/tags/v1.2.3-rc.1' },
    { ...envelope, sourceReference: { ...envelope.sourceReference, kind: 'BRANCH' } },
    { ...envelope, sourceReference: { ...envelope.sourceReference, immutable: false } },
    { ...envelope, release: { ...envelope.release, appleBuildNumber: 0 } },
  ]) {
    assert.equal(validate(broken), false, JSON.stringify(broken.sourceRef));
  }
});

test('Xcode Cloud build run readback이 태그 파생값과 다르면 fail-closed한다', async () => {
  const { verifyXcodeCloudRunReadbackV5, generateXcodeCloudRunV5 } = await import(
    '../packages/repo-contract/src/workflow-bundle-v5.mjs'
  );
  const envelope = JSON.parse(
    readFileSync(join(FIXTURES, 'xcode-cloud/release-run.json'), 'utf8'),
  );
  const good = {
    sourceCommitSha: envelope.requiredReadback.expectedSourceCommitSha,
    sourceReferenceId: envelope.requiredReadback.expectedSourceReferenceId,
    workflowId: envelope.requiredReadback.expectedWorkflowId,
    marketingVersion: envelope.requiredReadback.expectedMarketingVersion,
    buildNumber: envelope.requiredReadback.expectedBuildNumber,
  };
  assert.deepEqual(verifyXcodeCloudRunReadbackV5(envelope, good), { ok: true, diagnostics: [] });

  for (const [field, value, diagnostic] of [
    ['sourceCommitSha', 'f'.repeat(40), 'XCODE_RUN_SOURCE_COMMIT_MISMATCH'],
    ['sourceReferenceId', 'other-reference', 'XCODE_RUN_SOURCE_REFERENCE_MISMATCH'],
    ['workflowId', 'other-workflow', 'XCODE_RUN_WORKFLOW_MISMATCH'],
    ['marketingVersion', '9.9.9', 'XCODE_RUN_MARKETING_VERSION_MISMATCH'],
    ['buildNumber', 1, 'XCODE_RUN_BUILD_NUMBER_MISMATCH'],
  ]) {
    const result = verifyXcodeCloudRunReadbackV5(envelope, { ...good, [field]: value });
    assert.equal(result.ok, false, field);
    assert.deepEqual([...result.diagnostics], [diagnostic], field);
  }

  // 승인 binding 없이는 run envelope 자체를 만들 수 없다.
  await assert.rejects(
    generateXcodeCloudRunV5({}),
    /APPROVED_WORKFLOW_BUNDLE_BINDING_REQUIRED/u,
  );
});

test('build runtime readback 계약이 release tag ref와 AIT binding을 허용한다', async () => {
  const Ajv2020 = (await import('ajv/dist/2020.js')).default;
  const schema = JSON.parse(
    readFileSync(
      resolve(REPOSITORY_ROOT, 'contracts/workflow-bundle-v5-build-runtime-readback.schema.json'),
      'utf8',
    ),
  );
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

  const request = {
    repositoryId: '7001',
    fullName: 'seorilabs/runtime-canary',
    applicationSourceSha: SOURCE_SHA,
    eventSourceSha: SOURCE_SHA,
    workflowExecutionSha: BUNDLE_SHA,
    bindingTarget: 'ait',
    mode: 'RELEASE',
  };
  const response = releaseResponse(request, 'ait-granite');
  assert.equal(validate(response), true, JSON.stringify(validate.errors));

  // branch ref로 release 실행을 만들 수 없고, 알 수 없는 mode도 계약이 거부한다.
  assert.equal(
    validate({ ...response, manifest: { ...response.manifest, sourceRef: 'refs/heads/release' } }),
    false,
  );
  assert.equal(validate({ ...response, mode: 'SHADOW' }), false);

  // android release readback도 같은 계약을 통과한다.
  const androidResponse = releaseResponse(
    { ...request, bindingTarget: 'android' },
    'godot-android',
  );
  assert.equal(validate(androidResponse), true, JSON.stringify(validate.errors));
});
