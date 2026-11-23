'use strict';

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const mysql = require('mysql2/promise');

const { createApp } = require('../../src/app');
const { mysqlSettings, ROOT } = require('../../src/config');
const db = require('../../src/db');
const { hashPassword } = require('../../src/services/staff');
const { generateTicketCode, prefixFromTitle } = require('../../src/lib/tickets');
const { fromLocalParts, toManilaIso } = require('../../src/lib/time');

// Tests run on a fixed clock: Saturday, Dec 5, 2026, 12:00 PM Cebu time.
const TODAY = '2026-12-05';
const NOW = new Date(`${TODAY}T12:00:00+08:00`);
const PASSWORDS = { organizer: 'organizer-pass-1', door: 'door-pass-1' };

/**
 * Tests use the same MySQL server as the app (MYSQL_* / DATABASE_URL from the environment or .env;
 * TEST_DATABASE_URL overrides it), but each test file gets its own throwaway database,
 * which is dropped afterwards. Your real data is never touched.
 */
function testServerSettings() {
  const file = path.join(ROOT, '.env');
  const fromFile = fs.existsSync(file) ? util.parseEnv(fs.readFileSync(file, 'utf8')) : {};
  const env = { ...fromFile, ...process.env };
  if (env.TEST_DATABASE_URL) env.DATABASE_URL = env.TEST_DATABASE_URL;
  return mysqlSettings(env);
}

async function startApp({ rateLimits = {} } = {}) {
  const mysqlTest = { ...testServerSettings(), database: `cebu_test_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}` };
  let clock = NOW;
  const app = await createApp({
    skipEnvFile: true,
    mysql: mysqlTest,
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
  const pool = app.locals.db;
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const addStaff = 'INSERT INTO staff_users (name, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)';
  await db.run(pool, addStaff, ['Olivia Organizer', 'organizer', hashPassword(PASSWORDS.organizer), 'organizer', toManilaIso(NOW)]);
  await db.run(pool, addStaff, ['Dario Door', 'door', hashPassword(PASSWORDS.door), 'door', toManilaIso(NOW)]);

  return {
    app,
    db: pool,
    mysql: mysqlTest,
    base,
    /** First row of a query, or null. */
    get(sql, ...params) {
      return db.get(pool, sql, params);
    },
    all(sql, ...params) {
      return db.all(pool, sql, params);
    },
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
    async makeEvent({ title = 'Test Event', capacity = 5, status = 'published', date = TODAY, start = '09:00', end = '22:00', description = 'A test event.' } = {}) {
      const res = await db.run(
        pool,
        `INSERT INTO events (title, description, venue, starts_at, ends_at, capacity, status, code_prefix, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [title, description, 'Ayala Center Cebu, Function Room 2', fromLocalParts(date, start), fromLocalParts(date, end), capacity, status, prefixFromTitle(title), toManilaIso(NOW), toManilaIso(NOW)]
      );
      return res.insertId;
    },
    /** Insert a registration directly (bypasses the web form). */
    async addRegistration(eventId, { name = 'Seed Person', email, mobile = '09170000000', status = 'confirmed' } = {}) {
      const ev = await db.get(pool, 'SELECT code_prefix FROM events WHERE id = ?', [eventId]);
      const code = generateTicketCode(ev.code_prefix);
      await db.run(pool, 'INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        eventId,
        name,
        email || `${Math.random().toString(36).slice(2)}@example.com`,
        mobile,
        code,
        status,
        toManilaIso(NOW),
      ]);
      return code;
    },
    reg(code) {
      return db.get(pool, 'SELECT * FROM registrations WHERE ticket_code = ?', [code]);
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      // Let fire-and-forget emails finish writing before the pool closes.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await app.locals.close();
      const admin = await mysql.createConnection({ ...mysqlTest, database: undefined });
      await admin.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(mysqlTest.database)}`);
      await admin.end();
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
