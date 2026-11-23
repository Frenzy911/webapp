'use strict';

/**
 * Demo data. Dates are relative to "today" in Cebu so the demo always works:
 *  - Cebu Dev Meetup 2026 is today (so check-in works right away), 18 of 30 registered.
 *  - Cebu Hackathon Kickoff Night is today and FULL, with 3 people on the waitlist.
 *  - One upcoming published event, one Draft (hidden), and one past event (Ended).
 *
 * Run `npm run seed` to wipe the database and load this again.
 */

const { transaction, get, run } = require('./index');
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

async function clearAll(conn) {
  // Children before parents, because of the foreign keys.
  for (const table of ['email_outbox', 'audit_logs', 'registrations', 'events', 'staff_users', 'sessions']) {
    await run(conn, `DELETE FROM ${table}`);
  }
}

async function seedDatabase(db, config, now = new Date()) {
  const today = manilaDateString(now);
  const minutesAgo = (m) => toManilaIso(new Date(now.getTime() - m * 60_000));
  const daysAgo = (d, extraMin = 0) => toManilaIso(new Date(now.getTime() - d * 86_400_000 - extraMin * 60_000));

  await transaction(db, async (conn) => {
    await clearAll(conn);

    const created = toManilaIso(now);
    const addStaff = async (name, username, password, role) =>
      (await run(conn, 'INSERT INTO staff_users (name, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)', [name, username, hashPassword(password), role, created])).insertId;
    const organizerId = await addStaff('Ana Reyes', 'organizer', config.seedPasswords.organizer, 'organizer');
    const doorId = await addStaff('Marco Villanueva', 'door', config.seedPasswords.door, 'door');

    const event = async (e) =>
      (
        await run(
          conn,
          `INSERT INTO events (title, description, venue, starts_at, ends_at, capacity, status, code_prefix, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [e.title, e.description, e.venue, fromLocalParts(e.date, e.start), fromLocalParts(e.date, e.end), e.capacity, e.status, e.prefix, organizerId, daysAgo(20), daysAgo(20)]
        )
      ).insertId;

    const reg = (eventId, prefix, p, status, registeredAt, checkedInAt = null, cancelledAt = null) =>
      run(
        conn,
        `INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, registered_at, checked_in_at, checked_in_by, cancelled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [eventId, p.name, p.email, p.mobile, generateTicketCode(prefix), status, registeredAt, checkedInAt, checkedInAt ? doorId : null, cancelledAt]
      );

    // 1. The demo event from the activity brief: today, 18 of 30 registered, 5 already checked in.
    const meetup = await event({
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
    for (const [i, p] of people(19, 0).entries()) {
      if (i === 18) {
        await reg(meetup, 'CDM', p, 'cancelled', daysAgo(9), null, daysAgo(2));
        continue;
      }
      const checkedIn = i < 5 ? minutesAgo(40 - i * 6) : null;
      await reg(meetup, 'CDM', p, checkedIn ? 'checked_in' : 'confirmed', daysAgo(14 - (i % 10), i * 13), checkedIn);
    }

    // 2. A FULL event (today) with a waitlist, so testers can see "Full", the waitlist and promotion.
    const hack = await event({
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
    for (const [i, p] of people(15, 20).entries()) {
      await reg(hack, 'CHKN', p, i < 12 ? 'confirmed' : 'waitlisted', daysAgo(6 - Math.floor(i / 3), 60 - i));
    }

    // 3. Upcoming published event.
    const pitch = await event({
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
    for (const [i, p] of people(7, 9).entries()) await reg(pitch, 'CSPN', p, 'confirmed', daysAgo(3, i * 37));

    // 4. Draft: invisible to attendees until an organizer publishes it.
    await event({
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
    const past = await event({
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
    for (const [i, p] of people(25, 5).entries()) {
      const checkedIn = i < 20 ? `${pastDay}T18:${String(5 + i * 2).padStart(2, '0')}:00+08:00` : null;
      await reg(past, 'CTTV', p, checkedIn ? 'checked_in' : 'confirmed', daysAgo(40, i * 11), checkedIn);
    }
  });
}

async function seedIfEmpty(db, config) {
  const { n } = await get(db, 'SELECT COUNT(*) AS n FROM staff_users');
  if (n > 0) return false;
  await seedDatabase(db, config);
  return true;
}

module.exports = { seedDatabase, seedIfEmpty };

if (require.main === module) {
  (async () => {
    const { loadConfig } = require('../config');
    const { openDb } = require('./index');
    const config = loadConfig();
    const db = await openDb(config.mysql);
    try {
      await seedDatabase(db, config);
      const counts = await get(db, 'SELECT (SELECT COUNT(*) FROM events) AS events, (SELECT COUNT(*) FROM registrations) AS registrations, (SELECT COUNT(*) FROM staff_users) AS staff');
      console.log(`Seeded MySQL database "${config.mysql.database}" on ${config.mysql.host}:${config.mysql.port}`);
      console.log(`  ${counts.events} events, ${counts.registrations} registrations, ${counts.staff} staff accounts`);
      console.log(`  Organizer sign-in:  organizer / ${config.seedPasswords.organizer}`);
      console.log(`  Door staff sign-in: door / ${config.seedPasswords.door}`);
    } finally {
      await db.end();
    }
  })().catch((err) => {
    console.error(`Seeding failed: ${err.message}`);
    process.exit(1);
  });
}
