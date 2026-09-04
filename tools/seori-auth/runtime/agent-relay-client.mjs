#!/usr/bin/env node

import { isAbsolute } from 'node:path';

import {
  assertAgentRelayClientSocket,
  assertAgentRelayPublicRequest,
  executeAgentRelayClientRequest,
} from '../src/index.mjs';

const REQUEST_LIMIT = 6 * 1024 * 1024;

function fail() {
  throw new Error('agent relay client rejected the request');
}

function socketArgument(argv) {
  if (argv.length !== 1 || !argv[0].startsWith('--socket=')) fail();
  const path = argv[0].slice('--socket='.length);
  if (!isAbsolute(path) || path.includes('\0')) fail();
  return path;
}

async function stdinJson() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const copy = Buffer.from(chunk);
    bytes += copy.length;
    if (bytes > REQUEST_LIMIT) {
      copy.fill(0);
      chunks.forEach((entry) => entry.fill(0));
      fail();
    }
    chunks.push(copy);
  }
  const encoded = Buffer.concat(chunks);
  try {
    return assertAgentRelayPublicRequest(JSON.parse(encoded.toString('utf8')));
  } finally {
    encoded.fill(0);
    chunks.forEach((entry) => entry.fill(0));
  }
}

async function main() {
  const socketPath = socketArgument(process.argv.slice(2));
  await assertAgentRelayClientSocket(socketPath);
  const encoded = Buffer.from(JSON.stringify(await stdinJson()), 'utf8');
  try {
    const result = await executeAgentRelayClientRequest({ socketPath, encoded });
    const output = Buffer.from(`${JSON.stringify(result.body)}\n`, 'utf8');
    process.stdout.write(output, () => output.fill(0));
    if (result.statusCode < 200 || result.statusCode >= 300) process.exitCode = 1;
  } finally {
    encoded.fill(0);
  }
}

main().catch(() => {
  process.stderr.write('seori-auth agent relay client failed code=CLIENT_REJECTED\n');
  process.exitCode = 1;
});
