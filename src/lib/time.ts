/**
 * Everything is shown in Cebu time (Asia/Manila, UTC+8, no daylight saving).
 * The database stores timestamptz; these helpers turn form input into instants and instants into labels.
 */

export const TIME_ZONE = 'Asia/Manila';
const OFFSET_MS = 8 * 60 * 60 * 1000;

type DateLike = Date | string;

function toDate(value: DateLike): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Date -> "2026-12-05T18:00:00+08:00" */
export function toManilaIso(value: DateLike): string {
  const shifted = new Date(toDate(value).getTime() + OFFSET_MS);
  return shifted.toISOString().slice(0, 19) + '+08:00';
}

/** Date -> "2026-12-05" (the calendar date in Cebu) */
export function manilaDateString(value: DateLike): string {
  return toManilaIso(value).slice(0, 10);
}

/** "2026-12-05", "18:00" -> "2026-12-05T18:00:00+08:00" (or null if invalid) */
export function fromLocalParts(dateStr: string, timeStr: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') || !/^\d{2}:\d{2}$/.test(timeStr || '')) return null;
  const iso = `${dateStr}T${timeStr}:00+08:00`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // Reject impossible dates like 2026-02-31 (Date would roll them over).
  if (toManilaIso(d) !== iso) return null;
  return iso;
}

/** instant -> { date: "2026-12-05", time: "18:00" } in Cebu time */
export function toLocalParts(value: DateLike): { date: string; time: string } {
  const iso = toManilaIso(value);
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00+08:00`);
  return manilaDateString(new Date(d.getTime() + days * 86_400_000));
}

function clean(s: string): string {
  // Newer ICU versions put a narrow no-break space before AM/PM; use a normal space.
  return s.replace(/[  ]/g, ' ');
}

const fmtDate = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit', hour12: true });
const fmtShortDate = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric', year: 'numeric' });

/** "Sat, Dec 5, 2026" */
export function formatDate(value: DateLike): string {
  return clean(fmtDate.format(toDate(value)));
}

/** "6:00 PM" */
export function formatTime(value: DateLike): string {
  return clean(fmtTime.format(toDate(value)));
}

/** "Dec 5, 2026, 6:03 PM" */
export function formatDateTime(value: DateLike | null | undefined): string {
  if (!value) return '';
  return `${clean(fmtShortDate.format(toDate(value)))}, ${formatTime(value)}`;
}

/** "6:00 PM – 9:00 PM" (adds the end date if the event runs past midnight) */
export function formatTimeRange(start: DateLike, end: DateLike): string {
  const sameDay = manilaDateString(start) === manilaDateString(end);
  return sameDay ? `${formatTime(start)} – ${formatTime(end)}` : `${formatTime(start)} – ${formatDate(end)} ${formatTime(end)}`;
}
