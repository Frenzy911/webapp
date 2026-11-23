'use strict';

// Level 2 acceptance checks: event management, waitlist, cancel, dashboard, CSV, undo.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./support/harness');

const eventForm = (over = {}) => ({
  title: 'Flutter Cebu Workshop',
  description: 'Build your first app.',
  venue: 'Cebu IT Park',
  date: '2026-12-12',
  start_time: '13:00',
  end_time: '17:00',
  capacity: '20',
  status: 'draft',
  ...over,
});

describe('Level 2 · event management', () => {
  let t;
  let org;
  before(async () => {
    t = await startApp();
    org = await t.staffClient('organizer');
  });
  after(() => t.close());

  it('a Draft event is hidden from attendees; publishing it makes it appear', async () => {
    const res = await org.post('/staff/events', eventForm());
    assert.equal(res.status, 303);
    const id = Number(res.location.match(/\/staff\/events\/(\d+)\//)[1]);
    const ev = t.db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    assert.equal(ev.status, 'draft');
    assert.equal(ev.starts_at, '2026-12-12T13:00:00+08:00');
    assert.equal(ev.code_prefix, 'FCW');

    const visitor = t.client();
    assert.ok(!(await visitor.get('/')).text.includes('Flutter Cebu Workshop'));
    assert.equal((await visitor.get(`/events/${id}`)).status, 404);
    assert.equal((await visitor.register(id, { email: 'early@example.com' })).status, 404);

    const pub = await org.post(`/staff/events/${id}/status`, { status: 'published' });
    assert.equal(pub.status, 303);
    assert.match((await visitor.get('/')).text, /Flutter Cebu Workshop/);
    assert.equal((await visitor.get(`/events/${id}`)).status, 200);
  });

  it('blocks saving an event whose end time is before its start time', async () => {
    const res = await org.post('/staff/events', eventForm({ title: 'Backwards', start_time: '18:00', end_time: '09:00' }));
    assert.equal(res.status, 422);
    assert.match(res.text, /End time must be after the start time/);
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM events WHERE title = 'Backwards'").get().n, 0);
    const zero = await org.post('/staff/events', eventForm({ title: 'Zero', capacity: '0' }));
    assert.equal(zero.status, 422);
    assert.match(zero.text, /Capacity must be a whole number, at least 1/);
  });

  it('blocks lowering capacity below the number already registered, with a message', async () => {
    const id = t.makeEvent({ title: 'Capacity Test', capacity: 5 });
    for (let i = 0; i < 3; i += 1) t.addRegistration(id);
    t.addRegistration(id, { status: 'waitlisted' }); // waitlisted people don't count
    const res = await org.post(`/staff/events/${id}`, eventForm({ title: 'Capacity Test', date: '2026-12-05', capacity: '2', status: 'published' }));
    assert.equal(res.status, 422);
    assert.match(res.text, /can(&#39;|')t be lower than the 3 people already registered/);
    assert.equal(t.db.prepare('SELECT capacity FROM events WHERE id = ?').get(id).capacity, 5);
    const ok = await org.post(`/staff/events/${id}`, eventForm({ title: 'Capacity Test', date: '2026-12-05', capacity: '3', status: 'published' }));
    assert.equal(ok.status, 303);
    assert.equal(t.db.prepare('SELECT capacity FROM events WHERE id = ?').get(id).capacity, 3);
  });

  it('closed events stop accepting registrations', async () => {
    const id = t.makeEvent({ title: 'Soon Closed', capacity: 5 });
    await org.post(`/staff/events/${id}/status`, { status: 'closed' });
    const res = await t.client().register(id, { email: 'late@example.com' });
    assert.equal(res.status, 303);
    assert.equal(res.location, `/events/${id}`);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?').get(id).n, 0);
    assert.ok(!(await t.client().get('/')).text.includes('Soon Closed'), 'closed events are not listed');
  });
});

describe('Level 2 · waitlist, cancel, promote, undo', () => {
  let t;
  let ev;
  let door;
  let org;
  const codes = {};
  before(async () => {
    t = await startApp();
    ev = t.makeEvent({ title: 'Tiny Meetup', capacity: 2 });
    door = await t.staffClient('door');
    org = await t.staffClient('organizer');
  });
  after(() => t.close());

  it('fills the event, then joins the waitlist and shows the position', async () => {
    codes.a = (await t.client().register(ev, { name: 'Attendee A', email: 'a@example.com' })).code;
    codes.b = (await t.client().register(ev, { name: 'Attendee B', email: 'b@example.com' })).code;
    const page = await t.client().get(`/events/${ev}`);
    assert.match(page.text, /Join the waitlist/);

    const c = t.client();
    const w1 = await c.register(ev, { name: 'Waiter One', email: 'w1@example.com', waitlist: true });
    assert.equal(w1.status, 303);
    codes.w1 = w1.code;
    const ticket = await c.get(`/tickets/${w1.code}`);
    assert.match(ticket.text, /You are <strong>#1<\/strong> on the waitlist/);
    assert.ok(!ticket.text.includes('class="qr-box"'), 'waitlisted people get no QR');

    const c2 = t.client();
    codes.w2 = (await c2.register(ev, { name: 'Waiter Two', email: 'w2@example.com', waitlist: true })).code;
    assert.match((await c2.get(`/tickets/${codes.w2}`)).text, /You are <strong>#2<\/strong> on the waitlist/);
  });

  it('scanning a waitlisted ticket shows "On waitlist — not confirmed"', async () => {
    const r = await door.checkIn(ev, codes.w1);
    assert.equal(r.result, 'waitlisted');
    assert.equal(r.title, 'On waitlist — not confirmed');
    assert.equal(r.tone, 'danger');
    assert.equal(t.reg(codes.w1).status, 'waitlisted');
  });

  it('cancelling a confirmed registration frees a spot, and scanning it shows "Cancelled"', async () => {
    const before = await t.client().get(`/events/${ev}`);
    assert.match(before.text, /<strong class="text-danger">Full<\/strong>/);

    const owner = t.client();
    await owner.post('/tickets/find', { code: codes.b, contact: 'b@example.com' });
    const stranger = t.client();
    assert.equal((await stranger.post(`/tickets/${codes.b}/cancel`)).status, 404, 'only the owner can cancel');
    const cancel = await owner.post(`/tickets/${codes.b}/cancel`);
    assert.equal(cancel.status, 303);
    assert.equal(t.reg(codes.b).status, 'cancelled');

    const after = await t.client().get(`/events/${ev}`);
    assert.match(after.text, /<strong>1<\/strong> of 2 spots left/);

    const r = await door.checkIn(ev, codes.b);
    assert.equal(r.result, 'cancelled');
    assert.equal(r.title, 'Cancelled');
  });

  it('promoting the first waitlisted person gives them a ticket that checks in', async () => {
    const res = await org.post(`/staff/events/${ev}/promote`);
    assert.equal(res.status, 303);
    assert.equal(t.reg(codes.w1).status, 'confirmed');
    assert.equal(t.reg(codes.w2).status, 'waitlisted', 'only the first in line');
    const r = await door.checkIn(ev, codes.w1);
    assert.equal(r.result, 'checked_in');
    assert.equal(r.name, 'Waiter One');

    // No more spots: promoting again is refused.
    await org.post(`/staff/events/${ev}/promote`);
    assert.equal(t.reg(codes.w2).status, 'waitlisted');
  });

  it('a checked-in registration cannot be cancelled (by staff or attendee)', async () => {
    const reg = t.reg(codes.w1);
    const res = await org.post(`/staff/registrations/${reg.id}/cancel`);
    assert.equal(res.status, 303);
    const page = await org.get(res.location);
    assert.match(page.text, /already checked in, so the registration can’t be cancelled/);
    const owner = t.client();
    await owner.post('/tickets/find', { code: codes.w1, contact: 'w1@example.com' });
    await owner.post(`/tickets/${codes.w1}/cancel`);
    assert.equal(t.reg(codes.w1).status, 'checked_in');
  });

  it('undoing a check-in lets the ticket check in again, and records who and when', async () => {
    const reg = t.reg(codes.w1);
    const res = await door.postJson(`/staff/api/registrations/${reg.id}/undo-checkin`);
    assert.equal(res.status, 200);
    const row = t.reg(codes.w1);
    assert.equal(row.status, 'confirmed');
    assert.equal(row.checked_in_at, null);
    assert.equal(row.checkin_undone_by, 2); // the door account
    assert.equal(row.checkin_undone_at, '2026-12-05T12:00:00+08:00');
    const log = t.db.prepare("SELECT * FROM audit_logs WHERE action = 'checkin_undone' AND target_id = ?").get(reg.id);
    assert.ok(log);
    assert.equal(log.staff_user_id, 2);
    assert.match(log.actor, /Dario Door/);
    assert.equal((await door.checkIn(ev, codes.w1)).result, 'checked_in');
  });

  it('the dashboard counts match the attendee list', async () => {
    t.addRegistration(ev, { status: 'waitlisted' });
    const dash = await org.get('/staff/dashboard');
    const card = dash.text.slice(dash.text.indexOf('Tiny Meetup'));
    const num = (label) => Number(card.match(new RegExp(`<dt>${label}</dt><dd>(\\d+|—)</dd>`))[1]);
    const db = t.db.prepare(
      `SELECT SUM(status IN ('confirmed','checked_in')) AS confirmed, SUM(status='waitlisted') AS waitlisted,
              SUM(status='cancelled') AS cancelled, SUM(status='checked_in') AS checked_in, SUM(status='confirmed') AS no_shows
       FROM registrations WHERE event_id = ?`
    ).get(ev);
    assert.equal(num('Capacity'), 2);
    assert.equal(num('Confirmed'), db.confirmed);
    assert.equal(num('Waitlisted'), db.waitlisted);
    assert.equal(num('Cancelled'), db.cancelled);
    assert.equal(num('Checked in'), db.checked_in);
    assert.equal(num('No-shows'), db.no_shows); // event started at 9:00 AM, "now" is 12:00 PM

    const list = await org.get(`/staff/events/${ev}/attendees`);
    assert.match(list.text, new RegExp(`<dt>Registered</dt><dd>${db.confirmed} <span>/ 2</span></dd>`));
    assert.match(list.text, new RegExp(`<dt>Checked in</dt><dd>${db.checked_in} <span>/ ${db.confirmed}</span></dd>`));
    assert.match(list.text, new RegExp(`<dt>Waitlisted</dt><dd>${db.waitlisted}</dd>`));
    assert.match(list.text, new RegExp(`<dt>Cancelled</dt><dd>${db.cancelled}</dd>`));
  });

  it('no-shows are hidden until the event starts', async () => {
    const future = t.makeEvent({ title: 'Later Today', start: '18:00', end: '21:00' });
    t.addRegistration(future);
    const dash = await org.get('/staff/dashboard');
    const card = dash.text.slice(dash.text.indexOf('Later Today'));
    assert.match(card, /<dt>No-shows<\/dt><dd>—<\/dd>/);
  });

  it('exports the attendee list as Excel-friendly CSV', async () => {
    const res = await org.get(`/staff/events/${ev}/attendees.csv`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/csv; charset=utf-8/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="TM-attendees-2026-12-05\.csv"/);
    assert.ok(res.text.startsWith('﻿"Ticket code","Full name","Email","Mobile","Status"'));
    const lines = res.text.trim().split('\r\n');
    const total = t.db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?').get(ev).n;
    assert.equal(lines.length, total + 1);
    assert.ok(lines.some((l) => l.includes('"Attendee A","a@example.com","=""09171234567""","Confirmed"')));
    assert.ok(lines.some((l) => l.includes('"Cancelled"')));
  });

  it('neutralises spreadsheet formulas in exported names', async () => {
    t.addRegistration(ev, { name: '=HYPERLINK("http://evil")', status: 'waitlisted' });
    const res = await org.get(`/staff/events/${ev}/attendees.csv`);
    assert.ok(res.text.includes(`"'=HYPERLINK(""http://evil"")"`));
  });
});
