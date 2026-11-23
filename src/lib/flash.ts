import 'server-only';
import { cookies } from 'next/headers';

export type Flash = { id: string; type: 'success' | 'error'; message: string };

const COOKIE = 'flash';

/**
 * A one-time message shown on the next page ("Event saved.", "Cancelled Maria Santos.").
 * Set it in a Server Action right before redirect(); <FlashMessage> shows it and clears it.
 */
export async function setFlash(type: Flash['type'], message: string): Promise<void> {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  (await cookies()).set(COOKIE, encodeURIComponent(JSON.stringify({ id, type, message })), {
    path: '/',
    sameSite: 'lax',
    maxAge: 30,
    httpOnly: false, // the page clears it from the browser once it has been shown
  });
}

export async function readFlash(): Promise<Flash | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  try {
    const f = JSON.parse(decodeURIComponent(raw));
    if ((f.type === 'success' || f.type === 'error') && typeof f.message === 'string') {
      return { id: String(f.id || ''), type: f.type, message: f.message.slice(0, 500) };
    }
  } catch {
    /* ignore a malformed cookie */
  }
  return null;
}
