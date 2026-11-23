// Check-in outcomes, undo, double scans and rate limits, against the real local database.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures, admin, NOW } from './support/fixtures';
import { checkIn, undoCheckIn, recentCheckins, stats } from '../src/lib/checkin';
import { register } from '../src/lib/registrations';
import { AppError } from '../src/lib/errors';
import type { Staff } from '../src/lib/types';

describe('check-in', () => {
  const f = fixtures();
  let door: Staff;
  let meetup: number;
  let other: number;
  before(async () => {
    door = await f.makeStaff('door');
    meetup = await f.makeEvent({ title: 'Cebu Dev Meetup 2026', capacity: 30 });
    other = await f.makeEvent({ title: 'Mobile Dev Workshop', capacity: 10 });
  });
  after(() => f.cleanup());

  it('checks in a valid ticket (green, with name), then warns "Already checked in" with the first time', async () => {
    const reg = await register(meetup, { full_name: 'Pedro Penduko', email: 'pedro@example.com', mobile: '09171234567' }, {}, NOW);
    const first = await checkIn(meetup, reg.ticket_code, door, NOW);
    assert.equal(first.result, 'checked_in');
    assert.equal(first.tone, 'success');
    assert.equal(first.title, 'Checked in');
    assert.equal(first.name, 'Pedro Penduko');
    assert.equal(first.message, 'Checked in at 12:00 PM.');
    assert.equal(new Date((await f.reg(reg.id)).checked_in_at!).getTime(), NOW.getTime());

    const later = new Date(NOW.getTime() + 15 * 60_000);
    const again = await checkIn(meetup, reg.ticket_code.toLowerCase(), door, later);
    assert.equal(again.result, 'already');
    assert.equal(again.tone, 'warning');
    assert.match(again.message, /^First checked in at 12:00 PM/);
    assert.equal(new Date((await f.reg(reg.id)).checked_in_at!).getTime(), NOW.getTime(), 'first time is kept');

    const recent = await recentCheckins(meetup);
    assert.equal(recent[0].name, 'Pedro Penduko');
    assert.equal(recent[0].by, 'Dario Door');
  });

  it('shows "Invalid ticket" for made-up codes, garbage, edited codes and codes from another event', async () => {
    const real = await f.addRegistration(other);
    for (const code of ['CDM-ABCDEFGH', 'hello world', 'CDM-000001', '']) {
      const r = await checkIn(meetup, code, door, NOW);
      assert.equal(r.result, 'invalid', code);
      assert.equal(r.title, 'Invalid ticket');
    }
    const wrongEvent = await checkIn(meetup, real.ticket_code, door, NOW);
    assert.equal(wrongEvent.result, 'invalid');
    assert.equal(wrongEvent.message, 'This ticket is for a different event.');
    assert.equal((await f.reg(real.id)).status, 'confirmed', 'not checked in anywhere');
  });

  it('refuses waitlisted and cancelled tickets, and confirmed tickets on another day', async () => {
    const wl = await f.addRegistration(meetup, { status: 'waitlisted' });
    const cancelled = await f.addRegistration(meetup, { status: 'cancelled' });
    const fine = await f.addRegistration(meetup);
    assert.equal((await checkIn(meetup, wl.ticket_code, door, NOW)).title, 'On waitlist — not confirmed');
    assert.equal((await checkIn(meetup, cancelled.ticket_code, door, NOW)).result, 'cancelled');
    const dayBefore = new Date(NOW.getTime() - 86_400_000);
    const early = await checkIn(meetup, fine.ticket_code, door, dayBefore);
    assert.equal(early.result, 'not_event_day');
    assert.equal(early.message, 'Check-in only works on the event day (Sat, Dec 5, 2026).');
    assert.equal((await f.reg(fine.id)).status, 'confirmed');
  });

  it('undo lets the ticket check in again, and records who and when', async () => {
    const r = await f.addRegistration(meetup, { name: 'Undo Me' });
    await checkIn(meetup, r.ticket_code, door, NOW);
    const out = await undoCheckIn(r.id, door, NOW);
    assert.equal(out.registration.status, 'confirmed');
    const row = await f.reg(r.id);
    assert.equal(row.checked_in_at, null);
    assert.equal(row.checkin_undone_by, door.id);
    const { data: log } = await admin.from('audit_logs').select('actor, details').eq('action', 'checkin_undone').eq('target_id', String(r.id)).single();
    assert.equal(log!.actor, 'Dario Door (Door staff)');
    assert.match(log!.details, /was checked in at 12:00 PM/);
    assert.equal((await checkIn(meetup, r.ticket_code, door, NOW)).result, 'checked_in');
    await assert.rejects(undoCheckIn(999999999, door, NOW), (e: unknown) => e instanceof AppError && e.code === 'NOT_FOUND');
  });

  it('when four devices check in the same ticket at once, only one says "Checked in"', async () => {
    const ev = await f.makeEvent({ title: 'Door Rush', capacity: 10 });
    const r = await f.addRegistration(ev, { name: 'Popular Person' });
    const results = await Promise.all([1, 2, 3, 4].map(() => checkIn(ev, r.ticket_code, door, NOW)));
    assert.equal(results.filter((x) => x.result === 'checked_in').length, 1);
    assert.equal(results.filter((x) => x.result === 'already').length, 3);
    const { count } = await admin.from('audit_logs').select('id', { count: 'exact', head: true }).eq('event_id', ev).eq('action', 'checked_in');
    assert.equal(count, 1);
    assert.deepEqual(await stats(ev), { checkedIn: 1, registered: 1 });
  });
});

describe('rate limits', () => {
  it('allows up to the limit in a window, then says how long to wait', async () => {
    const key = `test:${Math.random()}`;
    const results: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { data } = await admin.rpc('hit_rate_limit', { p_key: key, p_window_seconds: 60, p_max: 3 });
      results.push(data);
    }
    assert.deepEqual(results.slice(0, 3), [0, 0, 0]);
    assert.ok(results[3] > 0 && results[3] <= 60);
    await admin.from('rate_limits').delete().eq('key', key);
  });

  it('is not callable with the public key', async () => {
    const { createClient } = await import('@supabase/supabase-js');
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
    const { error } = await anon.rpc('hit_rate_limit', { p_key: 'x', p_window_seconds: 60, p_max: 3 });
    assert.ok(error, 'anon may not call functions');
    const read = await anon.from('registrations').select('email').limit(1);
    assert.ok(read.error || read.data?.length === 0, 'anon cannot read attendee data');
  });
});
