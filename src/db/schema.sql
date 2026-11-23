-- Event registration + QR check-in schema (MySQL 8 / MariaDB 10.6+).
-- Times are ISO 8601 strings in Cebu time with an explicit offset, e.g. 2026-12-05T18:00:00+08:00.
-- Every stored time has the same offset, so plain string comparison sorts them correctly.
--
-- The app runs this file on start-up (CREATE TABLE IF NOT EXISTS, and each trigger only if it is missing).
-- You can also import it yourself: `mysql -u root cebu_events < src/db/schema.sql` or phpMyAdmin → Import.

CREATE TABLE IF NOT EXISTS staff_users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  username      VARCHAR(64)  NOT NULL,                  -- case-insensitive (utf8mb4_unicode_ci)
  password_hash VARCHAR(100) NOT NULL,                  -- bcrypt hash, never plain text
  role          VARCHAR(16)  NOT NULL,
  active        TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    VARCHAR(25)  NOT NULL,
  UNIQUE KEY uq_staff_users_username (username),
  CONSTRAINT chk_staff_users_role CHECK (role IN ('organizer', 'door'))
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS events (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title       VARCHAR(120) NOT NULL,
  description TEXT         NOT NULL,
  venue       VARCHAR(160) NOT NULL,
  starts_at   VARCHAR(25)  NOT NULL,
  ends_at     VARCHAR(25)  NOT NULL,
  capacity    INT          NOT NULL,
  status      VARCHAR(16)  NOT NULL DEFAULT 'draft',
  code_prefix VARCHAR(8)   NOT NULL,                    -- ticket code prefix, e.g. CDM
  created_by  INT UNSIGNED NULL,
  created_at  VARCHAR(25)  NOT NULL,
  updated_at  VARCHAR(25)  NOT NULL,
  KEY ix_events_starts_at (starts_at),
  CONSTRAINT fk_events_created_by FOREIGN KEY (created_by) REFERENCES staff_users (id),
  CONSTRAINT chk_events_capacity CHECK (capacity >= 1),
  CONSTRAINT chk_events_status CHECK (status IN ('draft', 'published', 'closed')),
  CONSTRAINT chk_events_times CHECK (ends_at > starts_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS registrations (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id           INT UNSIGNED NOT NULL,
  full_name          VARCHAR(100) NOT NULL,
  email              VARCHAR(254) NOT NULL,             -- stored lower-case
  mobile             VARCHAR(20)  NOT NULL,             -- 11 digits, starts with 09
  ticket_code        VARCHAR(20)  CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, -- random, e.g. CDM-7K3P9QXM
  status             VARCHAR(16)  NOT NULL,
  registered_at      VARCHAR(25)  NOT NULL,
  promoted_at        VARCHAR(25)  NULL,
  promoted_by        INT UNSIGNED NULL,
  checked_in_at      VARCHAR(25)  NULL,
  checked_in_by      INT UNSIGNED NULL,
  checkin_undone_at  VARCHAR(25)  NULL,
  checkin_undone_by  INT UNSIGNED NULL,
  cancelled_at       VARCHAR(25)  NULL,
  cancelled_by       INT UNSIGNED NULL,                 -- NULL when the attendee cancelled
  -- One active registration per email per event; cancelled rows do not block re-registering.
  -- MySQL has no partial unique index, so this column is the email while active and NULL once
  -- cancelled (a UNIQUE index allows any number of NULLs).
  active_email       VARCHAR(254) GENERATED ALWAYS AS (IF(status <> 'cancelled', email, NULL)) STORED,
  UNIQUE KEY uq_registrations_ticket_code (ticket_code),
  UNIQUE KEY uq_registrations_active_email (event_id, active_email),
  KEY ix_registrations_event_status (event_id, status),
  CONSTRAINT fk_registrations_event FOREIGN KEY (event_id) REFERENCES events (id),
  CONSTRAINT fk_registrations_promoted_by FOREIGN KEY (promoted_by) REFERENCES staff_users (id),
  CONSTRAINT fk_registrations_checked_in_by FOREIGN KEY (checked_in_by) REFERENCES staff_users (id),
  CONSTRAINT fk_registrations_checkin_undone_by FOREIGN KEY (checkin_undone_by) REFERENCES staff_users (id),
  CONSTRAINT fk_registrations_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES staff_users (id),
  CONSTRAINT chk_registrations_status CHECK (status IN ('confirmed', 'checked_in', 'waitlisted', 'cancelled'))
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  staff_user_id INT UNSIGNED NULL,                      -- NULL when an attendee did it
  actor         VARCHAR(400) NOT NULL,                  -- readable "who"
  action        VARCHAR(40)  NOT NULL,
  target_type   VARCHAR(20)  NULL,
  target_id     INT UNSIGNED NULL,
  event_id      INT UNSIGNED NULL,
  details       TEXT         NULL,
  created_at    VARCHAR(25)  NOT NULL,
  KEY ix_audit_created (created_at),
  CONSTRAINT fk_audit_logs_staff FOREIGN KEY (staff_user_id) REFERENCES staff_users (id),
  CONSTRAINT fk_audit_logs_event FOREIGN KEY (event_id) REFERENCES events (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  sid        VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  data       MEDIUMTEXT   NOT NULL,
  expires_at BIGINT       NOT NULL,                     -- milliseconds since 1970
  KEY ix_sessions_expires (expires_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS email_outbox (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind            VARCHAR(20)  NOT NULL,                -- registration | waitlist | promotion
  registration_id INT UNSIGNED NULL,
  to_address      VARCHAR(254) NOT NULL,
  subject         VARCHAR(400) NOT NULL,
  html            MEDIUMTEXT   NOT NULL,                -- preview copy (QR inlined as data URI)
  status          VARCHAR(10)  NOT NULL,                -- sent | failed | saved (no SMTP configured)
  error           TEXT         NULL,
  created_at      VARCHAR(25)  NOT NULL,
  CONSTRAINT fk_email_outbox_registration FOREIGN KEY (registration_id) REFERENCES registrations (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Database-level capacity guard (second line of defence behind the app's
-- SELECT … FOR UPDATE on the event row). Confirmed + checked-in rows can never
-- exceed capacity. Each trigger locks the event row first, so it also holds for
-- writes that don't go through the app.
-- ---------------------------------------------------------------------------
DELIMITER $$

DROP TRIGGER IF EXISTS trg_registrations_capacity_insert $$
CREATE TRIGGER trg_registrations_capacity_insert
BEFORE INSERT ON registrations
FOR EACH ROW
BEGIN
  DECLARE cap INT;
  DECLARE taken INT;
  IF NEW.status IN ('confirmed', 'checked_in') THEN
    SELECT capacity INTO cap FROM events WHERE id = NEW.event_id FOR UPDATE;
    SELECT COUNT(*) INTO taken FROM registrations
     WHERE event_id = NEW.event_id AND status IN ('confirmed', 'checked_in');
    IF taken >= cap THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'EVENT_FULL';
    END IF;
  END IF;
END $$

DROP TRIGGER IF EXISTS trg_registrations_capacity_update $$
CREATE TRIGGER trg_registrations_capacity_update
BEFORE UPDATE ON registrations
FOR EACH ROW
BEGIN
  DECLARE cap INT;
  DECLARE taken INT;
  IF NEW.status IN ('confirmed', 'checked_in') AND OLD.status NOT IN ('confirmed', 'checked_in') THEN
    SELECT capacity INTO cap FROM events WHERE id = NEW.event_id FOR UPDATE;
    SELECT COUNT(*) INTO taken FROM registrations
     WHERE event_id = NEW.event_id AND status IN ('confirmed', 'checked_in');
    IF taken >= cap THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'EVENT_FULL';
    END IF;
  END IF;
END $$

DROP TRIGGER IF EXISTS trg_events_capacity_shrink $$
CREATE TRIGGER trg_events_capacity_shrink
BEFORE UPDATE ON events
FOR EACH ROW
BEGIN
  DECLARE taken INT;
  IF NEW.capacity < OLD.capacity THEN
    SELECT COUNT(*) INTO taken FROM registrations
     WHERE event_id = NEW.id AND status IN ('confirmed', 'checked_in');
    IF NEW.capacity < taken THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CAPACITY_BELOW_REGISTERED';
    END IF;
  END IF;
END $$

DELIMITER ;
