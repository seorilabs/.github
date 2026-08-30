#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import {
  StateEnvelopeError,
  verifyApplicationEnvelopeContract,
  verifyRetainVolumeReadback,
} from '../../tools/seori-auth/src/state-envelope.mjs';
import {
  KubectlReadbackBoundaryError,
  openSecureKubectlReadbackBoundary,
} from '../../tools/seori-auth/src/kubectl-readback-boundary.mjs';

const contractPath = fileURLToPath(
  new URL('../../contracts/fleet-p3-runtime.yaml', import.meta.url),
);
const mode = process.argv[2];
const kubectl = process.env.SEORILABS_KUBECTL ?? '/usr/local/bin/kubectl';
const fixtureRuntime = process.env.SEORILABS_STATE_FIXTURE_RUNTIME;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
let readbackBoundary;

class VerificationFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new VerificationFailure(code);
}

function configureMode() {
  if (mode === 'contract' && process.argv.length === 3) return;
  if (
    mode !== 'live-readback' || process.argv.length !== 4 ||
    !process.argv[3].startsWith('--kubeconfig=')
  ) fail('STATE_ENVELOPE_COMMAND_INVALID');
  const requestedKubeconfig = process.argv[3].slice('--kubeconfig='.length);
  try {
    readbackBoundary = openSecureKubectlReadbackBoundary(requestedKubeconfig);
  } catch (error) {
    if (error instanceof KubectlReadbackBoundaryError) fail(error.code);
    fail('KUBECONFIG_PATH_INVALID');
  }
}

function canonicalRegularPath(path, code, executable = false) {
  try {
    const entry = lstatSync(path);
    if (
      !isAbsolute(path) || !entry.isFile() || entry.isSymbolicLink() ||
      realpathSync(path) !== path || (executable && (entry.mode & 0o111) === 0)
    ) fail(code);
    return path;
  } catch (error) {
    if (error instanceof VerificationFailure) throw error;
    fail(code);
  }
}

function childEnvironment() {
  return {
    ...readbackBoundary.environment,
    ...(process.env.SEORILABS_STATE_FIXTURE_SCENARIO === undefined ? {} : {
      SEORILABS_STATE_FIXTURE_SCENARIO: process.env.SEORILABS_STATE_FIXTURE_SCENARIO,
    }),
    ...(process.env.SEORILABS_STATE_FIXTURE_LOG === undefined ? {} : {
      SEORILABS_STATE_FIXTURE_LOG: process.env.SEORILABS_STATE_FIXTURE_LOG,
    }),
    ...(process.env.SEORILABS_STATE_FIXTURE_ENV_LOG === undefined ? {} : {
      SEORILABS_STATE_FIXTURE_ENV_LOG: process.env.SEORILABS_STATE_FIXTURE_ENV_LOG,
    }),
  };
}

function kubectlArgs(args) {
  return [
    `--kubeconfig=${readbackBoundary.kubeconfig}`,
    `--cache-dir=${readbackBoundary.cacheDirectory}`,
    ...args,
  ];
}

function run(executable, args, code) {
  try {
    return execFileSync(executable, args, {
      encoding: 'utf8',
      env: childEnvironment(),
      maxBuffer: MAX_OUTPUT_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    }).trim();
  } catch (error) {
    if (error instanceof VerificationFailure) throw error;
    fail(code);
  }
}

function runCommand(executable, args, code) {
  const commandPath = canonicalRegularPath(executable, code, true);
  if (fixtureRuntime === undefined) return run(commandPath, args, code);
  if (
    process.env.SEORILABS_STATE_FIXTURE_SCENARIO === undefined ||
    process.env.SEORILABS_KUBECTL === undefined
  ) fail('STATE_ENVELOPE_FIXTURE_RUNTIME_INVALID');
  const runtimePath = canonicalRegularPath(
    fixtureRuntime,
    'STATE_ENVELOPE_FIXTURE_RUNTIME_INVALID',
    true,
  );
  return run(runtimePath, [commandPath, ...args], code);
}

function optionalPublicJson(text, invalidCode) {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    fail(invalidCode);
  }
}

function loadState() {
  let bytes;
  try {
    bytes = readFileSync(contractPath);
    if (bytes.length === 0 || bytes.length > 512 * 1024) {
      fail('STATE_ENVELOPE_CONTRACT_INVALID');
    }
    return parse(bytes.toString('utf8'))?.authBroker?.state;
  } catch (error) {
    if (error instanceof VerificationFailure) throw error;
    fail('STATE_ENVELOPE_CONTRACT_INVALID');
  } finally {
    if (Buffer.isBuffer(bytes)) bytes.fill(0);
  }
}

function liveReadback(state) {
  const { volume } = state;
  const currentContext = runCommand(
    kubectl,
    kubectlArgs(['config', 'current-context']),
    'STATE_VOLUME_CONTEXT_READ_FAILED',
  );
  if (currentContext !== volume.kubernetesContext) fail('STATE_VOLUME_CONTEXT_MISMATCH');
  const observedPv = optionalPublicJson(
    runCommand(
      kubectl,
      kubectlArgs([
        '--context', volume.kubernetesContext, 'get', 'persistentvolume', volume.volumeName,
        '--output=json', '--ignore-not-found=true',
      ]),
      'STATE_VOLUME_LIVE_READBACK_FAILED',
    ),
    'STATE_VOLUME_LIVE_READBACK_INVALID',
  );
  const observedPvc = optionalPublicJson(
    runCommand(
      kubectl,
      kubectlArgs([
        '--context', volume.kubernetesContext, 'get', 'persistentvolumeclaim',
        volume.claimName, '--namespace', volume.namespace, '--output=json',
        '--ignore-not-found=true',
      ]),
      'STATE_VOLUME_LIVE_READBACK_FAILED',
    ),
    'STATE_VOLUME_LIVE_READBACK_INVALID',
  );
  return verifyRetainVolumeReadback({ state, observedPv, observedPvc });
}

try {
  configureMode();
  const state = loadState();
  const result = mode === 'contract'
    ? verifyApplicationEnvelopeContract(state)
    : liveReadback(state);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const code = error instanceof StateEnvelopeError || error instanceof VerificationFailure
    ? error.code
    : 'STATE_ENVELOPE_VERIFICATION_FAILED';
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exitCode = 1;
} finally {
  try {
    readbackBoundary?.close();
  } catch {
    process.stderr.write(`${JSON.stringify({ ok: false, code: 'KUBECTL_TEMP_BOUNDARY_INVALID' })}\n`);
    process.exitCode = 1;
  }
}
