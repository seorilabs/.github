import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MacOSKeychainPasswordLoader,
  RemoteTotpSignerClient,
  SecretManagerPasswordLoader,
  SeoriAuthError,
} from '../src/index.mjs';

const request = {
  credentialRef: 'shared/apps-in-toss/bot-password',
  credentialGeneration: 3,
  provider: 'apps-in-toss',
  accountId: 'automation-account',
};

test('Secret Manager password loader delegates only one logical id and generation without exposing a resource locator', async () => {
  const source = Buffer.from('fake-secret-manager-password');
  const calls = [];
  const loader = new SecretManagerPasswordLoader({
    bindings: [{
      ...request,
      factor: 'password',
    }],
    async loadSecret(input) {
      calls.push(input);
      return source;
    },
  });
  assert.deepEqual(Object.keys(loader), []);
  assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(loader)), ['constructor']);
  const password = await loader.loadPassword(request);
  assert.equal(password.toString('utf8'), 'fake-secret-manager-password');
  assert.ok(source.every((byte) => byte === 0));
  assert.deepEqual(calls, [{
    credentialRef: 'shared/apps-in-toss/bot-password',
    credentialGeneration: 3,
  }]);
  password.fill(0);

  await assert.rejects(
    loader.loadPassword({ ...request, credentialGeneration: 4 }),
    (error) => error instanceof SeoriAuthError && error.code === 'password_binding_mismatch',
  );
  assert.throws(
    () => new SecretManagerPasswordLoader({
      bindings: [{ ...request, factor: 'password', resourceName: 'projects/p/secrets/s/versions/latest' }],
      loadSecret: async () => Buffer.from('unused'),
    }),
    (error) => error instanceof SeoriAuthError && error.code === 'invalid_factor_binding',
  );
});

test('macOS Keychain password loader uses catalog-resolved public service/account only', async () => {
  const source = Buffer.from('fake-keychain-password');
  const loader = new MacOSKeychainPasswordLoader({
    bindings: [{
      ...request,
      factor: 'password',
      service: 'seorilabs.auth-broker',
      account: 'shared/apps-in-toss/bot-password',
    }],
    async readGenericPassword(locator) {
      assert.deepEqual(locator, {
        service: 'seorilabs.auth-broker',
        account: 'shared/apps-in-toss/bot-password',
      });
      return source;
    },
  });
  const password = await loader.loadPassword(request);
  assert.equal(password.toString('utf8'), 'fake-keychain-password');
  assert.ok(source.every((byte) => byte === 0));
  password.fill(0);
});

test('remote TOTP client has no seed API and exact-binds logical id, account, generation, and origin', async () => {
  const source = Buffer.from('123456');
  const calls = [];
  const signer = new RemoteTotpSignerClient({
    bindings: [{
      credentialRef: 'shared/apps-in-toss/bot-totp',
      credentialGeneration: 2,
      factor: 'totp',
      provider: 'apps-in-toss',
      accountId: 'automation-account',
      origins: ['https://business.toss.im'],
    }],
    async requestCode(binding) {
      calls.push(binding);
      return { code: source, expiresAt: 1_700_000_020_000 };
    },
  });
  assert.deepEqual(Object.keys(signer), []);
  assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(signer)).sort(), ['constructor', 'signCode']);
  assert.equal('seed' in signer, false);
  const signed = await signer.signCode({
    credentialRef: 'shared/apps-in-toss/bot-totp',
    credentialGeneration: 2,
    provider: 'apps-in-toss',
    accountId: 'automation-account',
    origin: 'https://business.toss.im',
  });
  assert.equal(signed.code.toString('ascii'), '123456');
  assert.ok(source.every((byte) => byte === 0));
  assert.doesNotMatch(JSON.stringify(calls), /123456|seed/i);
  signed.code.fill(0);

  await assert.rejects(
    signer.signCode({
      credentialRef: 'shared/apps-in-toss/bot-totp',
      credentialGeneration: 2,
      provider: 'apps-in-toss',
      accountId: 'automation-account',
      origin: 'https://business.toss.im.evil.test',
    }),
    (error) => error instanceof SeoriAuthError && error.code === 'totp_binding_mismatch',
  );
});
