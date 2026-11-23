import { Suspense } from 'react';
import { Loading } from '@/components/Icon';
import { Outbox } from '../Outbox';

export const metadata = { title: 'Emails' };

export default function OutboxEmailPage({ params }: PageProps<'/staff/outbox/[id]'>) {
  return (
    <Suspense fallback={<Loading />}>
      <Selected params={params} />
    </Suspense>
  );
}

async function Selected({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  return <Outbox selectedId={Number.isSafeInteger(id) && id > 0 ? id : -1} />;
}
