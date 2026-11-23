'use strict';

/**
 * Demo data. Dates are relative to "today" in Cebu so the demo always works:
 *  - Cebu Dev Meetup 2026 is today (so check-in works right away), 18 of 30 registered.
 *  - Cebu Hackathon Kickoff Night is today and FULL, with 3 people on the waitlist.
 *  - One upcoming published event, one Draft (hidden), and one past event (Ended).
 *
 * Run `npm run seed` to wipe the database and load this again.
 */

const { transaction } = require('./index');
const { hashPassword } = require('../services/staff');
const { generateTicketCode } = require('../lib/tickets');
const { toManilaIso, manilaDateString, addDays, fromLocalParts } = require('../lib/time');

const FIRST = ['Juan', 'Maria', 'Jose', 'Ana', 'Mark', 'Kristine', 'John Paul', 'Angelica', 'Carlo', 'Patricia', 'Miguel', 'Camille', 'Paolo', 'Bea', 'Rafael', 'Nicole', 'Gabriel', 'Jasmine', 'Joshua', 'Trisha', 'Kevin', 'Andrea', 'Renz', 'Mae', 'Ivan', 'Shiela', 'Bryan', 'Erika', 'Neil', 'Joy', 'Christian', 'Danica', 'Ramon', 'Lovely', 'Arvin', 'Princess', 'Jerome', 'Hazel', 'Vince', 'Ella'];
const LAST = ['Dela Cruz', 'Santos', 'Reyes', 'Garcia', 'Mendoza', 'Villanueva', 'Cruz', 'Bautista', 'Ramos', 'Aquino', 'Flores', 'Gonzales', 'Navarro', 'Castillo', 'Lim', 'Tan', 'Ong', 'Abella', 'Cabahug', 'Alcantara', 'Ybañez', 'Lapu', 'Pacquiao', 'Rosales', 'Sarmiento', 'Tumulak', 'Uy', 'Dizon', 'Ocampo', 'Pepito'];
const PREFIXES = ['0917', '0918', '0920', '0927', '0995', '0966', '0908', '0939'];

function people(count, offset) {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    const first = FIRST[(i + offset) % FIRST.length];
    const last = LAST[(i * 7 + offset) % LAST.length];
    const handle = `${first}.${last}`.toLowerCase().replace(/ñ/g, 'n').replace(/[^a-z.]/g, '');
    list.push({
      name: `${first} ${last}`,
      email: `${handle}${(i + offset) % 3 === 0 ? '' : i + offset}@example.com`,
      mobile: PREFIXES[(i + offset) % PREFIXES.length] + String(1000000 + ((i + 1) * 7919 * (offset + 3)) % 9000000).padStart(7, '0'),
    });
  }
  return list;
}

function clearAll(db) {
  db.exec(`
    DELETE FROM email_outbox;
    DELETE FROM audit_logs;
    DELETE FROM registrations;
    DELETE FROM events;
    DELETE FROM staff_users;
    DELETE FROM sessions;
  `);
}

function seedDatabase(db, config, now = new Date()) {
  const today = manilaDateString(now);
  const minutesAgo = (m) => toManilaIso(new Date(now.getTime() - m * 60_000));
  const daysAgo = (d, extraMin = 0) => toManilaIso(new Date(now.getTime() - d * 86_400_000 - extraMin * 60_000));

  transaction(db, () => {
    clearAll(db);

    const created = toManilaIso(now);
    const addStaff = db.prepare('INSERT INTO staff_users (name, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)');
    const organizerId = Number(addStaff.run('Ana Reyes', 'organizer', hashPassword(config.seedPasswords.organizer), 'organizer', created).lastInsertRowid);
    const doorId = Number(addStaff.run('Marco Villanueva', 'door', hashPassword(config.seedPasswords.door), 'door', created).lastInsertRowid);

    const addEvent = db.prepare(
      `INSERT INTO events (title, description, venue, starts_at, ends_at, capacity, status, code_prefix, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const event = (e) =>
      Number(addEvent.run(e.title, e.description, e.venue, fromLocalParts(e.date, e.start), fromLocalParts(e.date, e.end), e.capacity, e.status, e.prefix, organizerId, daysAgo(20), daysAgo(20)).lastInsertRowid);

    const addReg = db.prepare(
      `INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, registered_at, checked_in_at, checked_in_by, cancelled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const reg = (eventId, prefix, p, status, registeredAt, checkedInAt = null, cancelledAt = null) =>
      addReg.run(eventId, p.name, p.email, p.mobile, generateTicketCode(prefix), status, registeredAt, checkedInAt, checkedInAt ? doorId : null, cancelledAt);

    // 1. The demo event from the activity brief: today, 18 of 30 registered, 5 already checked in.
    const meetup = event({
      title: 'Cebu Dev Meetup 2026',
      prefix: 'CDM',
      description:
        "Cebu's community meetup for developers, designers and builders.\n\n" +
        'Morning: talks on web, mobile and cloud. Afternoon: hands-on workshops. Evening: lightning talks and networking.\n\n' +
        'Free entry. Bring a valid ID and your QR ticket.',
      venue: 'Ayala Center Cebu, Function Room 2',
      date: today,
      start: '09:00',
      end: '22:00',
      capacity: 30,
      status: 'published',
    });
    people(19, 0).forEach((p, i) => {
      if (i === 18) return reg(meetup, 'CDM', p, 'cancelled', daysAgo(9), null, daysAgo(2));
      const checkedIn = i < 5 ? minutesAgo(40 - i * 6) : null;
      return reg(meetup, 'CDM', p, checkedIn ? 'checked_in' : 'confirmed', daysAgo(14 - (i % 10), i * 13), checkedIn);
    });

    // 2. A FULL event (today) with a waitlist, so testers can see "Full", the waitlist and promotion.
    const hack = event({
      title: 'Cebu Hackathon Kickoff Night',
      prefix: 'CHKN',
      description: 'Team formation, problem statements and pizza. Limited seats so every team gets a mentor.\n\nThis seeded event is full on purpose: try joining the waitlist.',
      venue: 'The Company Cebu, Asiatown IT Park, Lahug',
      date: today,
      start: '17:00',
      end: '23:00',
      capacity: 12,
      status: 'published',
    });
    people(15, 20).forEach((p, i) => {
      reg(hack, 'CHKN', p, i < 12 ? 'confirmed' : 'waitlisted', daysAgo(6 - Math.floor(i / 3), 60 - i));
    });

    // 3. Upcoming published event.
    const pitch = event({
      title: 'Cebu Startup Pitch Night',
      prefix: 'CSPN',
      description: 'Eight early-stage Cebu startups pitch to a panel of founders and investors. Q&A and networking after.',
      venue: 'Cebu IT Park, Skyrise 4 Events Hall',
      date: addDays(today, 14),
      start: '18:00',
      end: '21:00',
      capacity: 50,
      status: 'published',
    });
    people(7, 9).forEach((p, i) => reg(pitch, 'CSPN', p, 'confirmed', daysAgo(3, i * 37)));

    // 4. Draft: invisible to attendees until an organizer publishes it.
    event({
      title: 'Women in Tech Cebu: Career Talks',
      prefix: 'WITC',
      description: 'Panel and mentoring circles. (Draft: not visible to attendees yet.)',
      venue: 'University of San Carlos, Talamban Campus',
      date: addDays(today, 21),
      start: '13:00',
      end: '17:00',
      capacity: 80,
      status: 'draft',
    });

    // 5. Past event, shown as "Ended".
    const past = event({
      title: 'Cebu Tech Talks Vol. 11',
      prefix: 'CTTV',
      description: 'Talks on Laravel, Flutter and AWS from local engineers.',
      venue: 'Ayala Center Cebu, Activity Center',
      date: addDays(today, -30),
      start: '18:00',
      end: '21:00',
      capacity: 40,
      status: 'published',
    });
    const pastDay = addDays(today, -30);
    people(25, 5).forEach((p, i) => {
      const checkedIn = i < 20 ? `${pastDay}T18:${String(5 + i * 2).padStart(2, '0')}:00+08:00` : null;
      reg(past, 'CTTV', p, checkedIn ? 'checked_in' : 'confirmed', daysAgo(40, i * 11), checkedIn);
    });
  });
}

function seedIfEmpty(db, config) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM staff_users').get();
  if (n > 0) return false;
  seedDatabase(db, config);
  return true;
}

module.exports = { seedDatabase, seedIfEmpty };

if (require.main === module) {
  const { loadConfig } = require('../config');
  const { openDb } = require('./index');
  const config = loadConfig();
  const db = openDb(config.dbFile);
  seedDatabase(db, config);
  const counts = db.prepare('SELECT (SELECT COUNT(*) FROM events) AS events, (SELECT COUNT(*) FROM registrations) AS registrations, (SELECT COUNT(*) FROM staff_users) AS staff').get();
  db.close();
  console.log(`Seeded ${config.dbFile}`);
  console.log(`  ${counts.events} events, ${counts.registrations} registrations, ${counts.staff} staff accounts`);
  console.log(`  Organizer sign-in:  organizer / ${config.seedPasswords.organizer}`);
  console.log(`  Door staff sign-in: door / ${config.seedPasswords.door}`);
}
