'use strict';

const bcrypt = require('bcryptjs');
const { transaction, isConstraintError } = require('../db');
const { ValidationError, AppError } = require('../lib/errors');
const { logAudit } = require('../lib/audit');
const { toManilaIso } = require('../lib/time');
const { validateStaffUser } = require('../lib/validation');

const BCRYPT_COST = 10;
// Compared against when the username doesn't exist, so a wrong username takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

function hashPassword(password) {
  return bcrypt.hashSync(password, BCRYPT_COST);
}

function getStaff(db, id) {
  return db.prepare('SELECT id, name, username, role, active, created_at FROM staff_users WHERE id = ?').get(Number(id) || 0) || null;
}

async function authenticate(db, username, password) {
  const user = db.prepare('SELECT * FROM staff_users WHERE username = ?').get(String(username || '').trim());
  const ok = await bcrypt.compare(String(password || ''), user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok || !user.active) return null;
  return getStaff(db, user.id);
}

function listStaff(db) {
  return db.prepare('SELECT id, name, username, role, active, created_at FROM staff_users ORDER BY active DESC, role DESC, name').all();
}

function createStaff(db, body, actor, now) {
  const v = validateStaffUser(body);
  if (!v.ok) throw new ValidationError(v.errors);
  const hash = hashPassword(v.password);
  return transaction(db, () => {
    try {
      const res = db
        .prepare('INSERT INTO staff_users (name, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(v.values.name, v.values.username, hash, v.values.role, toManilaIso(now));
      const id = Number(res.lastInsertRowid);
      logAudit(db, { staff: actor, action: 'staff_created', targetType: 'staff', targetId: id, details: `${v.values.name} (@${v.values.username}, ${v.values.role})` }, now);
      return id;
    } catch (err) {
      if (isConstraintError(err, 'staff_users.username')) throw new ValidationError({ username: 'That username is already taken.' });
      throw err;
    }
  });
}

function setStaffActive(db, id, active, actor, now) {
  return transaction(db, () => {
    const user = getStaff(db, id);
    if (!user) throw new AppError('NOT_FOUND', 'Staff account not found.', { status: 404 });
    if (user.id === actor.id) throw new AppError('SELF', "You can't deactivate your own account.");
    if (!active && user.role === 'organizer') {
      const { n } = db.prepare("SELECT COUNT(*) AS n FROM staff_users WHERE role = 'organizer' AND active = 1").get();
      if (n <= 1) throw new AppError('LAST_ORGANIZER', 'At least one organizer account must stay active.');
    }
    db.prepare('UPDATE staff_users SET active = ? WHERE id = ?').run(active ? 1 : 0, user.id);
    logAudit(db, { staff: actor, action: active ? 'staff_reactivated' : 'staff_deactivated', targetType: 'staff', targetId: user.id, details: `${user.name} (@${user.username})` }, now);
  });
}

module.exports = { hashPassword, getStaff, authenticate, listStaff, createStaff, setStaffActive };
