'use strict';

// Level 1 acceptance checks (see README checklist).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const QRCode = require('qrcode');
const jsQR = require('jsqr');
const { startApp, NOW } = require('./support/harness');

/** Rasterise the QR the app would draw for `text` and decode it with the same library the camera uses. */
function decodeQr(text) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const scale = 6;
  const quiet = 4;
  const px = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(px * px * 4).fill(255);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!qr.modules.get(y, x)) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const i = (((y + quiet) * scale + dy) * px + (x + quiet) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  const found = jsQR(data, px, px);
  return found && found.data;
}

describe('Level 1 · core flow', () => {
  let t;
  let meetup;
  let other;
  let full;
  before(async () => {
    t = await startApp();
    meetup = await t.makeEvent({ title: 'Cebu Dev Meetup 2026', capacity: 30 });
    other = await t.makeEvent({ title: 'Mobile Dev Workshop', capacity: 10 });
    full = await t.makeEvent({ title: 'Full House Night', capacity: 2 });
    await t.addRegistration(full);
    await t.addRegistration(full);
  });
  after(() => t.close());

  it('lists upcoming events with Cebu times and spots left', async () => {
    const res = await t.client().get('/');
    assert.equal(res.status, 200);
    assert.match(res.text, /Cebu Dev Meetup 2026/);
    assert.match(res.text, /Sat, Dec 5, 2026 · 9:00 AM – 10:00 PM/);
    assert.match(res.text, /<strong>30<\/strong> of 30 spots left/);
    assert.match(res.text, /Ayala Center Cebu, Function Room 2/);
  });

  it('registers on the Cebu Dev Meetup and shows a ticket page with a QR code of the ticket code', async () => {
    const c = t.client();
    const res = await c.register(meetup, { name: 'Juan Dela Cruz', email: 'Juan@Example.com', mobile: '0917 123 4567' });
    assert.equal(res.status, 303);
    assert.match(res.code, /^CDM-[0-9A-HJKMNP-TV-Z]{8}$/);

    const page = await c.get(`/tickets/${res.code}`);
    assert.equal(page.status, 200);
    for (const text of ['Cebu Dev Meetup 2026', 'Juan Dela Cruz', res.code, 'Sat, Dec 5, 2026', '9:00 AM – 10:00 PM', 'Ayala Center Cebu, Function Room 2', "You're registered!"]) {
      assert.ok(page.text.includes(text), `ticket page should include ${text}`);
    }
    assert.match(page.text, /name="viewport" content="width=device-width/);

    // The QR on the page is exactly the QR of the ticket code, and it decodes back to that code.
    const expectedSvg = await QRCode.toString(res.code, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    assert.ok(page.text.includes(expectedSvg), 'page embeds the QR of the ticket code');
    assert.equal(decodeQr(res.code), res.code);

    const row = await t.reg(res.code);
    assert.equal(row.email, 'juan@example.com');
    assert.equal(row.mobile, '09171234567');
    assert.equal(row.status, 'confirmed');
  });

  it('finds the ticket again after a refresh with ticket code + email (or mobile)', async () => {
    const res = await t.client().register(meetup, { name: 'Maria Santos', email: 'maria@example.com', mobile: '09181234567' });
    const stranger = t.client(); // fresh browser, no session
    const blocked = await stranger.get(`/tickets/${res.code}`);
    assert.equal(blocked.status, 302);
    assert.match(blocked.location, /^\/tickets\/find\?code=/);

    const found = await stranger.post('/tickets/find', { code: res.code.toLowerCase(), contact: 'MARIA@example.com' });
    assert.equal(found.status, 303);
    assert.equal(found.location, `/tickets/${res.code}`);
    const page = await stranger.get(found.location);
    assert.equal(page.status, 200);
    assert.match(page.text, /Maria Santos/);

    const byMobile = await t.client().post('/tickets/find', { code: res.code, contact: '09181234567' });
    assert.equal(byMobile.status, 303);
  });

  it('wrong ticket code or wrong email shows "Ticket not found" and no details', async () => {
    const res = await t.client().register(meetup, { name: 'Secret Person', email: 'secret@example.com', mobile: '09191234567' });
    const c = t.client();
    for (const [code, contact] of [
      [res.code, 'someone.else@example.com'],
      ['CDM-ZZZZZZZZ', 'secret@example.com'],
      [res.code, '09990000000'],
      ['', ''],
    ]) {
      const r = await c.post('/tickets/find', { code, contact });
      assert.equal(r.status, 404);
      assert.match(r.text, /Ticket not found/);
      assert.ok(!r.text.includes('Secret Person'), 'must not reveal the name');
      assert.ok(!r.text.includes('Cebu Dev Meetup'), 'must not reveal the event');
    }
  });

  it('blocks the same email registering twice for one event (any letter case)', async () => {
    const c = t.client();
    const first = await c.register(meetup, { email: 'twice@example.com' });
    assert.equal(first.status, 303);
    const second = await c.register(meetup, { email: 'TWICE@example.com' });
    assert.equal(second.status, 409);
    assert.match(second.text, /already registered for this event/);
    const { n } = await t.get("SELECT COUNT(*) AS n FROM registrations WHERE email = 'twice@example.com'");
    assert.equal(n, 1);
    // The same email may register for a different event.
    assert.equal((await c.register(other, { email: 'twice@example.com' })).status, 303);
  });

  it('shows field errors for a bad email and a 10-digit mobile, and saves nothing', async () => {
    const before = (await t.get('SELECT COUNT(*) AS n FROM registrations')).n;
    const res = await t.client().register(meetup, { name: 'Bad Input', email: 'not-an-email', mobile: '0917123456' });
    assert.equal(res.status, 422);
    assert.match(res.text, /id="f-email-error"[^>]*>.*Enter a valid email address/s);
    assert.match(res.text, /id="f-mobile-error"[^>]*>.*11-digit mobile number starting with 09/s);
    assert.match(res.text, /aria-invalid="true"/);
    const empty = await t.client().register(meetup, { name: '', email: '', mobile: '' });
    assert.equal(empty.status, 422);
    assert.match(empty.text, /Enter your full name/);
    assert.match(empty.text, /Enter your email address/);
    assert.match(empty.text, /Enter your mobile number/);
    assert.equal((await t.get('SELECT COUNT(*) AS n FROM registrations')).n, before);
  });

  it('shows a full event as "Full" with the Register button disabled, and the server refuses extra registrations', async () => {
    const page = await t.client().get(`/events/${full}`);
    assert.match(page.text, /<span class="badge badge-danger">Full<\/span>/);
    assert.match(page.text, /<button class="btn btn-big" type="button" disabled[^>]*>Register · Full<\/button>/);
    // Skipping the disabled button and posting directly still fails.
    const res = await t.client().register(full, { email: 'sneaky@example.com' });
    assert.equal(res.status, 409);
    assert.equal((await t.get("SELECT COUNT(*) AS n FROM registrations WHERE event_id = ? AND status IN ('confirmed','checked_in')", full)).n, 2);
  });

  it('sends signed-out visitors from staff pages to the sign-in page (server-side)', async () => {
    const c = t.client();
    for (const url of ['/staff', '/staff/dashboard', '/staff/checkin', `/staff/events/${meetup}/checkin`, `/staff/events/${meetup}/attendees`, `/staff/events/${meetup}/attendees.csv`, '/staff/events/new', '/staff/audit']) {
      const r = await c.get(url);
      assert.equal(r.status, 302, url);
      assert.match(r.location, /^\/staff\/login\?next=/, url);
    }
    const api = await c.postJson(`/staff/api/events/${meetup}/checkin`, { code: 'CDM-12345678' });
    assert.equal(api.status, 401);
    const wrong = await c.post('/staff/login', { username: 'organizer', password: 'nope' });
    assert.equal(wrong.status, 401);
    assert.match(wrong.text, /Wrong username or password/);
  });

  it('stores staff passwords as bcrypt hashes', async () => {
    for (const row of await t.all('SELECT password_hash FROM staff_users')) {
      assert.match(row.password_hash, /^\$2[aby]\$10\$/);
    }
  });

  it('checks in a valid ticket (green, with name), then warns "Already checked in" with the first time', async () => {
    const { code } = await t.client().register(meetup, { name: 'Pedro Penduko', email: 'pedro@example.com' });
    const staff = await t.staffClient('door');
    const first = await staff.checkIn(meetup, code);
    assert.equal(first.result, 'checked_in');
    assert.equal(first.tone, 'success');
    assert.equal(first.title, 'Checked in');
    assert.equal(first.name, 'Pedro Penduko');
    assert.equal((await t.reg(code)).checked_in_at, '2026-12-05T12:00:00+08:00');

    t.setNow(new Date(NOW.getTime() + 15 * 60_000));
    const again = await staff.checkIn(meetup, code.toLowerCase());
    t.setNow(NOW);
    assert.equal(again.result, 'already');
    assert.equal(again.tone, 'warning');
    assert.equal(again.title, 'Already checked in');
    assert.match(again.message, /First checked in at 12:00 PM/);
    assert.equal((await t.reg(code)).checked_in_at, '2026-12-05T12:00:00+08:00', 'first time is kept');
  });

  it('shows "Invalid ticket" for a made-up code and for a real code from another event', async () => {
    const staff = await t.staffClient('door');
    const madeUp = await staff.checkIn(meetup, 'CDM-ABCDEFGH');
    assert.equal(madeUp.result, 'invalid');
    assert.equal(madeUp.title, 'Invalid ticket');
    const garbage = await staff.checkIn(meetup, 'hello world');
    assert.equal(garbage.result, 'invalid');
    const { code } = await t.client().register(other, { email: 'other-event@example.com' });
    const wrongEvent = await staff.checkIn(meetup, code);
    assert.equal(wrongEvent.result, 'invalid');
    assert.match(wrongEvent.message, /different event/);
    assert.equal((await t.reg(code)).status, 'confirmed', 'not checked in anywhere');
  });

  it('check-in works as a plain form post too (no JavaScript / USB scanner)', async () => {
    const { code } = await t.client().register(meetup, { name: 'Form Poster', email: 'form@example.com' });
    const staff = await t.staffClient('door');
    const res = await staff.post(`/staff/events/${meetup}/checkin`, { code });
    assert.equal(res.status, 200);
    assert.match(res.text, /result result-success/);
    assert.match(res.text, /<p class="result-title">Checked in<\/p>/);
    assert.match(res.text, /Form Poster/);
  });

  it('attendee list shows correct registered / capacity and checked in / registered totals, with search', async () => {
    const staff = await t.staffClient('organizer');
    const res = await staff.get(`/staff/events/${meetup}/attendees`);
    assert.equal(res.status, 200);
    const counts = await t.get("SELECT SUM(status IN ('confirmed','checked_in')) AS reg, SUM(status = 'checked_in') AS ci FROM registrations WHERE event_id = ?", meetup);
    assert.match(res.text, new RegExp(`<dt>Registered</dt><dd>${counts.reg} <span>/ 30</span></dd>`));
    assert.match(res.text, new RegExp(`<dt>Checked in</dt><dd>${counts.ci} <span>/ ${counts.reg}</span></dd>`));
    for (const col of ['Name', 'Email', 'Mobile', 'Ticket code', 'Registered at', 'Status']) assert.ok(res.text.includes(`>${col}</th>`), col);

    const search = await staff.get(`/staff/events/${meetup}/attendees?q=pedro`);
    assert.match(search.text, /Pedro Penduko/);
    assert.ok(!search.text.includes('Maria Santos'));
    const byCode = (await t.get("SELECT ticket_code FROM registrations WHERE full_name = 'Maria Santos'")).ticket_code;
    const search2 = await staff.get(`/staff/events/${meetup}/attendees?q=${byCode.slice(-5)}`);
    assert.match(search2.text, /Maria Santos/);
  });

  it('rejects form posts without the CSRF token', async () => {
    const c = t.client();
    await c.ensureToken();
    const res = await c.request('POST', `/events/${meetup}/register`, { form: { full_name: 'X Y', email: 'csrf@example.com', mobile: '09171234567' } });
    assert.equal(res.status, 403);
  });
});
