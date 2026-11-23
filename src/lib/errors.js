'use strict';

/** An expected, user-facing failure (e.g. "event is full"). Routes turn these into friendly pages. */
class AppError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

class ValidationError extends AppError {
  constructor(errors, message = 'Please fix the highlighted fields.') {
    super('VALIDATION', message, { status: 422, details: errors });
    this.errors = errors;
  }
}

module.exports = { AppError, ValidationError };
