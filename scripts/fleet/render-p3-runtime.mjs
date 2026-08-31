#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";

import {
  APPROVED_IMAGE_BINDING,
  EXPECTED_CANARY_OUTPUT_SHA256,
  canonicalSha256,
} from "../../tools/seori-auth/scripts/public-image-binding.mjs";
import { ANDROID_CANARY_BUILD_TARGETS } from "./resolve-android-cloud-build-target.mjs";

const contractPath = fileURLToPath(
  new URL("../../contracts/fleet-p3-runtime.yaml", import.meta.url),
);
const schemaPath = fileURLToPath(
  new URL("../../contracts/fleet-p3-runtime.schema.json", import.meta.url),
);
const commands = new Set([
  "github-app",
  "custom-properties",
  "pilot-values",
  "ruleset",
  "cloud-build",
  "auth-broker-foundation",
  "auth-broker-foundation-rollback",
]);

function fail(code) {
  process.stderr.write(`${JSON.stringify({ valid: false, code })}\n`);
  process.exit(1);
}

function unique(values) {
  return new Set(values).size === values.length;
}

function validateSemantics(contract) {
  const expectedGithubProvider =
    `projects/${contract.cloudBuild.projectNumber}/locations/global/` +
    `workloadIdentityPools/${contract.cloudBuild.wif.pool}/providers/` +
    contract.cloudBuild.wif.githubProvider;
  if (
    contract.cloudBuild.provider !== expectedGithubProvider ||
    contract.cloudBuild.wif.githubAudience !==
      `https://iam.googleapis.com/${expectedGithubProvider}`
  ) {
    fail("P3_GITHUB_WIF_AUDIENCE_INVALID");
  }
  const propertyNames = contract.github.customProperties.map(
    ({ property_name: name }) => name,
  );
  const expectedProperties = [
    "fleet-managed",
    "fleet-profile",
    "fleet-ruleset",
    "fleet-state",
  ];
  if (
    !unique(propertyNames) ||
    propertyNames.toSorted().join("\0") !== expectedProperties.join("\0")
  ) {
    fail("P3_CUSTOM_PROPERTY_CONTRACT_INVALID");
  }
  const pilots = new Map(
    contract.github.pilotValues.map((entry) => [entry.repository, entry.values]),
  );
  if (
    pilots.size !== 2 ||
    pilots.get("happy-farm")?.["fleet-profile"] !== "react-native" ||
    pilots.get("lizard-tycoon")?.["fleet-profile"] !== "godot"
  ) {
    fail("P3_PILOT_BINDING_INVALID");
  }
  const serviceAccounts = [
    contract.cloudBuild.submitter.serviceAccountEmail,
    ...contract.cloudBuild.executors.map(({ serviceAccountEmail }) =>
      serviceAccountEmail,
    ),
    ...contract.authBroker.roles.map(({ googleServiceAccount }) =>
      googleServiceAccount,
    ),
  ];
  if (!unique(serviceAccounts)) fail("P3_WORKLOAD_IDENTITY_REUSED");
  const executorKeys = contract.cloudBuild.executors.map(
    ({ repositoryId, target }) => `${repositoryId}\0${target}`,
  );
  const canaryExecutors = contract.cloudBuild.executors.filter(
    ({ capability }) => capability === "ANDROID_CANARY_BUILD_ONLY",
  );
  const releaseExecutors = contract.cloudBuild.executors.filter(
    ({ capability }) =>
      capability === "ANDROID_PLAY_PROMOTABLE_SIGNED_BUILD",
  );
  const expectedCanaries = ANDROID_CANARY_BUILD_TARGETS.map(
    ({ repositoryId, fullName, buildProfile, executorServiceAccount }) =>
      [repositoryId, fullName, buildProfile, executorServiceAccount].join("\0"),
  );
  const actualCanaries = canaryExecutors.map(
    ({ repositoryId, fullName, buildProfile, serviceAccountEmail }) =>
      [repositoryId, fullName, buildProfile, serviceAccountEmail].join("\0"),
  );
  if (
    contract.cloudBuild.executors.length !== 8 ||
    !unique(executorKeys) ||
    canaryExecutors.length !== 4 ||
    releaseExecutors.length !== 4 ||
    actualCanaries.toSorted().join("\n") !==
      expectedCanaries.toSorted().join("\n") ||
    canaryExecutors.some(
      ({ target, artifactClass, state, secretBindings }) =>
        target !== "ANDROID_CANARY_AAB" ||
        artifactClass !== "NON_PROMOTABLE_CANARY" ||
        state !== "blocked_unverified" ||
        secretBindings.length !== 0,
    ) ||
    releaseExecutors.some(
      ({ fullName, target, artifactClass, buildProfile, logicalCredentialId, serviceAccountEmail, secretBindings }) => {
        const app = fullName.split("/")[1];
        const secretPrefix =
          app === "lizard-tycoon" ? "lizard-" : `${app}-`;
        return (
          target !== "ANDROID_PLAY_AAB" ||
          artifactClass !== "PLAY_PROMOTABLE_SIGNED" ||
          buildProfile !== "android-play-promotable-signed" ||
          logicalCredentialId !== `app/${app}/gcp/cloud-build-release` ||
          serviceAccountEmail !==
            `seori-${app}-release@seorilabs-ci.iam.gserviceaccount.com` ||
          secretBindings.some(
            ({ logicalCredentialId: credentialId, resource, versionResource, usages }) =>
              !credentialId.startsWith(`app/${app}/`) ||
              !resource.startsWith(
                `projects/seorilabs-ci/secrets/${secretPrefix}`,
              ) ||
              !versionResource.startsWith(`${resource}/versions/`) ||
              usages.length === 0,
          )
        );
      },
    )
  ) {
    fail("P3_ANDROID_EXECUTOR_PARTITION_INVALID");
  }
  if (
    releaseExecutors.some(({ state }) => state !== "blocked_unverified")
  ) {
    fail("P3_ANDROID_RELEASE_GATE_INVALID");
  }
  const lizardRelease = releaseExecutors.find(
    ({ fullName }) => fullName === "seorilabs/lizard-tycoon",
  );
  const lizardPasswordBinding = lizardRelease?.secretBindings.find(
    ({ resource }) =>
      resource ===
      "projects/seorilabs-ci/secrets/lizard-play-keystore-password",
  );
  if (
    lizardRelease?.secretBindings.length !== 2 ||
    lizardPasswordBinding?.versionResource !==
      "projects/seorilabs-ci/secrets/lizard-play-keystore-password/versions/1" ||
    lizardPasswordBinding?.usages.join("\0") !==
      ["KEYSTORE_PASSWORD", "KEY_PASSWORD"].join("\0")
  ) {
    fail("P3_ANDROID_RELEASE_CREDENTIAL_BINDING_INVALID");
  }
  const environmentBindings = contract.cloudBuild.githubActions.repositoryBindings;
  if (
    environmentBindings.length !== 4 ||
    environmentBindings.some((binding) => {
      const canary = canaryExecutors.find(
        ({ repositoryId }) => repositoryId === binding.repositoryId,
      );
      return (
        canary === undefined ||
        binding.fullName !== canary.fullName ||
        binding.logicalCredentialId !== canary.logicalCredentialId ||
        binding.variables.GOOGLE_WORKLOAD_IDENTITY_PROVIDER !==
          contract.cloudBuild.provider ||
        binding.variables.SEORI_CLOUD_BUILD_SUBMITTER_SERVICE_ACCOUNT !==
          contract.cloudBuild.submitter.serviceAccountEmail ||
        binding.variables.SEORI_CLOUD_BUILD_EXECUTOR_SERVICE_ACCOUNT !==
          canary.serviceAccountEmail
      );
    })
  ) {
    fail("P3_ANDROID_ENVIRONMENT_BINDING_INVALID");
  }
  const secretManagerBindings = contract.authBroker.secretManager.resources.map(
    ({ secretId, logicalCredentialId, consumerRole, googleServiceAccount, resource, versionResource }) =>
      [secretId, logicalCredentialId, consumerRole, googleServiceAccount, resource, versionResource].join("\0"),
  );
  const expectedSecretManagerBindings = [
    ["seori-auth-journal-mac", "shared/seori-auth/journal-mac", "broker", "seori-auth-broker@seorilabs-ci.iam.gserviceaccount.com"],
    ["seori-auth-browser-vault", "shared/seori-auth/browser-vault", "broker", "seori-auth-broker@seorilabs-ci.iam.gserviceaccount.com"],
    ["seori-auth-canary-password", "shared/seori-auth/canary-password", "password-loader", "seori-auth-password-loader@seorilabs-ci.iam.gserviceaccount.com"],
    ["seori-auth-canary-totp-seed", "shared/seori-auth/canary-totp-seed", "totp-signer", "seori-auth-totp-signer@seorilabs-ci.iam.gserviceaccount.com"],
  ].map((entry) => {
    const resource = `projects/seorilabs-ci/secrets/${entry[0]}`;
    return [...entry, resource, `${resource}/versions/1`].join("\0");
  });
  if (
    !unique(secretManagerBindings) ||
    secretManagerBindings.toSorted().join("\n") !==
      expectedSecretManagerBindings.toSorted().join("\n")
  ) {
    fail("P3_SECRET_MANAGER_PARTITION_INVALID");
  }
  const { image, imageProvenance, registry, canary } = contract.authBroker;
  if (
    image !== APPROVED_IMAGE_BINDING.image ||
    canonicalSha256(imageProvenance) !==
      canonicalSha256(APPROVED_IMAGE_BINDING.imageProvenance) ||
    image !== `${registry.repository}@${imageProvenance.imageDigest}` ||
    imageProvenance.sourceSha !== registry.packageVersionTag ||
    imageProvenance.repository !== "seorilabs/.github" ||
    imageProvenance.workflow !== ".github/workflows/seori-auth-image.yml" ||
    imageProvenance.platform !== "linux/arm64"
  ) {
    fail("P2_AUTH_IMAGE_PROVENANCE_INVALID");
  }
  if (
    !["PUBLIC", "PACKAGES_READER"].includes(registry.mode) ||
    canary.expectedOutputSha256 !== EXPECTED_CANARY_OUTPUT_SHA256
  ) {
    fail("P2_AUTH_CANARY_CONTRACT_INVALID");
  }
  for (const identity of [contract.cloudBuild.submitter]) {
    const bindings = identity.bindings.map(
      ({ resource, role }) => `${resource}\0${role}`,
    );
    if (
      !unique(bindings) ||
      identity.bindings.some(({ role }) =>
        ["roles/owner", "roles/editor", "roles/viewer"].includes(role),
      )
    ) {
      fail("P3_CLOUD_BUILD_IAM_INVALID");
    }
  }
  const executionBindings = contract.cloudBuild.executionPolicy.baseBindings;
  if (
    !unique(executionBindings.map(({ resource, role }) => `${resource}\0${role}`)) ||
    executionBindings.some(({ role }) =>
      ["roles/owner", "roles/editor", "roles/viewer"].includes(role),
    )
  ) {
    fail("P3_CLOUD_BUILD_IAM_INVALID");
  }
  if (
    !contract.cloudBuild.submitter.bindings.some(
      ({ resource, role }) =>
        resource === `projects/${contract.cloudBuild.projectId}` &&
        role === "roles/storage.bucketViewer",
    )
  ) {
    fail("P3_CLOUD_BUILD_IAM_INVALID");
  }
}

async function loadContract() {
  const [contractText, schemaText] = await Promise.all([
    readFile(contractPath, "utf8"),
    readFile(schemaPath, "utf8"),
  ]);
  let contract;
  let schema;
  try {
    contract = parse(contractText);
    schema = JSON.parse(schemaText);
  } catch {
    fail("P3_CONTRACT_PARSE_FAILED");
  }
  const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(
    schema,
  );
  if (!validate(contract)) fail("P3_CONTRACT_SCHEMA_INVALID");
  validateSemantics(contract);
  return contract;
}

function githubApp(contract) {
  const {
    organization,
    app,
    trustedExecution,
    webhook,
    credentialRecovery,
  } = contract.github;
  return {
    apiVersion: contract.github.apiVersion,
    organization,
    reuseExisting: app.reuseExisting,
    identity: {
      appId: app.appId,
      slug: app.slug,
      installationId: app.installationId,
      targetType: app.targetType,
      repositorySelection: app.repositorySelection,
    },
    requiredPermissions: app.permissions,
    requiredEvents: app.events,
    permissionExpansionGate: app.humanGate,
    trustedExecution,
    webhook: { ...webhook },
    credentialRecovery,
    staticKeysCreated: false,
  };
}

function customProperties(contract) {
  return contract.github.customProperties.map((property) => ({
    apiVersion: contract.github.apiVersion,
    method: "PUT",
    path:
      `/orgs/${contract.github.organization}/properties/schema/` +
      encodeURIComponent(property.property_name),
    body: Object.fromEntries(
      Object.entries(property).filter(([name]) => name !== "property_name"),
    ),
  }));
}

function pilotValues(contract) {
  return contract.github.pilotValues.map(({ repository, values }) => ({
    apiVersion: contract.github.apiVersion,
    method: "PATCH",
    path: `/orgs/${contract.github.organization}/properties/values`,
    body: {
      repository_names: [repository],
      properties: Object.entries(values).map(([property_name, value]) => ({
        property_name,
        value,
      })),
    },
  }));
}

function ruleset(contract) {
  const source = contract.github.ruleset;
  return {
    apiVersion: contract.github.apiVersion,
    method: "POST",
    path: `/orgs/${contract.github.organization}/rulesets`,
    body: {
      name: source.name,
      target: source.target,
      enforcement: source.enforcement,
      conditions: {
        ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
        repository_name: {
          include: source.repositories,
          exclude: [],
          protected: false,
        },
      },
      rules: [
        { type: "deletion" },
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: source.requiredStatusCheck }],
            strict_required_status_checks_policy: false,
            do_not_enforce_on_create: false,
          },
        },
        {
          type: "pull_request",
          parameters: {
            allowed_merge_methods: ["squash"],
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_approving_review_count: 0,
            required_review_thread_resolution: true,
          },
        },
      ],
    },
  };
}

function metadata(name, namespace = "auth-broker") {
  return { name, namespace };
}

function issuer(name, spec) {
  return {
    apiVersion: "cert-manager.io/v1",
    kind: "Issuer",
    metadata: metadata(name),
    spec,
  };
}

function caCertificate(name) {
  return {
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: metadata(name),
    spec: {
      secretName: name,
      isCA: true,
      commonName: name,
      duration: "43800h",
      renewBefore: "720h",
      privateKey: { algorithm: "ECDSA", size: 256, rotationPolicy: "Always" },
      usages: ["cert sign", "crl sign", "digital signature"],
      issuerRef: { name: "auth-broker-selfsigned", kind: "Issuer" },
    },
  };
}

function serviceCertificate(role) {
  const serviceName = role.serviceAccount;
  return {
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: metadata(role.tlsSecretName),
    spec: {
      secretName: role.tlsSecretName,
      duration: "2160h",
      renewBefore: "360h",
      privateKey: { algorithm: "ECDSA", size: 256, rotationPolicy: "Always" },
      dnsNames: [
        serviceName,
        `${serviceName}.auth-broker`,
        `${serviceName}.auth-broker.svc`,
        `${serviceName}.auth-broker.svc.cluster.local`,
      ],
      uris: [
        `spiffe://seorilabs.local/ns/auth-broker/sa/${role.serviceAccount}`,
      ],
      usages: ["digital signature", "server auth", "client auth"],
      issuerRef: { name: "auth-broker-service-ca", kind: "Issuer" },
    },
  };
}

function egressCertificate(role) {
  return {
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: metadata(role.egressTlsSecretName),
    spec: {
      secretName: role.egressTlsSecretName,
      duration: "2160h",
      renewBefore: "360h",
      privateKey: { algorithm: "ECDSA", size: 256, rotationPolicy: "Always" },
      uris: [
        `spiffe://seorilabs.local/ns/auth-broker/sa/${role.serviceAccount}`,
      ],
      usages: ["digital signature", "client auth"],
      issuerRef: { name: "auth-broker-egress-ca", kind: "Issuer" },
    },
  };
}

function authBrokerFoundation(contract) {
  const broker = contract.authBroker;
  const bindingSha256 = canonicalSha256(broker);
  const publicBinding = { ...broker, bindingSha256 };
  const labels = {
    "pod-security.kubernetes.io/enforce": "restricted",
    "pod-security.kubernetes.io/enforce-version": "latest",
    "pod-security.kubernetes.io/audit": "restricted",
    "pod-security.kubernetes.io/warn": "restricted",
  };
  const appName = (name) =>
    name === "broker" ? "seori-auth-broker" : `seori-${name}`;
  const items = [
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: broker.namespace, labels },
    },
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        ...metadata(`auth-broker-public-bindings-${bindingSha256.slice(0, 12)}`),
        annotations: {
          "seorilabs.io/binding-sha256": bindingSha256,
          "seorilabs.io/image-digest": broker.imageProvenance.imageDigest,
          "seorilabs.io/image-source-sha": broker.imageProvenance.sourceSha,
        },
      },
      immutable: true,
      data: {
        "bindings.json": `${JSON.stringify(publicBinding, null, 2)}\n`,
      },
    },
    issuer("auth-broker-selfsigned", { selfSigned: {} }),
    caCertificate("auth-broker-service-ca"),
    issuer("auth-broker-service-ca", {
      ca: { secretName: "auth-broker-service-ca" },
    }),
    caCertificate("auth-broker-egress-ca"),
    issuer("auth-broker-egress-ca", {
      ca: { secretName: "auth-broker-egress-ca" },
    }),
  ];
  for (const role of broker.roles) {
    items.push(
      {
        apiVersion: "v1",
        kind: "ServiceAccount",
        metadata: {
          ...metadata(role.serviceAccount),
          annotations: {
            "seorilabs.io/google-service-account": role.googleServiceAccount,
            "seorilabs.io/workload-identity-status": "planned",
          },
        },
        automountServiceAccountToken: false,
      },
      {
        apiVersion: "v1",
        kind: "Service",
        metadata: metadata(role.serviceAccount),
        spec: {
          selector: { "app.kubernetes.io/name": appName(role.name) },
          ports: [
            {
              name: "mtls",
              port: role.servicePort,
              targetPort: "mtls",
              protocol: "TCP",
            },
          ],
        },
      },
      serviceCertificate(role),
      egressCertificate(role),
    );
  }
  items.push(
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: metadata("auth-broker-no-kubernetes-api"),
      rules: [],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: metadata("auth-broker-no-kubernetes-api"),
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: "auth-broker-no-kubernetes-api",
      },
      subjects: broker.roles.map((role) => ({
        kind: "ServiceAccount",
        name: role.serviceAccount,
        namespace: broker.namespace,
      })),
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: metadata("default-deny"),
      spec: {
        podSelector: {},
        policyTypes: ["Ingress", "Egress"],
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: metadata("broker-allowed-traffic"),
      spec: {
        podSelector: {
          matchLabels: { "app.kubernetes.io/name": "seori-auth-broker" },
        },
        policyTypes: ["Ingress", "Egress"],
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: {
                    "kubernetes.io/metadata.name":
                      broker.trustedWorkers.namespaceLabel,
                  },
                },
                podSelector: {
                  matchLabels: {
                    "seorilabs.io/auth-client":
                      broker.trustedWorkers.podLabel,
                  },
                },
              },
              {
                namespaceSelector: {
                  matchLabels: {
                    "kubernetes.io/metadata.name":
                      broker.providerControlPlane.peer.namespaceLabel,
                  },
                },
                podSelector: {
                  matchLabels: {
                    "app.kubernetes.io/component":
                      broker.providerControlPlane.peer.podLabel,
                  },
                },
              },
            ],
            ports: [{ protocol: "TCP", port: 8443 }],
          },
        ],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                },
                podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
              },
            ],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: {
                    "kubernetes.io/metadata.name":
                      broker.egressProxy.peer.namespaceLabel,
                  },
                },
                podSelector: {
                  matchLabels: {
                    "app.kubernetes.io/name": broker.egressProxy.peer.podLabel,
                  },
                },
              },
            ],
            ports: [{ protocol: "TCP", port: broker.egressProxy.port }],
          },
          {
            to: [
              {
                podSelector: {
                  matchExpressions: [
                    {
                      key: "app.kubernetes.io/name",
                      operator: "In",
                      values: ["seori-password-loader", "seori-totp-signer"],
                    },
                  ],
                },
              },
            ],
            ports: [{ protocol: "TCP", port: 9443 }],
          },
        ],
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: metadata("factor-allowed-traffic"),
      spec: {
        podSelector: {
          matchExpressions: [
            {
              key: "app.kubernetes.io/name",
              operator: "In",
              values: ["seori-password-loader", "seori-totp-signer"],
            },
          ],
        },
        policyTypes: ["Ingress", "Egress"],
        ingress: [
          {
            from: [
              {
                podSelector: {
                  matchLabels: {
                    "app.kubernetes.io/name": "seori-auth-broker",
                  },
                },
              },
            ],
            ports: [{ protocol: "TCP", port: 9443 }],
          },
        ],
      },
    },
  );
  return { apiVersion: "v1", kind: "List", items };
}

const [command, ...extra] = process.argv.slice(2);
if (!commands.has(command) || extra.length !== 0) fail("P3_COMMAND_INVALID");
const contract = await loadContract();
const output =
  command === "github-app"
    ? githubApp(contract)
    : command === "custom-properties"
      ? customProperties(contract)
      : command === "pilot-values"
        ? pilotValues(contract)
        : command === "ruleset"
          ? ruleset(contract)
          : command === "cloud-build"
            ? contract.cloudBuild
            : command === "auth-broker-foundation"
              ? authBrokerFoundation(contract)
              : {
                  apiVersion: "v1",
                  kind: "List",
                  items: authBrokerFoundation(contract).items
                    .filter(({ kind }) => kind !== "Namespace")
                    .toReversed(),
                };
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
