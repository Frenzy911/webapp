'use strict';

const { transaction, isConstraintError } = require('../db');
const { ValidationError, AppError } = require('../lib/errors');
const { logAudit } = require('../lib/audit');
const { prefixFromTitle } = require('../lib/tickets');
const { toManilaIso, manilaDateString, formatDate, formatTimeRange, toLocalParts } = require('../lib/time');
const { validateEvent } = require('../lib/validation');

// Capacity counts Confirmed + Checked in. Waitlisted and Cancelled do not.
const EVENT_WITH_COUNTS = `
  SELECT e.*,
    COALESCE(SUM(r.status IN ('confirmed', 'checked_in')), 0) AS registered,
    COALESCE(SUM(r.status = 'checked_in'), 0)                AS checked_in,
    COALESCE(SUM(r.status = 'confirmed'), 0)                 AS not_checked_in,
    COALESCE(SUM(r.status = 'waitlisted'), 0)                AS waitlisted,
    COALESCE(SUM(r.status = 'cancelled'), 0)                 AS cancelled
  FROM events e
  LEFT JOIN registrations r ON r.event_id = e.id
`;

/** Add computed fields used by every screen. */
function decorate(ev, now) {
  if (!ev) return null;
  const nowIso = toManilaIso(now);
  const today = manilaDateString(now);
  ev.spotsLeft = Math.max(0, ev.capacity - ev.registered);
  ev.isFull = ev.registered >= ev.capacity;
  ev.hasStarted = nowIso >= ev.starts_at;
  ev.hasEnded = nowIso >= ev.ends_at;
  ev.isEventDay = today >= ev.starts_at.slice(0, 10) && today <= ev.ends_at.slice(0, 10);
  ev.registrationOpen = ev.status === 'published' && !ev.hasEnded;
  ev.dateLabel = formatDate(ev.starts_at);
  ev.timeLabel = formatTimeRange(ev.starts_at, ev.ends_at);
  // No-shows only make sense once the event has started.
  ev.noShows = ev.hasStarted ? ev.not_checked_in : null;
  return ev;
}

function getEvent(db, id, now) {
  const row = db.prepare(`${EVENT_WITH_COUNTS} WHERE e.id = ? GROUP BY e.id`).get(Number(id) || 0);
  return decorate(row, now);
}

/** Attendee list: only Published events that haven't ended. */
function listPublicEvents(db, now) {
  const rows = db
    .prepare(`${EVENT_WITH_COUNTS} WHERE e.status = 'published' AND e.ends_at > ? GROUP BY e.id ORDER BY e.starts_at`)
    .all(toManilaIso(now));
  return rows.map((r) => decorate(r, now));
}

/** A few recent past events, shown below the list and marked "Ended". */
function listPastPublicEvents(db, now, limit = 3) {
  const rows = db
    .prepare(`${EVENT_WITH_COUNTS} WHERE e.status IN ('published', 'closed') AND e.ends_at <= ? GROUP BY e.id ORDER BY e.starts_at DESC LIMIT ?`)
    .all(toManilaIso(now), limit);
  return rows.map((r) => decorate(r, now));
}

function listAllEvents(db, now) {
  const rows = db.prepare(`${EVENT_WITH_COUNTS} GROUP BY e.id ORDER BY e.starts_at DESC`).all();
  return rows.map((r) => decorate(r, now));
}

/** Dashboard: every event that hasn't ended yet (upcoming or happening now). */
function listUpcomingEvents(db, now) {
  const rows = db.prepare(`${EVENT_WITH_COUNTS} WHERE e.ends_at > ? GROUP BY e.id ORDER BY e.starts_at`).all(toManilaIso(now));
  return rows.map((r) => decorate(r, now));
}

/** Events door staff can pick on the check-in screen: today's first, then the rest of the upcoming ones. */
function listCheckinEvents(db, now) {
  const today = manilaDateString(now);
  const rows = db
    .prepare(`${EVENT_WITH_COUNTS} WHERE e.status <> 'draft' AND substr(e.ends_at, 1, 10) >= ? GROUP BY e.id ORDER BY e.starts_at`)
    .all(today);
  return rows.map((r) => decorate(r, now));
}

function formValuesFromEvent(ev) {
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

function createEvent(db, body, staff, now) {
  const v = validateEvent(body);
  if (!v.ok) throw new ValidationError(v.errors);
  const d = v.data;
  const ts = toManilaIso(now);
  return transaction(db, () => {
    const res = db
      .prepare(
        `INSERT INTO events (title, description, venue, starts_at, ends_at, capacity, status, code_prefix, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(d.title, d.description, d.venue, d.startsAt, d.endsAt, d.capacity, d.status, prefixFromTitle(d.title), staff.id, ts, ts);
    const id = Number(res.lastInsertRowid);
    logAudit(db, { staff, action: 'event_created', targetType: 'event', targetId: id, eventId: id, details: `Created "${d.title}" (${d.status}, capacity ${d.capacity})` }, now);
    return id;
  });
}

function updateEvent(db, id, body, staff, now) {
  const v = validateEvent(body);
  const errors = { ...v.errors };
  return transaction(db, () => {
    const ev = getEvent(db, id, now);
    if (!ev) throw new AppError('NOT_FOUND', 'Event not found.', { status: 404 });

    if (!errors.capacity && v.data.capacity < ev.registered) {
      errors.capacity = `Capacity can't be lower than the ${ev.registered} people already registered. Cancel registrations first, or keep the capacity at ${ev.registered} or more.`;
    }
    if (!errors.status && v.data.status === 'draft' && ev.status !== 'draft' && ev.registered + ev.waitlisted > 0) {
      errors.status = "This event already has registrations, so it can't go back to Draft. Close it instead.";
    }
    if (Object.keys(errors).length) throw new ValidationError(errors);

    const d = v.data;
    try {
      db.prepare(
        `UPDATE events SET title = ?, description = ?, venue = ?, starts_at = ?, ends_at = ?, capacity = ?, status = ?, updated_at = ? WHERE id = ?`
      ).run(d.title, d.description, d.venue, d.startsAt, d.endsAt, d.capacity, d.status, toManilaIso(now), ev.id);
    } catch (err) {
      if (isConstraintError(err, 'CAPACITY_BELOW_REGISTERED')) {
        throw new ValidationError({ capacity: "Capacity can't be lower than the number of people already registered." });
      }
      throw err;
    }

    const changes = [];
    for (const [key, label] of [['title', 'title'], ['venue', 'venue'], ['starts_at', 'start'], ['ends_at', 'end'], ['capacity', 'capacity'], ['status', 'status']]) {
      const next = { title: d.title, venue: d.venue, starts_at: d.startsAt, ends_at: d.endsAt, capacity: d.capacity, status: d.status }[key];
      if (String(ev[key]) !== String(next)) changes.push(`${label}: ${ev[key]} → ${next}`);
    }
    if (ev.description !== d.description) changes.push('description updated');
    logAudit(db, { staff, action: 'event_updated', targetType: 'event', targetId: ev.id, eventId: ev.id, details: changes.length ? changes.join('; ') : 'No changes' }, now);
    return ev.id;
  });
}

function setEventStatus(db, id, status, staff, now) {
  if (!['published', 'closed'].includes(status)) throw new AppError('BAD_STATUS', 'Unknown status.');
  return transaction(db, () => {
    const ev = getEvent(db, id, now);
    if (!ev) throw new AppError('NOT_FOUND', 'Event not found.', { status: 404 });
    if (ev.status === status) return ev;
    db.prepare('UPDATE events SET status = ?, updated_at = ? WHERE id = ?').run(status, toManilaIso(now), ev.id);
    logAudit(db, { staff, action: 'event_status_changed', targetType: 'event', targetId: ev.id, eventId: ev.id, details: `"${ev.title}": ${ev.status} → ${status}` }, now);
    return ev;
  });
}

module.exports = {
  getEvent,
  listPublicEvents,
  listPastPublicEvents,
  listAllEvents,
  listUpcomingEvents,
  listCheckinEvents,
  formValuesFromEvent,
  createEvent,
  updateEvent,
  setEventStatus,
};
