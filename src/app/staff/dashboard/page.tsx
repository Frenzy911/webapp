import Link from 'next/link';
import { Suspense } from 'react';
import { Loading, StatusBadge } from '@/components/Icon';
import { NoAccess } from '@/components/NoAccess';
import { requireStaff } from '@/lib/auth';
import { listUpcomingEvents } from '@/lib/events';
import { STATUS_LABELS } from '@/lib/types';

export const metadata = { title: 'Dashboard' };

export default function DashboardPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Dashboard />
    </Suspense>
  );
}

async function Dashboard() {
  const staff = await requireStaff();
  if (staff.role !== 'organizer') return <NoAccess />;
  const events = await listUpcomingEvents(new Date());

  return (
    <>
      <section className="page-head page-head-row">
        <div>
          <h1>Dashboard</h1>
          <p className="lead">Every event that hasn&apos;t ended yet.</p>
        </div>
        <Link className="btn btn-primary" href="/staff/events/new">
          + New event
        </Link>
      </section>
      {events.length === 0 && (
        <div className="card empty-state">
          <p>
            No upcoming events. <Link href="/staff/events/new">Create one</Link>.
          </p>
        </div>
      )}
      <div className="dash-grid">
      {events.map((ev) => (
        <article className="card dash-card" key={ev.id}>
          <header className="dash-card-head">
            <div>
              <h2>
                <Link href={`/staff/events/${ev.id}/attendees`}>{ev.title}</Link>
              </h2>
              <p className="meta">
                {ev.dateLabel} · {ev.timeLabel}
              </p>
            </div>
            <StatusBadge status={ev.status} label={STATUS_LABELS[ev.status]} />
          </header>
          <dl className="stat-grid">
            <div>
              <dt>Capacity</dt>
              <dd>{ev.capacity}</dd>
            </div>
            <div>
              <dt>Confirmed</dt>
              <dd>{ev.registered}</dd>
              <span className="stat-help">incl. checked in</span>
            </div>
            <div>
              <dt>Waitlisted</dt>
              <dd>{ev.waitlisted}</dd>
            </div>
            <div>
              <dt>Cancelled</dt>
              <dd>{ev.cancelled}</dd>
            </div>
            <div>
              <dt>Checked in</dt>
              <dd>{ev.checked_in}</dd>
            </div>
            <div>
              <dt>No-shows</dt>
              <dd>{ev.noShows === null ? '—' : ev.noShows}</dd>
              <span className="stat-help">{ev.noShows === null ? 'after it starts' : 'not checked in'}</span>
            </div>
          </dl>
          <footer className="dash-card-actions">
            <Link className="btn btn-small" href={`/staff/events/${ev.id}/attendees`}>
              Attendees
            </Link>
            {ev.status !== 'draft' && (
              <Link className="btn btn-small" href={`/staff/events/${ev.id}/checkin`}>
                Check-in
              </Link>
            )}
            <a className="btn btn-small btn-ghost" href={`/staff/events/${ev.id}/attendees.csv`}>
              Export CSV
            </a>
          </footer>
        </article>
      ))}
      </div>
    </>
  );
}
