import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { Loading } from '@/components/Icon';
import { getCurrentStaff, safeStaffPath } from '@/lib/auth';
import { LoginForm } from './LoginForm';

export const metadata = { title: 'Staff sign-in' };

export default function LoginPage({ searchParams }: PageProps<'/staff/login'>) {
  return (
    <div className="card form-card narrow">
      <p className="eyebrow">Staff only</p>
      <h1>Sign in</h1>
      <Suspense fallback={<Loading label="" />}>
        <Login searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Login({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const next = safeStaffPath((await searchParams).next, '');
  if (await getCurrentStaff()) redirect(next || '/staff');
  return (
    <>
      {next && <p className="muted">Please sign in to continue.</p>}
      <LoginForm next={next} />
    </>
  );
}
