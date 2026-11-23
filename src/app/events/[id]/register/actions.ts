'use server';

import { redirect } from 'next/navigation';
import { AppError, ValidationError } from '@/lib/errors';
import { getEvent } from '@/lib/events';
import { setFlash } from '@/lib/flash';
import { queueTicketEmail } from '@/lib/mailer';
import { rateLimit, tooManyMessage } from '@/lib/rateLimit';
import { register, waitlistPosition } from '@/lib/registrations';
import { rememberTicket } from '@/lib/ticketAccess';
import type { Registration } from '@/lib/types';

export type RegisterState = {
  values: { full_name: string; email: string; mobile: string };
  errors: Record<string, string>;
  formError: string | null;
  duplicate: boolean;
  waitlist: boolean;
};

export async function registerAction(eventId: number, prev: RegisterState, formData: FormData): Promise<RegisterState> {
  const now = new Date();
  const values = {
    full_name: String(formData.get('full_name') || '').slice(0, 200),
    email: String(formData.get('email') || '').slice(0, 300),
    mobile: String(formData.get('mobile') || '').slice(0, 30),
  };
  const joinWaitlist = formData.get('waitlist') === '1';
  const base = { values, errors: {}, formError: null, duplicate: false, waitlist: joinWaitlist };

  const wait = await rateLimit('register');
  if (wait) return { ...base, formError: tooManyMessage(wait) };

  let reg: Registration;
  try {
    reg = await register(eventId, values, { joinWaitlist }, now);
  } catch (err) {
    if (err instanceof ValidationError) return { ...base, errors: err.errors };
    if (err instanceof AppError) {
      if (err.code === 'FULL') {
        return { ...base, formError: 'Sorry, the last spot was just taken. You can join the waitlist below with the same details.', waitlist: true };
      }
      if (err.code === 'DUPLICATE') return { ...base, formError: err.message, duplicate: true };
      if (err.code === 'ENDED' || err.code === 'CLOSED') {
        await setFlash('error', err.message);
        redirect(`/events/${eventId}`);
      }
      if (err.code === 'NOT_FOUND') redirect('/');
    }
    throw err;
  }

  // This browser may now see the ticket. The email goes out after the response, so it never slows this down.
  await rememberTicket(reg.id);
  const ev = (await getEvent(eventId, now))!;
  if (reg.status === 'waitlisted') queueTicketEmail('waitlist', reg, ev, { waitlistPosition: await waitlistPosition(reg) });
  else queueTicketEmail('registration', reg, ev);
  redirect(`/tickets/${reg.ticket_code}?new=1`);
}
