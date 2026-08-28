import { createServer } from 'node:https';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { fail } from './errors.mjs';

async function readTlsFile(path, { privateMaterial = false } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    fail('invalid_tls_configuration', 'TLS file paths must be absolute');
  }
  const [stat, canonical] = await Promise.all([lstat(path), realpath(path)]);
  if (!stat.isFile() || stat.isSymbolicLink() || canonical !== path) {
    fail('invalid_tls_configuration', 'TLS material must be a canonical regular file');
  }
  if (privateMaterial && (stat.mode & 0o037) !== 0) {
    fail('invalid_tls_configuration', 'TLS private key may be group-readable but not group-writable, executable, or world-accessible');
  }
  return readFile(path);
}

function configureServer(server) {
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 1;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('tlsClientError', (_error, socket) => socket.destroy());
}

export class MtlsAuthDaemon {
  #application;
  #host;
  #port;
  #tls;
  #server;

  constructor({ application, host = '0.0.0.0', port = 8443, tls }) {
    if (!application || typeof application.dispatch !== 'function') {
      throw new TypeError('application must expose the Seori Auth HTTP dispatch boundary');
    }
    if (!['0.0.0.0', '127.0.0.1', '::'].includes(host)) {
      throw new TypeError('mTLS daemon host must be an explicit local or all-interface address');
    }
    if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
      throw new TypeError('mTLS daemon port must be between 1024 and 65535');
    }
    if (!tls || typeof tls !== 'object' || Array.isArray(tls)) {
      throw new TypeError('mTLS daemon requires certificate, private key, and client CA paths');
    }
    this.#application = application;
    this.#host = host;
    this.#port = port;
    this.#tls = Object.freeze({
      caPath: tls.caPath,
      certificatePath: tls.certificatePath,
      privateKeyPath: tls.privateKeyPath,
    });
  }

  async start() {
    if (this.#server) fail('daemon_already_started', 'mTLS auth daemon is already started');
    const [ca, cert, key] = await Promise.all([
      readTlsFile(this.#tls.caPath),
      readTlsFile(this.#tls.certificatePath),
      readTlsFile(this.#tls.privateKeyPath, { privateMaterial: true }),
    ]);
    let server;
    try {
      server = createServer({
        ca,
        cert,
        key,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        honorCipherOrder: true,
      }, (request, response) => this.#application.dispatch(request, response));
    } finally {
      ca.fill(0);
      cert.fill(0);
      key.fill(0);
    }
    configureServer(server);
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(this.#port, this.#host, () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });
    this.#server = server;
    return Object.freeze({ transport: 'mtls', host: this.#host, port: this.#port });
  }

  async stop() {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }
}
