// Registration, waitlist, cancel, promote and event rules, run against the real local database.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures, admin, NOW } from './support/fixtures';
import { register, lookupTicket, cancelRegistration, promoteNext, listRegistrations, waitlistPosition, getRegistrationByCode } from '../src/lib/registrations';
import { getEvent, saveEvent, setEventStatus, listPublicEvents } from '../src/lib/events';
import { AppError, ValidationError } from '../src/lib/errors';
import type { Staff } from '../src/lib/types';

const person = (n: number | string, extra = {}) => ({ full_name: `Racer ${n}`, email: `racer${n}@example.com`, mobile: '09171234567', ...extra });

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof AppError, `expected AppError ${code}, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });
}

describe('registration', () => {
  const f = fixtures();
  let meetup: number;
  let other: number;
  before(async () => {
    meetup = await f.makeEvent({ title: 'Cebu Dev Meetup 2026', capacity: 30 });
    other = await f.makeEvent({ title: 'Mobile Dev Workshop', capacity: 10 });
  });
  after(() => f.cleanup());

  it('confirms a valid registration with a secure ticket code and normalised details', async () => {
    const reg = await register(meetup, { full_name: 'Juan  Dela Cruz', email: 'Juan@Example.com', mobile: '0917 123 4567' }, {}, NOW);
    assert.equal(reg.status, 'confirmed');
    assert.match(reg.ticket_code, /^CDM-[0-9A-HJKMNP-TV-Z]{8}$/);
    assert.equal(reg.full_name, 'Juan Dela Cruz');
    assert.equal(reg.email, 'juan@example.com');
    assert.equal(reg.mobile, '09171234567');
    const ev = await getEvent(meetup, NOW);
    assert.equal(ev!.spotsLeft, 29);
  });

  it('blocks the same email twice for one event (any letter case), but not for another event', async () => {
    await register(meetup, person('twice', { email: 'twice@example.com' }), {}, NOW);
    await rejectsWith(register(meetup, person('twice', { email: 'TWICE@example.com' }), {}, NOW), 'DUPLICATE');
    assert.ok(await register(other, person('twice', { email: 'twice@example.com' }), {}, NOW));
  });

  it('lets a cancelled email register again', async () => {
    const first = await register(meetup, person('again'), {}, NOW);
    await cancelRegistration(first, null, NOW);
    const second = await register(meetup, person('again'), {}, NOW);
    assert.notEqual(second.ticket_code, first.ticket_code);
  });

  it('rejects bad input with a message per field and saves nothing', async () => {
    const before = await f.count(meetup, ['confirmed', 'waitlisted', 'cancelled', 'checked_in']);
    await assert.rejects(register(meetup, { full_name: '', email: 'not-an-email', mobile: '0917123456' }, {}, NOW), (err: unknown) => {
      assert.ok(err instanceof ValidationError);
      assert.deepEqual(Object.keys(err.errors).sort(), ['email', 'full_name', 'mobile']);
      return true;
    });
    assert.equal(await f.count(meetup, ['confirmed', 'waitlisted', 'cancelled', 'checked_in']), before);
  });

  it('finds a ticket only with the right code AND email or mobile', async () => {
    const reg = await register(meetup, { full_name: 'Maria Santos', email: 'maria@example.com', mobile: '09181234567' }, {}, NOW);
    assert.equal((await lookupTicket(reg.ticket_code.toLowerCase(), 'MARIA@example.com'))?.id, reg.id);
    assert.equal((await lookupTicket(reg.ticket_code, '0918 123 4567'))?.id, reg.id);
    assert.equal(await lookupTicket(reg.ticket_code, 'someone.else@example.com'), null);
    assert.equal(await lookupTicket('CDM-ZZZZZZZZ', 'maria@example.com'), null);
    assert.equal(await lookupTicket(reg.ticket_code, ''), null);
  });

  it('refuses draft, closed and ended events', async () => {
    const draft = await f.makeEvent({ title: 'Secret Draft', status: 'draft' });
    const closed = await f.makeEvent({ title: 'Closed One', status: 'closed' });
    const ended = await f.makeEvent({ title: 'Morning Only', start: '08:00', end: '10:00' });
    await rejectsWith(register(draft, person('d'), {}, NOW), 'NOT_FOUND');
    await rejectsWith(register(closed, person('c'), {}, NOW), 'CLOSED');
    await rejectsWith(register(ended, person('e'), {}, NOW), 'ENDED');
    const listed = (await listPublicEvents(NOW)).map((e) => e.id);
    assert.ok(!listed.includes(draft) && !listed.includes(closed) && !listed.includes(ended));
  });
});

describe('capacity, waitlist, cancel and promote', () => {
  const f = fixtures();
  let organizer: Staff;
  before(async () => {
    organizer = await f.makeStaff('organizer');
  });
  after(() => f.cleanup());

  it('a full event refuses registration unless joining the waitlist, which shows the position', async () => {
    const ev = await f.makeEvent({ title: 'Tiny Meetup', capacity: 2 });
    await register(ev, person('a'), {}, NOW);
    await register(ev, person('b'), {}, NOW);
    assert.ok((await getEvent(ev, NOW))!.isFull);
    await rejectsWith(register(ev, person('c'), {}, NOW), 'FULL');
    const w1 = await register(ev, person('w1'), { joinWaitlist: true }, NOW);
    const w2 = await register(ev, person('w2'), { joinWaitlist: true }, NOW);
    assert.equal(w1.status, 'waitlisted');
    assert.equal(await waitlistPosition(w1), 1);
    assert.equal(await waitlistPosition(w2), 2);
    await rejectsWith(register(ev, person('w1'), { joinWaitlist: true }, NOW), 'DUPLICATE');
  });

  it('cancelling frees a spot; promotion moves #1 off the waitlist; no spot means no promotion', async () => {
    const ev = await f.makeEvent({ title: 'Promo Night', capacity: 1 });
    const a = await register(ev, person('pa'), {}, NOW);
    const w1 = await register(ev, person('pw1'), { joinWaitlist: true }, NOW);
    const w2 = await register(ev, person('pw2'), { joinWaitlist: true }, NOW);
    await rejectsWith(promoteNext(ev, organizer, NOW), 'NO_SPOT');

    await cancelRegistration(a, null, NOW);
    assert.equal((await getEvent(ev, NOW))!.spotsLeft, 1);
    const promoted = await promoteNext(ev, organizer, NOW);
    assert.equal(promoted.id, w1.id);
    assert.equal(promoted.status, 'confirmed');
    assert.equal(promoted.promoted_by, organizer.id);
    assert.equal((await f.reg(w2.id)).status, 'waitlisted', 'only the first in line');
    await rejectsWith(promoteNext(ev, organizer, NOW), 'NO_SPOT');

    const { data: log } = await admin.from('audit_logs').select('action, actor').eq('event_id', ev).order('id');
    assert.deepEqual(log!.map((l) => l.action), ['registration_cancelled', 'waitlist_promoted']);
    assert.equal(log![0].actor, 'Attendee (racerpa@example.com)');
    assert.equal(log![1].actor, 'Olivia Organizer (Organizer)');
  });

  it('a checked-in registration cannot be cancelled', async () => {
    const ev = await f.makeEvent({ title: 'No Take Backs' });
    const r = await f.addRegistration(ev, { status: 'checked_in' });
    await rejectsWith(cancelRegistration(r, organizer, NOW), 'CHECKED_IN');
    await rejectsWith(cancelRegistration(await f.addRegistration(ev, { status: 'cancelled' }), null, NOW), 'ALREADY_CANCELLED');
  });

  it('when many people register for the last spot at once, exactly one gets it', async () => {
    const ev = await f.makeEvent({ title: 'Last Spot', capacity: 3 });
    await f.addRegistration(ev);
    await f.addRegistration(ev);
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => register(ev, person(`last${i}`), {}, NOW)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(failed.length, 11);
    assert.ok(failed.every((r) => r.reason instanceof AppError && r.reason.code === 'FULL'));
    assert.equal(await f.count(ev, ['confirmed', 'checked_in']), 3);
  });

  it('the database itself refuses to go over capacity, even when the app is bypassed', async () => {
    const ev = await f.makeEvent({ title: 'Trigger Guard', capacity: 1 });
    await f.addRegistration(ev);
    await assert.rejects(f.addRegistration(ev), /EVENT_FULL/);
    const wl = await f.addRegistration(ev, { status: 'waitlisted' });
    const upd = await admin.from('registrations').update({ status: 'confirmed' }).eq('id', wl.id);
    assert.match(upd.error!.message, /EVENT_FULL/);
    const shrink = await admin.from('events').update({ capacity: 0 }).eq('id', ev);
    assert.ok(shrink.error, 'capacity 0 is refused');
  });
});

describe('event management rules', () => {
  const f = fixtures();
  let organizer: Staff;
  before(async () => {
    organizer = await f.makeStaff('organizer');
  });
  after(() => f.cleanup());

  const form = (over = {}) => ({ title: 'Flutter Cebu Workshop', description: 'Build your first app.', venue: 'Cebu IT Park', date: '2026-12-12', start_time: '13:00', end_time: '17:00', capacity: '20', status: 'draft', ...over });

  it('creates an event in Cebu time with a ticket prefix, and logs it', async () => {
    const id = f.track(await saveEvent(null, form(), organizer, NOW));
    const ev = (await getEvent(id, NOW))!;
    assert.equal(ev.status, 'draft');
    assert.equal(new Date(ev.starts_at).toISOString(), '2026-12-12T05:00:00.000Z');
    assert.equal(ev.code_prefix, 'FCW');
    assert.equal(ev.timeLabel, '1:00 PM – 5:00 PM');
    const { data: log } = await admin.from('audit_logs').select('actor, details').eq('event_id', id).single();
    assert.equal(log!.details, 'Created "Flutter Cebu Workshop" (draft, capacity 20)');
  });

  it('blocks lowering capacity below the number registered, with the count in the message', async () => {
    const id = await f.makeEvent({ title: 'Capacity Test', capacity: 5 });
    for (let i = 0; i < 3; i += 1) await f.addRegistration(id);
    await f.addRegistration(id, { status: 'waitlisted' }); // waitlisted people don't count
    await assert.rejects(saveEvent(id, form({ title: 'Capacity Test', date: '2026-12-05', capacity: '2', status: 'published' }), organizer, NOW), (err: unknown) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.errors.capacity, /lower than the 3 people already registered/);
      return true;
    });
    assert.equal((await getEvent(id, NOW))!.capacity, 5);
    await saveEvent(id, form({ title: 'Capacity Test', venue: 'Hall B', date: '2026-12-05', capacity: '3', status: 'published' }), organizer, NOW);
    assert.equal((await getEvent(id, NOW))!.capacity, 3);
    const { data: log } = await admin.from('audit_logs').select('details').eq('event_id', id).eq('action', 'event_updated').single();
    assert.match(log!.details, /venue: Ayala Center Cebu, Function Room 2 → Hall B/);
    assert.match(log!.details, /capacity: 5 → 3/);
  });

  it('an event with registrations cannot go back to Draft; publish and close work', async () => {
    const id = await f.makeEvent({ title: 'Has People' });
    await f.addRegistration(id);
    await assert.rejects(saveEvent(id, form({ title: 'Has People', date: '2026-12-05', status: 'draft' }), organizer, NOW), ValidationError);
    await setEventStatus(id, 'closed', organizer, NOW);
    assert.equal((await getEvent(id, NOW))!.status, 'closed');
  });

  it('searches attendees by name, email or code, treating % and _ literally', async () => {
    const id = await f.makeEvent({ title: 'Search Me', capacity: 10 });
    const pedro = await f.addRegistration(id, { name: 'Pedro Penduko', email: 'pedro@example.com' });
    await f.addRegistration(id, { name: 'Maria Santos', email: 'maria_s@example.com' });
    await f.addRegistration(id, { name: 'Wait Lister', status: 'waitlisted' });
    assert.deepEqual((await listRegistrations(id, { q: 'pedro' })).map((r) => r.id), [pedro.id]);
    assert.equal((await listRegistrations(id, { q: pedro.ticket_code.slice(-5) }))[0].id, pedro.id);
    assert.equal((await listRegistrations(id, { q: '%' })).length, 0);
    assert.equal((await listRegistrations(id, { q: 'maria_s' })).length, 1);
    const wl = await listRegistrations(id, { status: 'waitlisted' });
    assert.equal(wl.length, 1);
    assert.equal(wl[0].waitlist_position, 1);
    assert.equal((await getRegistrationByCode(pedro.ticket_code.toLowerCase()))?.id, pedro.id);
  });
});
