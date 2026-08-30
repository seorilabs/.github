import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';

const require = createRequire(import.meta.url);
const SHA40 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const localMarkers = Object.freeze([
  'SEORI_AUTH_NATIVE_LAUNCHED',
  'SEORI_AUTH_PROCESS_BOUNDARY_FD',
  'SEORI_AUTH_LOCAL_CONTROLLER_FD',
  'SEORI_AUTH_LOCAL_SOURCE_RECEIPT_FD',
  'SEORI_AUTH_LOCAL_SOURCE_SHA',
  'SEORI_AUTH_LOCAL_CONTROLLER_SHA256',
  'SEORI_AUTH_LOCAL_SOURCE_RECEIPT_SHA256',
]);
const expectedReceipts = Object.freeze({
  linux: Object.freeze({
    state: 'PROCESS_HARDENING_OK',
    coreSoft: 0,
    coreHard: 0,
    dumpable: 0,
    noNewPrivileges: 1,
  }),
  darwin: Object.freeze({
    state: 'PROCESS_HARDENING_OK',
    coreSoft: 0,
    coreHard: 0,
    denyAttachApplied: true,
  }),
});

function assertReceipt(receipt, expectedReceipt) {
  if (
    receipt === null || typeof receipt !== 'object' || Array.isArray(receipt) ||
    Object.keys(receipt).toSorted().join('\0') !==
      Object.keys(expectedReceipt).toSorted().join('\0') ||
    Object.entries(expectedReceipt).some(([key, value]) => receipt[key] !== value)
  ) throw new Error('P2_PROCESS_BOUNDARY_RECEIPT_INVALID');
}

function assertRootTrustedPath(path) {
  if (!isAbsolute(path) || realpathSync(path) !== path) {
    throw new Error('P2_PROCESS_BOUNDARY_PATH_INVALID');
  }
  const root = lstatSync('/');
  if (
    root.isSymbolicLink() || !root.isDirectory() || root.uid !== 0 || (root.mode & 0o022) !== 0
  ) throw new Error('P2_PROCESS_BOUNDARY_PATH_INVALID');
  const parts = path.split('/').filter(Boolean);
  let current = '';
  for (const [index, part] of parts.entries()) {
    current += `/${part}`;
    const entry = lstatSync(current);
    const leaf = index === parts.length - 1;
    if (
      entry.isSymbolicLink() || entry.uid !== 0 || (entry.mode & 0o022) !== 0 ||
      (leaf ? !entry.isFile() : !entry.isDirectory())
    ) throw new Error('P2_PROCESS_BOUNDARY_PATH_INVALID');
  }
}

function assertCurrentUserPath(path, { leafMode, maximum, exactDirectories = new Map() }) {
  if (!isAbsolute(path) || realpathSync(path) !== path || process.geteuid?.() === undefined) {
    throw new Error('P2_LOCAL_PROCESS_BOUNDARY_PATH_INVALID');
  }
  const user = process.geteuid();
  const root = lstatSync('/');
  if (
    root.isSymbolicLink() || !root.isDirectory() || root.uid !== 0 || (root.mode & 0o022) !== 0
  ) throw new Error('P2_LOCAL_PROCESS_BOUNDARY_PATH_INVALID');
  const parts = path.split('/').filter(Boolean);
  let current = '';
  for (const [index, part] of parts.entries()) {
    current += `/${part}`;
    const entry = lstatSync(current);
    const leaf = index === parts.length - 1;
    if (
      entry.isSymbolicLink() || (entry.uid !== 0 && entry.uid !== user) ||
      (entry.mode & 0o022) !== 0 || (leaf ? !entry.isFile() : !entry.isDirectory())
    ) throw new Error('P2_LOCAL_PROCESS_BOUNDARY_PATH_INVALID');
    const exactMode = exactDirectories.get(current);
    if (!leaf && exactMode !== undefined && (entry.mode & 0o7777) !== exactMode) {
      throw new Error('P2_LOCAL_PROCESS_BOUNDARY_PATH_INVALID');
    }
    if (leaf && (
      entry.uid !== user || (entry.mode & 0o7777) !== leafMode || entry.nlink !== 1 ||
      entry.size < 1 || entry.size > maximum
    )) throw new Error('P2_LOCAL_PROCESS_BOUNDARY_PATH_INVALID');
  }
  return lstatSync(path);
}

function sameEntry(first, second) {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size &&
    first.mode === second.mode && first.uid === second.uid && first.gid === second.gid &&
    first.nlink === second.nlink;
}

function readBoundFile(descriptor, pathEntry, maximum) {
  const before = fstatSync(descriptor);
  if (!sameEntry(before, pathEntry) || !before.isFile() || before.size > maximum) {
    throw new Error('P2_LOCAL_PROCESS_BOUNDARY_FD_INVALID');
  }
  const bytes = readFileSync(descriptor);
  const after = fstatSync(descriptor);
  if (!sameEntry(before, after) || bytes.length !== before.size) {
    bytes.fill(0);
    throw new Error('P2_LOCAL_PROCESS_BOUNDARY_FD_INVALID');
  }
  return bytes;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertExactObject(value, expectedKeys, code) {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).toSorted().join('\0') !== [...expectedKeys].toSorted().join('\0')
  ) throw new Error(code);
}

function activateLocalBoundary(processBoundary, context, expectedReceipt) {
  const expectedBoundary = Object.freeze({
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
  assertExactObject(
    processBoundary, Object.keys(expectedBoundary), 'P2_LOCAL_PROCESS_BOUNDARY_CONTRACT_INVALID',
  );
  if (Object.entries(expectedBoundary).some(([key, value]) => processBoundary[key] !== value)) {
    throw new Error('P2_LOCAL_PROCESS_BOUNDARY_CONTRACT_INVALID');
  }
  const expectedContextKeys = [
    'trustedRoot', 'sourceSha', 'archiveSha256', 'packageLockSha256', 'contractDigest',
    'controllerSha256', 'runtimeManifestSha256', 'runtimeFileCount',
    'sourceReceiptSha256', 'controllerExecutable',
  ];
  assertExactObject(context, expectedContextKeys, 'P2_LOCAL_PROCESS_BOUNDARY_CONTEXT_INVALID');
  if (
    process.platform !== 'darwin' || process.arch !== 'arm64' ||
    !SHA40.test(context.sourceSha ?? '') ||
    ![
      context.archiveSha256, context.packageLockSha256, context.contractDigest,
      context.controllerSha256, context.runtimeManifestSha256, context.sourceReceiptSha256,
    ].every((value) => SHA256.test(value ?? '')) ||
    !Number.isSafeInteger(context.runtimeFileCount) || context.runtimeFileCount < 1 ||
    process.env.SEORI_AUTH_NATIVE_LAUNCHED !== '1' ||
    process.env.SEORI_AUTH_PROCESS_BOUNDARY_FD !== '5' ||
    process.env.SEORI_AUTH_LOCAL_CONTROLLER_FD !== '6' ||
    process.env.SEORI_AUTH_LOCAL_SOURCE_RECEIPT_FD !== '7' ||
    process.env.SEORI_AUTH_LOCAL_SOURCE_SHA !== context.sourceSha ||
    process.env.SEORI_AUTH_LOCAL_CONTROLLER_SHA256 !== context.controllerSha256 ||
    process.env.SEORI_AUTH_LOCAL_SOURCE_RECEIPT_SHA256 !== context.sourceReceiptSha256
  ) throw new Error('P2_LOCAL_PROCESS_BOUNDARY_LAUNCH_REQUIRED');

  const sourceRoot = dirname(dirname(dirname(context.controllerExecutable)));
  const expectedController = join(sourceRoot, processBoundary.controllerRelativePath);
  const expectedRuntimeSuffix = join(processBoundary.runtimeRootRelativePath, context.sourceSha);
  if (
    context.controllerExecutable !== expectedController ||
    !sourceRoot.endsWith(`/${expectedRuntimeSuffix}`)
  ) throw new Error('P2_LOCAL_PROCESS_BOUNDARY_SOURCE_INVALID');
  const modulePath = join(context.trustedRoot, processBoundary.moduleRelativePath);
  const receiptPath = join(sourceRoot, processBoundary.sourceReceiptLeaf);
  const user = process.geteuid();
  const exactDirectories = new Map([
    [context.trustedRoot, 0o700],
    [dirname(modulePath), 0o700],
    [dirname(dirname(sourceRoot)), 0o700],
    [dirname(sourceRoot), 0o700],
    [sourceRoot, 0o700],
    [dirname(dirname(context.controllerExecutable)), 0o700],
    [dirname(context.controllerExecutable), 0o700],
  ]);
  const moduleEntry = assertCurrentUserPath(modulePath, {
    leafMode: 0o400, maximum: 8 * 1024 * 1024, exactDirectories,
  });
  const controllerEntry = assertCurrentUserPath(context.controllerExecutable, {
    leafMode: 0o400, maximum: 8 * 1024 * 1024, exactDirectories,
  });
  const receiptEntry = assertCurrentUserPath(receiptPath, {
    leafMode: 0o400, maximum: 64 * 1024, exactDirectories,
  });
  if (moduleEntry.uid !== user || controllerEntry.uid !== user || receiptEntry.uid !== user) {
    throw new Error('P2_LOCAL_PROCESS_BOUNDARY_PATH_INVALID');
  }

  let receiptBytes;
  let controllerBytes;
  try {
    if (!sameEntry(fstatSync(5), moduleEntry)) {
      throw new Error('P2_LOCAL_PROCESS_BOUNDARY_FD_INVALID');
    }
    controllerBytes = readBoundFile(6, controllerEntry, 8 * 1024 * 1024);
    receiptBytes = readBoundFile(7, receiptEntry, 64 * 1024);
    if (
      digest(controllerBytes) !== context.controllerSha256 ||
      digest(receiptBytes) !== context.sourceReceiptSha256
    ) throw new Error('P2_LOCAL_PROCESS_BOUNDARY_DIGEST_INVALID');
    let sourceReceipt;
    try {
      sourceReceipt = JSON.parse(receiptBytes.toString('utf8'));
    } catch {
      throw new Error('P2_LOCAL_PROCESS_BOUNDARY_SOURCE_RECEIPT_INVALID');
    }
    const receiptKeys = [
      'schemaVersion', 'state', 'sourceRepository', 'sourceSha', 'archiveSha256',
      'packageLockSha256', 'contractDigest', 'controllerRelativePath',
      'controllerSha256', 'runtimeManifestSha256', 'runtimeFileCount', 'secretExposed',
    ];
    assertExactObject(
      sourceReceipt, receiptKeys, 'P2_LOCAL_PROCESS_BOUNDARY_SOURCE_RECEIPT_INVALID',
    );
    if (
      sourceReceipt.schemaVersion !== 1 || sourceReceipt.state !== 'P2_STAGE1_LOCAL_RUNTIME_READY' ||
      sourceReceipt.sourceRepository !== 'seorilabs/.github' ||
      sourceReceipt.sourceSha !== context.sourceSha ||
      sourceReceipt.archiveSha256 !== context.archiveSha256 ||
      sourceReceipt.packageLockSha256 !== context.packageLockSha256 ||
      sourceReceipt.contractDigest !== context.contractDigest ||
      sourceReceipt.controllerRelativePath !== processBoundary.controllerRelativePath ||
      sourceReceipt.controllerSha256 !== context.controllerSha256 ||
      sourceReceipt.runtimeManifestSha256 !== context.runtimeManifestSha256 ||
      sourceReceipt.runtimeFileCount !== context.runtimeFileCount ||
      sourceReceipt.secretExposed !== false
    ) throw new Error('P2_LOCAL_PROCESS_BOUNDARY_SOURCE_RECEIPT_INVALID');

    const nativeModule = { exports: {} };
    process.dlopen(nativeModule, '/dev/fd/5');
    assertReceipt(nativeModule.exports, expectedReceipt);
    return expectedReceipt;
  } finally {
    receiptBytes?.fill(0);
    controllerBytes?.fill(0);
  }
}

export function activateP2ProcessHardening(processBoundary, context = undefined) {
  const expectedReceipt = expectedReceipts[process.platform];
  if (expectedReceipt === undefined) throw new Error('P2_PROCESS_BOUNDARY_LAUNCH_REQUIRED');
  const local = processBoundary?.loadPolicy === 'NATIVE_FD5_BIND_PROCESS_DLOPEN_CONSUME';
  const boundDescriptors = local ? [
    ['SEORI_AUTH_PROCESS_BOUNDARY_FD', '5', 5],
    ['SEORI_AUTH_LOCAL_CONTROLLER_FD', '6', 6],
    ['SEORI_AUTH_LOCAL_SOURCE_RECEIPT_FD', '7', 7],
  ].filter(([marker, value]) => process.env[marker] === value) : [];
  try {
    if (local) return activateLocalBoundary(processBoundary, context, expectedReceipt);
    const launchMarker = processBoundary?.launchMarker;
    if (
      context !== undefined || launchMarker !== 'SEORI_AUTH_NATIVE_LAUNCHED' ||
      process.env[launchMarker] !== '1'
    ) throw new Error('P2_PROCESS_BOUNDARY_LAUNCH_REQUIRED');
    assertRootTrustedPath(processBoundary.moduleExecutable);
    const receipt = require(processBoundary.moduleExecutable);
    assertReceipt(receipt, expectedReceipt);
    return expectedReceipt;
  } finally {
    if (local) {
      let closeFailed = false;
      for (const [, , descriptor] of boundDescriptors) {
        try {
          closeSync(descriptor);
        } catch {
          closeFailed = true;
        }
      }
      for (const marker of localMarkers) delete process.env[marker];
      if (closeFailed) throw new Error('P2_LOCAL_PROCESS_BOUNDARY_FD_CLOSE_FAILED');
    } else if (processBoundary?.launchMarker !== undefined) {
      delete process.env[processBoundary.launchMarker];
    }
  }
}
