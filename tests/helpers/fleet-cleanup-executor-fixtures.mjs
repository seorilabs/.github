import { Buffer } from "node:buffer";
import {
  createHash,
  generateKeyPairSync,
  sign as signEd25519,
} from "node:crypto";

import {
  createTrustedFleetCleanupGitHubAdapter,
  createTrustedFleetCleanupStateStore,
} from "../../packages/repo-contract/src/trusted-cleanup-executor.mjs";
import {
  createFleetMigrationReadOnlyCollector,
} from "../../packages/repo-contract/src/fleet-migration-collector.mjs";
import {
  computeFleetEvidenceDigest,
  createFleetMigrationPlan,
  loadTrustedFleetMigrationInventoryBinding,
} from "../../packages/repo-contract/src/fleet-migration.mjs";
import {
  createFleetMigrationInventoryIssuer,
  fleetMigrationInventoryIssuerContract,
} from "../../packages/repo-contract/src/trusted-inventory-issuer.mjs";
import {
  INSTALLATION_ID,
  ORGANIZATION_ID,
  canonicalJson,
  digest,
  makeCollectorFixture,
  sha,
} from "./fleet-migration-collector-fixtures.mjs";

const REQUEST = Object.freeze({
  deliveryId: "fleet-cleanup-collector-delivery-0001",
  inventoryId: "fleet-cleanup-inventory-0001",
  mode: "READ_ONLY_SHADOW",
  requestedRunId: "fleet-cleanup-collector-run-0001",
});

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function gitBlobSha(value) {
  const content = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return createHash("sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");
}

function publicKeyFingerprint(publicKey) {
  return sha256(publicKey.export({ format: "der", type: "spki" }));
}

function withEvidence(value) {
  const result = structuredClone(value);
  result.evidenceDigest = computeFleetEvidenceDigest(result);
  return result;
}

function currentCapability(capability, nowMs) {
  const value = structuredClone(capability);
  value.revision = "github-app-capability-cleanup-current-0002";
  value.observedAt = new Date(nowMs).toISOString();
  value.app.readbackId = "github-app-cleanup-readback-current-0002";
  value.installation.readbackId =
    "github-installation-cleanup-readback-current-0002";
  value.eventAcceptance.deliveryId =
    "github-delivery-cleanup-current-0002";
  value.eventAcceptance.acceptedAt = new Date(nowMs - 1_000).toISOString();
  value.eventAcceptance.appReadbackId = value.app.readbackId;
  value.eventAcceptance.installationReadbackId =
    value.installation.readbackId;
  value.eventAcceptance.evidenceDigest = computeFleetEvidenceDigest(
    value.eventAcceptance,
  );
  value.evidenceDigest = computeFleetEvidenceDigest(value);
  return value;
}

function signingKeyReadback(keys, nowMs) {
  return withEvidence({
    contract: "seorilabs-fleet-signing-key-public-identity-v1",
    readbackId: "cleanup-signing-key-readback-0001",
    revision: "cleanup-signing-key-revision-0001",
    observedAt: new Date(nowMs - 20_000).toISOString(),
    algorithm: "Ed25519",
    credentialId: "shared/platform/fleet-release-approval-signing",
    keyId: "platform-fleet-release-20260829-5458c56b",
    keyPurpose: "FLEET_MIGRATION_INVENTORY_ATTESTATION",
    keyFingerprint: publicKeyFingerprint(keys.publicKey),
    state: "ACTIVE",
  });
}

export async function makeAuthoritativeCleanupFixture({
  count = 38,
  nowMs = Date.now(),
} = {}) {
  const fixture = makeCollectorFixture({
    count,
    nowMs,
    verifiedCapability: true,
  });
  const collection = await createFleetMigrationReadOnlyCollector(
    fixture.configuration,
  ).collect({
    ...REQUEST,
    mode: count === 38 ? "READ_ONLY_SHADOW" : "FIXTURE",
  });
  if (count !== 38) {
    return {
      fixture,
      collection,
      plan: createFleetMigrationPlan(collection.inventory, {
        now: new Date(nowMs).toISOString(),
      }),
    };
  }
  const keys = generateKeyPairSync("ed25519");
  const issuedAtMs = nowMs + 60_000;
  const issuer = createFleetMigrationInventoryIssuer({
    clock: () => issuedAtMs,
    inventoryPublicKey: keys.publicKey,
    readGitHubAppCapability: async () =>
      currentCapability(fixture.capability, issuedAtMs),
    readOccurrence: fixture.durable.read,
    readSigningKeyPublicIdentity: async () =>
      signingKeyReadback(keys, issuedAtMs),
    signInventoryPayload: async (request) => ({
      algorithm: "Ed25519",
      credentialId: request.credentialId,
      keyFingerprint: publicKeyFingerprint(keys.publicKey),
      keyId: request.keyId,
      value: signEd25519(null, request.payload, keys.privateKey).toString(
        "base64url",
      ),
    }),
  });
  const issuance = await issuer.issueAuthoritative(collection);
  const executionNowMs = issuedAtMs + 30_000;
  const trustedInventoryBinding = loadTrustedFleetMigrationInventoryBinding({
    inventory: issuance.inventory,
    trustedInventoryKeys: {
      [fleetMigrationInventoryIssuerContract.keyId]: keys.publicKey,
    },
    now: new Date(executionNowMs).toISOString(),
  });
  const plan = createFleetMigrationPlan(issuance.inventory, {
    trustedInventoryBinding,
    now: new Date(executionNowMs).toISOString(),
  });
  return {
    fixture,
    collection,
    keys,
    issuance,
    plan,
    executionNowMs,
  };
}

function stableChangesFromRequest(request) {
  return request.mutations.map((mutation) => ({
    operation: mutation.operation,
    path: mutation.path,
    expectedMode: mutation.expectedMode,
    expectedBlobSha: mutation.expectedBlobSha,
    expectedContentDigest: mutation.expectedContentDigest,
    replacementDigest: mutation.replacementDigest,
    replacementBindingDigest: mutation.replacementBindingDigest,
    resultBlobSha:
      mutation.content === null ? null : gitBlobSha(mutation.content),
  }));
}

function absentReadback(kind, request, nowMs, state = "ABSENT") {
  return withEvidence({
    contract: "seorilabs-fleet-cleanup-mutation-readback-v1",
    kind,
    state,
    readbackId: `cleanup-${kind.toLowerCase()}-readback-absent-0001`,
    observedAt: new Date(nowMs).toISOString(),
    repositoryId: request.repositoryId,
    fullName: request.fullName,
    operationId: request.operationId,
  });
}

function cloneWithCurrentEvidence(value, nowMs, suffix) {
  const result = structuredClone(value);
  result.readbackId = `${result.readbackId}-${suffix}`;
  result.observedAt = new Date(nowMs).toISOString();
  result.evidenceDigest = computeFleetEvidenceDigest(result);
  return result;
}

export function makeCleanupGitHubProvider({
  plan,
  issuance,
  repositoryId,
  now,
  fault = {},
} = {}) {
  const repository = plan.repositories.find(
    (item) => item.repositoryId === repositoryId,
  );
  const inventoryRepository = issuance.inventory.repositories.find(
    ({ repository: item }) => item.id === repositoryId,
  );
  const state = {
    commit: null,
    ref: null,
    pullRequest: null,
    calls: {
      createCommit: 0,
      createRef: 0,
      createPullRequest: 0,
      readMutationGuard: 0,
    },
    crashRemaining: new Set(fault.crashAfterPersist ?? []),
    failBeforePersistRemaining: new Set(fault.failBeforePersist ?? []),
    unknownReadbacks: new Set(fault.unknownReadbacks ?? []),
  };
  const approvalApprovedAt = now() - 10_000;
  const approvalExpiresAt =
    now() + (fault.approvalTtlMs ?? 10 * 60_000);
  if (fault.existingPullRequest) {
    state.pullRequest = {
      foreign: true,
      number: 77,
      state: "OPEN",
      isDraft: false,
      baseRef: repository.sourceRef.slice("refs/heads/".length),
      headRef: "seori/other-autonomous-pr",
      headSha: sha("foreign-pr-head"),
      operationId: digest("foreign-pr-operation"),
    };
  }

  const provider = {
    async readMutationGuard(request) {
      state.calls.readMutationGuard += 1;
      fault.beforeMutationGuard?.({
        callCount: state.calls.readMutationGuard,
      });
      const readStartedAt = now();
      const openPullRequests = [];
      if (state.pullRequest !== null) {
        openPullRequests.push({
          number: state.pullRequest.number,
          state: state.pullRequest.state,
          isDraft: state.pullRequest.isDraft,
          baseRef: state.pullRequest.baseRef,
          headRef: state.pullRequest.headRef,
          headSha: state.pullRequest.headSha,
          operationId: state.pullRequest.operationId,
        });
      }
      const readback = withEvidence({
        contract: "seorilabs-fleet-cleanup-mutation-guard-v1",
        readbackId: `cleanup-mutation-guard-${String(
          state.calls.readMutationGuard,
        ).padStart(4, "0")}`,
        observedAt: new Date(readStartedAt).toISOString(),
        organizationId: request.organizationId,
        installationId: request.installationId,
        repositoryId: fault.crossRepository
          ? String(Number(request.repositoryId) + 1)
          : request.repositoryId,
        fullName: fault.crossRepository
          ? "seorilabs/cross-repository"
          : request.fullName,
        defaultRef: request.defaultRef,
        defaultHeadSha: fault.headDrift
          ? sha("drifted-default-head")
          : request.sourceSha,
        treeSha: request.treeSha,
        archived: false,
        fork: false,
        openAutonomousReadyPullRequestCount: openPullRequests.length,
        openAutonomousReadyPullRequests: openPullRequests,
        issue: {
          number: request.issueNumber,
          state: "OPEN",
          labels: [...(fault.labels ?? ["autopilot", "p1"])].sort(),
          approvalState: fault.approvalDenied ? "DENIED" : "APPROVED",
          approvalId: "fleet-cleanup-runtime-approval-0001",
          approvalScopeDigest: request.approvalScopeDigest,
          approvedAt: new Date(approvalApprovedAt).toISOString(),
          expiresAt: new Date(approvalExpiresAt).toISOString(),
        },
        blobs: structuredClone(request.expectedBlobs).map((blob, index) =>
          fault.blobDrift && index === 0
            ? { ...blob, contentDigest: digest("drifted-blob-content") }
            : blob,
        ),
      });
      fault.afterMutationGuard?.({
        callCount: state.calls.readMutationGuard,
      });
      return readback;
    },
    async readReplacementBlob(request) {
      const content = Buffer.from(
        fault.replacementTamper
          ? "tampered workflow replacement"
          : `workflow-replacement:${request.repositoryId}:${request.path}`,
        "utf8",
      );
      return {
        contract: "seorilabs-fleet-cleanup-replacement-readback-v1",
        readbackId: `cleanup-replacement-readback-${sha(request.path).slice(0, 16)}`,
        observedAt: new Date(now()).toISOString(),
        repositoryId: request.repositoryId,
        fullName: request.fullName,
        sourceSha: request.sourceSha,
        path: request.path,
        planDigest: request.planDigest,
        replacementDigest: request.replacementDigest,
        replacementBindingDigest: request.replacementBindingDigest,
        content,
      };
    },
    async readCommit(request) {
      if (state.commit !== null) {
        return cloneWithCurrentEvidence(state.commit, now(), "current");
      }
      return absentReadback(
        "CREATE_COMMIT",
        request,
        now(),
        state.unknownReadbacks.has("CREATE_COMMIT") ? "UNKNOWN" : "ABSENT",
      );
    },
    async createCommit(request) {
      state.calls.createCommit += 1;
      if (state.failBeforePersistRemaining.delete("CREATE_COMMIT")) {
        state.unknownReadbacks.add("CREATE_COMMIT");
        throw new Error("transport failed before provider result");
      }
      const changes = stableChangesFromRequest(request);
      state.commit = withEvidence({
        contract: "seorilabs-fleet-cleanup-mutation-readback-v1",
        kind: "CREATE_COMMIT",
        state: "FOUND",
        readbackId: "cleanup-create-commit-readback-0001",
        observedAt: new Date(now()).toISOString(),
        repositoryId: request.repositoryId,
        fullName: request.fullName,
        operationId: request.operationId,
        parentSha: request.parentSha,
        sourceTreeSha: request.sourceTreeSha,
        commitSha: sha(`cleanup-commit:${request.operationId}`),
        treeSha: sha(`cleanup-tree:${request.mutationsDigest}`),
        mutationsDigest: request.mutationsDigest,
        changes,
      });
      if (state.crashRemaining.delete("CREATE_COMMIT")) {
        throw new Error("transport uncertain after commit");
      }
    },
    async readRef(request) {
      if (state.ref !== null) {
        return cloneWithCurrentEvidence(state.ref, now(), "current");
      }
      return absentReadback(
        "CREATE_REF",
        request,
        now(),
        state.unknownReadbacks.has("CREATE_REF") ? "UNKNOWN" : "ABSENT",
      );
    },
    async createRef(request) {
      state.calls.createRef += 1;
      if (state.failBeforePersistRemaining.delete("CREATE_REF")) {
        state.unknownReadbacks.add("CREATE_REF");
        throw new Error("transport failed before provider result");
      }
      state.ref = withEvidence({
        contract: "seorilabs-fleet-cleanup-mutation-readback-v1",
        kind: "CREATE_REF",
        state: "FOUND",
        readbackId: "cleanup-create-ref-readback-0001",
        observedAt: new Date(now()).toISOString(),
        repositoryId: request.repositoryId,
        fullName: request.fullName,
        operationId: request.operationId,
        ref: request.ref,
        commitSha: request.commitSha,
      });
      if (state.crashRemaining.delete("CREATE_REF")) {
        throw new Error("transport uncertain after ref");
      }
    },
    async readPullRequest(request) {
      if (state.pullRequest !== null && !state.pullRequest.foreign) {
        const readback = cloneWithCurrentEvidence(
          state.pullRequest,
          now(),
          "current",
        );
        if (fault.dropPullRequestAfterReadback) state.pullRequest = null;
        return readback;
      }
      return absentReadback(
        "CREATE_PR",
        request,
        now(),
        state.unknownReadbacks.has("CREATE_PR") ? "UNKNOWN" : "ABSENT",
      );
    },
    async createPullRequest(request) {
      state.calls.createPullRequest += 1;
      if (state.failBeforePersistRemaining.delete("CREATE_PR")) {
        state.unknownReadbacks.add("CREATE_PR");
        throw new Error("transport failed before provider result");
      }
      const number = 101;
      state.pullRequest = withEvidence({
        contract: "seorilabs-fleet-cleanup-mutation-readback-v1",
        kind: "CREATE_PR",
        readbackId: "cleanup-create-pr-readback-0001",
        observedAt: new Date(now()).toISOString(),
        repositoryId: request.repositoryId,
        fullName: request.fullName,
        operationId: request.operationId,
        number,
        url: `https://github.com/${request.fullName}/pull/${number}`,
        state: "OPEN",
        isDraft: request.draft,
        baseRef: request.baseRef,
        headRef: request.headRef,
        headSha: request.headSha,
        title: request.title,
        bodyDigest: request.bodyDigest,
      });
      if (fault.dropRefAfterPullRequest) state.ref = null;
      if (state.crashRemaining.delete("CREATE_PR")) {
        throw new Error("transport uncertain after PR");
      }
    },
  };
  return {
    adapter: createTrustedFleetCleanupGitHubAdapter({ provider }),
    provider,
    state,
    repository,
    inventoryRepository,
  };
}

function refreshLedger(ledger, nowMs) {
  ledger.observedAt = new Date(nowMs).toISOString();
  ledger.readbackId =
    `cleanup-ledger-readback-${String(ledger.executionGeneration).padStart(4, "0")}`;
  ledger.evidenceDigest = computeFleetEvidenceDigest(ledger);
}

function ledgerState(steps) {
  if (steps.some(({ state }) => state === "RESULT_UNKNOWN")) {
    return "RESULT_UNKNOWN";
  }
  if (steps.every(({ state }) => state === "CONFIRMED")) {
    return "READY_TO_COMPLETE";
  }
  return "RUNNING";
}

export function makeCleanupStateProvider({ now, fault = {} } = {}) {
  const authority = {
    generation: 1,
    reservations: new Map(),
  };
  const state = {
    reserveCalls: 0,
    transitionCalls: 0,
    completionCalls: 0,
    issuedLeaseBuffers: [],
  };
  const provider = {
    async readAuthority(request) {
      const readStartedAt = now();
      const readback = withEvidence({
        contract: "seorilabs-fleet-cleanup-state-authority-v1",
        authorityRevision: "fleet-cleanup-state-authority-0001",
        readbackId: `fleet-cleanup-authority-readback-${String(
          authority.generation,
        ).padStart(4, "0")}`,
        observedAt: new Date(readStartedAt).toISOString(),
        organizationId: request.organizationId,
        installationId: request.installationId,
        repositoryId: request.repositoryId,
        fullName: request.fullName,
        sourceSha: request.sourceSha,
        inventoryDigest: request.inventoryDigest,
        planDigest: fault.authorityPlanDrift
          ? digest("authority-plan-drift")
          : request.planDigest,
        state: "ACTIVE",
        generation: authority.generation,
        chainHeadDigest: request.chainHeadDigest,
      });
      fault.afterAuthorityRead?.();
      return readback;
    },
    async reserveExecution(request) {
      state.reserveCalls += 1;
      const existing = authority.reservations.get(request.executionKey);
      if (existing !== undefined) {
        if (
          existing.binding.runId !== request.runId ||
          existing.binding.workerId !== request.workerId
        ) {
          throw new Error("execution key already claimed");
        }
        if (existing.ledger.state === "COMPLETED") {
          return {
            contract: "seorilabs-fleet-cleanup-state-reservation-v1",
            state: "COMPLETED",
            ...structuredClone(existing.binding),
            reservationId: existing.reservationId,
            expectedStateGeneration: existing.expectedStateGeneration,
            reservedStateGeneration: existing.reservedStateGeneration,
            executionGeneration: existing.ledger.executionGeneration,
            stateGeneration: existing.reservedStateGeneration,
            receiptDigest: existing.ledger.receiptDigest,
          };
        }
        const issuedLeaseToken = Buffer.from(existing.leaseToken);
        state.issuedLeaseBuffers.push(issuedLeaseToken);
        return {
          contract: "seorilabs-fleet-cleanup-state-reservation-v1",
          state: "RESUME",
          ...structuredClone(existing.binding),
          reservationId: existing.reservationId,
          expectedStateGeneration: existing.expectedStateGeneration,
          reservedStateGeneration: existing.reservedStateGeneration,
          executionGeneration: existing.ledger.executionGeneration,
          expiresAt: existing.expiresAt,
          leaseToken: issuedLeaseToken,
        };
      }
      if (request.expectedStateGeneration !== authority.generation) {
        throw new Error("state generation conflict");
      }
      const bindingKeys = [
        "organizationId",
        "installationId",
        "issuanceDigest",
        "inventoryDigest",
        "planDigest",
        "executionKey",
        "runId",
        "workerId",
        "repositoryId",
        "fullName",
        "sourceSha",
        "issueNumber",
        "chainHeadDigest",
      ];
      const binding = Object.fromEntries(
        bindingKeys.map((key) => [key, request[key]]),
      );
      const reservationId =
        `fleet-cleanup-reservation-${request.executionKey.slice(7, 27)}`;
      const leaseToken = Buffer.alloc(32, 0x5a);
      const ledger = {
        contract: "seorilabs-fleet-cleanup-execution-ledger-v1",
        ...structuredClone(binding),
        readbackId: "cleanup-ledger-readback-0001",
        observedAt: new Date(now()).toISOString(),
        reservationId,
        expectedStateGeneration: authority.generation,
        reservedStateGeneration: authority.generation + 1,
        executionGeneration: 1,
        state: "RUNNING",
        steps: request.steps.map((step) => ({
          ...structuredClone(step),
          state: "PENDING",
          receiptDigest: null,
        })),
        receiptDigest: null,
        evidenceDigest: "sha256:" + "0".repeat(64),
      };
      refreshLedger(ledger, now());
      const record = {
        binding,
        reservationId,
        expectedStateGeneration: authority.generation,
        reservedStateGeneration: authority.generation + 1,
        expiresAt: request.requestedExpiresAt,
        leaseToken,
        ledger,
      };
      authority.reservations.set(request.executionKey, record);
      const issuedLeaseToken = Buffer.from(leaseToken);
      state.issuedLeaseBuffers.push(issuedLeaseToken);
      return {
        contract: "seorilabs-fleet-cleanup-state-reservation-v1",
        state: "CLAIMED",
        ...structuredClone(binding),
        reservationId,
        expectedStateGeneration: record.expectedStateGeneration,
        reservedStateGeneration: record.reservedStateGeneration,
        executionGeneration: ledger.executionGeneration,
        expiresAt: record.expiresAt,
        leaseToken: issuedLeaseToken,
      };
    },
    async readExecution(request) {
      const record = authority.reservations.get(request.executionKey);
      if (
        record === undefined ||
        record.reservationId !== request.reservationId
      ) {
        throw new Error("ledger not found");
      }
      refreshLedger(record.ledger, now());
      return structuredClone(record.ledger);
    },
    async transitionStep(request) {
      state.transitionCalls += 1;
      const record = authority.reservations.get(request.executionKey);
      if (
        record === undefined ||
        record.reservationId !== request.reservationId ||
        !Buffer.isBuffer(request.leaseToken) ||
        !request.leaseToken.equals(record.leaseToken) ||
        request.expectedExecutionGeneration !==
          record.ledger.executionGeneration
      ) {
        throw new Error("stale ledger transition");
      }
      const step = record.ledger.steps.find(
        (item) => item.kind === request.kind,
      );
      if (
        step?.state !== request.expectedStepState ||
        step.operationId !== request.operationId
      ) {
        throw new Error("step transition mismatch");
      }
      step.state = request.nextStepState;
      step.receiptDigest = request.receiptDigest;
      if (
        fault.tamperPriorStep &&
        request.kind === "CREATE_REF" &&
        request.nextStepState === "DISPATCHED"
      ) {
        record.ledger.steps[0].receiptDigest = digest(
          "tampered-create-commit-receipt",
        );
      }
      record.ledger.executionGeneration += 1;
      record.ledger.state = ledgerState(record.ledger.steps);
      fault.afterTransition?.({
        kind: request.kind,
        nextStepState: request.nextStepState,
      });
      refreshLedger(record.ledger, now());
      return structuredClone(record.ledger);
    },
    async completeAndConsume(request) {
      state.completionCalls += 1;
      const record = authority.reservations.get(request.executionKey);
      if (
        record === undefined ||
        record.reservationId !== request.reservationId ||
        !Buffer.isBuffer(request.leaseToken) ||
        !request.leaseToken.equals(record.leaseToken) ||
        request.expectedExecutionGeneration !==
          record.ledger.executionGeneration ||
        request.expectedStateGeneration !== authority.generation ||
        request.reservedStateGeneration !== authority.generation + 1 ||
        record.ledger.state !== "READY_TO_COMPLETE"
      ) {
        throw new Error("stale completion");
      }
      record.ledger.executionGeneration += 1;
      record.ledger.state = "COMPLETED";
      record.ledger.receiptDigest = request.receiptDigest;
      refreshLedger(record.ledger, now());
      authority.generation = request.reservedStateGeneration;
      const completion = withEvidence({
        contract: "seorilabs-fleet-cleanup-state-consumption-v1",
        state: "COMPLETED",
        ...structuredClone(record.binding),
        reservationId: record.reservationId,
        stateGeneration: authority.generation,
        executionGeneration: fault.staleCompletion
          ? record.ledger.executionGeneration - 1
          : record.ledger.executionGeneration,
        receiptDigest: request.receiptDigest,
      });
      return completion;
    },
  };
  return {
    authority,
    provider,
    state,
    store: createTrustedFleetCleanupStateStore({ provider }),
  };
}

export function cleanupExecutionRequest(repositoryId, overrides = {}) {
  return {
    repositoryId,
    issueNumber: 7001,
    runId: "fleet-cleanup-executor-run-0001",
    workerId: "codex-seorilabs-generic-worker",
    ...overrides,
  };
}

export { INSTALLATION_ID, ORGANIZATION_ID, canonicalJson, digest };
