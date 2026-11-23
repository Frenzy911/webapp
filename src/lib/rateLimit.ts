import 'server-only';
import { headers } from 'next/headers';
import { db } from './supabase/admin';

/** Requests allowed per window. Counted in the database, so all serverless instances share them. */
export const LIMITS = {
  lookup: { windowSeconds: 60, max: 10 },
  register: { windowSeconds: 60, max: 10 },
  login: { windowSeconds: 15 * 60, max: 10 },
  checkin: { windowSeconds: 60, max: 120 },
} as const;

export async function clientIp(): Promise<string> {
  const h = await headers();
  // Vercel sets x-forwarded-for to the real client IP (first entry).
  const forwarded = h.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || h.get('x-real-ip') || 'local';
}

/**
 * Count one hit. Returns 0 if allowed, otherwise how many seconds to wait.
 * `key` defaults to the client IP.
 */
export async function rateLimit(name: keyof typeof LIMITS, key?: string): Promise<number> {
  const { windowSeconds, max } = LIMITS[name];
  const who = key ?? (await clientIp());
  const { data, error } = await db().rpc('hit_rate_limit', { p_key: `${name}:${who}`, p_window_seconds: windowSeconds, p_max: max });
  if (error) {
    console.error(`[rate-limit] ${error.message}`);
    return 0; // fail open: a database hiccup shouldn't lock everyone out
  }
  return Number(data) || 0;
}

export function tooManyMessage(retryAfter: number): string {
  return `Too many attempts. Please wait about ${retryAfter} seconds and try again.`;
}
