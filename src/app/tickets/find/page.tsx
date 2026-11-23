import { Suspense } from 'react';
import { Icon, Loading } from '@/components/Icon';
import { FindTicketForm } from './FindTicketForm';

export const metadata = { title: 'Find my ticket' };

export default function FindTicketPage({ searchParams }: PageProps<'/tickets/find'>) {
  return (
    <div className="card form-card">
      <div className="form-symbol" aria-hidden="true">
        <Icon name="ticket" />
      </div>
      <h1>Find my ticket</h1>
      <p className="lead">Enter your ticket code and the email or mobile number you registered with.</p>
      <Suspense fallback={<Loading label="" />}>
        <FormWithCode searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function FormWithCode({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { code } = await searchParams;
  return <FindTicketForm code={String(code || '').slice(0, 32)} />;
}
