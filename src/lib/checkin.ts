import 'server-only';
import { db } from './supabase/admin';
import { AppError, dbErrorCode, unexpected } from './errors';
import { normalizeTicketCode } from './tickets';
import { formatDate, formatDateTime, formatTime } from './time';
import { staffLabel, type Registration, type Staff, type Stats } from './types';

export type CheckinKind = 'checked_in' | 'already' | 'waitlisted' | 'cancelled' | 'invalid' | 'not_event_day';

/**
 * What staff see for each outcome. `tone` drives the colour; the title and icon always
 * say the same thing in words, so colour is never the only signal.
 */
export const RESULTS: Record<CheckinKind, { tone: 'success' | 'warning' | 'danger'; icon: string; title: string }> = {
  checked_in: { tone: 'success', icon: '✓', title: 'Checked in' },
  already: { tone: 'warning', icon: '!', title: 'Already checked in' },
  waitlisted: { tone: 'danger', icon: '✕', title: 'On waitlist — not confirmed' },
  cancelled: { tone: 'danger', icon: '✕', title: 'Cancelled' },
  invalid: { tone: 'danger', icon: '✕', title: 'Invalid ticket' },
  not_event_day: { tone: 'danger', icon: '✕', title: 'Not the event day' },
};

export type CheckinResult = {
  result: CheckinKind;
  tone: 'success' | 'warning' | 'danger';
  icon: string;
  title: string;
  name: string | null;
  code: string;
  registrationId: number | null;
  message: string;
  firstCheckedInAt?: string | null;
  stats: Stats;
};

export type RecentCheckin = { id: number; name: string; code: string; time: string; by: string | null };

export async function stats(eventId: number): Promise<Stats> {
  const { data, error } = await db().rpc('event_stats', { p_event_id: eventId });
  if (error) unexpected(error, 'stats');
  return data as Stats;
}

export async function recentCheckins(eventId: number, limit = 8): Promise<RecentCheckin[]> {
  const { data, error } = await db()
    .from('registrations_detailed')
    .select('id, full_name, ticket_code, checked_in_at, checked_in_by_name')
    .eq('event_id', eventId)
    .eq('status', 'checked_in')
    .order('checked_in_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (error) unexpected(error, 'recentCheckins');
  return (data || []).map((r) => ({ id: r.id, name: r.full_name, code: r.ticket_code, time: formatTime(r.checked_in_at), by: r.checked_in_by_name }));
}

function build(kind: CheckinKind, reg: Registration | null, message: string, code: string, s: Stats): CheckinResult {
  return {
    result: kind,
    ...RESULTS[kind],
    name: reg ? reg.full_name : null,
    code: reg ? reg.ticket_code : code,
    registrationId: reg ? reg.id : null,
    message,
    stats: s,
  };
}

/**
 * Check a ticket in. In order (see the activity's check-in diagram):
 *   1. Does the code exist AND belong to the selected event?   no -> Invalid ticket
 *   2. Its status: confirmed -> Checked in, checked_in -> Already checked in, waitlisted / cancelled -> not confirmed
 * Plus the booking rule: a Confirmed ticket only checks in on the event day.
 *
 * check_in() locks the event row, so when two devices scan the same ticket at the same moment
 * exactly one of them checks it in and the other sees "Already checked in".
 */
export async function checkIn(eventId: number, rawCode: unknown, staff: Staff, now: Date): Promise<CheckinResult> {
  const code = normalizeTicketCode(rawCode);
  const typed = String(rawCode || '').trim().slice(0, 40);
  const { data, error } = await db().rpc('check_in', {
    p_event_id: eventId,
    p_ticket_code: code,
    p_staff: staff.id,
    p_actor: staffLabel(staff),
    p_now: now.toISOString(),
  });
  if (dbErrorCode(error) === 'EVENT_NOT_FOUND') throw new AppError('NOT_FOUND', 'Event not found.', 404);
  if (error) unexpected(error, 'checkIn');

  const out = data as { result: string; registration: Registration | null; ticketCode: string | null; eventStartsAt: string; stats: Stats };
  const reg = out.registration;
  switch (out.result) {
    case 'invalid':
      return build('invalid', null, 'No ticket has this code. Check for typos, or ask for the ticket page.', typed, out.stats);
    case 'other_event':
      return build('invalid', null, 'This ticket is for a different event.', out.ticketCode || typed, out.stats);
    case 'already':
      return {
        ...build('already', reg, `First checked in at ${formatTime(reg!.checked_in_at!)} (${formatDate(reg!.checked_in_at!)}).`, typed, out.stats),
        firstCheckedInAt: reg!.checked_in_at,
      };
    case 'waitlisted':
      return build('waitlisted', reg, 'This person is on the waitlist and does not have a confirmed spot.', typed, out.stats);
    case 'cancelled':
      return build('cancelled', reg, `This registration was cancelled${reg!.cancelled_at ? ` on ${formatDateTime(reg!.cancelled_at)}` : ''}.`, typed, out.stats);
    case 'not_event_day':
      return build('not_event_day', reg, `Check-in only works on the event day (${formatDate(out.eventStartsAt)}).`, typed, out.stats);
    default:
      return build('checked_in', reg, `Checked in at ${formatTime(reg!.checked_in_at!)}.`, typed, out.stats);
  }
}

/** Reverse a mistaken check-in. Records who undid it and when, on the row and in the audit log. */
export async function undoCheckIn(regId: number, staff: Staff, now: Date): Promise<{ registration: Registration; stats: Stats }> {
  const { data, error } = await db().rpc('undo_check_in', {
    p_registration_id: regId,
    p_staff: staff.id,
    p_actor: staffLabel(staff),
    p_now: now.toISOString(),
  });
  const code = dbErrorCode(error);
  if (code === 'NOT_FOUND') throw new AppError('NOT_FOUND', 'Registration not found.', 404);
  if (code === 'NOT_CHECKED_IN') throw new AppError('NOT_CHECKED_IN', 'This ticket is not checked in.', 409);
  if (error) unexpected(error, 'undoCheckIn');
  return data as { registration: Registration; stats: Stats };
}
