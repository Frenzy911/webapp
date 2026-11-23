import type { EventStatus } from './validation';

export type StaffRole = 'organizer' | 'door';

export type Staff = {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  active: boolean;
  created_at: string;
};

export type RegistrationStatus = 'confirmed' | 'checked_in' | 'waitlisted' | 'cancelled';

export type Registration = {
  id: number;
  event_id: number;
  full_name: string;
  email: string;
  mobile: string;
  ticket_code: string;
  status: RegistrationStatus;
  registered_at: string;
  promoted_at: string | null;
  promoted_by: string | null;
  checked_in_at: string | null;
  checked_in_by: string | null;
  checkin_undone_at: string | null;
  checkin_undone_by: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
};

export type RegistrationDetailed = Registration & {
  waitlist_position: number | null;
  checked_in_by_name: string | null;
  checkin_undone_by_name: string | null;
  cancelled_by_name: string | null;
};

export type EventRow = {
  id: number;
  title: string;
  description: string;
  venue: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  status: EventStatus;
  code_prefix: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  registered: number;
  checked_in: number;
  not_checked_in: number;
  waitlisted: number;
  cancelled: number;
};

/** An event plus the computed fields every screen uses. */
export type EventView = EventRow & {
  spotsLeft: number;
  isFull: boolean;
  hasStarted: boolean;
  hasEnded: boolean;
  isEventDay: boolean;
  registrationOpen: boolean;
  dateLabel: string;
  timeLabel: string;
  /** No-shows only make sense once the event has started. */
  noShows: number | null;
};

export type Stats = { checkedIn: number; registered: number };

export const STATUS_LABELS: Record<string, string> = {
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  waitlisted: 'Waitlisted',
  cancelled: 'Cancelled',
  draft: 'Draft',
  published: 'Published',
  closed: 'Closed',
};

export function staffLabel(staff: Pick<Staff, 'name' | 'role'>): string {
  return `${staff.name} (${staff.role === 'organizer' ? 'Organizer' : 'Door staff'})`;
}

export const ACTION_LABELS: Record<string, string> = {
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
