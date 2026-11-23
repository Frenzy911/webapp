import type { FieldErrors } from './validation';

/** An expected, user-facing failure (e.g. "event is full"). Pages and actions turn these into friendly messages. */
export class AppError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class ValidationError extends AppError {
  errors: FieldErrors;
  constructor(errors: FieldErrors, message = 'Please fix the highlighted fields.') {
    super('VALIDATION', message, 422);
    this.errors = errors;
  }
}

/** The shape of an error from supabase-js (PostgREST). */
export type DbError = { code?: string; message: string; details?: string | null; hint?: string | null } | null;

/**
 * The booking functions raise short codes (`raise exception 'FULL'`), which arrive as error.message
 * with SQLSTATE P0001. Unique violations (23505) come back as "UNIQUE:<constraint name>".
 */
export function dbErrorCode(error: DbError): string | null {
  if (!error) return null;
  if (error.code === 'P0001') return error.message;
  if (error.code === '23505') {
    const m = error.message.match(/constraint "([^"]+)"/);
    return `UNIQUE:${m ? m[1] : ''}`;
  }
  return null;
}

/** Throw unexpected database errors as-is (they become a 500 and get logged). */
export function unexpected(error: NonNullable<DbError>, what: string): never {
  throw new Error(`${what}: ${error.message}${error.details ? ` (${error.details})` : ''}`);
}
