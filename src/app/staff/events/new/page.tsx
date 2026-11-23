import Link from 'next/link';
import { Suspense } from 'react';
import { Loading } from '@/components/Icon';
import { NoAccess } from '@/components/NoAccess';
import { requireStaff } from '@/lib/auth';
import { addDays, manilaDateString } from '@/lib/time';
import { EventForm } from '../EventForm';

export const metadata = { title: 'New event' };

export default function NewEventPage() {
  return (
    <Suspense fallback={<Loading />}>
      <NewEvent />
    </Suspense>
  );
}

async function NewEvent() {
  const staff = await requireStaff();
  if (staff.role !== 'organizer') return <NoAccess />;
  const date = addDays(manilaDateString(new Date()), 7);
  return (
    <>
      <Link className="back-link" href="/staff/events">
        ← Back
      </Link>
      <div className="card form-card wide">
        <h1>New event</h1>
        <EventForm
          eventId={null}
          minCapacity={null}
          values={{ title: '', description: '', venue: '', date, startTime: '18:00', endTime: '21:00', capacity: '30', status: 'draft' }}
        />
      </div>
    </>
  );
}
