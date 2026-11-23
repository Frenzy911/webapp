-- Event registration + QR check-in schema (SQLite).
-- Times are ISO 8601 strings in Cebu time with an explicit offset, e.g. 2026-12-05T18:00:00+08:00.

CREATE TABLE IF NOT EXISTS staff_users (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,                       -- bcrypt hash, never plain text
  role          TEXT    NOT NULL CHECK (role IN ('organizer', 'door')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  title       TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  venue       TEXT    NOT NULL,
  starts_at   TEXT    NOT NULL,
  ends_at     TEXT    NOT NULL,
  capacity    INTEGER NOT NULL CHECK (capacity >= 1),
  status      TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed')),
  code_prefix TEXT    NOT NULL,                         -- ticket code prefix, e.g. CDM
  created_by  INTEGER REFERENCES staff_users(id),
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS registrations (
  id                 INTEGER PRIMARY KEY,
  event_id           INTEGER NOT NULL REFERENCES events(id),
  full_name          TEXT    NOT NULL,
  email              TEXT    NOT NULL,                  -- stored lower-case
  mobile             TEXT    NOT NULL,                  -- 11 digits, starts with 09
  ticket_code        TEXT    NOT NULL UNIQUE,           -- random, e.g. CDM-7K3P9QXM
  status             TEXT    NOT NULL CHECK (status IN ('confirmed', 'checked_in', 'waitlisted', 'cancelled')),
  registered_at      TEXT    NOT NULL,
  promoted_at        TEXT,
  promoted_by        INTEGER REFERENCES staff_users(id),
  checked_in_at      TEXT,
  checked_in_by      INTEGER REFERENCES staff_users(id),
  checkin_undone_at  TEXT,
  checkin_undone_by  INTEGER REFERENCES staff_users(id),
  cancelled_at       TEXT,
  cancelled_by       INTEGER REFERENCES staff_users(id)  -- NULL when the attendee cancelled
);

-- One active registration per email per event. Cancelled rows do not block re-registering.
CREATE UNIQUE INDEX IF NOT EXISTS ux_registrations_active_email
  ON registrations (event_id, email) WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS ix_registrations_event_status ON registrations (event_id, status);

CREATE TABLE IF NOT EXISTS audit_logs (
  id            INTEGER PRIMARY KEY,
  staff_user_id INTEGER REFERENCES staff_users(id),     -- NULL when an attendee did it
  actor         TEXT    NOT NULL,                       -- readable "who"
  action        TEXT    NOT NULL,
  target_type   TEXT,
  target_id     INTEGER,
  event_id      INTEGER REFERENCES events(id),
  details       TEXT,
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_logs (created_at);

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT    PRIMARY KEY,
  data       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS email_outbox (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL,                        -- registration | waitlist | promotion
  registration_id INTEGER REFERENCES registrations(id),
  to_address      TEXT NOT NULL,
  subject         TEXT NOT NULL,
  html            TEXT NOT NULL,                        -- preview copy (QR inlined as data URI)
  status          TEXT NOT NULL,                        -- sent | failed | saved (no SMTP configured)
  error           TEXT,
  created_at      TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Database-level capacity guard (second line of defence behind the app's
-- BEGIN IMMEDIATE transaction). Confirmed + checked-in rows can never exceed capacity.
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_registrations_capacity_insert
BEFORE INSERT ON registrations
WHEN NEW.status IN ('confirmed', 'checked_in')
 AND (SELECT COUNT(*) FROM registrations WHERE event_id = NEW.event_id AND status IN ('confirmed', 'checked_in'))
     >= (SELECT capacity FROM events WHERE id = NEW.event_id)
BEGIN
  SELECT RAISE(ABORT, 'EVENT_FULL');
END;

CREATE TRIGGER IF NOT EXISTS trg_registrations_capacity_update
BEFORE UPDATE OF status ON registrations
WHEN NEW.status IN ('confirmed', 'checked_in')
 AND OLD.status NOT IN ('confirmed', 'checked_in')
 AND (SELECT COUNT(*) FROM registrations WHERE event_id = NEW.event_id AND status IN ('confirmed', 'checked_in'))
     >= (SELECT capacity FROM events WHERE id = NEW.event_id)
BEGIN
  SELECT RAISE(ABORT, 'EVENT_FULL');
END;

CREATE TRIGGER IF NOT EXISTS trg_events_capacity_shrink
BEFORE UPDATE OF capacity ON events
WHEN NEW.capacity < (SELECT COUNT(*) FROM registrations WHERE event_id = NEW.id AND status IN ('confirmed', 'checked_in'))
BEGIN
  SELECT RAISE(ABORT, 'CAPACITY_BELOW_REGISTERED');
END;
