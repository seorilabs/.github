import { closeSync, readFileSync } from 'node:fs';

const expected = 'FAKE_K8S_PROJECTED_TOKEN_CANARY_20260828';
if (process.argv.length !== 2 || process.env.SEORI_AUTH_SUBJECT_TOKEN_FD !== '4') process.exit(64);

const first = readFileSync(4);
closeSync(4);
delete process.env.SEORI_AUTH_SUBJECT_TOKEN_FD;
let descriptorClosed = false;
try {
  readFileSync(4);
} catch (error) {
  descriptorClosed = error?.code === 'EBADF';
}
try {
  if (first.toString('utf8').trim() !== expected || !descriptorClosed) process.exitCode = 65;
} finally {
  first.fill(0);
}
if (process.exitCode === undefined) {
  process.stdout.write(`${JSON.stringify({ state: 'PROJECTED_TOKEN_OK', tokenExposed: false, fdReusable: false })}\n`);
}
