'use strict';

const path = require('node:path');
const ejs = require('ejs');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const { toManilaIso, formatDate, formatTimeRange } = require('./time');
const { ticketAccessToken } = require('./tickets');

const TEMPLATE = path.join(__dirname, '..', 'views', 'emails', 'ticket.ejs');

const SUBJECTS = {
  registration: (ev, reg) => `Your ticket for ${ev.title} · ${reg.ticket_code}`,
  waitlist: (ev) => `You're on the waitlist for ${ev.title}`,
  promotion: (ev, reg) => `Good news: you have a spot at ${ev.title} · ${reg.ticket_code}`,
};

/**
 * Sends ticket emails through SMTP (Mailtrap, Ethereal, Resend test mode...) when SMTP_HOST
 * is set. Every email is also saved to the email_outbox table so organizers can preview it;
 * without SMTP settings that outbox is the only destination (handy for local testing).
 */
function createMailer(config, db) {
  const transport = config.smtp.host
    ? nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      })
    : null;

  const insert = db.prepare(
    'INSERT INTO email_outbox (kind, registration_id, to_address, subject, html, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  async function sendTicketEmail(kind, reg, ev, extra = {}) {
    const ticketUrl = `${config.baseUrl}/tickets/${reg.ticket_code}?t=${ticketAccessToken(config.sessionSecret, reg.ticket_code)}`;
    const showQr = kind !== 'waitlist';
    const qrPng = showQr ? await QRCode.toBuffer(reg.ticket_code, { width: 280, margin: 2, errorCorrectionLevel: 'M' }) : null;
    const locals = {
      kind,
      reg,
      ev,
      ticketUrl,
      dateLabel: formatDate(ev.starts_at),
      timeLabel: formatTimeRange(ev.starts_at, ev.ends_at),
      waitlistPosition: extra.waitlistPosition || null,
    };
    const subject = SUBJECTS[kind](ev, reg);
    const html = await ejs.renderFile(TEMPLATE, { ...locals, qrSrc: 'cid:ticket-qr' });
    const previewHtml = await ejs.renderFile(TEMPLATE, { ...locals, qrSrc: qrPng ? `data:image/png;base64,${qrPng.toString('base64')}` : '' });

    let status = 'saved';
    let error = null;
    if (transport) {
      try {
        await transport.sendMail({
          from: config.mailFrom,
          to: `"${reg.full_name.replace(/"/g, '')}" <${reg.email}>`,
          subject,
          html,
          text: `${subject}\n\n${ev.title}\n${locals.dateLabel}, ${locals.timeLabel}\n${ev.venue}\n\nTicket code: ${reg.ticket_code}\nView your ticket: ${ticketUrl}`,
          attachments: qrPng ? [{ filename: `${reg.ticket_code}.png`, content: qrPng, cid: 'ticket-qr' }] : [],
        });
        status = 'sent';
      } catch (err) {
        status = 'failed';
        error = err.message;
        console.error(`[mail] ${kind} email to registration ${reg.id} failed: ${err.message}`);
      }
    }
    insert.run(kind, reg.id, reg.email, subject, previewHtml, status, error, toManilaIso(new Date()));
    return status;
  }

  /** Fire-and-forget: a mail problem must never break registration or promotion. */
  function queue(kind, reg, ev, extra) {
    sendTicketEmail(kind, reg, ev, extra).catch((err) => console.error('[mail] unexpected error', err));
  }

  return { sendTicketEmail, queue, smtpConfigured: Boolean(transport) };
}

module.exports = { createMailer };
