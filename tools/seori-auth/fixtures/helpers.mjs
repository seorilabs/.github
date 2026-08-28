import { fileURLToPath } from 'node:url';

import { NativeSecurityBoundary } from '../src/native-boundary.mjs';
import { DurableAuthState } from '../src/durable-state.mjs';

export const COMMIT_SHA = '1'.repeat(40);
export const ARTIFACT_SHA = 'a'.repeat(64);
const NATIVE_HELPER = fileURLToPath(new URL('../.build/seori-auth-native', import.meta.url));

export async function makeNativeLockProvider() {
  const boundary = await NativeSecurityBoundary.open({
    helperPath: NATIVE_HELPER,
    resolvePrincipal: async () => ({
      subject: 'fixture',
      runId: 'fixture',
      repository: 'seorilabs/fixture',
      workerId: 'fixture',
    }),
  });
  return boundary.lockProvider();
}

export async function makeNativeLauncher() {
  const boundary = await NativeSecurityBoundary.open({
    helperPath: NATIVE_HELPER,
    resolvePrincipal: async () => ({
      subject: 'fixture',
      runId: 'fixture',
      repository: 'seorilabs/fixture',
      workerId: 'fixture',
    }),
  });
  return boundary.launcher();
}

export async function makeNativeBrowserAdapter({
  execute,
  terminate = async () => ({ terminated: true }),
  timeoutMs,
  terminationTimeoutMs,
}) {
  const boundary = await NativeSecurityBoundary.open({
    helperPath: NATIVE_HELPER,
    resolvePrincipal: async () => ({
      subject: 'fixture',
      runId: 'fixture',
      repository: 'seorilabs/fixture',
      workerId: 'fixture',
    }),
  });
  return boundary.browserAdapter({ execute, terminate, timeoutMs, terminationTimeoutMs });
}

export async function openDurableAuthState(options) {
  return DurableAuthState.open({
    ...options,
    writerLockProvider: options.writerLockProvider ?? await makeNativeLockProvider(),
  });
}

export function makePolicy(ruleOverrides = {}, policyOverrides = {}) {
  return {
    schemaVersion: 1,
    generation: 7,
    accounts: [
      {
        provider: 'apps-in-toss',
        accountId: 'operator-account',
        kind: 'dedicated_bot',
        credentialRefs: [
          'shared/apps-in-toss/operator',
          'shared/apps-in-toss/bot-password',
          'shared/apps-in-toss/bot-totp',
        ],
      },
    ],
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
        accountIds: ['operator-account'],
        actionClass: 'internal_upload',
        authStrategies: [['api_key']],
        requiresArtifact: true,
        artifactSha256s: [ARTIFACT_SHA],
        allowTotp: false,
        approvals: [{
          id: 'approval-123',
          mode: 'preapproved',
          expiresAt: '2099-01-01T00:00:00.000Z',
          maxUses: 1,
        }],
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
    accountId: 'operator-account',
    authFactors: ['api_key'],
    approval: {
      id: 'approval-123',
      mode: 'preapproved',
      expiresAt: '2099-01-01T00:00:00.000Z',
      maxUses: 1,
    },
    ...overrides,
  };
}
