import { Suspense } from 'react';
import { Loading } from '@/components/Icon';
import { Outbox } from './Outbox';

export const metadata = { title: 'Emails' };

export default function OutboxPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Outbox selectedId={null} />
    </Suspense>
  );
}
