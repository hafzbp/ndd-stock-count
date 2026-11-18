-- Daily cycle count (DCC).
-- Each NDD gets its own small stock take per working day (kind = 'daily'), planned automatically:
--   ABC per NDD per month (by stock value from the latest daily stock upload), monthly targets per class
--   (default A 4x, B 2x, C 1x), spread over the remaining working days, plus next-day recounts of SKUs
--   that were outside tolerance. The monthly stock take (kind = 'monthly') works as before and takes
--   precedence for a warehouse while it is open there.
-- Supervisors (plant code + PIN) review their own warehouse, add SKUs to today's list, or skip a day.

------------------------------------------------------------------ schema
alter table public.stock_takes add column if not exists kind text not null default 'monthly' check (kind in ('monthly', 'daily'));
alter table public.stock_takes add column if not exists branch text;
alter table public.stock_takes add column if not exists count_date date;
alter table public.stock_takes add column if not exists snap_id uuid;
alter table public.stock_takes add column if not exists skip_reason text;
alter table public.stock_takes add column if not exists added_skus text[] not null default '{}';
alter table public.stock_takes add column if not exists plan jsonb not null default '{}'::jsonb;
create unique index if not exists stock_takes_daily_uq on public.stock_takes (branch, count_date) where kind = 'daily';

alter table public.branches add column if not exists work_days int[] not null default '{1,2,3,4,5,6}';  -- ISO weekday, 1 = Monday
alter table public.branches add column if not exists count_from time not null default '07:00';
alter table public.branches add column if not exists count_to time not null default '10:00';
alter table public.branches add column if not exists sup_hash text;
alter table public.branches add column if not exists sup_must_change boolean not null default false;

alter table public.tokens add column if not exists sup boolean not null default false;

-- daily stock upload (one file for all plants), kept for the last 14 upload dates
create table if not exists public.snapshots (
  id uuid primary key default gen_random_uuid(),
  snap_date date not null unique,
  loaded_at timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb
);
create table if not exists public.snap_stock (
  snap_id uuid not null references public.snapshots(id) on delete cascade,
  branch text not null,
  code text not null,
  batch text not null default '',
  qty numeric not null,
  unit_cost numeric,
  sloc text,
  stype text not null default 'good' check (stype in ('good', 'bad'))   -- bad stock: later phase
);
create index if not exists snap_stock_idx on public.snap_stock (snap_id, branch, code);

create table if not exists public.sku_class (
  branch text not null,
  month date not null,
  code text not null,
  cls text not null check (cls in ('A', 'B', 'C')),
  value numeric not null default 0,
  share numeric not null default 0,
  override boolean not null default false,
  primary key (branch, month, code)
);

-- one row per SKU per closed count (daily or monthly): drives the schedule and the dashboard
create table if not exists public.count_log (
  take_id uuid not null references public.stock_takes(id) on delete cascade,
  branch text not null,
  code text not null,
  count_date date not null,
  kind text not null,
  sys_q numeric, phys_q numeric, var_q numeric, var_rm numeric,
  flag text,
  primary key (take_id, branch, code)
);
create index if not exists count_log_bcd on public.count_log (branch, code, count_date);

do $$ declare t text; begin
  foreach t in array array['snapshots', 'snap_stock', 'sku_class', 'count_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

insert into public.settings (key, value) values
  ('dcc_enabled', 'true'::jsonb), ('dcc_abc', '{"a": 80, "b": 95}'::jsonb), ('dcc_target', '{"A": 4, "B": 2, "C": 1}'::jsonb)
on conflict (key) do nothing;

------------------------------------------------------------------ helpers
create or replace function private.today()
returns date language sql stable set search_path = '' as $$
  select coalesce((select (value #>> '{}')::date from public.settings where key = 'test_today'),
                  (now() at time zone 'Asia/Kuala_Lumpur')::date)
$$;

create or replace function private.workdays(b public.branches, d1 date, d2 date)
returns int language sql stable set search_path = '' as $$
  select count(*)::int from generate_series(d1, d2, interval '1 day') g where extract(isodow from g)::int = any (b.work_days)
$$;

create or replace function private.take_json(t public.stock_takes)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', t.id, 'name', t.name, 'status', t.status, 'closed', t.status = 'closed',
    'scope', t.scope, 'mode', t.mode, 'skuCount', coalesce(array_length(t.skus, 1), 0), 'resetId', t.reset_id,
    'startedAt', t.started_at, 'openedAt', t.opened_at, 'closedAt', t.closed_at,
    'kind', t.kind, 'branch', t.branch, 'countDate', t.count_date, 'skipReason', t.skip_reason)
$$;

-- ABC for one warehouse and month, from one stock upload. A = SKUs making up the first 80% of stock value,
-- B = the next 15%, C = the rest (thresholds in settings). Without RM values, quantity is used instead.
create or replace function private.ensure_abc(p_branch text, p_month date, p_snap uuid)
returns void language plpgsql set search_path = '' as $$
declare a numeric := coalesce((private.setting('dcc_abc') ->> 'a')::numeric, 80) / 100;
        bb numeric := coalesce((private.setting('dcc_abc') ->> 'b')::numeric, 95) / 100;
begin
  if exists (select 1 from public.sku_class where branch = p_branch and month = p_month) then return; end if;
  insert into public.sku_class (branch, month, code, cls, value, share)
  with v as (
    select code, sum(qty * coalesce(unit_cost, 0)) as val, sum(qty) as q
    from public.snap_stock where snap_id = p_snap and branch = p_branch and stype = 'good'
    group by code having sum(qty) > 0
  ), t as (select sum(val) as tv, sum(q) as tq from v),
  r as (select v.code, v.val, case when t.tv > 0 then v.val / t.tv else v.q / t.tq end as sh from v, t),
  c as (select r.*, coalesce(sum(sh) over (order by sh desc, code rows between unbounded preceding and 1 preceding), 0) as before from r)
  select p_branch, p_month, code, case when before < a then 'A' when before < bb then 'B' else 'C' end, val, sh from c;
end $$;

-- Write the per-SKU result of a closed count to count_log.
create or replace function private.log_take(p_take uuid)
returns void language plpgsql set search_path = '' as $$
declare t public.stock_takes;
begin
  select * into t from public.stock_takes where id = p_take;
  delete from public.count_log where take_id = p_take;
  insert into public.count_log (take_id, branch, code, count_date, kind, sys_q, phys_q, var_q, var_rm, flag)
  select p_take, v.branch, v.code,
         coalesce(t.count_date, (coalesce(t.closed_at, now()) at time zone 'Asia/Kuala_Lumpur')::date), t.kind,
         sum(v.sys), sum(v.phys), sum(v.v), sum(v.vv), max(v.sku_flag)
  from private.variance(p_take) v
  where v.sku_flag not in ('PENDING', 'NOT COUNTED')
  group by v.branch, v.code;
end $$;

-- Plan today's list for one warehouse (or return the existing one). Returns null when there is nothing to plan:
-- not a working day, monthly stock take open there, no stock upload yet, or nothing due.
create or replace function private.plan_daily(p_branch text, d date)
returns public.stock_takes language plpgsql set search_path = '' as $$
declare b public.branches; t public.stock_takes; m public.stock_takes := private.cur(); sid uuid; mon date := date_trunc('month', d)::date;
        w int; r int; quota int; tgt jsonb := coalesce(private.setting('dcc_target'), '{"A":4,"B":2,"C":1}'::jsonb);
        picks text[]; trig text[]; allc text[]; pl jsonb;
begin
  select * into t from public.stock_takes where kind = 'daily' and branch = p_branch and count_date = d;
  if found then return t; end if;
  if coalesce((private.setting('dcc_enabled') #>> '{}')::boolean, false) is not true then return null; end if;
  select * into b from public.branches where name = p_branch and active;
  if not found or not (extract(isodow from d)::int = any (b.work_days)) then return null; end if;
  if m.status = 'open' and exists (select 1 from private.scoped_sys(m.id) s where s.branch = p_branch) then return null; end if;
  select id into sid from public.snapshots where snap_date <= d order by snap_date desc limit 1;
  if sid is null then return null; end if;
  perform private.ensure_abc(p_branch, mon, sid);
  w := greatest(private.workdays(b, mon, (mon + interval '1 month - 1 day')::date), 1);
  r := greatest(private.workdays(b, d, (mon + interval '1 month - 1 day')::date), 1);

  create temp table if not exists _due (code text, cls text, need int, gap int, since int, val numeric) on commit drop;
  delete from pg_temp._due where true;
  insert into pg_temp._due
  select sc.code, sc.cls,
         greatest(0, coalesce((tgt ->> sc.cls)::int, 1) - (select count(*) from public.count_log l where l.branch = p_branch and l.code = sc.code and l.count_date >= mon and l.count_date < d))::int,
         greatest(1, floor(w::numeric / greatest(coalesce((tgt ->> sc.cls)::int, 1), 1))::int - 1),
         coalesce(d - (select max(l.count_date) from public.count_log l where l.branch = p_branch and l.code = sc.code and l.count_date < d), 9999),
         sc.value
  from public.sku_class sc where sc.branch = p_branch and sc.month = mon;

  quota := ceil((select coalesce(sum(need), 0) from pg_temp._due)::numeric / r)::int;
  select coalesce(array_agg(code), '{}') into picks from (
    select code from pg_temp._due where need > 0 and since >= gap order by cls, since desc, val desc, code limit quota) x;
  if coalesce(array_length(picks, 1), 0) < quota then
    picks := picks || coalesce((select array_agg(code) from (
      select code from pg_temp._due where need > 0 and not (code = any (picks)) order by cls, since desc, val desc, code
      limit quota - coalesce(array_length(picks, 1), 0)) y), '{}');
  end if;
  -- next-day recount: SKUs outside tolerance (or found without system stock) on the previous daily count
  select coalesce(array_agg(l.code), '{}') into trig from public.count_log l
  where l.take_id = (select id from public.stock_takes where kind = 'daily' and branch = p_branch and count_date < d
                     and status = 'closed' and skip_reason is null order by count_date desc limit 1)
    and l.flag in ('OVER', 'NOT IN SYSTEM');
  allc := array(select distinct x from unnest(picks || trig) x order by 1);
  if coalesce(array_length(allc, 1), 0) = 0 then return null; end if;
  select jsonb_object_agg(x, case when x = any (trig) then 'R' else coalesce((select cls from pg_temp._due where code = x), 'C') end) into pl from unnest(allc) x;

  insert into public.stock_takes (name, kind, branch, count_date, scope, skus, mode, status, opened_at, snap_id, plan)
  values ('Daily ' || to_char(d, 'DD Mon YYYY'), 'daily', p_branch, d, 'partial', allc, 'single', 'open', now(), sid, pl)
  on conflict (branch, count_date) where kind = 'daily' do nothing
  returning * into t;
  if t.id is null then
    select * into t from public.stock_takes where kind = 'daily' and branch = p_branch and count_date = d;
    return t;
  end if;
  insert into public.sys_stock (take_id, branch, code, batch, qty, unit_cost, sloc)
  select t.id, s.branch, s.code, s.batch, s.qty, s.unit_cost, s.sloc
  from public.snap_stock s where s.snap_id = sid and s.branch = p_branch and s.stype = 'good' and s.code = any (allc);
  return t;
end $$;

-- Close daily counts from earlier days (once per call, cheap when there is nothing to do).
create or replace function private.roll_daily()
returns void language plpgsql set search_path = '' as $$
declare t public.stock_takes;
begin
  for t in select * from public.stock_takes where kind = 'daily' and status = 'open' and count_date < private.today() loop
    update public.stock_takes set status = 'closed', closed = true, closed_at = now() where id = t.id;
    perform private.log_take(t.id);
  end loop;
end $$;

-- The stock take a counter at this warehouse works on right now.
create or replace function private.take_for(p_branch text)
returns public.stock_takes language plpgsql set search_path = '' as $$
declare m public.stock_takes := private.cur(); d public.stock_takes;
begin
  if m.status = 'open' and exists (select 1 from private.scoped_sys(m.id) s where s.branch = p_branch) then return m; end if;
  if coalesce((private.setting('dcc_enabled') #>> '{}')::boolean, false) then
    perform private.roll_daily();
    d := private.plan_daily(p_branch, private.today());
    if d.id is not null then return d; end if;
  end if;
  return m;
end $$;

create or replace function private.tok_sup(p_token text, p_branch text)
returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from public.tokens where token = p_token and expires_at > now()
    and (kind in ('owner', 'finance') or (kind = 'branch' and sup and branch = p_branch)))
$$;
create or replace function private.need_sup(p_token text, p_branch text)
returns void language plpgsql stable set search_path = '' as $$
begin
  if not private.tok_sup(p_token, p_branch) then raise exception 'AUTH: supervisor login needed' using errcode = '28000'; end if;
end $$;

------------------------------------------------------------------ counters (take per warehouse)
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
  return jsonb_build_object('ok', true, 'token', private.new_token('branch', b.name, 30), 'branch', b.name, 'plant', c,
    'take', private.take_json(private.take_for(b.name)));
end $$;

create or replace function public.counter_branch(p_token text, p_branch text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare t public.stock_takes;
begin
  perform private.need_branch(p_token, p_branch);
  t := private.take_for(p_branch);
  return jsonb_build_object(
    'branch', p_branch, 'take', private.take_json(t),
    'codes', case when t.kind = 'daily' then to_jsonb(t.skus)
             else coalesce((select jsonb_agg(distinct code) from private.scoped_sys(t.id) where branch = p_branch), '[]'::jsonb) end,
    'batches', coalesce((select jsonb_object_agg(code, bs) from (
        select code, jsonb_agg(distinct private.month_of(batch)) as bs
        from private.scoped_sys(t.id) where branch = p_branch group by code) x), '{}'::jsonb),
    'recount', coalesce((select to_jsonb(items) from public.recount where take_id = t.id and branch = p_branch), '[]'::jsonb));
end $$;

-- A phone normally serves one warehouse: its take is the one for the most recently logged-in warehouse.
create or replace function public.counter_sync(p_tokens text[], p_device text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare adm boolean; br text; t public.stock_takes; brs text[];
begin
  select bool_or(kind in ('owner', 'finance')), coalesce(array_agg(branch) filter (where kind = 'branch'), '{}')
    into adm, brs from public.tokens where token = any (p_tokens) and expires_at > now();
  select branch into br from public.tokens where token = any (p_tokens) and expires_at > now() and kind = 'branch' order by created_at desc limit 1;
  t := case when br is not null then private.take_for(br) else private.cur() end;
  return jsonb_build_object(
    'take', private.take_json(t),
    'sessions', coalesce((select jsonb_agg(private.session_json(s)) from public.count_sessions s
        where s.take_id = t.id and s.device_id = p_device and (coalesce(adm, false) or s.branch = any (brs))), '[]'::jsonb),
    'recount', coalesce((select jsonb_object_agg(r.branch, to_jsonb(r.items)) from public.recount r
        where r.take_id = t.id and (coalesce(adm, false) or r.branch = any (brs))), '{}'::jsonb));
end $$;

create or replace function public.counter_start(p_token text, p_device text, p_branch text, p_role text, p_data jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare k text := private.need_branch(p_token, p_branch); tk public.stock_takes; s public.count_sessions;
begin
  tk := private.take_for(p_branch);
  if k = 'branch' and tk.kind = 'monthly' and coalesce((private.setting('dcc_enabled') #>> '{}')::boolean, false)
     and (tk.status = 'draft' or (tk.status = 'closed' and coalesce(tk.closed_at, '-infinity') < now() - interval '12 hours')) then
    raise exception 'NOT OPEN: Nothing to count at % today.', p_branch;
  end if;
  if tk.status = 'draft' and k = 'branch' then raise exception 'NOT OPEN: Counting hasn''t started yet. Your admin will open it.'; end if;
  if tk.status = 'closed' and k = 'branch' then
    raise exception 'CLOSED: %', case when tk.skip_reason is not null then 'Today''s count was skipped: ' || tk.skip_reason else 'Counting is closed.' end;
  end if;
  if p_role not in ('ops', 'fin') then raise exception 'Bad role'; end if;
  if k <> 'owner' and exists (select 1 from public.count_sessions x where x.take_id = tk.id and x.device_id = p_device
       and x.branch = p_branch and x.role <> p_role and private.has_qty(x.data)) then
    raise exception 'NOT ALLOWED: this phone already has a % count for %. Ops and Finance must count on different phones so the two counts stay independent.',
      case when p_role = 'ops' then 'Finance' else 'Ops' end, p_branch;
  end if;
  insert into public.count_sessions (take_id, device_id, branch, role, data)
  values (tk.id, p_device, p_branch, p_role, coalesce(p_data, '{}'::jsonb))
  on conflict (take_id, device_id, branch, role) do update
    set data = public.count_sessions.data || jsonb_build_object('member', excluded.data -> 'member', 'names', excluded.data -> 'names', 'countedBy', excluded.data -> 'countedBy'),
        updated_at = now()
  returning * into s;
  return private.session_json(s);
end $$;

create or replace function public.counter_save(p_token text, p_device text, p_id uuid, p_data jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare s public.count_sessions; k text; st text;
begin
  select * into s from public.count_sessions where id = p_id;
  if not found then raise exception 'GONE: this count was cleared by the owner.'; end if;
  k := private.need_branch(p_token, s.branch);
  if s.device_id <> p_device and k = 'branch' then raise exception 'Not your count'; end if;
  perform private.roll_daily();
  select t.status into st from public.stock_takes t where t.id = s.take_id;
  if s.status = 'submitted' or (st <> 'open' and k = 'branch') or s.take_id <> (private.take_for(s.branch)).id then
    return jsonb_build_object('ok', false, 'session', private.session_json(s), 'closed', st <> 'open');
  end if;
  update public.count_sessions set data = p_data, updated_at = now() where id = p_id returning * into s;
  return jsonb_build_object('ok', true, 'session', private.session_json(s));
end $$;

------------------------------------------------------------------ supervisor
create or replace function public.sup_login(p_code text, p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare b public.branches; c text := trim(coalesce(p_code, '')); t text;
begin
  perform private.too_many('sup');
  select * into b from public.branches where active and c = any (plants) limit 1;
  if not found or b.sup_hash is null or b.sup_hash <> extensions.crypt(coalesce(p_pin, ''), b.sup_hash) then
    insert into public.login_attempts (key, ok) values ('sup', false);
    return jsonb_build_object('ok', false);
  end if;
  t := private.new_token('branch', b.name, 14);
  update public.tokens set sup = true where token = t;
  return jsonb_build_object('ok', true, 'token', t, 'branch', b.name, 'mustChange', b.sup_must_change);
end $$;

create or replace function public.sup_change_pin(p_token text, p_branch text, p_pin text)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.need_sup(p_token, p_branch);
  if coalesce(p_pin, '') !~ '^[0-9]{6,8}$' then raise exception 'Use 6 to 8 digits'; end if;
  update public.branches set sup_hash = extensions.crypt(p_pin, extensions.gen_salt('bf')), sup_must_change = false where name = p_branch;
end $$;

-- HQ creates or resets a supervisor PIN; it is shown once and must be changed at first login.
create or replace function public.admin_sup_pin(p_token text, p_branch text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare p text := lpad((floor(random() * 1000000))::int::text, 6, '0');
begin
  perform private.need_admin(p_token);
  update public.branches set sup_hash = extensions.crypt(p, extensions.gen_salt('bf')), sup_must_change = true where name = p_branch;
  if not found then raise exception 'Unknown warehouse'; end if;
  delete from public.tokens where branch = p_branch and sup;
  return jsonb_build_object('branch', p_branch, 'pin', p);
end $$;

-- One warehouse's daily count for a date (today by default), in the same shape the Master view reads.
create or replace function public.sup_day(p_token text, p_branch text, p_date date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare d date := coalesce(p_date, private.today()); t public.stock_takes;
begin
  perform private.need_sup(p_token, p_branch);
  perform private.roll_daily();
  if d = private.today() then t := private.plan_daily(p_branch, d);
  else select * into t from public.stock_takes where kind = 'daily' and branch = p_branch and count_date = d; end if;
  return jsonb_build_object(
    'date', d, 'today', private.today(), 'branch', p_branch,
    'takeInfo', case when t.id is null then null else private.take_json(t) || jsonb_build_object('skus', to_jsonb(t.skus), 'plan', t.plan, 'added', to_jsonb(t.added_skus)) end,
    'settings', (select jsonb_object_agg(key, value) from public.settings where key in ('tolerance', 'photo_min', 'photo_max', 'title')),
    'skus', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'desc', descr, 'per', per, 'perBox', per_box) order by code) from public.skus), '[]'::jsonb),
    'branches', jsonb_build_array(jsonb_build_object('name', p_branch, 'active', true)),
    'sessions', coalesce((select jsonb_agg(private.session_json(s) order by s.started_at) from public.count_sessions s where s.take_id = t.id), '[]'::jsonb),
    'sys', coalesce((select jsonb_object_agg(branch, rows) from (
        select branch, jsonb_agg(jsonb_build_array(code, batch, qty, coalesce(unit_cost, 0), coalesce(sloc, '')) order by code, batch) as rows
        from private.scoped_sys(t.id) group by branch) x), '{}'::jsonb),
    'recount', coalesce((select jsonb_object_agg(branch, to_jsonb(items)) from public.recount where take_id = t.id), '{}'::jsonb),
    'history', coalesce((select jsonb_agg(h order by h ->> 'date' desc) from (
        select jsonb_build_object('date', x.count_date, 'id', x.id, 'status', x.status, 'skip', x.skip_reason, 'skus', coalesce(array_length(x.skus, 1), 0),
          'counted', case when x.status = 'open' then (select count(distinct e.value ->> 'code') from public.count_sessions s
                       cross join lateral jsonb_each(coalesce(s.data -> 'lines', '{}'::jsonb)) e where s.take_id = x.id and private.line_has_qty(e.value))
                     else (select count(*) from public.count_log l where l.take_id = x.id) end,
          'ok', (select count(*) from public.count_log l where l.take_id = x.id and l.flag in ('OK', 'WITHIN')),
          'submittedAt', (select min(s.submitted_at) from public.count_sessions s where s.take_id = x.id and s.status = 'submitted')) as h
        from public.stock_takes x where x.kind = 'daily' and x.branch = p_branch and x.count_date > d - 31 and x.count_date <= private.today()) y), '[]'::jsonb),
    'monthlyOpen', (private.cur()).status = 'open');
end $$;

create or replace function public.sup_add_sku(p_token text, p_branch text, p_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare t public.stock_takes; c text := trim(coalesce(p_code, ''));
begin
  perform private.need_sup(p_token, p_branch);
  t := private.plan_daily(p_branch, private.today());
  if t.id is null then raise exception 'There is no count planned for today at %.', p_branch; end if;
  if t.status <> 'open' then raise exception 'Today''s count is closed.'; end if;
  if not exists (select 1 from public.skus where code = c) then raise exception 'Unknown SKU %', c; end if;
  if c = any (t.skus) then return private.take_json(t); end if;
  update public.stock_takes set skus = skus || c, added_skus = added_skus || c, plan = plan || jsonb_build_object(c, 'S')
    where id = t.id returning * into t;
  insert into public.sys_stock (take_id, branch, code, batch, qty, unit_cost, sloc)
  select t.id, s.branch, s.code, s.batch, s.qty, s.unit_cost, s.sloc
  from public.snap_stock s where s.snap_id = t.snap_id and s.branch = p_branch and s.stype = 'good' and s.code = c;
  return private.take_json(t);
end $$;

create or replace function public.sup_skip(p_token text, p_branch text, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare t public.stock_takes;
begin
  perform private.need_sup(p_token, p_branch);
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Give a reason'; end if;
  t := private.plan_daily(p_branch, private.today());
  if t.id is null then raise exception 'There is no count planned for today at %.', p_branch; end if;
  if exists (select 1 from public.count_sessions s where s.take_id = t.id and private.has_qty(s.data)) then
    raise exception 'Counting has already started today; it can''t be skipped.';
  end if;
  update public.stock_takes set status = 'closed', closed = true, closed_at = now(), skip_reason = trim(p_reason)
    where id = t.id returning * into t;
  return private.take_json(t);
end $$;

------------------------------------------------------------------ HQ admin
-- Daily stock upload: one file for all plants, dated. Open daily counts pick up the new figures
-- (counters never see system stock, so this is safe while they count).
create or replace function public.admin_load_daily(p_token text, p_date date, p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare sid uuid; b text; pl jsonb; n int := 0; t public.stock_takes;
begin
  perform private.need_admin(p_token);
  if p_date is null or p_date > private.today() then raise exception 'Pick the stock date (today or earlier)'; end if;
  insert into public.snapshots (snap_date, meta) values (p_date, coalesce(p_payload -> 'meta', '{}'::jsonb))
    on conflict (snap_date) do update set meta = excluded.meta, loaded_at = now()
    returning id into sid;
  delete from public.snap_stock where snap_id = sid;
  for b in select jsonb_object_keys(p_payload -> 'byBr') loop
    insert into public.snap_stock (snap_id, branch, code, batch, qty, unit_cost, sloc)
    select sid, b, r ->> 0, coalesce(r ->> 1, ''), (r ->> 2)::numeric, nullif(r ->> 3, '')::numeric, r ->> 4
    from jsonb_array_elements(p_payload -> 'byBr' -> b) r;
    n := n + 1;
  end loop;
  for b, pl in select key, value from jsonb_each(coalesce(p_payload -> 'plants', '{}'::jsonb)) loop
    update public.branches set plants = array(select distinct x from unnest(plants || array(select jsonb_array_elements_text(pl))) x where x <> '')
      where name = b;
  end loop;
  insert into public.skus (code, descr)
  select d.key, d.value #>> '{}' from jsonb_each(coalesce(p_payload -> 'descs', '{}'::jsonb)) d
  on conflict (code) do update set descr = case when public.skus.descr = '' then excluded.descr else public.skus.descr end;
  insert into public.skus (code, descr) select distinct code, '' from public.snap_stock where snap_id = sid on conflict (code) do nothing;
  -- refresh open daily counts that use an older or the same upload
  for t in select x.* from public.stock_takes x join public.snapshots s on s.id = x.snap_id
           where x.kind = 'daily' and x.status = 'open' and x.count_date >= p_date and s.snap_date <= p_date loop
    delete from public.sys_stock where take_id = t.id;
    insert into public.sys_stock (take_id, branch, code, batch, qty, unit_cost, sloc)
    select t.id, s.branch, s.code, s.batch, s.qty, s.unit_cost, s.sloc
    from public.snap_stock s where s.snap_id = sid and s.branch = t.branch and s.stype = 'good' and s.code = any (t.skus);
    update public.stock_takes set snap_id = sid where id = t.id;
  end loop;
  delete from public.snapshots where id in (select id from public.snapshots order by snap_date desc offset 14)
    and id not in (select snap_id from public.stock_takes where snap_id is not null and status = 'open');
  return jsonb_build_object('branches', n, 'date', p_date);
end $$;

create or replace function public.admin_dcc_branch(p_token text, p_branch text, p_days int[], p_from time, p_to time)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.need_admin(p_token);
  if p_from >= p_to then raise exception 'Count window: start must be before end'; end if;
  if exists (select 1 from unnest(p_days) x where x < 1 or x > 7) then raise exception 'Bad weekday'; end if;
  update public.branches set work_days = coalesce(p_days, '{}'), count_from = p_from, count_to = p_to where name = p_branch;
end $$;

-- Overview of one day for all warehouses (plans today's lists on the way).
create or replace function public.admin_dcc_day(p_token text, p_date date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare d date := coalesce(p_date, private.today()); b public.branches; t public.stock_takes; out jsonb := '[]'::jsonb; m public.stock_takes := private.cur();
        why text; sub timestamptz; started boolean; cnt int;
begin
  perform private.need_admin(p_token);
  perform private.roll_daily();
  for b in select * from public.branches where active order by sort, name loop
    t := null; why := null;
    if d = private.today() then t := private.plan_daily(b.name, d);
    else select * into t from public.stock_takes where kind = 'daily' and branch = b.name and count_date = d; end if;
    if t.id is null then
      why := case when not (extract(isodow from d)::int = any (b.work_days)) then 'off'
                  when m.status = 'open' and exists (select 1 from private.scoped_sys(m.id) s where s.branch = b.name) then 'monthly'
                  when not exists (select 1 from public.snapshots where snap_date <= d) then 'nostock'
                  else 'nothing' end;
    end if;
    select min(s.submitted_at) filter (where s.status = 'submitted'), bool_or(private.has_qty(s.data))
      into sub, started from public.count_sessions s where s.take_id = t.id;
    select count(distinct e.value ->> 'code') into cnt from public.count_sessions s cross join lateral jsonb_each(coalesce(s.data -> 'lines', '{}'::jsonb)) e
      where s.take_id = t.id and private.line_has_qty(e.value);
    out := out || jsonb_build_object('branch', b.name, 'workDays', to_jsonb(b.work_days), 'from', to_char(b.count_from, 'HH24:MI'), 'to', to_char(b.count_to, 'HH24:MI'),
      'take', case when t.id is null then null else private.take_json(t) || jsonb_build_object('plan', t.plan) end,
      'why', why, 'submittedAt', sub, 'started', coalesce(started, false), 'counted', coalesce(cnt, 0),
      'late', sub is not null and ((sub at time zone 'Asia/Kuala_Lumpur')::date > d or (sub at time zone 'Asia/Kuala_Lumpur')::time > b.count_to));
  end loop;
  return jsonb_build_object('date', d, 'today', private.today(), 'rows', out,
    'snapshot', (select jsonb_build_object('date', snap_date, 'loadedAt', loaded_at) from public.snapshots order by snap_date desc limit 1));
end $$;

-- ABC list of a warehouse for a month, with progress against the monthly target.
create or replace function public.admin_abc(p_token text, p_branch text, p_month date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare mon date := date_trunc('month', coalesce(p_month, private.today()))::date; tgt jsonb := private.setting('dcc_target');
begin
  if not private.tok_sup(p_token, p_branch) then perform private.need_admin(p_token); end if;
  return jsonb_build_object('month', mon, 'target', tgt, 'rows', coalesce((select jsonb_agg(jsonb_build_object(
      'code', sc.code, 'desc', (select descr from public.skus k where k.code = sc.code), 'cls', sc.cls, 'value', round(sc.value, 2), 'share', round(sc.share * 100, 2),
      'counted', (select count(*) from public.count_log l where l.branch = sc.branch and l.code = sc.code and l.count_date >= mon and l.count_date < (mon + interval '1 month')::date),
      'last', (select max(count_date) from public.count_log l where l.branch = sc.branch and l.code = sc.code))
    order by sc.cls, sc.share desc) from public.sku_class sc where sc.branch = p_branch and sc.month = mon), '[]'::jsonb));
end $$;

------------------------------------------------------------------ dashboard
-- Shared numbers for the daily-count dashboard. with_rm = false for the public page.
create or replace function private.dcc_stats(p_from date, p_to date, with_rm boolean)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare res jsonb; td date := private.today(); mon date := date_trunc('month', p_to)::date;
begin
  perform private.roll_daily();
  create temp table if not exists _lg (branch text, code text, count_date date, var_q numeric, var_rm numeric, flag text) on commit drop;
  delete from pg_temp._lg where true;
  insert into pg_temp._lg select branch, code, count_date, var_q, var_rm, flag from public.count_log where kind = 'daily' and count_date between p_from and p_to;
  -- today's open counts that are already submitted count too
  insert into pg_temp._lg
  select v.branch, v.code, t.count_date, sum(v.v), sum(v.vv), max(v.sku_flag)
  from public.stock_takes t cross join lateral private.variance(t.id) v
  where t.kind = 'daily' and t.status = 'open' and t.count_date between p_from and p_to
    and exists (select 1 from public.count_sessions s where s.take_id = t.id and s.status = 'submitted')
    and v.sku_flag not in ('PENDING', 'NOT COUNTED')
  group by v.branch, v.code, t.count_date;

  with days as (select g::date as d from generate_series(p_from, p_to, interval '1 day') g),
  br as (select * from public.branches where active),
  cell as (
    select br.name as branch, days.d,
      case
        when t.id is not null and t.skip_reason is not null then 'skip'
        when t.id is not null and sub.s is not null then case when (sub.s at time zone 'Asia/Kuala_Lumpur')::date > days.d or (sub.s at time zone 'Asia/Kuala_Lumpur')::time > br.count_to then 'late' else 'ontime' end
        when t.id is not null and days.d < td then 'missed'
        when t.id is not null and days.d = td then case when sub.started then 'progress' else 'todo' end
        when days.d > td then 'future'
        when not (extract(isodow from days.d)::int = any (br.work_days)) then 'off'
        else 'none' end as st,
      t.skip_reason
    from br cross join days
    left join public.stock_takes t on t.kind = 'daily' and t.branch = br.name and t.count_date = days.d
    left join lateral (select min(s.submitted_at) filter (where s.status = 'submitted') as s, bool_or(private.has_qty(s.data)) as started
                       from public.count_sessions s where s.take_id = t.id) sub on true
  ),
  uni as (select branch, count(*) as n from public.sku_class where month = mon group by branch),
  cov as (select l.branch, count(distinct l.code) as n from public.count_log l join public.sku_class sc on sc.branch = l.branch and sc.month = mon and sc.code = l.code
          where l.count_date >= mon and l.count_date <= p_to group by l.branch),
  covt as (select branch, count(distinct code) as n from pg_temp._lg where count_date >= mon group by branch),
  acc as (select branch, count(*) filter (where flag in ('OK', 'WITHIN')) as ok, count(*) as n,
                 sum(var_rm) as net, sum(abs(var_rm)) as ab, sum(var_q) as netq from pg_temp._lg group by branch),
  pace as (select br.name as branch, private.workdays(br, mon, least(p_to, td)) as done, private.workdays(br, mon, (mon + interval '1 month - 1 day')::date) as tot from br)
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'today', td, 'withRm', with_rm,
    'branches', (select jsonb_agg(jsonb_build_object(
        'branch', br.name,
        'cells', (select jsonb_agg(jsonb_build_object('d', c.d, 'st', c.st, 'why', c.skip_reason) order by c.d) from cell c where c.branch = br.name),
        'universe', coalesce(uni.n, 0),
        'covered', greatest(coalesce(cov.n, 0), coalesce(covt.n, 0)),
        'pace', case when pace.tot > 0 then round(pace.done::numeric / pace.tot * 100, 1) end,
        'ok', coalesce(acc.ok, 0), 'counted', coalesce(acc.n, 0),
        'net', case when with_rm then round(acc.net, 2) end, 'abs', case when with_rm then round(acc.ab, 2) end, 'netQ', acc.netq
      ) order by br.sort, br.name)
      from br left join uni on uni.branch = br.name left join cov on cov.branch = br.name left join covt on covt.branch = br.name
      left join acc on acc.branch = br.name left join pace on pace.branch = br.name),
    'trend', (select jsonb_agg(jsonb_build_object('d', days.d,
        'ok', (select count(*) from pg_temp._lg where count_date = days.d and flag in ('OK', 'WITHIN')),
        'n', (select count(*) from pg_temp._lg where count_date = days.d),
        'covered', (select count(distinct (branch, code)) from pg_temp._lg where count_date >= greatest(mon, p_from) and count_date <= days.d)
                   + (select count(distinct (branch, code)) from public.count_log l where l.count_date >= mon and l.count_date < greatest(mon, p_from)),
        'net', case when with_rm then (select round(sum(var_rm), 2) from pg_temp._lg where count_date = days.d) end) order by days.d)
      from days where days.d <= td),
    'universe', (select coalesce(sum(n), 0) from uni),
    'top', case when with_rm then (select coalesce(jsonb_agg(jsonb_build_object('branch', y.branch, 'code', y.code, 'desc', (select descr from public.skus k where k.code = y.code),
          'varQ', y.vq, 'varRm', round(y.vr, 2), 'times', y.times) order by abs(coalesce(y.vr, 0)) desc, abs(y.vq) desc), '[]'::jsonb) from (
        select branch, code, sum(var_q) as vq, sum(var_rm) as vr, count(*) filter (where flag in ('OVER', 'NOT IN SYSTEM')) as times
        from pg_temp._lg group by branch, code having coalesce(sum(var_q), 0) <> 0
        order by abs(coalesce(sum(var_rm), 0)) desc, abs(coalesce(sum(var_q), 0)) desc limit 10) y) end
  ) into res;
  return res;
end $$;

create or replace function public.admin_dcc_stats(p_token text, p_from date, p_to date)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.need_admin(p_token);
  if p_to - p_from > 92 then raise exception 'Pick at most 3 months'; end if;
  return private.dcc_stats(p_from, p_to, true);
end $$;

create or replace function public.public_dcc(p_from date default null, p_to date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare t date := coalesce(p_to, private.today()); f date := coalesce(p_from, date_trunc('month', coalesce(p_to, private.today()))::date);
begin
  if t - f > 92 then raise exception 'Pick at most 3 months'; end if;
  return private.dcc_stats(f, t, false) || jsonb_build_object('title', private.setting('title'));
end $$;

------------------------------------------------------------------ monthly: log results on close, admin views
create or replace function public.admin_set_status(p_token text, p_status text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare t public.stock_takes := private.cur();
begin
  perform private.need_admin(p_token);
  if p_status = 'open' then
    if not exists (select 1 from private.scoped_sys(t.id)) then
      raise exception 'Upload the MB52 first%', case when t.scope = 'partial' then ' (and check the picked SKUs are in it)' else '' end;
    end if;
    if t.scope = 'partial' and coalesce(array_length(t.skus, 1), 0) = 0 then raise exception 'Pick at least one SKU'; end if;
    update public.stock_takes set status = 'open', closed = false, opened_at = coalesce(opened_at, now()), closed_at = null where id = t.id returning * into t;
    delete from public.count_log where take_id = t.id;
  elsif p_status = 'closed' then
    if t.status <> 'open' then raise exception 'Only an open stock take can be closed'; end if;
    update public.stock_takes set status = 'closed', closed = true, closed_at = now() where id = t.id returning * into t;
    perform private.log_take(t.id);
  else
    raise exception 'Bad status';
  end if;
  return private.take_json(t);
end $$;

create or replace function public.admin_load(p_token text, p_take uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare k text := private.need_admin(p_token); tk uuid := coalesce(p_take, private.cur_take());
begin
  return jsonb_build_object(
    'kind', k,
    'settings', (select jsonb_object_agg(key, value) from public.settings),
    'takes', (select jsonb_agg(private.take_json(t) order by t.started_at desc) from public.stock_takes t where t.kind = 'monthly'),
    'take', tk, 'current', private.cur_take(),
    'takeInfo', (select private.take_json(t) || jsonb_build_object('skus', to_jsonb(t.skus), 'plan', t.plan) from public.stock_takes t where t.id = tk),
    'branches', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'pin', coalesce(pin, ''), 'plants', to_jsonb(plants), 'active', active,
        'workDays', to_jsonb(work_days), 'from', to_char(count_from, 'HH24:MI'), 'to', to_char(count_to, 'HH24:MI'),
        'supPin', sup_hash is not null, 'supMustChange', sup_must_change) order by sort, name) from public.branches), '[]'::jsonb),
    'team', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'branch', branch, 'role', role) order by branch, name) from public.team), '[]'::jsonb),
    'skus', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'desc', descr, 'per', per, 'perBox', per_box) order by code) from public.skus), '[]'::jsonb),
    'barcodeCount', (select count(*) from public.barcodes),
    'sessions', coalesce((select jsonb_agg(private.session_json(s) order by s.branch, s.role, s.started_at) from public.count_sessions s where s.take_id = tk), '[]'::jsonb),
    'sys', coalesce((select jsonb_object_agg(branch, rows) from (
        select branch, jsonb_agg(jsonb_build_array(code, batch, qty, coalesce(unit_cost, 0), coalesce(sloc, '')) order by code, batch) as rows
        from private.scoped_sys(tk) group by branch) x), '{}'::jsonb),
    'sysAllCodes', coalesce((select jsonb_agg(distinct code) from public.sys_stock where take_id = tk), '[]'::jsonb),
    'meta', (select data || jsonb_build_object('loadedAt', loaded_at) from public.mb52_meta where take_id = tk),
    'recount', coalesce((select jsonb_object_agg(branch, to_jsonb(items)) from public.recount where take_id = tk), '{}'::jsonb),
    'snapshot', (select jsonb_build_object('date', snap_date, 'loadedAt', loaded_at) from public.snapshots order by snap_date desc limit 1),
    'financeReady', exists (select 1 from private.secrets where key = 'finance_hash'));
end $$;

create or replace function public.admin_settings(p_token text, p_patch jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare k text; v jsonb;
begin
  perform private.need_admin(p_token);
  for k, v in select * from jsonb_each(p_patch) loop
    if k in ('title', 'tolerance', 'photo_min', 'photo_max', 'photo_roles', 'dash_level', 'dcc_enabled', 'dcc_abc', 'dcc_target') or k like 'x_%' then
      if k = 'tolerance' and ((v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric > 100) then raise exception 'Tolerance must be 0-100'; end if;
      if k = 'dash_level' and (v #>> '{}') not in ('progress', 'qty', 'value') then raise exception 'Bad dashboard level'; end if;
      if k = 'dcc_abc' and not ((v ->> 'a')::numeric > 0 and (v ->> 'a')::numeric < (v ->> 'b')::numeric and (v ->> 'b')::numeric < 100) then
        raise exception 'ABC: A must be below B, both between 0 and 100'; end if;
      if k = 'dcc_target' and not ((v ->> 'A')::int between 1 and 31 and (v ->> 'B')::int between 1 and 31 and (v ->> 'C')::int between 1 and 31) then
        raise exception 'Counts per month must be 1-31'; end if;
      insert into public.settings (key, value) values (k, v) on conflict (key) do update set value = excluded.value, updated_at = now();
    else
      raise exception 'Unknown setting %', k;
    end if;
  end loop;
end $$;

------------------------------------------------------------------ grants
revoke execute on function private.today(), private.workdays(public.branches, date, date), private.ensure_abc(text, date, uuid),
  private.log_take(uuid), private.plan_daily(text, date), private.roll_daily(), private.take_for(text), private.tok_sup(text, text),
  private.need_sup(text, text), private.dcc_stats(date, date, boolean) from public, anon, authenticated;
revoke execute on function public.sup_login(text, text), public.sup_change_pin(text, text, text), public.admin_sup_pin(text, text),
  public.sup_day(text, text, date), public.sup_add_sku(text, text, text), public.sup_skip(text, text, text),
  public.admin_load_daily(text, date, jsonb), public.admin_dcc_branch(text, text, int[], time, time), public.admin_dcc_day(text, date),
  public.admin_abc(text, text, date), public.admin_dcc_stats(text, date, date), public.public_dcc(date, date) from public;
grant execute on function public.sup_login(text, text), public.sup_change_pin(text, text, text), public.admin_sup_pin(text, text),
  public.sup_day(text, text, date), public.sup_add_sku(text, text, text), public.sup_skip(text, text, text),
  public.admin_load_daily(text, date, jsonb), public.admin_dcc_branch(text, text, int[], time, time), public.admin_dcc_day(text, date),
  public.admin_abc(text, text, date), public.admin_dcc_stats(text, date, date), public.public_dcc(date, date) to anon, authenticated;
