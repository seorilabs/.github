import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  CanaryExecutionError,
  executeNonsecretCanary,
} from '../scripts/execute-nonsecret-canary-k8s.mjs';
import {
  APPROVED_IMAGE_BINDING,
  EXPECTED_CANARY_OUTPUT_SHA256,
} from '../scripts/public-image-binding.mjs';
import {
  canaryOccurrence,
  renderCanaryManifest,
  validateCanaryConfig,
} from '../scripts/render-nonsecret-canary-k8s.mjs';

const execFileAsync = promisify(execFile);
const executorPath = fileURLToPath(
  new URL('../scripts/execute-nonsecret-canary-k8s.mjs', import.meta.url),
);

function config(registry = { mode: 'PUBLIC', visibilityStatus: 'VERIFIED_PUBLIC' }) {
  return validateCanaryConfig({
    schemaVersion: 1,
    namespace: 'auth-broker',
    image: APPROVED_IMAGE_BINDING.image,
    imageProvenance: { ...APPROVED_IMAGE_BINDING.imageProvenance },
    registry,
    canary: {
      contractVersion: 1,
      kind: 'NON_SECRET_BUILTIN',
      kubernetesContext: 'vzyx-cluster',
      serviceAccountName: 'seori-auth-canary',
      createPolicy: 'SERVER_DRY_RUN_THEN_CREATE_IF_ABSENT',
      publicPullBinding: 'NO_IMAGE_PULL_SECRETS',
      packagesReaderPullBinding: 'EXACT_CANONICAL_ONE',
      nodeSelector: { 'kubernetes.io/hostname': 'rpi5' },
      activeDeadlineSeconds: 300,
      expectedOutputSha256: EXPECTED_CANARY_OUTPUT_SHA256,
      idempotency: {
        markerKind: 'Job',
        key: 'image-source-contract-sha256',
        existingPolicy: 'READBACK_ONLY',
        unknownOutcomePolicy: 'READBACK_FIRST',
      },
    },
  });
}

function key(kind, name) {
  return `${kind}/${name}`;
}

function live(resource, suffix = '1') {
  const copy = structuredClone(resource);
  copy.metadata.uid = `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
  copy.metadata.resourceVersion = suffix;
  if (copy.kind === 'Job') {
    copy.spec.completionMode = 'NonIndexed';
    copy.spec.manualSelector = false;
    copy.spec.suspend = false;
    copy.spec.selector = {
      matchLabels: { 'batch.kubernetes.io/controller-uid': copy.metadata.uid },
    };
    copy.spec.template.metadata.labels = {
      ...copy.spec.template.metadata.labels,
      'batch.kubernetes.io/controller-uid': copy.metadata.uid,
      'controller-uid': copy.metadata.uid,
      'batch.kubernetes.io/job-name': copy.metadata.name,
      'job-name': copy.metadata.name,
    };
  }
  return copy;
}

class FakeAdapter {
  constructor() {
    this.context = 'vzyx-cluster';
    this.resources = new Map();
    this.pods = [];
    this.createCalls = [];
    this.dryRunCalls = [];
    this.getCalls = [];
    this.logCalls = [];
    this.createBehavior = new Map();
  }

  async currentContext() {
    return this.context;
  }

  async get(kind, name) {
    this.getCalls.push(key(kind, name));
    const value = this.resources.get(key(kind, name));
    return value === undefined ? null : structuredClone(value);
  }

  async serverDryRun(resource) {
    this.dryRunCalls.push(key(resource.kind, resource.metadata.name));
    return live(resource, `9${this.dryRunCalls.length}`);
  }

  async create(resource) {
    const resourceKey = key(resource.kind, resource.metadata.name);
    this.createCalls.push(resourceKey);
    const behavior = this.createBehavior.get(resource.kind);
    if (behavior !== 'fail-before-commit') {
      if (this.resources.has(resourceKey)) throw new Error('AlreadyExists');
      this.resources.set(resourceKey, live(resource, String(this.createCalls.length)));
    }
    if (behavior === 'fail-before-commit' || behavior === 'fail-after-commit') {
      throw new Error('unknown create result');
    }
    return structuredClone(this.resources.get(resourceKey));
  }

  async listPods() {
    return structuredClone(this.pods);
  }

  async verifyCanaryLog(namespace, podName, containerName) {
    this.logCalls.push({ namespace, podName, containerName });
    return {
      state: 'CANARY_OUTPUT_VERIFIED',
      sha256: EXPECTED_CANARY_OUTPUT_SHA256,
    };
  }
}

function expected(configValue) {
  const items = renderCanaryManifest(configValue).items;
  return {
    serviceAccount: items.find(({ kind }) => kind === 'ServiceAccount'),
    networkPolicy: items.find(({ kind }) => kind === 'NetworkPolicy'),
    job: items.find(({ kind }) => kind === 'Job'),
  };
}

function complete(adapter, configValue) {
  const occurrence = canaryOccurrence(configValue);
  const jobKey = key('Job', occurrence.jobName);
  const job = structuredClone(adapter.resources.get(jobKey));
  job.status = {
    succeeded: 1,
    conditions: [{ type: 'Complete', status: 'True' }],
  };
  adapter.resources.set(jobKey, job);
  adapter.pods = [{
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `${occurrence.jobName}-pod`,
      namespace: configValue.namespace,
      uid: '10000000-0000-4000-8000-000000000001',
      labels: structuredClone(job.spec.template.metadata.labels),
      annotations: structuredClone(job.spec.template.metadata.annotations),
      ownerReferences: [{
        apiVersion: 'batch/v1',
        kind: 'Job',
        name: occurrence.jobName,
        uid: job.metadata.uid,
        controller: true,
      }],
    },
    spec: structuredClone(job.spec.template.spec),
    status: {
      containerStatuses: [{
        name: 'canary',
        imageID: `docker-pullable://${configValue.image}`,
        state: { terminated: { exitCode: 0 } },
      }],
    },
  }];
}

test('executor creates exact support objects and Job once, then only reads them back', async () => {
  const adapter = new FakeAdapter();
  const configValue = config();
  const first = await executeNonsecretCanary(configValue, adapter);
  const createdCalls = [...adapter.createCalls];
  const dryRunCalls = [...adapter.dryRunCalls];
  const resources = expected(configValue);

  assert.equal(first.state, 'CANARY_PENDING');
  assert.equal(first.source, 'CREATED');
  assert.deepEqual(createdCalls, [
    key('ServiceAccount', 'seori-auth-canary'),
    key('NetworkPolicy', resources.networkPolicy.metadata.name),
    key('Job', resources.job.metadata.name),
  ]);
  assert.deepEqual(dryRunCalls, createdCalls);
  assert.deepEqual(
    adapter.resources.get(key('ServiceAccount', 'seori-auth-canary')).imagePullSecrets,
    [],
  );
  assert.equal(resources.job.spec.template.spec.serviceAccountName, 'seori-auth-canary');
  assert.equal('imagePullSecrets' in resources.job.spec.template.spec, false);

  const second = await executeNonsecretCanary(configValue, adapter);
  assert.equal(second.state, 'CANARY_PENDING');
  assert.equal(second.source, 'READBACK_ONLY');
  assert.deepEqual(adapter.createCalls, createdCalls);
  assert.deepEqual(adapter.dryRunCalls, dryRunCalls);
});

test('existing successful Job verifies its exact Pod log without mutation', async () => {
  const adapter = new FakeAdapter();
  const configValue = config();
  await executeNonsecretCanary(configValue, adapter);
  complete(adapter, configValue);
  const createCount = adapter.createCalls.length;

  const result = await executeNonsecretCanary(configValue, adapter);

  assert.deepEqual(result, {
    state: 'CANARY_OUTPUT_VERIFIED',
    source: 'READBACK_ONLY',
    jobName: canaryOccurrence(configValue).jobName,
    idempotencyKey: canaryOccurrence(configValue).idempotencyKey,
    imageDigest: APPROVED_IMAGE_BINDING.imageProvenance.imageDigest,
    outputSha256: EXPECTED_CANARY_OUTPUT_SHA256,
  });
  assert.equal(adapter.createCalls.length, createCount);
  assert.deepEqual(adapter.logCalls, [{
    namespace: 'auth-broker',
    podName: `${canaryOccurrence(configValue).jobName}-pod`,
    containerName: 'canary',
  }]);
});

test('PUBLIC admitted Pod rejects injected pull credentials and credential annotations', async () => {
  for (const [mutate, expectedCode] of [
    [
      (pod) => {
        pod.spec.imagePullSecrets = [{ name: 'unexpected-private-pull' }];
      },
      'CANARY_IMAGE_PULL_BINDING_DRIFT',
    ],
    [
      (pod) => {
        pod.metadata.annotations['vault.example.io/agent-inject-secret-session'] = 'enabled';
      },
      'CANARY_CREDENTIAL_ANNOTATION_INJECTED',
    ],
  ]) {
    const adapter = new FakeAdapter();
    const configValue = config();
    await executeNonsecretCanary(configValue, adapter);
    complete(adapter, configValue);
    mutate(adapter.pods[0]);

    await assert.rejects(
      executeNonsecretCanary(configValue, adapter),
      (error) => {
        assert.ok(error instanceof CanaryExecutionError);
        assert.equal(error.code, expectedCode);
        return true;
      },
    );
  }
});

test('PACKAGES_READER admitted Pod allows only the canonical one-secret binding', async () => {
  const registry = {
    mode: 'PACKAGES_READER',
    imagePullSecretName: 'seori-auth-ghcr-pull',
    credentialId: 'shared/github/packages-reader',
    catalogStatus: 'ACTIVE',
    kubernetesStatus: 'VERIFIED',
  };
  const adapter = new FakeAdapter();
  const configValue = config(registry);
  await executeNonsecretCanary(configValue, adapter);
  complete(adapter, configValue);
  const valid = await executeNonsecretCanary(configValue, adapter);
  assert.equal(valid.state, 'CANARY_OUTPUT_VERIFIED');
  assert.deepEqual(adapter.pods[0].spec.imagePullSecrets, [{ name: 'seori-auth-ghcr-pull' }]);

  adapter.pods[0].spec.imagePullSecrets.push({ name: 'extra' });
  await assert.rejects(
    executeNonsecretCanary(configValue, adapter),
    (error) => {
      assert.equal(error.code, 'CANARY_IMAGE_PULL_BINDING_DRIFT');
      return true;
    },
  );
});

test('unknown create result reads back once and never retries', async () => {
  const committed = new FakeAdapter();
  committed.createBehavior.set('Job', 'fail-after-commit');
  const committedResult = await executeNonsecretCanary(config(), committed);
  assert.equal(committedResult.state, 'CANARY_PENDING');
  assert.equal(committedResult.source, 'READBACK_FIRST');
  assert.equal(committed.createCalls.filter((value) => value.startsWith('Job/')).length, 1);

  const absent = new FakeAdapter();
  absent.createBehavior.set('Job', 'fail-before-commit');
  await assert.rejects(
    executeNonsecretCanary(config(), absent),
    (error) => {
      assert.equal(error.code, 'CANARY_CREATE_RESULT_UNKNOWN');
      return true;
    },
  );
  assert.equal(absent.createCalls.filter((value) => value.startsWith('Job/')).length, 1);
});

test('an existing Job with missing support state never recreates anything', async () => {
  const adapter = new FakeAdapter();
  const configValue = config();
  const resources = expected(configValue);
  adapter.resources.set(key('Job', resources.job.metadata.name), live(resources.job));

  await assert.rejects(
    executeNonsecretCanary(configValue, adapter),
    (error) => {
      assert.equal(error.code, 'CANARY_SUPPORT_STATE_MISSING');
      return true;
    },
  );
  assert.deepEqual(adapter.createCalls, []);
  assert.deepEqual(adapter.dryRunCalls, []);
});

test('existing ServiceAccount, NetworkPolicy, and Job drift all fail before mutation', async () => {
  for (const mutate of [
    (adapter) => {
      adapter.resources.get(key('ServiceAccount', 'seori-auth-canary')).imagePullSecrets = [
        { name: 'injected' },
      ];
    },
    (adapter, configValue) => {
      const name = canaryOccurrence(configValue).networkPolicyName;
      adapter.resources.get(key('NetworkPolicy', name)).spec.egress = [{}];
    },
    (adapter, configValue) => {
      const name = canaryOccurrence(configValue).jobName;
      adapter.resources.get(key('Job', name)).spec.template.spec.containers[0].args = ['serve'];
    },
  ]) {
    const adapter = new FakeAdapter();
    const configValue = config();
    await executeNonsecretCanary(configValue, adapter);
    const createCount = adapter.createCalls.length;
    mutate(adapter, configValue);
    await assert.rejects(executeNonsecretCanary(configValue, adapter), CanaryExecutionError);
    assert.equal(adapter.createCalls.length, createCount);
  }
});

test('mixed absent and drifted support state is fully read before any create', async () => {
  const adapter = new FakeAdapter();
  const configValue = config();
  const resources = expected(configValue);
  const networkPolicy = live(resources.networkPolicy);
  networkPolicy.spec.egress = [{}];
  adapter.resources.set(
    key('NetworkPolicy', resources.networkPolicy.metadata.name),
    networkPolicy,
  );

  await assert.rejects(
    executeNonsecretCanary(configValue, adapter),
    (error) => {
      assert.equal(error.code, 'CANARY_NETWORK_POLICY_DRIFT');
      return true;
    },
  );
  assert.deepEqual(adapter.createCalls, []);
  assert.deepEqual(adapter.dryRunCalls, []);
});

test('admitted Pod accepts only the exact Kubernetes scheduling defaults on RPI5', async () => {
  const adapter = new FakeAdapter();
  const configValue = config();
  await executeNonsecretCanary(configValue, adapter);
  complete(adapter, configValue);
  Object.assign(adapter.pods[0].spec, {
    nodeName: 'rpi5',
    preemptionPolicy: 'PreemptLowerPriority',
    priority: 0,
    tolerations: [
      {
        effect: 'NoExecute',
        key: 'node.kubernetes.io/not-ready',
        operator: 'Exists',
        tolerationSeconds: 300,
      },
      {
        effect: 'NoExecute',
        key: 'node.kubernetes.io/unreachable',
        operator: 'Exists',
        tolerationSeconds: 300,
      },
    ],
  });

  const result = await executeNonsecretCanary(configValue, adapter);
  assert.equal(result.state, 'CANARY_OUTPUT_VERIFIED');

  adapter.pods[0].spec.nodeName = 'rpi4';
  await assert.rejects(
    executeNonsecretCanary(configValue, adapter),
    (error) => {
      assert.equal(error.code, 'CANARY_POD_SPEC_DRIFT');
      return true;
    },
  );
});

test('executor child boundary uses spawn without shell and a minimal environment', async () => {
  const source = await readFile(
    new URL('../scripts/execute-nonsecret-canary-k8s.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /spawn\(executable, args/u);
  assert.match(source, /shell: false/u);
  assert.doesNotMatch(source, /execFile|\bexec\(/u);
  assert.doesNotMatch(source, /\.\.\.process\.env/u);
  assert.match(source, /\['HOME', 'KUBECONFIG', 'SSL_CERT_DIR', 'SSL_CERT_FILE'\]/u);
});

test('executor CLI reflects neither config details nor ambient secret-shaped environment', async () => {
  const marker = 'DO_NOT_REFLECT_EXECUTOR_SECRET';
  await assert.rejects(
    execFileAsync(process.execPath, [executorPath, '--config=relative.json'], {
      env: { ...process.env, HOSTILE_SECRET_MARKER: marker },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.deepEqual(JSON.parse(error.stderr), {
        valid: false,
        code: 'invalid_canary_config',
      });
      assert.doesNotMatch(`${error.stdout}${error.stderr}`, new RegExp(marker, 'u'));
      return true;
    },
  );
});
