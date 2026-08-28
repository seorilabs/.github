import { readFileSync } from 'node:fs';

if (process.platform !== 'linux' || process.argv.length !== 2) process.exit(64);

let limits;
let status;
try {
  limits = readFileSync('/proc/self/limits');
  status = readFileSync('/proc/self/status');
  const coreDisabled = /^Max core file size\s+0\s+0\s+/m.test(limits.toString('utf8'));
  const noNewPrivileges = /^NoNewPrivs:\s+1$/m.test(status.toString('utf8'));
  if (!coreDisabled || !noNewPrivileges) process.exitCode = 65;
} finally {
  if (Buffer.isBuffer(limits)) limits.fill(0);
  if (Buffer.isBuffer(status)) status.fill(0);
}

if (process.exitCode === undefined) {
  process.stdout.write(`${JSON.stringify({ state: 'PROCESS_HARDENING_OK', coreDumps: false, noNewPrivileges: true })}\n`);
}
