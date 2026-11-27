-- 025: one login page. Warehouse people sign in with a username and a 6-digit PIN from any phone (no device set-up);
-- HQ signs in with email and password on the same page. NDDs on the plant code keep it until HQ switches them.
-- The devices table and its functions from 022 stay but the app no longer uses them.

alter table public.people add column if not exists username text;

-- a username from the name and the NDD's plant code, e.g. "ravi.1503"; a number is added when it is taken
create or replace function private.suggest_username(p_name text, p_branch text, p_except uuid default null)
returns text language plpgsql stable set search_path = '' as $$
declare base text; u text; i int := 1;
begin
  base := lower(regexp_replace(split_part(trim(coalesce(p_name, '')), ' ', 1), '[^A-Za-z0-9]', '', 'g'));
  if base = '' then base := 'user'; end if;
  base := base || '.' || coalesce((select plants[1] from public.branches where name = p_branch), 'ndd');
  u := base;
  while exists (select 1 from public.people where lower(username) = u and id is distinct from p_except) loop
    i := i + 1; u := base || i;
  end loop;
  return u;
end $$;

do $$ declare p record; begin
  for p in select id, name, branch from public.people where username is null order by created_at loop
    update public.people set username = private.suggest_username(p.name, p.branch, p.id) where id = p.id;
  end loop;
end $$;
alter table public.people alter column username set not null;
create unique index if not exists people_username on public.people (lower(username));

-- every PIN is 6 digits now (no device behind it any more)
create or replace function private.person_json(p public.people)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'name', p.name, 'username', p.username, 'roles', to_jsonb(private.eff_roles(p)), 'lang', p.lang,
    'locked', p.locked_until is not null and p.locked_until > now(), 'lockedUntil', p.locked_until,
    'actingOmUntil', p.acting_om_until, 'active', p.active, 'pinSet', p.pin_hash is not null and not p.must_change)
$$;

create or replace function public.user_login(p_user text, p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare u text := lower(trim(coalesce(p_user, ''))); p public.people; b public.branches; t text; r text[];
begin
  perform private.too_many('user:' || u);
  select * into p from public.people where lower(username) = u and active;
  if p.id is null then
    insert into public.login_attempts (key, ok) values ('user:' || u, false);
    return jsonb_build_object('ok', false);
  end if;
  select * into b from public.branches where name = p.branch;
  if not b.active or b.login_mode <> 'people' then return jsonb_build_object('ok', false, 'plant', true, 'branch', b.name); end if;
  if p.locked_until is not null and p.locked_until > now() then return jsonb_build_object('ok', false, 'lockedUntil', p.locked_until); end if;
  if p.pin_hash is null or p.pin_hash <> extensions.crypt(coalesce(p_pin, ''), p.pin_hash) then
    -- 5 wrong in a row: locked 15 minutes, then 5 more tries
    update public.people set
      locked_until = case when fails + 1 >= 5 then now() + interval '15 minutes' else locked_until end,
      fails = case when fails + 1 >= 5 then 0 else fails + 1 end
      where id = p.id;
    select * into p from public.people where id = p.id;
    insert into public.login_attempts (key, ok) values ('user:' || u, false);
    return jsonb_build_object('ok', false, 'lockedUntil', case when p.locked_until > now() then p.locked_until end,
      'left', case when p.locked_until > now() then 0 else 5 - p.fails end);
  end if;
  insert into public.login_attempts (key, ok) values ('user:' || u, true);
  update public.people set fails = 0, locked_until = null where id = p.id;
  r := private.eff_roles(p);
  t := private.new_tok('branch', p.branch, interval '12 hours', p.id, null, null);
  update public.tokens set sup = (r && array['sup', 'om']) where token = t;
  return jsonb_build_object('ok', true, 'token', t, 'branch', p.branch, 'mustChange', p.must_change, 'person', private.person_json(p));
end $$;

create or replace function public.person_set_pin(p_token text, p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare p public.people := private.need_person(p_token);
begin
  if not private.pin_ok(coalesce(p_pin, ''), 6) then
    raise exception 'Use 6 digits, not all the same and not in a row like 123456';
  end if;
  if p.pin_hash is not null and p.pin_hash = extensions.crypt(p_pin, p.pin_hash) then raise exception 'Choose a new PIN, not the temporary one'; end if;
  update public.people set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf')), must_change = false where id = p.id;
  return jsonb_build_object('ok', true);
end $$;

-- who is signed in, and whether a monthly stock take is open at their NDD
create or replace function public.wh_me(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare p public.people := private.need_person(p_token); t public.stock_takes := private.cur();
begin
  return jsonb_build_object('person', private.person_json(p), 'branch', p.branch,
    'stockTake', case when t.kind = 'monthly' and t.status = 'open' and exists (select 1 from private.scoped_sys(t.id) s where s.branch = p.branch)
                      then jsonb_build_object('id', t.id, 'name', t.name) end);
end $$;

-- the monthly stock take: Admin, Supervisor or Ops Manager opens counting on this phone for the helpers
create or replace function public.person_join_take(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare p public.people := private.need_person(p_token, array['admin', 'sup', 'om']); t public.stock_takes := private.cur();
begin
  if not (t.kind = 'monthly' and t.status = 'open' and exists (select 1 from private.scoped_sys(t.id) s where s.branch = p.branch)) then
    raise exception 'NOT OPEN: there is no stock take open at this warehouse';
  end if;
  return jsonb_build_object('ok', true, 'branch', p.branch,
    'token', private.new_tok('branch', p.branch, interval '1 day', null, null, null),
    'take', private.take_json(t));
end $$;

-- people: a username is part of a person now
drop function if exists public.wh_person_save(text, text, uuid, text, text[], boolean, date);
create or replace function public.wh_person_save(p_token text, p_branch text, p_id uuid, p_name text, p_username text, p_roles text[], p_active boolean default true, p_acting_om_until date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare me uuid := private.need_om_or_hq(p_token, p_branch); hq boolean := me is null; p public.people; pin text; rs text[];
        un text := lower(trim(coalesce(p_username, '')));
begin
  rs := array(select distinct x from unnest(coalesce(p_roles, '{}')) x where x in ('lo', 'admin', 'sup', 'om'));
  if trim(coalesce(p_name, '')) = '' then raise exception 'Enter a name'; end if;
  if not exists (select 1 from public.branches where name = p_branch) then raise exception 'Unknown warehouse'; end if;
  if array_length(rs, 1) is null then raise exception 'Pick at least one role'; end if;
  if p_id is not null then select * into p from public.people where id = p_id and branch = p_branch; if p.id is null then raise exception 'Person not found'; end if; end if;
  if un = '' then un := coalesce(p.username, private.suggest_username(p_name, p_branch, p.id)); end if;
  if un !~ '^[a-z0-9][a-z0-9._-]{2,31}$' then raise exception 'Username: 3 to 32 letters or numbers (dot, dash and underscore allowed), no spaces'; end if;
  if exists (select 1 from public.people x where lower(x.username) = un and x.id is distinct from p.id) then raise exception 'That username is taken. Try %', private.suggest_username(p_name, p_branch, p.id); end if;
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
    pin := private.temp_pin(6);
    insert into public.people (branch, name, username, roles, pin_hash, must_change, acting_om_until)
    values (p_branch, trim(p_name), un, rs, extensions.crypt(pin, extensions.gen_salt('bf')), true, p_acting_om_until) returning * into p;
  else
    update public.people set name = trim(p_name), username = un, roles = rs, active = coalesce(p_active, true), acting_om_until = p_acting_om_until
    where id = p.id returning * into p;
    if not p.active then delete from public.tokens where person_id = p.id; end if;
  end if;
  return private.person_json(p) || jsonb_build_object('tempPin', pin);
end $$;

create or replace function public.wh_person_reset(p_token text, p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare p public.people; me uuid; pin text := private.temp_pin(6);
begin
  select * into p from public.people where id = p_id;
  if p.id is null then raise exception 'Person not found'; end if;
  me := private.need_om_or_hq(p_token, p.branch);
  if me is not null and 'om' = any (p.roles) then raise exception 'NOT ALLOWED: HQ resets an Ops Manager''s PIN'; end if;
  update public.people set pin_hash = extensions.crypt(pin, extensions.gen_salt('bf')), must_change = true, fails = 0, locked_until = null where id = p.id;
  delete from public.tokens where person_id = p.id;
  return jsonb_build_object('ok', true, 'tempPin', pin, 'name', p.name, 'username', p.username);
end $$;

-- the OM closes the day with their 6-digit PIN (unchanged); devices are no longer needed to sign in
revoke all on function private.suggest_username(text, text, uuid) from public, anon, authenticated;
do $$ declare f text; begin
  foreach f in array array['user_login(text, text)', 'person_set_pin(text, text)', 'wh_me(text)', 'person_join_take(text)',
    'wh_person_save(text, text, uuid, text, text, text[], boolean, date)', 'wh_person_reset(text, uuid)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  -- the device set-up and device sign-in are retired
  foreach f in array array['device_setup_start(text)', 'device_setup(text, uuid, text, text)', 'device_info(text)', 'person_login(text, uuid, text)', 'device_join_take(text)'] loop
    execute format('revoke all on function public.%s from anon, authenticated', f);
  end loop;
end $$;
