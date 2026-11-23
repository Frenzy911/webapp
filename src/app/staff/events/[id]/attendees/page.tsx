import Link from 'next/link';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { ConfirmForm } from '@/components/ConfirmForm';
import { Loading, StatusBadge } from '@/components/Icon';
import { NoAccess } from '@/components/NoAccess';
import { requireStaff } from '@/lib/auth';
import { getEvent } from '@/lib/events';
import { listRegistrations, STATUS_FILTERS } from '@/lib/registrations';
import { formatDateTime, formatTime } from '@/lib/time';
import { STATUS_LABELS } from '@/lib/types';
import { cancelRegistrationAction, promoteNextAction, undoCheckInAndBackAction } from '../../../actions';

export const metadata = { title: 'Attendees' };

export default function AttendeesPage({ params, searchParams }: PageProps<'/staff/events/[id]/attendees'>) {
  return (
    <>
      <Link className="back-link" href="/staff/dashboard">
        ← Dashboard
      </Link>
      <Suspense fallback={<Loading />}>
        <Attendees params={params} searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Attendees({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff();
  if (staff.role !== 'organizer') return <NoAccess />;
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const ev = await getEvent(id, new Date());
  if (!ev) notFound();

  const q = String(query.q || '').slice(0, 100);
  const status = (STATUS_FILTERS as readonly string[]).includes(String(query.status)) ? String(query.status) : '';
  const rows = await listRegistrations(ev.id, { q, status });
  const here = `/staff/events/${ev.id}/attendees`;

  return (
    <>
      <section className="page-head page-head-row">
        <div>
          <h1>{ev.title}</h1>
          <p className="meta">
            {ev.dateLabel} · {ev.timeLabel} · {ev.venue} · <StatusBadge status={ev.status} label={STATUS_LABELS[ev.status]} />
            {ev.hasEnded ? ' · Ended' : ''}
          </p>
        </div>
        <div className="head-actions">
          {ev.status !== 'draft' && (
            <Link className="btn btn-primary" href={`/staff/events/${ev.id}/checkin`}>
              Open check-in
            </Link>
          )}
          <Link className="btn" href={`/staff/events/${ev.id}/edit`}>
            Edit event
          </Link>
          <a className="btn btn-ghost" href={`/staff/events/${ev.id}/attendees.csv`}>
            Export CSV
          </a>
        </div>
      </section>

      <dl className="totals">
        <div className="total">
          <dt>Registered</dt>
          <dd>
            {ev.registered} <span>/ {ev.capacity}</span>
          </dd>
          <span className="stat-help">
            {ev.spotsLeft} spot{ev.spotsLeft === 1 ? '' : 's'} left
          </span>
        </div>
        <div className="total">
          <dt>Checked in</dt>
          <dd>
            {ev.checked_in} <span>/ {ev.registered}</span>
          </dd>
          <span className="stat-help">{ev.noShows === null ? 'event not started' : `${ev.noShows} no-show${ev.noShows === 1 ? '' : 's'} so far`}</span>
        </div>
        <div className="total">
          <dt>Waitlisted</dt>
          <dd>{ev.waitlisted}</dd>
        </div>
        <div className="total">
          <dt>Cancelled</dt>
          <dd>{ev.cancelled}</dd>
        </div>
      </dl>

      {ev.waitlisted > 0 && (
        <div className={`notice ${ev.isFull ? 'notice-info' : 'notice-warning'} promote-bar`}>
          {ev.isFull ? (
            <span>
              <strong>{ev.waitlisted}</strong> on the waitlist. No open spot right now. A spot opens when someone cancels or you raise the capacity.
            </span>
          ) : (
            <>
              <span>
                <strong>{ev.spotsLeft}</strong> spot{ev.spotsLeft === 1 ? '' : 's'} open and <strong>{ev.waitlisted}</strong> waiting.
              </span>
              <ConfirmForm action={promoteNextAction.bind(null, ev.id)} className="inline" buttonClassName="btn btn-primary btn-small" label="Promote #1 on waitlist" />
            </>
          )}
        </div>
      )}

      <form method="get" action={here} className="search-bar" role="search">
        <label htmlFor="q" className="sr-only">
          Search by name, email or ticket code
        </label>
        <input id="q" name="q" type="search" defaultValue={q} placeholder="Search name, email or ticket code" autoComplete="off" />
        <label htmlFor="status-filter" className="sr-only">
          Status
        </label>
        <select id="status-filter" name="status" defaultValue={status}>
          <option value="">All statuses</option>
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <button className="btn" type="submit">
          Search
        </button>
        {(q || status) && (
          <Link className="btn btn-ghost" href={here}>
            Clear
          </Link>
        )}
      </form>

      <p className="meta">
        {rows.length} {rows.length === 1 ? 'registration' : 'registrations'}
        {q || status ? ' match' : ''}.
      </p>

      <div className="table-wrap card">
        <table className="table attendees">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Mobile</th>
              <th scope="col">Ticket code</th>
              <th scope="col">Registered at</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No registrations{q || status ? ' match your search' : ' yet'}.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className={`row-${r.status}`}>
                <td>
                  <strong>{r.full_name}</strong>
                </td>
                <td>{r.email}</td>
                <td className="nowrap">{r.mobile}</td>
                <td className="mono nowrap">{r.ticket_code}</td>
                <td className="nowrap">{formatDateTime(r.registered_at)}</td>
                <td>
                  {r.status === 'checked_in' ? (
                    <>
                      <span className="badge badge-success">✓ Checked in</span>
                      <div className="meta">
                        {formatTime(r.checked_in_at!)}
                        {r.checked_in_by_name ? ` by ${r.checked_in_by_name}` : ''}
                      </div>
                    </>
                  ) : r.status === 'confirmed' ? (
                    <>
                      <span className="badge badge-info">Confirmed</span>
                      {r.checkin_undone_at && (
                        <div className="meta">
                          Check-in undone {formatTime(r.checkin_undone_at)} by {r.checkin_undone_by_name}
                        </div>
                      )}
                      {r.promoted_at && <div className="meta">Promoted from waitlist</div>}
                    </>
                  ) : r.status === 'waitlisted' ? (
                    <span className="badge badge-warning">Waitlist #{r.waitlist_position}</span>
                  ) : (
                    <>
                      <span className="badge badge-danger">✕ Cancelled</span>
                      <div className="meta">
                        {formatDateTime(r.cancelled_at)} by {r.cancelled_by_name || 'attendee'}
                      </div>
                    </>
                  )}
                </td>
                <td className="actions-cell">
                  {r.status === 'checked_in' ? (
                    <ConfirmForm
                      action={undoCheckInAndBackAction.bind(null, r.id, here)}
                      confirm={`Undo the check-in for ${r.full_name}?`}
                      className="inline"
                      buttonClassName="btn btn-small btn-ghost"
                      label="Undo check-in"
                    />
                  ) : r.status === 'confirmed' || r.status === 'waitlisted' ? (
                    <ConfirmForm
                      action={cancelRegistrationAction.bind(null, r.id, here)}
                      confirm={`Cancel the registration for ${r.full_name} (${r.ticket_code})?`}
                      className="inline"
                      buttonClassName="btn btn-small btn-danger-outline"
                      label="Cancel"
                    />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
