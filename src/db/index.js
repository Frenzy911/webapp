'use strict';

const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

// Applied to every connection, whatever the server defaults are (XAMPP, MySQL 8 and cloud hosts all differ).
const SESSION_SETUP = [
  // Strict mode: a value that doesn't fit is an error, never silently cut short.
  "SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'",
  // Every statement sees the latest committed data. See transaction() below.
  'SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED',
];

function connectionOptions(settings) {
  return {
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: settings.password,
    database: settings.database,
    charset: 'utf8mb4_unicode_ci',
    decimalNumbers: true, // SUM() comes back as a number, not a string
    dateStrings: true,
  };
}

function friendlyConnectError(err, settings) {
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(err.code)) {
    err.message =
      `Can't reach MySQL at ${settings.host}:${settings.port} (${err.code}). Is the MySQL server running? ` +
      '(XAMPP: click Start next to MySQL in the Control Panel.) Check MYSQL_HOST and MYSQL_PORT in .env.';
  } else if (err.code === 'ER_ACCESS_DENIED_ERROR') {
    err.message = `MySQL refused user "${settings.user}". Check MYSQL_USER and MYSQL_PASSWORD in .env.`;
  }
  return err;
}

/** Connect for setup work. Creates the database the first time if the user is allowed to. */
async function connectForSetup(settings) {
  const options = connectionOptions(settings);
  try {
    return await mysql.createConnection(options);
  } catch (err) {
    if (err.code !== 'ER_BAD_DB_ERROR') throw friendlyConnectError(err, settings);
    const server = await mysql.createConnection({ ...options, database: undefined });
    try {
      await server.query(`CREATE DATABASE IF NOT EXISTS ${mysql.escapeId(settings.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } finally {
      await server.end();
    }
    return mysql.createConnection(options);
  }
}

/**
 * Split schema.sql into statements. Understands the `DELIMITER $$` lines the mysql client
 * and phpMyAdmin use, so the same file works for the app and for a manual import.
 */
function splitStatements(sql) {
  const statements = [];
  let delimiter = ';';
  let current = [];
  for (const line of sql.split(/\r?\n/)) {
    const d = line.match(/^\s*DELIMITER\s+(\S+)\s*$/i);
    if (d) {
      delimiter = d[1];
      continue;
    }
    if (!current.length && (/^\s*--/.test(line) || !line.trim())) continue;
    current.push(line);
    if (line.trimEnd().endsWith(delimiter)) {
      const text = current.join('\n').trimEnd();
      statements.push(text.slice(0, text.length - delimiter.length).trim());
      current = [];
    }
  }
  if (current.join('').trim()) statements.push(current.join('\n').trim());
  return statements;
}

/** Create missing tables and triggers. Existing ones are left as they are. */
async function applySchema(conn) {
  const [rows] = await conn.query('SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()');
  const existingTriggers = new Set(rows.map((r) => r.name.toLowerCase()));
  for (const statement of splitStatements(fs.readFileSync(SCHEMA_FILE, 'utf8'))) {
    const trigger = statement.match(/^(?:DROP|CREATE)\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?`?(\w+)`?/i);
    if (trigger && existingTriggers.has(trigger[1].toLowerCase())) continue;
    try {
      await conn.query(statement);
    } catch (err) {
      if (err.code === 'ER_BINLOG_CREATE_ROUTINE_NEED_SUPER') {
        err.message += ' Ask your host to set log_bin_trust_function_creators=1, or create the triggers as an admin user.';
      }
      throw err;
    }
  }
}

/**
 * Open a connection pool to the MySQL database in `settings` ({ host, port, user, password, database }),
 * creating the database and tables on first run.
 */
async function openDb(settings) {
  const setup = await connectForSetup(settings);
  try {
    await applySchema(setup);
  } finally {
    await setup.end();
  }

  const pool = mysql.createPool({ ...connectionOptions(settings), connectionLimit: 10, waitForConnections: true });
  pool.on('connection', (conn) => {
    for (const sql of SESSION_SETUP) {
      conn.query(sql, (err) => {
        if (err) console.error(`[db] ${sql} failed: ${err.message}`);
      });
    }
  });
  return pool;
}

/** `db` is the pool, or the connection of a transaction. */
async function all(db, sql, params = []) {
  const [rows] = await db.query(sql, params);
  return rows;
}

async function get(db, sql, params = []) {
  const rows = await all(db, sql, params);
  return rows[0] || null;
}

/** INSERT / UPDATE / DELETE. Returns { insertId, changes }. */
async function run(db, sql, params = []) {
  const [res] = await db.query(sql, params);
  return { insertId: res.insertId, changes: res.affectedRows };
}

/**
 * Run `fn(conn)` inside a transaction on one pooled connection, and commit (or roll back on error).
 *
 * Booking actions call lockEvent() first: `SELECT … FOR UPDATE` on the event row. Two requests
 * for the same event can then never both read "1 spot left" and both take it: the second one
 * waits until the first commits, and because connections use READ COMMITTED it then reads the
 * new count. A deadlock (InnoDB rolls one side back) is retried a couple of times.
 */
async function transaction(db, fn, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback().catch(() => {});
      if (err.code === 'ER_LOCK_DEADLOCK' && attempt < retries) continue;
      throw err;
    } finally {
      conn.release();
    }
  }
}

/** Lock one event row until the transaction ends. Call before reading counts you are about to change. */
async function lockEvent(conn, eventId) {
  return get(conn, 'SELECT id FROM events WHERE id = ? FOR UPDATE', [Number(eventId) || 0]);
}

/** True for a duplicate key on the named UNIQUE index, or a trigger error with this text (e.g. EVENT_FULL). */
function isConstraintError(err, text) {
  return Boolean(err && typeof err.message === 'string' && err.message.includes(text));
}

module.exports = { openDb, transaction, lockEvent, all, get, run, isConstraintError, splitStatements };
