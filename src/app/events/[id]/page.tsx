import Link from 'next/link';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Loading } from '@/components/Icon';
import { getEvent } from '@/lib/events';

export const metadata = { title: 'Event' };

export default function EventPage({ params }: PageProps<'/events/[id]'>) {
  return (
    <>
      <Link className="back-link" href="/">
        ← All events
      </Link>
      <Suspense fallback={<Loading />}>
        <EventDetail params={params} />
      </Suspense>
    </>
  );
}

async function EventDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await connection();
  const ev = await getEvent(id, new Date());
  // Drafts are invisible to attendees, even by URL.
  if (!ev || ev.status === 'draft') notFound();

  return (
    <article className="event-detail">
      <header className="event-detail-head">
        <h1>{ev.title}</h1>
        {ev.hasEnded ? (
          <span className="badge badge-muted">Ended</span>
        ) : ev.status === 'closed' ? (
          <span className="badge badge-muted">Registration closed</span>
        ) : (
          <>
            {ev.hasStarted && <span className="badge badge-success badge-live">Happening now</span>}
            {ev.isFull && <span className="badge badge-danger">Full</span>}
          </>
        )}
      </header>

      <div className="event-detail-grid">
        <section className="card event-info" aria-labelledby="event-info-title">
          <h2 id="event-info-title">Event details</h2>
          <dl className="facts">
            <div>
              <dt>Date</dt>
              <dd>{ev.dateLabel}</dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd>
                {ev.timeLabel} <span className="muted">Cebu time</span>
              </dd>
            </div>
            <div>
              <dt>Venue</dt>
              <dd>{ev.venue}</dd>
            </div>
          </dl>
          {ev.description && <div className="description">{ev.description}</div>}
        </section>

        <section className="card event-booking" aria-labelledby="event-booking-title">
          <h2 id="event-booking-title">Registration</h2>
          <p className="booking-spots">
            {ev.isFull ? (
              <>
                <strong className="text-danger">Full</strong> · {ev.capacity} of {ev.capacity} taken
                {ev.waitlisted > 0 && ` · ${ev.waitlisted} on waitlist`}
              </>
            ) : (
              <>
                <strong>{ev.spotsLeft}</strong> of {ev.capacity} spots left
              </>
            )}
          </p>
          <div className="cta">
            {ev.hasEnded ? (
              <button className="btn btn-big" type="button" disabled>
                Registration closed · event ended
              </button>
            ) : ev.status === 'closed' ? (
              <button className="btn btn-big" type="button" disabled>
                Registration closed
              </button>
            ) : ev.isFull ? (
              <>
                <button className="btn btn-big" type="button" disabled aria-describedby="full-note">
                  Register · Full
                </button>
                <p className="cta-note" id="full-note">
                  Join the waitlist and we&apos;ll email you if a spot opens.
                </p>
                <Link className="btn btn-primary btn-big" href={`/events/${ev.id}/register`}>
                  Join the waitlist
                </Link>
              </>
            ) : (
              <Link className="btn btn-primary btn-big" href={`/events/${ev.id}/register`}>
                Register
              </Link>
            )}
          </div>
          <p className="muted small">
            Already registered? <Link href="/tickets/find">Find your ticket</Link>
          </p>
        </section>
      </div>
    </article>
  );
}
