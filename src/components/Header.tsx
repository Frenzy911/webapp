import Link from 'next/link';
import { getCurrentStaff } from '@/lib/auth';
import { HeaderNav } from './HeaderNav';

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <path d="M8 8h6v6H8zM18 8h6v6h-6zM8 18h6v6H8zM19 19h2v2h-2zM22 22h2v2h-2zM18 22h2v2h-2zM22 18h2v2h-2z" fill="#fff" />
    </svg>
  );
}

/** Reads who is signed in (request-time), so it sits behind a Suspense boundary in the layout. */
export async function HeaderWithUser() {
  const staff = await getCurrentStaff();
  return <HeaderNav staff={staff ? { name: staff.name, role: staff.role } : null} />;
}

/** Shown for a moment while the signed-in check runs. */
export function HeaderFallback() {
  return (
    <header className="topbar public">
      <div className="wrap topbar-inner">
        <div className="brand-row">
          <Link className="brand" href="/">
            <BrandMark />
            <span>Cebu Events</span>
          </Link>
        </div>
        <nav className="nav" aria-label="Main" />
      </div>
    </header>
  );
}
