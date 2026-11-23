import Link from 'next/link';
import QRCode from 'qrcode';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { ConfirmForm } from '@/components/ConfirmForm';
import { Loading } from '@/components/Icon';
import { getEvent } from '@/lib/events';
import { smtpConfigured } from '@/lib/mailer';
import { getRegistrationByCode, waitlistPosition } from '@/lib/registrations';
import { canViewTicket } from '@/lib/ticketAccess';
import { formatTime } from '@/lib/time';
import { cancelOwnTicketAction } from '../actions';

export const metadata = { title: 'Your ticket' };

export default function TicketPage({ params, searchParams }: PageProps<'/tickets/[code]'>) {
  return (
    <Suspense fallback={<Loading label="Loading your ticket…" />}>
      <Ticket params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Ticket({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ code }, query] = await Promise.all([params, searchParams]);
  await connection();
  const reg = await getRegistrationByCode(code);
  // Only a browser that registered, looked the ticket up, or opened the email link may see it.
  if (!reg || !(await canViewTicket(reg.id))) redirect(`/tickets/find?code=${encodeURIComponent(String(code).slice(0, 32))}`);

  const ev = (await getEvent(reg.event_id, new Date()))!;
  const hasQr = reg.status === 'confirmed' || reg.status === 'checked_in';
  const qrSvg = hasQr ? await QRCode.toString(reg.ticket_code, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) : null;
  const position = await waitlistPosition(reg);
  const justRegistered = query.new === '1';
  const emailSent = smtpConfigured();
  const canCancel = (reg.status === 'confirmed' || reg.status === 'waitlisted') && !ev.hasEnded;

  return (
    <>
      {justRegistered && (
        <div className="notice notice-success ticket-notice" role="status">
          {reg.status === 'waitlisted' ? (
            <>
              <strong>You&apos;re on the waitlist.</strong>
              {emailSent && ` We sent the details to ${reg.email}.`} We&apos;ll email you if a spot opens.
            </>
          ) : (
            <>
              <strong>You&apos;re registered!</strong> Show this QR code at the door.
              {emailSent && ` We also emailed it to ${reg.email}.`} To open it again later, use your ticket code and email on{' '}
              <Link href="/tickets/find">Find my ticket</Link>.
            </>
          )}
        </div>
      )}

      <article className={`ticket ticket-${reg.status}`} aria-labelledby="ticket-title">
        <header className="ticket-head">
          <p className="eyebrow">{reg.status === 'waitlisted' ? 'Waitlist' : 'Event ticket'}</p>
          <h1 id="ticket-title">{ev.title}</h1>
          <p className="ticket-status">
            {reg.status === 'confirmed' ? (
              <span className="badge badge-success">✓ Confirmed</span>
            ) : reg.status === 'checked_in' ? (
              <span className="badge badge-success">✓ Checked in · {formatTime(reg.checked_in_at!)}</span>
            ) : reg.status === 'waitlisted' ? (
              <span className="badge badge-warning">On waitlist · not confirmed</span>
            ) : (
              <span className="badge badge-danger">✕ Cancelled</span>
            )}
            {ev.hasEnded && <span className="badge badge-muted">Event ended</span>}
          </p>
        </header>

        <div className="ticket-main">
          {qrSvg ? (
            <figure className="qr">
              {/* SVG generated on the server by the qrcode library from a validated ticket code. */}
              <div className="qr-box" role="img" aria-label={`QR code for ticket ${reg.ticket_code}`} dangerouslySetInnerHTML={{ __html: qrSvg }} />
              <figcaption>
                <span className="ticket-code-label">Ticket code</span>
                <span className="ticket-code">{reg.ticket_code}</span>
              </figcaption>
            </figure>
          ) : reg.status === 'waitlisted' ? (
            <div className="waitlist-box">
              <p className="waitlist-pos">
                You are <strong>#{position}</strong> on the waitlist
              </p>
              <p>
                This is <strong>not</strong> an entry ticket yet. If a spot opens, staff will confirm you and we&apos;ll email your QR ticket to {reg.email}.
              </p>
              <p className="muted small">
                Reference code: <span className="mono">{reg.ticket_code}</span>
              </p>
            </div>
          ) : (
            <div className="waitlist-box">
              <p className="waitlist-pos">This registration is cancelled.</p>
              <p>
                It no longer works at the door.
                {ev.registrationOpen && (
                  <>
                    {' '}
                    You can <Link href={`/events/${ev.id}`}>register again</Link> if spots are available.
                  </>
                )}
              </p>
              <p className="muted small">
                Reference code: <span className="mono">{reg.ticket_code}</span>
              </p>
            </div>
          )}

          <dl className="ticket-facts">
            <div>
              <dt>Name</dt>
              <dd>{reg.full_name}</dd>
            </div>
            <div>
              <dt>Date</dt>
              <dd>{ev.dateLabel}</dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd>{ev.timeLabel}</dd>
            </div>
            <div>
              <dt>Venue</dt>
              <dd>{ev.venue}</dd>
            </div>
          </dl>
        </div>
      </article>

      <div className="ticket-actions">
        {canCancel ? (
          <ConfirmForm
            action={cancelOwnTicketAction.bind(null, reg.ticket_code)}
            confirm={`Cancel your ${reg.status === 'waitlisted' ? 'place on the waitlist' : 'registration'} for ${ev.title}? This can't be undone.`}
            buttonClassName="btn btn-danger-outline"
            label={reg.status === 'waitlisted' ? 'Leave waitlist' : 'Cancel registration'}
          />
        ) : (
          reg.status === 'checked_in' && <p className="muted small">Checked-in registrations can&apos;t be cancelled.</p>
        )}
        <Link className="btn btn-ghost" href="/tickets/find">
          Find another ticket
        </Link>
        <Link className="btn btn-ghost" href="/">
          Browse events
        </Link>
      </div>
    </>
  );
}
