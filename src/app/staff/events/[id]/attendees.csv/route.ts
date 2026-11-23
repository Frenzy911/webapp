import { NextResponse } from 'next/server';
import { getCurrentStaff } from '@/lib/auth';
import { getEvent } from '@/lib/events';
import { listRegistrations } from '@/lib/registrations';
import { formatDateTime, manilaDateString } from '@/lib/time';
import { STATUS_LABELS } from '@/lib/types';

function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return `"${s.replace(/"/g, '""')}"`;
}

/** Attendee list as Excel-friendly CSV (UTF-8 BOM, CRLF, mobile numbers keep their leading zero). */
export async function GET(_request: Request, { params }: RouteContext<'/staff/events/[id]/attendees.csv'>) {
  const staff = await getCurrentStaff();
  if (!staff) return NextResponse.json({ error: 'Please sign in again.' }, { status: 401 });
  if (staff.role !== 'organizer') return NextResponse.json({ error: 'Organizers only.' }, { status: 403 });
  const ev = await getEvent((await params).id, new Date());
  if (!ev) return NextResponse.json({ error: 'Event not found.' }, { status: 404 });

  const rows = await listRegistrations(ev.id);
  const header = ['Ticket code', 'Full name', 'Email', 'Mobile', 'Status', 'Waitlist position', 'Registered at', 'Checked in at', 'Checked in by', 'Cancelled at'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.ticket_code),
        csvCell(r.full_name),
        csvCell(r.email),
        // Written as ="09171234567" so Excel keeps the leading zero. Safe: mobile is validated as 11 digits.
        /^\d{1,15}$/.test(r.mobile) ? `"=""${r.mobile}"""` : csvCell(r.mobile),
        csvCell(STATUS_LABELS[r.status]),
        csvCell(r.waitlist_position || ''),
        csvCell(formatDateTime(r.registered_at)),
        csvCell(formatDateTime(r.checked_in_at)),
        csvCell(r.checked_in_by_name || ''),
        csvCell(formatDateTime(r.cancelled_at)),
      ].join(',')
    );
  }
  const filename = `${ev.code_prefix}-attendees-${manilaDateString(ev.starts_at)}.csv`;
  return new Response('﻿' + lines.join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
