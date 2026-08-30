#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import { buildRetainVolumeList } from '../../tools/seori-auth/src/state-envelope.mjs';

const args = process.argv.slice(2);
const scenario = process.env.SEORILABS_STATE_FIXTURE_SCENARIO ?? 'exact';
const log = process.env.SEORILABS_STATE_FIXTURE_LOG;
if (log) appendFileSync(log, `${JSON.stringify(args)}\n`, 'utf8');
const environmentLog = process.env.SEORILABS_STATE_FIXTURE_ENV_LOG;
if (environmentLog) {
  appendFileSync(environmentLog, `${JSON.stringify({
    HOME: process.env.HOME,
    KUBECONFIG: process.env.KUBECONFIG,
    TMPDIR: process.env.TMPDIR,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  })}\n`, 'utf8');
}

const [kubeconfigArgument, cacheArgument, ...commandArgs] = args;
if (
  !kubeconfigArgument?.startsWith('--kubeconfig=/') ||
  !cacheArgument?.startsWith('--cache-dir=/')
) process.exit(64);

function output(value) {
  if (value !== undefined) {
    process.stdout.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value)}\n`);
  }
  process.exit(0);
}

const contractPath = fileURLToPath(
  new URL('../../contracts/fleet-p3-runtime.yaml', import.meta.url),
);
const state = parse(readFileSync(contractPath, 'utf8')).authBroker.state;
const desired = buildRetainVolumeList(state);
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

if (scenario === 'destructive-reclaim') pv.spec.persistentVolumeReclaimPolicy = 'Delete';
if (scenario === 'wrong-node') {
  pv.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values = ['rpi4001'];
}
if (scenario === 'wrong-storage-class') pvc.spec.storageClassName = 'lookalike-hostpath';
if (scenario === 'claim-uid-mismatch') pv.spec.claimRef.uid = 'other-pvc-uid';
if (scenario === 'volume-drift') pvc.spec.resources.requests.storage = '11Gi';
if (scenario === 'deleting') pvc.metadata.deletionTimestamp = '2026-08-30T00:00:00.000Z';
if (scenario === 'unbound') pv.status.phase = 'Available';

if (commandArgs.join('\0') === ['config', 'current-context'].join('\0')) {
  output(scenario === 'wrong-context' ? 'other-cluster' : state.volume.kubernetesContext);
}

const pvArgs = [
  '--context', state.volume.kubernetesContext, 'get', 'persistentvolume',
  state.volume.volumeName, '--output=json', '--ignore-not-found=true',
];
if (commandArgs.join('\0') === pvArgs.join('\0')) {
  if (scenario === 'unknown-pv') process.exit(70);
  output(['missing-both', 'missing-pv'].includes(scenario) ? undefined : pv);
}

const pvcArgs = [
  '--context', state.volume.kubernetesContext, 'get', 'persistentvolumeclaim',
  state.volume.claimName, '--namespace', state.volume.namespace, '--output=json',
  '--ignore-not-found=true',
];
if (commandArgs.join('\0') === pvcArgs.join('\0')) {
  output(['missing-both', 'missing-pvc'].includes(scenario) ? undefined : pvc);
}

process.exit(64);
