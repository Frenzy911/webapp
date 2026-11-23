'use strict';

const { run } = require('../db');
const { toManilaIso } = require('./time');

const ACTION_LABELS = {
  event_created: 'Event created',
  event_updated: 'Event edited',
  event_status_changed: 'Event status changed',
  registration_cancelled: 'Registration cancelled',
  waitlist_promoted: 'Promoted from waitlist',
  checked_in: 'Checked in',
  checkin_undone: 'Check-in undone',
  staff_created: 'Staff account created',
  staff_deactivated: 'Staff account deactivated',
  staff_reactivated: 'Staff account reactivated',
};

function staffLabel(staff) {
  return `${staff.name} (${staff.role === 'organizer' ? 'Organizer' : 'Door staff'})`;
}

/**
 * Record who did what, and when. Call inside the same transaction as the change,
 * so the log and the data can never disagree.
 */
async function logAudit(db, { staff, actor, action, targetType = null, targetId = null, eventId = null, details = null }, now) {
  await run(
    db,
    `INSERT INTO audit_logs (staff_user_id, actor, action, target_type, target_id, event_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [staff ? staff.id : null, actor || (staff ? staffLabel(staff) : 'System'), action, targetType, targetId, eventId, details, toManilaIso(now)]
  );
}

module.exports = { logAudit, staffLabel, ACTION_LABELS };
