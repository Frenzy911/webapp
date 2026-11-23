import { Suspense } from 'react';
import { Loading } from '@/components/Icon';
import { NoAccess } from '@/components/NoAccess';
import { requireStaff } from '@/lib/auth';
import { unexpected } from '@/lib/errors';
import { listAllEvents } from '@/lib/events';
import { db } from '@/lib/supabase/admin';
import { formatDateTime } from '@/lib/time';
import { ACTION_LABELS } from '@/lib/types';

export const metadata = { title: 'Audit log' };

type AuditRow = { id: number; actor: string; action: string; details: string | null; created_at: string; events: { title: string } | null };

export default function AuditPage({ searchParams }: PageProps<'/staff/audit'>) {
  return (
    <Suspense fallback={<Loading />}>
      <Audit searchParams={searchParams} />
    </Suspense>
  );
}

async function Audit({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff();
  if (staff.role !== 'organizer') return <NoAccess />;
  const query = await searchParams;
  const eventId = Number(query.event) || null;
  const action = Object.keys(ACTION_LABELS).includes(String(query.action)) ? String(query.action) : '';

  let q = db().from('audit_logs').select('id, actor, action, details, created_at, events(title)').order('id', { ascending: false }).limit(300);
  if (eventId) q = q.eq('event_id', eventId);
  if (action) q = q.eq('action', action);
  const [{ data, error }, events] = await Promise.all([q.overrideTypes<AuditRow[], { merge: false }>(), listAllEvents(new Date())]);
  if (error) unexpected(error, 'audit log');
  const rows = data || [];

  return (
    <>
      <section className="page-head">
        <h1>Audit log</h1>
        <p className="lead">Who did what, and when. Newest first (last 300 entries).</p>
      </section>

      <form method="get" action="/staff/audit" className="search-bar">
        <label htmlFor="audit-event" className="sr-only">
          Event
        </label>
        <select id="audit-event" name="event" defaultValue={eventId ? String(eventId) : ''}>
          <option value="">All events</option>
          {events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
            </option>
          ))}
        </select>
        <label htmlFor="audit-action" className="sr-only">
          Action
        </label>
        <select id="audit-action" name="action" defaultValue={action}>
          <option value="">All actions</option>
          {Object.entries(ACTION_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <button className="btn" type="submit">
          Filter
        </button>
      </form>

      <div className="table-wrap card">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">What</th>
              <th scope="col">Details</th>
              <th scope="col">Event</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  Nothing logged yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="nowrap">{formatDateTime(r.created_at)}</td>
                <td>{r.actor}</td>
                <td>
                  <span className={`badge badge-${r.action === 'checkin_undone' || r.action === 'registration_cancelled' ? 'warning' : 'muted'}`}>
                    {ACTION_LABELS[r.action] || r.action}
                  </span>
                </td>
                <td>{r.details}</td>
                <td>{r.events?.title || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
