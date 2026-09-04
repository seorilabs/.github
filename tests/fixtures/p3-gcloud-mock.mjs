#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.P3_GCLOUD_MOCK_STATE;
if (!statePath) process.exit(2);

const args = process.argv.slice(2).filter((argument) => argument !== "--quiet");
const state = JSON.parse(readFileSync(statePath, "utf8"));
state.history ??= [];
state.services ??= [];

function save() {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function output(value) {
  if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  }
}

function notFound() {
  process.stderr.write(state.notFoundDiagnostic ?? "NOT_FOUND\n");
  process.exit(1);
}

function fail() {
  process.stderr.write("UNSUPPORTED_MOCK_COMMAND\n");
  process.exit(1);
}

function flag(name) {
  const prefix = `${name}=`;
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function providerExpectedFromArgs() {
  return {
    attributeCondition: flag("--attribute-condition"),
    attributeMapping: Object.fromEntries(
      (flag("--attribute-mapping") ?? "")
        .split(",")
        .filter(Boolean)
        .map((entry) => entry.split(/=(.*)/su).slice(0, 2)),
    ),
    disabled: args.includes("--disabled"),
    oidc: {
      allowedAudiences: [flag("--allowed-audiences")],
      issuerUri: flag("--issuer-uri"),
    },
  };
}

function bindingTarget() {
  if (args[0] === "projects") {
    return { resourceType: "project", resource: `projects/${args[2]}` };
  }
  if (args[0] === "storage") {
    return { resourceType: "bucket", resource: args[3] };
  }
  if (args[0] === "iam" && args[1] === "service-accounts") {
    return { resourceType: "serviceAccount", resource: args[3] };
  }
  if (args[0] === "artifacts") {
    return {
      resourceType: "artifactRepository",
      resource:
        `projects/${flag("--project")}/locations/${flag("--location")}` +
        `/repositories/${args[3]}`,
    };
  }
  if (args[0] === "secrets") {
    return {
      resourceType: "secret",
      resource: `projects/${flag("--project")}/secrets/${args[2]}`,
    };
  }
  fail();
}

function bindingVerb() {
  if (args[0] === "projects") return args[1];
  if (["storage", "iam", "artifacts"].includes(args[0])) return args[2];
  if (args[0] === "secrets") return args[1];
  fail();
}

function policyFor(target) {
  const roles = new Map();
  for (const item of state.bindings.filter(
    ({ resourceType, resource }) =>
      resourceType === target.resourceType && resource === target.resource,
  )) {
    const members = roles.get(item.role) ?? [];
    if (!members.includes(item.member)) members.push(item.member);
    roles.set(item.role, members);
  }
  const conditionalBindings = (state.conditionalPolicies ?? [])
    .filter(({ resourceType, resource }) =>
      resourceType === target.resourceType && resource === target.resource,
    )
    .flatMap(({ bindings }) => bindings);
  const bindings = [
    ...[...roles.entries()].map(([role, members]) => ({ role, members })),
    ...conditionalBindings,
  ];
  return {
    etag: "mock-policy-etag",
    version: conditionalBindings.length === 0 ? 1 : 3,
    ...(bindings.length === 0 ? {} : { bindings }),
  };
}

const commandFailure = state.commandFailures?.find(({ prefix }) =>
  prefix.every((argument, index) => args[index] === argument),
);
if (commandFailure) {
  process.stdout.write(commandFailure.stdout ?? "");
  process.stderr.write(commandFailure.stderr ?? "");
  process.exit(1);
}

if (args[0] === "projects" && args[1] === "describe") {
  output(state.projectNumber);
  process.exit(0);
}

if (args[0] === "services" && args[1] === "list" && args.includes("--enabled")) {
  output([...state.services].sort().join("\n"));
  process.exit(0);
}

if (args[0] === "services" && args[1] === "enable") {
  const requested = args
    .slice(2)
    .filter((argument) => !argument.startsWith("--"));
  for (const service of requested) {
    if (!state.services.includes(service)) {
      state.services.push(service);
      state.history.push(`service:enable:${service}`);
    }
  }
  state.services.sort();
  save();
  process.exit(0);
}

if (args[0] === "asset" && args[1] === "analyze-iam-policy") {
  if (state.assetResponseOverride !== undefined) {
    output(state.assetResponseOverride);
    process.exit(0);
  }
  const fullResourceName = flag("--full-resource-name");
  const permission = flag("--permissions");
  const projectId = flag("--project");
  const prefix = `//secretmanager.googleapis.com/projects/${state.projectNumber}/secrets/`;
  if (
    !fullResourceName?.startsWith(prefix) ||
    permission !== "secretmanager.versions.access" ||
    !args.includes("--expand-roles") || !args.includes("--show-response")
  ) fail();
  const secretId = fullResourceName.slice(prefix.length);
  const effectiveRoles = new Set([
    "roles/owner",
    "roles/secretmanager.admin",
    "roles/secretmanager.secretAccessor",
  ]);
  const applicable = state.bindings.filter(({ resourceType, resource, role }) =>
    effectiveRoles.has(role) && (
      (resourceType === "project" && resource === `projects/${projectId}`) ||
      (resourceType === "secret" &&
        resource === `projects/${projectId}/secrets/${secretId}`)
    ),
  );
  const fullyExplored = state.assetFullyExplored !== false;
  output({
    fullyExplored,
    mainAnalysis: {
      fullyExplored,
      analysisQuery: {
        scope: `projects/${projectId}`,
        resourceSelector: { fullResourceName },
        accessSelector: { permissions: [permission] },
        options: { expandRoles: true },
      },
      analysisResults: applicable.map((binding) => ({
        fullyExplored,
        attachedResourceFullName: binding.resourceType === "secret"
          ? fullResourceName
          : `//cloudresourcemanager.googleapis.com/projects/${projectId}`,
        iamBinding: { role: binding.role, members: [binding.member] },
        identityList: { identities: [{ name: binding.member }] },
        accessControlLists: [{
          accesses: [{ permission }],
          resources: [{ fullResourceName }],
        }],
      })),
    },
  });
  process.exit(0);
}

if (args[0] === "secrets" && args[1] === "describe") {
  const secret = state.secrets?.[args[2]];
  if (!secret) notFound();
  output({ name: secret.name });
  process.exit(0);
}

if (
  args[0] === "secrets" &&
  args[1] === "versions" &&
  args[2] === "list"
) {
  const secret = state.secrets?.[args[3]];
  if (!secret) notFound();
  output(secret.versions ?? []);
  process.exit(0);
}

if (args[0] === "iam" && args[1] === "service-accounts") {
  if (args[2] === "describe") {
    const account = state.serviceAccounts[args[3]];
    if (!account) notFound();
    output(args.some((argument) => argument === "--format=value(email)")
      ? account.email
      : account);
    process.exit(0);
  }
  if (args[2] === "create") {
    const email = `${args[3]}@${flag("--project")}.iam.gserviceaccount.com`;
    state.serviceAccounts[email] = { email, disabled: false };
    state.history.push(`service-account:create:${email}`);
    save();
    process.exit(0);
  }
}

if (
  args[0] === "iam" &&
  args[1] === "workload-identity-pools" &&
  args[2] === "describe"
) {
  if (!state.pool) notFound();
  output(state.pool);
  process.exit(0);
}

if (
  args[0] === "iam" &&
  args[1] === "workload-identity-pools" &&
  args[2] === "create"
) {
  state.pool = {
    name:
      `projects/${state.projectNumber}/locations/global/workloadIdentityPools/` +
      args[3],
    displayName: flag("--display-name"),
    description: flag("--description"),
    disabled: false,
    state: "ACTIVE",
  };
  state.history.push(`pool:create:${args[3]}`);
  save();
  process.exit(0);
}

if (
  args[0] === "iam" &&
  args[1] === "workload-identity-pools" &&
  args[2] === "providers"
) {
  const provider = args[4];
  if (args[3] === "describe") {
    if (!state.providers[provider]) notFound();
    output(state.providers[provider]);
    process.exit(0);
  }
  if (args[3] === "create-oidc") {
    state.providers[provider] = providerExpectedFromArgs();
    state.history.push(`provider:create:${provider}`);
    save();
    process.exit(0);
  }
  if (args[3] === "update-oidc") {
    if (!state.providers[provider]) notFound();
    const configurationUpdate = [
      "--attribute-condition",
      "--attribute-mapping",
      "--issuer-uri",
      "--allowed-audiences",
    ].some((name) => flag(name) !== undefined);
    if (flag("--attribute-condition") !== undefined) {
      state.providers[provider].attributeCondition = flag(
        "--attribute-condition",
      );
    }
    if (flag("--attribute-mapping") !== undefined) {
      state.providers[provider].attributeMapping =
        providerExpectedFromArgs().attributeMapping;
    }
    if (flag("--issuer-uri") !== undefined) {
      state.providers[provider].oidc.issuerUri = flag("--issuer-uri");
    }
    if (flag("--allowed-audiences") !== undefined) {
      state.providers[provider].oidc.allowedAudiences = [
        flag("--allowed-audiences"),
      ];
    }
    if (args.includes("--disabled")) state.providers[provider].disabled = true;
    else if (args.includes("--no-disabled")) {
      state.providers[provider].disabled = false;
    } else {
      fail();
    }
    state.history.push(
      configurationUpdate
        ? `provider:update:${provider}`
        : `provider:${state.providers[provider].disabled ? "disable" : "enable"}:${provider}`,
    );
    save();
    process.exit(0);
  }
}

if (
  args.some((argument) =>
    [
      "add-iam-policy-binding",
      "remove-iam-policy-binding",
      "get-iam-policy",
    ].includes(argument),
  )
) {
  const target = bindingTarget();
  const verb = bindingVerb();
  if (verb === "get-iam-policy") {
    const policy = policyFor(target);
    output(args.includes("--format=json(bindings)")
      ? (policy.bindings === undefined ? null : { bindings: policy.bindings })
      : policy);
    process.exit(0);
  }
  if (
    verb === "add-iam-policy-binding" &&
    policyFor(target).bindings?.some(({ condition }) => condition !== undefined) &&
    flag("--condition") !== "None"
  ) {
    process.stderr.write("IAM_CONDITION_MUST_BE_EXPLICIT\n");
    process.exit(1);
  }
  const item = {
    ...target,
    role: flag("--role"),
    member: flag("--member"),
  };
  const index = state.bindings.findIndex(
    (candidate) => JSON.stringify(candidate) === JSON.stringify(item),
  );
  if (verb === "add-iam-policy-binding" && index === -1) {
    state.bindings.push(item);
  }
  if (verb === "remove-iam-policy-binding" && index !== -1) {
    state.bindings.splice(index, 1);
  }
  state.history.push(
    `iam:${verb === "add-iam-policy-binding" ? "add" : "remove"}`,
  );
  save();
  process.exit(0);
}

fail();
