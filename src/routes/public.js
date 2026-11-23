'use strict';

const express = require('express');
const QRCode = require('qrcode');

const { AppError, ValidationError } = require('../lib/errors');
const { rateLimit } = require('../lib/rateLimit');
const { verifyTicketAccessToken, normalizeTicketCode } = require('../lib/tickets');
const events = require('../services/events');
const regs = require('../services/registrations');

const MAX_REMEMBERED_TICKETS = 20;

/** Tickets this browser has proven it may see (by registering, or by code + email lookup). */
function rememberTicket(req, regId) {
  const list = (req.session.tickets || []).filter((id) => id !== regId);
  list.push(regId);
  req.session.tickets = list.slice(-MAX_REMEMBERED_TICKETS);
}

function canViewTicket(req, regId) {
  return Array.isArray(req.session.tickets) && req.session.tickets.includes(regId);
}

function tooMany(req, res, retryAfter) {
  res.page('error', { title: 'Too many attempts', heading: 'Too many attempts', message: `Please wait about ${retryAfter} seconds and try again.` }, 429);
}

module.exports = function publicRoutes(config) {
  const router = express.Router();
  const registerLimiter = rateLimit({ ...config.rateLimits.register, onLimit: tooMany });
  const lookupLimiter = rateLimit({ ...config.rateLimits.lookup, onLimit: tooMany });

  router.use((req, res, next) => {
    req.db = req.app.locals.db;
    req.now = config.now();
    next();
  });

  // ---------------------------------------------------------------- events
  router.get('/', async (req, res) => {
    res.page('public/events', {
      title: 'Upcoming events',
      events: await events.listPublicEvents(req.db, req.now),
      pastEvents: await events.listPastPublicEvents(req.db, req.now),
    });
  });

  async function loadPublicEvent(req) {
    const ev = await events.getEvent(req.db, req.params.id, req.now);
    // Drafts are invisible to attendees, even by URL.
    if (!ev || ev.status === 'draft') throw new AppError('NOT_FOUND', 'This event does not exist or is not open to the public.', { status: 404 });
    return ev;
  }

  router.get('/events/:id', async (req, res) => {
    const ev = await loadPublicEvent(req);
    res.page('public/event', { title: ev.title, ev });
  });

  function renderRegister(res, ev, { values = {}, errors = {}, formError = null, waitlist = false, status = 200, duplicate = false } = {}) {
    res.page('public/register', { title: `Register · ${ev.title}`, ev, values, errors, formError, waitlist, duplicate }, status);
  }

  router.get('/events/:id/register', async (req, res) => {
    const ev = await loadPublicEvent(req);
    if (!ev.registrationOpen) return res.redirect(`/events/${ev.id}`);
    renderRegister(res, ev, { waitlist: ev.isFull });
  });

  router.post('/events/:id/register', registerLimiter, async (req, res) => {
    const ev = await loadPublicEvent(req);
    const joinWaitlist = req.body.waitlist === '1';
    const values = { full_name: req.body.full_name || '', email: req.body.email || '', mobile: req.body.mobile || '' };
    let reg;
    try {
      reg = await regs.register(req.db, ev.id, req.body, { joinWaitlist }, req.now);
    } catch (err) {
      const fresh = await events.getEvent(req.db, ev.id, req.now);
      if (err instanceof ValidationError) return renderRegister(res, fresh, { values, errors: err.errors, waitlist: joinWaitlist || fresh.isFull, status: 422 });
      if (err instanceof AppError && err.code === 'FULL') {
        return renderRegister(res, fresh, { values, formError: 'Sorry, the last spot was just taken. You can join the waitlist below with the same details.', waitlist: true, status: 409 });
      }
      if (err instanceof AppError && err.code === 'DUPLICATE') {
        return renderRegister(res, fresh, { values, formError: err.message, duplicate: true, waitlist: joinWaitlist || fresh.isFull, status: 409 });
      }
      if (err instanceof AppError && (err.code === 'ENDED' || err.code === 'CLOSED')) {
        req.flash('error', err.message);
        return res.redirect(303, `/events/${ev.id}`);
      }
      throw err;
    }

    rememberTicket(req, reg.id);
    const mailer = req.app.locals.mailer;
    if (reg.status === 'waitlisted') mailer.queue('waitlist', reg, ev, { waitlistPosition: await regs.waitlistPosition(req.db, reg) });
    else mailer.queue('registration', reg, ev);
    req.session.justRegistered = reg.id;
    res.redirect(303, `/tickets/${reg.ticket_code}`);
  });

  // --------------------------------------------------------------- tickets
  router.get('/tickets/find', (req, res) => {
    res.page('public/find-ticket', { title: 'Find my ticket', values: { code: String(req.query.code || '').slice(0, 32), contact: '' }, notFound: false });
  });

  router.post('/tickets/find', lookupLimiter, async (req, res) => {
    const code = String(req.body.code || '').trim().slice(0, 32);
    const contact = String(req.body.contact || '').trim().slice(0, 254);
    const reg = await regs.lookupTicket(req.db, code, contact);
    if (!reg) {
      // Same answer whether the code, the email or both are wrong: reveal nothing.
      return res.page('public/find-ticket', { title: 'Find my ticket', values: { code, contact }, notFound: true }, 404);
    }
    rememberTicket(req, reg.id);
    res.redirect(303, `/tickets/${reg.ticket_code}`);
  });

  router.get('/tickets/:code', async (req, res) => {
    const code = normalizeTicketCode(req.params.code);
    const reg = code ? await regs.getRegistrationByCode(req.db, code) : null;
    const secret = req.app.locals.config.sessionSecret;

    // Email links carry a signed token. Accept it once, then drop it from the URL.
    if (reg && req.query.t && verifyTicketAccessToken(secret, reg.ticket_code, String(req.query.t))) {
      rememberTicket(req, reg.id);
      return res.redirect(`/tickets/${reg.ticket_code}`);
    }
    if (!reg || !canViewTicket(req, reg.id)) {
      return res.redirect(`/tickets/find?code=${encodeURIComponent(String(req.params.code).slice(0, 32))}`);
    }

    const ev = await events.getEvent(req.db, reg.event_id, req.now);
    const hasQr = reg.status === 'confirmed' || reg.status === 'checked_in';
    const qrSvg = hasQr ? await QRCode.toString(reg.ticket_code, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) : null;
    const justRegistered = req.session.justRegistered === reg.id;
    delete req.session.justRegistered;
    res.page('public/ticket', {
      title: `Ticket ${reg.ticket_code}`,
      reg,
      ev,
      qrSvg,
      justRegistered,
      emailSent: req.app.locals.mailer.smtpConfigured,
      waitlistPosition: await regs.waitlistPosition(req.db, reg),
      canCancel: (reg.status === 'confirmed' || reg.status === 'waitlisted') && !ev.hasEnded,
    });
  });

  router.post('/tickets/:code/cancel', async (req, res) => {
    const reg = await regs.getRegistrationByCode(req.db, req.params.code);
    if (!reg || !canViewTicket(req, reg.id)) throw new AppError('NOT_FOUND', 'Ticket not found.', { status: 404 });
    try {
      await regs.cancelRegistration(req.db, reg.id, {}, req.now);
      req.flash('success', 'Your registration is cancelled. Thanks for letting us know — your spot is now free for someone else.');
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      req.flash('error', err.message);
    }
    res.redirect(303, `/tickets/${reg.ticket_code}`);
  });

  return router;
};
