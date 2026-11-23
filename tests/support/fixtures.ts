/**
 * Test data on the local Supabase. Each test file creates its own staff accounts and events
 * (unique names) and deletes them afterwards, so the demo data you seeded is left alone.
 */
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { fromLocalParts } from '../../src/lib/time';
import { generateTicketCode, prefixFromTitle } from '../../src/lib/tickets';
import type { Registration, Staff } from '../../src/lib/types';

// Tests run on a fixed clock: Saturday, Dec 5, 2026, 12:00 PM Cebu time.
export const TODAY = '2026-12-05';
export const NOW = new Date(`${TODAY}T12:00:00+08:00`);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const secret = process.env.SUPABASE_SECRET_KEY!;
if (!url || !secret) throw new Error('Run the tests with npm test (it loads .env.local).');
if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)) throw new Error(`Tests only run against a local Supabase, not ${url}.`);

export const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

export function fixtures() {
  const run = crypto.randomBytes(3).toString('hex');
  const eventIds: number[] = [];
  const staffIds: string[] = [];

  async function makeStaff(role: 'organizer' | 'door', name = role === 'organizer' ? 'Olivia Organizer' : 'Dario Door'): Promise<Staff> {
    const email = `${role}-${run}-${staffIds.length}@test.example.com`;
    const { data, error } = await admin.auth.admin.createUser({ email, password: 'test-password-1', email_confirm: true });
    if (error) throw new Error(error.message);
    const profile = { id: data.user.id, name, email, role, active: true };
    const res = await admin.from('staff_profiles').insert(profile).select().single();
    if (res.error) throw new Error(res.error.message);
    staffIds.push(data.user.id);
    return res.data as Staff;
  }

  /** Defaults: published, Dec 5 2026 09:00–22:00 Cebu time. */
  async function makeEvent({ title = 'Test Event', capacity = 5, status = 'published', date = TODAY, start = '09:00', end = '22:00' } = {}): Promise<number> {
    const { data, error } = await admin
      .from('events')
      .insert({
        title: `${title}`,
        description: 'A test event.',
        venue: 'Ayala Center Cebu, Function Room 2',
        starts_at: fromLocalParts(date, start),
        ends_at: fromLocalParts(date, end),
        capacity,
        status,
        code_prefix: prefixFromTitle(title),
      })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    eventIds.push(data.id);
    return data.id;
  }

  /** Insert a registration directly (bypasses the booking rules, like a seed script would). */
  async function addRegistration(eventId: number, { name = 'Seed Person', email = '', mobile = '09170000000', status = 'confirmed' } = {}): Promise<Registration> {
    const { data: ev } = await admin.from('events').select('code_prefix').eq('id', eventId).single();
    const { data, error } = await admin
      .from('registrations')
      .insert({
        event_id: eventId,
        full_name: name,
        email: email || `${crypto.randomBytes(5).toString('hex')}@example.com`,
        mobile,
        ticket_code: generateTicketCode(ev!.code_prefix),
        status,
        registered_at: NOW.toISOString(),
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data as Registration;
  }

  async function reg(id: number): Promise<Registration> {
    const { data, error } = await admin.from('registrations').select('*').eq('id', id).single();
    if (error) throw new Error(error.message);
    return data as Registration;
  }

  async function count(eventId: number, statuses: string[]): Promise<number> {
    const { count: n, error } = await admin.from('registrations').select('id', { count: 'exact', head: true }).eq('event_id', eventId).in('status', statuses);
    if (error) throw new Error(error.message);
    return n ?? 0;
  }

  async function cleanup() {
    if (eventIds.length) {
      const { data: regs } = await admin.from('registrations').select('id').in('event_id', eventIds);
      const regIds = (regs || []).map((r) => r.id);
      if (regIds.length) await admin.from('email_outbox').delete().in('registration_id', regIds);
      await admin.from('audit_logs').delete().in('event_id', eventIds);
      await admin.from('registrations').delete().in('event_id', eventIds);
      await admin.from('events').delete().in('id', eventIds);
    }
    if (staffIds.length) {
      await admin.from('audit_logs').delete().in('staff_user_id', staffIds);
      for (const id of staffIds) await admin.auth.admin.deleteUser(id); // cascades to staff_profiles
    }
  }

  /** Clean up an event the test created through the app. */
  function track(eventId: number): number {
    eventIds.push(eventId);
    return eventId;
  }

  return { run, makeStaff, makeEvent, addRegistration, reg, count, track, cleanup };
}
