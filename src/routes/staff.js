'use strict';

const express = require('express');

const { AppError, ValidationError } = require('../lib/errors');
const { rateLimit } = require('../lib/rateLimit');
const { ACTION_LABELS } = require('../lib/audit');
const { manilaDateString, addDays, formatDateTime } = require('../lib/time');
const events = require('../services/events');
const regs = require('../services/registrations');
const checkin = require('../services/checkin');
const staffSvc = require('../services/staff');

function wantsJson(req) {
  return req.originalUrl.startsWith('/staff/api/');
}

/** Server-side guard: every staff URL requires a signed-in staff account. */
function requireStaff(req, res, next) {
  if (req.staff) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'Please sign in again.' });
  return res.redirect(`/staff/login?next=${encodeURIComponent(req.originalUrl)}`);
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (roles.includes(req.staff.role)) return next();
    if (wantsJson(req)) return res.status(403).json({ error: 'Your account does not have access to this.' });
    return res.page(
      'error',
      { title: 'No access', heading: 'Organizers only', message: 'Door staff accounts can only use the check-in screen.', link: { href: '/staff/checkin', label: 'Go to check-in' } },
      403
    );
  };
}

/** Only allow redirects back into the staff area (no open redirects). */
function safeReturn(value, fallback) {
  const s = String(value || '');
  return /^\/staff(\/[\w\-./?=&%]*)?$/.test(s) && !s.includes('//') ? s : fallback;
}

function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return `"${s.replace(/"/g, '""')}"`;
}

module.exports = function staffRoutes(config) {
  const router = express.Router();
  const tooMany = (req, res, retryAfter) => {
    const message = `Too many attempts. Please wait about ${retryAfter} seconds.`;
    if (wantsJson(req)) return res.status(429).json({ error: message });
    return res.page('error', { title: 'Too many attempts', heading: 'Too many attempts', message }, 429);
  };
  const loginLimiter = rateLimit({ ...config.rateLimits.login, onLimit: tooMany });
  const checkinLimiter = rateLimit({ ...config.rateLimits.checkin, key: (req) => `staff:${req.staff ? req.staff.id : req.ip}`, onLimit: tooMany });

  router.use((req, res, next) => {
    req.db = req.app.locals.db;
    req.now = config.now();
    next();
  });

  // ---------------------------------------------------------------- sign in
  router.get('/login', (req, res) => {
    if (req.staff) return res.redirect('/staff');
    res.page('staff/login', { title: 'Staff sign-in', next: safeReturn(req.query.next, ''), username: '', error: null });
  });

  router.post('/login', loginLimiter, async (req, res, next) => {
    const username = String(req.body.username || '').trim().slice(0, 64);
    const nextUrl = safeReturn(req.body.next, '');
    const user = await staffSvc.authenticate(req.db, username, String(req.body.password || '').slice(0, 200));
    if (!user) {
      return res.page('staff/login', { title: 'Staff sign-in', next: nextUrl, username, error: 'Wrong username or password.' }, 401);
    }
    // New session id on sign-in (prevents session fixation); keep the attendee's remembered tickets.
    const tickets = req.session.tickets;
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.staffId = user.id;
      if (tickets) req.session.tickets = tickets;
      res.redirect(303, nextUrl || '/staff');
    });
  });

  router.post('/logout', (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('sid');
      res.redirect(303, '/staff/login');
    });
  });

  // Everything below requires a signed-in staff member.
  router.use(requireStaff);

  router.get('/', (req, res) => res.redirect(req.staff.role === 'organizer' ? '/staff/dashboard' : '/staff/checkin'));

  // ------------------------------------------------- check-in (both roles)
  router.get('/checkin', (req, res) => {
    res.page('staff/checkin-select', { title: 'Check-in', events: events.listCheckinEvents(req.db, req.now) });
  });

  function loadCheckinEvent(req) {
    const ev = events.getEvent(req.db, req.params.id, req.now);
    if (!ev || ev.status === 'draft') throw new AppError('NOT_FOUND', 'Event not found.', { status: 404 });
    return ev;
  }

  function renderCheckin(req, res, ev, result = null, status = 200) {
    res.page(
      'staff/checkin',
      {
        title: `Check-in · ${ev.title}`,
        ev,
        result,
        stats: checkin.stats(req.db, ev.id),
        recent: checkin.recentCheckins(req.db, ev.id),
      },
      status
    );
  }

  router.get('/events/:id/checkin', (req, res) => renderCheckin(req, res, loadCheckinEvent(req)));

  // Plain form fallback (works without JavaScript, e.g. a USB scanner that types + Enter).
  router.post('/events/:id/checkin', checkinLimiter, (req, res) => {
    const ev = loadCheckinEvent(req);
    const result = checkin.checkIn(req.db, ev.id, req.body.code, req.staff, req.now);
    renderCheckin(req, res, events.getEvent(req.db, ev.id, req.now), result);
  });

  router.post('/api/events/:id/checkin', checkinLimiter, (req, res) => {
    const ev = loadCheckinEvent(req);
    const result = checkin.checkIn(req.db, ev.id, req.body.code, req.staff, req.now);
    res.json({ ...result, recent: checkin.recentCheckins(req.db, ev.id) });
  });

  router.get('/api/events/:id/stats', (req, res) => {
    const ev = loadCheckinEvent(req);
    res.json({ stats: checkin.stats(req.db, ev.id), recent: checkin.recentCheckins(req.db, ev.id) });
  });

  router.post('/api/registrations/:id/undo-checkin', (req, res) => {
    const out = checkin.undoCheckIn(req.db, req.params.id, req.staff, req.now);
    res.json({ ok: true, name: out.registration.full_name, code: out.registration.ticket_code, stats: out.stats, recent: checkin.recentCheckins(req.db, out.registration.event_id) });
  });

  router.post('/registrations/:id/undo-checkin', (req, res) => {
    const reg = regs.getRegistration(req.db, req.params.id);
    const back = safeReturn(req.body.return_to, reg ? `/staff/events/${reg.event_id}/checkin` : '/staff');
    try {
      const out = checkin.undoCheckIn(req.db, req.params.id, req.staff, req.now);
      req.flash('success', `Check-in undone for ${out.registration.full_name} (${out.registration.ticket_code}). They can be checked in again.`);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      req.flash('error', err.message);
    }
    res.redirect(303, back);
  });

  // ------------------------------------------------------- organizer only
  router.use(requireRole('organizer'));

  router.get('/dashboard', (req, res) => {
    res.page('staff/dashboard', { title: 'Dashboard', events: events.listUpcomingEvents(req.db, req.now) });
  });

  router.get('/events', (req, res) => {
    res.page('staff/events', { title: 'Events', events: events.listAllEvents(req.db, req.now) });
  });

  function renderEventForm(res, { ev = null, values, errors = {}, status = 200 }) {
    res.page('staff/event-form', { title: ev ? `Edit · ${ev.title}` : 'New event', ev, values, errors }, status);
  }

  router.get('/events/new', (req, res) => {
    renderEventForm(res, {
      values: { title: '', description: '', venue: '', date: addDays(manilaDateString(req.now), 7), startTime: '18:00', endTime: '21:00', capacity: '30', status: 'draft' },
    });
  });

  function formValues(body) {
    return {
      title: body.title || '',
      description: body.description || '',
      venue: body.venue || '',
      date: body.date || '',
      startTime: body.start_time || '',
      endTime: body.end_time || '',
      capacity: body.capacity || '',
      status: body.status || '',
    };
  }

  router.post('/events', (req, res) => {
    try {
      const id = events.createEvent(req.db, req.body, req.staff, req.now);
      req.flash('success', 'Event created.');
      res.redirect(303, `/staff/events/${id}/attendees`);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      renderEventForm(res, { values: formValues(req.body), errors: err.errors, status: 422 });
    }
  });

  router.get('/events/:id/edit', (req, res) => {
    const ev = events.getEvent(req.db, req.params.id, req.now);
    if (!ev) throw new AppError('NOT_FOUND', 'Event not found.', { status: 404 });
    renderEventForm(res, { ev, values: events.formValuesFromEvent(ev) });
  });

  router.post('/events/:id', (req, res) => {
    const ev = events.getEvent(req.db, req.params.id, req.now);
    if (!ev) throw new AppError('NOT_FOUND', 'Event not found.', { status: 404 });
    try {
      events.updateEvent(req.db, ev.id, req.body, req.staff, req.now);
      req.flash('success', 'Event saved.');
      res.redirect(303, `/staff/events/${ev.id}/attendees`);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      renderEventForm(res, { ev, values: formValues(req.body), errors: err.errors, status: 422 });
    }
  });

  router.post('/events/:id/status', (req, res) => {
    const ev = events.setEventStatus(req.db, req.params.id, String(req.body.status || ''), req.staff, req.now);
    req.flash('success', `"${ev.title}" is now ${req.body.status === 'published' ? 'published' : 'closed'}.`);
    res.redirect(303, safeReturn(req.body.return_to, '/staff/events'));
  });

  router.get('/events/:id/attendees', (req, res) => {
    const ev = events.getEvent(req.db, req.params.id, req.now);
    if (!ev) throw new AppError('NOT_FOUND', 'Event not found.', { status: 404 });
    const q = String(req.query.q || '').slice(0, 100);
    const status = regs.STATUS_FILTERS.includes(req.query.status) ? req.query.status : '';
    res.page('staff/attendees', { title: `Attendees · ${ev.title}`, ev, rows: regs.listRegistrations(req.db, ev.id, { q, status }), q, status });
  });

  router.get('/events/:id/attendees.csv', (req, res) => {
    const ev = events.getEvent(req.db, req.params.id, req.now);
    if (!ev) throw new AppError('NOT_FOUND', 'Event not found.', { status: 404 });
    const rows = regs.listRegistrations(req.db, ev.id);
    const statusLabel = res.locals.statusLabel;
    const header = ['Ticket code', 'Full name', 'Email', 'Mobile', 'Status', 'Waitlist position', 'Registered at', 'Checked in at', 'Checked in by', 'Cancelled at'];
    const lines = [header.map(csvCell).join(',')];
    for (const r of rows) {
      lines.push(
        [
          csvCell(r.ticket_code),
          csvCell(r.full_name),
          csvCell(r.email),
          // Written as ="09171234567" so Excel keeps the leading zero. Safe: mobile is validated as 11 digits.
          /^\d{1,15}$/.test(r.mobile) ? `"=""${r.mobile}"""` : csvCell(r.mobile),
          csvCell(statusLabel(r.status)),
          csvCell(r.waitlist_position || ''),
          csvCell(formatDateTime(r.registered_at)),
          csvCell(formatDateTime(r.checked_in_at)),
          csvCell(r.checked_in_by_name || ''),
          csvCell(formatDateTime(r.cancelled_at)),
        ].join(',')
      );
    }
    const filename = `${ev.code_prefix}-attendees-${ev.starts_at.slice(0, 10)}.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('﻿' + lines.join('\r\n') + '\r\n'); // BOM so Excel reads UTF-8 (ñ, é...)
  });

  router.post('/events/:id/promote', (req, res) => {
    const back = `/staff/events/${Number(req.params.id) || 0}/attendees`;
    try {
      const reg = regs.promoteNext(req.db, req.params.id, req.staff, req.now);
      const ev = events.getEvent(req.db, reg.event_id, req.now);
      req.app.locals.mailer.queue('promotion', reg, ev);
      req.flash('success', `${reg.full_name} (${reg.ticket_code}) moved from the waitlist to confirmed. A confirmation email is on its way.`);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      req.flash('error', err.message);
    }
    res.redirect(303, back);
  });

  router.post('/registrations/:id/cancel', (req, res) => {
    const reg = regs.getRegistration(req.db, req.params.id);
    if (!reg) throw new AppError('NOT_FOUND', 'Registration not found.', { status: 404 });
    try {
      regs.cancelRegistration(req.db, reg.id, { staff: req.staff }, req.now);
      req.flash('success', `Cancelled ${reg.full_name} (${reg.ticket_code}).`);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      req.flash('error', err.message);
    }
    res.redirect(303, safeReturn(req.body.return_to, `/staff/events/${reg.event_id}/attendees`));
  });

  // ------------------------------------------------------------ audit log
  router.get('/audit', (req, res) => {
    const eventId = Number(req.query.event) || null;
    const action = Object.keys(ACTION_LABELS).includes(req.query.action) ? req.query.action : '';
    const where = [];
    const params = [];
    if (eventId) {
      where.push('a.event_id = ?');
      params.push(eventId);
    }
    if (action) {
      where.push('a.action = ?');
      params.push(action);
    }
    const rows = req.db
      .prepare(
        `SELECT a.*, e.title AS event_title FROM audit_logs a LEFT JOIN events e ON e.id = a.event_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT 300`
      )
      .all(...params);
    res.page('staff/audit', { title: 'Audit log', rows, actions: ACTION_LABELS, action, eventId, events: events.listAllEvents(req.db, req.now) });
  });

  // ---------------------------------------------------------- staff users
  function renderUsers(req, res, { values = { name: '', username: '', role: 'door' }, errors = {}, status = 200 } = {}) {
    res.page('staff/users', { title: 'Staff accounts', users: staffSvc.listStaff(req.db), values, errors }, status);
  }

  router.get('/users', (req, res) => renderUsers(req, res));

  router.post('/users', (req, res) => {
    try {
      staffSvc.createStaff(req.db, req.body, req.staff, req.now);
      req.flash('success', `Account @${String(req.body.username).trim().toLowerCase()} created.`);
      res.redirect(303, '/staff/users');
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      renderUsers(req, res, { values: { name: req.body.name || '', username: req.body.username || '', role: req.body.role || 'door' }, errors: err.errors, status: 422 });
    }
  });

  router.post('/users/:id/active', (req, res) => {
    try {
      staffSvc.setStaffActive(req.db, req.params.id, req.body.active === '1', req.staff, req.now);
      req.flash('success', 'Account updated.');
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      req.flash('error', err.message);
    }
    res.redirect(303, '/staff/users');
  });

  // --------------------------------------------------------- email outbox
  router.get('/outbox', (req, res) => {
    const rows = req.db.prepare('SELECT id, kind, to_address, subject, status, error, created_at FROM email_outbox ORDER BY id DESC LIMIT 100').all();
    res.page('staff/outbox', { title: 'Email outbox', rows, smtpConfigured: req.app.locals.mailer.smtpConfigured, selected: null });
  });

  router.get('/outbox/:id', (req, res) => {
    const rows = req.db.prepare('SELECT id, kind, to_address, subject, status, error, created_at FROM email_outbox ORDER BY id DESC LIMIT 100').all();
    const selected = req.db.prepare('SELECT id, kind, to_address, subject, status, error, created_at FROM email_outbox WHERE id = ?').get(Number(req.params.id) || 0);
    if (!selected) throw new AppError('NOT_FOUND', 'Email not found.', { status: 404 });
    res.page('staff/outbox', { title: 'Email outbox', rows, smtpConfigured: req.app.locals.mailer.smtpConfigured, selected });
  });

  // The email body, shown inside a sandboxed iframe with its own strict CSP.
  router.get('/outbox/:id/raw', (req, res) => {
    const row = req.db.prepare('SELECT html FROM email_outbox WHERE id = ?').get(Number(req.params.id) || 0);
    if (!row) throw new AppError('NOT_FOUND', 'Email not found.', { status: 404 });
    res.set({
      'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'",
      'X-Frame-Options': 'SAMEORIGIN',
    });
    res.type('html').send(row.html);
  });

  return router;
};
