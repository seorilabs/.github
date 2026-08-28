export class SeoriAuthError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'SeoriAuthError';
    this.code = code;
    if (details !== undefined) {
      Object.defineProperty(this, 'details', {
        value: Object.freeze({ ...details }),
        enumerable: false,
        writable: false,
      });
    }
  }
}

export function fail(code, message, details = undefined) {
  throw new SeoriAuthError(code, message, details);
}
