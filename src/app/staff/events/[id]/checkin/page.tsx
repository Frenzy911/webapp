import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { Loading } from '@/components/Icon';
import { requireStaff } from '@/lib/auth';
import { recentCheckins, stats } from '@/lib/checkin';
import { getEvent } from '@/lib/events';
import { CheckinScreen } from './CheckinScreen';

export const metadata = { title: 'Check-in' };

export default function CheckinPage({ params }: PageProps<'/staff/events/[id]/checkin'>) {
  return (
    <Suspense fallback={<Loading />}>
      <Checkin params={params} />
    </Suspense>
  );
}

async function Checkin({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff(); // both roles
  const ev = await getEvent((await params).id, new Date());
  if (!ev || ev.status === 'draft') notFound();
  const [initialStats, initialRecent] = await Promise.all([stats(ev.id), recentCheckins(ev.id)]);
  return (
    <CheckinScreen
      event={{ id: ev.id, title: ev.title, dateLabel: ev.dateLabel, timeLabel: ev.timeLabel, venue: ev.venue, isEventDay: ev.isEventDay }}
      initialStats={initialStats}
      initialRecent={initialRecent}
    />
  );
}
