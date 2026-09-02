// Public GitHub response normalization. Provider metadata is not desired state.
// Unknown settings and enterprise-inherited definitions remain fail-closed.
import { createHash } from "node:crypto";

const propertyFields = Object.freeze([
  "property_name", "value_type", "required", "default_value", "description",
  "allowed_values", "values_editable_by", "require_explicit_values",
]);
const propertyResponseFields = new Set([...propertyFields, "url", "source_type"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).toSorted(
      ([left], [right]) => left.localeCompare(right),
    ).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

function propertySettings(value) {
  return {
    property_name: value.property_name,
    value_type: value.value_type,
    required: value.required === undefined ? false : value.required,
    default_value: value.default_value ?? null,
    description: value.description ?? null,
    allowed_values: value.allowed_values ?? null,
    values_editable_by: value.values_editable_by === undefined ? "org_actors" : value.values_editable_by,
    require_explicit_values: value.require_explicit_values === undefined ? false : value.require_explicit_values,
  };
}

export function githubCustomPropertyReadback(desired, actual, organization) {
  const result = { propertyName: desired.property_name, exists: actual !== null, exact: false };
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return result;
  if (Object.keys(actual).some((key) => !propertyResponseFields.has(key))) return result;
  if (actual.source_type !== undefined && actual.source_type !== "organization") return result;
  const expectedUrl = `https://api.github.com/orgs/${organization}/properties/schema/`
    + encodeURIComponent(desired.property_name);
  if (actual.url !== undefined && actual.url !== expectedUrl) return result;
  result.exact = JSON.stringify(canonical(propertySettings(actual)))
    === JSON.stringify(canonical(propertySettings(desired)));
  return result;
}

export function githubProtectionPlanReadback(actual, { organization, organizationId }) {
  const identityExact = actual !== null && typeof actual === "object"
    && actual.login === organization && String(actual.id) === String(organizationId);
  const reportedPlan = identityExact ? actual.plan?.name : undefined;
  const plan = ["free", "team", "enterprise"].includes(reportedPlan) ? reportedPlan : null;
  const protection = plan === "team" ? "SUPPORTED" : plan === null ? "UNVERIFIED" : "UNSUPPORTED";
  return {
    organizationId: String(organizationId),
    identityExact,
    plan,
    protection,
    requiredPlan: "team",
    providerMode: "REPO_BRANCH_PROTECTION",
    rolloutMode: "SHADOW",
    code: !identityExact && actual !== null ? "P3_GITHUB_ORGANIZATION_IDENTITY_MISMATCH"
      : protection === "UNSUPPORTED" ? "P3_GITHUB_PROTECTION_PLAN_DRIFT"
      : protection === "UNVERIFIED" ? "P3_GITHUB_PLAN_VISIBILITY_REQUIRED" : null,
  };
}

// This is an observation, never permission to change branch protection. A null
// branchProtection is supplied only for GitHub's exact "Branch not protected" 404.
export function githubProtectionReadback(desired, binding, actual, observedAt) {
  const identityExact = actual.repository?.full_name === binding.fullName
    && String(actual.repository?.id) === binding.repositoryId
    && actual.repository?.default_branch === desired.branch;
  const branch = actual.branchProtection;
  const branchValid = branch === null || (branch && typeof branch === "object"
    && !Array.isArray(branch)
    && branch.url === `https://api.github.com/repos/${binding.fullName}/branches/${desired.branch}/protection`);
  const rulesValid = Array.isArray(actual.activeRules)
    && actual.activeRules.every((rule) => rule && typeof rule === "object" && typeof rule.type === "string");
  const observed = Boolean(identityExact && branchValid && rulesValid);
  const checks = observed ? [...new Set([
    ...(branch?.required_status_checks?.contexts ?? []),
    ...(branch?.required_status_checks?.checks ?? []).map(({ context }) => context),
    ...actual.activeRules.filter(({ type }) => type === "required_status_checks")
      .flatMap(({ parameters }) => (parameters?.required_status_checks ?? []).map(({ context }) => context)),
  ])].sort() : [];
  const checkPresent = observed && checks.includes(desired.requiredStatusCheck);
  return {
    ...binding,
    branch: desired.branch,
    observedAt,
    state: observed ? "OBSERVED" : "UNVERIFIED",
    identityExact,
    branchProtectionPresent: observed ? branch !== null : null,
    existingStatusChecks: checks,
    missingStatusChecks: observed && !checkPresent ? [desired.requiredStatusCheck] : [],
    requiredStatusCheck: desired.requiredStatusCheck,
    requiredStatusCheckPresent: observed ? checkPresent : null,
    snapshotDigest: observed ? `sha256:${createHash("sha256")
      .update(JSON.stringify(canonical(actual))).digest("hex")}` : null,
  };
}
