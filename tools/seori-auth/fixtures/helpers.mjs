import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { NativeSecurityBoundary } from '../src/native-boundary.mjs';
import { DurableAuthState } from '../src/durable-state.mjs';
import {
  createTrustedJournalCheckpointControlPlane,
  JOURNAL_CHECKPOINT_CONTRACT,
  JOURNAL_CHECKPOINT_GENESIS_MAC,
} from '../src/journal-checkpoint.mjs';
import { PROVIDER_CONTROL_PLANE_CLIENT_SPIFFE_ID } from '../src/provider-grants.mjs';

export const COMMIT_SHA = '1'.repeat(40);
export const ARTIFACT_SHA = 'a'.repeat(64);
const NATIVE_HELPER = fileURLToPath(new URL('../.build/seori-auth-native', import.meta.url));
const checkpointFixtures = new Map();

export function makeJournalCheckpointFixture({
  journalId = 'test-journal',
  initialCheckpoint = {
    schemaVersion: 1,
    journalId,
    generation: 0,
    sequence: 0,
    headMac: JOURNAL_CHECKPOINT_GENESIS_MAC,
  },
  onRead,
  onCompareAndSwap,
} = {}) {
  const binding = Object.freeze({
    ...JOURNAL_CHECKPOINT_CONTRACT,
    journalId,
    authoritySpiffeId: PROVIDER_CONTROL_PLANE_CLIENT_SPIFFE_ID,
  });
  let current = structuredClone(initialCheckpoint);
  const operations = [];
  const fixture = {
    binding,
    operations,
    current: () => structuredClone(current),
    setCurrent(value) {
      current = structuredClone(value);
    },
  };
  fixture.controlPlane = createTrustedJournalCheckpointControlPlane({
    binding,
    async readCurrent(request) {
      operations.push({ operation: 'READ', request: structuredClone(request) });
      if (onRead) return onRead({ request, current: fixture.current(), fixture });
      return fixture.current();
    },
    async compareAndSwap(request) {
      operations.push({ operation: 'CAS', request: structuredClone(request) });
      if (onCompareAndSwap) {
        return onCompareAndSwap({ request, current: fixture.current(), fixture });
      }
      if (
        current.generation === request.next.generation &&
        current.sequence === request.next.sequence &&
        current.headMac === request.next.headMac
      ) return { outcome: 'COMMITTED' };
      if (
        current.generation !== request.expected.generation ||
        current.sequence !== request.expected.sequence ||
        current.headMac !== request.expected.headMac
      ) return { outcome: 'CONFLICT' };
      current = structuredClone(request.next);
      return { outcome: 'COMMITTED' };
    },
  });
  return fixture;
}

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
  let journalCheckpointBinding = options.journalCheckpointBinding;
  let journalCheckpointControlPlane = options.journalCheckpointControlPlane;
  if (
    Buffer.isBuffer(options.journalMacKey) &&
    journalCheckpointBinding === undefined &&
    journalCheckpointControlPlane === undefined
  ) {
    const key = resolve(options.directory);
    let fixture = checkpointFixtures.get(key);
    if (!fixture) {
      fixture = makeJournalCheckpointFixture();
      checkpointFixtures.set(key, fixture);
    }
    ({ binding: journalCheckpointBinding, controlPlane: journalCheckpointControlPlane } = fixture);
  }
  return DurableAuthState.open({
    ...options,
    journalCheckpointBinding,
    journalCheckpointControlPlane,
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
