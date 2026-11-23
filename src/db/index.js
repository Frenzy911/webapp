'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  db.exec(SCHEMA);
  return db;
}

/**
 * Run `fn` inside a write transaction.
 *
 * BEGIN IMMEDIATE takes SQLite's write lock up front, so two requests (or two server
 * processes sharing the file) can never read "1 spot left" at the same time and both
 * take it: the second one waits until the first commits, then sees the new count.
 * `fn` must be synchronous: no awaits inside a transaction.
 */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

function isConstraintError(err, text) {
  return Boolean(err && typeof err.message === 'string' && err.message.includes(text));
}

module.exports = { openDb, transaction, isConstraintError };
