'use strict';

const session = require('express-session');

/** express-session store backed by the app's SQLite database (survives restarts). */
class SqliteSessionStore extends session.Store {
  constructor(db, { ttlMs = 24 * 60 * 60 * 1000 } = {}) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
    this.getStmt = db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires_at > ?');
    this.setStmt = db.prepare(
      'INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at'
    );
    this.touchStmt = db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?');
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.pruneStmt = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
    this.timer = setInterval(() => this.prune(), 15 * 60 * 1000);
    this.timer.unref();
  }

  expiry(sess) {
    const expires = sess && sess.cookie && sess.cookie.expires;
    return expires ? new Date(expires).getTime() : Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb = () => {}) {
    try {
      this.setStmt.run(sid, JSON.stringify(sess), this.expiry(sess));
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sess, cb = () => {}) {
    try {
      this.touchStmt.run(this.expiry(sess), sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb = () => {}) {
    try {
      this.destroyStmt.run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  prune() {
    try {
      this.pruneStmt.run(Date.now());
    } catch {
      /* db closed */
    }
  }

  close() {
    clearInterval(this.timer);
  }
}

module.exports = { SqliteSessionStore };
