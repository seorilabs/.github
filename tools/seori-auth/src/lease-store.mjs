import { randomUUID } from 'node:crypto';

import { fail } from './errors.mjs';
import { equalBinding, normalizeLeaseRequest } from './validation.mjs';

export const LEASE_TTL_MS = 5 * 60 * 1_000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;

export class LeaseStore {
  #clock;
  #leases = new Map();

  constructor({ clock = () => Date.now() } = {}) {
    this.#clock = clock;
  }

  issue({ request, ruleId, idempotencyKey }) {
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      fail('invalid_request', 'idempotencyKey must be a log-safe public identifier');
    }
    const sameKey = [...this.#leases.values()].find((candidate) => candidate.idempotencyKey === idempotencyKey);
    if (sameKey) {
      if (!equalBinding(sameKey.binding, request) || sameKey.ruleId !== ruleId) {
        fail('idempotency_conflict', 'idempotency key is already bound to another approval request');
      }
      return this.#view(sameKey);
    }
    if ([...this.#leases.values()].some(
      (candidate) => candidate.binding.approval.id === request.approval.id,
    )) {
      fail('approval_already_used', 'approval maximum use count has already been reserved');
    }
    const now = this.#clock();
    const lease = {
      id: randomUUID(),
      issuedAt: now,
      expiresAt: now + LEASE_TTL_MS,
      state: 'issued',
      ruleId,
      binding: request,
      idempotencyKey,
    };
    this.#leases.set(lease.id, lease);

    return this.#view(lease);
  }

  #view(lease) {
    return Object.freeze({
      leaseId: lease.id,
      issuedAt: new Date(lease.issuedAt).toISOString(),
      expiresAt: new Date(lease.expiresAt).toISOString(),
      maxUses: 1,
      ruleId: lease.ruleId,
      adapterId: lease.binding.adapterId,
      secretExportable: false,
    });
  }

  consume({ leaseId, context, currentCredentialGeneration, currentPolicyGeneration }) {
    const lease = this.#leases.get(leaseId);
    if (!lease) {
      fail('lease_not_found', 'lease does not exist');
    }

    const now = this.#clock();
    if (now >= lease.expiresAt) {
      lease.state = 'expired';
      fail('lease_expired', 'lease has expired');
    }
    if (lease.state !== 'issued') {
      fail('lease_already_used', 'lease is single-use and has already been consumed');
    }

    const normalizedContext = normalizeLeaseRequest(context);
    if (!equalBinding(lease.binding, normalizedContext)) {
      fail('lease_binding_mismatch', 'execution context does not exactly match the issued lease');
    }
    if (currentPolicyGeneration !== lease.binding.policyGeneration) {
      fail('stale_policy_generation', 'policy generation changed after lease issuance');
    }
    if (currentCredentialGeneration !== lease.binding.credentialGeneration) {
      fail('stale_credential_generation', 'credential generation changed after lease issuance');
    }

    // Consume before loading a secret or starting a child so failures cannot replay the capability.
    lease.state = 'consumed';
    lease.consumedAt = now;
    return Object.freeze({
      id: lease.id,
      ruleId: lease.ruleId,
      binding: lease.binding,
      consumedAt: lease.consumedAt,
    });
  }
}
