import { readFileSync } from 'node:fs';

const fd = Number.parseInt(process.env.SEORI_AUTH_SECRET_FD ?? '', 10);
const secret = readFileSync(fd, 'utf8');
process.stdout.write(`adapter stdout secret=${secret}\n`);
process.stderr.write(`Authorization: Bearer ${secret}\n`);
