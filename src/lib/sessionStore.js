'use strict';

const session = require('express-session');
const { get, run } = require('../db');

/** express-session store backed by the app's MySQL database (survives restarts). */
class MysqlSessionStore extends session.Store {
  constructor(db, { ttlMs = 24 * 60 * 60 * 1000 } = {}) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
    this.timer = setInterval(() => this.prune(), 15 * 60 * 1000);
    this.timer.unref();
  }

  expiry(sess) {
    const expires = sess && sess.cookie && sess.cookie.expires;
    return expires ? new Date(expires).getTime() : Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    get(this.db, 'SELECT data FROM sessions WHERE sid = ? AND expires_at > ?', [sid, Date.now()])
      .then((row) => {
        let sess;
        try {
          sess = row ? JSON.parse(row.data) : null;
        } catch (err) {
          return cb(err);
        }
        return cb(null, sess);
      }, cb);
  }

  set(sid, sess, cb = () => {}) {
    const data = JSON.stringify(sess);
    const expires = this.expiry(sess);
    run(this.db, 'INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = ?, expires_at = ?', [sid, data, expires, data, expires])
      .then(() => cb(null), cb);
  }

  touch(sid, sess, cb = () => {}) {
    run(this.db, 'UPDATE sessions SET expires_at = ? WHERE sid = ?', [this.expiry(sess), sid])
      .then(() => cb(null), cb);
  }

  destroy(sid, cb = () => {}) {
    run(this.db, 'DELETE FROM sessions WHERE sid = ?', [sid])
      .then(() => cb(null), cb);
  }

  prune() {
    run(this.db, 'DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]).catch(() => {
      /* pool closed */
    });
  }

  close() {
    clearInterval(this.timer);
  }
}

module.exports = { MysqlSessionStore };
