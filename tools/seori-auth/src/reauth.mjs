import { fail } from './errors.mjs';

export const REAUTH_CLASSIFICATIONS = Object.freeze({
  session_expired: Object.freeze({ humanRequired: true, retryAutomatically: false }),
  credential_rejected: Object.freeze({ humanRequired: true, retryAutomatically: false }),
  mfa_required: Object.freeze({ humanRequired: true, retryAutomatically: false }),
  trusted_device_required: Object.freeze({ humanRequired: true, retryAutomatically: false }),
  captcha_required: Object.freeze({ humanRequired: true, retryAutomatically: false }),
  passkey_required: Object.freeze({ humanRequired: true, retryAutomatically: false }),
  sso_required: Object.freeze({ humanRequired: true, retryAutomatically: false }),
  account_recovery_required: Object.freeze({ humanRequired: true, retryAutomatically: false }),
  policy_blocked: Object.freeze({ humanRequired: true, retryAutomatically: false }),
});

export function classifyReauth(code) {
  const classification = REAUTH_CLASSIFICATIONS[code];
  if (!classification) {
    fail('unknown_reauth_classification', 'reauthentication signal is not recognized');
  }
  return Object.freeze({ code, ...classification });
}
