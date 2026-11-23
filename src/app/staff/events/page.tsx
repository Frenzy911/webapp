import Link from 'next/link';
import { Suspense } from 'react';
import { ConfirmForm } from '@/components/ConfirmForm';
import { Loading, StatusBadge } from '@/components/Icon';
import { NoAccess } from '@/components/NoAccess';
import { requireStaff } from '@/lib/auth';
import { listAllEvents } from '@/lib/events';
import { STATUS_LABELS } from '@/lib/types';
import { setEventStatusAction } from '../actions';

export const metadata = { title: 'Events' };

export default function EventsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Events />
    </Suspense>
  );
}

async function Events() {
  const staff = await requireStaff();
  if (staff.role !== 'organizer') return <NoAccess />;
  const events = await listAllEvents(new Date());

  return (
    <>
      <section className="page-head page-head-row">
        <div>
          <h1>Events</h1>
          <p className="lead">
            Only <strong>Published</strong> events are visible to attendees. <strong>Closed</strong> events stop taking registrations.
          </p>
        </div>
        <Link className="btn btn-primary" href="/staff/events/new">
          + New event
        </Link>
      </section>

      <div className="table-wrap card">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Event</th>
              <th scope="col">Status</th>
              <th scope="col">Registered</th>
              <th scope="col">Waitlist</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No events yet.
                </td>
              </tr>
            )}
            {events.map((ev) => (
              <tr key={ev.id}>
                <td>
                  <Link href={`/staff/events/${ev.id}/attendees`}>
                    <strong>{ev.title}</strong>
                  </Link>
                  <div className="meta">
                    {ev.dateLabel} · {ev.timeLabel}
                    {ev.hasEnded ? ' · Ended' : ''}
                  </div>
                </td>
                <td>
                  <StatusBadge status={ev.status} label={STATUS_LABELS[ev.status]} />
                </td>
                <td>
                  {ev.registered} / {ev.capacity}
                </td>
                <td>{ev.waitlisted}</td>
                <td className="actions-cell">
                  <Link className="btn btn-small" href={`/staff/events/${ev.id}/edit`}>
                    Edit
                  </Link>
                  {ev.status !== 'published' && (
                    <ConfirmForm
                      action={setEventStatusAction.bind(null, ev.id, 'published', '/staff/events')}
                      className="inline"
                      buttonClassName="btn btn-small btn-ghost"
                      label="Publish"
                    />
                  )}
                  {ev.status === 'published' && (
                    <ConfirmForm
                      action={setEventStatusAction.bind(null, ev.id, 'closed', '/staff/events')}
                      confirm={`Close registration for ${ev.title}? Existing tickets keep working.`}
                      className="inline"
                      buttonClassName="btn btn-small btn-ghost"
                      label="Close"
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
