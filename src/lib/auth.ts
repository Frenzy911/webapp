import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { authClient } from './supabase/server';
import { getStaff } from './staff';
import { AppError } from './errors';
import type { Staff, StaffRole } from './types';

/**
 * The signed-in staff member, or null. Reads the Supabase Auth session cookie, verifies it,
 * then loads the staff profile. Deactivated accounts count as signed out.
 * Cached per request, so pages and components can call it freely.
 */
export const getCurrentStaff = cache(async (): Promise<Staff | null> => {
  // Who is signed in is only known per request (and checking the session reads the clock),
  // so never compute it while prerendering.
  await connection();
  const supabase = await authClient();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) return null;
  const staff = await getStaff(userId);
  return staff && staff.active ? staff : null;
});

/** For pages: the signed-in staff member, or a redirect to the sign-in page. */
export async function requireStaff(): Promise<Staff> {
  const staff = await getCurrentStaff();
  if (!staff) redirect('/staff/login');
  return staff;
}

/** For Server Actions and Route Handlers: never trust the page, check again here. */
export async function assertStaff(...roles: StaffRole[]): Promise<Staff> {
  const staff = await getCurrentStaff();
  if (!staff) throw new AppError('SIGNED_OUT', 'Please sign in again.', 401);
  if (roles.length && !roles.includes(staff.role)) throw new AppError('FORBIDDEN', 'Your account does not have access to this.', 403);
  return staff;
}

/** Only allow redirects back into the staff area (no open redirects). */
export function safeStaffPath(value: unknown, fallback = ''): string {
  const s = String(value || '');
  return /^\/staff(\/[\w\-./?=&%]*)?$/.test(s) && !s.includes('//') ? s : fallback;
}
