import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = '.github/workflows/rn-build-android.yml';
const workflow = await readFile(workflowPath, 'utf8');

test('stable tag contract builds and uploads a signed AAB artifact', () => {
  assert.match(workflow, /release_tag:[\s\S]*?type: string/);
  assert.match(workflow, /ref: \$\{\{ inputs\.release_tag \|\| github\.ref \}\}/);
  assert.match(workflow, /checkout "\$tag"/);
  assert.match(workflow, /gradlew :app:bundleRelease/);
  assert.match(workflow, /name: Upload signed AAB artifact/);
  assert.match(workflow, /path: \$\{\{ steps\.android\.outputs\.aab_path \}\}/);
  assert.match(workflow, /signing_properties_file:[\s\S]*?default: "key\.properties"/);
  assert.match(
    workflow,
    /SIGNING_PROPERTIES_FILE: \$\{\{ inputs\.signing_properties_file \}\}/,
  );
  assert.match(workflow, /properties_path="\$ANDROID_DIR\/\$SIGNING_PROPERTIES_FILE"/);
});

test('Gradle dependencies are cached and callers can narrow release ABIs safely', () => {
  assert.match(
    workflow,
    /react_native_architectures:[\s\S]*?default: ""[\s\S]*?type: string/,
  );
  assert.match(workflow, /uses: actions\/setup-java@v5[\s\S]*?cache: gradle/);
  assert.match(
    workflow,
    /REACT_NATIVE_ARCHITECTURES: \$\{\{ inputs\.react_native_architectures \}\}/,
  );
  assert.match(
    workflow,
    /gradle_args\+=\("-PreactNativeArchitectures=\$REACT_NATIVE_ARCHITECTURES"\)/,
  );
  assert.match(workflow, /gradlew :app:bundleRelease "\$\{gradle_args\[@\]\}"/);
});

test('build-only workflow has no Google Play deployment authority or command', () => {
  assert.match(workflow, /permissions:\n  contents: read\n/);
  assert.doesNotMatch(workflow, /id-token:|environment:\s*google-play/);
  assert.doesNotMatch(
    workflow,
    /google-github-actions|workload_identity|upload-google-play|Upload AAB to Google Play/,
  );
});

test('signed AAB artifact uses x64 Linux and three-day retention', () => {
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /retention-days: 3/);
  assert.doesNotMatch(workflow, /runs-on: seorilabs-rpi-arm64/);
});
