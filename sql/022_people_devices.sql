-- 022: My Warehouse login. A warehouse device is set up once for one NDD; each person signs in on it with their
-- own name and PIN (roles: lo = Logistic Officer, admin = Warehouse Admin, sup = Supervisor, om = Ops Manager).
-- HQ signs in with named accounts (superadmin, admin, finance) instead of the shared passwords.
-- NDDs keep the plant-code login until HQ switches them to login_mode 'people'.

------------------------------------------------------------------ schema
create table if not exists public.people (
  id uuid primary key default gen_random_uuid(),
  branch text not null references public.branches(name) on update cascade on delete cascade,
  name text not null,
  roles text[] not null default '{}',
  pin_hash text,
  must_change boolean not null default true,
  fails int not null default 0,
  locked_until timestamptz,
  acting_om_until date,                 -- HQ can make someone acting Ops Manager until this date
  lang text not null default 'en' check (lang in ('en', 'ms')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists people_branch on public.people (branch);

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  branch text not null references public.branches(name) on update cascade on delete cascade,
  label text not null default '',
  key_hash text not null unique,
  set_up_by uuid references public.people(id) on delete set null,
  created_at timestamptz not null default now(),
  last_seen timestamptz,
  revoked_at timestamptz
);

create table if not exists public.hq_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  role text not null check (role in ('superadmin', 'admin', 'finance')),
  pw_hash text not null,
  must_change boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_login timestamptz
);

alter table public.tokens add column if not exists person_id uuid;
alter table public.tokens add column if not exists device_id uuid;
alter table public.tokens add column if not exists hq_user uuid;
alter table public.branches add column if not exists login_mode text not null default 'plant';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'branches_login_mode_chk') then
    alter table public.branches add constraint branches_login_mode_chk check (login_mode in ('plant', 'people'));
  end if;
end $$;

do $$ declare t text; begin
  foreach t in array array['people', 'devices', 'hq_users'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

------------------------------------------------------------------ helpers
-- clock that tests can set (settings.test_now); everything time-of-day uses it
create or replace function private.mw_now()
returns timestamptz language sql stable set search_path = '' as $$
  select coalesce((select (value #>> '{}')::timestamptz from public.settings where key = 'test_now'), now())
$$;

create or replace function private.new_tok(p_kind text, p_branch text, p_life interval, p_person uuid, p_device uuid, p_hq uuid)
returns text language plpgsql set search_path = '' as $$
declare t text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  delete from public.tokens where expires_at < now();
  insert into public.tokens (token, kind, branch, expires_at, person_id, device_id, hq_user)
  values (t, p_kind, p_branch, now() + p_life, p_person, p_device, p_hq);
  return t;
end $$;

create or replace function private.key_hash(p_key text)
returns text language sql immutable set search_path = '' as $$
  select encode(extensions.digest(coalesce(p_key, ''), 'sha256'), 'hex')
$$;

create or replace function private.eff_roles(p public.people)
returns text[] language sql stable set search_path = '' as $$
  select case when p.acting_om_until is not null and p.acting_om_until >= private.today() and not ('om' = any (p.roles))
              then p.roles || array['om'] else p.roles end
$$;

create or replace function private.person_json(p public.people)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'name', p.name, 'roles', to_jsonb(private.eff_roles(p)), 'lang', p.lang,
    'locked', p.locked_until is not null and p.locked_until > now(), 'lockedUntil', p.locked_until,
    'actingOmUntil', p.acting_om_until, 'active', p.active, 'pinSet', p.pin_hash is not null and not p.must_change)
$$;

-- the person behind a token (null when the token is not a person's)
create or replace function private.tok_person(p_token text)
returns public.people language sql stable set search_path = '' as $$
  select p.* from public.tokens t join public.people p on p.id = t.person_id
  where t.token = p_token and t.expires_at > now() and p.active
$$;

create or replace function private.need_person(p_token text, p_roles text[] default null)
returns public.people language plpgsql stable set search_path = '' as $$
declare p public.people := private.tok_person(p_token);
begin
  if p.id is null then raise exception 'AUTH: sign in again' using errcode = '28000'; end if;
  if p_roles is not null and not (private.eff_roles(p) && p_roles) then raise exception 'NOT ALLOWED: your role can''t do this'; end if;
  return p;
end $$;

-- HQ (owner token) or the branch's Ops Manager
create or replace function private.need_om_or_hq(p_token text, p_branch text)
returns uuid language plpgsql stable set search_path = '' as $$
declare k text := private.tok_kind(p_token); p public.people;
begin
  if k = 'owner' then return null; end if;
  p := private.tok_person(p_token);
  if p.id is null or p.branch is distinct from p_branch or not ('om' = any (private.eff_roles(p))) then
    raise exception 'AUTH: Ops Manager or HQ login needed' using errcode = '28000';
  end if;
  return p.id;
end $$;

create or replace function private.device_of(p_key text)
returns public.devices language plpgsql set search_path = '' as $$
declare d public.devices;
begin
  select * into d from public.devices where key_hash = private.key_hash(p_key);
  if d.id is null or d.revoked_at is not null then raise exception 'AUTH: this device was removed by HQ. Set it up again.' using errcode = '28000'; end if;
  update public.devices set last_seen = now() where id = d.id;
  return d;
end $$;

create or replace function private.temp_pin(p_len int)
returns text language sql volatile set search_path = '' as $$
  select string_agg((floor(random() * 10))::int::text, '') from generate_series(1, p_len)
$$;

create or replace function private.pin_ok(p_pin text, p_len int)
returns boolean language sql immutable set search_path = '' as $$
  select p_pin ~ ('^[0-9]{' || p_len || '}$')
     and p_pin !~ '^(.)\1+$'
     and position(p_pin in '0123456789012345') = 0
     and position(p_pin in '9876543210987654') = 0
$$;

------------------------------------------------------------------ device set-up and person sign-in
-- step 1 of setting up a device: the plant code shows the NDD and its Ops Managers
create or replace function public.device_setup_start(p_plant text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare b public.branches; c text := trim(coalesce(p_plant, ''));
begin
  perform private.too_many('devsetup');
  select * into b from public.branches where active and c = any (plants) limit 1;
  if b.name is null then
    insert into public.login_attempts (key, ok) values ('devsetup', false);
    return jsonb_build_object('ok', false);
  end if;
  if b.login_mode <> 'people' then return jsonb_build_object('ok', false, 'notYet', true, 'branch', b.name); end if;
  return jsonb_build_object('ok', true, 'branch', b.name,
    'oms', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.name) from public.people p
                     where p.branch = b.name and p.active and 'om' = any (private.eff_roles(p))), '[]'::jsonb));
end $$;

-- step 2: the Ops Manager's PIN sets the device up; the device keeps the returned key
create or replace function public.device_setup(p_plant text, p_person uuid, p_pin text, p_label text default '')
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare b public.branches; p public.people; k text; d uuid; c text := trim(coalesce(p_plant, ''));
begin
  perform private.too_many('devsetup');
  select * into b from public.branches where active and login_mode = 'people' and c = any (plants) limit 1;
  select * into p from public.people where id = p_person and active;
  if b.name is null or p.id is null or p.branch <> b.name or not ('om' = any (private.eff_roles(p)))
     or p.pin_hash is null or p.pin_hash <> extensions.crypt(coalesce(p_pin, ''), p.pin_hash)
     or (p.locked_until is not null and p.locked_until > now()) then
    insert into public.login_attempts (key, ok) values ('devsetup', false);
    return jsonb_build_object('ok', false);
  end if;
  insert into public.login_attempts (key, ok) values ('devsetup', true);
  k := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.devices (branch, label, key_hash, set_up_by) values (b.name, left(coalesce(nullif(trim(p_label), ''), 'Device'), 40), private.key_hash(k), p.id)
    returning id into d;
  return jsonb_build_object('ok', true, 'key', k, 'deviceId', d, 'branch', b.name);
end $$;

-- what the people screen needs; also tells the device when it has been removed
create or replace function public.device_info(p_key text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare d public.devices := private.device_of(p_key); b public.branches; t public.stock_takes := private.cur();
begin
  select * into b from public.branches where name = d.branch;
  return jsonb_build_object('deviceId', d.id, 'label', d.label, 'branch', d.branch, 'loginMode', b.login_mode,
    'plant', b.plants[1],
    'people', coalesce((select jsonb_agg(private.person_json(p) order by p.name) from public.people p where p.branch = d.branch and p.active), '[]'::jsonb),
    'stockTake', case when t.kind = 'monthly' and t.status = 'open' and exists (select 1 from private.scoped_sys(t.id) s where s.branch = d.branch)
                      then jsonb_build_object('id', t.id, 'name', t.name) end);
end $$;

create or replace function public.person_login(p_key text, p_person uuid, p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare d public.devices := private.device_of(p_key); p public.people; t text; r text[];
begin
  select * into p from public.people where id = p_person and active and branch = d.branch;
  if p.id is null then return jsonb_build_object('ok', false, 'gone', true); end if;
  if p.locked_until is not null and p.locked_until > now() then return jsonb_build_object('ok', false, 'lockedUntil', p.locked_until); end if;
  if p.pin_hash is null or p.pin_hash <> extensions.crypt(coalesce(p_pin, ''), p.pin_hash) then
    -- 5 wrong in a row: locked 15 minutes, then 5 more tries
    update public.people set
      locked_until = case when fails + 1 >= 5 then now() + interval '15 minutes' else locked_until end,
      fails = case when fails + 1 >= 5 then 0 else fails + 1 end
      where id = p.id;
    select * into p from public.people where id = p.id;
    return jsonb_build_object('ok', false, 'lockedUntil', case when p.locked_until > now() then p.locked_until end,
      'left', case when p.locked_until > now() then 0 else 5 - p.fails end);
  end if;
  update public.people set fails = 0, locked_until = null where id = p.id;
  r := private.eff_roles(p);
  t := private.new_tok('branch', p.branch, interval '12 hours', p.id, d.id, null);
  update public.tokens set sup = (r && array['sup', 'om']) where token = t;
  return jsonb_build_object('ok', true, 'token', t, 'branch', p.branch, 'mustChange', p.must_change, 'person', private.person_json(p));
end $$;

create or replace function public.person_set_pin(p_token text, p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare p public.people := private.need_person(p_token); n int;
begin
  n := case when 'om' = any (private.eff_roles(p)) then 6 else 4 end;
  if not private.pin_ok(coalesce(p_pin, ''), n) then
    raise exception 'Use % digits, not all the same and not in a row like 1234', n;
  end if;
  update public.people set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf')), must_change = false where id = p.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.person_set_lang(p_token text, p_lang text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare p public.people := private.need_person(p_token);
begin
  if p_lang not in ('en', 'ms') then raise exception 'Unknown language'; end if;
  update public.people set lang = p_lang where id = p.id;
end $$;

-- the monthly stock take keeps its own join: a counting token for the device's NDD while a stock take is open there
create or replace function public.device_join_take(p_key text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare d public.devices := private.device_of(p_key); t public.stock_takes := private.cur();
begin
  if not (t.kind = 'monthly' and t.status = 'open' and exists (select 1 from private.scoped_sys(t.id) s where s.branch = d.branch)) then
    raise exception 'NOT OPEN: there is no stock take open at this warehouse';
  end if;
  return jsonb_build_object('ok', true, 'branch', d.branch,
    'token', private.new_tok('branch', d.branch, interval '1 day', null, d.id, null),
    'take', private.take_json(t));
end $$;

------------------------------------------------------------------ people (Ops Manager for their NDD, HQ for all)
create or replace function public.wh_people(p_token text, p_branch text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.need_om_or_hq(p_token, p_branch);
  return coalesce((select jsonb_agg(private.person_json(p) order by p.active desc, p.name) from public.people p where p.branch = p_branch), '[]'::jsonb);
end $$;

create or replace function public.wh_person_save(p_token text, p_branch text, p_id uuid, p_name text, p_roles text[], p_active boolean default true, p_acting_om_until date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare me uuid := private.need_om_or_hq(p_token, p_branch); hq boolean := me is null; p public.people; pin text; rs text[];
begin
  rs := array(select distinct x from unnest(coalesce(p_roles, '{}')) x where x in ('lo', 'admin', 'sup', 'om'));
  if trim(coalesce(p_name, '')) = '' then raise exception 'Enter a name'; end if;
  if not exists (select 1 from public.branches where name = p_branch) then raise exception 'Unknown warehouse'; end if;
  if array_length(rs, 1) is null then raise exception 'Pick at least one role'; end if;
  if p_id is not null then select * into p from public.people where id = p_id and branch = p_branch; if p.id is null then raise exception 'Person not found'; end if; end if;
  -- only HQ gives or takes the Ops Manager role, sets acting OM, or edits an Ops Manager
  if not hq and (('om' = any (rs)) is distinct from (p.id is not null and 'om' = any (p.roles))
                 or (p.id is not null and 'om' = any (p.roles) and p.id <> me)
                 or p_acting_om_until is distinct from p.acting_om_until) then
    raise exception 'NOT ALLOWED: only HQ can change an Ops Manager';
  end if;
  if not hq and p.id = me and not coalesce(p_active, true) then raise exception 'NOT ALLOWED: you can''t switch yourself off'; end if;
  if exists (select 1 from public.people x where x.branch = p_branch and x.active and lower(x.name) = lower(trim(p_name)) and x.id is distinct from p.id) then
    raise exception 'Someone at this warehouse already has that name. Add a surname or initial.';
  end if;
  if p.id is null then
    pin := private.temp_pin(case when 'om' = any (rs) then 6 else 4 end);
    insert into public.people (branch, name, roles, pin_hash, must_change, acting_om_until)
    values (p_branch, trim(p_name), rs, extensions.crypt(pin, extensions.gen_salt('bf')), true, p_acting_om_until) returning * into p;
  else
    update public.people set name = trim(p_name), roles = rs, active = coalesce(p_active, true), acting_om_until = p_acting_om_until
    where id = p.id returning * into p;
    if not p.active then delete from public.tokens where person_id = p.id; end if;
  end if;
  return private.person_json(p) || jsonb_build_object('tempPin', pin);
end $$;

create or replace function public.wh_person_reset(p_token text, p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare p public.people; me uuid; pin text;
begin
  select * into p from public.people where id = p_id;
  if p.id is null then raise exception 'Person not found'; end if;
  me := private.need_om_or_hq(p_token, p.branch);
  if me is not null and 'om' = any (p.roles) then raise exception 'NOT ALLOWED: HQ resets an Ops Manager''s PIN'; end if;
  pin := private.temp_pin(case when 'om' = any (private.eff_roles(p)) then 6 else 4 end);
  update public.people set pin_hash = extensions.crypt(pin, extensions.gen_salt('bf')), must_change = true, fails = 0, locked_until = null where id = p.id;
  delete from public.tokens where person_id = p.id;
  return jsonb_build_object('ok', true, 'tempPin', pin, 'name', p.name);
end $$;

create or replace function public.wh_person_unlock(p_token text, p_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare p public.people;
begin
  select * into p from public.people where id = p_id;
  if p.id is null then raise exception 'Person not found'; end if;
  perform private.need_om_or_hq(p_token, p.branch);
  update public.people set fails = 0, locked_until = null where id = p.id;
end $$;

------------------------------------------------------------------ devices (HQ)
create or replace function public.admin_devices(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.need_owner(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'branch', d.branch, 'label', d.label, 'createdAt', d.created_at,
      'lastSeen', d.last_seen, 'setUpBy', (select name from public.people where id = d.set_up_by)) order by d.branch, d.created_at)
    from public.devices d where d.revoked_at is null), '[]'::jsonb);
end $$;

create or replace function public.admin_device_revoke(p_token text, p_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.need_owner(p_token);
  update public.devices set revoked_at = now() where id = p_id and revoked_at is null;
  delete from public.tokens where device_id = p_id;
end $$;

------------------------------------------------------------------ HQ named accounts
create or replace function private.hq_of(p_token text)
returns public.hq_users language sql stable set search_path = '' as $$
  select u.* from public.tokens t join public.hq_users u on u.id = t.hq_user
  where t.token = p_token and t.expires_at > now() and u.active
$$;

-- superadmin; or, while no superadmin exists yet, the shared owner password (to make the first one)
create or replace function private.need_super(p_token text)
returns void language plpgsql stable set search_path = '' as $$
declare u public.hq_users := private.hq_of(p_token);
begin
  if u.role = 'superadmin' then return; end if;
  if u.id is null and private.tok_kind(p_token) = 'owner'
     and not exists (select 1 from public.hq_users where role = 'superadmin' and active) then return; end if;
  raise exception 'AUTH: superadmin login needed' using errcode = '28000';
end $$;

create or replace function public.hq_login(p_email text, p_password text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare u public.hq_users; e text := lower(trim(coalesce(p_email, ''))); k text;
begin
  perform private.too_many('hq:' || e);
  select * into u from public.hq_users where email = e and active;
  if u.id is null or u.pw_hash <> extensions.crypt(coalesce(p_password, ''), u.pw_hash) then
    insert into public.login_attempts (key, ok) values ('hq:' || e, false);
    return jsonb_build_object('ok', false);
  end if;
  insert into public.login_attempts (key, ok) values ('hq:' || e, true);
  update public.hq_users set last_login = now() where id = u.id;
  k := case when u.role = 'finance' then 'finance' else 'owner' end;
  return jsonb_build_object('ok', true, 'kind', k, 'token', private.new_tok(k, null, interval '14 days', null, null, u.id),
    'user', jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email, 'role', u.role), 'mustChange', u.must_change);
end $$;

create or replace function public.hq_me(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare u public.hq_users := private.hq_of(p_token); k text := private.tok_kind(p_token);
begin
  if k is null or k = 'branch' then raise exception 'AUTH: sign in again' using errcode = '28000'; end if;
  return jsonb_build_object('kind', k, 'shared', u.id is null,
    'user', case when u.id is not null then jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email, 'role', u.role) end,
    'mustChange', coalesce(u.must_change, false),
    'sharedLogin', coalesce((private.setting('shared_login') #>> '{}')::boolean, true),
    'superExists', exists (select 1 from public.hq_users where role = 'superadmin' and active));
end $$;

create or replace function public.hq_set_password(p_token text, p_old text, p_new text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare u public.hq_users := private.hq_of(p_token);
begin
  if u.id is null then raise exception 'AUTH: sign in with your own account' using errcode = '28000'; end if;
  if u.pw_hash <> extensions.crypt(coalesce(p_old, ''), u.pw_hash) then raise exception 'Current password is wrong'; end if;
  if length(coalesce(p_new, '')) < 8 then raise exception 'Use at least 8 characters'; end if;
  update public.hq_users set pw_hash = extensions.crypt(p_new, extensions.gen_salt('bf')), must_change = false where id = u.id;
end $$;

create or replace function public.hq_users_list(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.need_super(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'email', email, 'name', name, 'role', role, 'active', active, 'lastLogin', last_login)
    order by active desc, role, name) from public.hq_users), '[]'::jsonb);
end $$;

create or replace function public.hq_user_save(p_token text, p_id uuid, p_email text, p_name text, p_role text, p_active boolean default true)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare me public.hq_users := private.hq_of(p_token); u public.hq_users; pw text; e text := lower(trim(coalesce(p_email, '')));
begin
  perform private.need_super(p_token);
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email'; end if;
  if trim(coalesce(p_name, '')) = '' then raise exception 'Enter a name'; end if;
  if p_role not in ('superadmin', 'admin', 'finance') then raise exception 'Pick a role'; end if;
  -- the shared owner password can only make the first superadmin
  if me.id is null and (p_id is not null or p_role <> 'superadmin') then raise exception 'NOT ALLOWED: make the first superadmin account first'; end if;
  if p_id is not null and p_id = me.id and (p_role <> 'superadmin' or not coalesce(p_active, true)) then raise exception 'NOT ALLOWED: you can''t remove your own superadmin'; end if;
  if exists (select 1 from public.hq_users where email = e and id is distinct from p_id) then raise exception 'That email already has an account'; end if;
  if p_id is null then
    pw := encode(extensions.gen_random_bytes(6), 'hex');
    insert into public.hq_users (email, name, role, pw_hash) values (e, trim(p_name), p_role, extensions.crypt(pw, extensions.gen_salt('bf'))) returning * into u;
  else
    update public.hq_users set email = e, name = trim(p_name), role = p_role, active = coalesce(p_active, true) where id = p_id returning * into u;
    if u.id is null then raise exception 'Account not found'; end if;
    if not u.active then delete from public.tokens where hq_user = u.id; end if;
  end if;
  return jsonb_build_object('id', u.id, 'email', u.email, 'name', u.name, 'role', u.role, 'active', u.active, 'tempPassword', pw);
end $$;

create or replace function public.hq_user_reset(p_token text, p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare pw text := encode(extensions.gen_random_bytes(6), 'hex'); u public.hq_users;
begin
  perform private.need_super(p_token);
  update public.hq_users set pw_hash = extensions.crypt(pw, extensions.gen_salt('bf')), must_change = true where id = p_id returning * into u;
  if u.id is null then raise exception 'Account not found'; end if;
  delete from public.tokens where hq_user = u.id;
  return jsonb_build_object('tempPassword', pw, 'email', u.email);
end $$;

-- superadmin can switch off the shared owner/finance passwords once named accounts are in use
create or replace function public.hq_shared_login(p_token text, p_on boolean)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if (private.hq_of(p_token)).role is distinct from 'superadmin' then raise exception 'AUTH: superadmin login needed' using errcode = '28000'; end if;
  insert into public.settings (key, value) values ('shared_login', to_jsonb(coalesce(p_on, true)))
    on conflict (key) do update set value = excluded.value;
  if not coalesce(p_on, true) then delete from public.tokens where kind in ('owner', 'finance') and hq_user is null; end if;
end $$;

-- shared passwords: refused once the superadmin switched them off
create or replace function public.admin_login(p_password text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare oh text; fh text; pw text := coalesce(p_password, '');
begin
  if not coalesce((private.setting('shared_login') #>> '{}')::boolean, true) then return jsonb_build_object('ok', false, 'disabled', true); end if;
  perform private.too_many('admin');
  select value into oh from private.secrets where key = 'owner_hash';
  select value into fh from private.secrets where key = 'finance_hash';
  if pw <> '' and oh is not null and extensions.crypt(pw, oh) = oh then
    insert into public.login_attempts (key, ok) values ('admin', true);
    return jsonb_build_object('ok', true, 'kind', 'owner', 'token', private.new_token('owner', null, 14));
  elsif pw <> '' and fh is not null and extensions.crypt(pw, fh) = fh then
    insert into public.login_attempts (key, ok) values ('admin', true);
    return jsonb_build_object('ok', true, 'kind', 'finance', 'token', private.new_token('finance', null, 14));
  end if;
  insert into public.login_attempts (key, ok) values ('admin', false);
  return jsonb_build_object('ok', false);
end $$;

------------------------------------------------------------------ plant-code logins stop where an NDD uses names and PINs
create or replace function public.plant_login(p_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare b public.branches; c text := trim(coalesce(p_code, ''));
begin
  perform private.too_many('plant');
  select * into b from public.branches where active and c = any (plants) limit 1;
  if not found then
    insert into public.login_attempts (key, ok) values ('plant', false);
    return jsonb_build_object('ok', false);
  end if;
  if b.login_mode = 'people' then return jsonb_build_object('ok', false, 'people', true, 'branch', b.name); end if;
  return jsonb_build_object('ok', true, 'token', private.new_token('branch', b.name, 30), 'branch', b.name, 'plant', c,
    'take', private.take_json(private.take_for(b.name)), 'wait', private.daily_wait(b.name, private.today()));
end $$;

create or replace function public.sup_login(p_code text, p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare b public.branches; c text := trim(coalesce(p_code, '')); t text;
begin
  perform private.too_many('sup');
  select * into b from public.branches where active and c = any (plants) limit 1;
  if found and b.login_mode = 'people' then return jsonb_build_object('ok', false, 'people', true, 'branch', b.name); end if;
  if not found or b.sup_hash is null or b.sup_hash <> extensions.crypt(coalesce(p_pin, ''), b.sup_hash) then
    insert into public.login_attempts (key, ok) values ('sup', false);
    return jsonb_build_object('ok', false);
  end if;
  t := private.new_token('branch', b.name, 14);
  update public.tokens set sup = true where token = t;
  return jsonb_build_object('ok', true, 'token', t, 'branch', b.name, 'mustChange', b.sup_must_change);
end $$;

------------------------------------------------------------------ grants
revoke all on function private.mw_now(), private.new_tok(text, text, interval, uuid, uuid, uuid), private.key_hash(text), private.eff_roles(public.people),
  private.person_json(public.people), private.tok_person(text), private.need_person(text, text[]), private.need_om_or_hq(text, text),
  private.device_of(text), private.temp_pin(int), private.pin_ok(text, int), private.hq_of(text), private.need_super(text) from public, anon, authenticated;
do $$ declare f text; begin
  foreach f in array array[
    'device_setup_start(text)', 'device_setup(text, uuid, text, text)', 'device_info(text)', 'person_login(text, uuid, text)',
    'person_set_pin(text, text)', 'person_set_lang(text, text)', 'device_join_take(text)',
    'wh_people(text, text)', 'wh_person_save(text, text, uuid, text, text[], boolean, date)', 'wh_person_reset(text, uuid)', 'wh_person_unlock(text, uuid)',
    'admin_devices(text)', 'admin_device_revoke(text, uuid)',
    'hq_login(text, text)', 'hq_me(text)', 'hq_set_password(text, text, text)', 'hq_users_list(text)',
    'hq_user_save(text, uuid, text, text, text, boolean)', 'hq_user_reset(text, uuid)', 'hq_shared_login(text, boolean)',
    'admin_login(text)', 'plant_login(text)', 'sup_login(text, text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
