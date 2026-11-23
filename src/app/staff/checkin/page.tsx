import Link from 'next/link';
import { Suspense } from 'react';
import { Loading } from '@/components/Icon';
import { requireStaff } from '@/lib/auth';
import { listCheckinEvents } from '@/lib/events';

export const metadata = { title: 'Check-in' };

export default function CheckinSelectPage() {
  return (
    <>
      <section className="page-head">
        <h1>Check-in</h1>
        <p className="lead">Choose the event you are working at.</p>
      </section>
      <Suspense fallback={<Loading />}>
        <EventPicker />
      </Suspense>
    </>
  );
}

async function EventPicker() {
  await requireStaff();
  const events = await listCheckinEvents(new Date());
  if (!events.length) {
    return (
      <div className="card empty-state">
        <p>No published events today or coming up.</p>
      </div>
    );
  }
  const groups: [string, typeof events][] = [
    ['Today', events.filter((e) => e.isEventDay)],
    ['Coming up', events.filter((e) => !e.isEventDay)],
  ];
  return (
    <>
      {groups
        .filter(([, list]) => list.length)
        .map(([heading, list]) => (
          <section key={heading}>
            <h2 className="section-title">{heading}</h2>
            <ul className="pick-list">
              {list.map((ev) => (
                <li key={ev.id}>
                  <Link className="pick" href={`/staff/events/${ev.id}/checkin`}>
                    <span className="pick-main">
                      <strong>{ev.title}</strong>
                      <span className="meta">
                        {ev.dateLabel} · {ev.timeLabel} · {ev.venue}
                      </span>
                    </span>
                    <span className="pick-side">
                      <span className="pick-count">
                        {ev.checked_in} / {ev.registered}
                      </span>
                      <span className="meta">checked in</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </>
  );
}
