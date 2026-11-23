import Link from 'next/link';
import { manilaDateString } from '@/lib/time';
import type { EventView } from '@/lib/types';
import { Icon } from './Icon';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function EventCard({ ev }: { ev: EventView }) {
  const date = manilaDateString(ev.starts_at);
  const titleId = `event-${ev.id}-title`;
  return (
    <Link className={`event-card${ev.hasEnded ? ' is-ended' : ''}`} href={`/events/${ev.id}`} aria-labelledby={titleId}>
      <div className="event-card-top">
        <div className="date-badge" aria-hidden="true">
          <span className="date-badge-m">{MONTHS[Number(date.slice(5, 7)) - 1]}</span>
          <span className="date-badge-d">{Number(date.slice(8, 10))}</span>
        </div>
        <div className="event-card-tags">
          {ev.hasEnded ? (
            <span className="badge badge-muted">Ended</span>
          ) : (
            <>
              {ev.hasStarted && <span className="badge badge-success badge-live">Happening now</span>}
              {ev.isFull && <span className="badge badge-warning">Full</span>}
            </>
          )}
        </div>
      </div>
      <div className="event-card-body">
        <h3 className="event-card-title" id={titleId}>
          {ev.title}
        </h3>
        <p className="event-meta">
          <Icon name="calendar" />
          <span>
            {ev.dateLabel} · {ev.timeLabel}
          </span>
        </p>
        <p className="event-meta">
          <Icon name="pin" />
          <span>{ev.venue}</span>
        </p>
      </div>
      <div className="event-card-footer">
        {!ev.hasEnded && (
          <span className={`spots${!ev.isFull && ev.spotsLeft <= 5 ? ' spots-low' : ''}`}>
            <Icon name="ticket" />
            {ev.isFull ? (
              <span>{ev.waitlisted} on waitlist</span>
            ) : (
              <span>
                <strong>{ev.spotsLeft}</strong> of {ev.capacity} spots left
              </span>
            )}
          </span>
        )}
        <span className="event-card-arrow" aria-hidden="true">
          <Icon name="arrow" />
        </span>
      </div>
    </Link>
  );
}
