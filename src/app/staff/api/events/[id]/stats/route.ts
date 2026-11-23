import { NextResponse } from 'next/server';
import { getCurrentStaff } from '@/lib/auth';
import { recentCheckins, stats } from '@/lib/checkin';
import { getEvent } from '@/lib/events';

/** Live counter for the check-in screen (polled every few seconds, so several door phones stay in sync). */
export async function GET(_request: Request, { params }: RouteContext<'/staff/api/events/[id]/stats'>) {
  const staff = await getCurrentStaff();
  if (!staff) return NextResponse.json({ error: 'Please sign in again.' }, { status: 401 });
  const ev = await getEvent((await params).id, new Date());
  if (!ev || ev.status === 'draft') return NextResponse.json({ error: 'Event not found.' }, { status: 404 });
  const [s, recent] = await Promise.all([stats(ev.id), recentCheckins(ev.id)]);
  return NextResponse.json({ stats: s, recent }, { headers: { 'Cache-Control': 'no-store' } });
}
