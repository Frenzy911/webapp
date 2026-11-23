import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { Loading } from '@/components/Icon';
import { requireStaff } from '@/lib/auth';

export default function StaffHome() {
  return (
    <Suspense fallback={<Loading />}>
      <ToRoleHome />
    </Suspense>
  );
}

async function ToRoleHome(): Promise<never> {
  const staff = await requireStaff();
  redirect(staff.role === 'organizer' ? '/staff/dashboard' : '/staff/checkin');
}
