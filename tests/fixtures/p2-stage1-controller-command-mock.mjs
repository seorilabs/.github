#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import {
  buildPreProvisionBackupAttestation,
  buildTangServerAttestation,
  canonicalJson,
  confirmations,
  contractDigest,
  sha256,
} from '../../tools/seori-auth/src/host-encryption-provisioning.mjs';
import { readScopedTangInventory } from '../../tools/seori-auth/src/p2-stage1.mjs';

const [executable, ...args] = process.argv.slice(2);
const remoteRoot = process.env.SEORILABS_P2_STAGE1_FIXTURE_REMOTE_ROOT;
const logPath = process.env.SEORILABS_P2_STAGE1_FIXTURE_LOG;
const scenario = process.env.SEORILABS_P2_STAGE1_FIXTURE_SCENARIO ?? 'success';
const hostCli = fileURLToPath(new URL('./p2-stage1-tang-fixture-entrypoint.mjs', import.meta.url));
const contract = parse(readFileSync('contracts/fleet-p2-host-encryption.yaml', 'utf8'));
const stage1 = parse(readFileSync('contracts/fleet-p2-stage1.yaml', 'utf8'));
const IP_TO_NODE = Object.freeze(Object.fromEntries(stage1.hosts.map(({ ipv4, nodeName }) => [ipv4, nodeName])));
const recoveryKeyCanary = 'STAGE1_LUKS_RECOVERY_KEY_MUST_NOT_APPEAR_17593\n';

if (executable !== stage1.ssh.executable || typeof remoteRoot !== 'string' || remoteRoot.length === 0) {
  process.exit(126);
}

const destination = args.at(-2);
const remoteCommand = args.at(-1);
const match = new RegExp(`^${stage1.ssh.user}@([0-9.]+)$`, 'u').exec(destination ?? '');
const nodeName = match === null ? undefined : IP_TO_NODE[match[1]];
if (nodeName === undefined || typeof remoteCommand !== 'string') process.exit(126);
if (logPath !== undefined) {
  appendFileSync(logPath, `${JSON.stringify({ executable, nodeName, remoteCommand })}\n`, 'utf8');
}

const nodeRoot = join(remoteRoot, nodeName);
const input = readFileSync(0);

function output(value) {
  if (Buffer.isBuffer(value)) process.stdout.write(value);
  else process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
  process.exit(0);
}

function mapped(path) {
  return join(nodeRoot, path.slice(1));
}

function hostMode() {
  const match = /\/scripts\/fleet\/p2-stage1-tang-backup\.mjs ([a-z0-9-]+)(.*?) 3<&0'$/u
    .exec(remoteCommand);
  if (match === null) return false;
  const options = match[2].trim().split(' ').filter(Boolean);
  const result = spawnSync(
    '/bin/sh',
    ['-c', `exec "${process.execPath}" "${hostCli}" "${match[1]}" "$@" 3<&0`, '--', ...options],
    {
      input,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        SEORILABS_P2_STAGE1_FIXTURE_ROOT: nodeRoot,
      },
      encoding: null,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  if (result.status !== 0 || result.error !== undefined) {
    if (result.stderr?.length > 0) process.stderr.write(result.stderr);
    process.exit(result.status ?? 126);
  }
  if (scenario === 'response-unknown' && match[1] === 'backup-verify') process.exit(70);
  output(result.stdout);
  return true;
}

if (hostMode()) process.exit(0);

if (remoteCommand === `/usr/bin/install -d -m 0700 ${stage1.sourceBootstrap.incomingRoot}`) {
  mkdirSync(mapped(stage1.sourceBootstrap.incomingRoot), { recursive: true, mode: 0o700 });
  process.exit(0);
}

const readback = /^\/bin\/bash -s -- --archive=(\/var\/tmp\/seorilabs-fleet-p2\/[a-f0-9]{40}-[a-f0-9]{64}\.tar) --sha=([a-f0-9]{64})$/u
  .exec(remoteCommand);
if (readback !== null) {
  const path = mapped(readback[1]);
  try {
    const bytes = readFileSync(path);
    output({ state: sha256(bytes) === readback[2] ? 'EXACT_READBACK' : 'DRIFT' });
  } catch (error) {
    if (error?.code === 'ENOENT') output({ state: 'ABSENT' });
    process.exit(126);
  }
}

const upload = /^\/usr\/bin\/dd of=(\/var\/tmp\/seorilabs-fleet-p2\/[a-f0-9]{40}-[a-f0-9]{64}\.tar) status=none conv=excl$/u
  .exec(remoteCommand);
if (upload !== null) {
  const path = mapped(upload[1]);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const descriptor = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, input);
  } finally {
    closeSync(descriptor);
  }
  process.exit(0);
}

const bootstrap = /^(?:sudo -n|sudo -S -p '') \/bin\/bash -s -- --host=([a-z0-9-]+) --source-sha=([a-f0-9]{40}) --archive=(\/var\/tmp\/seorilabs-fleet-p2\/[a-f0-9]{40}-([a-f0-9]{64})\.tar) --archive-sha=([a-f0-9]{64}) --lock-sha=([a-f0-9]{64}) --contract-digest=([a-f0-9]{64}) --confirmation=(.+)$/u
  .exec(remoteCommand);
if (bootstrap !== null) {
  if (bootstrap[1] !== nodeName || bootstrap[4] !== bootstrap[5]) process.exit(126);
  output({
    schemaVersion: 1,
    state: 'P2_STAGE1_SOURCE_READY',
    nodeName,
    sourceSha: bootstrap[2],
    archiveSha256: bootstrap[5],
    packageLockSha256: bootstrap[6],
    installState: 'CREATED',
    secretExposed: false,
  });
}

const cat = /^(?:sudo -n|sudo -S -p '') \/bin\/cat -- (\/var\/backups\/seori-auth\/tang-v1\/(?:rpi4001|seori-m6-01)\.(?:server-keys\.seori-aes256gcm|live-evidence\.json))$/u
  .exec(remoteCommand);
if (cat !== null) output(readFileSync(mapped(cat[1])));

const tangProvision = /provision-p2-tang-server\.mjs (plan|apply) --server=(rpi4001|seori-m6-01)(?: --confirmation=([A-Za-z0-9-]+))? 3<&0'$/u
  .exec(remoteCommand);
if (tangProvision !== null) {
  if (tangProvision[2] !== nodeName) process.exit(126);
  const server = contract.tang.servers.find((entry) => entry.nodeName === nodeName);
  const expectedConfirmation = confirmations(contract).tang[nodeName];
  if (tangProvision[1] === 'plan') {
    output({
      schemaVersion: 1,
      state: 'DRY_RUN',
      contractDigest: contractDigest(contract),
      server,
      confirmation: expectedConfirmation,
      secretValuesReturned: false,
    });
  }
  if (tangProvision[3] !== expectedConfirmation) process.exit(126);
  const inventory = readScopedTangInventory(mapped(server.keyDirectory), { enforcePrivate: false });
  for (const file of inventory.archivePayload.files) file.content = '';
  output({
    schemaVersion: 1,
    state: 'TANG_SERVER_KEYS_BACKUP_REQUIRED',
    contractDigest: contractDigest(contract),
    nodeName,
    hostname: server.expectedHostname,
    ipv4: server.ipv4,
    port: server.port,
    url: server.url,
    packageVersion: '15-3',
    signingKeyThumbprints: [nodeName === 'rpi4001' ? 'A'.repeat(43) : 'B'.repeat(43)],
    advertisementSha256: sha256(Buffer.from(`fixture-advertisement-${nodeName}`, 'utf8')),
    keyInventory: {
      ...inventory.publicInventory,
      backupLogicalId: server.backupLogicalId,
    },
    requiredBackupLogicalId: server.backupLogicalId,
    secretValuesReturned: false,
  });
}

const tangReadback = /provision-p2-tang-server\.mjs readback --server=(rpi4001|seori-m6-01) --backup-attestation=(\/var\/lib\/seorilabs\/tang-backup-attestations\/(?:rpi4001|seori-m6-01)\.json) 3<&0'$/u
  .exec(remoteCommand);
if (tangReadback !== null) {
  if (tangReadback[1] !== nodeName || !tangReadback[2].endsWith(`/${nodeName}.json`)) process.exit(126);
  const server = contract.tang.servers.find((entry) => entry.nodeName === nodeName);
  const inventory = readScopedTangInventory(mapped(server.keyDirectory), { enforcePrivate: false });
  const publicKey = readFileSync(mapped(stage1.tangBackup.trustAnchorPath));
  const backupAttestation = JSON.parse(readFileSync(mapped(tangReadback[2]), 'utf8'));
  const attestation = buildTangServerAttestation({
    contract,
    server,
    hostname: server.expectedHostname,
    ipv4: server.ipv4,
    packageVersion: '15-3',
    signingKeyThumbprints: [nodeName === 'rpi4001' ? 'A'.repeat(43) : 'B'.repeat(43)],
    advertisementSha256: sha256(Buffer.from(`fixture-advertisement-${nodeName}`, 'utf8')),
    keyInventory: {
      directory: server.keyDirectory,
      fileCount: inventory.publicInventory.fileCount,
      inventoryEvidenceSha256: inventory.privateInventory.inventoryEvidenceSha256,
      backupLogicalId: server.backupLogicalId,
    },
    backupAttestation,
    authorityPublicKey: publicKey,
  });
  for (const file of inventory.archivePayload.files) file.content = '';
  output(canonicalJson(attestation));
}

function fixtureHostBackup() {
  return buildPreProvisionBackupAttestation({
    contract,
    configuration: [contract.systemd.crypttabPath, contract.systemd.fstabPath].map((path, index) => ({
      path,
      existed: false,
      sha256: String(index + 1).repeat(64),
      metadata: null,
    })),
    pathIdentities: [
      '/data/seori-auth',
      '/data/seori-auth/rollback',
      contract.target.mountPath,
      contract.target.backupRoot,
    ].map((path, index) => ({
      path,
      type: 'directory',
      device: String(index + 1),
      inode: String(index + 11),
      ownerId: 0,
      groupId: 0,
      mode: '0700',
    })),
    unlockerState: { enabled: false, active: false },
  });
}

const hostBackupMarker = join(nodeRoot, 'host-pre-backup.json');
const hostBackupState = /provision-p2-host-encryption\.mjs backup-state --kubeconfig=\/var\/snap\/microk8s\/current\/credentials\/kubelet\.config --public-error-channel=stdout 3<&0'$/u
  .exec(remoteCommand);
if (hostBackupState !== null) {
  if (nodeName !== contract.target.nodeName) process.exit(126);
  try {
    output(JSON.parse(readFileSync(hostBackupMarker, 'utf8')));
  } catch (error) {
    if (error?.code !== 'ENOENT') process.exit(126);
    output({
      schemaVersion: 1,
      state: 'HOST_PRE_BACKUP_MISSING',
      nodeName: contract.target.nodeName,
      contractDigest: contractDigest(contract),
      targetEmpty: true,
    });
  }
}

const hostBackup = /provision-p2-host-encryption\.mjs backup --confirmation=fleet-p2-host-backup-[a-f0-9]{12} --kubeconfig=\/var\/snap\/microk8s\/current\/credentials\/kubelet\.config --public-error-channel=stdout 3<&0'$/u
  .exec(remoteCommand);
if (hostBackup !== null) {
  if (nodeName !== contract.target.nodeName) process.exit(126);
  const attestation = fixtureHostBackup();
  writeFileSync(hostBackupMarker, `${canonicalJson(attestation)}\n`, { mode: 0o600, flag: 'wx' });
  output(attestation);
}

const hostEncryptionReadback = /provision-p2-host-encryption\.mjs readback --kubeconfig=\/var\/snap\/microk8s\/current\/credentials\/kubelet\.config --tang-attestation=\/var\/lib\/seorilabs\/tang-backup-attestations\/rpi4001\.json --tang-attestation=\/var\/lib\/seorilabs\/tang-backup-attestations\/seori-m6-01\.json --public-error-channel=stdout 3<&0'$/u
  .exec(remoteCommand);
if (hostEncryptionReadback !== null) {
  if (nodeName !== contract.target.nodeName) process.exit(126);
  if (scenario === 'host-kubeconfig-error') {
    output({ ok: false, code: 'KUBECONFIG_PATH_INVALID' });
  }
  if (scenario === 'host-unapproved-error') {
    output({ ok: false, code: 'SECRET_SHAPED_REMOTE_FAILURE' });
  }
  output({
    schemaVersion: 1,
    state: 'HOST_ENCRYPTED_MOUNT_MISSING',
    nodeName: contract.target.nodeName,
    contractDigest: contractDigest(contract),
    targetEmpty: true,
  });
}

const hostEncryptionApply = /^sudo -n \/usr\/local\/libexec\/seori-auth-native launch -- \/usr\/local\/bin\/node \/opt\/seorilabs\/fleet-p2\/[a-f0-9]{40}\/scripts\/fleet\/p2-host-encryption-apply-loader\.mjs$/u
  .exec(remoteCommand);
if (hostEncryptionApply !== null) {
  if (nodeName !== contract.target.nodeName || input.toString('utf8') !== recoveryKeyCanary) {
    process.exit(126);
  }
  output({
    schemaVersion: 1,
    state: 'HOST_PROVISIONED_REBOOT_READBACK_REQUIRED',
    nodeName: contract.target.nodeName,
    contractDigest: contractDigest(contract),
    provisionedDigest: 'd'.repeat(64),
    secretExposed: false,
  });
}

process.exit(126);
