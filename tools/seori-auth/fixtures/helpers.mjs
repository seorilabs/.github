export const COMMIT_SHA = '1'.repeat(40);
export const ARTIFACT_SHA = 'a'.repeat(64);

export function makePolicy(ruleOverrides = {}, policyOverrides = {}) {
  return {
    schemaVersion: 1,
    generation: 7,
    rules: [
      {
        id: 'private-upload',
        enabled: true,
        credentialRefs: ['shared/apps-in-toss/operator'],
        subjects: ['k8s:release-workers:worker-a'],
        repositories: ['seorilabs/example-app'],
        runIds: ['github:123'],
        commitShas: [COMMIT_SHA],
        providers: ['apps-in-toss'],
        origins: ['https://apps-in-toss-api.toss.im'],
        redirectOrigins: ['https://business.toss.im'],
        capabilities: ['ait.bundle.upload.private'],
        resources: [{ kind: 'miniapp', id: 'example-app', environment: 'private' }],
        adapters: ['test-adapter'],
        accountKinds: ['dedicated_bot'],
        requiresArtifact: true,
        artifactSha256s: [ARTIFACT_SHA],
        allowTotp: false,
        ...ruleOverrides,
      },
    ],
    ...policyOverrides,
  };
}

export function makeRequest(overrides = {}) {
  return {
    credentialRef: 'shared/apps-in-toss/operator',
    credentialGeneration: 3,
    policyGeneration: 7,
    subject: 'k8s:release-workers:worker-a',
    runId: 'github:123',
    repository: 'seorilabs/example-app',
    commitSha: COMMIT_SHA,
    provider: 'apps-in-toss',
    origin: 'https://apps-in-toss-api.toss.im',
    redirectOrigins: ['https://business.toss.im'],
    capability: 'ait.bundle.upload.private',
    resource: { kind: 'miniapp', id: 'example-app', environment: 'private' },
    artifact: { sha256: ARTIFACT_SHA, sizeBytes: 1024 },
    adapterId: 'test-adapter',
    accountKind: 'dedicated_bot',
    authFactors: ['api_key'],
    ...overrides,
  };
}
