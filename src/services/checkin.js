'use strict';

const { transaction, lockEvent, all, get, run } = require('../db');
const { AppError } = require('../lib/errors');
const { logAudit } = require('../lib/audit');
const { normalizeTicketCode } = require('../lib/tickets');
const { toManilaIso, formatTime, formatDateTime, formatDate } = require('../lib/time');
const { getEvent } = require('./events');

/**
 * What staff see for each outcome. `tone` drives the colour; the title and icon
 * always say the same thing in words, so colour is never the only signal.
 */
const RESULTS = {
  checked_in: { tone: 'success', icon: '✓', title: 'Checked in' },
  already: { tone: 'warning', icon: '!', title: 'Already checked in' },
  waitlisted: { tone: 'danger', icon: '✕', title: 'On waitlist — not confirmed' },
  cancelled: { tone: 'danger', icon: '✕', title: 'Cancelled' },
  invalid: { tone: 'danger', icon: '✕', title: 'Invalid ticket' },
  not_event_day: { tone: 'danger', icon: '✕', title: 'Not the event day' },
};

async function stats(db, eventId) {
  const row = await get(
    db,
    `SELECT COALESCE(SUM(status = 'checked_in'), 0) AS checked_in,
            COALESCE(SUM(status IN ('confirmed', 'checked_in')), 0) AS registered
     FROM registrations WHERE event_id = ?`,
    [eventId]
  );
  return { checkedIn: row.checked_in, registered: row.registered };
}

async function recentCheckins(db, eventId, limit = 8) {
  const rows = await all(
    db,
    `SELECT r.id, r.full_name, r.ticket_code, r.checked_in_at, s.name AS checked_in_by_name
     FROM registrations r LEFT JOIN staff_users s ON s.id = r.checked_in_by
     WHERE r.event_id = ? AND r.status = 'checked_in'
     ORDER BY r.checked_in_at DESC, r.id DESC LIMIT ?`,
    [eventId, limit]
  );
  return rows.map((r) => ({ id: r.id, name: r.full_name, code: r.ticket_code, time: formatTime(r.checked_in_at), by: r.checked_in_by_name }));
}

function buildResult(kind, { reg = null, message = '', code = '' } = {}) {
  const meta = RESULTS[kind];
  return {
    result: kind,
    tone: meta.tone,
    icon: meta.icon,
    title: meta.title,
    name: reg ? reg.full_name : null,
    code: reg ? reg.ticket_code : code,
    registrationId: reg ? reg.id : null,
    message,
  };
}

/**
 * Check a ticket in. Two checks, in order (see the activity's check-in diagram):
 *   1. Does the code exist AND belong to the selected event?   no -> Invalid ticket
 *   2. What is its status?  confirmed -> Checked in, checked_in -> Already checked in,
 *                           waitlisted / cancelled -> Not confirmed
 * Plus the booking rule: a Confirmed ticket only checks in on the event day.
 *
 * The final UPDATE only matches rows that are still 'confirmed', so if two devices
 * scan the same ticket at the same moment exactly one of them changes the row and
 * shows "Checked in"; the other sees changes === 0 and reports "Already checked in".
 */
async function checkIn(db, eventId, rawCode, staff, now) {
  const code = normalizeTicketCode(rawCode);
  const typed = String(rawCode || '').trim().slice(0, 40);

  return transaction(db, async (conn) => {
    await lockEvent(conn, eventId);
    const ev = await getEvent(conn, eventId, now);
    if (!ev || ev.status === 'draft') throw new AppError('NOT_FOUND', 'Event not found.', { status: 404 });

    const reg = code ? await get(conn, 'SELECT * FROM registrations WHERE ticket_code = ?', [code]) : null;
    let out;
    if (!reg) {
      out = buildResult('invalid', { code: typed, message: 'No ticket has this code. Check for typos, or ask for the ticket page.' });
    } else if (reg.event_id !== ev.id) {
      out = buildResult('invalid', { code: reg.ticket_code, message: 'This ticket is for a different event.' });
    } else if (reg.status === 'checked_in') {
      out = buildResult('already', { reg, message: `First checked in at ${formatTime(reg.checked_in_at)} (${formatDate(reg.checked_in_at)}).` });
      out.firstCheckedInAt = reg.checked_in_at;
    } else if (reg.status === 'waitlisted') {
      out = buildResult('waitlisted', { reg, message: 'This person is on the waitlist and does not have a confirmed spot.' });
    } else if (reg.status === 'cancelled') {
      out = buildResult('cancelled', { reg, message: `This registration was cancelled${reg.cancelled_at ? ` on ${formatDateTime(reg.cancelled_at)}` : ''}.` });
    } else if (!ev.isEventDay) {
      out = buildResult('not_event_day', { reg, message: `Check-in only works on the event day (${ev.dateLabel}).` });
    } else {
      const ts = toManilaIso(now);
      const res = await run(conn, "UPDATE registrations SET status = 'checked_in', checked_in_at = ?, checked_in_by = ? WHERE id = ? AND status = 'confirmed'", [
        ts,
        staff.id,
        reg.id,
      ]);
      if (res.changes === 1) {
        await logAudit(conn, { staff, action: 'checked_in', targetType: 'registration', targetId: reg.id, eventId: ev.id, details: `${reg.ticket_code} · ${reg.full_name}` }, now);
        out = buildResult('checked_in', { reg, message: `Checked in at ${formatTime(ts)}.` });
      } else {
        // Someone else changed it between our read and our write.
        const fresh = await get(conn, 'SELECT * FROM registrations WHERE id = ?', [reg.id]);
        out =
          fresh.status === 'checked_in'
            ? buildResult('already', { reg: fresh, message: `First checked in at ${formatTime(fresh.checked_in_at)}.` })
            : buildResult(fresh.status === 'waitlisted' ? 'waitlisted' : 'cancelled', { reg: fresh });
      }
    }
    out.stats = await stats(conn, ev.id);
    return out;
  });
}

/** Reverse a mistaken check-in. Records who undid it and when, on the row and in the audit log. */
async function undoCheckIn(db, regId, staff, now) {
  return transaction(db, async (conn) => {
    const found = await get(conn, 'SELECT event_id FROM registrations WHERE id = ?', [Number(regId) || 0]);
    if (!found) throw new AppError('NOT_FOUND', 'Registration not found.', { status: 404 });
    await lockEvent(conn, found.event_id);
    const reg = await get(conn, 'SELECT * FROM registrations WHERE id = ?', [Number(regId) || 0]);
    if (reg.status !== 'checked_in') throw new AppError('NOT_CHECKED_IN', 'This ticket is not checked in.', { status: 409 });
    const ts = toManilaIso(now);
    const res = await run(
      conn,
      `UPDATE registrations SET status = 'confirmed', checked_in_at = NULL, checked_in_by = NULL, checkin_undone_at = ?, checkin_undone_by = ?
       WHERE id = ? AND status = 'checked_in'`,
      [ts, staff.id, reg.id]
    );
    if (res.changes !== 1) throw new AppError('CONFLICT', 'This ticket just changed. Refresh and try again.', { status: 409 });
    await logAudit(
      conn,
      { staff, action: 'checkin_undone', targetType: 'registration', targetId: reg.id, eventId: reg.event_id, details: `${reg.ticket_code} · ${reg.full_name} (was checked in at ${formatTime(reg.checked_in_at)})` },
      now
    );
    return { registration: { ...reg, status: 'confirmed' }, stats: await stats(conn, reg.event_id) };
  });
}

module.exports = { checkIn, undoCheckIn, stats, recentCheckins, RESULTS };
