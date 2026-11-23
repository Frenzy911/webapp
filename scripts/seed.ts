/**
 * Demo data. Dates are relative to "today" in Cebu so the demo always works:
 *  - Cebu Dev Meetup 2026 is today (check-in works right away), 18 of 30 registered.
 *  - Cebu Hackathon Kickoff Night is today and FULL, with 3 people on the waitlist.
 *  - One upcoming published event, one Draft (hidden), and one past event (Ended).
 * Plus two staff logins (organizer and door staff).
 *
 *   npm run seed            wipes events, registrations, audit log and emails, then loads the demo
 *   npm run seed -- --remote   same, against a hosted Supabase project (asks you to confirm by flag)
 */
import { createClient } from '@supabase/supabase-js';
import { generateTicketCode } from '../src/lib/tickets';
import { addDays, fromLocalParts, manilaDateString } from '../src/lib/time';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set (see .env.local).');
  process.exit(1);
}
const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(url);
if (!local && !process.argv.includes('--remote')) {
  console.error(`Refusing to wipe ${url}: it is not a local Supabase. Run "npm run seed -- --remote" if you really mean it.`);
  process.exit(1);
}

const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

const STAFF = [
  { email: process.env.SEED_ORGANIZER_EMAIL || 'organizer@example.com', password: process.env.SEED_ORGANIZER_PASSWORD || 'Organizer@2026', name: 'Ana Reyes', role: 'organizer' },
  { email: process.env.SEED_DOOR_EMAIL || 'door@example.com', password: process.env.SEED_DOOR_PASSWORD || 'DoorStaff@2026', name: 'Marco Villanueva', role: 'door' },
] as const;

const FIRST = ['Juan', 'Maria', 'Jose', 'Ana', 'Mark', 'Kristine', 'John Paul', 'Angelica', 'Carlo', 'Patricia', 'Miguel', 'Camille', 'Paolo', 'Bea', 'Rafael', 'Nicole', 'Gabriel', 'Jasmine', 'Joshua', 'Trisha', 'Kevin', 'Andrea', 'Renz', 'Mae', 'Ivan', 'Shiela', 'Bryan', 'Erika', 'Neil', 'Joy', 'Christian', 'Danica', 'Ramon', 'Lovely', 'Arvin', 'Princess', 'Jerome', 'Hazel', 'Vince', 'Ella'];
const LAST = ['Dela Cruz', 'Santos', 'Reyes', 'Garcia', 'Mendoza', 'Villanueva', 'Cruz', 'Bautista', 'Ramos', 'Aquino', 'Flores', 'Gonzales', 'Navarro', 'Castillo', 'Lim', 'Tan', 'Ong', 'Abella', 'Cabahug', 'Alcantara', 'Ybañez', 'Lapu', 'Pacquiao', 'Rosales', 'Sarmiento', 'Tumulak', 'Uy', 'Dizon', 'Ocampo', 'Pepito'];
const PREFIXES = ['0917', '0918', '0920', '0927', '0995', '0966', '0908', '0939'];

function people(count: number, offset: number) {
  return Array.from({ length: count }, (_, i) => {
    const first = FIRST[(i + offset) % FIRST.length];
    const last = LAST[(i * 7 + offset) % LAST.length];
    const handle = `${first}.${last}`.toLowerCase().replace(/ñ/g, 'n').replace(/[^a-z.]/g, '');
    return {
      full_name: `${first} ${last}`,
      email: `${handle}${(i + offset) % 3 === 0 ? '' : i + offset}@example.com`,
      mobile: PREFIXES[(i + offset) % PREFIXES.length] + String(1000000 + (((i + 1) * 7919 * (offset + 3)) % 9000000)).padStart(7, '0'),
    };
  });
}

function check<R extends { data: unknown; error: { message: string } | null }>(res: R, what: string): Exclude<R['data'], null> {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as Exclude<R['data'], null>;
}

/** Create the login, or reset its password if it already exists, and (re)create its staff profile. */
async function upsertStaff(s: (typeof STAFF)[number]): Promise<string> {
  const list = check(await db.auth.admin.listUsers({ perPage: 1000 }), 'listUsers');
  const existing = list.users.find((u) => u.email?.toLowerCase() === s.email.toLowerCase());
  let id: string;
  if (existing) {
    id = existing.id;
    check(await db.auth.admin.updateUserById(id, { password: s.password, ban_duration: 'none', email_confirm: true }), 'updateUser');
  } else {
    id = check(await db.auth.admin.createUser({ email: s.email, password: s.password, email_confirm: true, user_metadata: { name: s.name } }), 'createUser').user!.id;
  }
  check(await db.from('staff_profiles').upsert({ id, name: s.name, email: s.email.toLowerCase(), role: s.role, active: true }), 'staff profile');
  return id;
}

async function main() {
  const now = new Date();
  const today = manilaDateString(now);
  const iso = (d: Date) => d.toISOString();
  const minutesAgo = (m: number) => iso(new Date(now.getTime() - m * 60_000));
  const daysAgo = (d: number, extraMin = 0) => iso(new Date(now.getTime() - d * 86_400_000 - extraMin * 60_000));

  // Wipe event data (children first because of the foreign keys). Staff accounts are kept.
  // (PostgREST refuses a DELETE without a filter, hence "where <primary key> is not null".)
  for (const [table, key] of [['email_outbox', 'id'], ['audit_logs', 'id'], ['registrations', 'id'], ['events', 'id'], ['rate_limits', 'key']]) {
    check(await db.from(table).delete().not(key, 'is', null), `clear ${table}`);
  }

  const [organizerId, doorId] = [await upsertStaff(STAFF[0]), await upsertStaff(STAFF[1])];

  async function event(e: { title: string; prefix: string; description: string; venue: string; date: string; start: string; end: string; capacity: number; status: string }) {
    const row = check(
      await db
        .from('events')
        .insert({
          title: e.title,
          description: e.description,
          venue: e.venue,
          starts_at: fromLocalParts(e.date, e.start),
          ends_at: fromLocalParts(e.date, e.end),
          capacity: e.capacity,
          status: e.status,
          code_prefix: e.prefix,
          created_by: organizerId,
          created_at: daysAgo(20),
          updated_at: daysAgo(20),
        })
        .select('id')
        .single(),
      `event ${e.title}`
    );
    return (row as { id: number }).id;
  }

  async function regs(eventId: number, prefix: string, rows: Array<Record<string, unknown>>) {
    // One by one, in order, so ids (and waitlist order) follow the list.
    for (const r of rows) check(await db.from('registrations').insert({ event_id: eventId, ticket_code: generateTicketCode(prefix), ...r }), 'registration');
  }

  // 1. The demo event from the activity brief: today, 18 of 30 registered, 5 already checked in, 1 cancelled.
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
  await regs(
    meetup,
    'CDM',
    people(19, 0).map((p, i) => {
      if (i === 18) return { ...p, status: 'cancelled', registered_at: daysAgo(9), cancelled_at: daysAgo(2) };
      const checkedIn = i < 5 ? minutesAgo(40 - i * 6) : null;
      return { ...p, status: checkedIn ? 'checked_in' : 'confirmed', registered_at: daysAgo(14 - (i % 10), i * 13), checked_in_at: checkedIn, checked_in_by: checkedIn ? doorId : null };
    })
  );

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
  await regs(hack, 'CHKN', people(15, 20).map((p, i) => ({ ...p, status: i < 12 ? 'confirmed' : 'waitlisted', registered_at: daysAgo(6 - Math.floor(i / 3), 60 - i) })));

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
  await regs(pitch, 'CSPN', people(7, 9).map((p, i) => ({ ...p, status: 'confirmed', registered_at: daysAgo(3, i * 37) })));

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
  const pastDay = addDays(today, -30);
  const past = await event({
    title: 'Cebu Tech Talks Vol. 11',
    prefix: 'CTTV',
    description: 'Talks on Laravel, Flutter and AWS from local engineers.',
    venue: 'Ayala Center Cebu, Activity Center',
    date: pastDay,
    start: '18:00',
    end: '21:00',
    capacity: 40,
    status: 'published',
  });
  await regs(
    past,
    'CTTV',
    people(25, 5).map((p, i) => {
      const checkedIn = i < 20 ? fromLocalParts(pastDay, `18:${String(5 + i * 2).padStart(2, '0')}`) : null;
      return { ...p, status: checkedIn ? 'checked_in' : 'confirmed', registered_at: daysAgo(40, i * 11), checked_in_at: checkedIn, checked_in_by: checkedIn ? doorId : null };
    })
  );

  const { count } = await db.from('registrations').select('id', { count: 'exact', head: true });
  console.log(`Seeded ${url}`);
  console.log(`  5 events, ${count} registrations`);
  console.log(`  Organizer sign-in:  ${STAFF[0].email} / ${STAFF[0].password}`);
  console.log(`  Door staff sign-in: ${STAFF[1].email} / ${STAFF[1].password}`);
}

main().catch((err) => {
  console.error(`Seeding failed: ${err.message}`);
  process.exit(1);
});
