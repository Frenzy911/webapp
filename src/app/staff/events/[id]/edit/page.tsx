import Link from 'next/link';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { Loading } from '@/components/Icon';
import { NoAccess } from '@/components/NoAccess';
import { requireStaff } from '@/lib/auth';
import { formValuesFromEvent, getEvent } from '@/lib/events';
import { EventForm } from '../../EventForm';

export const metadata = { title: 'Edit event' };

export default function EditEventPage({ params }: PageProps<'/staff/events/[id]/edit'>) {
  return (
    <Suspense fallback={<Loading />}>
      <EditEvent params={params} />
    </Suspense>
  );
}

async function EditEvent({ params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaff();
  if (staff.role !== 'organizer') return <NoAccess />;
  const ev = await getEvent((await params).id, new Date());
  if (!ev) notFound();
  return (
    <>
      <Link className="back-link" href={`/staff/events/${ev.id}/attendees`}>
        ← Back
      </Link>
      <div className="card form-card wide">
        <h1>Edit event</h1>
        <p className="meta">
          Ticket codes start with <span className="mono">{ev.code_prefix}-</span> · {ev.registered} registered · {ev.waitlisted} on waitlist
        </p>
        <EventForm eventId={ev.id} minCapacity={ev.registered} values={formValuesFromEvent(ev)} />
      </div>
    </>
  );
}
