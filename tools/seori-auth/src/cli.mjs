#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

import { PolicyEngine } from './policy.mjs';
import { classifyReauth } from './reauth.mjs';

function usage() {
  process.stderr.write('Usage: seori-auth validate-policy <file> | classify-reauth <code>\n');
  process.exitCode = 2;
}

const [, , command, argument, ...rest] = process.argv;

try {
  if (!argument || rest.length > 0) {
    usage();
  } else if (command === 'validate-policy') {
    const policy = JSON.parse(await readFile(argument, 'utf8'));
    const engine = new PolicyEngine(policy);
    process.stdout.write(`${JSON.stringify({ valid: true, schemaVersion: 1, generation: engine.generation, rules: engine.rules.length })}\n`);
  } else if (command === 'classify-reauth') {
    process.stdout.write(`${JSON.stringify(classifyReauth(argument))}\n`);
  } else {
    usage();
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ valid: false, code: error.code ?? 'invalid_input', message: error.message })}\n`);
  process.exitCode = 1;
}
