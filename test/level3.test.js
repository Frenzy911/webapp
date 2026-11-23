'use strict';

// Level 3 checks that can be automated: race conditions, unguessable codes, rate limits,
// emails, roles and the audit log. (Camera scanning and HTTPS deployment are checked by hand.)
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { startApp } = require('./support/harness');
const { ticketAccessToken } = require('../src/lib/tickets');

describe('Level 3 · race conditions', () => {
  let t;
  before(async () => {
    t = await startApp();
  });
  after(() => t.close());

  it('when many people register for the last spot at once, only one gets it', async () => {
    const ev = t.makeEvent({ title: 'Last Spot', capacity: 3 });
    t.addRegistration(ev);
    t.addRegistration(ev);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => t.client().register(ev, { name: `Racer ${i}`, email: `racer${i}@example.com` }))
    );
    assert.equal(results.filter((r) => r.status === 303).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 11);
    assert.ok(results.filter((r) => r.status === 409).every((r) => /last spot was just taken/.test(r.text)));
    const { n } = t.db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE event_id = ? AND status IN ('confirmed','checked_in')").get(ev);
    assert.equal(n, 3);
  });

  it('the database itself refuses to go over capacity, even from a second connection', () => {
    const ev = t.makeEvent({ title: 'Trigger Guard', capacity: 1 });
    t.addRegistration(ev);
    const other = new DatabaseSync(t.db.location());
    try {
      assert.throws(
        () =>
          other
            .prepare("INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, registered_at) VALUES (?, 'X', 'x@example.com', '09170000000', 'TG-AAAAAAAA', 'confirmed', '2026-12-05T12:00:00+08:00')")
            .run(ev),
        /EVENT_FULL/
      );
      const wl = other
        .prepare("INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, registered_at) VALUES (?, 'Y', 'y@example.com', '09170000000', 'TG-BBBBBBBB', 'waitlisted', '2026-12-05T12:00:00+08:00')")
        .run(ev);
      assert.throws(() => other.prepare("UPDATE registrations SET status = 'confirmed' WHERE id = ?").run(wl.lastInsertRowid), /EVENT_FULL/);
    } finally {
      other.close();
    }
  });

  it('when two devices check in the same ticket at once, only one says "Checked in"', async () => {
    const ev = t.makeEvent({ title: 'Door Rush', capacity: 10 });
    const { code } = await t.client().register(ev, { name: 'Popular Person', email: 'popular@example.com' });
    const phones = await Promise.all([t.staffClient('door'), t.staffClient('door'), t.staffClient('organizer'), t.staffClient('door')]);
    const results = await Promise.all(phones.map((p) => p.checkIn(ev, code)));
    assert.equal(results.filter((r) => r.result === 'checked_in').length, 1);
    assert.equal(results.filter((r) => r.result === 'already').length, 3);
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'checked_in' AND details LIKE ?").get(`${code}%`).n, 1);
  });
});

describe('Level 3 · secure codes and rate limits', () => {
  let t;
  let ev;
  before(async () => {
    t = await startApp({ rateLimits: { lookup: { windowMs: 60_000, max: 5 } } });
    ev = t.makeEvent({ title: 'Cebu Dev Meetup 2026', capacity: 30 });
  });
  after(() => t.close());

  it('ticket codes are long random values, never sequential', async () => {
    const codes = [];
    for (let i = 0; i < 20; i += 1) codes.push((await t.client().register(ev, { email: `r${i}@example.com` })).code);
    assert.equal(new Set(codes).size, 20);
    for (const c of codes) assert.match(c, /^CDM-[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it('guessed, sequential or edited codes never check anyone in', async () => {
    const door = await t.staffClient('door');
    const real = t.db.prepare('SELECT ticket_code FROM registrations WHERE event_id = ? LIMIT 1').get(ev).ticket_code;
    const last = real.slice(-1);
    const edited = real.slice(0, -1) + (last === 'Z' ? 'Y' : last === '9' ? '8' : String.fromCharCode(last.charCodeAt(0) + 1) === 'I' ? 'J' : String.fromCharCode(last.charCodeAt(0) + 1));
    for (const guess of ['CDM-000001', 'CDM-00000001', 'CDM-00000002', 'CDM-7K3P9Q', edited, real.replace('CDM', 'CDN')]) {
      if (guess === real) continue;
      const r = await door.checkIn(ev, guess);
      assert.equal(r.result, 'invalid', guess);
    }
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE status = 'checked_in'").get().n, 0);
  });

  it('rate-limits ticket lookups', async () => {
    const c = t.client();
    const statuses = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await c.post('/tickets/find', { code: `CDM-0000000${i}`, contact: 'x@example.com' })).status);
    assert.deepEqual(statuses.slice(0, 5), [404, 404, 404, 404, 404]);
    assert.equal(statuses[5], 429);
    assert.equal(statuses[6], 429);
  });
});

describe('Level 3 · email confirmation', () => {
  let t;
  before(async () => {
    t = await startApp();
  });
  after(() => t.close());

  const waitForEmail = async (db, kind, regId) => {
    for (let i = 0; i < 50; i += 1) {
      const row = db.prepare('SELECT * FROM email_outbox WHERE kind = ? AND registration_id = ?').get(kind, regId);
      if (row) return row;
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  };

  it('sends a registration email with the QR code and a working ticket link', async () => {
    const ev = t.makeEvent({ title: 'Email Event', capacity: 1 });
    const { code } = await t.client().register(ev, { name: 'Mail Reader', email: 'reader@example.com' });
    const reg = t.reg(code);
    const mail = await waitForEmail(t.db, 'registration', reg.id);
    assert.ok(mail, 'registration email recorded');
    assert.equal(mail.to_address, 'reader@example.com');
    assert.equal(mail.status, 'saved'); // no SMTP in tests
    assert.match(mail.subject, new RegExp(code));
    assert.match(mail.html, /<img src="data:image\/png;base64,/);
    const token = ticketAccessToken('test-secret-0123456789abcdef0123456789abcdef', code);
    assert.ok(mail.html.includes(`http://tickets.test/tickets/${code}?t=${token}`));

    // The link opens the ticket in a fresh browser; a forged token does not.
    const fresh = t.client();
    const open = await fresh.get(`/tickets/${code}?t=${token}`);
    assert.equal(open.status, 302);
    assert.equal(open.location, `/tickets/${code}`);
    assert.match((await fresh.get(open.location)).text, /Mail Reader/);
    const forged = await t.client().get(`/tickets/${code}?t=${'A'.repeat(32)}`);
    assert.match(forged.location, /^\/tickets\/find/);
  });

  it('sends a waitlist email, and a promotion email with the QR code', async () => {
    const ev = t.makeEvent({ title: 'Promo Event', capacity: 1 });
    const first = await t.client().register(ev, { email: 'first@example.com' });
    const { code } = await t.client().register(ev, { name: 'Wait Lister', email: 'waiter@example.com', waitlist: true });
    const reg = t.reg(code);
    const wl = await waitForEmail(t.db, 'waitlist', reg.id);
    assert.ok(wl);
    assert.match(wl.html, /position #1/);
    assert.ok(!wl.html.includes('data:image/png'), 'no QR while waitlisted');

    const org = await t.staffClient('organizer');
    const owner = t.client();
    await owner.post('/tickets/find', { code: first.code, contact: 'first@example.com' });
    await owner.post(`/tickets/${first.code}/cancel`);
    await org.post(`/staff/events/${ev}/promote`);
    const promo = await waitForEmail(t.db, 'promotion', reg.id);
    assert.ok(promo, 'promotion email recorded');
    assert.match(promo.subject, /Good news/);
    assert.match(promo.html, /data:image\/png;base64,/);

    const outbox = await org.get(`/staff/outbox/${promo.id}`);
    assert.equal(outbox.status, 200);
    const raw = await org.get(`/staff/outbox/${promo.id}/raw`);
    assert.match(raw.headers.get('content-security-policy'), /default-src 'none'/);
  });
});

describe('Level 3 · roles and audit log', () => {
  let t;
  before(async () => {
    t = await startApp();
  });
  after(() => t.close());

  it('door staff can only use check-in; organizers can manage events', async () => {
    const door = await t.staffClient('door');
    const ev = t.makeEvent({ title: 'Role Test' });
    assert.equal((await door.get('/staff')).location, '/staff/checkin');
    assert.equal((await door.get('/staff/checkin')).status, 200);
    assert.equal((await door.get(`/staff/events/${ev}/checkin`)).status, 200);
    for (const url of ['/staff/dashboard', '/staff/events', '/staff/events/new', `/staff/events/${ev}/edit`, `/staff/events/${ev}/attendees`, `/staff/events/${ev}/attendees.csv`, '/staff/audit', '/staff/users', '/staff/outbox']) {
      assert.equal((await door.get(url)).status, 403, url);
    }
    const create = await door.post('/staff/events', { title: 'Sneaky', venue: 'X', date: '2026-12-10', start_time: '10:00', end_time: '11:00', capacity: '5', status: 'published' });
    assert.equal(create.status, 403);
    assert.equal((await door.post(`/staff/events/${ev}/status`, { status: 'closed' })).status, 403);
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM events WHERE title = 'Sneaky'").get().n, 0);

    const org = await t.staffClient('organizer');
    const ok = await org.post('/staff/events', { title: 'Allowed', venue: 'X', date: '2026-12-10', start_time: '10:00', end_time: '11:00', capacity: '5', status: 'published' });
    assert.equal(ok.status, 303);
  });

  it('organizers can add staff; deactivated accounts are signed out', async () => {
    const org = await t.staffClient('organizer');
    const res = await org.post('/staff/users', { name: 'New Door', username: 'newdoor', password: 'short', role: 'door' });
    assert.equal(res.status, 422);
    assert.equal((await org.post('/staff/users', { name: 'New Door', username: 'newdoor', password: 'long-enough-pw', role: 'door' })).status, 303);
    const nd = t.client();
    await nd.login('newdoor', 'long-enough-pw');
    assert.equal((await nd.get('/staff/checkin')).status, 200);
    const id = t.db.prepare("SELECT id FROM staff_users WHERE username = 'newdoor'").get().id;
    await org.post(`/staff/users/${id}/active`, { active: '0' });
    assert.equal((await nd.get('/staff/checkin')).status, 302);
  });

  it('records who did what and when for the key actions', async () => {
    const org = await t.staffClient('organizer');
    const door = await t.staffClient('door');
    const created = await org.post('/staff/events', { title: 'Audit Me', venue: 'Hall', date: '2026-12-05', start_time: '09:00', end_time: '21:00', capacity: '1', status: 'published' });
    const ev = Number(created.location.match(/events\/(\d+)/)[1]);
    await org.post(`/staff/events/${ev}`, { title: 'Audit Me', venue: 'Hall B', date: '2026-12-05', start_time: '09:00', end_time: '21:00', capacity: '1', status: 'published' });
    const a = await t.client().register(ev, { email: 'aa@example.com' });
    const b = await t.client().register(ev, { email: 'bb@example.com', waitlist: true });
    await org.post(`/staff/registrations/${t.reg(a.code).id}/cancel`);
    await org.post(`/staff/events/${ev}/promote`);
    await door.checkIn(ev, b.code);
    await door.postJson(`/staff/api/registrations/${t.reg(b.code).id}/undo-checkin`);

    const actions = t.db.prepare('SELECT action, staff_user_id, actor, created_at, details FROM audit_logs WHERE event_id = ? ORDER BY id').all(ev);
    assert.deepEqual(
      actions.map((x) => x.action),
      ['event_created', 'event_updated', 'registration_cancelled', 'waitlist_promoted', 'checked_in', 'checkin_undone']
    );
    assert.match(actions[1].details, /venue: Hall → Hall B/);
    for (const x of actions) {
      assert.ok(x.staff_user_id, 'who');
      assert.equal(x.created_at, '2026-12-05T12:00:00+08:00', 'when');
    }
    const page = await org.get(`/staff/audit?event=${ev}`);
    assert.match(page.text, /Check-in undone/);
    assert.match(page.text, /Dario Door \(Door staff\)/);
  });
});
