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
