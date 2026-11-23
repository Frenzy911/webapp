'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTicketCode, prefixFromTitle, generateTicketCode, verifyTicketAccessToken, ticketAccessToken } = require('../src/lib/tickets');
const { validateRegistration, normalizeMobile } = require('../src/lib/validation');
const time = require('../src/lib/time');

describe('ticket codes', () => {
  it('builds a prefix from the event title', () => {
    assert.equal(prefixFromTitle('Cebu Dev Meetup 2026'), 'CDM');
    assert.equal(prefixFromTitle('Cebu Hackathon Kickoff Night'), 'CHKN');
    assert.equal(prefixFromTitle('2026'), 'EVT');
  });

  it('generates 8 random Crockford base32 characters', () => {
    const seen = new Set();
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

  it('verifies email-link tokens', () => {
    const tok = ticketAccessToken('s3cret', 'CDM-7K3P9QXM');
    assert.equal(tok.length, 32);
    assert.ok(verifyTicketAccessToken('s3cret', 'CDM-7K3P9QXM', tok));
    assert.ok(!verifyTicketAccessToken('s3cret', 'CDM-7K3P9QXN', tok));
    assert.ok(!verifyTicketAccessToken('other', 'CDM-7K3P9QXM', tok));
    assert.ok(!verifyTicketAccessToken('s3cret', 'CDM-7K3P9QXM', undefined));
  });
});

describe('registration validation', () => {
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
});

describe('Cebu time', () => {
  it('stores ISO strings with +08:00 and formats 12-hour times', () => {
    const d = new Date('2026-12-05T10:30:00Z'); // 6:30 PM in Cebu
    assert.equal(time.toManilaIso(d), '2026-12-05T18:30:00+08:00');
    assert.equal(time.manilaDateString(new Date('2026-12-05T17:00:00Z')), '2026-12-06', 'after 4 PM UTC it is already tomorrow in Cebu');
    assert.equal(time.formatTime('2026-12-05T18:30:00+08:00'), '6:30 PM');
    assert.equal(time.formatDate('2026-12-05T18:30:00+08:00'), 'Sat, Dec 5, 2026');
    assert.equal(time.formatTimeRange('2026-12-05T18:00:00+08:00', '2026-12-05T21:00:00+08:00'), '6:00 PM – 9:00 PM');
    assert.equal(time.fromLocalParts('2026-02-31', '10:00'), null);
    assert.equal(time.fromLocalParts('2026-12-05', '09:05'), '2026-12-05T09:05:00+08:00');
  });
});
