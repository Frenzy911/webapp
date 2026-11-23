import crypto from 'node:crypto';

// Crockford base32: no I, L, O or U, so codes are easy to read aloud and type.
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_LENGTH = 8; // 8 chars x 5 bits = 40 random bits (~1.1 trillion codes per prefix)

/** 8 characters from a cryptographically secure RNG. 256 % 32 === 0, so there is no bias. */
function randomPart(length = RANDOM_LENGTH): string {
  let out = '';
  for (const b of crypto.randomBytes(length)) out += ALPHABET[b & 31];
  return out;
}

/** "Cebu Dev Meetup 2026" -> "CDM" */
export function prefixFromTitle(title: string): string {
  const words = String(title || '').match(/[A-Za-z]+/g) || [];
  let prefix = words.map((w) => w[0]).join('').toUpperCase().slice(0, 4);
  if (prefix.length < 2) prefix = (prefix + 'EVT').slice(0, 3);
  return prefix;
}

export function generateTicketCode(prefix: string): string {
  return `${prefix}-${randomPart()}`;
}

/**
 * Turn whatever was typed or scanned into the canonical code, or null if it can't be one.
 * "cdm 7k3p-9qxm" -> "CDM-7K3P9QXM". In the random part, O is read as 0 and I/L as 1.
 */
export function normalizeTicketCode(raw: unknown): string | null {
  const s = String(raw || '').toUpperCase().replace(/[\s-]+/g, (m) => (m.includes('-') ? '-' : ''));
  if (s.length > 32) return null;
  const match = s.match(/^([A-Z]{1,4})-?([0-9A-Z-]{8,10})$/);
  if (!match) return null;
  const body = match[2].replace(/-/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (body.length !== RANDOM_LENGTH || /[^0-9A-HJKMNP-TV-Z]/.test(body)) return null;
  return `${match[1]}-${body}`;
}

/** Signed token that lets an email link open a ticket page without typing the email again. */
export function ticketAccessToken(secret: string, ticketCode: string): string {
  return crypto.createHmac('sha256', secret).update(`ticket-view:${ticketCode}`).digest('base64url').slice(0, 32);
}

export function verifyTicketAccessToken(secret: string, ticketCode: string, token: unknown): boolean {
  if (typeof token !== 'string' || token.length !== 32) return false;
  const expected = Buffer.from(ticketAccessToken(secret, ticketCode));
  const given = Buffer.from(token);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
