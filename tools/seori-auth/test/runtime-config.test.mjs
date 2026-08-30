import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const entrypoint = fileURLToPath(new URL('../runtime/entrypoint.mjs', import.meta.url));
const configDigest = 'd'.repeat(64);
const googleServiceAccount = 'seori-auth-password@example-project.iam.gserviceaccount.com';
const wifAudience = '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/seori-auth/providers/microk8s';
const backofficeSpiffeId = 'spiffe://seorilabs.local/ns/platform/sa/provider-execution-signer';
const providerEndpointScope = '/internal/control-plane/provider-grants';
const stateAttestationFile = '/run/seori-auth-state-attestor/verified.json';
const stateAttestationSha256 = 'f'.repeat(64);
const hostEncryptionMarkerFile = '/var/lib/seori-auth/.seorilabs-host-encrypted-mount.json';
const hostEncryptionSha256 = 'e'.repeat(64);

function stateDeploymentArguments() {
  return [
    `--state-attestation-file=${stateAttestationFile}`,
    `--expected-state-attestation-sha256=${stateAttestationSha256}`,
    `--host-encryption-marker-file=${hostEncryptionMarkerFile}`,
    `--expected-host-encryption-sha256=${hostEncryptionSha256}`,
  ];
}

function passwordConfig() {
  return {
    schemaVersion: 1,
    role: 'password-loader',
    nativeHelperPath: '/opt/seori-auth/bin/seori-auth-native',
    nativeHelperSha256: 'a'.repeat(64),
    readinessFile: '/run/seori-auth/password-loader.ready',
    secretAccess: {
      nodeSha256: 'b'.repeat(64),
      childSha256: 'c'.repeat(64),
      configSha256: configDigest,
    },
    credentialBindings: [{
      credentialRef: 'shared/apps-in-toss/bot-password',
      credentialGeneration: 3,
      resourceName: 'projects/seorilabs-ci/secrets/apps-in-toss-password/versions/7',
    }],
    listen: { host: '0.0.0.0', port: 9443 },
    tls: {
      caPath: '/etc/seori-auth/tls/ca.crt',
      certificatePath: '/etc/seori-auth/tls/tls.crt',
      privateKeyPath: '/etc/seori-auth/tls/tls.key',
    },
    adapters: [{
      id: 'password-injector',
      executable: '/opt/seori-auth/adapters/password-injector',
      fixedArgs: [],
      providers: ['apps-in-toss'],
      capabilities: ['browser.password.inject'],
      timeoutMs: 10_000,
      maxOutputBytes: 1_024,
    }],
    allowedBrokerSpiffeIds: ['spiffe://seorilabs.local/ns/auth-broker/sa/auth-broker'],
    factorBindings: [{
      credentialRef: 'shared/apps-in-toss/bot-password',
      credentialGeneration: 3,
      factor: 'password',
      provider: 'apps-in-toss',
      accountId: 'automation-account',
    }],
  };
}

function brokerConfig() {
  return {
    schemaVersion: 2,
    role: 'broker',
    nativeHelperPath: '/opt/seori-auth/bin/seori-auth-native',
    nativeHelperSha256: 'a'.repeat(64),
    readinessFile: '/run/seori-auth/broker.ready',
    secretAccess: {
      nodeSha256: 'b'.repeat(64),
      childSha256: 'c'.repeat(64),
      configSha256: configDigest,
    },
    credentialBindings: [
      {
        credentialRef: 'shared/seori-auth/journal-mac',
        credentialGeneration: 2,
        resourceName: 'projects/seorilabs-ci/secrets/seori-auth-journal-mac/versions/2',
      },
      {
        credentialRef: 'shared/seori-auth/browser-vault',
        credentialGeneration: 3,
        resourceName: 'projects/seorilabs-ci/secrets/seori-auth-browser-vault/versions/3',
      },
      {
        credentialRef: 'shared/apps-in-toss/operator',
        credentialGeneration: 4,
        resourceName: 'projects/seorilabs-ci/secrets/apps-in-toss-operator/versions/4',
      },
    ],
    listen: { host: '0.0.0.0', port: 8443 },
    tls: {
      caPath: '/etc/seori-auth/tls/ca.crt',
      certificatePath: '/etc/seori-auth/tls/tls.crt',
      privateKeyPath: '/etc/seori-auth/tls/tls.key',
    },
    adapters: [{
      id: 'ait-cli-v1',
      executable: '/opt/seori-auth/adapters/ait-cli-v1',
      fixedArgs: ['execute-provider-command'],
      providers: ['apps-in-toss'],
      capabilities: ['ait.bundle.upload.private'],
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
    }],
    allowedClientSpiffeIds: [backofficeSpiffeId],
    bootstrapCredentials: {
      journalMac: {
        credentialRef: 'shared/seori-auth/journal-mac',
        credentialGeneration: 2,
      },
      browserVault: {
        credentialRef: 'shared/seori-auth/browser-vault',
        credentialGeneration: 3,
      },
    },
    browserRuntimeDirectory: '/run/seori-auth/browser-runtime',
    journalCheckpoint: {
      schemaVersion: 1,
      journalId: 'seori-auth-production',
      authoritySpiffeId: backofficeSpiffeId,
      mode: 'TRUSTED_CONTROL_PLANE_CAS',
      persistence: 'BACKOFFICE_DURABLE_CAS',
      commitOrder: 'JOURNAL_FSYNC_THEN_CHECKPOINT_CAS',
      unknownOutcomePolicy: 'READBACK_FIRST',
    },
    policyPath: '/etc/seori-auth/policy.json',
    runAttestationPublicKeyPath: '/etc/seori-auth/run-attestation.pub',
    stateDirectory: '/var/lib/seori-auth/state',
    vaultDirectory: '/var/lib/seori-auth/browser-vault',
    providerControlPlane: {
      backofficeClientSpiffeId: backofficeSpiffeId,
      endpointScope: providerEndpointScope,
    },
  };
}

async function validate(config, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'seori-auth-runtime-config-'));
  const path = join(root, 'runtime.json');
  try {
    await writeFile(path, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    return await execFileAsync(process.execPath, [
      entrypoint,
      'validate-config',
      `--config=${await realpath(path)}`,
      `--expected-secret-access-sha256=${configDigest}`,
      `--expected-google-service-account=${overrides.googleServiceAccount ?? googleServiceAccount}`,
      `--expected-wif-audience=${wifAudience}`,
      `--expected-backoffice-spiffe-id=${overrides.backofficeSpiffeId ?? backofficeSpiffeId}`,
      `--expected-provider-endpoint-scope=${overrides.providerEndpointScope ?? providerEndpointScope}`,
      ...(config.role === 'broker' && overrides.omitStateAttestation !== true
        ? stateDeploymentArguments() : []),
      ...(overrides.factorStateAttestation === true ? stateDeploymentArguments() : []),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('validate-config uses the same strict password runtime schema as serve', async () => {
  const result = await validate(passwordConfig());
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    valid: true,
    schemaVersion: 1,
    role: 'password-loader',
  });
});

test('validate-config rejects a role marker without the complete runtime contract', async () => {
  await assert.rejects(validate({ schemaVersion: 1, role: 'password-loader' }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /runtime_error/);
    return true;
  });
});

test('password runtime cannot map its factor binding to a different logical credential', async () => {
  const config = passwordConfig();
  config.factorBindings[0].credentialRef = 'shared/apps-in-toss/bot-totp';
  await assert.rejects(validate(config), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /runtime_error/);
    assert.doesNotMatch(error.stderr, /bot-password|bot-totp|resourceName/);
    return true;
  });
});

test('runtime rejects undeclared extension fields and a checksum not bound by the rendered workload', async () => {
  const extended = passwordConfig();
  extended.debug = true;
  await assert.rejects(validate(extended), (error) => error.code === 1);

  const drifted = passwordConfig();
  drifted.secretAccess.configSha256 = 'e'.repeat(64);
  await assert.rejects(validate(drifted), (error) => error.code === 1);
});

test('broker runtime exact-binds the Backoffice SPIFFE identity and internal provider endpoint scope', async () => {
  const config = brokerConfig();
  const result = await validate(config, {
    googleServiceAccount: 'seori-auth-broker@example-project.iam.gserviceaccount.com',
  });
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { valid: true, schemaVersion: 2, role: 'broker' });

  const driftedSpiffe = brokerConfig();
  driftedSpiffe.providerControlPlane.backofficeClientSpiffeId =
    'spiffe://seorilabs.local/ns/platform/sa/other-worker';
  await assert.rejects(
    validate(driftedSpiffe, {
      googleServiceAccount: 'seori-auth-broker@example-project.iam.gserviceaccount.com',
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /runtime_error/);
      assert.doesNotMatch(error.stderr, /other-worker|provider-execution-signer/);
      return true;
    },
  );

  const driftedCheckpointAuthority = brokerConfig();
  driftedCheckpointAuthority.journalCheckpoint.authoritySpiffeId =
    'spiffe://seorilabs.local/ns/platform/sa/other-worker';
  await assert.rejects(
    validate(driftedCheckpointAuthority, {
      googleServiceAccount: 'seori-auth-broker@example-project.iam.gserviceaccount.com',
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.doesNotMatch(error.stderr, /other-worker|provider-execution-signer/);
      return true;
    },
  );

  const legacyStaticHead = brokerConfig();
  legacyStaticHead.schemaVersion = 1;
  legacyStaticHead.expectedJournalHeadMac = 'e'.repeat(64);
  delete legacyStaticHead.journalCheckpoint;
  await assert.rejects(
    validate(legacyStaticHead, {
      googleServiceAccount: 'seori-auth-broker@example-project.iam.gserviceaccount.com',
    }),
    (error) => error.code === 1,
  );
});

test('broker는 exact state attestation deployment binding을 요구하고 factor는 이를 거부한다', async () => {
  await assert.rejects(
    validate(brokerConfig(), {
      googleServiceAccount: 'seori-auth-broker@example-project.iam.gserviceaccount.com',
      omitStateAttestation: true,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /runtime_error/);
      return true;
    },
  );
  await assert.rejects(
    validate(passwordConfig(), { factorStateAttestation: true }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /runtime_error/);
      return true;
    },
  );
});

test('broker healthcheck removes readiness when encrypted-state attestation cannot be revalidated', async () => {
  const source = await readFile(entrypoint, 'utf8');
  assert.match(source, /validateHostEncryptedMountMarkerDigest/u);
  assert.match(source, /await rm\(path, \{ force: true \}\)/u);
});
