/**
 * Cloud Build가 쓰는 Workload Identity Federation provider 정책을 만든다.
 *
 * 조직 소유자와 (repository_id, job_workflow_ref) 쌍만으로 조건을 고정한다. 이 값은
 * contracts/fleet-p3-runtime.yaml이 정본이고 bootstrap-p3-* 스크립트가 GCP에 적용한다.
 */
const ID_PATTERN = /^[1-9][0-9]{0,31}$/u;
const JOB_WORKFLOW_REF_PATTERN =
  /^seorilabs\/\.github\/\.github\/workflows\/[a-z0-9-]+\.yml@[0-9a-f]{40}$/u;

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function snapshotWifCapabilities(capabilities) {
  if (
    !Array.isArray(capabilities) ||
    capabilities.length === 0 ||
    capabilities.length > 64
  ) {
    throw new Error("WIF_PROVIDER_POLICY_INVALID");
  }
  const snapshot = capabilities.map((capability) => {
    if (
      !exactKeys(capability, ["environment", "jobWorkflowRef", "repositoryId"]) ||
      capability.environment !== "internal" ||
      !ID_PATTERN.test(capability.repositoryId ?? "") ||
      !JOB_WORKFLOW_REF_PATTERN.test(capability.jobWorkflowRef ?? "")
    ) {
      throw new Error("WIF_PROVIDER_POLICY_INVALID");
    }
    return structuredClone(capability);
  });
  const keys = snapshot.map(
    ({ repositoryId, jobWorkflowRef }) => `${repositoryId}:${jobWorkflowRef}`,
  );
  if (new Set(keys).size !== keys.length) {
    throw new Error("WIF_PROVIDER_POLICY_INVALID");
  }
  return deepFreeze(
    snapshot.toSorted(
      (left, right) =>
        left.repositoryId.localeCompare(right.repositoryId) ||
        left.jobWorkflowRef.localeCompare(right.jobWorkflowRef),
    ),
  );
}

export function createTrustedWifProviderPolicy({
  organizationId,
  capabilities,
} = {}) {
  if (!ID_PATTERN.test(organizationId ?? "")) {
    throw new Error("WIF_PROVIDER_POLICY_INVALID");
  }
  const trustedCapabilities = snapshotWifCapabilities(capabilities);
  const pairwiseCondition = trustedCapabilities
    .map(
      ({ repositoryId, jobWorkflowRef }) =>
        `(assertion.repository_id == '${repositoryId}' && ` +
        `assertion.job_workflow_ref == '${jobWorkflowRef}')`,
    )
    .join(" || ");
  return deepFreeze({
    attributeCondition:
      `assertion.repository_owner_id == '${organizationId}' && ` +
      `(${pairwiseCondition})`,
    attributeMapping: {
      "google.subject": "assertion.sub",
      "attribute.repository": "assertion.repository",
      "attribute.repository_id": "assertion.repository_id",
      "attribute.job_workflow_ref": "assertion.job_workflow_ref",
    },
    capabilities: trustedCapabilities,
  });
}
