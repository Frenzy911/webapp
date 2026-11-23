'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../../src/app');
const { hashPassword } = require('../../src/services/staff');
const { generateTicketCode, prefixFromTitle } = require('../../src/lib/tickets');
const { fromLocalParts, toManilaIso } = require('../../src/lib/time');

// Tests run on a fixed clock: Saturday, Dec 5, 2026, 12:00 PM Cebu time.
const TODAY = '2026-12-05';
const NOW = new Date(`${TODAY}T12:00:00+08:00`);
const PASSWORDS = { organizer: 'organizer-pass-1', door: 'door-pass-1' };

async function startApp({ rateLimits = {} } = {}) {
  const dbFile = path.join(os.tmpdir(), `cebu-events-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  let clock = NOW;
  const app = createApp({
    skipEnvFile: true,
    dbFile,
    sessionSecret: 'test-secret-0123456789abcdef0123456789abcdef',
    baseUrl: 'http://tickets.test',
    cookieSecure: false,
    logRequests: false,
    autoSeed: false,
    smtp: { host: '' },
    now: () => new Date(clock),
    rateLimits: {
      lookup: { windowMs: 60_000, max: 1000 },
      register: { windowMs: 60_000, max: 1000 },
      login: { windowMs: 60_000, max: 1000 },
      checkin: { windowMs: 60_000, max: 1000 },
      ...rateLimits,
    },
  });
  const db = app.locals.db;
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const addStaff = db.prepare('INSERT INTO staff_users (name, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)');
  addStaff.run('Olivia Organizer', 'organizer', hashPassword(PASSWORDS.organizer), 'organizer', toManilaIso(NOW));
  addStaff.run('Dario Door', 'door', hashPassword(PASSWORDS.door), 'door', toManilaIso(NOW));

  return {
    app,
    db,
    base,
    setNow(d) {
      clock = d;
    },
    client() {
      return new Client(base);
    },
    async staffClient(role = 'organizer') {
      const c = new Client(base);
      await c.login(role, PASSWORDS[role]);
      return c;
    },
    /** Create an event directly in the database. Defaults: published, today 09:00–22:00. */
    makeEvent({ title = 'Test Event', capacity = 5, status = 'published', date = TODAY, start = '09:00', end = '22:00', description = 'A test event.' } = {}) {
      const res = db
        .prepare(
          `INSERT INTO events (title, description, venue, starts_at, ends_at, capacity, status, code_prefix, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .run(title, description, 'Ayala Center Cebu, Function Room 2', fromLocalParts(date, start), fromLocalParts(date, end), capacity, status, prefixFromTitle(title), toManilaIso(NOW), toManilaIso(NOW));
      return Number(res.lastInsertRowid);
    },
    /** Insert a registration directly (bypasses the web form). */
    addRegistration(eventId, { name = 'Seed Person', email, mobile = '09170000000', status = 'confirmed' } = {}) {
      const ev = db.prepare('SELECT code_prefix FROM events WHERE id = ?').get(eventId);
      const code = generateTicketCode(ev.code_prefix);
      db.prepare('INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        eventId,
        name,
        email || `${Math.random().toString(36).slice(2)}@example.com`,
        mobile,
        code,
        status,
        toManilaIso(NOW)
      );
      return code;
    },
    reg(code) {
      return db.prepare('SELECT * FROM registrations WHERE ticket_code = ?').get(code);
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      app.locals.close();

      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
    },
  };
}

/** Tiny browser stand-in: keeps cookies and the CSRF token, never follows redirects automatically. */
class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
    this.token = null;
  }

  async request(method, url, { form, json, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (form) {
      h['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    } else if (json) {
      h['content-type'] = 'application/json';
      h.accept = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(this.base + url, { method, headers: h, body, redirect: 'manual' });
    for (const raw of res.headers.getSetCookie()) {
      const pair = raw.split(';')[0];
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (!value || /expires=Thu, 01 Jan 1970/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer()); // keep the BOM so CSV tests can see it
    const out = { status: res.status, location: res.headers.get('location'), headers: res.headers, text };
    const meta = text.match(/name="csrf-token" content="([^"]+)"/);
    if (meta) this.token = meta[1];
    out.json = () => JSON.parse(text);
    return out;
  }

  get(url) {
    return this.request('GET', url);
  }

  async ensureToken() {
    if (!this.token) await this.get('/tickets/find');
    return this.token;
  }

  async post(url, form = {}) {
    const _csrf = await this.ensureToken();
    return this.request('POST', url, { form: { _csrf, ...form } });
  }

  async postJson(url, json = {}) {
    const token = await this.ensureToken();
    return this.request('POST', url, { json, headers: { 'x-csrf-token': token } });
  }

  async login(username, password) {
    const res = await this.post('/staff/login', { username, password });
    if (res.status !== 303) throw new Error(`login failed for ${username}: ${res.status}`);
    this.token = null; // new session after sign-in -> new CSRF token
    await this.ensureToken();
    return res;
  }

  async register(eventId, { name = 'Juan Dela Cruz', email, mobile = '09171234567', waitlist = false } = {}) {
    const form = { full_name: name, email, mobile };
    if (waitlist) form.waitlist = '1';
    const res = await this.post(`/events/${eventId}/register`, form);
    const m = res.location && res.location.match(/^\/tickets\/([A-Z0-9-]+)$/);
    res.code = m ? m[1] : null;
    return res;
  }

  checkIn(eventId, code) {
    return this.postJson(`/staff/api/events/${eventId}/checkin`, { code }).then((r) => r.json());
  }
}

module.exports = { startApp, NOW, TODAY, PASSWORDS };
