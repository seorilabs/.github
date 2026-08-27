export class SeoriAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SeoriAuthError';
    this.code = code;
  }
}

export function fail(code, message) {
  throw new SeoriAuthError(code, message);
}
