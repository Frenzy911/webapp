import 'server-only';
import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { env } from './env';

/**
 * Which tickets this browser has proven it may see (by registering, by code + email lookup, or
 * through an email link). Kept in a signed, httpOnly cookie, so nobody can add someone else's ticket.
 */
const COOKIE = 'tickets';
const MAX_TICKETS = 20;

function sign(payload: string): string {
  return crypto.createHmac('sha256', env.ticketSecret).update(`tickets:${payload}`).digest('base64url');
}

export async function rememberedTickets(): Promise<number[]> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return [];
  const [payload, mac] = raw.split('.');
  if (!payload || !mac) return [];
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return [];
  return payload.split('-').map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
}

export async function canViewTicket(registrationId: number): Promise<boolean> {
  return (await rememberedTickets()).includes(registrationId);
}

/** Call from a Server Action or Route Handler (cookies can't be set while rendering a page). */
export async function rememberTicket(registrationId: number): Promise<void> {
  const ids = (await rememberedTickets()).filter((id) => id !== registrationId);
  ids.push(registrationId);
  const payload = ids.slice(-MAX_TICKETS).join('-');
  (await cookies()).set(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.production,
    path: '/',
    maxAge: 60 * 60 * 24 * 60, // 60 days
  });
}
