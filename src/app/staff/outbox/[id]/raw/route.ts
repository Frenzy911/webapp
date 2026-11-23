import { getCurrentStaff } from '@/lib/auth';
import { db } from '@/lib/supabase/admin';

/** The saved email body, shown inside a sandboxed iframe with its own strict Content-Security-Policy. */
export async function GET(_request: Request, { params }: RouteContext<'/staff/outbox/[id]/raw'>) {
  const staff = await getCurrentStaff();
  if (!staff || staff.role !== 'organizer') return new Response('Not allowed', { status: staff ? 403 : 401 });
  const id = Number((await params).id);
  const { data } = await db().from('email_outbox').select('html').eq('id', Number.isSafeInteger(id) ? id : 0).maybeSingle<{ html: string }>();
  if (!data) return new Response('Email not found', { status: 404 });
  return new Response(data.html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'",
      'X-Frame-Options': 'SAMEORIGIN',
      'Cache-Control': 'no-store',
    },
  });
}
