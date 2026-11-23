# Cebu Events · Event Registration with QR Check-in

A web app where organizers create events with a set capacity, attendees register and get a QR code ticket, and door staff scan the QR (or type the code) to check people in. Built for the *Event Registration with QR Check-in* intern activity.

**Level reached:** Level 2 complete. Level 3 items 13 (race conditions), 14 (secure codes and rate limits) and 16 (roles and audit log) are built and verified. Items 12 (camera scanning) and 15 (email) are built but still need a check on a real phone and an SMTP sandbox. Item 17 (deployment) is not done yet: a Dockerfile and steps are below. See the [acceptance checklist](#acceptance-checklist).

## Tech stack

| Part | Choice |
|---|---|
| Server | Node.js 22.13+ (tested on 24) with Express 5 |
| Database | SQLite via Node's built-in `node:sqlite`, so there's nothing native to compile |
| Pages | Server-rendered EJS templates and plain CSS, mobile first. A little vanilla JS for the scanner. |
| QR | `qrcode` draws the QR on the server. `jsQR` decodes it from the camera in the browser. |
| Auth | Session cookie stored in SQLite. Passwords hashed with bcrypt (`bcryptjs`). |
| Email | `nodemailer` over SMTP (Mailtrap, Ethereal or Resend test mode) |
| Tests | Node's built-in test runner. 46 tests cover the acceptance checks. |

## Setup and run

You need **Node.js 22.13 or newer** (`node -v`).

```powershell
npm install
```

```powershell
npm run setup
```

```powershell
npm start
```

Then open http://localhost:3000. Staff sign-in is at http://localhost:3000/staff/login.

- `npm run setup` creates `.env` from `.env.example` with a fresh random `SESSION_SECRET`, then creates the database and loads the demo data.
- `npm run dev` runs the server and restarts it when files change.
- `npm test` runs the automated acceptance tests. They use their own temporary database.

### Seed data

`npm run seed` **wipes the database** and loads the demo data again. Seeded dates are relative to *today* in Cebu, so check-in works right away. **Run it again on the day you test.**

| Event | When | State |
|---|---|---|
| Cebu Dev Meetup 2026, Ayala Center Cebu, Function Room 2 | today, 9:00 AM – 10:00 PM | Published · 18 of 30 registered (12 spots left) · 5 checked in · 1 cancelled |
| Cebu Hackathon Kickoff Night | today, 5:00 PM – 11:00 PM | Published · **Full** (12/12) · 3 on the waitlist |
| Cebu Startup Pitch Night | in 14 days | Published · 7 of 50 |
| Women in Tech Cebu: Career Talks | in 21 days | **Draft** (attendees can't see it) |
| Cebu Tech Talks Vol. 11 | 30 days ago | Ended |

The server also loads this data automatically the first time it starts with an empty database. Set `AUTO_SEED=false` to turn that off.

### Demo staff logins

| Role | Username | Password | Can do |
|---|---|---|---|
| Organizer | `organizer` | `Organizer@2026` | Everything: events, attendees, waitlist, CSV, dashboard, audit log, staff accounts |
| Door staff | `door` | `DoorStaff@2026` | Check-in screen only, including undo |

Change these with `SEED_ORGANIZER_PASSWORD` and `SEED_DOOR_PASSWORD` in `.env`, then run `npm run seed`. Don't use `#` in values in `.env`: it starts a comment.

### Email (Level 3 · item 15)

With no SMTP settings, emails are **saved, not sent**. Organizers can read every email, with its QR code, under **Staff → Emails**. To deliver them to a sandbox inbox, put the sandbox's SMTP details in `.env`, for example for Mailtrap:

```
SMTP_HOST=sandbox.smtp.mailtrap.io
SMTP_PORT=2525
SMTP_USER=your-mailtrap-user
SMTP_PASS=your-mailtrap-password
APP_BASE_URL=http://localhost:3000
```

Emails are sent after registration (QR attached inline, plus a link to the ticket), when someone joins the waitlist (no QR), and when someone is promoted off the waitlist (QR). Keys live only in `.env`, which git ignores.

## How it works

### Attendee
1. **Events** lists published events that haven't ended. Each card shows the date, start and end time in Cebu time (12-hour), the venue, and spots left, e.g. "12 of 30 spots left". Full events show **Full**. Ended events are listed under *Past events* and marked **Ended**.
2. **Register** asks for full name, email and a PH mobile number (`09171234567`; spaces, dashes and `+63` are accepted and normalised). Each field gets its own error message. The server re-checks everything, including capacity.
3. The **ticket page** shows the event, date, time, venue, attendee name, ticket code and the QR code. It is sized for a phone held up at the door.
4. **Find my ticket** needs the ticket code **and** the email or mobile used to register. Any mismatch shows "Ticket not found" and nothing else. Lookups are rate-limited.
5. From the ticket page, attendees can **cancel** a confirmed or waitlisted registration. A checked-in registration can't be cancelled.

### Staff
- **Check-in** (both roles): pick the event, then scan with the camera or type the code. A USB/Bluetooth scanner that types the code and presses Enter also works. Each scan shows one big result, using both colour and words:
  - ✓ **Checked in** (green) with the name
  - ! **Already checked in** (yellow) with the first check-in time
  - ✕ **Invalid ticket** (red): the code doesn't exist or belongs to another event
  - ✕ **On waitlist — not confirmed** / ✕ **Cancelled** (red)
  - ✕ **Not the event day** (red): Confirmed tickets only check in on the event's date

  A live counter ("6 / 18 checked in") updates after each scan and every 5 seconds, so several door phones stay in sync. **Undo** is on the result and in the recent check-ins list.
- **Camera scanning:** results stay on screen for about 2 seconds, then the scanner is ready for the next ticket automatically. A QR still held in front of the camera isn't scanned twice. If the camera is blocked, the page says why and the manual box keeps working. Browsers only allow the camera on HTTPS or `localhost`.
- **Dashboard** (organizer): every event that hasn't ended, with capacity, confirmed, waitlisted, cancelled, checked in and no-shows. No-shows appear only after the event starts.
- **Events** (organizer): create, edit, publish and close events. The rules are enforced on the server:
  - the end time must be after the start time
  - capacity must be at least 1, and can't go below the number already registered
  - an event with registrations can't go back to Draft
- **Attendees** (organizer): totals at the top (registered / capacity, checked in / registered, waitlisted, cancelled), search by name, email or ticket code, filter by status, cancel, undo a check-in, **Promote #1 on waitlist** when a spot is open, and **Export CSV**.
- **Audit log** (organizer): who, what and when for these actions: event created or edited, status changed, registration cancelled, waitlist promotion, check-in, undo check-in, staff account changes.
- **Staff** (organizer): add accounts and deactivate or reactivate them. Deactivated users are signed out on their next request.

### Booking rules (enforced on the server)
- Capacity counts **Confirmed + Checked in**. Waitlisted and Cancelled don't count.
- One **active** registration per email per event. Cancelled ones don't block registering again. This is a partial unique index in the database as well as an app check.
- Check-in only works for a **Confirmed** ticket, for the **selected event**, on the **event day**. A ticket checks in once.
- Times are stored as ISO 8601 with a `+08:00` offset (e.g. `2026-12-05T18:00:00+08:00`) and shown in 12-hour Cebu time.

## Last spot and double scans (Level 3 · item 13)

Three layers make sure two people can't both get the last spot, and two phones can't both check in the same ticket:

1. **One writer at a time.** Every booking action (register, cancel, promote, check-in, undo, capacity change) runs in `BEGIN IMMEDIATE` (`src/db/index.js`). That takes SQLite's write lock *before* reading the spot count, so a second request waits until the first commits, then sees the updated count.
2. **The database refuses overbooking.** Triggers in `src/db/schema.sql` abort any insert or update that would push Confirmed + Checked in above capacity (`EVENT_FULL`), and any capacity change below the current count. This holds even for a second connection or a buggy code path. A test opens a separate connection to prove it.
3. **Conditional updates.** Check-in is `UPDATE … SET status='checked_in' … WHERE id = ? AND status = 'confirmed'`. Only the request whose update changes a row says **Checked in**; every other one gets 0 rows changed and reports **Already checked in**. Cancel and undo work the same way.

Tests: 12 browsers registering for the last spot at the same moment gives exactly 1 success and 11 "the last spot was just taken" (each offered the waitlist). 4 devices scanning one ticket at once gives exactly 1 "Checked in" and 3 "Already checked in".

*If this moved to PostgreSQL/MySQL, layer 1 would become `SELECT … FROM events WHERE id = ? FOR UPDATE` inside a transaction.*

## Security (Level 3 · item 14 and the basics)

- **Ticket codes can't be guessed.** Codes look like `CDM-7K3P9QXM`: an event prefix plus 8 characters from a crypto-secure random generator in Crockford base32 (40 bits, about 1.1 trillion combinations per event). They are never sequential. Typed `O`/`I`/`L` are read as `0`/`1`. `CDM-000001`, an edited code or a code from another event never checks anyone in.
- **Rate limits** apply per IP for ticket lookup (10/min), registration (10/min) and sign-in (10 per 15 min), and per staff account for check-in (120/min).
- **Email links** to a ticket carry an HMAC-SHA256 token (`?t=…`). Without it, or a code + email lookup, a ticket page shows nothing.
- **Passwords** are bcrypt hashes. A wrong username takes as long to reject as a wrong password.
- Every staff URL is guarded **on the server** (`requireStaff`, `requireRole`), not just hidden. JSON endpoints return 401/403.
- **CSRF tokens** on every form and fetch. **SameSite=Lax, HttpOnly** session cookies (`Secure` in production). The session ID is regenerated at sign-in.
- **Parameterized SQL** everywhere. EJS escapes all output. A strict **Content-Security-Policy** allows no inline scripts or styles.
- **CSV export** neutralises `= + - @` at the start of a cell (formula injection) and keeps the leading zero of mobile numbers for Excel.
- **Secrets** (`SESSION_SECRET`, SMTP) live in `.env`, which git ignores. Only `.env.example` with fake values is committed.

## Data model

```
staff_users    id, name, username (unique, case-insensitive), password_hash, role (organizer|door), active, created_at
events         id, title, description, venue, starts_at, ends_at, capacity (>=1), status (draft|published|closed),
               code_prefix, created_by → staff_users, created_at, updated_at        CHECK (ends_at > starts_at)
registrations  id, event_id → events, full_name, email (lower-case), mobile, ticket_code (unique),
               status (confirmed|checked_in|waitlisted|cancelled), registered_at,
               promoted_at, promoted_by, checked_in_at, checked_in_by,
               checkin_undone_at, checkin_undone_by, cancelled_at, cancelled_by     (… _by → staff_users)
               UNIQUE (event_id, email) WHERE status <> 'cancelled'
audit_logs     id, staff_user_id → staff_users, actor, action, target_type, target_id, event_id, details, created_at
sessions       sid, data, expires_at
email_outbox   id, kind, registration_id, to_address, subject, html, status (sent|failed|saved), error, created_at
```

The full schema, including the capacity triggers, is in [src/db/schema.sql](src/db/schema.sql). The waitlist position is worked out on the fly: first come, first served, by registration order.

## Project layout

```
src/
  server.js            start the server (loads demo data into an empty database)
  app.js               Express setup: security headers, sessions, CSRF, error pages
  config.js            settings from .env
  db/                  schema.sql, connection + transaction helper, seed.js
  lib/                 time (Cebu), tickets (codes + tokens), validation, mailer, audit, rate limit, session store
  services/            business rules: events, registrations, checkin, staff
  routes/              public.js (attendees), staff.js (staff + JSON API)
  views/               EJS pages, partials and the email template
public/                css/app.css, js/app.js, js/checkin.js (camera + live counter)
test/                  level1/2/3 acceptance tests, unit tests, support/harness.js
scripts/setup.js       first-time setup
```

## Deployment (Level 3 · item 17: not done yet)

The app runs from the included `Dockerfile` on any host with HTTPS. For example, on Render:

1. Create a **Web Service** from the repo and choose **Docker**.
2. Add a **persistent disk** mounted at `/data`, so the SQLite file survives redeploys.
3. Set these environment variables:
   - `SESSION_SECRET` (long random string)
   - `APP_BASE_URL=https://<your-app>.onrender.com`
   - the SMTP sandbox settings
   - `NODE_ENV=production` and `TRUST_PROXY=1` are already set in the Dockerfile
4. Deploy, then open the HTTPS link on a phone. Camera scanning only works over HTTPS.

## Known limitations

- **One server process.** SQLite and the in-memory rate limiter assume a single instance, which is plenty for event-sized traffic. Rate-limit counters reset on restart. Running several instances would need PostgreSQL and a shared limiter (e.g. Redis).
- **Single-day events.** The event form has one date with a start and end time. Events past midnight aren't supported in the form.
- **Check-in is open all of the event's date** (Cebu time), not only between the start and end times. This follows the "on the event day" rule.
- **Seeded dates move.** Demo events are placed relative to the day you run `npm run seed`. Re-seed on the day you test.
- **Manual waitlist promotion,** as the brief specifies. The organizer clicks **Promote #1** when a spot opens.
- **No password reset or change-password page.** An organizer can create a new account and deactivate the old one.
- **Emails need SMTP settings to be delivered.** Without them they are saved in **Staff → Emails** only.

## Acceptance checklist

Legend: **Pass** = verified by the automated tests (`npm test`, 46/46 passing) and/or by hand in a browser at phone size (375 px). **To check** = built, but needs a real phone, Excel or an SMTP sandbox to confirm. **Not done** = not built yet.

### Level 1

| # | Check | Result |
|---|---|---|
| 1 | Register for Cebu Dev Meetup 2026 on a phone-sized screen and see a ticket with a QR code | **Pass**: browser at 375 px plus test |
| 2 | Scan the QR with any phone QR app: it shows the same ticket code | **To check** on a phone. The QR decodes back to the exact code with jsQR in the test suite and in the browser. |
| 3 | Refresh, then find the ticket again with ticket code + email | **Pass** |
| 4 | A wrong ticket code or wrong email shows "Ticket not found" and no details | **Pass** |
| 5 | Register the same email twice for one event: the second attempt is blocked | **Pass** (letter case ignored) |
| 6 | Bad email and a 10-digit mobile number: both show errors | **Pass**: browser plus test |
| 7 | The seeded full event shows "Full" and the Register button is disabled | **Pass** (the server refuses too) |
| 8 | Open a staff page while signed out: sent to the sign-in page | **Pass** (every staff URL; the API returns 401) |
| 9 | Check in a valid ticket: green "Checked in" with the name | **Pass**: browser plus test |
| 10 | Check in the same ticket again: yellow "Already checked in" with the first time | **Pass**: browser plus test |
| 11 | A made-up code, and a real code from a different event: both "Invalid ticket" | **Pass**: browser plus test |
| 12 | The attendee list shows correct registered and checked-in totals | **Pass** |

### Level 2

| # | Check | Result |
|---|---|---|
| 1 | Create a Draft event: attendees can't see it. Publish it: it appears | **Pass** |
| 2 | Save an event whose end time is before its start time: blocked | **Pass** |
| 3 | Lower capacity below the number registered: blocked with a message | **Pass** |
| 4 | Fill an event, join the waitlist and see your position | **Pass** |
| 5 | Scan a waitlisted ticket: "On waitlist — not confirmed" | **Pass**: browser plus test |
| 6 | Cancel one confirmed registration: spots left goes up by 1; scanning it shows "Cancelled" | **Pass** |
| 7 | Promote the first waitlisted person: they now check in successfully | **Pass** |
| 8 | Cancel a checked-in registration: blocked | **Pass** (staff and attendee) |
| 9 | Undo a check-in: the ticket checks in again, and the undo is recorded | **Pass** (on the row and in the audit log) |
| 10 | Dashboard counts match the attendee list. CSV export opens correctly in Excel | Counts **Pass**. CSV format (UTF-8 BOM, CRLF, leading zeros kept) checked by test. **To check**: open it in Excel. |

### Level 3

| # | Check | Result |
|---|---|---|
| 12 | Scan a ticket from another phone's screen with the camera: correct result, then ready for the next scan | **To check** on a phone over HTTPS. Built; the "camera blocked" fallback is verified in the browser. |
| 13 | Two browsers register for the last spot at the same moment: only one gets it | **Pass** (12 at once gives 1 success) |
| 13 | Two devices check in the same ticket at the same moment: only one says "Checked in" | **Pass** (4 at once gives 1 "Checked in") |
| 14 | Guess a sequential or edited ticket code: never valid | **Pass** |
| 15 | Registration and promotion emails arrive in the sandbox inbox with the QR or ticket link | **To check** once SMTP sandbox details are added. Emails with the QR and a signed link are produced and verified in **Staff → Emails** and by test. |
| 16 | Door staff can't create or edit events; Organizer can | **Pass** |
| 17 | The deployed link works on a phone over HTTPS, including the camera | **Not done** (see Deployment) |
