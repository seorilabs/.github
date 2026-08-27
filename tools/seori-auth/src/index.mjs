export { TrustedAdapterRegistry } from './adapters.mjs';
export { SeoriAuthError } from './errors.mjs';
export { executeLease } from './executor.mjs';
export { LEASE_TTL_MS, LeaseStore } from './lease-store.mjs';
export { PolicyEngine } from './policy.mjs';
export { classifyReauth, REAUTH_CLASSIFICATIONS } from './reauth.mjs';
export { normalizeHttpsOrigin, normalizeLeaseRequest } from './validation.mjs';

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

  issueLease(request) {
    return this.#leaseStore.issue(this.#policy.authorize(request));
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
