import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyReauth, REAUTH_CLASSIFICATIONS, SeoriAuthError } from '../src/index.mjs';

test('all reauthentication classifications stop automatic retries', () => {
  for (const code of Object.keys(REAUTH_CLASSIFICATIONS)) {
    assert.deepEqual(classifyReauth(code), {
      code,
      humanRequired: true,
      retryAutomatically: false,
    });
  }
});

test('unknown reauthentication signals fail closed', () => {
  assert.throws(
    () => classifyReauth('maybe_retry'),
    (error) => error instanceof SeoriAuthError && error.code === 'unknown_reauth_classification',
  );
});
