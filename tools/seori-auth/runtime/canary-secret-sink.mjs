import { readFileSync } from 'node:fs';

const descriptor = Number(process.env.SEORI_AUTH_SECRET_FD);
if (descriptor !== 3 || process.argv.length !== 2) process.exit(64);

let bytes;
try {
  bytes = readFileSync(descriptor);
  if (bytes.length < 16 || bytes.length > 4_096) process.exitCode = 65;
} finally {
  if (Buffer.isBuffer(bytes)) bytes.fill(0);
}
