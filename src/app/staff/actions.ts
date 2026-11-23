'use server';

import { redirect } from 'next/navigation';
import { assertStaff, safeStaffPath } from '@/lib/auth';
import { undoCheckIn } from '@/lib/checkin';
import { AppError, ValidationError } from '@/lib/errors';
import { getEvent, saveEvent, setEventStatus } from '@/lib/events';
import { setFlash } from '@/lib/flash';
import { queueTicketEmail } from '@/lib/mailer';
import { rateLimit, tooManyMessage } from '@/lib/rateLimit';
import { cancelRegistration, getRegistration, promoteNext } from '@/lib/registrations';
import { createStaff, getStaff, setStaffActive } from '@/lib/staff';
import { authClient } from '@/lib/supabase/server';
import type { EventFormValues } from '@/lib/validation';

// Every action checks the signed-in staff member and role again: pages can be skipped, actions can't.

/** Run a staff action, then go back with a one-time message (errors the user can fix become an error message). */
async function andBack(back: string, run: () => Promise<string>): Promise<never> {
  try {
    await setFlash('success', await run());
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.code === 'SIGNED_OUT') redirect('/staff/login');
    await setFlash('error', err.message);
  }
  redirect(back);
}

// ------------------------------------------------------------------ sign in / out

export type SignInState = { email: string; error: string | null };

export async function signInAction(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get('email') || '').trim().toLowerCase().slice(0, 254);
  const password = String(formData.get('password') || '').slice(0, 200);
  const next = safeStaffPath(formData.get('next'), '/staff');

  const wait = await rateLimit('login');
  if (wait) return { email, error: tooManyMessage(wait) };

  const supabase = await authClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  const profile = data.user ? await getStaff(data.user.id) : null;
  if (error || !profile || !profile.active) {
    if (data.user) await supabase.auth.signOut();
    return { email, error: 'Wrong email or password.' };
  }
  redirect(next === '/staff' ? (profile.role === 'organizer' ? '/staff/dashboard' : '/staff/checkin') : next);
}

export async function signOutAction(): Promise<void> {
  const supabase = await authClient();
  await supabase.auth.signOut();
  redirect('/staff/login');
}

// ------------------------------------------------------------------ check-in (both roles)

export async function undoCheckInAndBackAction(registrationId: number, back: string): Promise<void> {
  const target = safeStaffPath(back, '/staff/checkin');
  await andBack(target, async () => {
    const staff = await assertStaff();
    const out = await undoCheckIn(registrationId, staff, new Date());
    return `Check-in undone for ${out.registration.full_name} (${out.registration.ticket_code}). They can be checked in again.`;
  });
}

// ------------------------------------------------------------------ events (organizers)

export type EventFormState = { values: EventFormValues; errors: Record<string, string> };

function eventValues(formData: FormData): EventFormValues {
  const get = (k: string) => String(formData.get(k) || '');
  return {
    title: get('title'),
    description: get('description'),
    venue: get('venue'),
    date: get('date'),
    startTime: get('start_time'),
    endTime: get('end_time'),
    capacity: get('capacity'),
    status: get('status'),
  };
}

export async function saveEventAction(eventId: number | null, _prev: EventFormState, formData: FormData): Promise<EventFormState> {
  const staff = await assertStaff('organizer');
  const values = eventValues(formData);
  let id: number;
  try {
    id = await saveEvent(eventId, Object.fromEntries(formData), staff, new Date());
  } catch (err) {
    if (err instanceof ValidationError) return { values, errors: err.errors };
    throw err;
  }
  await setFlash('success', eventId ? 'Event saved.' : 'Event created.');
  redirect(`/staff/events/${id}/attendees`);
}

export async function setEventStatusAction(eventId: number, status: 'published' | 'closed', back: string): Promise<void> {
  await andBack(safeStaffPath(back, '/staff/events'), async () => {
    const staff = await assertStaff('organizer');
    const ev = await setEventStatus(eventId, status, staff, new Date());
    return `"${ev.title}" is now ${status === 'published' ? 'published' : 'closed'}.`;
  });
}

// ------------------------------------------------------------------ attendees (organizers)

export async function promoteNextAction(eventId: number): Promise<void> {
  await andBack(`/staff/events/${eventId}/attendees`, async () => {
    const staff = await assertStaff('organizer');
    const now = new Date();
    const reg = await promoteNext(eventId, staff, now);
    queueTicketEmail('promotion', reg, (await getEvent(eventId, now))!);
    return `${reg.full_name} (${reg.ticket_code}) moved from the waitlist to confirmed. A confirmation email is on its way.`;
  });
}

export async function cancelRegistrationAction(registrationId: number, back: string): Promise<void> {
  await andBack(safeStaffPath(back, '/staff/dashboard'), async () => {
    const staff = await assertStaff('organizer');
    const reg = await getRegistration(registrationId);
    if (!reg) throw new AppError('NOT_FOUND', 'Registration not found.', 404);
    await cancelRegistration(reg, staff, new Date());
    return `Cancelled ${reg.full_name} (${reg.ticket_code}).`;
  });
}

// ------------------------------------------------------------------ staff accounts (organizers)

export type StaffFormState = { values: { name: string; email: string; role: string }; errors: Record<string, string>; created: string | null };

export async function createStaffAction(_prev: StaffFormState, formData: FormData): Promise<StaffFormState> {
  const actor = await assertStaff('organizer');
  const values = { name: String(formData.get('name') || ''), email: String(formData.get('email') || ''), role: String(formData.get('role') || 'door') };
  try {
    const created = await createStaff(Object.fromEntries(formData), actor, new Date());
    await setFlash('success', `Account for ${created.email} created. They can sign in now.`);
  } catch (err) {
    if (err instanceof ValidationError) return { values, errors: err.errors, created: null };
    throw err;
  }
  redirect('/staff/users');
}

export async function setStaffActiveAction(userId: string, active: boolean): Promise<void> {
  await andBack('/staff/users', async () => {
    const actor = await assertStaff('organizer');
    await setStaffActive(userId, active, actor, new Date());
    return active ? 'Account reactivated.' : 'Account deactivated. They are signed out on their next click.';
  });
}
