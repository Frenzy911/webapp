'use server';

import { assertStaff } from '@/lib/auth';
import { checkIn, recentCheckins, undoCheckIn, type CheckinResult, type RecentCheckin } from '@/lib/checkin';
import { AppError } from '@/lib/errors';
import { rateLimit, tooManyMessage } from '@/lib/rateLimit';
import type { Stats } from '@/lib/types';

// Called directly by the check-in screen (camera, typed code, USB scanner). They return data instead of
// redirecting, so the screen can show the result instantly. Both roles may use them.

export type CheckinResponse = { ok: true; result: CheckinResult; recent: RecentCheckin[] } | { ok: false; error: string; signedOut?: boolean };
export type UndoResponse = { ok: true; name: string; code: string; stats: Stats; recent: RecentCheckin[] } | { ok: false; error: string; signedOut?: boolean };

function failure(err: unknown): { ok: false; error: string; signedOut?: boolean } {
  if (err instanceof AppError) return { ok: false, error: err.message, signedOut: err.code === 'SIGNED_OUT' };
  console.error(err);
  return { ok: false, error: 'Something went wrong. Try again.' };
}

export async function checkInAction(eventId: number, code: string): Promise<CheckinResponse> {
  try {
    const staff = await assertStaff();
    const wait = await rateLimit('checkin', `staff:${staff.id}`);
    if (wait) return { ok: false, error: tooManyMessage(wait) };
    const result = await checkIn(eventId, String(code).slice(0, 64), staff, new Date());
    return { ok: true, result, recent: await recentCheckins(eventId) };
  } catch (err) {
    return failure(err);
  }
}

export async function undoCheckInAction(registrationId: number): Promise<UndoResponse> {
  try {
    const staff = await assertStaff();
    const out = await undoCheckIn(registrationId, staff, new Date());
    return { ok: true, name: out.registration.full_name, code: out.registration.ticket_code, stats: out.stats, recent: await recentCheckins(out.registration.event_id) };
  } catch (err) {
    return failure(err);
  }
}
