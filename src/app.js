'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');

const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { SqliteSessionStore } = require('./lib/sessionStore');
const { createMailer } = require('./lib/mailer');
const { AppError } = require('./lib/errors');
const time = require('./lib/time');
const { getStaff } = require('./services/staff');
const publicRoutes = require('./routes/public');
const staffRoutes = require('./routes/staff');

function wantsJson(req) {
  return req.originalUrl.startsWith('/staff/api/') || (req.get('accept') || '').startsWith('application/json');
}

function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  const db = overrides.db || openDb(config.dbFile);
  const mailer = createMailer(config, db);
  const sessionStore = new SqliteSessionStore(db);

  const app = express();
  app.locals.config = config;
  app.locals.db = db;
  app.locals.mailer = mailer;
  app.set('views', path.join(__dirname, 'views'));
  app.set('view engine', 'ejs');
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  if (config.logRequests) {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        if (!req.path.startsWith('/static') && !req.path.startsWith('/vendor')) {
          console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
        }
      });
      next();
    });
  }

  // Security headers. No inline scripts or styles anywhere, so the CSP can stay strict.
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-src 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    });
    if (config.cookieSecure) res.set('Strict-Transport-Security', 'max-age=15552000');
    next();
  });

  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: config.production ? '1d' : 0 }));
  app.use('/vendor/jsqr', express.static(path.dirname(require.resolve('jsqr')), { maxAge: '7d' }));
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/static/favicon.svg'));

  app.use(express.urlencoded({ extended: false, limit: '20kb' }));
  app.use(express.json({ limit: '10kb' }));

  app.use(
    session({
      name: 'sid',
      secret: config.sessionSecret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 24 * 60 * 60 * 1000 },
    })
  );

  // Who is signed in (if anyone), CSRF token, flash messages, and view helpers.
  app.use((req, res, next) => {
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('base64url');
    res.locals.csrfToken = req.session.csrfToken;

    const staff = req.session.staffId ? getStaff(db, req.session.staffId) : null;
    if (staff && staff.active) {
      req.staff = staff;
      res.locals.currentStaff = staff;
    } else {
      res.locals.currentStaff = null;
      if (req.session.staffId) delete req.session.staffId;
    }
    req.flash = (type, message) => {
      req.session.flash = req.session.flash || [];
      req.session.flash.push({ type, message });
    };
    res.locals.takeFlash = () => {
      const items = req.session.flash || [];
      delete req.session.flash;
      return items;
    };
    res.locals.currentPath = req.path;
    Object.assign(res.locals, viewHelpers(config));

    // Render a view inside the shared layout.
    res.page = (view, locals = {}, status = 200) => {
      res.render(view, locals, (err, body) => {
        if (err) return next(err);
        res.status(status).render('layout', { ...locals, body }, (err2, html) => (err2 ? next(err2) : res.send(html)));
      });
    };
    next();
  });

  // CSRF: every form post and fetch must send back the per-session token.
  app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const sent = String((req.body && req.body._csrf) || req.get('x-csrf-token') || '');
    const expected = req.session.csrfToken;
    if (sent.length === expected.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected))) return next();
    const message = 'Your session expired or the form was out of date. Go back, reload the page and try again.';
    if (wantsJson(req)) return res.status(403).json({ error: message });
    return res.page('error', { title: 'Session expired', heading: 'Session expired', message }, 403);
  });

  // Ticket and staff pages contain personal data: never cache them.
  app.use(['/tickets', '/staff'], (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.use('/', publicRoutes(config));
  app.use('/staff', staffRoutes(config));

  app.use((req, res) => {
    if (wantsJson(req)) return res.status(404).json({ error: 'Not found' });
    res.page('error', { title: 'Page not found', heading: 'Page not found', message: 'That page does not exist or is no longer available.' }, 404);
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const known = err instanceof AppError;
    if (!known) console.error(err);
    const status = known ? err.status : err.status === 413 ? 413 : 500;
    const message = known ? err.message : status === 413 ? 'That request was too large.' : 'Something went wrong on our side. Please try again.';
    if (wantsJson(req)) return res.status(status).json({ error: message, code: known ? err.code : 'SERVER_ERROR' });
    if (typeof res.page !== 'function') return res.status(status).send(message);
    res.page('error', { title: 'Error', heading: status === 404 ? 'Not found' : 'Something went wrong', message }, status);
  });

  app.locals.close = () => {
    sessionStore.close();
    if (!overrides.db) db.close();
  };
  return app;
}

function viewHelpers(config) {
  return {
    fmt: time,
    appName: 'Cebu Events',
    now: () => config.now(),
    statusLabel: (s) => ({ confirmed: 'Confirmed', checked_in: 'Checked in', waitlisted: 'Waitlisted', cancelled: 'Cancelled', draft: 'Draft', published: 'Published', closed: 'Closed' })[s] || s,
  };
}

module.exports = { createApp };
