'use strict';

const { fromLocalParts } = require('./time');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function str(value) {
  return typeof value === 'string' ? value : '';
}

/** "0917 123 4567", "0917-123-4567" and "+639171234567" all become "09171234567". */
function normalizeMobile(raw) {
  let s = str(raw).replace(/[\s().-]/g, '');
  const intl = s.match(/^\+?63(9\d{9})$/);
  if (intl) s = '0' + intl[1];
  return s;
}

function normalizeEmail(raw) {
  return str(raw).trim().toLowerCase();
}

function validateRegistration(body) {
  const values = {
    fullName: str(body.full_name).trim().replace(/\s+/g, ' '),
    email: normalizeEmail(body.email),
    mobile: normalizeMobile(body.mobile),
  };
  const errors = {};

  if (!values.fullName) errors.full_name = 'Enter your full name.';
  else if (values.fullName.length < 2) errors.full_name = 'Your name looks too short.';
  else if (values.fullName.length > 100) errors.full_name = 'Keep your name under 100 characters.';

  if (!values.email) errors.email = 'Enter your email address.';
  else if (values.email.length > 254 || !EMAIL_RE.test(values.email)) errors.email = 'Enter a valid email address, like juan@example.com.';

  if (!str(body.mobile).trim()) errors.mobile = 'Enter your mobile number.';
  else if (!/^09\d{9}$/.test(values.mobile)) errors.mobile = 'Enter an 11-digit mobile number starting with 09, like 09171234567.';

  return { values, errors, ok: Object.keys(errors).length === 0 };
}

const EVENT_STATUSES = ['draft', 'published', 'closed'];

function validateEvent(body) {
  const values = {
    title: str(body.title).trim(),
    description: str(body.description).trim().replace(/\r\n/g, '\n'),
    venue: str(body.venue).trim(),
    date: str(body.date).trim(),
    startTime: str(body.start_time).trim(),
    endTime: str(body.end_time).trim(),
    capacity: str(body.capacity).trim(),
    status: str(body.status).trim(),
  };
  const errors = {};

  if (!values.title) errors.title = 'Enter a title.';
  else if (values.title.length > 120) errors.title = 'Keep the title under 120 characters.';
  if (values.description.length > 2000) errors.description = 'Keep the description under 2,000 characters.';
  if (!values.venue) errors.venue = 'Enter a venue.';
  else if (values.venue.length > 160) errors.venue = 'Keep the venue under 160 characters.';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date) || !fromLocalParts(values.date, '00:00')) errors.date = 'Choose a valid date.';
  if (!/^\d{2}:\d{2}$/.test(values.startTime)) errors.start_time = 'Choose a start time.';
  if (!/^\d{2}:\d{2}$/.test(values.endTime)) errors.end_time = 'Choose an end time.';

  let startsAt = null;
  let endsAt = null;
  if (!errors.date && !errors.start_time && !errors.end_time) {
    startsAt = fromLocalParts(values.date, values.startTime);
    endsAt = fromLocalParts(values.date, values.endTime);
    if (!startsAt) errors.start_time = 'Choose a valid start time.';
    else if (!endsAt) errors.end_time = 'Choose a valid end time.';
    else if (endsAt <= startsAt) errors.end_time = 'End time must be after the start time.';
  }

  const capacity = Number(values.capacity);
  if (!/^\d+$/.test(values.capacity) || !Number.isInteger(capacity) || capacity < 1) errors.capacity = 'Capacity must be a whole number, at least 1.';
  else if (capacity > 100000) errors.capacity = 'Capacity must be 100,000 or less.';

  if (!EVENT_STATUSES.includes(values.status)) errors.status = 'Choose a status.';

  return {
    values,
    errors,
    ok: Object.keys(errors).length === 0,
    data: {
      title: values.title,
      description: values.description,
      venue: values.venue,
      startsAt,
      endsAt,
      capacity,
      status: values.status,
    },
  };
}

function validateStaffUser(body) {
  const values = {
    name: str(body.name).trim(),
    username: str(body.username).trim().toLowerCase(),
    role: str(body.role),
  };
  const password = str(body.password);
  const errors = {};
  if (!values.name) errors.name = 'Enter a name.';
  else if (values.name.length > 100) errors.name = 'Keep the name under 100 characters.';
  if (!/^[a-z0-9._-]{3,32}$/.test(values.username)) errors.username = 'Use 3–32 letters, numbers, dots, dashes or underscores.';
  if (password.length < 8) errors.password = 'Use at least 8 characters.';
  if (!['organizer', 'door'].includes(values.role)) errors.role = 'Choose a role.';
  return { values, password, errors, ok: Object.keys(errors).length === 0 };
}

module.exports = {
  normalizeMobile,
  normalizeEmail,
  validateRegistration,
  validateEvent,
  validateStaffUser,
  EVENT_STATUSES,
};
