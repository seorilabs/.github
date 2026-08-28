import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EncryptedBrowserVault, SeoriAuthError } from '../src/index.mjs';

const SOURCE_SHA = '1'.repeat(40);

function identity(overrides = {}) {
  return {
    provider: 'apps-in-toss',
    accountId: 'automation-account',
    teamId: 'seorilabs-team',
    workspaceId: 'release-workspace',
    appId: 'example-app',
    ...overrides,
  };
}

function ids() {
  let value = 0;
  return () => `capability-${++value}`;
}

function binding(overrides = {}) {
  return {
    subject: 'k8s:release-workers:worker-a',
    runId: 'github:123',
    repository: 'seorilabs/example-app',
    workerId: 'worker-a',
    ...overrides,
  };
}

async function allFileContents(directory) {
  const values = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else values.push(await readFile(child));
    }
  }
  await visit(directory);
  return Buffer.concat(values).toString('utf8');
}

test('Browser Vault encrypts persistent profiles, clones ephemerally, and locks one account across roles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seori-browser-vault-'));
  const source = join(root, 'source');
  const secondSource = join(root, 'source-operator');
  const vaultDirectory = join(root, 'vault');
  const runtimeDirectory = join(root, 'runtime');
  const key = Buffer.alloc(32, 0x2a);
  const contenderKey = Buffer.alloc(32, 0x2a);
  const cookieCanary = 'fake-cookie-canary-value';
  let now = 1_700_000_000_000;
  let vault;
  let contender;
  try {
    await mkdir(join(source, 'Default'), { recursive: true, mode: 0o700 });
    await writeFile(join(source, 'Default', 'Cookies'), cookieCanary, { mode: 0o600 });
    await mkdir(secondSource, { mode: 0o700 });
    await writeFile(join(secondSource, 'state.json'), '{"public":true}', { mode: 0o600 });
    vault = await EncryptedBrowserVault.open({
      vaultDirectory,
      runtimeDirectory,
      encryptionKey: key,
      clock: () => now,
      idFactory: ids(),
    });
    await vault.registerProfile({ sourceDirectory: source, role: 'release', publicIdentity: identity() });
    await vault.registerProfile({ sourceDirectory: secondSource, role: 'operator', publicIdentity: identity() });
    contender = await EncryptedBrowserVault.open({
      vaultDirectory,
      runtimeDirectory,
      encryptionKey: contenderKey,
      clock: () => now,
      idFactory: () => 'contender-capability',
    });

    const persisted = await allFileContents(vaultDirectory);
    assert.doesNotMatch(persisted, new RegExp(cookieCanary));
    assert.doesNotMatch(persisted, new RegExp(Buffer.from(cookieCanary).toString('base64')));
    assert.doesNotMatch(persisted, /Default|Cookies/);

    const checkout = await vault.checkout({
      role: 'release',
      expectedIdentity: identity(),
      expectedGeneration: 1,
      executionBinding: binding(),
      sourceSha: SOURCE_SHA,
    });
    assert.deepEqual(Object.keys(checkout).sort(), ['capabilityId', 'expiresAt', 'generation', 'publicIdentity']);
    assert.doesNotMatch(JSON.stringify(checkout), /cookie|profile|path|fake-cookie/i);
    await assert.rejects(
      contender.checkout({
        role: 'operator',
        expectedIdentity: identity(),
        expectedGeneration: 1,
        executionBinding: binding(),
        sourceSha: SOURCE_SHA,
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'browser_account_in_use',
    );

    let clonePath;
    for (const mismatch of [
      binding({ subject: 'k8s:other-namespace:worker-a' }),
      binding({ runId: 'github:other' }),
      binding({ repository: 'seorilabs/other-app' }),
      binding({ workerId: 'worker-b' }),
    ]) {
      await assert.rejects(
        vault.withClone({
          capabilityId: checkout.capabilityId,
          executionBinding: mismatch,
          sourceSha: SOURCE_SHA,
        }, async () => {}),
        (error) => error instanceof SeoriAuthError && error.code === 'browser_session_binding_mismatch',
      );
    }
    await assert.rejects(
      vault.withClone({
        capabilityId: checkout.capabilityId,
        executionBinding: binding(),
        sourceSha: '2'.repeat(40),
      }, async () => {}),
      (error) => error instanceof SeoriAuthError && error.code === 'browser_session_binding_mismatch',
    );
    await assert.rejects(
      vault.withClone({
        capabilityId: checkout.capabilityId,
        executionBinding: binding(),
        sourceSha: SOURCE_SHA,
      }, async () => { throw new Error(cookieCanary); }),
      (error) =>
        error instanceof SeoriAuthError &&
        error.code === 'browser_adapter_failed' &&
        !error.message.includes(cookieCanary),
    );
    const execution = await vault.withClone({
      capabilityId: checkout.capabilityId,
      executionBinding: binding(),
      sourceSha: SOURCE_SHA,
    }, async (path) => {
      clonePath = path;
      assert.equal(await readFile(join(path, 'Default', 'Cookies'), 'utf8'), cookieCanary);
      await writeFile(join(path, 'Default', 'Cookies'), 'rotated-fake-cookie', { mode: 0o600 });
      return path;
    });
    assert.deepEqual(execution, { status: 'EXECUTED' });
    assert.doesNotMatch(JSON.stringify(execution), /checkout-|profile|path/i);
    await assert.rejects(
      vault.complete({
        capabilityId: checkout.capabilityId,
        executionBinding: binding({ workerId: 'worker-b' }),
        sourceSha: SOURCE_SHA,
        observedIdentity: identity(),
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'browser_session_binding_mismatch',
    );
    const completed = await vault.complete({
      capabilityId: checkout.capabilityId,
      executionBinding: binding(),
      sourceSha: SOURCE_SHA,
      observedIdentity: identity(),
    });
    assert.equal(completed.state, 'COMPLETED');
    assert.equal(completed.generation, 2);
    await assert.rejects(stat(clonePath), (error) => error.code === 'ENOENT');

    await assert.rejects(
      vault.checkout({
        role: 'release',
        expectedIdentity: identity(),
        expectedGeneration: 1,
        executionBinding: binding(),
        sourceSha: SOURCE_SHA,
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'browser_profile_generation_mismatch',
    );
    const replay = await vault.checkout({
      role: 'release',
      expectedIdentity: identity(),
      expectedGeneration: 2,
      executionBinding: binding(),
      sourceSha: SOURCE_SHA,
    });
    await vault.withClone({
      capabilityId: replay.capabilityId,
      executionBinding: binding(),
      sourceSha: SOURCE_SHA,
    }, async (path) => {
      assert.equal(await readFile(join(path, 'Default', 'Cookies'), 'utf8'), 'rotated-fake-cookie');
    });
    await assert.rejects(
      vault.complete({
        capabilityId: replay.capabilityId,
        executionBinding: binding(),
        sourceSha: SOURCE_SHA,
        observedIdentity: identity({ workspaceId: 'wrong-workspace' }),
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'identity_readback_mismatch',
    );
    const afterMismatch = await vault.checkout({
      role: 'operator',
      expectedIdentity: identity(),
      expectedGeneration: 1,
      executionBinding: binding(),
      sourceSha: SOURCE_SHA,
    });
    now += 300_000;
    await assert.rejects(
      vault.withClone({
        capabilityId: afterMismatch.capabilityId,
        executionBinding: binding(),
        sourceSha: SOURCE_SHA,
      }, async () => {}),
      (error) => error instanceof SeoriAuthError && error.code === 'browser_capability_expired',
    );
  } finally {
    if (contender) await contender.close();
    if (vault) await vault.close();
    key.fill(0);
    contenderKey.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test('Browser Vault refuses symbolic links in a filesystem profile reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seori-browser-vault-symlink-'));
  const source = join(root, 'source');
  const outside = join(root, 'outside-cookie');
  const key = Buffer.alloc(32, 0x3b);
  let vault;
  try {
    await mkdir(source, { mode: 0o700 });
    await writeFile(outside, 'fake-outside-cookie', { mode: 0o600 });
    await symlink(outside, join(source, 'Cookies'));
    vault = await EncryptedBrowserVault.open({
      vaultDirectory: join(root, 'vault'),
      runtimeDirectory: join(root, 'runtime'),
      encryptionKey: key,
    });
    await assert.rejects(
      vault.registerProfile({ sourceDirectory: source, role: 'release', publicIdentity: identity() }),
      (error) => error instanceof SeoriAuthError && error.code === 'invalid_browser_profile',
    );
  } finally {
    if (vault) await vault.close();
    key.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});
