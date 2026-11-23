-- Cebu Events: event registration with QR check-in.
--
-- Access model: Row Level Security is on for every table with NO policies, and the functions
-- below can only be executed by service_role. The browser never talks to the database directly:
-- every read and write goes through the Next.js server, which checks who is asking first and
-- then uses the secret (service_role) key. Supabase Auth is used only to sign staff in.
--
-- Concurrency: every booking function starts with SELECT … FOR UPDATE on the event row, so two
-- requests for the same event run one after the other (one can't take a spot the other just saw
-- as free). The capacity triggers are a second line of defence that also locks the event row.

-- ---------------------------------------------------------------------------- tables

create table public.staff_profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 100),
  email      text not null,
  role       text not null check (role in ('organizer', 'door')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.events (
  id          bigint generated always as identity primary key,
  title       text not null check (char_length(title) between 1 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  venue       text not null check (char_length(venue) between 1 and 160),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  capacity    integer not null check (capacity between 1 and 100000),
  status      text not null default 'draft' check (status in ('draft', 'published', 'closed')),
  code_prefix text not null check (code_prefix ~ '^[A-Z]{1,4}$'),  -- ticket code prefix, e.g. CDM
  created_by  uuid references public.staff_profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint events_ends_after_starts check (ends_at > starts_at)
);

create table public.registrations (
  id                bigint generated always as identity primary key,
  event_id          bigint not null references public.events (id),
  full_name         text not null check (char_length(full_name) between 2 and 100),
  email             text not null check (email = lower(email) and char_length(email) <= 254),
  mobile            text not null check (mobile ~ '^09[0-9]{9}$'),
  ticket_code       text not null constraint registrations_ticket_code_key unique,  -- random, e.g. CDM-7K3P9QXM
  status            text not null check (status in ('confirmed', 'checked_in', 'waitlisted', 'cancelled')),
  registered_at     timestamptz not null default now(),
  promoted_at       timestamptz,
  promoted_by       uuid references public.staff_profiles (id) on delete set null,
  checked_in_at     timestamptz,
  checked_in_by     uuid references public.staff_profiles (id) on delete set null,
  checkin_undone_at timestamptz,
  checkin_undone_by uuid references public.staff_profiles (id) on delete set null,
  cancelled_at      timestamptz,
  cancelled_by      uuid references public.staff_profiles (id) on delete set null  -- null when the attendee cancelled
);

-- One active registration per email per event. Cancelled rows don't block registering again.
create unique index ux_registrations_active_email on public.registrations (event_id, email) where status <> 'cancelled';
create index ix_registrations_event_status on public.registrations (event_id, status);

create table public.audit_logs (
  id            bigint generated always as identity primary key,
  staff_user_id uuid references public.staff_profiles (id) on delete set null,  -- null when an attendee did it
  actor         text not null,                                                  -- readable "who"
  action        text not null,
  target_type   text,
  target_id     text,
  event_id      bigint references public.events (id),
  details       text,
  created_at    timestamptz not null default now()
);
create index ix_audit_created on public.audit_logs (created_at desc);
create index ix_audit_event on public.audit_logs (event_id);

create table public.email_outbox (
  id              bigint generated always as identity primary key,
  kind            text not null check (kind in ('registration', 'waitlist', 'promotion')),
  registration_id bigint references public.registrations (id),
  to_address      text not null,
  subject         text not null,
  html            text not null,   -- preview copy (QR inlined as a data URI)
  status          text not null check (status in ('sent', 'failed', 'saved')),  -- saved = no SMTP configured
  error           text,
  created_at      timestamptz not null default now()
);

-- Fixed-window counters for rate limiting (works across serverless instances, unlike memory).
create table public.rate_limits (
  key      text primary key,
  count    integer not null,
  reset_at timestamptz not null
);

alter table public.staff_profiles enable row level security;
alter table public.events         enable row level security;
alter table public.registrations  enable row level security;
alter table public.audit_logs     enable row level security;
alter table public.email_outbox   enable row level security;
alter table public.rate_limits    enable row level security;

-- ---------------------------------------------------------------------------- read views

-- Capacity counts Confirmed + Checked in. Waitlisted and Cancelled do not.
create view public.events_with_counts with (security_invoker = true) as
select e.*,
  coalesce(c.registered, 0)     as registered,
  coalesce(c.checked_in, 0)     as checked_in,
  coalesce(c.not_checked_in, 0) as not_checked_in,
  coalesce(c.waitlisted, 0)     as waitlisted,
  coalesce(c.cancelled, 0)      as cancelled
from public.events e
left join (
  select event_id,
    count(*) filter (where status in ('confirmed', 'checked_in'))::int as registered,
    count(*) filter (where status = 'checked_in')::int                as checked_in,
    count(*) filter (where status = 'confirmed')::int                 as not_checked_in,
    count(*) filter (where status = 'waitlisted')::int                as waitlisted,
    count(*) filter (where status = 'cancelled')::int                 as cancelled
  from public.registrations
  group by event_id
) c on c.event_id = e.id;

-- Registrations with staff names and the waitlist position (first come, first served).
create view public.registrations_detailed with (security_invoker = true) as
select r.*,
  case when r.status = 'waitlisted'
       then row_number() over (partition by r.event_id, (r.status = 'waitlisted') order by r.id)::int
  end as waitlist_position,
  ci.name as checked_in_by_name,
  ud.name as checkin_undone_by_name,
  cb.name as cancelled_by_name
from public.registrations r
left join public.staff_profiles ci on ci.id = r.checked_in_by
left join public.staff_profiles ud on ud.id = r.checkin_undone_by
left join public.staff_profiles cb on cb.id = r.cancelled_by;

-- ---------------------------------------------------------------------------- capacity guard triggers

create function public.guard_registration_capacity() returns trigger
language plpgsql set search_path = '' as $$
declare
  cap   integer;
  taken integer;
begin
  if new.status in ('confirmed', 'checked_in')
     and (tg_op = 'INSERT' or old.status not in ('confirmed', 'checked_in')) then
    select capacity into cap from public.events where id = new.event_id for update;
    select count(*) into taken from public.registrations
     where event_id = new.event_id and status in ('confirmed', 'checked_in');
    if taken >= cap then
      raise exception 'EVENT_FULL' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

create trigger trg_registrations_capacity
before insert or update of status on public.registrations
for each row execute function public.guard_registration_capacity();

create function public.guard_event_capacity() returns trigger
language plpgsql set search_path = '' as $$
declare
  taken integer;
begin
  if new.capacity < old.capacity then
    select count(*) into taken from public.registrations
     where event_id = new.id and status in ('confirmed', 'checked_in');
    if new.capacity < taken then
      raise exception 'CAPACITY_BELOW_REGISTERED' using errcode = 'P0001', detail = taken::text;
    end if;
  end if;
  return new;
end $$;

create trigger trg_events_capacity_shrink
before update of capacity on public.events
for each row execute function public.guard_event_capacity();

-- ---------------------------------------------------------------------------- helpers

-- "2026-12-05T18:00:00+08:00": how times appear in audit details.
create function public.manila_iso(t timestamptz) returns text
language sql immutable set search_path = '' as $$
  select to_char(t at time zone 'Asia/Manila', 'YYYY-MM-DD"T"HH24:MI:SS"+08:00"')
$$;

create function public.manila_date(t timestamptz) returns date
language sql immutable set search_path = '' as $$
  select (t at time zone 'Asia/Manila')::date
$$;

create function public.write_audit(
  p_staff uuid, p_actor text, p_action text, p_target_type text, p_target_id text,
  p_event_id bigint, p_details text, p_now timestamptz
) returns void
language sql set search_path = '' as $$
  insert into public.audit_logs (staff_user_id, actor, action, target_type, target_id, event_id, details, created_at)
  values (p_staff, p_actor, p_action, p_target_type, p_target_id, p_event_id, p_details, p_now)
$$;

-- Lock the event row for the rest of the transaction and return it (null if missing).
create function public.lock_event(p_event_id bigint) returns public.events
language sql set search_path = '' as $$
  select * from public.events where id = p_event_id for update
$$;

create function public.event_stats(p_event_id bigint) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'checkedIn',  count(*) filter (where status = 'checked_in'),
    'registered', count(*) filter (where status in ('confirmed', 'checked_in')))
  from public.registrations where event_id = p_event_id
$$;

-- ---------------------------------------------------------------------------- booking functions

-- Register an attendee. If the event is full: join the waitlist when p_join_waitlist, else FULL.
create function public.register_attendee(
  p_event_id bigint, p_full_name text, p_email text, p_mobile text,
  p_ticket_code text, p_join_waitlist boolean, p_now timestamptz
) returns public.registrations
language plpgsql set search_path = '' as $$
declare
  ev       public.events;
  existing public.registrations;
  taken    integer;
  st       text;
  reg      public.registrations;
begin
  ev := public.lock_event(p_event_id);
  if ev.id is null or ev.status = 'draft' then raise exception 'EVENT_NOT_FOUND'; end if;
  if ev.ends_at <= p_now then raise exception 'ENDED'; end if;
  if ev.status = 'closed' then raise exception 'CLOSED'; end if;

  select * into existing from public.registrations
   where event_id = ev.id and email = p_email and status <> 'cancelled' limit 1;
  if existing.id is not null then
    raise exception '%', case when existing.status = 'waitlisted' then 'DUPLICATE_WAITLIST' else 'DUPLICATE' end;
  end if;

  select count(*) into taken from public.registrations
   where event_id = ev.id and status in ('confirmed', 'checked_in');
  if taken < ev.capacity then st := 'confirmed';
  elsif p_join_waitlist then st := 'waitlisted';
  else raise exception 'FULL';
  end if;

  insert into public.registrations (event_id, full_name, email, mobile, ticket_code, status, registered_at)
  values (ev.id, p_full_name, p_email, p_mobile, p_ticket_code, st, p_now)
  returning * into reg;
  return reg;
end $$;

-- Cancel a registration (by staff when p_staff is set, otherwise by the attendee).
create function public.cancel_registration(
  p_registration_id bigint, p_staff uuid, p_actor text, p_now timestamptz
) returns public.registrations
language plpgsql set search_path = '' as $$
declare
  reg  public.registrations;
  prev text;
begin
  select * into reg from public.registrations where id = p_registration_id;
  if reg.id is null then raise exception 'NOT_FOUND'; end if;
  perform public.lock_event(reg.event_id);  -- same lock order as every other booking action
  select * into reg from public.registrations where id = p_registration_id;
  if reg.status = 'checked_in' then raise exception 'CHECKED_IN'; end if;
  if reg.status = 'cancelled' then raise exception 'ALREADY_CANCELLED'; end if;
  prev := reg.status;

  update public.registrations
     set status = 'cancelled', cancelled_at = p_now, cancelled_by = p_staff
   where id = reg.id
  returning * into reg;

  perform public.write_audit(p_staff, p_actor, 'registration_cancelled', 'registration', reg.id::text, reg.event_id,
    format('%s · %s (was %s)', reg.ticket_code, reg.full_name, prev), p_now);
  return reg;
end $$;

-- Move the first person on the waitlist into an open spot.
create function public.promote_next(p_event_id bigint, p_staff uuid, p_actor text, p_now timestamptz)
returns public.registrations
language plpgsql set search_path = '' as $$
declare
  ev    public.events;
  taken integer;
  nxt   public.registrations;
begin
  ev := public.lock_event(p_event_id);
  if ev.id is null then raise exception 'EVENT_NOT_FOUND'; end if;
  if ev.ends_at <= p_now then raise exception 'ENDED'; end if;
  select count(*) into taken from public.registrations
   where event_id = ev.id and status in ('confirmed', 'checked_in');
  if taken >= ev.capacity then raise exception 'NO_SPOT'; end if;

  select * into nxt from public.registrations
   where event_id = ev.id and status = 'waitlisted' order by id limit 1;
  if nxt.id is null then raise exception 'EMPTY_WAITLIST'; end if;

  update public.registrations
     set status = 'confirmed', promoted_at = p_now, promoted_by = p_staff
   where id = nxt.id
  returning * into nxt;

  perform public.write_audit(p_staff, p_actor, 'waitlist_promoted', 'registration', nxt.id::text, ev.id,
    format('%s · %s', nxt.ticket_code, nxt.full_name), p_now);
  return nxt;
end $$;

-- Check a ticket in. Returns { result, registration, stats }.
--   result: checked_in | already | waitlisted | cancelled | invalid | other_event | not_event_day
-- A ticket only checks in when it is Confirmed, belongs to this event, and today (Cebu time) is the event day.
create function public.check_in(
  p_event_id bigint, p_ticket_code text, p_staff uuid, p_actor text, p_now timestamptz
) returns jsonb
language plpgsql set search_path = '' as $$
declare
  ev      public.events;
  reg     public.registrations;
  outcome text;
  today   date := public.manila_date(p_now);
begin
  ev := public.lock_event(p_event_id);
  if ev.id is null or ev.status = 'draft' then raise exception 'EVENT_NOT_FOUND'; end if;

  if p_ticket_code is not null then
    select * into reg from public.registrations where ticket_code = p_ticket_code;
  end if;

  if reg.id is null then outcome := 'invalid';
  elsif reg.event_id <> ev.id then outcome := 'other_event';
  elsif reg.status = 'checked_in' then outcome := 'already';
  elsif reg.status = 'waitlisted' then outcome := 'waitlisted';
  elsif reg.status = 'cancelled' then outcome := 'cancelled';
  elsif today < public.manila_date(ev.starts_at) or today > public.manila_date(ev.ends_at) then outcome := 'not_event_day';
  else
    update public.registrations
       set status = 'checked_in', checked_in_at = p_now, checked_in_by = p_staff
     where id = reg.id and status = 'confirmed'
    returning * into reg;
    outcome := 'checked_in';
    perform public.write_audit(p_staff, p_actor, 'checked_in', 'registration', reg.id::text, ev.id,
      format('%s · %s', reg.ticket_code, reg.full_name), p_now);
  end if;

  return jsonb_build_object(
    'result', outcome,
    'registration', case when reg.id is null or outcome = 'other_event' then null else to_jsonb(reg) end,
    'ticketCode', reg.ticket_code,
    'eventStartsAt', ev.starts_at,
    'stats', public.event_stats(ev.id));
end $$;

-- Reverse a mistaken check-in. Records who undid it and when.
create function public.undo_check_in(p_registration_id bigint, p_staff uuid, p_actor text, p_now timestamptz)
returns jsonb
language plpgsql set search_path = '' as $$
declare
  reg public.registrations;
  was timestamptz;
begin
  select * into reg from public.registrations where id = p_registration_id;
  if reg.id is null then raise exception 'NOT_FOUND'; end if;
  perform public.lock_event(reg.event_id);
  select * into reg from public.registrations where id = p_registration_id;
  if reg.status <> 'checked_in' then raise exception 'NOT_CHECKED_IN'; end if;
  was := reg.checked_in_at;

  update public.registrations
     set status = 'confirmed', checked_in_at = null, checked_in_by = null,
         checkin_undone_at = p_now, checkin_undone_by = p_staff
   where id = reg.id
  returning * into reg;

  perform public.write_audit(p_staff, p_actor, 'checkin_undone', 'registration', reg.id::text, reg.event_id,
    format('%s · %s (was checked in at %s)', reg.ticket_code, reg.full_name, to_char(was at time zone 'Asia/Manila', 'FMHH12:MI AM')),
    p_now);
  return jsonb_build_object('registration', to_jsonb(reg), 'stats', public.event_stats(reg.event_id));
end $$;

-- Create (p_id null) or update an event, with the audit entry.
create function public.save_event(
  p_id bigint, p_title text, p_description text, p_venue text, p_starts_at timestamptz, p_ends_at timestamptz,
  p_capacity integer, p_status text, p_code_prefix text, p_staff uuid, p_actor text, p_now timestamptz
) returns bigint
language plpgsql set search_path = '' as $$
declare
  ev      public.events;
  taken   integer;
  waiting integer;
  changes text[] := '{}';
  new_id  bigint;
begin
  if p_id is null then
    insert into public.events (title, description, venue, starts_at, ends_at, capacity, status, code_prefix, created_by, created_at, updated_at)
    values (p_title, p_description, p_venue, p_starts_at, p_ends_at, p_capacity, p_status, p_code_prefix, p_staff, p_now, p_now)
    returning id into new_id;
    perform public.write_audit(p_staff, p_actor, 'event_created', 'event', new_id::text, new_id,
      format('Created "%s" (%s, capacity %s)', p_title, p_status, p_capacity), p_now);
    return new_id;
  end if;

  ev := public.lock_event(p_id);
  if ev.id is null then raise exception 'EVENT_NOT_FOUND'; end if;
  select count(*) filter (where status in ('confirmed', 'checked_in')), count(*) filter (where status = 'waitlisted')
    into taken, waiting from public.registrations where event_id = ev.id;
  if p_capacity < taken then
    raise exception 'CAPACITY_BELOW_REGISTERED' using detail = taken::text;
  end if;
  if p_status = 'draft' and ev.status <> 'draft' and taken + waiting > 0 then
    raise exception 'DRAFT_HAS_REGISTRATIONS';
  end if;

  update public.events
     set title = p_title, description = p_description, venue = p_venue, starts_at = p_starts_at, ends_at = p_ends_at,
         capacity = p_capacity, status = p_status, updated_at = p_now
   where id = ev.id;

  if ev.title <> p_title then changes := changes || format('title: %s → %s', ev.title, p_title); end if;
  if ev.venue <> p_venue then changes := changes || format('venue: %s → %s', ev.venue, p_venue); end if;
  if ev.starts_at <> p_starts_at then changes := changes || format('start: %s → %s', public.manila_iso(ev.starts_at), public.manila_iso(p_starts_at)); end if;
  if ev.ends_at <> p_ends_at then changes := changes || format('end: %s → %s', public.manila_iso(ev.ends_at), public.manila_iso(p_ends_at)); end if;
  if ev.capacity <> p_capacity then changes := changes || format('capacity: %s → %s', ev.capacity, p_capacity); end if;
  if ev.status <> p_status then changes := changes || format('status: %s → %s', ev.status, p_status); end if;
  if ev.description <> p_description then changes := changes || 'description updated'::text; end if;

  perform public.write_audit(p_staff, p_actor, 'event_updated', 'event', ev.id::text, ev.id,
    coalesce(nullif(array_to_string(changes, '; '), ''), 'No changes'), p_now);
  return ev.id;
end $$;

create function public.set_event_status(p_id bigint, p_status text, p_staff uuid, p_actor text, p_now timestamptz)
returns public.events
language plpgsql set search_path = '' as $$
declare
  ev public.events;
begin
  if p_status not in ('published', 'closed') then raise exception 'BAD_STATUS'; end if;
  ev := public.lock_event(p_id);
  if ev.id is null then raise exception 'EVENT_NOT_FOUND'; end if;
  if ev.status = p_status then return ev; end if;
  update public.events set status = p_status, updated_at = p_now where id = ev.id;
  perform public.write_audit(p_staff, p_actor, 'event_status_changed', 'event', ev.id::text, ev.id,
    format('"%s": %s → %s', ev.title, ev.status, p_status), p_now);
  ev.status := p_status;
  return ev;
end $$;

-- Deactivate / reactivate a staff account. At least one organizer must stay active.
create function public.set_staff_active(p_id uuid, p_active boolean, p_staff uuid, p_actor text, p_now timestamptz)
returns public.staff_profiles
language plpgsql set search_path = '' as $$
declare
  usr        public.staff_profiles;
  organizers integer;
begin
  -- Lock all organizer rows, so two organizers can't deactivate each other at the same moment.
  perform 1 from public.staff_profiles where role = 'organizer' for update;
  select * into usr from public.staff_profiles where id = p_id for update;
  if usr.id is null then raise exception 'NOT_FOUND'; end if;
  if usr.id = p_staff then raise exception 'SELF'; end if;
  if not p_active and usr.role = 'organizer' and usr.active then
    select count(*) into organizers from public.staff_profiles where role = 'organizer' and active;
    if organizers <= 1 then raise exception 'LAST_ORGANIZER'; end if;
  end if;
  update public.staff_profiles set active = p_active where id = usr.id returning * into usr;
  perform public.write_audit(p_staff, p_actor, case when p_active then 'staff_reactivated' else 'staff_deactivated' end,
    'staff', usr.id::text, null, format('%s (%s)', usr.name, usr.email), p_now);
  return usr;
end $$;

create function public.add_staff_profile(
  p_id uuid, p_name text, p_email text, p_role text, p_staff uuid, p_actor text, p_now timestamptz
) returns public.staff_profiles
language plpgsql set search_path = '' as $$
declare
  usr public.staff_profiles;
begin
  insert into public.staff_profiles (id, name, email, role, created_at)
  values (p_id, p_name, lower(p_email), p_role, p_now)
  returning * into usr;
  perform public.write_audit(p_staff, p_actor, 'staff_created', 'staff', usr.id::text, null,
    format('%s (%s, %s)', usr.name, usr.email, usr.role), p_now);
  return usr;
end $$;

-- Attendee list for staff, with optional search by name, email or ticket code.
create function public.list_registrations(p_event_id bigint, p_q text default '', p_status text default '')
returns setof public.registrations_detailed
language sql stable set search_path = '' as $$
  select * from public.registrations_detailed r
   where r.event_id = p_event_id
     and (coalesce(p_status, '') = '' or r.status = p_status)
     and (coalesce(p_q, '') = '' or
          r.full_name ilike '%' || replace(replace(replace(p_q, '!', '!!'), '%', '!%'), '_', '!_') || '%' escape '!' or
          r.email     ilike '%' || replace(replace(replace(p_q, '!', '!!'), '%', '!%'), '_', '!_') || '%' escape '!' or
          r.ticket_code ilike '%' || replace(replace(replace(p_q, '!', '!!'), '%', '!%'), '_', '!_') || '%' escape '!')
   order by r.id
$$;

-- Fixed-window rate limit. Returns 0 when allowed, otherwise seconds until the window resets.
create function public.hit_rate_limit(p_key text, p_window_seconds integer, p_max integer)
returns integer
language plpgsql set search_path = '' as $$
declare
  n     integer;
  reset timestamptz;
begin
  insert into public.rate_limits as rl (key, count, reset_at)
  values (p_key, 1, now() + make_interval(secs => p_window_seconds))
  on conflict (key) do update set
    count    = case when rl.reset_at <= now() then 1 else rl.count + 1 end,
    reset_at = case when rl.reset_at <= now() then now() + make_interval(secs => p_window_seconds) else rl.reset_at end
  returning count, reset_at into n, reset;

  if random() < 0.01 then
    delete from public.rate_limits where reset_at < now() - interval '1 day';
  end if;

  if n > p_max then
    return greatest(1, ceil(extract(epoch from reset - now()))::integer);
  end if;
  return 0;
end $$;

-- ---------------------------------------------------------------------------- permissions

-- Only the server (service_role) may touch data or call functions. anon / authenticated get nothing.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
