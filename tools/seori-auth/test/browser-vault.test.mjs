import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { EncryptedBrowserVault, SeoriAuthError } from '../src/index.mjs';
import { makeNativeLockProvider } from '../fixtures/helpers.mjs';

const SOURCE_SHA = '1'.repeat(40);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const nativeHelper = join(packageRoot, '.build', 'seori-auth-native');
const crashFixture = fileURLToPath(new URL('../fixtures/browser-vault-crash-child.mjs', import.meta.url));
const cleanupCommand = fileURLToPath(new URL('../scripts/cleanup-browser-runtime.mjs', import.meta.url));

function childCompletion(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function firstLine(child) {
  return new Promise((resolve, reject) => {
    let value = '';
    child.once('error', reject);
    child.stdout.on('data', (chunk) => {
      value += chunk.toString('utf8');
      if (value.length > 256) reject(new Error('child output exceeded bound'));
      const newline = value.indexOf('\n');
      if (newline >= 0) resolve(value.slice(0, newline));
    });
    child.once('close', (code, signal) => reject(new Error(`child closed before ready: ${code}/${signal}`)));
  });
}

async function lockOutcome(child) {
  const completion = childCompletion(child);
  try {
    const line = await firstLine(child);
    assert.deepEqual(JSON.parse(line), { locked: true });
    return { outcome: 'acquired', child, completion };
  } catch {
    const result = await completion;
    return { outcome: 'blocked', result };
  }
}

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
      lockProvider: await makeNativeLockProvider(),
    });
    await vault.registerProfile({ sourceDirectory: source, role: 'release', publicIdentity: identity() });
    await vault.registerProfile({ sourceDirectory: secondSource, role: 'operator', publicIdentity: identity() });
    contender = await EncryptedBrowserVault.open({
      vaultDirectory,
      runtimeDirectory,
      encryptionKey: contenderKey,
      clock: () => now,
      idFactory: () => 'contender-capability',
      lockProvider: await makeNativeLockProvider(),
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
      lockProvider: await makeNativeLockProvider(),
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

test('Browser Vault removes TTL-expired plaintext clones and releases the account lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seori-browser-vault-ttl-'));
  const source = join(root, 'source');
  const key = Buffer.alloc(32, 0x4c);
  let vault;
  try {
    await mkdir(source, { mode: 0o700 });
    await writeFile(join(source, 'Cookies'), 'fake-ttl-cookie', { mode: 0o600 });
    vault = await EncryptedBrowserVault.open({
      vaultDirectory: join(root, 'vault'),
      runtimeDirectory: join(root, 'runtime'),
      encryptionKey: key,
      lockProvider: await makeNativeLockProvider(),
      ttlMs: 1_000,
    });
    await vault.registerProfile({ sourceDirectory: source, role: 'release', publicIdentity: identity() });
    const checkout = await vault.checkout({
      role: 'release',
      expectedIdentity: identity(),
      expectedGeneration: 1,
      executionBinding: binding(),
      sourceSha: SOURCE_SHA,
    });
    let cloneDirectory;
    await vault.withClone({
      capabilityId: checkout.capabilityId,
      executionBinding: binding(),
      sourceSha: SOURCE_SHA,
    }, async (path) => { cloneDirectory = path; });

    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      try {
        await stat(cloneDirectory);
      } catch (error) {
        if (error.code === 'ENOENT') break;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await assert.rejects(stat(cloneDirectory), (error) => error.code === 'ENOENT');
    await assert.rejects(
      vault.withClone({
        capabilityId: checkout.capabilityId,
        executionBinding: binding(),
        sourceSha: SOURCE_SHA,
      }, async () => {}),
      (error) => error instanceof SeoriAuthError &&
        ['browser_capability_expired', 'browser_capability_invalid'].includes(error.code),
    );
    const recovered = await vault.checkout({
      role: 'release',
      expectedIdentity: identity(),
      expectedGeneration: 1,
      executionBinding: binding(),
      sourceSha: SOURCE_SHA,
    });
    await vault.abort({
      capabilityId: recovered.capabilityId,
      executionBinding: binding(),
      sourceSha: SOURCE_SHA,
    });
  } finally {
    if (vault) await vault.close();
    key.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test('Browser Vault startup removes a clone left by a killed broker without exposing its path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seori-browser-vault-crash-'));
  const source = join(root, 'source');
  const vaultDirectory = join(root, 'vault');
  const runtimeDirectory = join(root, 'runtime');
  const key = Buffer.alloc(32, 0x5c);
  let bootstrap;
  let restarted;
  let crashedChild;
  try {
    await mkdir(source, { mode: 0o700 });
    await writeFile(join(source, 'Cookies'), 'fake-crash-cookie', { mode: 0o600 });
    bootstrap = await EncryptedBrowserVault.open({
      vaultDirectory,
      runtimeDirectory,
      encryptionKey: key,
      lockProvider: await makeNativeLockProvider(),
    });
    await bootstrap.registerProfile({ sourceDirectory: source, role: 'release', publicIdentity: identity() });
    await bootstrap.close();
    bootstrap = undefined;

    crashedChild = spawn(process.execPath, [crashFixture, vaultDirectory, runtimeDirectory, nativeHelper], {
      env: { LANG: 'C.UTF-8' },
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const crashedCompletion = childCompletion(crashedChild);
    assert.deepEqual(JSON.parse(await firstLine(crashedChild)), { status: 'CHECKED_OUT' });
    const beforeCrash = (await readdir(runtimeDirectory)).filter((name) => name.startsWith('checkout-'));
    assert.equal(beforeCrash.length, 1);
    assert.doesNotMatch(JSON.stringify({ status: 'CHECKED_OUT' }), /checkout-|cookie|path/i);
    crashedChild.kill('SIGKILL');
    const crashResult = await crashedCompletion;
    assert.equal(crashResult.signal, 'SIGKILL');
    crashedChild = undefined;

    await new Promise((resolve) => setTimeout(resolve, 100));
    restarted = await EncryptedBrowserVault.open({
      vaultDirectory,
      runtimeDirectory,
      encryptionKey: key,
      lockProvider: await makeNativeLockProvider(),
    });
    const afterRestart = (await readdir(runtimeDirectory)).filter((name) => name.startsWith('checkout-'));
    assert.deepEqual(afterRestart, []);
    const recovered = await restarted.checkout({
      role: 'release',
      expectedIdentity: identity(),
      expectedGeneration: 1,
      executionBinding: binding(),
      sourceSha: SOURCE_SHA,
    });
    await restarted.abort({
      capabilityId: recovered.capabilityId,
      executionBinding: binding(),
      sourceSha: SOURCE_SHA,
    });
  } finally {
    crashedChild?.kill('SIGKILL');
    if (bootstrap) await bootstrap.close();
    if (restarted) await restarted.close();
    key.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test('native advisory lock permits exactly one process after the previous holder crashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seori-native-lock-race-'));
  const lockPath = join(root, 'account.lock');
  let holder;
  const spawned = [];
  try {
    holder = spawn(nativeHelper, ['hold-lock', lockPath], {
      env: { LANG: 'C.UTF-8' }, shell: false, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const holderCompletion = childCompletion(holder);
    assert.deepEqual(JSON.parse(await firstLine(holder)), { locked: true });
    const blocked = spawn(nativeHelper, ['hold-lock', lockPath], {
      env: { LANG: 'C.UTF-8' }, shell: false, stdio: ['pipe', 'pipe', 'ignore'],
    });
    assert.equal((await childCompletion(blocked)).code, 75);

    holder.kill('SIGKILL');
    assert.equal((await holderCompletion).signal, 'SIGKILL');
    holder = undefined;

    const contenders = [0, 1].map(() => spawn(nativeHelper, ['hold-lock', lockPath], {
      env: { LANG: 'C.UTF-8' }, shell: false, stdio: ['pipe', 'pipe', 'ignore'],
    }));
    spawned.push(...contenders);
    const outcomes = await Promise.all(contenders.map(lockOutcome));
    assert.equal(outcomes.filter(({ outcome }) => outcome === 'acquired').length, 1);
    assert.equal(outcomes.filter(({ outcome }) => outcome === 'blocked').length, 1);
    const winner = outcomes.find(({ outcome }) => outcome === 'acquired');
    winner.child.stdin.end();
    assert.deepEqual(await winner.completion, { code: 0, signal: null });
  } finally {
    holder?.kill('SIGKILL');
    for (const child of spawned) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

test('supervisor cleanup removes only unlocked stale clones and returns no sensitive path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seori-browser-supervisor-cleanup-'));
  const runtimeDirectory = join(root, 'runtime');
  const staleDirectory = join(runtimeDirectory, `checkout-${'a'.repeat(64)}-stale1`);
  try {
    await mkdir(staleDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(staleDirectory, 'Cookies'), 'fake-supervisor-cookie', { mode: 0o600 });
    const child = spawn(process.execPath, [
      cleanupCommand,
      `--runtime-directory=${runtimeDirectory}`,
      `--native-helper=${nativeHelper}`,
    ], { env: { LANG: 'C.UTF-8' }, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    const completion = childCompletion(child);
    const output = await firstLine(child);
    assert.deepEqual(JSON.parse(output), { state: 'CLEAN' });
    assert.doesNotMatch(output, /checkout-|cookie|path|runtime/i);
    assert.deepEqual(await completion, { code: 0, signal: null });
    await assert.rejects(stat(staleDirectory), (error) => error.code === 'ENOENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
