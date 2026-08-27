function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DEFENSE_IN_DEPTH_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(?:password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
];

export function redactOutput(value, secret) {
  let redacted = String(value);
  if (secret.length > 0) {
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  }
  for (const pattern of DEFENSE_IN_DEPTH_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}
