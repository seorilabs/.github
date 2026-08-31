import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import test from 'node:test';

const repositoryRoot = new URL('../', import.meta.url).pathname;
const builder = join(repositoryRoot, 'scripts/fleet/build-p2-regular-file-askpass.mjs');

async function listen(server, socketPath) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function run(executable) {
  return spawnSync(executable, [], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
}

test('regular-file askpass injects only the exact request through a native pipe', async () => {
  const root = await mkdtemp('/private/tmp/p2ask.');
  const askDirectory = join(root, 'run/systemd/ask-password');
  const sourceDirectory = join(root, 'data/seori-auth');
  const binaryDirectory = join(root, 'bin');
  const source = join(sourceDirectory, 'seori-auth-state.luks');
  const ask = join(askDirectory, 'ask.exact');
  const socket = join(askDirectory, 'sck.exact');
  const secretInput = join(root, 'canonical-secret-input');
  const replyCount = join(root, 'reply-count');
  const clevisArguments = join(root, 'clevis-argv');
  const replyArguments = join(root, 'reply-argv');
  const clevisEnvironment = join(root, 'clevis-env');
  const replyEnvironment = join(root, 'reply-env');
  const fakeClevis = join(binaryDirectory, 'clevis');
  const fakeReply = join(binaryDirectory, 'systemd-reply-password');
  const helper = join(binaryDirectory, 'seorilabs-p2-regular-file-askpass');
  const canary = `canary-${randomBytes(24).toString('hex')}`;
  const server = net.createServer();
  try {
    await mkdir(askDirectory, { recursive: true, mode: 0o700 });
    await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
    await mkdir(binaryDirectory, { mode: 0o700 });
    await writeFile(source, 'fixture-luks-container', { mode: 0o600 });
    await writeFile(secretInput, canary, { mode: 0o600 });
    await writeFile(fakeClevis, `#!/bin/sh
set -eu
[ "$#" -eq 6 ]
[ "$1" = luks ] && [ "$2" = pass ] && [ "$3" = -d ]
[ "$4" = /proc/self/fd/3 ] && [ "$5" = -s ] && [ "$6" = 1 ]
/usr/bin/printf '%s\\n' "$@" >${JSON.stringify(clevisArguments)}
/usr/bin/env >${JSON.stringify(clevisEnvironment)}
exec /bin/cat ${JSON.stringify(secretInput)}
`, { mode: 0o700 });
    await writeFile(fakeReply, `#!/bin/sh
set -eu
[ "$#" -eq 2 ] && [ "$1" = 1 ] && [ "$2" = ${JSON.stringify(socket)} ]
/usr/bin/printf '%s\\n' "$@" >${JSON.stringify(replyArguments)}
/usr/bin/env >${JSON.stringify(replyEnvironment)}
/usr/bin/wc -c | /usr/bin/tr -d ' ' >${JSON.stringify(replyCount)}
`, { mode: 0o700 });
    await Promise.all([chmod(fakeClevis, 0o700), chmod(fakeReply, 0o700)]);
    const build = spawnSync(process.execPath, [
      builder,
      helper,
      `--test-root=${root}`,
      `--clevis-executable=${fakeClevis}`,
      `--reply-executable=${fakeReply}`,
    ], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);
    await listen(server, socket);
    await writeFile(ask, [
      '[Ask]',
      `Id=cryptsetup:${source}`,
      `Socket=${socket}`,
      '',
    ].join('\n'), { mode: 0o600 });

    const accepted = run(helper);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.stdout, '');
    assert.equal(accepted.stderr, '');
    assert.equal((await readFile(replyCount, 'utf8')).trim(), String(Buffer.byteLength(canary)));
    const publicEvidence = (await Promise.all([
      readFile(clevisArguments, 'utf8'),
      readFile(replyArguments, 'utf8'),
      readFile(clevisEnvironment, 'utf8'),
      readFile(replyEnvironment, 'utf8'),
      readFile(replyCount, 'utf8'),
      readFile(ask, 'utf8'),
    ])).join('\n');
    assert.doesNotMatch(`${accepted.stdout}${accepted.stderr}${publicEvidence}`, new RegExp(canary, 'u'));
    const childEnvironment = Object.fromEntries((await readFile(clevisEnvironment, 'utf8'))
      .split('\n').filter(Boolean).map((line) => line.split(/=(.*)/su).slice(0, 2)));
    assert.equal(childEnvironment.LANG, 'C');
    assert.equal(childEnvironment.LC_ALL, 'C');
    assert.equal(childEnvironment.PATH, '/usr/sbin:/usr/bin:/sbin:/bin');
    assert.deepEqual(Object.keys(childEnvironment).toSorted(), [
      'LANG', 'LC_ALL', 'PATH', 'PWD', 'SHLVL', '_',
    ].toSorted());

    await rm(replyCount, { force: true });
    await writeFile(ask, [
      '[Ask]',
      `Id=cryptsetup:${source}.lookalike`,
      `Socket=${socket}`,
      '',
    ].join('\n'), { mode: 0o600 });
    const lookalike = run(helper);
    assert.equal(lookalike.status, 0, lookalike.stderr);
    await assert.rejects(readFile(replyCount), { code: 'ENOENT' });

    await writeFile(ask, [
      '[Ask]',
      `Id=cryptsetup:${source}`,
      `Socket=${askDirectory}/../sck.lookalike`,
      '',
    ].join('\n'), { mode: 0o600 });
    const redirect = run(helper);
    assert.equal(redirect.status, 126);
    assert.match(redirect.stderr, /ASK_SOCKET_INVALID/u);
    assert.doesNotMatch(redirect.stderr, new RegExp(canary, 'u'));

    await close(server);
    await unlink(socket).catch(() => {});
    await writeFile(ask, [
      '[Ask]',
      `Id=cryptsetup:${source}`,
      `Socket=${socket}`,
      '',
    ].join('\n'), { mode: 0o600 });
    const revoked = run(helper);
    assert.equal(revoked.status, 126);
    assert.match(revoked.stderr, /ASK_SOCKET_INVALID/u);
    await assert.rejects(readFile(replyCount), { code: 'ENOENT' });
  } finally {
    if (server.listening) await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('regular-file askpass contract keeps the vendor block-device unlocker and adds a pre-start only', async () => {
  const dropIn = await readFile(
    join(repositoryRoot, 'contracts/systemd/clevis-luks-askpass.service.d/10-seorilabs-regular-file.conf'),
    'utf8',
  );
  const bootstrap = await readFile(join(repositoryRoot, 'scripts/fleet/bootstrap-p2-stage1-host.sh'), 'utf8');
  assert.equal(dropIn, [
    '[Service]',
    'ExecStartPre=/usr/local/libexec/seorilabs-p2-regular-file-askpass',
    '',
  ].join('\n'));
  assert.doesNotMatch(dropIn, /^ExecStart=$/mu);
  assert.doesNotMatch(dropIn, /ExecStart=\/usr\/libexec\/clevis-luks-askpass/mu);
  assert.match(bootstrap, /systemctl daemon-reload/u);
  assert.match(bootstrap, /DropInPaths/u);
  assert.match(bootstrap, /install_exact_helper "\$source" "\$regular_file_askpass"/u);
});
