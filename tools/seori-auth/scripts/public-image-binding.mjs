import { createHash } from 'node:crypto';

export const IMAGE_REPOSITORY = 'ghcr.io/seorilabs/seori-auth';
export const PACKAGES_READER_CREDENTIAL_ID = 'shared/github/packages-reader';
export const PACKAGES_READER_SECRET_NAME = 'seori-auth-ghcr-pull';
export const EXPECTED_CANARY_OUTPUT = '{"state":"CANARY_OK","secretExposed":false}\n';
export const EXPECTED_CANARY_OUTPUT_SHA256 = createHash('sha256')
  .update(EXPECTED_CANARY_OUTPUT)
  .digest('hex');
export const APPROVED_IMAGE_BINDING = Object.freeze({
  image: `${IMAGE_REPOSITORY}@sha256:2f53e39b74f872d74ab3fa8d3a6bce024272acbd8a52c9ee0c6685eac1224658`,
  imageProvenance: Object.freeze({
    repository: 'seorilabs/.github',
    sourceSha: '9f6f1efa3b0d89f49a395af55847e957d3aeddde',
    workflow: '.github/workflows/seori-auth-image.yml',
    runId: 33531634882,
    platform: 'linux/arm64',
    imageDigest: 'sha256:2f53e39b74f872d74ab3fa8d3a6bce024272acbd8a52c9ee0c6685eac1224658',
  }),
});

const IMAGE = /^ghcr\.io\/seorilabs\/seori-auth@sha256:[a-f0-9]{64}$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SOURCE_SHA = /^[a-f0-9]{40}$/;

export function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonical(child)]),
  );
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalSha256(value) {
  return sha256(JSON.stringify(canonical(value)));
}

export function validateImageProvenance(image, value, fail) {
  if (!IMAGE.test(image ?? '')) fail('image must be the immutable Seori Auth GHCR digest');
  if (!exactKeys(value, [
    'imageDigest', 'platform', 'repository', 'runId', 'sourceSha', 'workflow',
  ])) fail('image provenance fields are invalid');
  if (
    !SOURCE_SHA.test(value.sourceSha ?? '') ||
    !Number.isSafeInteger(value.runId) ||
    value.runId < 1 ||
    !SHA256_DIGEST.test(value.imageDigest ?? '') ||
    image !== APPROVED_IMAGE_BINDING.image ||
    canonicalSha256(value) !== canonicalSha256(APPROVED_IMAGE_BINDING.imageProvenance)
  ) fail('image provenance does not match the code-approved immutable binding');
  return Object.freeze({ ...value });
}

export function validateRegistry(value, fail) {
  if (exactKeys(value, ['mode', 'visibilityStatus']) && value.mode === 'PUBLIC') {
    if (value.visibilityStatus !== 'VERIFIED_PUBLIC') {
      fail('public GHCR visibility is not verified');
    }
    return Object.freeze({ mode: value.mode, visibilityStatus: value.visibilityStatus });
  }
  if (
    exactKeys(value, [
      'catalogStatus', 'credentialId', 'imagePullSecretName', 'kubernetesStatus', 'mode',
    ]) &&
    value.mode === 'PACKAGES_READER'
  ) {
    if (
      value.credentialId !== PACKAGES_READER_CREDENTIAL_ID ||
      value.imagePullSecretName !== PACKAGES_READER_SECRET_NAME ||
      value.catalogStatus !== 'ACTIVE' ||
      value.kubernetesStatus !== 'VERIFIED'
    ) fail('packages reader binding is not canonical and verified');
    return Object.freeze({ ...value });
  }
  fail('registry mode must be explicit PUBLIC or PACKAGES_READER');
}

export function imagePullSecrets(registry) {
  return registry.mode === 'PACKAGES_READER'
    ? Object.freeze([{ name: registry.imagePullSecretName }])
    : undefined;
}
