const defaultPermission = "secretmanager.versions.access";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

export function secretEffectiveAccessArgs({
  projectId,
  projectNumber,
  secretId,
  permission = defaultPermission,
}) {
  const fullResourceName =
    `//secretmanager.googleapis.com/projects/${projectNumber}/secrets/${secretId}`;
  return [
    "asset",
    "analyze-iam-policy",
    `--project=${projectId}`,
    `--full-resource-name=${fullResourceName}`,
    `--permissions=${permission}`,
    "--expand-roles",
    "--show-response",
    "--format=json",
  ];
}

export function evaluateSecretEffectiveAccess({
  analysis,
  projectId,
  projectNumber,
  secretId,
  allowedPrincipals,
  permission = defaultPermission,
}) {
  const fullResourceName =
    `//secretmanager.googleapis.com/projects/${projectNumber}/secrets/${secretId}`;
  const expectedScope = `projects/${projectId}`;
  const main = analysis?.mainAnalysis;
  const query = main?.analysisQuery;
  const results = main?.analysisResults;
  if (
    analysis === null || typeof analysis !== "object" || Array.isArray(analysis) ||
    main === null || typeof main !== "object" || Array.isArray(main) ||
    query?.scope !== expectedScope ||
    query?.resourceSelector?.fullResourceName !== fullResourceName ||
    !exactStrings(query?.accessSelector?.permissions, [permission]) ||
    query?.options?.expandRoles !== true ||
    !Array.isArray(results) ||
    !Array.isArray(allowedPrincipals) ||
    allowedPrincipals.some((principal) => typeof principal !== "string")
  ) fail("SECRET_EFFECTIVE_ACCESS_RESPONSE_INVALID");
  if (
    analysis.fullyExplored !== true || main.fullyExplored !== true ||
    results.some((result) => result?.fullyExplored !== true)
  ) fail("SECRET_EFFECTIVE_ACCESS_INCOMPLETE");

  const principals = new Set();
  for (const result of results) {
    const members = result?.iamBinding?.members;
    const identities = result?.identityList?.identities;
    const accessControlLists = result?.accessControlLists;
    if (
      typeof result?.attachedResourceFullName !== "string" ||
      typeof result?.iamBinding?.role !== "string" ||
      !Array.isArray(members) || members.some((member) => typeof member !== "string") ||
      !Array.isArray(identities) ||
      identities.some(({ name } = {}) => typeof name !== "string") ||
      !Array.isArray(accessControlLists) || accessControlLists.length === 0 ||
      accessControlLists.some((list) =>
        !Array.isArray(list?.accesses) ||
        !list.accesses.some((access) => access?.permission === permission) ||
        !Array.isArray(list?.resources) ||
        !list.resources.some((resource) => resource?.fullResourceName === fullResourceName))
    ) fail("SECRET_EFFECTIVE_ACCESS_RESPONSE_INVALID");
    for (const member of members) principals.add(member);
    for (const { name } of identities) principals.add(name);
  }

  const allowed = new Set(allowedPrincipals);
  const observedPrincipals = [...principals].toSorted();
  const unexpectedPrincipals = observedPrincipals.filter(
    (principal) => !allowed.has(principal),
  );
  return {
    permission,
    fullResourceName,
    fullyExplored: true,
    observedPrincipals,
    unexpectedPrincipals,
    exact: unexpectedPrincipals.length === 0,
  };
}
