import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BrowserLoginBoundary,
  CanonicalAccountRegistry,
  HUMAN_REAUTH_REQUIRED,
  SeoriAuthError,
} from '../src/index.mjs';

function identity(overrides = {}) {
  return {
    provider: 'apps-in-toss',
    accountId: 'automation-account',
    teamId: 'seorilabs-team',
    workspaceId: 'release-workspace',
    appId: 'example-app',
    ...overrides,
  };
}

function inspection(overrides = {}) {
  return {
    origin: 'https://business.toss.im',
    redirectOrigins: ['https://accounts.toss.im'],
    publicIdentity: identity(),
    authenticated: false,
    challenge: null,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    passwordRef: 'shared/apps-in-toss/bot-password',
    passwordGeneration: 1,
    totpRef: 'shared/apps-in-toss/bot-totp',
    totpGeneration: 2,
    expectedOrigin: 'https://business.toss.im',
    expectedRedirectOrigins: ['https://accounts.toss.im'],
    expectedIdentity: identity(),
    authFactors: ['password', 'totp'],
    ...overrides,
  };
}

function accountRegistry(kind = 'dedicated_bot') {
  return new CanonicalAccountRegistry([{
    provider: 'apps-in-toss',
    accountId: 'automation-account',
    kind,
    credentialRefs: [
      'shared/apps-in-toss/bot-password',
      'shared/apps-in-toss/bot-totp',
    ],
  }]);
}

function securityControls(overrides = {}) {
  return {
    allowedNetworkOrigins: ['https://business.toss.im', 'https://accounts.toss.im'],
    clipboard: false,
    downloads: false,
    extensions: false,
    har: false,
    profilePathExposed: false,
    screenshots: false,
    storageStateExport: false,
    traces: false,
    video: false,
    ...overrides,
  };
}

test('password and TOTP stay inside distinct trusted services and exact browser identity gates', async () => {
  const password = Buffer.from('fake-canary-password');
  const totp = Buffer.from('123456');
  const calls = [];
  const login = new BrowserLoginBoundary({
    accountRegistry: accountRegistry(),
    passwordLoader: {
      async loadPassword(input) {
        calls.push({ service: 'password', input });
        return password;
      },
    },
    totpSigner: {
      async signCode(input) {
        calls.push({ service: 'totp', input });
        return { code: totp, expiresAt: 1_700_000_020_000 };
      },
    },
    clock: () => 1_700_000_000_000,
  });
  const stages = {
    before_password: inspection(),
    after_password: inspection({ challenge: 'totp_required' }),
    after_totp: inspection({ authenticated: true }),
  };
  const injected = [];
  const result = await login.authenticate({
    ...request(),
    browser: {
      async securityControls() { return securityControls(); },
      async inspect({ stage }) {
        calls.push({ service: 'inspect', stage });
        return stages[stage];
      },
      async injectPassword(value) {
        injected.push({ factor: 'password', matches: value.toString('utf8') === 'fake-canary-password' });
      },
      async injectTotp(value) {
        injected.push({ factor: 'totp', matches: value.toString('ascii') === '123456' });
      },
    },
  });

  assert.deepEqual(result, { status: 'AUTHENTICATED', publicIdentity: identity() });
  assert.deepEqual(injected, [
    { factor: 'password', matches: true },
    { factor: 'totp', matches: true },
  ]);
  assert.ok(password.every((byte) => byte === 0));
  assert.ok(totp.every((byte) => byte === 0));
  assert.equal(calls.filter(({ service }) => service === 'password').length, 1);
  assert.equal(calls.filter(({ service }) => service === 'totp').length, 1);
  assert.doesNotMatch(JSON.stringify(result), /fake-canary-password|123456/);
  assert.doesNotMatch(JSON.stringify(calls), /fake-canary-password|123456/);
});

test('look-alike origin and wrong public identity fail before either factor service', async () => {
  for (const observed of [
    inspection({ origin: 'https://business.toss.im.evil.test' }),
    inspection({ redirectOrigins: ['https://accounts.toss.im.evil.test'] }),
    inspection({ publicIdentity: identity({ accountId: 'different-account' }) }),
  ]) {
    let passwordLoads = 0;
    let totpSigns = 0;
    const login = new BrowserLoginBoundary({
      accountRegistry: accountRegistry(),
      passwordLoader: { async loadPassword() { passwordLoads += 1; return Buffer.from('unused'); } },
      totpSigner: { async signCode() { totpSigns += 1; return { code: Buffer.from('123456'), expiresAt: Date.now() + 10_000 }; } },
    });
    await assert.rejects(
      login.authenticate({
        ...request(),
        browser: {
          async securityControls() { return securityControls(); },
          async inspect() { return observed; },
          async injectPassword() {},
          async injectTotp() {},
        },
      }),
      (error) => error instanceof SeoriAuthError &&
        ['browser_origin_mismatch', 'identity_readback_mismatch'].includes(error.code),
    );
    assert.equal(passwordLoads, 0);
    assert.equal(totpSigns, 0);
  }
});

test('human challenges and canonical human-account password/TOTP stop before any loader', async () => {
  let loads = 0;
  const login = new BrowserLoginBoundary({
    accountRegistry: accountRegistry(),
    passwordLoader: { async loadPassword() { loads += 1; return Buffer.from('unused'); } },
    totpSigner: { async signCode() { throw new Error('must not run'); } },
  });
  await assert.rejects(
    login.authenticate({
      ...request(),
      browser: {
        async securityControls() { return securityControls(); },
        async inspect() { return inspection({ challenge: 'captcha_required' }); },
        async injectPassword() {},
        async injectTotp() {},
      },
    }),
    (error) => error instanceof SeoriAuthError && error.code === HUMAN_REAUTH_REQUIRED,
  );
  assert.equal(loads, 0);

  await assert.rejects(
    login.authenticate({
      ...request(),
      browser: {
        async securityControls() { return securityControls(); },
        async inspect() { return inspection({ challenge: 'session_expired' }); },
        async injectPassword() {},
        async injectTotp() {},
      },
    }),
    (error) => error instanceof SeoriAuthError && error.code === HUMAN_REAUTH_REQUIRED,
  );
  assert.equal(loads, 0, 'revoked session must not trigger password retry');

  const humanLogin = new BrowserLoginBoundary({
    accountRegistry: accountRegistry('human'),
    passwordLoader: { async loadPassword() { loads += 1; return Buffer.from('unused'); } },
    totpSigner: { async signCode() { throw new Error('must not run'); } },
  });
  for (const authFactors of [['password'], ['password', 'totp']]) {
    await assert.rejects(
      humanLogin.authenticate({
        ...request({ authFactors }),
        browser: {
          async securityControls() { throw new Error('must not inspect controls'); },
          async inspect() { throw new Error('must not inspect'); },
          async injectPassword() {},
          async injectTotp() {},
        },
      }),
      (error) => error instanceof SeoriAuthError && error.code === HUMAN_REAUTH_REQUIRED,
    );
  }
  assert.equal(loads, 0, 'human password must stop before loading');
});

test('capture, export, clipboard, and network controls fail before password loading', async () => {
  for (const controls of [
    securityControls({ screenshots: true }),
    securityControls({ allowedNetworkOrigins: ['https://business.toss.im', 'https://evil.test'] }),
  ]) {
    let loads = 0;
    const login = new BrowserLoginBoundary({
      accountRegistry: accountRegistry(),
      passwordLoader: { async loadPassword() { loads += 1; return Buffer.from('unused'); } },
      totpSigner: { async signCode() { throw new Error('must not run'); } },
    });
    await assert.rejects(
      login.authenticate({
        ...request(),
        browser: {
          async securityControls() { return controls; },
          async inspect() { throw new Error('must not inspect'); },
          async injectPassword() {},
          async injectTotp() {},
        },
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'browser_security_controls_failed',
    );
    assert.equal(loads, 0);
  }
});

test('password and TOTP service objects cannot be the same boundary', () => {
  const combined = { loadPassword() {}, signCode() {} };
  assert.throws(
    () => new BrowserLoginBoundary({
      passwordLoader: combined,
      totpSigner: combined,
      accountRegistry: accountRegistry(),
    }),
    (error) => error instanceof SeoriAuthError && error.code === 'invalid_factor_service',
  );
});
