'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOutAction } from '@/app/staff/actions';
import type { StaffRole } from '@/lib/types';

const BRAND_PATH = 'M8 8h6v6H8zM18 8h6v6h-6zM8 18h6v6H8zM19 19h2v2h-2zM22 22h2v2h-2zM18 22h2v2h-2zM22 18h2v2h-2z';

const ORGANIZER_NAV: [string, string][] = [
  ['/staff/dashboard', 'Dashboard'],
  ['/staff/events', 'Events'],
  ['/staff/checkin', 'Check-in'],
  ['/staff/audit', 'Audit log'],
  ['/staff/users', 'Staff'],
  ['/staff/outbox', 'Emails'],
];
const DOOR_NAV: [string, string][] = [['/staff/checkin', 'Check-in']];
const PUBLIC_NAV: [string, string][] = [
  ['/', 'Events'],
  ['/tickets/find', 'Find my ticket'],
];

export function HeaderNav({ staff }: { staff: { name: string; role: StaffRole } | null }) {
  const path = usePathname();
  const inStaff = path.startsWith('/staff') && staff !== null;
  const nav = inStaff ? (staff.role === 'organizer' ? ORGANIZER_NAV : DOOR_NAV) : PUBLIC_NAV;
  const atCheckIn = path === '/staff/checkin' || path.endsWith('/checkin');

  const isActive = (href: string) =>
    href === '/'
      ? path === '/' || path.startsWith('/events/')
      : href === '/tickets/find'
        ? path.startsWith('/tickets/')
        : href === '/staff/checkin'
          ? atCheckIn
          : path.startsWith(href) && !atCheckIn;

  return (
    <header className={`topbar ${inStaff ? 'staff' : 'public'}`}>
      <div className="wrap topbar-inner">
        <div className="brand-row">
          <Link className="brand" href={inStaff ? '/staff' : '/'}>
            <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" rx="8" fill="currentColor" />
              <path d={BRAND_PATH} fill="#fff" />
            </svg>
            <span>
              Cebu Events{inStaff && <span className="brand-tag"> Staff</span>}
            </span>
          </Link>
          {inStaff && (
            <form action={signOutAction} className="signout">
              <span className="who">
                {staff.name} · {staff.role === 'organizer' ? 'Organizer' : 'Door staff'}
              </span>
              <button type="submit" className="btn btn-small btn-ghost">
                Sign out
              </button>
            </form>
          )}
        </div>
        <nav className="nav" aria-label="Main">
          {nav.map(([href, label]) => (
            <Link key={href} href={href} aria-current={isActive(href) ? 'page' : undefined}>
              {label}
            </Link>
          ))}
          {inStaff ? (
            <Link className="nav-staff" href="/">
              Public site
            </Link>
          ) : (
            <Link className="nav-staff" href="/staff">
              {staff ? 'Staff area' : 'Staff sign-in'}
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
