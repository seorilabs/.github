import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { withCanaryDirectories } from '../runtime/canary-directories.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seori-auth-canary-directories-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeParent = join(root, 'runtime');
  const vaultParent = join(root, 'vault');
  await mkdir(runtimeParent);
  await mkdir(vaultParent);
  return { platform: 'linux', runtimeParent, vaultParent, temporaryParent: join(root, 'unavailable') };
}

test('canary uses private children of writable volume roots without changing their permissions', async (t) => {
  const options = await fixture(t);
  for (const parent of [options.runtimeParent, options.vaultParent]) await chmod(parent, 0o2777);
  const parentsBefore = await Promise.all([options.runtimeParent, options.vaultParent].map(lstat));
  let firstPaths;
  await withCanaryDirectories(async (paths) => {
    firstPaths = paths;
    for (const [key, parent] of [['runtimeRoot', options.runtimeParent], ['vaultRoot', options.vaultParent]]) {
      assert.equal(dirname(paths[key]), parent);
      const entry = await lstat(paths[key]);
      assert.equal(entry.uid, process.getuid());
      assert.equal(entry.mode & 0o777, 0o700);
      await writeFile(join(paths[key], 'canary-state'), 'fake-state', { mode: 0o600 });
    }
  }, options);
  await withCanaryDirectories(async (paths) => {
    assert.notEqual(paths.runtimeRoot, firstPaths.runtimeRoot);
    assert.notEqual(paths.vaultRoot, firstPaths.vaultRoot);
  }, options);
  for (const [index, parent] of [options.runtimeParent, options.vaultParent].entries()) {
    const after = await lstat(parent);
    assert.equal(after.mode, parentsBefore[index].mode);
    assert.equal(after.uid, parentsBefore[index].uid);
    assert.deepEqual(await readdir(parent), []);
  }
});

test('canary removes its private state after callback failure, preserving unrelated volume data', async (t) => {
  const options = await fixture(t);
  const marker = join(options.runtimeParent, 'existing-state');
  await writeFile(marker, 'existing');
  await assert.rejects(withCanaryDirectories(async ({ vaultRoot }) => {
    await writeFile(join(vaultRoot, 'partial-state'), 'fake');
    throw new Error('expected failure');
  }, options), /expected failure/);
  assert.deepEqual(await readdir(options.runtimeParent), ['existing-state']);
  assert.deepEqual(await readdir(options.vaultParent), []);
});

test('symlink and partial production mounts are rejected without fallback or mutation', async (t) => {
  const options = await fixture(t);
  const link = join(options.runtimeParent, 'linked-vault');
  await symlink(options.vaultParent, link);
  for (const vaultParent of [link, join(options.vaultParent, 'missing')]) {
    await assert.rejects(withCanaryDirectories(() => assert.fail('must not execute'), {
      ...options, vaultParent,
    }), { code: 'CANARY_DIRECTORY_UNSAFE' });
  }
  assert.deepEqual(await readdir(options.runtimeParent), ['linked-vault']);
  assert.deepEqual(await readdir(options.vaultParent), []);
});

test('local non-container canary retains a private temporary root and cleans it completely', async (t) => {
  const options = await fixture(t);
  await withCanaryDirectories(async ({ runtimeRoot, vaultRoot }) => {
    assert.equal(dirname(runtimeRoot), dirname(vaultRoot));
    assert.equal((await lstat(runtimeRoot)).mode & 0o777, 0o700);
    assert.equal((await lstat(vaultRoot)).mode & 0o777, 0o700);
  }, { ...options, platform: 'darwin', temporaryParent: options.runtimeParent });
  assert.deepEqual(await readdir(options.runtimeParent), []);
});
