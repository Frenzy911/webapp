import 'server-only';
import { db } from './supabase/admin';
import { AppError, ValidationError, dbErrorCode, unexpected } from './errors';
import { validateStaffUser } from './validation';
import { staffLabel, type Staff } from './types';

const STAFF_COLUMNS = 'id, name, email, role, active, created_at';

export async function getStaff(id: string): Promise<Staff | null> {
  const { data, error } = await db().from('staff_profiles').select(STAFF_COLUMNS).eq('id', id).maybeSingle<Staff>();
  if (error) unexpected(error, 'getStaff');
  return data;
}

export async function listStaff(): Promise<Staff[]> {
  const { data, error } = await db()
    .from('staff_profiles')
    .select(STAFF_COLUMNS)
    .order('active', { ascending: false })
    .order('role', { ascending: false })
    .order('name');
  if (error) unexpected(error, 'listStaff');
  return (data || []) as Staff[];
}

/** Create a Supabase Auth user (email + password, already confirmed) and its staff profile. */
export async function createStaff(body: Record<string, unknown>, actor: Staff, now: Date): Promise<Staff> {
  const v = validateStaffUser(body);
  if (!v.ok) throw new ValidationError(v.errors);

  const { data: created, error: authError } = await db().auth.admin.createUser({
    email: v.values.email,
    password: v.password,
    email_confirm: true,
    user_metadata: { name: v.values.name },
  });
  if (authError) {
    if (authError.code === 'email_exists' || /already (been )?registered/i.test(authError.message)) {
      throw new ValidationError({ email: 'A staff account with this email already exists.' });
    }
    if (authError.code === 'weak_password') throw new ValidationError({ password: authError.message });
    throw new Error(`createUser: ${authError.message}`);
  }

  const { data, error } = await db().rpc('add_staff_profile', {
    p_id: created.user.id,
    p_name: v.values.name,
    p_email: v.values.email,
    p_role: v.values.role,
    p_staff: actor.id,
    p_actor: staffLabel(actor),
    p_now: now.toISOString(),
  });
  if (error) {
    await db().auth.admin.deleteUser(created.user.id); // don't leave a login without a profile
    unexpected(error, 'add_staff_profile');
  }
  return data as Staff;
}

const ACTIVE_ERRORS: Record<string, string> = {
  NOT_FOUND: 'Staff account not found.',
  SELF: "You can't deactivate your own account.",
  LAST_ORGANIZER: 'At least one organizer account must stay active.',
};

/**
 * Deactivate or reactivate. A deactivated account is refused on its next request (the app checks
 * `active` every time) and is banned in Supabase Auth so it can't sign in again.
 */
export async function setStaffActive(id: string, active: boolean, actor: Staff, now: Date): Promise<void> {
  const { error } = await db().rpc('set_staff_active', {
    p_id: id,
    p_active: active,
    p_staff: actor.id,
    p_actor: staffLabel(actor),
    p_now: now.toISOString(),
  });
  const code = dbErrorCode(error);
  if (code && ACTIVE_ERRORS[code]) throw new AppError(code, ACTIVE_ERRORS[code], code === 'NOT_FOUND' ? 404 : 400);
  if (error) unexpected(error, 'setStaffActive');
  const { error: banError } = await db().auth.admin.updateUserById(id, { ban_duration: active ? 'none' : '876000h' });
  if (banError) console.error(`[staff] could not ${active ? 'unban' : 'ban'} ${id}: ${banError.message}`);
}
