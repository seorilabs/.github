import { isAbsolute } from 'node:path';

import { fail } from './errors.mjs';

const SENSITIVE_ENV_NAME = /(AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/i;
const FORBIDDEN_ENV = new Set(['NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']);

function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    fail('invalid_adapter', 'adapter must be an object');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(adapter.id ?? '')) {
    fail('invalid_adapter', 'adapter.id must be a lowercase identifier');
  }
  if (typeof adapter.executable !== 'string' || !isAbsolute(adapter.executable)) {
    fail('invalid_adapter', 'adapter.executable must be an absolute path');
  }
  if (!Array.isArray(adapter.providers) || adapter.providers.length === 0) {
    fail('invalid_adapter', 'adapter.providers must be a non-empty array');
  }
  if (!Array.isArray(adapter.capabilities) || adapter.capabilities.length === 0) {
    fail('invalid_adapter', 'adapter.capabilities must be a non-empty array');
  }
  if (adapter.providers.some((provider) => !/^[a-z0-9][a-z0-9-]*$/.test(provider))) {
    fail('invalid_adapter', 'adapter.providers contains an invalid provider id');
  }
  if (adapter.capabilities.some((capability) => !/^[a-z0-9][a-z0-9.-]*$/.test(capability))) {
    fail('invalid_adapter', 'adapter.capabilities contains an invalid capability');
  }
  if (adapter.credentialDelivery !== 'fd3') {
    fail('invalid_adapter', 'trusted adapters must receive credentials through file descriptor 3');
  }
  if (typeof adapter.buildArgs !== 'function') {
    fail('invalid_adapter', 'adapter.buildArgs must be a function');
  }

  const environment = adapter.environment ?? {};
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    fail('invalid_adapter', 'adapter.environment must be an object');
  }
  for (const [name, value] of Object.entries(environment)) {
    if (
      FORBIDDEN_ENV.has(name) ||
      SENSITIVE_ENV_NAME.test(name) ||
      typeof value !== 'string' ||
      value.includes('\0')
    ) {
      fail('invalid_adapter', `adapter environment field is forbidden: ${name}`);
    }
  }

  const timeoutMs = adapter.timeoutMs ?? 120_000;
  const maxOutputBytes = adapter.maxOutputBytes ?? 65_536;
  if (adapter.cwd !== undefined && (typeof adapter.cwd !== 'string' || !isAbsolute(adapter.cwd))) {
    fail('invalid_adapter', 'adapter.cwd must be an absolute path when provided');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    fail('invalid_adapter', 'adapter.timeoutMs must be between 1000 and 300000');
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1_024 || maxOutputBytes > 1_048_576) {
    fail('invalid_adapter', 'adapter.maxOutputBytes must be between 1024 and 1048576');
  }

  return Object.freeze({
    id: adapter.id,
    executable: adapter.executable,
    providers: Object.freeze([...adapter.providers]),
    capabilities: Object.freeze([...adapter.capabilities]),
    credentialDelivery: adapter.credentialDelivery,
    buildArgs: adapter.buildArgs,
    environment: Object.freeze({ ...environment }),
    timeoutMs,
    maxOutputBytes,
    cwd: adapter.cwd,
  });
}

export class TrustedAdapterRegistry {
  #adapters = new Map();

  constructor(adapters = []) {
    for (const adapter of adapters) {
      const normalized = validateAdapter(adapter);
      if (this.#adapters.has(normalized.id)) {
        fail('invalid_adapter', `duplicate adapter id: ${normalized.id}`);
      }
      this.#adapters.set(normalized.id, normalized);
    }
  }

  require(adapterId, binding) {
    const adapter = this.#adapters.get(adapterId);
    if (!adapter) {
      fail('adapter_not_trusted', 'lease references an adapter outside the trusted registry');
    }
    if (!adapter.providers.includes(binding.provider) || !adapter.capabilities.includes(binding.capability)) {
      fail('adapter_scope_mismatch', 'trusted adapter scope does not match the lease binding');
    }

    const args = adapter.buildArgs(binding);
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
      fail('invalid_adapter', 'adapter.buildArgs must return safe string arguments');
    }

    return Object.freeze({ ...adapter, args: Object.freeze([...args]) });
  }
}
