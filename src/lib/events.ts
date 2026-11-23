import 'server-only';
import { db } from './supabase/admin';
import { AppError, ValidationError, dbErrorCode, unexpected } from './errors';
import { prefixFromTitle } from './tickets';
import { formatDate, formatTimeRange, manilaDateString, toLocalParts } from './time';
import { validateEvent, type EventFormValues, type EventStatus } from './validation';
import { staffLabel, type EventRow, type EventView, type Staff } from './types';

/** Add the computed fields used by every screen. */
export function decorate(row: EventRow, now: Date): EventView {
  const t = now.getTime();
  const starts = new Date(row.starts_at).getTime();
  const ends = new Date(row.ends_at).getTime();
  const today = manilaDateString(now);
  const hasStarted = t >= starts;
  const hasEnded = t >= ends;
  return {
    ...row,
    spotsLeft: Math.max(0, row.capacity - row.registered),
    isFull: row.registered >= row.capacity,
    hasStarted,
    hasEnded,
    isEventDay: today >= manilaDateString(row.starts_at) && today <= manilaDateString(row.ends_at),
    registrationOpen: row.status === 'published' && !hasEnded,
    dateLabel: formatDate(row.starts_at),
    timeLabel: formatTimeRange(row.starts_at, row.ends_at),
    noShows: hasStarted ? row.not_checked_in : null,
  };
}

const events = () => db().from('events_with_counts').select('*');

function decorateAll(data: EventRow[] | null, now: Date): EventView[] {
  return (data || []).map((r) => decorate(r, now));
}

export async function getEvent(id: unknown, now: Date): Promise<EventView | null> {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const { data, error } = await events().eq('id', n).maybeSingle<EventRow>();
  if (error) unexpected(error, 'getEvent');
  return data ? decorate(data, now) : null;
}

/** Attendee list: only Published events that haven't ended. */
export async function listPublicEvents(now: Date): Promise<EventView[]> {
  const { data, error } = await events().eq('status', 'published').gt('ends_at', now.toISOString()).order('starts_at');
  if (error) unexpected(error, 'listPublicEvents');
  return decorateAll(data, now);
}

/** A few recent past events, shown below the list and marked "Ended". */
export async function listPastPublicEvents(now: Date, limit = 3): Promise<EventView[]> {
  const { data, error } = await events()
    .in('status', ['published', 'closed'])
    .lte('ends_at', now.toISOString())
    .order('starts_at', { ascending: false })
    .limit(limit);
  if (error) unexpected(error, 'listPastPublicEvents');
  return decorateAll(data, now);
}

export async function listAllEvents(now: Date): Promise<EventView[]> {
  const { data, error } = await events().order('starts_at', { ascending: false });
  if (error) unexpected(error, 'listAllEvents');
  return decorateAll(data, now);
}

/** Dashboard: every event that hasn't ended yet (upcoming or happening now). */
export async function listUpcomingEvents(now: Date): Promise<EventView[]> {
  const { data, error } = await events().gt('ends_at', now.toISOString()).order('starts_at');
  if (error) unexpected(error, 'listUpcomingEvents');
  return decorateAll(data, now);
}

/** Events door staff can pick on the check-in screen: anything not draft that ends today or later (Cebu time). */
export async function listCheckinEvents(now: Date): Promise<EventView[]> {
  const startOfToday = `${manilaDateString(now)}T00:00:00+08:00`;
  const { data, error } = await events().neq('status', 'draft').gte('ends_at', startOfToday).order('starts_at');
  if (error) unexpected(error, 'listCheckinEvents');
  return decorateAll(data, now);
}

export function formValuesFromEvent(ev: EventView): EventFormValues {
  const start = toLocalParts(ev.starts_at);
  const end = toLocalParts(ev.ends_at);
  return {
    title: ev.title,
    description: ev.description,
    venue: ev.venue,
    date: start.date,
    startTime: start.time,
    endTime: end.time,
    capacity: String(ev.capacity),
    status: ev.status,
  };
}

/** Create (id = null) or update an event. Returns the event id. Throws ValidationError with field messages. */
export async function saveEvent(id: number | null, body: Record<string, unknown>, staff: Staff, now: Date): Promise<number> {
  const v = validateEvent(body);
  if (!v.ok) throw new ValidationError(v.errors);
  const d = v.data;
  const { data, error } = await db().rpc('save_event', {
    p_id: id,
    p_title: d.title,
    p_description: d.description,
    p_venue: d.venue,
    p_starts_at: d.startsAt,
    p_ends_at: d.endsAt,
    p_capacity: d.capacity,
    p_status: d.status,
    p_code_prefix: prefixFromTitle(d.title),
    p_staff: staff.id,
    p_actor: staffLabel(staff),
    p_now: now.toISOString(),
  });
  const code = dbErrorCode(error);
  if (code === 'EVENT_NOT_FOUND') throw new AppError('NOT_FOUND', 'Event not found.', 404);
  if (code === 'CAPACITY_BELOW_REGISTERED') {
    const n = Number(error?.details) || 0;
    throw new ValidationError({
      capacity: `Capacity can't be lower than the ${n} people already registered. Cancel registrations first, or keep the capacity at ${n} or more.`,
    });
  }
  if (code === 'DRAFT_HAS_REGISTRATIONS') {
    throw new ValidationError({ status: "This event already has registrations, so it can't go back to Draft. Close it instead." });
  }
  if (error) unexpected(error, 'saveEvent');
  return Number(data);
}

export async function setEventStatus(id: number, status: EventStatus, staff: Staff, now: Date): Promise<EventRow> {
  const { data, error } = await db().rpc('set_event_status', {
    p_id: id,
    p_status: status,
    p_staff: staff.id,
    p_actor: staffLabel(staff),
    p_now: now.toISOString(),
  });
  const code = dbErrorCode(error);
  if (code === 'EVENT_NOT_FOUND') throw new AppError('NOT_FOUND', 'Event not found.', 404);
  if (code === 'BAD_STATUS') throw new AppError('BAD_STATUS', 'Unknown status.');
  if (error) unexpected(error, 'setEventStatus');
  return data as EventRow;
}
