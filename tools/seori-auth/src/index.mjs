export { TrustedAdapterRegistry } from './adapters.mjs';
export { CanonicalAccountRegistry } from './accounts.mjs';
export { EncryptedBrowserVault } from './browser-vault.mjs';
export { BrowserLoginBoundary } from './browser-login.mjs';
export {
  AgentRelayDaemon,
  agentRelayProjectionDigest,
  assertAgentRelayProjection,
  assertAgentRelayClientSocket,
  assertAgentRelayPublicJson,
  createAgentMtlsForwarder,
  executeAgentRelayClientRequest,
  readImmutableAgentRelayConfig,
} from './agent-relay.mjs';
export { runAgentRelayLifecycle } from './agent-relay-lifecycle.mjs';
export { SeoriAuthError } from './errors.mjs';
export {
  computeAuthStrategyEvidenceKey,
  DurableAuthState,
  HUMAN_REAUTH_REQUIRED,
  normalizeExecutionBinding,
  normalizePublicIdentity,
} from './durable-state.mjs';
export {
  executeConsumedLease,
  executeConsumedProviderLease,
  executeLease,
  executeSecretAdapter,
} from './executor.mjs';
export { FactorHttpApplication } from './factor-daemon.mjs';
export {
  MacOSKeychainPasswordLoader,
  RemoteTotpSignerClient,
  SecretManagerPasswordLoader,
} from './factor-services.mjs';
export {
  createMtlsEgressProxy,
  GoogleSecretManagerExecutionStore,
  GoogleWorkloadIdentityTokenProvider,
  NativeSecretManagerExecutionStore,
} from './google-secret-manager.mjs';
export { LEASE_TTL_MS, LeaseStore } from './lease-store.mjs';
export {
  buildJournalCheckpointTransition,
  createTrustedJournalCheckpointControlPlane,
  JOURNAL_CHECKPOINT_CONTRACT,
  JOURNAL_CHECKPOINT_GENESIS_MAC,
  normalizeJournalCheckpoint,
  normalizeJournalCheckpointBinding,
  requireTrustedJournalCheckpointControlPlane,
} from './journal-checkpoint.mjs';
export {
  assertJournalCheckpointClientIdentity,
  checkJournalCheckpointAuthorityIdentity,
  createBackofficeJournalCheckpointClient,
  createJournalCheckpointMtlsTransport,
  createProductionJournalCheckpointClient,
  JOURNAL_CHECKPOINT_AUTHORITY,
} from './journal-checkpoint-authority.mjs';
export { LocalAuthDaemon } from './local-daemon.mjs';
export { MtlsAuthDaemon } from './mtls-daemon.mjs';
export { MtlsRunAttestor, requireExactMtlsPeer } from './mtls-identity.mjs';
export { NativeSecurityBoundary } from './native-boundary.mjs';
export { PolicyEngine } from './policy.mjs';
export { classifyReauth, REAUTH_CLASSIFICATIONS } from './reauth.mjs';
export {
  assertProviderGrantExpectation,
  canonicalPublicJson,
  normalizeProviderAdapterResult,
  normalizeProviderCommandEnvelope,
  normalizeProviderGrantExpectation,
  normalizeProviderGrantRegistration,
  normalizeProviderObservation,
  providerGrantActionClass,
  providerGrantLeaseRequest,
  providerGrantRequiresPerRunApproval,
  PROVIDER_CONTROL_PLANE_CLIENT_SPIFFE_ID,
  PROVIDER_CONTROL_PLANE_ENDPOINT_SCOPE,
  PROVIDER_GRANT_MAX_TTL_MS,
  publicJsonDigest,
} from './provider-grants.mjs';
export { SecretManagerTotpSigner } from './totp-signer.mjs';
export { isLogicalCredentialRef, normalizeHttpsOrigin, normalizeLeaseRequest } from './validation.mjs';

import { TrustedAdapterRegistry } from './adapters.mjs';
import { executeLease } from './executor.mjs';
import { LeaseStore } from './lease-store.mjs';
import { PolicyEngine } from './policy.mjs';

export class SeoriAuthBroker {
  #policy;
  #registry;
  #leaseStore;
  #loadSecret;
  #onAudit;

  constructor({ policy, adapters, loadSecret, clock, onAudit }) {
    if (typeof loadSecret !== 'function') {
      throw new TypeError('loadSecret must be a trusted in-process function');
    }
    this.#policy = new PolicyEngine(policy);
    this.#registry = new TrustedAdapterRegistry(adapters);
    this.#leaseStore = new LeaseStore({ clock });
    this.#loadSecret = loadSecret;
    this.#onAudit = onAudit;
  }

  issueLease(request, { idempotencyKey } = {}) {
    const authorized = this.#policy.authorize(request);
    return this.#leaseStore.issue({ ...authorized, idempotencyKey });
  }

  execute({ leaseId, context, currentCredentialGeneration }) {
    return executeLease({
      leaseStore: this.#leaseStore,
      registry: this.#registry,
      leaseId,
      context,
      currentCredentialGeneration,
      currentPolicyGeneration: this.#policy.generation,
      loadSecret: this.#loadSecret,
      onAudit: this.#onAudit,
    });
  }
}
