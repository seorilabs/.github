#!/usr/bin/env node

import {
  appendFileSync,
  chmodSync,
  existsSync,
  fstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import { buildRetainVolumeList } from '../../tools/seori-auth/src/state-envelope.mjs';

const [executable, ...args] = process.argv.slice(2);
const scenario = process.env.SEORILABS_HOST_FIXTURE_SCENARIO ?? 'missing';
const logPath = process.env.SEORILABS_HOST_FIXTURE_LOG;
const statePath = process.env.SEORILABS_HOST_FIXTURE_STATE;
const fixtureRoot = process.env.SEORILABS_HOST_FIXTURE_ROOT;
const nodeName = process.env.SEORILABS_HOST_FIXTURE_NODE ?? 'rpi5';
const LUKS_UUID = '12345678-1234-1234-1234-123456789abc';
const THUMBPRINTS = {
  rpi4001: 'A'.repeat(43),
  'seori-m6-01': 'B'.repeat(43),
};
const IPS = {
  rpi5: '192.168.0.99',
  rpi4001: '192.168.0.100',
  'seori-m6-01': '192.168.0.118',
};
const TANG_TRUST_PROBE = 'seorilabs-p2-tang-trust-probe-v1';

let recoveryFdIdentity;
try {
  const entry = fstatSync(3);
  recoveryFdIdentity = `${entry.dev}:${entry.ino}`;
} catch {
  recoveryFdIdentity = undefined;
}

if (logPath) {
  appendFileSync(logPath, `${JSON.stringify({
    executable,
    args,
    environment: process.env,
    ...(recoveryFdIdentity === undefined ? {} : { recoveryFdIdentity }),
  })}\n`, 'utf8');
}

function defaultState() {
  return {
    source: ['partial', 'complete', 'drift'].includes(scenario),
    luks: ['complete', 'drift'].includes(scenario),
    clevis: ['complete', 'drift'].includes(scenario),
    mapper: ['complete', 'drift'].includes(scenario),
    filesystem: ['complete', 'drift'].includes(scenario),
    mounted: ['complete', 'drift'].includes(scenario),
    bootId: '11111111-1111-4111-8111-111111111111',
    tangInstalled: !['tang-missing', 'tang-boundary-failure'].includes(scenario),
    tangActive: !['tang-missing', 'tang-boundary-failure'].includes(scenario),
    unlockerEnabled: scenario !== 'unlocker-masked',
    unlockerActive: false,
  };
}

function loadState() {
  if (statePath && existsSync(statePath)) return JSON.parse(readFileSync(statePath, 'utf8'));
  return defaultState();
}

let state = loadState();

function saveState() {
  if (!statePath) return;
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, 'utf8');
}

function output(value) {
  if (value !== undefined) {
    process.stdout.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value)}\n`);
  }
  process.exit(0);
}

function outputRaw(value) {
  process.stdout.write(value);
  process.exit(0);
}

function fixturePath(path) {
  return join(fixtureRoot, path.slice(1));
}

function isCommand(path, expected) {
  return executable === path && args.join('\0') === expected.join('\0');
}

if (isCommand('/usr/local/libexec/seori-auth-native', ['fixture-process-hardening-readback'])) {
  if (scenario === 'unhardened-process') process.exit(65);
  output({
    state: 'PROCESS_HARDENING_OK',
    coreSoft: 0,
    coreHard: 0,
    dumpable: 0,
    noNewPrivileges: 1,
  });
}

if (executable === '/usr/local/libexec/seorilabs-p2-host-fs-boundary') {
  const operation = args[0];
  if (operation === 'verify-namespace' && args.length === 1) {
    output({ operation, verified: true });
  }
  if (operation === 'publish-record') {
    const records = {
      'crypttab-before': '/var/backups/seori-auth/fleet-p2-host-v1/crypttab.before',
      'fstab-before': '/var/backups/seori-auth/fleet-p2-host-v1/fstab.before',
      'pre-provision': '/var/backups/seori-auth/fleet-p2-host-v1/pre-provision.json',
      'crypttab-managed': '/var/backups/seori-auth/fleet-p2-host-v1/crypttab.before.managed',
      'fstab-managed': '/var/backups/seori-auth/fleet-p2-host-v1/fstab.before.managed',
      marker: '/var/lib/seori-auth/.seorilabs-host-encrypted-mount.json',
      provision: '/var/backups/seori-auth/fleet-p2-host-v1/provision.json',
      reboot: '/var/backups/seori-auth/fleet-p2-host-v1/reboot.json',
      rollback: '/var/backups/seori-auth/fleet-p2-host-v1/rollback.json',
      'provision-restored': '/var/backups/seori-auth/fleet-p2-host-v1/provision.restored.json',
      'reboot-restored': '/var/backups/seori-auth/fleet-p2-host-v1/reboot.restored.json',
      'tang-socket-override': '/etc/systemd/system/tangd.socket.d/seorilabs.conf',
    };
    const identifier = args[1];
    const canonical = records[identifier];
    if (args.length !== 2 || canonical === undefined) process.exit(64);
    if (scenario === 'tang-boundary-failure' && identifier === 'tang-socket-override') {
      process.exit(70);
    }
    const target = fixturePath(canonical);
    if (existsSync(target)) process.exit(73);
    const content = readFileSync(0);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, {
      mode: identifier === 'marker' ? 0o440 : identifier === 'tang-socket-override' ? 0o644 : 0o600,
    });
    output({ operation, record: identifier, sizeBytes: content.length });
  }
  if (operation === 'create-source') {
    if (state.source) process.exit(73);
    state.source = true;
    const source = fixturePath('/data/seori-auth/seori-auth-state.luks');
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, 'fixture-luks-image\n', { mode: 0o600 });
    saveState();
    if (scenario === 'response-unknown') process.exit(70);
    output({ operation, created: true });
  }
  if (operation === 'backup-header') {
    const target = fixturePath('/var/backups/seori-auth/fleet-p2-host-v1/luks-header.bin');
    if (existsSync(target)) process.exit(73);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'fixture-luks-header\n', { mode: 0o400 });
    output({ operation, created: true });
  }
  if (operation === 'rollback-source' || operation === 'restore-source') {
    const rollback = operation === 'rollback-source';
    const source = fixturePath(rollback
      ? '/data/seori-auth/seori-auth-state.luks'
      : '/data/seori-auth/rollback/seori-auth-state.luks');
    const target = fixturePath(rollback
      ? '/data/seori-auth/rollback/seori-auth-state.luks'
      : '/data/seori-auth/seori-auth-state.luks');
    if (existsSync(target)) process.exit(73);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(source, target);
    state.source = !rollback;
    state.rollbackSource = rollback;
    saveState();
    output({ operation, moved: true });
  }
  if (['apply-config', 'rollback-config', 'restore-config'].includes(operation)) {
    const identifier = args[1];
    if (!['crypttab', 'fstab'].includes(identifier)) process.exit(64);
    const target = fixturePath(`/etc/${identifier}`);
    const swap = fixturePath(`/etc/.seorilabs-p2-${identifier}-original`);
    const original = readFileSync(3);
    const managed = readFileSync(4);
    const metadataMode = Number.parseInt(args[5], 8);
    if (operation === 'apply-config') {
      if (args[2] === '1') {
        writeFileSync(swap, original, { mode: metadataMode });
        writeFileSync(target, managed, { mode: metadataMode });
      } else {
        writeFileSync(target, managed, { mode: metadataMode });
      }
    } else if (operation === 'rollback-config') {
      if (args[2] === '1') {
        writeFileSync(swap, managed, { mode: metadataMode });
        writeFileSync(target, original, { mode: metadataMode });
      } else {
        renameSync(target, swap);
      }
    } else {
      if (args[2] === '1') {
        writeFileSync(target, managed, { mode: metadataMode });
        writeFileSync(swap, original, { mode: metadataMode });
      } else {
        renameSync(swap, target);
      }
    }
    output({ operation, config: identifier });
  }
  process.exit(64);
}

if (executable === '/usr/bin/hostname' && args.join('\0') === '--short') {
  output(scenario === 'wrong-host' ? 'lookalike-host' : nodeName);
}

if (executable === '/usr/bin/ip') {
  output([{
    ifname: 'eth0',
    addr_info: [{
      family: 'inet',
      local: scenario === 'wrong-ip' ? '192.168.0.250' : IPS[nodeName],
      scope: 'global',
    }],
  }]);
}

if (executable === '/usr/bin/test' && args[0] === '-e') {
  const path = args[1];
  const present = path === '/data/seori-auth/seori-auth-state.luks'
    ? state.source
    : path === '/dev/mapper/seori-auth-state'
      ? state.mapper
      : path === '/data/seori-auth/rollback/seori-auth-state.luks'
        ? state.rollbackSource
        : existsSync(fixturePath(path));
  process.exit(present ? 0 : 1);
}

if (executable === '/usr/bin/find' && args[0] === '/var/lib/seori-auth') {
  if (scenario === 'nonempty' && !state.mounted) output('/var/lib/seori-auth/existing-state');
  output();
}

if (executable === '/usr/bin/find' && args[0] === '/var/lib/tang') {
  outputRaw('sig.jwk\tf\nexc.jwk\tf\n');
}

if (executable === '/usr/bin/stat' && args.at(-1) === '/data/seori-auth/seori-auth-state.luks') {
  if (!state.source) process.exit(1);
  const blocks = scenario === 'sparse' ? '8' : '33554432';
  output(`17179869184:${blocks}:512`);
}

if (executable === '/usr/bin/stat' && args.at(-1) === '/var/lib/seori-auth/.seorilabs-host-encrypted-mount.json') {
  output(scenario === 'marker-mode-drift' ? '0:65532:644' : '0:65532:440');
}

if (executable === '/usr/bin/stat' && args.at(-1) === '/var/lib/tang') {
  output('0:108:2750');
}

if (executable === '/usr/bin/findmnt') {
  if (!state.mounted) process.exit(1);
  output({
    filesystems: [{
      source: scenario === 'drift' ? '/dev/mmcblk0p2' : '/dev/mapper/seori-auth-state',
      fstype: 'ext4',
      target: '/var/lib/seori-auth',
    }],
  });
}

if (executable === '/usr/sbin/cryptsetup') {
  const action = args[0];
  if (action === 'luksUUID') {
    if (!state.luks) process.exit(1);
    output(LUKS_UUID);
  }
  if (action === 'status') {
    if (!state.mapper) process.exit(4);
    outputRaw([
      '/dev/mapper/seori-auth-state is active and is in use.',
      '  type:    LUKS2',
      '  device:  /dev/loop7',
      `  loop:    ${scenario === 'wrong-backing' ? '/data/lookalike/seori-auth-state.luks' : '/data/seori-auth/seori-auth-state.luks'}`,
      '',
    ].join('\n'));
  }
  if (action === 'isLuks') process.exit(state.luks ? 0 : 1);
  if (action === 'luksFormat') {
    state.luks = true;
    saveState();
    if (scenario === 'recovery-key-swap') {
      const recoveryPath = join(dirname(fixtureRoot), 'recovery-key');
      renameSync(recoveryPath, `${recoveryPath}.original`);
      writeFileSync(recoveryPath, 'REPLACEMENT_RECOVERY_KEY_MUST_NOT_BE_USED_9876543210\n', {
        mode: 0o600,
      });
    }
    process.exit(0);
  }
  if (action === 'open' && args.includes('--test-passphrase')) process.exit(state.luks ? 0 : 1);
  if (action === 'open') {
    state.mapper = true;
    saveState();
    process.exit(0);
  }
  if (action === 'close') {
    state.mapper = false;
    saveState();
    process.exit(0);
  }
  if (action === 'luksHeaderBackup') {
    const canonical = args.at(-1);
    const target = fixturePath(canonical);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'fixture-luks-header\n', 'utf8');
    process.exit(0);
  }
}

if (executable === '/usr/sbin/dmsetup') {
  output(`seori-auth-state|CRYPT-LUKS2-${LUKS_UUID.replaceAll('-', '')}-seori--auth--state|253|7`);
}

if (executable === '/usr/sbin/losetup') {
  output({
    loopdevices: [{
      name: '/dev/loop7',
      'back-file': scenario === 'wrong-backing'
        ? '/data/lookalike/seori-auth-state.luks'
        : '/data/seori-auth/seori-auth-state.luks',
      'maj:min': '7:7',
    }],
  });
}

if (executable === '/usr/bin/fallocate') {
  state.source = true;
  const source = fixturePath('/data/seori-auth/seori-auth-state.luks');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, 'fixture-luks-image\n', { mode: 0o600 });
  saveState();
  if (scenario === 'response-unknown') process.exit(70);
  process.exit(0);
}

if (executable === '/usr/bin/clevis') {
  if (args[0] === 'encrypt' && args[1] === 'tang') {
    const input = readFileSync(0, 'utf8');
    let config;
    try {
      config = JSON.parse(args[2]);
    } catch {
      process.exit(1);
    }
    const expected = Object.entries(IPS).find(([, ipv4]) => config.url?.includes(ipv4))?.[0];
    if (
      input !== TANG_TRUST_PROBE || expected === undefined || expected === 'rpi5' ||
      config.thp !== THUMBPRINTS[expected] ||
      (scenario === 'tang-trust-drift' && expected === 'seori-m6-01')
    ) process.exit(1);
    outputRaw(`fixture-protected..fixture-iv.fixture-${expected}.fixture-tag`);
  }
  if (args[0] === 'decrypt' && args.length === 1) {
    const input = readFileSync(0, 'utf8');
    if (!/^fixture-protected\.\.fixture-iv\.fixture-(?:rpi4001|seori-m6-01)\.fixture-tag$/u
      .test(input)) process.exit(1);
    outputRaw(TANG_TRUST_PROBE);
  }
  if (args[1] === 'bind') {
    state.clevis = true;
    saveState();
    if (scenario === 'after-clevis-bind-unknown') process.exit(70);
    process.exit(0);
  }
  if (args[1] === 'list') {
    if (!state.clevis) process.exit(1);
    const policy = {
      t: 1,
      pins: {
        tang: [
          { url: 'http://192.168.0.100:7500', thp: THUMBPRINTS.rpi4001 },
          { url: 'http://192.168.0.118:7500', thp: THUMBPRINTS['seori-m6-01'] },
        ],
      },
    };
    output(`1: sss '${JSON.stringify(policy)}'`);
  }
}

if (executable === '/usr/sbin/mkfs.ext4') {
  state.filesystem = true;
  saveState();
  process.exit(0);
}

if (executable === '/usr/sbin/blkid') output(state.filesystem ? 'ext4' : '');

if (executable === '/usr/bin/mount') {
  state.mounted = true;
  const visibleMarker = fixturePath('/var/lib/seori-auth/.seorilabs-host-encrypted-mount.json');
  const encryptedMarker = fixturePath('/.encrypted-state/seori-auth-marker.json');
  if (existsSync(encryptedMarker)) {
    mkdirSync(dirname(visibleMarker), { recursive: true });
    renameSync(encryptedMarker, visibleMarker);
  }
  saveState();
  process.exit(0);
}

if (executable === '/usr/bin/umount') {
  state.mounted = false;
  const visibleMarker = fixturePath('/var/lib/seori-auth/.seorilabs-host-encrypted-mount.json');
  const encryptedMarker = fixturePath('/.encrypted-state/seori-auth-marker.json');
  if (existsSync(visibleMarker)) {
    mkdirSync(dirname(encryptedMarker), { recursive: true });
    renameSync(visibleMarker, encryptedMarker);
  }
  saveState();
  process.exit(0);
}

if (executable === '/usr/bin/mv') {
  const source = args.at(-2);
  const target = args.at(-1);
  if (
    source === '/data/seori-auth/seori-auth-state.luks' &&
    target === '/data/seori-auth/rollback/seori-auth-state.luks'
  ) {
    renameSync(fixturePath(source), fixturePath(target));
    state.source = false;
    state.rollbackSource = true;
  } else if (
    source === '/data/seori-auth/rollback/seori-auth-state.luks' &&
    target === '/data/seori-auth/seori-auth-state.luks'
  ) {
    renameSync(fixturePath(source), fixturePath(target));
    state.rollbackSource = false;
    state.source = true;
  } else {
    process.exit(64);
  }
  saveState();
  process.exit(0);
}

if (executable === '/usr/bin/systemctl') {
  if (args[0] === 'is-enabled') {
    if (args[1] === 'tangd.socket' || state.unlockerEnabled) output('enabled');
    process.stdout.write(scenario === 'unlocker-masked' ? 'masked\n' : 'disabled\n');
    process.exit(1);
  }
  if (args[0] === 'is-active') {
    if (args[1] === 'tangd.socket') output(state.tangActive ? 'active' : 'inactive');
    if (args[1] === 'clevis-luks-askpass.path') {
      if (scenario === 'unlocker-active-invalid') output('failed');
      if (state.unlockerActive) output('active');
      process.stdout.write('inactive\n');
      process.exit(3);
    }
    output(state.mounted ? 'active' : 'inactive');
  }
  if (args[0] === 'show') output(`[::]:7500 (Stream)`);
  if (args[0] === 'enable' && args.includes('tangd.socket')) {
    state.tangActive = true;
    saveState();
  }
  if (args[0] === 'enable' && args.includes('clevis-luks-askpass.path')) {
    state.unlockerEnabled = true;
    if (args.includes('--now')) state.unlockerActive = true;
    saveState();
  }
  if (args[0] === 'disable' && args.includes('clevis-luks-askpass.path')) {
    state.unlockerEnabled = false;
    saveState();
  }
  if (args[0] === 'start' && args.includes('clevis-luks-askpass.path')) {
    state.unlockerActive = true;
    saveState();
  }
  if (args[0] === 'stop' && args.includes('clevis-luks-askpass.path')) {
    state.unlockerActive = false;
    saveState();
  }
  process.exit(0);
}

if (executable === '/usr/bin/install') {
  if (args.includes('--directory')) {
    const target = fixturePath(args.at(-1));
    mkdirSync(target, { recursive: true });
    const modeArgument = args.find((value) => value.startsWith('--mode='));
    if (modeArgument !== undefined) chmodSync(target, Number.parseInt(modeArgument.slice(7), 8));
  }
  process.exit(0);
}

if (executable === '/usr/bin/chown' || executable === '/usr/bin/chmod') {
  process.exit(0);
}

if (executable === '/usr/bin/cat' && args[0] === '/proc/sys/kernel/random/boot_id') {
  output(state.bootId);
}

if (executable === '/usr/bin/curl') {
  const url = args.at(-1);
  if (url.includes('192.168.0.100') || (url.includes('127.0.0.1') && nodeName === 'rpi4001')) {
    outputRaw('{"server":"rpi4001","adv":1}\n');
  }
  if (url.includes('192.168.0.118') || (url.includes('127.0.0.1') && nodeName === 'seori-m6-01')) {
    outputRaw('{"server":"seori-m6-01","adv":1}\n');
  }
  process.exit(22);
}

if (executable === '/usr/bin/sha256sum') {
  const bytes = readFileSync(fixturePath(args[0]));
  const { createHash } = await import('node:crypto');
  output(`${createHash('sha256').update(bytes).digest('hex')}  ${args[0]}`);
}

if (executable === '/usr/bin/dpkg-query') {
  if (!state.tangInstalled) process.exit(1);
  output('install ok installed\t15-3');
}

if (executable === '/usr/bin/ss') output();

if (executable === '/usr/bin/apt-get') {
  if (args[0] === 'install') state.tangInstalled = true;
  saveState();
  process.exit(0);
}

if (executable === '/usr/bin/tang-show-keys') output(THUMBPRINTS[nodeName]);

if (executable.endsWith('/kubectl')) {
  const commandArgs = args.slice(2);
  const fleet = parse(readFileSync(fileURLToPath(
    new URL('../../contracts/fleet-p3-runtime.yaml', import.meta.url),
  ), 'utf8'));
  const volumeState = fleet.authBroker.state;
  const desired = buildRetainVolumeList(volumeState);
  const pv = structuredClone(desired.items.find(({ kind }) => kind === 'PersistentVolume'));
  const pvc = structuredClone(desired.items.find(({ kind }) => kind === 'PersistentVolumeClaim'));
  pvc.metadata.uid = 'fixture-pvc-uid';
  pvc.metadata.resourceVersion = '17';
  pvc.metadata.annotations = {
    ...pvc.metadata.annotations,
    'pv.kubernetes.io/bind-completed': 'yes',
  };
  pvc.status = {
    phase: 'Bound',
    accessModes: [...pvc.spec.accessModes],
    capacity: { storage: pvc.spec.resources.requests.storage },
  };
  pv.metadata.uid = 'fixture-pv-uid';
  pv.metadata.resourceVersion = '19';
  pv.spec.claimRef.uid = pvc.metadata.uid;
  pv.spec.claimRef.resourceVersion = pvc.metadata.resourceVersion;
  pv.status = { phase: 'Bound' };
  if (scenario === 'pv-drift') pv.metadata.uid = 'substituted-pv-uid';
  if (commandArgs.join('\0') === ['config', 'current-context'].join('\0')) {
    output(args.includes('--kubeconfig=/proc/self/fd/3') ? 'microk8s' : 'vzyx-cluster');
  }
  if (commandArgs.includes('statefulset') || commandArgs.includes('deployment')) {
    const kind = commandArgs.includes('statefulset') ? 'StatefulSet' : 'Deployment';
    const resourceIndex = commandArgs.findIndex((value) =>
      value === 'statefulset' || value === 'deployment');
    output({
      apiVersion: 'apps/v1',
      kind,
      metadata: { name: commandArgs[resourceIndex + 1], namespace: 'auth-broker' },
      spec: { replicas: scenario === 'consumer-active' ? 1 : 0 },
      status: scenario === 'consumer-active' ? { replicas: 1, readyReplicas: 1 } : {},
    });
  }
  if (commandArgs.includes('pods')) {
    const hostPath = scenario === 'consumer-ancestor-hostpath'
      ? '/var/lib'
      : scenario === 'consumer-mapper-hostpath'
        ? '/dev/mapper'
        : undefined;
    const consumerItems = scenario === 'consumer-active' ? [{
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: 'active-state-consumer',
        namespace: 'auth-broker',
        labels: { 'app.kubernetes.io/name': 'seori-auth-broker' },
      },
      spec: {
        volumes: [{
          name: 'state',
          persistentVolumeClaim: { claimName: 'seori-auth-state' },
        }],
      },
      status: { phase: 'Running' },
    }] : hostPath === undefined ? [] : [{
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'unmanaged-host-consumer', namespace: 'other' },
      spec: { volumes: [{ name: 'host', hostPath: { path: hostPath } }] },
      status: { phase: 'Running' },
    }];
    output({
      apiVersion: 'v1',
      kind: 'List',
      items: consumerItems,
    });
  }
  if (commandArgs.includes('persistentvolumeclaim')) output(pvc);
  if (commandArgs.includes('persistentvolume')) output(pv);
}

process.exit(64);
