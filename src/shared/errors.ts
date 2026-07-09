/** Safe message extraction — a thrown non-Error (string, object) has no `.message`. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Structured error meta for `logger.error` sites: message plus stack when available. */
export function errorMeta(err: unknown): { message: string; stack?: string } {
  return err instanceof Error
    ? { message: err.message, ...(err.stack !== undefined ? { stack: err.stack } : {}) }
    : { message: String(err) };
}

/** Typed application errors. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super('validation_error', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super('not_found', message);
  }
}

/** Business-rule rejection surfaced to the customer (design §11.3 stage 4). */
export class CartRejectedError extends AppError {
  constructor(
    public readonly reason: string, // e.g. "line_gone", "stale_edit", "unavailable_item"
    message: string,
  ) {
    super('cart_rejected', message);
  }
}
