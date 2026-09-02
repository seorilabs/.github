// Public GitHub response normalization. Provider metadata is not desired state.
// Unknown settings and enterprise-inherited definitions remain fail-closed.
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

export function githubRulesetPlanReadback(actual, { organization, organizationId }) {
  const identityExact = actual !== null && typeof actual === "object"
    && actual.login === organization && String(actual.id) === String(organizationId);
  const reportedPlan = identityExact ? actual.plan?.name : undefined;
  const plan = ["free", "team", "enterprise"].includes(reportedPlan) ? reportedPlan : null;
  const evaluate = plan === "enterprise" ? "SUPPORTED"
    : plan === "team" || plan === "free" ? "UNSUPPORTED" : "UNVERIFIED";
  return {
    organizationId: String(organizationId),
    identityExact,
    plan,
    evaluate,
    requiredPlan: "enterprise",
    code: !identityExact && actual !== null ? "P3_GITHUB_ORGANIZATION_IDENTITY_MISMATCH"
      : evaluate === "UNSUPPORTED" ? "P3_GITHUB_EVALUATE_UNSUPPORTED_BY_PLAN"
      : evaluate === "UNVERIFIED" ? "P3_GITHUB_PLAN_VISIBILITY_REQUIRED" : null,
  };
}
