const permissionRank = Object.freeze({ read: 1, write: 2, admin: 3 });

function permissionSatisfies(actual, required) {
  return (permissionRank[actual] ?? 0) >= (permissionRank[required] ?? 0);
}

export function githubAppReadback(desired, installations) {
  if (!Array.isArray(installations)) {
    return {
      identityExact: false,
      ready: false,
      code: "P3_GITHUB_APP_INSTALLATIONS_INVALID",
    };
  }
  const matches = installations.filter(
    ({ app_id: appId, id }) =>
      appId === desired.appId || id === desired.installationId,
  );
  if (matches.length !== 1) {
    return {
      identityExact: false,
      ready: false,
      code:
        matches.length === 0
          ? "P3_GITHUB_APP_INSTALLATION_MISSING"
          : "P3_GITHUB_APP_INSTALLATION_DUPLICATED",
    };
  }
  const installation = matches[0];
  const identity = {
    appId: installation.app_id,
    slug: installation.app_slug,
    installationId: installation.id,
    targetType: installation.target_type,
    repositorySelection: installation.repository_selection,
    suspendedAt: installation.suspended_at ?? null,
  };
  const identityExact =
    identity.appId === desired.appId &&
    identity.slug === desired.slug &&
    identity.installationId === desired.installationId &&
    identity.targetType === desired.targetType &&
    identity.repositorySelection === desired.repositorySelection &&
    identity.suspendedAt === null;
  const currentPermissions = installation.permissions ?? {};
  const permissionChanges = Object.entries(desired.permissions)
    .filter(
      ([permission, required]) =>
        !permissionSatisfies(currentPermissions[permission], required),
    )
    .map(([permission, required]) => ({
      permission,
      current: currentPermissions[permission] ?? null,
      required,
    }));
  const permissionUnion = { ...currentPermissions };
  for (const { permission, required } of permissionChanges) {
    permissionUnion[permission] = required;
  }
  const currentEvents = Array.isArray(installation.events)
    ? [...installation.events]
    : [];
  const eventAdditions = desired.events.filter(
    (event) => !currentEvents.includes(event),
  );
  const eventUnion = [...new Set([...currentEvents, ...desired.events])].toSorted();
  return {
    identity,
    identityExact,
    currentPermissions,
    permissionChanges,
    permissionUnion,
    currentEvents: currentEvents.toSorted(),
    eventAdditions,
    eventUnion,
    installationAcceptanceRequired:
      permissionChanges.length > 0 || eventAdditions.length > 0,
    ready:
      identityExact &&
      permissionChanges.length === 0 &&
      eventAdditions.length === 0,
  };
}
