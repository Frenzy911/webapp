import 'server-only';
import { db } from './supabase/admin';
import { AppError, ValidationError, dbErrorCode, unexpected } from './errors';
import { generateTicketCode, normalizeTicketCode } from './tickets';
import { normalizeEmail, normalizeMobile, validateRegistration } from './validation';
import { getEvent } from './events';
import { staffLabel, type Registration, type RegistrationDetailed, type Staff } from './types';

export async function getRegistration(id: unknown): Promise<Registration | null> {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const { data, error } = await db().from('registrations').select('*').eq('id', n).maybeSingle<Registration>();
  if (error) unexpected(error, 'getRegistration');
  return data;
}

export async function getRegistrationByCode(code: unknown): Promise<Registration | null> {
  const normalized = normalizeTicketCode(code);
  if (!normalized) return null;
  const { data, error } = await db().from('registrations').select('*').eq('ticket_code', normalized).maybeSingle<Registration>();
  if (error) unexpected(error, 'getRegistrationByCode');
  return data;
}

/** 1-based place in line; the waitlist is first come, first served. */
export async function waitlistPosition(reg: Registration | null): Promise<number | null> {
  if (!reg || reg.status !== 'waitlisted') return null;
  const { count, error } = await db()
    .from('registrations')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', reg.event_id)
    .eq('status', 'waitlisted')
    .lte('id', reg.id);
  if (error) unexpected(error, 'waitlistPosition');
  return count ?? null;
}

const REGISTER_ERRORS: Record<string, [string, string, number]> = {
  EVENT_NOT_FOUND: ['NOT_FOUND', 'Event not found.', 404],
  ENDED: ['ENDED', 'This event has ended, so registration is closed.', 400],
  CLOSED: ['CLOSED', 'Registration for this event is closed.', 400],
  DUPLICATE: ['DUPLICATE', 'This email is already registered for this event. Use "Find my ticket" to see your ticket again.', 409],
  DUPLICATE_WAITLIST: ['DUPLICATE', 'This email is already on the waitlist for this event. Use "Find my ticket" to see your place in line.', 409],
  'UNIQUE:ux_registrations_active_email': ['DUPLICATE', 'This email is already registered for this event.', 409],
  FULL: ['FULL', 'Sorry, this event is now full. You can join the waitlist instead.', 409],
  EVENT_FULL: ['FULL', 'Sorry, this event is now full.', 409],
};

/**
 * Register an attendee. Everything is re-validated here (the form's disabled button is only a hint),
 * and capacity is re-checked inside register_attendee() with the event row locked, so two people
 * can never both take the last spot. If the event is full it joins the waitlist when `joinWaitlist`
 * is set, otherwise it fails with FULL.
 */
export async function register(
  eventId: number,
  body: { full_name?: unknown; email?: unknown; mobile?: unknown },
  { joinWaitlist = false } = {},
  now: Date
): Promise<Registration> {
  const v = validateRegistration(body);
  if (!v.ok) throw new ValidationError(v.errors);
  const ev = await getEvent(eventId, now);
  if (!ev || ev.status === 'draft') throw new AppError('NOT_FOUND', 'Event not found.', 404);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data, error } = await db().rpc('register_attendee', {
      p_event_id: ev.id,
      p_full_name: v.values.fullName,
      p_email: v.values.email,
      p_mobile: v.values.mobile,
      p_ticket_code: generateTicketCode(ev.code_prefix),
      p_join_waitlist: joinWaitlist,
      p_now: now.toISOString(),
    });
    const code = dbErrorCode(error);
    if (code === 'UNIQUE:registrations_ticket_code_key') continue; // astronomically rare: try a new code
    if (code && REGISTER_ERRORS[code]) {
      const [c, message, status] = REGISTER_ERRORS[code];
      throw new AppError(c, message, status);
    }
    if (error) unexpected(error, 'register');
    return data as Registration;
  }
  throw new Error('Could not generate a unique ticket code.');
}

/**
 * Ticket lookup: the code AND the email (or mobile) must both match.
 * Any mismatch returns null, and the caller shows the same "Ticket not found" either way.
 */
export async function lookupTicket(code: unknown, contact: unknown): Promise<Registration | null> {
  const reg = await getRegistrationByCode(code);
  if (!reg) return null;
  const raw = String(contact || '').trim();
  if (!raw) return null;
  const matches = raw.includes('@') ? normalizeEmail(raw) === reg.email : normalizeMobile(raw) === reg.mobile;
  return matches ? reg : null;
}

const CANCEL_ERRORS: Record<string, [string, string, number]> = {
  NOT_FOUND: ['NOT_FOUND', 'Registration not found.', 404],
  CHECKED_IN: ['CHECKED_IN', 'This person is already checked in, so the registration can’t be cancelled.', 409],
  ALREADY_CANCELLED: ['ALREADY_CANCELLED', 'This registration is already cancelled.', 409],
};

/** Cancel a registration: by `staff`, or by the attendee when staff is null. Checked-in registrations can't be cancelled. */
export async function cancelRegistration(reg: Registration, staff: Staff | null, now: Date): Promise<Registration> {
  const { data, error } = await db().rpc('cancel_registration', {
    p_registration_id: reg.id,
    p_staff: staff ? staff.id : null,
    p_actor: staff ? staffLabel(staff) : `Attendee (${reg.email})`,
    p_now: now.toISOString(),
  });
  const code = dbErrorCode(error);
  if (code && CANCEL_ERRORS[code]) {
    const [c, message, status] = CANCEL_ERRORS[code];
    throw new AppError(c, message, status);
  }
  if (error) unexpected(error, 'cancelRegistration');
  return data as Registration;
}

const PROMOTE_ERRORS: Record<string, [string, string, number]> = {
  EVENT_NOT_FOUND: ['NOT_FOUND', 'Event not found.', 404],
  ENDED: ['ENDED', 'This event has ended.', 400],
  NO_SPOT: ['NO_SPOT', 'There is no open spot yet. A spot opens when someone cancels or capacity is raised.', 409],
  EVENT_FULL: ['NO_SPOT', 'The open spot was just taken.', 409],
  EMPTY_WAITLIST: ['EMPTY_WAITLIST', 'Nobody is on the waitlist.', 409],
};

/** Move the first person on the waitlist into an open spot. Staff only. */
export async function promoteNext(eventId: number, staff: Staff, now: Date): Promise<Registration> {
  const { data, error } = await db().rpc('promote_next', {
    p_event_id: eventId,
    p_staff: staff.id,
    p_actor: staffLabel(staff),
    p_now: now.toISOString(),
  });
  const code = dbErrorCode(error);
  if (code && PROMOTE_ERRORS[code]) {
    const [c, message, status] = PROMOTE_ERRORS[code];
    throw new AppError(c, message, status);
  }
  if (error) unexpected(error, 'promoteNext');
  return data as Registration;
}

export const STATUS_FILTERS = ['confirmed', 'checked_in', 'waitlisted', 'cancelled'] as const;

/** Attendee list for staff, with optional search by name, email or ticket code. */
export async function listRegistrations(eventId: number, { q = '', status = '' } = {}): Promise<RegistrationDetailed[]> {
  const { data, error } = await db().rpc('list_registrations', {
    p_event_id: eventId,
    p_q: String(q).trim().slice(0, 100),
    p_status: (STATUS_FILTERS as readonly string[]).includes(status) ? status : '',
  });
  if (error) unexpected(error, 'listRegistrations');
  return (data || []) as RegistrationDetailed[];
}
