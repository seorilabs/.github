import { readFileSync, writeFileSync } from 'node:fs';

const secretFd = Number.parseInt(process.env.SEORI_AUTH_SECRET_FD ?? '', 10);
const commandFd = Number.parseInt(process.env.SEORI_AUTH_COMMAND_FD ?? '', 10);
const resultFd = Number.parseInt(process.env.SEORI_AUTH_RESULT_FD ?? '', 10);
const mode = process.argv[2] ?? 'success';
const secret = Buffer.from(readFileSync(secretFd));
const commandBytes = Buffer.from(readFileSync(commandFd));

try {
  const command = JSON.parse(commandBytes.toString('utf8'));
  if (process.env.TEST_CAPTURE_FILE) {
    writeFileSync(process.env.TEST_CAPTURE_FILE, JSON.stringify({
      argv: process.argv,
      env: process.env,
      command,
    }));
  }

  if (mode === 'leak-base64') {
    writeFileSync(resultFd, secret.toString('base64'));
  } else if (mode === 'human') {
    writeFileSync(resultFd, JSON.stringify({
      schemaVersion: 1,
      outcome: 'HUMAN_REAUTH_REQUIRED',
      errorCode: 'HUMAN_REAUTH_REQUIRED',
    }));
  } else if (mode === 'invalid') {
    writeFileSync(resultFd, '{"schemaVersion":1,"outcome":"SUCCESS","extra":true}');
  } else {
    writeFileSync(resultFd, JSON.stringify({
      schemaVersion: 1,
      outcome: 'SUCCESS',
      observation: {
        kind: 'MARKET',
        payload: {
          schemaVersion: 1,
          market: command.provider,
          publicAccountId: command.credential.publicAccountId,
          publicAppId: command.resource.id,
          gate: 'UPLOAD',
          state: 'SUCCEEDED',
          sourceSha: command.sourceSha,
          configRevision: command.configRevision,
          artifactChecksum: command.artifactChecksum,
          providerReference: `upload:${command.bindingHash.slice(0, 16)}`,
          observedAt: new Date().toISOString(),
        },
      },
    }));
  }
} finally {
  secret.fill(0);
  commandBytes.fill(0);
}
