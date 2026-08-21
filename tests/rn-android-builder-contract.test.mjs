import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(path, 'utf8');

test('RN Android builder pins pnpm through build and verification substitutions', async () => {
  const [build, verify, readme] = await Promise.all([
    read('builders/rn-android/build.cloudbuild.yaml'),
    read('builders/rn-android/verify.cloudbuild.yaml'),
    read('builders/README.md'),
  ]);

  assert.match(build, /_PNPM_VERSION: "11\.3\.0"/);
  assert.match(build, /PNPM_VERSION=\$\{_PNPM_VERSION\}/);
  assert.match(build, /ANDROID_CMAKE=\$\{_ANDROID_CMAKE\}/);
  assert.match(verify, /EXPECTED_PNPM=\$\{_PNPM_VERSION\}/);
  assert.match(verify, /pnpm --version\)" = "\$\$EXPECTED_PNPM"/);
  assert.match(verify, /cmake\/\$\$EXPECTED_ANDROID_CMAKE\/bin\/cmake/);
  assert.match(
    readme,
    /_PNPM_VERSION=11\.14\.0[^\n]*_ANDROID_CMAKE=3\.22\.1[^\n]*_IMAGE_TAG=node24-pnpm11\.14-jdk21-rn085/,
  );
});
