#!/usr/bin/env node

import { timingSafeEqual } from 'node:crypto';

import {
  EXPECTED_CANARY_OUTPUT,
  EXPECTED_CANARY_OUTPUT_SHA256,
} from './public-image-binding.mjs';

function fail() {
  process.stderr.write(`${JSON.stringify({
    valid: false,
    code: 'canary_output_not_allowlisted',
  })}\n`);
  process.exit(1);
}

if (process.argv.length !== 2) fail();

const chunks = [];
let size = 0;
for await (const value of process.stdin) {
  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
  size += chunk.length;
  if (size > 128) {
    chunk.fill(0);
    for (const buffered of chunks) buffered.fill(0);
    fail();
  }
  chunks.push(chunk);
}

const actual = Buffer.concat(chunks);
const expected = Buffer.from(EXPECTED_CANARY_OUTPUT);
const valid = actual.length === expected.length && timingSafeEqual(actual, expected);
for (const chunk of chunks) chunk.fill(0);
actual.fill(0);
expected.fill(0);

if (!valid) fail();
process.stdout.write(`${JSON.stringify({
  state: 'CANARY_OUTPUT_VERIFIED',
  sha256: EXPECTED_CANARY_OUTPUT_SHA256,
})}\n`);
