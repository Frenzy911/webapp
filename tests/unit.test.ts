import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { normalizeTicketCode, prefixFromTitle, generateTicketCode, verifyTicketAccessToken, ticketAccessToken } from '../src/lib/tickets';
import { validateRegistration, normalizeMobile, validateEvent, validateStaffUser } from '../src/lib/validation';
import * as time from '../src/lib/time';
import { dbErrorCode } from '../src/lib/errors';

describe('ticket codes', () => {
  it('builds a prefix from the event title', () => {
    assert.equal(prefixFromTitle('Cebu Dev Meetup 2026'), 'CDM');
    assert.equal(prefixFromTitle('Cebu Hackathon Kickoff Night'), 'CHKN');
    assert.equal(prefixFromTitle('2026'), 'EVT');
  });

  it('generates 8 random Crockford base32 characters', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const c = generateTicketCode('CDM');
      assert.match(c, /^CDM-[0-9A-HJKMNP-TV-Z]{8}$/);
      seen.add(c);
    }
    assert.equal(seen.size, 2000);
  });

  it('normalises what staff type or scan', () => {
    assert.equal(normalizeTicketCode(' cdm-7k3p9qxm '), 'CDM-7K3P9QXM');
    assert.equal(normalizeTicketCode('CDM 7K3P 9QXM'), 'CDM-7K3P9QXM');
    assert.equal(normalizeTicketCode('CDM7K3P9QXM'), 'CDM-7K3P9QXM');
    assert.equal(normalizeTicketCode('CDM-7K3P9QXO'), 'CDM-7K3P9QX0', 'O is read as zero');
    assert.equal(normalizeTicketCode('CDM-7K3P9QXL'), 'CDM-7K3P9QX1', 'L is read as one');
    assert.equal(normalizeTicketCode('CDM-7K3P9QXU'), null, 'U is never used');
    assert.equal(normalizeTicketCode('CDM-000001'), null, 'too short');
    assert.equal(normalizeTicketCode('<script>'), null);
    assert.equal(normalizeTicketCode(''), null);
  });

  it('draws a QR that the camera decoder reads back as the exact ticket code', () => {
    const code = generateTicketCode('CDM');
    // Rasterise the QR the ticket page draws and decode it with jsQR, the library the check-in camera uses.
    const qr = QRCode.create(code, { errorCorrectionLevel: 'M' });
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
    assert.equal(jsQR(data, px, px)?.data, code);
  });

  it('verifies email-link tokens', () => {
    const tok = ticketAccessToken('s3cret', 'CDM-7K3P9QXM');
    assert.equal(tok.length, 32);
    assert.ok(verifyTicketAccessToken('s3cret', 'CDM-7K3P9QXM', tok));
    assert.ok(!verifyTicketAccessToken('s3cret', 'CDM-7K3P9QXN', tok));
    assert.ok(!verifyTicketAccessToken('other', 'CDM-7K3P9QXM', tok));
    assert.ok(!verifyTicketAccessToken('s3cret', 'CDM-7K3P9QXM', undefined));
  });
});

describe('validation', () => {
  it('accepts Philippine mobile formats and normalises them', () => {
    assert.equal(normalizeMobile('0917 123 4567'), '09171234567');
    assert.equal(normalizeMobile('0917-123-4567'), '09171234567');
    assert.equal(normalizeMobile('+63 917 123 4567'), '09171234567');
  });

  it('requires an 11-digit mobile starting with 09 and a valid email', () => {
    const bad = validateRegistration({ full_name: 'Ana', email: 'ana@', mobile: '0917123456' });
    assert.ok(!bad.ok);
    assert.ok(bad.errors.email);
    assert.ok(bad.errors.mobile);
    assert.ok(validateRegistration({ full_name: 'Ana', email: 'ana@example.com', mobile: '08171234567' }).errors.mobile);
    const good = validateRegistration({ full_name: '  Ana   Reyes ', email: ' Ana@Example.COM ', mobile: '09171234567' });
    assert.ok(good.ok);
    assert.deepEqual(good.values, { fullName: 'Ana Reyes', email: 'ana@example.com', mobile: '09171234567' });
  });

  it('blocks an event that ends before it starts, and capacity below 1', () => {
    const base = { title: 'T', venue: 'V', date: '2026-12-05', start_time: '18:00', end_time: '09:00', capacity: '10', status: 'draft' };
    assert.equal(validateEvent(base).errors.end_time, 'End time must be after the start time.');
    assert.match(validateEvent({ ...base, end_time: '21:00', capacity: '0' }).errors.capacity, /at least 1/);
    const ok = validateEvent({ ...base, end_time: '21:00' });
    assert.ok(ok.ok);
    assert.equal(ok.data.startsAt, '2026-12-05T18:00:00+08:00');
  });

  it('checks new staff accounts', () => {
    const bad = validateStaffUser({ name: '', email: 'nope', password: 'short', role: 'boss' });
    assert.deepEqual(Object.keys(bad.errors).sort(), ['email', 'name', 'password', 'role']);
    assert.ok(validateStaffUser({ name: 'Dario', email: 'Dario@Example.com', password: 'long-enough', role: 'door' }).ok);
  });
});

describe('Cebu time', () => {
  it('formats instants in Cebu time, 12-hour', () => {
    const d = new Date('2026-12-05T10:30:00Z'); // 6:30 PM in Cebu
    assert.equal(time.toManilaIso(d), '2026-12-05T18:30:00+08:00');
    assert.equal(time.manilaDateString(new Date('2026-12-05T17:00:00Z')), '2026-12-06', 'after 4 PM UTC it is already tomorrow in Cebu');
    assert.equal(time.formatTime('2026-12-05T10:30:00+00:00'), '6:30 PM', 'database times come back in UTC');
    assert.equal(time.formatDate('2026-12-05T18:30:00+08:00'), 'Sat, Dec 5, 2026');
    assert.equal(time.formatTimeRange('2026-12-05T18:00:00+08:00', '2026-12-05T21:00:00+08:00'), '6:00 PM – 9:00 PM');
    assert.equal(time.fromLocalParts('2026-02-31', '10:00'), null);
    assert.equal(time.fromLocalParts('2026-12-05', '09:05'), '2026-12-05T09:05:00+08:00');
    assert.deepEqual(time.toLocalParts('2026-12-05T10:30:00+00:00'), { date: '2026-12-05', time: '18:30' });
  });
});

describe('database error codes', () => {
  it('reads raised codes and unique violations', () => {
    assert.equal(dbErrorCode({ code: 'P0001', message: 'FULL' }), 'FULL');
    assert.equal(dbErrorCode({ code: '23505', message: 'duplicate key value violates unique constraint "ux_registrations_active_email"' }), 'UNIQUE:ux_registrations_active_email');
    assert.equal(dbErrorCode({ code: '42P01', message: 'nope' }), null);
    assert.equal(dbErrorCode(null), null);
  });
});
