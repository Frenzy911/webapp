'use strict';

/**
 * All times are stored and shown in Cebu time (Asia/Manila, UTC+8, no daylight saving).
 * Stored format: ISO 8601 with an explicit offset, e.g. "2026-12-05T18:00:00+08:00".
 * Because every stored value has the same offset, plain string comparison sorts correctly.
 */

const TIME_ZONE = 'Asia/Manila';
const OFFSET_MS = 8 * 60 * 60 * 1000;

/** Date -> "2026-12-05T18:00:00+08:00" */
function toManilaIso(date) {
  const shifted = new Date(date.getTime() + OFFSET_MS);
  return shifted.toISOString().slice(0, 19) + '+08:00';
}

/** Date -> "2026-12-05" (the calendar date in Cebu) */
function manilaDateString(date) {
  return toManilaIso(date).slice(0, 10);
}

/** "2026-12-05", "18:00" -> "2026-12-05T18:00:00+08:00" (or null if invalid) */
function fromLocalParts(dateStr, timeStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') || !/^\d{2}:\d{2}$/.test(timeStr || '')) return null;
  const iso = `${dateStr}T${timeStr}:00+08:00`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // Reject impossible dates like 2026-02-31 (Date would roll them over).
  if (toManilaIso(d) !== iso) return null;
  return iso;
}

/** "2026-12-05T18:00:00+08:00" -> { date: "2026-12-05", time: "18:00" } */
function toLocalParts(iso) {
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00+08:00`);
  return manilaDateString(new Date(d.getTime() + days * 86_400_000));
}

function clean(s) {
  // Newer ICU versions put a narrow no-break space before AM/PM; use a normal space.
  return s.replace(/[  ]/g, ' ');
}

const fmtDate = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit', hour12: true });
const fmtShortDate = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric', year: 'numeric' });

function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}

/** "Sat, Dec 5, 2026" */
function formatDate(value) {
  return clean(fmtDate.format(toDate(value)));
}

/** "6:00 PM" */
function formatTime(value) {
  return clean(fmtTime.format(toDate(value)));
}

/** "Dec 5, 2026, 6:03 PM" */
function formatDateTime(value) {
  if (!value) return '';
  return `${clean(fmtShortDate.format(toDate(value)))}, ${formatTime(value)}`;
}

/** "6:00 PM – 9:00 PM" (adds the end date if the event runs past midnight) */
function formatTimeRange(startIso, endIso) {
  const sameDay = startIso.slice(0, 10) === endIso.slice(0, 10);
  return sameDay
    ? `${formatTime(startIso)} – ${formatTime(endIso)}`
    : `${formatTime(startIso)} – ${formatDate(endIso)} ${formatTime(endIso)}`;
}

module.exports = {
  TIME_ZONE,
  toManilaIso,
  manilaDateString,
  fromLocalParts,
  toLocalParts,
  addDays,
  formatDate,
  formatTime,
  formatDateTime,
  formatTimeRange,
};
