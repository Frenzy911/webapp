'use server';

import { redirect } from 'next/navigation';
import { AppError } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import { rateLimit, tooManyMessage } from '@/lib/rateLimit';
import { cancelRegistration, getRegistrationByCode, lookupTicket } from '@/lib/registrations';
import { canViewTicket, rememberTicket } from '@/lib/ticketAccess';

export type FindState = { values: { code: string; contact: string }; notFound: boolean; error: string | null };

/** Find my ticket: code AND email/mobile must match. Any mismatch gives the same "not found". */
export async function findTicketAction(_prev: FindState, formData: FormData): Promise<FindState> {
  const code = String(formData.get('code') || '').trim().slice(0, 32);
  const contact = String(formData.get('contact') || '').trim().slice(0, 254);
  const values = { code, contact };

  const wait = await rateLimit('lookup');
  if (wait) return { values, notFound: false, error: tooManyMessage(wait) };

  const reg = await lookupTicket(code, contact);
  if (!reg) return { values, notFound: true, error: null };
  await rememberTicket(reg.id);
  redirect(`/tickets/${reg.ticket_code}`);
}

/** The attendee cancels their own registration (only from a browser that may see the ticket). */
export async function cancelOwnTicketAction(code: string): Promise<void> {
  const reg = await getRegistrationByCode(code);
  if (!reg || !(await canViewTicket(reg.id))) redirect('/tickets/find');
  try {
    await cancelRegistration(reg, null, new Date());
    await setFlash('success', 'Your registration is cancelled. Thanks for letting us know — your spot is now free for someone else.');
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    await setFlash('error', err.message);
  }
  redirect(`/tickets/${reg.ticket_code}`);
}
