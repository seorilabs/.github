#!/usr/bin/env node

import { fstatSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const options = new Map();
for (const argument of process.argv.slice(2)) {
  const separator = argument.indexOf('=');
  if (!argument.startsWith('--') || separator < 3) throw new Error('P2 local fixture input invalid');
  options.set(argument.slice(2, separator), argument.slice(separator + 1));
}

const required = [
  'boundary-module', 'trusted-root', 'source-sha', 'archive-sha256',
  'package-lock-sha256', 'contract-digest', 'controller-sha256',
  'runtime-manifest-sha256', 'runtime-file-count', 'source-receipt-sha256',
];
if (
  options.size !== required.length || required.some((key) => !options.has(key))
) throw new Error('P2 local fixture input invalid');

const boundary = Object.freeze({
  launcherRelativePath: 'bin/seori-auth-native',
  moduleRelativePath: 'bin/seorilabs-p2-process-hardening.node',
  receiptRelativePath: 'bin/stage1-process-boundary-v2.json',
  launcherMode: '0500',
  moduleMode: '0400',
  receiptMode: '0400',
  launchMarker: 'SEORI_AUTH_NATIVE_LAUNCHED',
  launchOperation: 'launch-local-controller',
  moduleFd: 5,
  controllerFd: 6,
  sourceReceiptFd: 7,
  runtimeRootRelativePath: '.local/share/seorilabs/fleet-p2',
  sourceArchiveLeaf: 'source.tar',
  sourceReceiptLeaf: 'stage1-local-source.json',
  controllerRelativePath: 'scripts/fleet/provision-p2-stage1.mjs',
  directoryMode: '0700',
  sourceFileMode: '0400',
  installPolicy: 'CURRENT_UID_CREATE_ONLY_OR_EXACT',
  loadPolicy: 'NATIVE_FD5_BIND_PROCESS_DLOPEN_CONSUME',
  sameUidThreatPolicy: 'SAME_UID_MUTATION_OUT_OF_SCOPE_AUDITED_BEFORE_EACH_RUN',
});

try {
  const { activateP2ProcessHardening } = await import(pathToFileURL(
    options.get('boundary-module'),
  ));
  const receipt = activateP2ProcessHardening(boundary, {
    trustedRoot: options.get('trusted-root'),
    sourceSha: options.get('source-sha'),
    archiveSha256: options.get('archive-sha256'),
    packageLockSha256: options.get('package-lock-sha256'),
    contractDigest: options.get('contract-digest'),
    controllerSha256: options.get('controller-sha256'),
    runtimeManifestSha256: options.get('runtime-manifest-sha256'),
    runtimeFileCount: Number(options.get('runtime-file-count')),
    sourceReceiptSha256: options.get('source-receipt-sha256'),
    controllerExecutable: fileURLToPath(import.meta.url),
  });
  let descriptorsClosed = true;
  for (const descriptor of [5, 6, 7]) {
    try {
      fstatSync(descriptor);
      descriptorsClosed = false;
    } catch (error) {
      if (error?.code !== 'EBADF') descriptorsClosed = false;
    }
  }
  const markersCleared = [
    'SEORI_AUTH_NATIVE_LAUNCHED',
    'SEORI_AUTH_PROCESS_BOUNDARY_FD',
    'SEORI_AUTH_LOCAL_CONTROLLER_FD',
    'SEORI_AUTH_LOCAL_SOURCE_RECEIPT_FD',
    'SEORI_AUTH_LOCAL_SOURCE_SHA',
    'SEORI_AUTH_LOCAL_CONTROLLER_SHA256',
    'SEORI_AUTH_LOCAL_SOURCE_RECEIPT_SHA256',
  ].every((marker) => process.env[marker] === undefined);
  process.stdout.write(`${JSON.stringify({ ...receipt, descriptorsClosed, markersCleared })}\n`);
} catch {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: 'P2_LOCAL_PROCESS_HARDENING_BOUNDARY_FAILED',
  })}\n`);
  process.exitCode = 1;
}
