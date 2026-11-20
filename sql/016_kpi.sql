-- 016: KPI dashboard.
--   KPI001 Daily Cycle Count = days passed / HKE. A day passes when the daily count is submitted the same day with at least
--   dcc_min_skus (10) SKUs counted. HKE = the warehouse's working days, less holidays, less days a monthly stock take was open
--   at the warehouse, less days without a daily list (no MB52 uploaded: HQ's side). A day the supervisor skipped fails.
--   KPI002 Stock Take = IRA by value from the month-end stock take (stock_takes.kpi_month): 1 - sum |SKU variance RM| / system RM.
insert into public.settings (key, value) values ('dcc_min_skus', '10'::jsonb) on conflict (key) do nothing;

create table if not exists public.holidays (
  id bigserial primary key,
  day date not null,
  name text not null default '',
  branches text[] not null default '{}',   -- empty = every warehouse (national holiday)
  created_at timestamptz not null default now()
);
alter table public.holidays enable row level security;
alter table public.stock_takes add column if not exists kpi_month date;

create or replace function private.plan_daily(p_branch text, d date)
returns public.stock_takes language plpgsql set search_path = '' as $$
declare b public.branches; t public.stock_takes; m public.stock_takes := private.cur(); sid uuid; mon date := date_trunc('month', d)::date;
        w int; r int; quota int; tgt jsonb := coalesce(private.setting('dcc_target'), '{"A":4,"B":2,"C":1}'::jsonb);
        picks text[]; trig text[]; allc text[]; pl jsonb; mn int := coalesce((private.setting('dcc_min_skus') #>> '{}')::int, 10);
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
  delete from pg_temp._due where true;  -- Supabase blocks DELETE without WHERE from the API
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
  -- KPI001 needs at least dcc_min_skus SKUs a day: top up with the next SKUs in the ABC queue (or every SKU if fewer)
  if coalesce(array_length(allc, 1), 0) < mn then
    allc := array(select distinct x from unnest(allc || coalesce((select array_agg(code) from (
      select code from pg_temp._due where not (code = any (allc)) order by (need > 0) desc, cls, since desc, val desc, code
      limit mn - coalesce(array_length(allc, 1), 0)) z), '{}')) x order by 1);
  end if;
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

create or replace function public.admin_settings(p_token text, p_patch jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare k text; v jsonb;
begin
  perform private.need_admin(p_token);
  for k, v in select * from jsonb_each(p_patch) loop
    if k in ('title', 'tolerance', 'photo_min', 'photo_max', 'photo_roles', 'dash_level', 'dcc_enabled', 'dcc_abc', 'dcc_target', 'dcc_min_skus') or k like 'x_%' then
      if k = 'tolerance' and ((v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric > 100) then raise exception 'Tolerance must be 0-100'; end if;
      if k = 'dash_level' and (v #>> '{}') not in ('progress', 'qty', 'value') then raise exception 'Bad dashboard level'; end if;
      if k = 'dcc_abc' and not ((v ->> 'a')::numeric > 0 and (v ->> 'a')::numeric < (v ->> 'b')::numeric and (v ->> 'b')::numeric < 100) then
        raise exception 'ABC: A must be below B, both between 0 and 100'; end if;
      if k = 'dcc_target' and not ((v ->> 'A')::int between 1 and 31 and (v ->> 'B')::int between 1 and 31 and (v ->> 'C')::int between 1 and 31) then
        raise exception 'Counts per month must be 1-31'; end if;
      if k = 'dcc_min_skus' and not ((v #>> '{}')::int between 1 and 50) then raise exception 'Minimum SKUs a day must be 1-50'; end if;
      insert into public.settings (key, value) values (k, v) on conflict (key) do update set value = excluded.value, updated_at = now();
    else
      raise exception 'Unknown setting %', k;
    end if;
  end loop;
end $$;

create or replace function public.admin_holidays(p_token text, p_add jsonb default null, p_delete bigint default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.need_admin(p_token);
  if p_delete is not null then delete from public.holidays where id = p_delete; end if;
  if p_add is not null then
    if (p_add ->> 'day') is null then raise exception 'Pick the date'; end if;
    insert into public.holidays (day, name, branches)
    values ((p_add ->> 'day')::date, btrim(coalesce(p_add ->> 'name', '')),
            coalesce(array(select jsonb_array_elements_text(coalesce(p_add -> 'branches', '[]'::jsonb))), '{}'));
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'day', day, 'name', name, 'branches', branches) order by day, name)
                   from public.holidays where day >= date_trunc('year', private.today()) - interval '1 year'), '[]'::jsonb);
end $$;

-- mark a monthly good-stock take as the month-end stock take of a month (null = not a KPI stock take)
create or replace function public.admin_set_kpi_month(p_token text, p_take uuid, p_month date)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare t public.stock_takes;
begin
  perform private.need_admin(p_token);
  select * into t from public.stock_takes where id = p_take;
  if not found or t.kind <> 'monthly' then raise exception 'Pick a monthly stock take'; end if;
  if p_month is not null and t.stock_type <> 'good' then raise exception 'Only a good-stock stock take counts for KPI002'; end if;
  update public.stock_takes set kpi_month = case when p_month is null then null else date_trunc('month', p_month)::date end
   where id = p_take returning * into t;
  return jsonb_build_object('id', t.id, 'kpiMonth', t.kpi_month);
end $$;

-- KPI001 cells of one warehouse for one month: st = pass / late / under / skip / missed / pending / future / off / holiday / monthly / nolist
create or replace function private.kpi1_cells(b public.branches, mon date)
returns table (d date, st text, skus int, sub timestamptz, why text)
language sql stable set search_path = '' as $$
  with days as (select g::date as d from generate_series(mon, (mon + interval '1 month - 1 day')::date, interval '1 day') g),
  mn as (select coalesce((private.setting('dcc_min_skus') #>> '{}')::int, 10) as v),
  td as (select private.today() as v),
  x as (
    select days.d, t.id as tid, t.skip_reason,
      (select min(s.submitted_at) from public.count_sessions s where s.take_id = t.id and s.status = 'submitted') as sub,
      (select count(distinct e.value ->> 'code') from public.count_sessions s cross join lateral jsonb_each(coalesce(s.data -> 'lines', '{}'::jsonb)) e
        where s.take_id = t.id and s.status = 'submitted' and private.line_has_qty(e.value))::int as skus,
      exists (select 1 from public.holidays h where h.day = days.d and (cardinality(h.branches) = 0 or b.name = any (h.branches))) as hol,
      (select h.name from public.holidays h where h.day = days.d and (cardinality(h.branches) = 0 or b.name = any (h.branches)) limit 1) as holname,
      exists (select 1 from public.stock_takes m where m.kind = 'monthly' and m.opened_at is not null
              and (m.opened_at at time zone 'Asia/Kuala_Lumpur')::date <= days.d
              and (coalesce(m.closed_at, now()) at time zone 'Asia/Kuala_Lumpur')::date >= days.d
              and exists (select 1 from public.sys_stock y where y.take_id = m.id and y.branch = b.name)) as mopen
    from days left join public.stock_takes t on t.kind = 'daily' and t.branch = b.name and t.count_date = days.d
  )
  select x.d,
    case when not (extract(isodow from x.d)::int = any (b.work_days)) then 'off'
         when x.hol then 'holiday'
         when x.tid is null and x.mopen then 'monthly'
         when x.d > (select v from td) then 'future'
         when x.tid is null and x.d = (select v from td) then 'pending'
         when x.tid is null then 'nolist'
         when x.skip_reason is not null then 'skip'
         when x.sub is null and x.d < (select v from td) then 'missed'
         when x.sub is null then 'pending'
         when (x.sub at time zone 'Asia/Kuala_Lumpur')::date > x.d then 'late'
         when x.skus < (select v from mn) then 'under'
         else 'pass' end,
    x.skus, x.sub, coalesce(x.skip_reason, x.holname)
  from x order by x.d
$$;

create or replace function private.kpi2(p_take uuid)
returns table (branch text, sys_rm numeric, abs_rm numeric, skus int)
language sql stable set search_path = '' as $$
  -- a SKU nobody counted (or Ops/Finance never agreed on) counts as not found: its whole system value is the variance
  select s.branch, s.sys_rm, coalesce(v.abs_rm, 0) + coalesce(s.miss_rm, 0), s.skus from
    (select l.branch, sum(coalesce(l.sys, 0) * coalesce(l.cost, 0)) as sys_rm, count(distinct l.code)::int as skus,
            sum(coalesce(l.sys, 0) * coalesce(l.cost, 0)) filter (where l.sku_flag in ('NOT COUNTED', 'PENDING')) as miss_rm
       from private.variance(p_take) l group by l.branch) s
  left join (select branch, sum(abs(coalesce(var_rm, 0))) as abs_rm from private.sku_var(p_take) group by branch) v using (branch)
$$;

-- full = admin (RM, top SKUs). Public view: no RM and no SKUs; the stock take IRA % only when the public dashboard level is "value".
create or replace function private.kpi_json(mon date, p_full boolean)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare res jsonb; tk public.stock_takes; trend jsonb := '[]'::jsonb; m date; t2 public.stock_takes; p int; h int;
        show2 boolean := p_full or coalesce(private.setting('dash_level') #>> '{}', 'progress') = 'value';
begin
  perform private.roll_daily();
  select * into tk from public.stock_takes where kind = 'monthly' and kpi_month = mon and status = 'closed' and stock_type = 'good' order by closed_at desc limit 1;
  for i in reverse 5..0 loop
    m := (mon - make_interval(months => i))::date;
    select count(*) filter (where c.st = 'pass'), count(*) filter (where c.st in ('pass', 'late', 'under', 'skip', 'missed'))
      into p, h from public.branches b cross join lateral private.kpi1_cells(b, m) c where b.active;
    t2 := null;
    select * into t2 from public.stock_takes where kind = 'monthly' and kpi_month = m and status = 'closed' and stock_type = 'good' order by closed_at desc limit 1;
    trend := trend || jsonb_build_object('month', m, 'pass', p, 'hke', h,
      'ira', case when show2 and t2.id is not null then (select case when sum(sys_rm) > 0 then round(1 - sum(abs_rm) / sum(sys_rm), 6) end from private.kpi2(t2.id)) end);
  end loop;
  select jsonb_build_object('month', mon, 'today', private.today(), 'minSkus', coalesce((private.setting('dcc_min_skus') #>> '{}')::int, 10), 'full', p_full, 'kpi2Hidden', not show2,
    'kpi2Ira', case when show2 and tk.id is not null then (select round(1 - sum(k.abs_rm) / nullif(sum(k.sys_rm), 0), 6) from private.kpi2(tk.id) k join public.branches b on b.name = k.branch and b.active) end,
    'kpi2Take', case when tk.id is not null and show2 then jsonb_build_object('id', case when p_full then tk.id end, 'name', tk.name, 'closedAt', tk.closed_at) end,
    'trend', trend,
    'branches', (select jsonb_agg(jsonb_build_object('branch', b.name, 'region', b.region, 'nom', b.nom,
        'cells', (select jsonb_agg(jsonb_build_object('d', c.d, 'st', c.st, 'skus', c.skus, 'sub', c.sub, 'why', c.why) order by c.d) from private.kpi1_cells(b, mon) c),
        'kpi2', case when show2 then (select jsonb_build_object('sysRm', case when p_full then round(k.sys_rm, 2) end, 'absRm', case when p_full then round(k.abs_rm, 2) end, 'skus', k.skus,
                   'ira', case when k.sys_rm > 0 then round(1 - k.abs_rm / k.sys_rm, 6) end) from private.kpi2(tk.id) k where k.branch = b.name) end,
        'top', case when not p_full then '[]'::jsonb else (select coalesce(jsonb_agg(jsonb_build_object('code', v.code, 'desc', (select descr from public.skus s where s.code = v.code), 'varQ', v.var_q, 'varRm', round(v.var_rm, 2)) order by abs(coalesce(v.var_rm, 0)) desc), '[]'::jsonb)
                from (select * from private.sku_var(tk.id) v where v.branch = b.name and coalesce(v.var_rm, 0) <> 0 order by abs(v.var_rm) desc limit 5) v) end
      ) order by b.sort, b.name) from public.branches b where b.active)
  ) into res;
  return res;
end $$;

create or replace function public.admin_kpi(p_token text, p_month date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.need_admin(p_token);
  return private.kpi_json(date_trunc('month', coalesce(p_month, private.today()))::date, true);
end $$;

-- public dashboard (no login): the last 6 months only
create or replace function public.public_kpi(p_month date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare mon date := date_trunc('month', coalesce(p_month, private.today()))::date;
begin
  if mon > date_trunc('month', private.today()) or mon < (date_trunc('month', private.today()) - interval '5 months') then raise exception 'Pick one of the last 6 months'; end if;
  return private.kpi_json(mon, false);
end $$;

revoke all on function public.admin_holidays(text, jsonb, bigint), public.admin_set_kpi_month(text, uuid, date), public.admin_kpi(text, date), public.public_kpi(date), private.kpi_json(date, boolean) from public;
grant execute on function public.admin_holidays(text, jsonb, bigint), public.admin_set_kpi_month(text, uuid, date), public.admin_kpi(text, date), public.public_kpi(date) to anon, authenticated;

create or replace function private.take_json(t public.stock_takes)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', t.id, 'name', t.name, 'status', t.status, 'closed', t.status = 'closed',
    'scope', t.scope, 'mode', t.mode, 'skuCount', coalesce(array_length(t.skus, 1), 0), 'resetId', t.reset_id,
    'startedAt', t.started_at, 'openedAt', t.opened_at, 'closedAt', t.closed_at,
    'kind', t.kind, 'branch', t.branch, 'countDate', t.count_date, 'skipReason', t.skip_reason, 'stockType', t.stock_type, 'kpiMonth', t.kpi_month,
    'countTo', case when t.kind = 'daily' then (select to_char(b.count_to, 'HH24:MI') from public.branches b where b.name = t.branch) end)
$$;
