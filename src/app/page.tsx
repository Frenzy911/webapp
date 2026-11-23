import Image from 'next/image';
import { Suspense } from 'react';
import { connection } from 'next/server';
import { EventCard } from '@/components/EventCard';
import { Icon, Loading } from '@/components/Icon';
import { listPastPublicEvents, listPublicEvents } from '@/lib/events';
import heroImage from '../../public/images/cebu-meetup.jpg';

export const metadata = { title: 'Upcoming events' };

export default function HomePage() {
  return (
    <>
      <section className="event-hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <h1 id="hero-title">
            Meet Cebu’s <em>tech community.</em>
          </h1>
          <p>Find free meetups, talks, and hackathons. Register online and bring your QR ticket to the door.</p>
          <a className="btn hero-action" href="#upcoming-events">
            Browse events <Icon name="arrow" />
          </a>
        </div>
        <div className="hero-art" aria-hidden="true">
          <Image src={heroImage} alt="" priority sizes="(min-width: 900px) 50vw, 100vw" />
        </div>
      </section>

      <Suspense fallback={<Loading label="Loading events…" />}>
        <EventLists />
      </Suspense>
    </>
  );
}

async function EventLists() {
  await connection(); // counts change every minute: always render at request time
  const now = new Date();
  const [events, pastEvents] = await Promise.all([listPublicEvents(now), listPastPublicEvents(now)]);
  return (
    <>
      <section className="event-section" id="upcoming-events" aria-labelledby="upcoming-title">
        <h2 className="event-section-title" id="upcoming-title">
          Upcoming events
        </h2>
        {events.length === 0 ? (
          <div className="card empty-state">
            <p>No upcoming events right now. Check back soon.</p>
          </div>
        ) : (
          <ul className="event-list">
            {events.map((ev) => (
              <li key={ev.id}>
                <EventCard ev={ev} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {pastEvents.length > 0 && (
        <section className="event-section" aria-labelledby="past-title">
          <h2 className="event-section-title" id="past-title">
            Past events
          </h2>
          <ul className="event-list past-event-list">
            {pastEvents.map((ev) => (
              <li key={ev.id}>
                <EventCard ev={ev} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
