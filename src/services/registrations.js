'use strict';

const { transaction, isConstraintError } = require('../db');
const { AppError, ValidationError } = require('../lib/errors');
const { logAudit } = require('../lib/audit');
const { generateTicketCode, normalizeTicketCode } = require('../lib/tickets');
const { toManilaIso } = require('../lib/time');
const { validateRegistration, normalizeEmail, normalizeMobile } = require('../lib/validation');
const { getEvent } = require('./events');

const ACTIVE = "status <> 'cancelled'";

function getRegistration(db, id) {
  return db.prepare('SELECT * FROM registrations WHERE id = ?').get(Number(id) || 0) || null;
}

function getRegistrationByCode(db, code) {
  const normalized = normalizeTicketCode(code);
  if (!normalized) return null;
  return db.prepare('SELECT * FROM registrations WHERE ticket_code = ?').get(normalized) || null;
}

/** 1-based place in line; the waitlist is first come, first served. */
function waitlistPosition(db, reg) {
  if (!reg || reg.status !== 'waitlisted') return null;
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM registrations WHERE event_id = ? AND status = 'waitlisted' AND id <= ?")
    .get(reg.event_id, reg.id);
  return row.n;
}

/**
 * Register an attendee.
 * - Re-validates everything on the server (the form's disabled button is only a hint).
 * - Re-checks capacity inside a BEGIN IMMEDIATE transaction, so two people can't take the last spot.
 * - If the event is full: joins the waitlist when `joinWaitlist` is set, otherwise fails with FULL.
 */
function register(db, eventId, body, { joinWaitlist = false } = {}, now) {
  const v = validateRegistration(body);
  if (!v.ok) throw new ValidationError(v.errors);
  const { fullName, email, mobile } = v.values;

  return transaction(db, () => {
    const ev = getEvent(db, eventId, now);
    if (!ev || ev.status === 'draft') throw new AppError('NOT_FOUND', 'Event not found.', { status: 404 });
    if (ev.hasEnded) throw new AppError('ENDED', 'This event has ended, so registration is closed.');
    if (ev.status === 'closed') throw new AppError('CLOSED', 'Registration for this event is closed.');

    const existing = db.prepare(`SELECT * FROM registrations WHERE event_id = ? AND email = ? AND ${ACTIVE}`).get(ev.id, email);
    if (existing) {
      throw new AppError(
        'DUPLICATE',
        existing.status === 'waitlisted'
          ? 'This email is already on the waitlist for this event. Use "Find my ticket" to see your place in line.'
          : 'This email is already registered for this event. Use "Find my ticket" to see your ticket again.',
        { status: 409 }
      );
    }

    let status;
    if (!ev.isFull) status = 'confirmed';
    else if (joinWaitlist) status = 'waitlisted';
    else throw new AppError('FULL', 'Sorry, this event is now full. You can join the waitlist instead.', { status: 409 });

    const registeredAt = toManilaIso(now);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateTicketCode(ev.code_prefix);
      try {
        const res = db
          .prepare(
            `INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, registered_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(ev.id, fullName, email, mobile, code, status, registeredAt);
        return getRegistration(db, res.lastInsertRowid);
      } catch (err) {
        if (isConstraintError(err, 'registrations.ticket_code')) continue; // astronomically rare: try a new code
        if (isConstraintError(err, 'EVENT_FULL')) throw new AppError('FULL', 'Sorry, this event is now full.', { status: 409 });
        if (isConstraintError(err, 'registrations.event_id, registrations.email')) {
          throw new AppError('DUPLICATE', 'This email is already registered for this event.', { status: 409 });
        }
        throw err;
      }
    }
    throw new Error('Could not generate a unique ticket code.');
  });
}

/**
 * Ticket lookup: the code AND the email (or mobile) must both match.
 * Any mismatch returns null, and the caller shows the same "Ticket not found" either way.
 */
function lookupTicket(db, code, contact) {
  const reg = getRegistrationByCode(db, code);
  if (!reg) return null;
  const raw = String(contact || '').trim();
  if (!raw) return null;
  const matches = raw.includes('@') ? normalizeEmail(raw) === reg.email : normalizeMobile(raw) === reg.mobile;
  return matches ? reg : null;
}

/**
 * Cancel a registration. Pass `staff` when staff cancels, or `attendee: true` when the attendee does.
 * Checked-in registrations cannot be cancelled.
 */
function cancelRegistration(db, regId, { staff = null } = {}, now) {
  return transaction(db, () => {
    const reg = getRegistration(db, regId);
    if (!reg) throw new AppError('NOT_FOUND', 'Registration not found.', { status: 404 });
    if (reg.status === 'checked_in') throw new AppError('CHECKED_IN', 'This person is already checked in, so the registration can’t be cancelled.', { status: 409 });
    if (reg.status === 'cancelled') throw new AppError('ALREADY_CANCELLED', 'This registration is already cancelled.', { status: 409 });

    const ts = toManilaIso(now);
    // The status condition makes this safe against a check-in landing at the same moment.
    const res = db
      .prepare("UPDATE registrations SET status = 'cancelled', cancelled_at = ?, cancelled_by = ? WHERE id = ? AND status IN ('confirmed', 'waitlisted')")
      .run(ts, staff ? staff.id : null, reg.id);
    if (res.changes !== 1) throw new AppError('CONFLICT', 'This registration just changed. Refresh and try again.', { status: 409 });

    logAudit(
      db,
      {
        staff,
        actor: staff ? undefined : `Attendee (${reg.email})`,
        action: 'registration_cancelled',
        targetType: 'registration',
        targetId: reg.id,
        eventId: reg.event_id,
        details: `${reg.ticket_code} · ${reg.full_name} (was ${reg.status === 'waitlisted' ? 'waitlisted' : 'confirmed'})`,
      },
      now
    );
    return { ...reg, status: 'cancelled', cancelled_at: ts };
  });
}

/** Move the first person on the waitlist into an open spot. Staff only. */
function promoteNext(db, eventId, staff, now) {
  return transaction(db, () => {
    const ev = getEvent(db, eventId, now);
    if (!ev) throw new AppError('NOT_FOUND', 'Event not found.', { status: 404 });
    if (ev.hasEnded) throw new AppError('ENDED', 'This event has ended.');
    if (ev.isFull) throw new AppError('NO_SPOT', 'There is no open spot yet. A spot opens when someone cancels or capacity is raised.', { status: 409 });
    const next = db
      .prepare("SELECT * FROM registrations WHERE event_id = ? AND status = 'waitlisted' ORDER BY id LIMIT 1")
      .get(ev.id);
    if (!next) throw new AppError('EMPTY_WAITLIST', 'Nobody is on the waitlist.', { status: 409 });

    const ts = toManilaIso(now);
    try {
      db.prepare("UPDATE registrations SET status = 'confirmed', promoted_at = ?, promoted_by = ? WHERE id = ? AND status = 'waitlisted'").run(ts, staff.id, next.id);
    } catch (err) {
      if (isConstraintError(err, 'EVENT_FULL')) throw new AppError('NO_SPOT', 'The open spot was just taken.', { status: 409 });
      throw err;
    }
    logAudit(db, { staff, action: 'waitlist_promoted', targetType: 'registration', targetId: next.id, eventId: ev.id, details: `${next.ticket_code} · ${next.full_name}` }, now);
    return getRegistration(db, next.id);
  });
}

const STATUS_FILTERS = ['confirmed', 'checked_in', 'waitlisted', 'cancelled'];

/** Attendee list for staff, with optional search by name, email or ticket code. */
function listRegistrations(db, eventId, { q = '', status = '' } = {}) {
  const where = ['r.event_id = ?'];
  const params = [Number(eventId) || 0];
  const term = String(q || '').trim();
  if (term) {
    where.push('(r.full_name LIKE ? ESCAPE \'\\\' OR r.email LIKE ? ESCAPE \'\\\' OR r.ticket_code LIKE ? ESCAPE \'\\\')');
    const like = `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    params.push(like, like, like);
  }
  if (STATUS_FILTERS.includes(status)) {
    where.push('r.status = ?');
    params.push(status);
  }
  const rows = db
    .prepare(
      `SELECT r.*, ci.name AS checked_in_by_name, ud.name AS checkin_undone_by_name, cb.name AS cancelled_by_name,
         (SELECT COUNT(*) FROM registrations w WHERE w.event_id = r.event_id AND w.status = 'waitlisted' AND w.id <= r.id) AS wl_pos
       FROM registrations r
       LEFT JOIN staff_users ci ON ci.id = r.checked_in_by
       LEFT JOIN staff_users ud ON ud.id = r.checkin_undone_by
       LEFT JOIN staff_users cb ON cb.id = r.cancelled_by
       WHERE ${where.join(' AND ')}
       ORDER BY r.id`
    )
    .all(...params);
  for (const r of rows) r.waitlist_position = r.status === 'waitlisted' ? r.wl_pos : null;
  return rows;
}

module.exports = {
  getRegistration,
  getRegistrationByCode,
  waitlistPosition,
  register,
  lookupTicket,
  cancelRegistration,
  promoteNext,
  listRegistrations,
  STATUS_FILTERS,
};
