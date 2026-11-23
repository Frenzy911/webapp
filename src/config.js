'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

let envLoaded = false;
function loadEnvFile() {
  if (envLoaded) return;
  envLoaded = true;
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

/**
 * MySQL connection settings. DATABASE_URL (mysql://user:pass@host:3306/dbname, as cloud hosts give you)
 * wins over the separate MYSQL_* values. The defaults match a fresh XAMPP install.
 */
function mysqlSettings(env) {
  if (env.DATABASE_URL) {
    const u = new URL(env.DATABASE_URL);
    return {
      host: u.hostname,
      port: Number(u.port) || 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'cebu_events',
    };
  }
  return {
    host: env.MYSQL_HOST || '127.0.0.1',
    port: Number(env.MYSQL_PORT) || 3306,
    user: env.MYSQL_USER || 'root',
    password: env.MYSQL_PASSWORD || '',
    database: env.MYSQL_DATABASE || 'cebu_events',
  };
}

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * Build the app configuration from environment variables.
 * `overrides` lets tests (and scripts) replace any value without touching process.env.
 */
function loadConfig(overrides = {}) {
  if (!overrides.skipEnvFile) loadEnvFile();
  const env = process.env;
  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT) || 3000;

  let sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret && !overrides.sessionSecret) {
    if (production) throw new Error('SESSION_SECRET must be set in production.');
    sessionSecret = crypto.randomBytes(32).toString('hex');
    console.warn('[config] SESSION_SECRET is not set; using a random one. Run `npm run setup` to create a .env file.');
  }

  const config = {
    production,
    port,
    baseUrl: (env.APP_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    mysql: mysqlSettings(env),
    sessionSecret,
    trustProxy: env.TRUST_PROXY ? (/^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : bool(env.TRUST_PROXY)) : false,
    cookieSecure: bool(env.COOKIE_SECURE, production),
    autoSeed: bool(env.AUTO_SEED, true),
    smtp: {
      host: env.SMTP_HOST || '',
      port: Number(env.SMTP_PORT) || 587,
      secure: bool(env.SMTP_SECURE, false),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
    },
    mailFrom: env.MAIL_FROM || 'Cebu Events <no-reply@example.com>',
    seedPasswords: {
      organizer: env.SEED_ORGANIZER_PASSWORD || 'Organizer@2026',
      door: env.SEED_DOOR_PASSWORD || 'DoorStaff@2026',
    },
    // Rate limits (requests per window). Tests lower these.
    rateLimits: {
      lookup: { windowMs: 60_000, max: 10 },
      register: { windowMs: 60_000, max: 10 },
      login: { windowMs: 15 * 60_000, max: 10 },
      checkin: { windowMs: 60_000, max: 120 },
    },
    // Clock is injectable so tests can control "now".
    now: () => new Date(),
    logRequests: !production && env.LOG_REQUESTS !== 'false',
    ...overrides,
  };
  if (overrides.sessionSecret) config.sessionSecret = overrides.sessionSecret;
  return config;
}

module.exports = { loadConfig, mysqlSettings, ROOT };
