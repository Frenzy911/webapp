# Cebu Events · Event Registration with QR Check-in

A web app where organizers create events with a set capacity, attendees register and get a QR code ticket, and door staff scan the QR (or type the code) to check people in. Built for the *Event Registration with QR Check-in* intern activity.

**Stack:** Next.js 16 (App Router) + Supabase (Postgres + Auth), deployed on Vercel.

**Level reached:** Level 2 complete. Level 3 items 13 (race conditions), 14 (secure codes and rate limits) and 16 (roles and audit log) are built and verified. Items 12 (camera scanning) and 15 (email) are built and work locally; they still need a check on a real phone and with a real email service. Item 17 (deployment) is ready to do: follow [Deploy to Vercel](#deploy-to-vercel). See the [acceptance checklist](#acceptance-checklist).

## Tech stack

| Part | Choice |
|---|---|
| Framework | Next.js 16 App Router, TypeScript, React 19. Server Components for pages, Server Actions for forms, `proxy.ts` to guard staff URLs. Cache Components on: every page renders its data at request time behind a `<Suspense>` boundary. |
| Database | Supabase Postgres. Booking rules run inside Postgres functions so they stay atomic on serverless (see [Last spot and double scans](#last-spot-and-double-scans-level-3--item-13)). |
| Staff sign-in | Supabase Auth, email + password. Roles (organizer / door) and deactivation in a `staff_profiles` table. |
| Pages | The existing CSS (mobile first), no UI framework. |
| QR | `qrcode` draws the QR on the server. `jsQR` decodes it from the camera in the browser. |
| Email | `nodemailer` over SMTP (Resend, Brevo, Mailtrap…). Locally, Supabase's built-in Mailpit inbox. |
| Hosting | Vercel (app) + Supabase (database and auth). Both have free tiers. |
| Tests | Node's test runner via `tsx`, against the local Supabase database. 33 tests. |

## Run it locally

You need **Node.js 20.9+** and **Docker Desktop** (the Supabase CLI runs Postgres, Auth and Mailpit in Docker).

1. Install packages:

   ```powershell
   npm install
   ```

2. Start Docker Desktop, then start Supabase. The first run downloads the images and takes a few minutes:

   ```powershell
   npm run db:start
   ```

   It prints the API URL and keys. The migration in `supabase/migrations/` is applied automatically.

3. Create `.env.local` from `.env.example` and fill in `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (from the output above, or `npx supabase status`) and a random `TICKET_SECRET`. For local email, set `SMTP_HOST=127.0.0.1` and `SMTP_PORT=54325`.

4. Load the demo data (wipes events and registrations, creates the two staff logins):

   ```powershell
   npm run seed
   ```

5. Run the app:

   ```powershell
   npm run dev
   ```

Open http://localhost:3000. Staff sign-in is at http://localhost:3000/staff/login.

Other useful things:
- **Supabase Studio** (browse tables, run SQL): http://127.0.0.1:54323
- **Mailpit** (every email the app sends locally): http://127.0.0.1:54324
- `npm test` runs the tests against the local database. They create their own events and staff and delete them afterwards, so your demo data is untouched.
- `npm run db:reset` recreates the local database from the migrations (then run `npm run seed` again).
- `npm run db:stop` stops the Docker containers.

### Seed data

`npm run seed` **wipes events, registrations, the audit log and emails** and loads the demo data. Dates are relative to *today* in Cebu, so check-in works right away. **Run it again on the day you test.** It refuses to run against a hosted Supabase unless you add `-- --remote`.

| Event | When | State |
|---|---|---|
| Cebu Dev Meetup 2026, Ayala Center Cebu, Function Room 2 | today, 9:00 AM – 10:00 PM | Published · 18 of 30 registered (12 spots left) · 5 checked in · 1 cancelled |
| Cebu Hackathon Kickoff Night | today, 5:00 PM – 11:00 PM | Published · **Full** (12/12) · 3 on the waitlist |
| Cebu Startup Pitch Night | in 14 days | Published · 7 of 50 |
| Women in Tech Cebu: Career Talks | in 21 days | **Draft** (attendees can't see it) |
| Cebu Tech Talks Vol. 11 | 30 days ago | Ended |

### Demo staff logins

| Role | Email | Password | Can do |
|---|---|---|---|
| Organizer | `organizer@example.com` | `Organizer@2026` | Everything: events, attendees, waitlist, CSV, dashboard, audit log, staff accounts |
| Door staff | `door@example.com` | `DoorStaff@2026` | Check-in screen only, including undo |

Change them with the `SEED_*` values in `.env.local`, then run `npm run seed`. **Don't keep these demo passwords on a public deployment.**

## Deploy to Vercel

1. **Create a Supabase project** at [supabase.com](https://supabase.com) (free tier is fine). Pick the Singapore region for Cebu.
2. **Push the database schema** from your computer:

   ```powershell
   npx supabase login
   ```

   ```powershell
   npx supabase link --project-ref <your-project-ref>
   ```

   ```powershell
   npx supabase db push
   ```

3. **Turn off public sign-ups** in the Supabase dashboard: *Authentication → Sign In / Providers → Allow new users to sign up* = off. Staff accounts are created by organizers inside the app.
4. **Create the first organizer.** Either run the seed against the hosted project (put its URL and secret key in `.env.local` temporarily, then `npm run seed -- --remote`, then change the passwords), or create a user in *Authentication → Users* and add a row for it in the `staff_profiles` table with role `organizer`.
5. **Import the GitHub repo in Vercel** (framework: Next.js, no build settings to change) and add these environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (Supabase → Project Settings → API Keys)
   - `TICKET_SECRET` (long random string)
   - `APP_BASE_URL` (optional; defaults to your Vercel production domain)
   - the SMTP settings, e.g. Resend: `SMTP_HOST=smtp.resend.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER=resend`, `SMTP_PASS=<API key>`, and a `MAIL_FROM` on a domain you verified there
6. **Deploy**, then open the HTTPS link on a phone and try the camera scanner. Browsers only allow the camera on HTTPS or `localhost`.

## How it works

### Attendee
1. **Events** lists published events that haven't ended. Each card shows the date, start and end time in Cebu time (12-hour), the venue, and spots left, e.g. "12 of 30 spots left". Full events show **Full**. Ended events are listed under *Past events* and marked **Ended**.
2. **Register** asks for full name, email and a PH mobile number (`09171234567`; spaces, dashes and `+63` are accepted and normalised). Each field gets its own error message, and what you typed stays in the form. The server re-checks everything, including capacity.
3. The **ticket page** shows the event, date, time, venue, attendee name, ticket code and the QR code. It is sized for a phone held up at the door.
4. **Find my ticket** needs the ticket code **and** the email or mobile used to register. Any mismatch shows "Ticket not found" and nothing else. Lookups are rate-limited.
5. From the ticket page, attendees can **cancel** a confirmed or waitlisted registration. A checked-in registration can't be cancelled.

A ticket page only opens in a browser that registered it, looked it up with code + email, or opened the signed email link. That list lives in a signed, httpOnly cookie.

### Staff
- **Check-in** (both roles): pick the event, then scan with the camera or type the code. A USB/Bluetooth scanner that types the code and presses Enter also works. Each scan shows one big result, using both colour and words:
  - ✓ **Checked in** (green) with the name
  - ! **Already checked in** (yellow) with the first check-in time
  - ✕ **Invalid ticket** (red): the code doesn't exist or belongs to another event
  - ✕ **On waitlist — not confirmed** / ✕ **Cancelled** (red)
  - ✕ **Not the event day** (red): Confirmed tickets only check in on the event's date

  A live counter ("6 / 18 checked in") updates after each scan and every 5 seconds, so several door phones stay in sync. **Undo** is on the result and in the recent check-ins list. Beep and vibration give feedback without looking at the screen.
- **Camera scanning:** results stay on screen for about 2 seconds, then the scanner is ready for the next ticket. A QR still held in front of the camera isn't scanned twice. If the camera is blocked, the page says why and the typed-code box keeps working.
- **Dashboard** (organizer): every event that hasn't ended, with capacity, confirmed, waitlisted, cancelled, checked in and no-shows. No-shows appear only after the event starts.
- **Events** (organizer): create, edit, publish and close events. Enforced on the server and in the database: the end time must be after the start, capacity must be at least 1 and can't go below the number already registered, and an event with registrations can't go back to Draft.
- **Attendees** (organizer): totals, search by name, email or ticket code, filter by status, cancel, undo a check-in, **Promote #1 on waitlist** when a spot is open, and **Export CSV**.
- **Audit log** (organizer): who, what and when for event created/edited/status changed, registration cancelled, waitlist promotion, check-in, undo check-in, and staff account changes.
- **Staff** (organizer): add accounts (email + password) and deactivate or reactivate them. A deactivated account is refused on its next request and banned in Supabase Auth.
- **Emails** (organizer): every email the app sent or tried to send, with a preview.

### Booking rules
- Capacity counts **Confirmed + Checked in**. Waitlisted and Cancelled don't count.
- One **active** registration per email per event. Cancelled ones don't block registering again. This is a partial unique index in Postgres as well as an app check.
- Check-in only works for a **Confirmed** ticket, for the **selected event**, on the **event day** (Cebu time). A ticket checks in once.
- Times are stored as `timestamptz` and always shown in 12-hour Cebu time (Asia/Manila).

## Last spot and double scans (Level 3 · item 13)

On Vercel, every request can run in a different serverless instance, and supabase-js can't hold a transaction open across several calls. So each booking action is **one Postgres function** (`register_attendee`, `cancel_registration`, `promote_next`, `check_in`, `undo_check_in`, `save_event`; see `supabase/migrations/`), called with `supabase.rpc()`. Each runs as a single transaction:

1. **One writer per event at a time.** Every function starts with `SELECT … FROM events WHERE id = ? FOR UPDATE`. A second request for the same event waits until the first commits, then reads the updated count. Because every action takes the event lock first, they can't deadlock each other.
2. **The database refuses overbooking.** Triggers abort any insert or update that would push Confirmed + Checked in above capacity (`EVENT_FULL`) and any capacity change below the current count. They lock the event row themselves, so this holds even for writes that skip the app. A test proves it with direct inserts.
3. **Status checks inside the lock.** Check-in only changes a row that is still `confirmed`, so of several devices scanning one ticket at once, exactly one gets **Checked in** and the rest get **Already checked in**.

Tests: 12 people registering for the last spot at the same moment gives exactly 1 success and 11 "full" (each offered the waitlist). 4 devices scanning one ticket at once gives exactly 1 "Checked in" and 3 "Already checked in".

## Security (Level 3 · item 14 and the basics)

- **Server-only data access.** Row Level Security is on for every table with no policies, and the functions can only be run by `service_role`. The browser can't read or change anything directly, even with the public key (a test checks this). Every page, Server Action and route handler checks the signed-in staff member and role on the server first, then uses the secret key, which is never sent to the browser.
- **Ticket codes can't be guessed.** Codes look like `CDM-7K3P9QXM`: an event prefix plus 8 characters from a crypto-secure random generator in Crockford base32 (40 bits). They are never sequential. Typed `O`/`I`/`L` are read as `0`/`1`.
- **Rate limits** per IP for ticket lookup (10/min), registration (10/min) and sign-in (10 per 15 min), and per staff account for check-in (120/min). Counters live in Postgres, so they work across serverless instances.
- **Email links** carry an HMAC-SHA256 token. Without it, or a code + email lookup, a ticket page shows nothing.
- **Staff URLs** are guarded in `proxy.ts` (signed-out visitors go to sign-in; the JSON API answers 401) and again in each page and action (role and active checks).
- **Forms** use Server Actions, which Next.js protects against cross-site posting by checking the Origin header. Auth cookies are httpOnly, SameSite=Lax and Secure on HTTPS.
- **CSV export** neutralises `= + - @` at the start of a cell and keeps the leading zero of mobile numbers for Excel.
- Security headers: `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, a `Permissions-Policy` that only allows the camera, and HSTS.
- **Secrets** (`SUPABASE_SECRET_KEY`, `TICKET_SECRET`, SMTP) live in `.env.local` / Vercel environment variables, which git ignores. Only `.env.example` with placeholders is committed.

## Data model

```
staff_profiles  id → auth.users, name, email, role (organizer|door), active, created_at
events          id, title, description, venue, starts_at, ends_at (timestamptz), capacity (1..100000),
                status (draft|published|closed), code_prefix, created_by → staff_profiles, created_at, updated_at
                CHECK (ends_at > starts_at)
registrations   id, event_id → events, full_name, email (lower-case), mobile (09 + 9 digits), ticket_code (unique),
                status (confirmed|checked_in|waitlisted|cancelled), registered_at,
                promoted_at/_by, checked_in_at/_by, checkin_undone_at/_by, cancelled_at/_by   (_by → staff_profiles)
                UNIQUE (event_id, email) WHERE status <> 'cancelled'
audit_logs      id, staff_user_id, actor, action, target_type, target_id, event_id, details, created_at
email_outbox    id, kind, registration_id, to_address, subject, html, status (sent|failed|saved), error, created_at
rate_limits     key, count, reset_at
views           events_with_counts (registered, checked_in, waitlisted, …), registrations_detailed (waitlist position, staff names)
```

Everything, including the triggers and booking functions, is in [supabase/migrations/](supabase/migrations/).

## Project layout

```
src/
  app/                   pages (App Router). Public: /, /events/[id], /events/[id]/register, /tickets/find, /tickets/[code]
    staff/               staff area: dashboard, events, attendees (+ .csv), checkin, audit, users, outbox
    staff/actions.ts     Server Actions for staff forms; checkin-actions.ts for the scanner
  components/            header, event card, form field, confirm button, flash message
  lib/                   events, registrations, checkin, staff (database calls); auth, tickets, validation, time,
                         mailer, rate limit, ticket-access cookie; supabase/ (server clients)
  proxy.ts               refreshes the staff session and guards /staff
supabase/
  config.toml            local Supabase settings (public sign-ups off)
  migrations/            the database schema, triggers and booking functions
scripts/seed.ts          demo data
tests/                   unit tests + booking and check-in tests against the local database
```

## Known limitations

- **Single-day events.** The event form has one date with a start and end time. Events past midnight aren't supported in the form.
- **Check-in is open all of the event's date** (Cebu time), not only between the start and end times. This follows the "on the event day" rule.
- **Seeded dates move.** Demo events are placed relative to the day you run `npm run seed`. Re-seed on the day you test.
- **Manual waitlist promotion,** as the brief specifies. The organizer clicks **Promote #1** when a spot opens.
- **No password reset page.** An organizer can create a new account and deactivate the old one, or reset a password in the Supabase dashboard.
- **The check-in screen needs JavaScript** (camera, typed codes and USB scanners all go through it). The other pages' forms work as normal forms.
- **No strict Content-Security-Policy.** Next.js adds inline scripts, so a strict CSP would need per-request nonces. The other security headers are set.
- **Some "not found" pages return HTTP 200.** Pages stream their data, so a missing or draft event shows the not-found page with status 200 (and `noindex`). Nothing private is sent.

## Acceptance checklist

Legend: **Pass** = verified by the automated tests (`npm test`, 33/33) and/or by hand in the browser against local Supabase. **To check** = built, but needs a real phone, Excel or a real email service to confirm. **Not done** = not deployed yet.

### Level 1

| # | Check | Result |
|---|---|---|
| 1 | Register for Cebu Dev Meetup 2026 on a phone-sized screen and see a ticket with a QR code | **Pass**: browser |
| 2 | Scan the QR with any phone QR app: it shows the same ticket code | **To check** on a phone. The QR decodes back to the exact code with jsQR in the test suite. |
| 3 | Refresh, then find the ticket again with ticket code + email | **Pass**: test plus browser |
| 4 | A wrong ticket code or wrong email shows "Ticket not found" and no details | **Pass**: test plus browser |
| 5 | Register the same email twice for one event: the second attempt is blocked | **Pass** (letter case ignored) |
| 6 | Bad email and a 10-digit mobile number: both show errors | **Pass**: test plus browser |
| 7 | The seeded full event shows "Full" and the Register button is disabled | **Pass** (the database refuses too) |
| 8 | Open a staff page while signed out: sent to the sign-in page | **Pass** (the API returns 401) |
| 9 | Check in a valid ticket: green "Checked in" with the name | **Pass**: test plus browser |
| 10 | Check in the same ticket again: yellow "Already checked in" with the first time | **Pass** |
| 11 | A made-up code, and a real code from a different event: both "Invalid ticket" | **Pass** |
| 12 | The attendee list shows correct registered and checked-in totals | **Pass** |

### Level 2

| # | Check | Result |
|---|---|---|
| 1 | Create a Draft event: attendees can't see it. Publish it: it appears | **Pass** |
| 2 | Save an event whose end time is before its start time: blocked | **Pass** |
| 3 | Lower capacity below the number registered: blocked with a message | **Pass** |
| 4 | Fill an event, join the waitlist and see your position | **Pass** |
| 5 | Scan a waitlisted ticket: "On waitlist — not confirmed" | **Pass** |
| 6 | Cancel one confirmed registration: spots left goes up by 1; scanning it shows "Cancelled" | **Pass** |
| 7 | Promote the first waitlisted person: they now check in successfully | **Pass**: test plus browser |
| 8 | Cancel a checked-in registration: blocked | **Pass** |
| 9 | Undo a check-in: the ticket checks in again, and the undo is recorded | **Pass** (on the row and in the audit log) |
| 10 | Dashboard counts match the attendee list. CSV export opens correctly in Excel | Counts **Pass**. CSV format (UTF-8 BOM, leading zeros kept) checked in the browser. **To check**: open it in Excel. |

### Level 3

| # | Check | Result |
|---|---|---|
| 12 | Scan a ticket from another phone's screen with the camera: correct result, then ready for the next scan | **To check** on a phone over HTTPS. The "camera blocked" fallback is verified in the browser. |
| 13 | Two browsers register for the last spot at the same moment: only one gets it | **Pass** (12 at once gives 1 success) |
| 13 | Two devices check in the same ticket at the same moment: only one says "Checked in" | **Pass** (4 at once gives 1 "Checked in") |
| 14 | Guess a sequential or edited ticket code: never valid | **Pass** |
| 15 | Registration and promotion emails arrive in an inbox with the QR or ticket link | **Pass** locally (Mailpit). **To check** with a real SMTP service on Vercel. |
| 16 | Door staff can't create or edit events; Organizer can | **Pass** |
| 17 | The deployed link works on a phone over HTTPS, including the camera | **Not done** (see Deploy to Vercel) |
