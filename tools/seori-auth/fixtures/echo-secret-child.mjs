import { readFileSync, writeFileSync } from 'node:fs';

if (process.env.TEST_CAPTURE_FILE) {
  writeFileSync(process.env.TEST_CAPTURE_FILE, JSON.stringify({
    argv: process.argv,
    env: process.env,
  }));
}

const fd = Number.parseInt(process.env.SEORI_AUTH_SECRET_FD ?? '', 10);
const secret = readFileSync(fd, 'utf8');
process.stdout.write(`adapter stdout secret=${secret}\n`);
process.stderr.write(`Authorization: Bearer ${secret}\n`);
process.stdout.write(`transformed=${Buffer.from(secret).toString('base64')}\n`);
