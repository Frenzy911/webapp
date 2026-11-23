import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { getRegistrationByCode } from '@/lib/registrations';
import { rememberTicket } from '@/lib/ticketAccess';
import { verifyTicketAccessToken } from '@/lib/tickets';

/**
 * Email links: /tickets/CDM-7K3P9QXM/open?t=<signed token>. A valid token lets this browser see the
 * ticket from now on; then we redirect to the clean ticket URL (so the token isn't left in the address bar).
 */
export async function GET(request: NextRequest, { params }: RouteContext<'/tickets/[code]/open'>) {
  const { code } = await params;
  const token = request.nextUrl.searchParams.get('t');
  const reg = await getRegistrationByCode(code);
  if (reg && verifyTicketAccessToken(env.ticketSecret, reg.ticket_code, token)) {
    await rememberTicket(reg.id);
    return NextResponse.redirect(new URL(`/tickets/${reg.ticket_code}`, request.url), 303);
  }
  return NextResponse.redirect(new URL(`/tickets/find?code=${encodeURIComponent(code.slice(0, 32))}`, request.url), 303);
}
