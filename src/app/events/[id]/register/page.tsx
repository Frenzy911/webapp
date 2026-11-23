import Link from 'next/link';
import { Suspense } from 'react';
import { notFound, redirect } from 'next/navigation';
import { connection } from 'next/server';
import { Loading } from '@/components/Icon';
import { getEvent } from '@/lib/events';
import { RegisterForm } from './RegisterForm';

export const metadata = { title: 'Register' };

export default function RegisterPage({ params }: PageProps<'/events/[id]/register'>) {
  return (
    <div className="public-flow">
      <Suspense fallback={<Loading />}>
        <Register params={params} />
      </Suspense>
    </div>
  );
}

async function Register({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await connection();
  const ev = await getEvent(id, new Date());
  if (!ev || ev.status === 'draft') notFound();
  if (!ev.registrationOpen) redirect(`/events/${ev.id}`);

  return (
    <>
      <Link className="back-link" href={`/events/${ev.id}`}>
        ← Back to event
      </Link>
      <div className="card form-card">
        <p className="eyebrow">{ev.isFull ? 'Join the waitlist' : 'Register'}</p>
        <h1>{ev.title}</h1>
        <p className="meta">
          {ev.dateLabel} · {ev.timeLabel}
          <br />
          {ev.venue}
        </p>
        <RegisterForm eventId={ev.id} full={ev.isFull} />
      </div>
    </>
  );
}
