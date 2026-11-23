import 'server-only';
import { after } from 'next/server';
import nodemailer from 'nodemailer';
import QRCode from 'qrcode';
import { db } from './supabase/admin';
import { env } from './env';
import { ticketAccessToken } from './tickets';
import { formatDate, formatTimeRange } from './time';
import type { EventRow, Registration } from './types';

export type EmailKind = 'registration' | 'waitlist' | 'promotion';

const SUBJECTS: Record<EmailKind, (ev: EventRow, reg: Registration) => string> = {
  registration: (ev, reg) => `Your ticket for ${ev.title} · ${reg.ticket_code}`,
  waitlist: (ev) => `You're on the waitlist for ${ev.title}`,
  promotion: (ev, reg) => `Good news: you have a spot at ${ev.title} · ${reg.ticket_code}`,
};

export function smtpConfigured(): boolean {
  return Boolean(env.smtp.host);
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

type TemplateData = { kind: EmailKind; reg: Registration; ev: EventRow; ticketUrl: string; qrSrc: string; waitlistPosition: number | null };

/** Table-based HTML so it renders in Gmail, Outlook and phone mail apps. */
export function ticketEmailHtml({ kind, reg, ev, ticketUrl, qrSrc, waitlistPosition }: TemplateData): string {
  const brand = '#5935cf';
  const heading = kind === 'waitlist' ? "You're on the waitlist" : kind === 'promotion' ? 'Your spot is confirmed' : 'Your ticket';
  const intro =
    kind === 'registration'
      ? "You're registered. Show this QR code at the door to check in."
      : kind === 'promotion'
        ? "<strong>Good news: a spot opened up and you've been moved off the waitlist.</strong> Your ticket is now confirmed. Show this QR code at the door."
        : `The event is full, so you're on the waitlist${waitlistPosition ? ` at position #${waitlistPosition}` : ''}. <strong>This is not a confirmed ticket.</strong> If a spot opens, we'll email you your QR ticket.`;
  const qr = qrSrc
    ? `<div style="text-align:center;margin:8px 0 20px;">
        <img src="${esc(qrSrc)}" width="220" height="220" alt="QR code for ticket ${esc(reg.ticket_code)}" style="display:inline-block;border:1px solid #e4e0f2;border-radius:8px;">
        <div style="font-family:Consolas,Menlo,monospace;font-size:22px;font-weight:700;letter-spacing:.06em;margin-top:8px;">${esc(reg.ticket_code)}</div>
      </div>`
    : '';
  const row = (label: string, value: string, mono = false) =>
    `<tr><td style="padding:8px 0;color:#5f5b70;width:90px;">${label}</td><td style="padding:8px 0;${mono ? 'font-family:Consolas,Menlo,monospace;' : ''}">${value}</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(ev.title)}</title></head>
<body style="margin:0;padding:0;background:#f8f7fc;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d1a2b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f7fc;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e4e0f2;">
        <tr><td style="background:${brand};color:#ffffff;padding:20px 24px;">
          <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.85;">${heading}</div>
          <div style="font-size:22px;font-weight:700;margin-top:4px;">${esc(ev.title)}</div>
        </td></tr>
        <tr><td style="padding:24px;">
          <p style="margin:0 0 16px;font-size:16px;">Hi ${esc(reg.full_name)},</p>
          <p style="margin:0 0 16px;font-size:16px;">${intro}</p>
          ${qr}
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:15px;border-top:1px solid #ece9f5;">
            ${row('Date', esc(formatDate(ev.starts_at)))}
            ${row('Time', `${esc(formatTimeRange(ev.starts_at, ev.ends_at))} (Cebu time)`)}
            ${row('Venue', esc(ev.venue))}
            ${row(kind === 'waitlist' ? 'Reference' : 'Ticket code', esc(reg.ticket_code), true)}
          </table>
          <p style="margin:24px 0 8px;text-align:center;">
            <a href="${esc(ticketUrl)}" style="display:inline-block;background:${brand};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px;">${kind === 'waitlist' ? 'View my waitlist status' : 'Open my ticket'}</a>
          </p>
          <p style="margin:16px 0 0;font-size:13px;color:#5f5b70;">You can also find your ticket any time with your ticket code and this email address. Can't make it? Open your ticket and cancel so someone on the waitlist can take your spot.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Send a ticket email through SMTP (Mailtrap, Resend, Brevo, or Mailpit locally) when SMTP_HOST is set.
 * Every email is also saved to email_outbox so organizers can preview it; without SMTP settings that
 * outbox is the only destination.
 */
export async function sendTicketEmail(kind: EmailKind, reg: Registration, ev: EventRow, extra: { waitlistPosition?: number | null } = {}) {
  const ticketUrl = `${env.baseUrl}/tickets/${reg.ticket_code}/open?t=${ticketAccessToken(env.ticketSecret, reg.ticket_code)}`;
  const qrPng = kind !== 'waitlist' ? await QRCode.toBuffer(reg.ticket_code, { width: 280, margin: 2, errorCorrectionLevel: 'M' }) : null;
  const subject = SUBJECTS[kind](ev, reg);
  const base = { kind, reg, ev, ticketUrl, waitlistPosition: extra.waitlistPosition ?? null };
  const html = ticketEmailHtml({ ...base, qrSrc: qrPng ? 'cid:ticket-qr' : '' });
  const previewHtml = ticketEmailHtml({ ...base, qrSrc: qrPng ? `data:image/png;base64,${qrPng.toString('base64')}` : '' });

  let status: 'saved' | 'sent' | 'failed' = 'saved';
  let error: string | null = null;
  const smtp = env.smtp;
  if (smtp.host) {
    try {
      const transport = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      });
      await transport.sendMail({
        from: env.mailFrom,
        to: { name: reg.full_name.replace(/"/g, ''), address: reg.email },
        subject,
        html,
        text: `${subject}\n\n${ev.title}\n${formatDate(ev.starts_at)}, ${formatTimeRange(ev.starts_at, ev.ends_at)}\n${ev.venue}\n\nTicket code: ${reg.ticket_code}\nView your ticket: ${ticketUrl}`,
        attachments: qrPng ? [{ filename: `${reg.ticket_code}.png`, content: qrPng, cid: 'ticket-qr' }] : [],
      });
      status = 'sent';
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
      console.error(`[mail] ${kind} email to registration ${reg.id} failed: ${error}`);
    }
  }
  const { error: dbError } = await db()
    .from('email_outbox')
    .insert({ kind, registration_id: reg.id, to_address: reg.email, subject, html: previewHtml, status, error });
  if (dbError) console.error(`[mail] could not save to outbox: ${dbError.message}`);
  return status;
}

/** Send after the response is finished, so a slow or broken mail server never delays or breaks registration. */
export function queueTicketEmail(...args: Parameters<typeof sendTicketEmail>): void {
  after(() => sendTicketEmail(...args).catch((err) => console.error('[mail] unexpected error', err)));
}
