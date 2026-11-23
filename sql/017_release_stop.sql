-- 017: daily counts are released by HQ's MB52 of the day (no more lists from old stock), HQ can stop / resume a
-- warehouse's daily count, delete one count, and stop & reset a monthly stock take. Late release moves the deadline.

-- a daily count HQ stopped for one warehouse and day (no list is made while this row exists)
create table if not exists public.daily_stop (branch text not null, day date not null, at timestamptz not null default now(), primary key (branch, day));
alter table public.daily_stop enable row level security;
-- deadline of a daily count when HQ released it late (window length counted from the release)
alter table public.stock_takes add column if not exists due_to time;

-- why a warehouse can't count today yet: 'stopped' (HQ stopped it), 'release' (HQ hasn't uploaded today's MB52), else null
create or replace function private.daily_wait(p_branch text, d date)
returns text language plpgsql stable set search_path = '' as $$
declare b public.branches; m public.stock_takes := private.cur();
begin
  if coalesce((private.setting('dcc_enabled') #>> '{}')::boolean, false) is not true then return null; end if;
  select * into b from public.branches where name = p_branch and active;
  if not found or not (extract(isodow from d)::int = any (b.work_days)) then return null; end if;
  if m.status = 'open' and exists (select 1 from private.scoped_sys(m.id) s where s.branch = p_branch) then return null; end if;
  if exists (select 1 from public.stock_takes where kind = 'daily' and branch = p_branch and count_date = d) then return null; end if;
  if exists (select 1 from public.daily_stop where branch = p_branch and day = d) then return 'stopped'; end if;
  if not exists (select 1 from public.snapshots where snap_date = d) then return 'release'; end if;
  return null;
end $$;


create or replace function private.plan_daily(p_branch text, d date)
returns public.stock_takes language plpgsql set search_path = '' as $$
declare b public.branches; t public.stock_takes; m public.stock_takes := private.cur(); sid uuid; rel timestamptz; due time; mon date := date_trunc('month', d)::date;
        w int; r int; quota int; tgt jsonb := coalesce(private.setting('dcc_target'), '{"A":4,"B":2,"C":1}'::jsonb);
        picks text[]; trig text[]; allc text[]; pl jsonb; mn int := coalesce((private.setting('dcc_min_skus') #>> '{}')::int, 10);
begin
  select * into t from public.stock_takes where kind = 'daily' and branch = p_branch and count_date = d;
  if found then return t; end if;
  if coalesce((private.setting('dcc_enabled') #>> '{}')::boolean, false) is not true then return null; end if;
  select * into b from public.branches where name = p_branch and active;
  if not found or not (extract(isodow from d)::int = any (b.work_days)) then return null; end if;
  if m.status = 'open' and exists (select 1 from private.scoped_sys(m.id) s where s.branch = p_branch) then return null; end if;
  if exists (select 1 from public.daily_stop where branch = p_branch and day = d) then return null; end if;
  -- released only by HQ's MB52 of that very day
  select id, loaded_at into sid, rel from public.snapshots where snap_date = d;
  if sid is null then return null; end if;
  -- released after the window opened: the warehouse still gets the full window length, from the release
  if (rel at time zone 'Asia/Kuala_Lumpur')::date = d and (rel at time zone 'Asia/Kuala_Lumpur')::time > b.count_from then
    due := least(time '23:59', greatest(b.count_to, (rel at time zone 'Asia/Kuala_Lumpur')::time + (b.count_to - b.count_from)));
    if due = b.count_to then due := null; end if;
  end if;
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

  insert into public.stock_takes (name, kind, branch, count_date, scope, skus, mode, status, opened_at, snap_id, plan, due_to)
  values ('Daily ' || to_char(d, 'DD Mon YYYY'), 'daily', p_branch, d, 'partial', allc, 'single', 'open', now(), sid, pl, due)
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

create or replace function private.take_json(t public.stock_takes)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', t.id, 'name', t.name, 'status', t.status, 'closed', t.status = 'closed',
    'scope', t.scope, 'mode', t.mode, 'skuCount', coalesce(array_length(t.skus, 1), 0), 'resetId', t.reset_id,
    'startedAt', t.started_at, 'openedAt', t.opened_at, 'closedAt', t.closed_at,
    'kind', t.kind, 'branch', t.branch, 'countDate', t.count_date, 'skipReason', t.skip_reason, 'stockType', t.stock_type, 'kpiMonth', t.kpi_month,
    'countTo', case when t.kind = 'daily' then coalesce(to_char(t.due_to, 'HH24:MI'), (select to_char(b.count_to, 'HH24:MI') from public.branches b where b.name = t.branch)) end)
$$;

create or replace function private.dcc_stats(p_from date, p_to date, with_rm boolean)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare res jsonb; td date := private.today(); mon date := date_trunc('month', p_to)::date;
begin
  perform private.roll_daily();
  create temp table if not exists _lg (branch text, code text, count_date date, var_q numeric, var_rm numeric, flag text) on commit drop;
  delete from pg_temp._lg where true;  -- Supabase blocks DELETE without WHERE from the API
  insert into pg_temp._lg select branch, code, count_date, var_q, var_rm, flag from public.count_log where kind = 'daily' and count_date between p_from and p_to;
  -- today's open counts that are already submitted count too
  insert into pg_temp._lg
  select v.branch, v.code, t.count_date, v.var_q, v.var_rm, v.flag
  from public.stock_takes t cross join lateral private.sku_var(t.id) v
  where t.kind = 'daily' and t.status = 'open' and t.count_date between p_from and p_to
    and exists (select 1 from public.count_sessions s where s.take_id = t.id and s.status = 'submitted');

  with days as (select g::date as d from generate_series(p_from, p_to, interval '1 day') g),
  br as (select * from public.branches where active),
  cell as (
    select br.name as branch, days.d,
      case
        when t.id is not null and t.skip_reason is not null then 'skip'
        when t.id is not null and sub.s is not null then case when (sub.s at time zone 'Asia/Kuala_Lumpur')::date > days.d or (sub.s at time zone 'Asia/Kuala_Lumpur')::time > coalesce(t.due_to, br.count_to) then 'late' else 'ontime' end
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

create or replace function public.admin_dcc_report(p_token text, p_from date, p_to date, p_branch text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare res jsonb;
begin
  perform private.need_admin(p_token);
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Pick a valid period'; end if;
  if p_to - p_from > 62 then raise exception 'Pick a period of at most 2 months'; end if;
  perform private.roll_daily();
  select jsonb_build_object('from', p_from, 'to', p_to, 'tolerance', private.setting('tolerance'),
           'takes', coalesce(jsonb_agg(x.j order by x.d, x.sort, x.branch), '[]'::jsonb))
    into res
  from (
    select t.count_date as d, b.sort, b.name as branch, jsonb_build_object(
      'id', t.id, 'branch', b.name, 'region', b.region, 'nom', b.nom, 'date', t.count_date, 'takeStatus', t.status,
      'skipReason', t.skip_reason, 'from', to_char(b.count_from, 'HH24:MI'), 'to', to_char(coalesce(t.due_to, b.count_to), 'HH24:MI'),
      'plan', coalesce(t.plan, '{}'::jsonb), 'listed', coalesce(array_length(t.skus, 1), 0),
      'snapDate', (select snap_date from public.snapshots where id = t.snap_id),
      'startedAt', ss.st0, 'submittedAt', ss.sub,
      'late', case when ss.sub is not null then (ss.sub at time zone 'Asia/Kuala_Lumpur')::date > t.count_date
                                               or (ss.sub at time zone 'Asia/Kuala_Lumpur')::time > coalesce(t.due_to, b.count_to) end,
      'who', (select string_agg(distinct n, ', ') from public.count_sessions s2 cross join lateral private.sess_names(s2.data) n
              where s2.take_id = t.id and private.has_qty(s2.data)),
      'photos', (select count(*) from public.session_photos p join public.count_sessions s3 on s3.id = p.session_id where s3.take_id = t.id),
      'lines', (select coalesce(jsonb_agg(jsonb_build_object('code', v.code, 'desc', (select k.descr from public.skus k where k.code = v.code),
                  'batch', v.batch, 'sys', v.sys, 'cost', v.cost, 'phys', v.phys, 'status', v.status, 'v', v.v, 'vv', v.vv,
                  'flag', v.sku_flag, 'pct', v.sku_pct) order by v.code, v.batch), '[]'::jsonb)
                from private.variance(t.id) v where v.branch = b.name)
    ) as j
    from public.stock_takes t join public.branches b on b.name = t.branch
    cross join lateral (select min(s.started_at) filter (where private.has_qty(s.data)) as st0,
                               min(s.submitted_at) filter (where s.status = 'submitted') as sub
                        from public.count_sessions s where s.take_id = t.id) ss
    where t.kind = 'daily' and t.count_date between p_from and p_to and (p_branch is null or t.branch = p_branch)
  ) x;
  return res;
end $$;

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
                  when exists (select 1 from public.daily_stop x where x.branch = b.name and x.day = d) then 'stopped'
                  when not exists (select 1 from public.snapshots x where x.snap_date = d) then case when d = private.today() then 'waiting' else 'norelease' end
                  when not exists (select 1 from public.snapshots x join public.snap_stock k on k.snap_id = x.id where x.snap_date = d and k.branch = b.name) then 'nostock'
                  else 'nothing' end;
    end if;
    select min(s.submitted_at) filter (where s.status = 'submitted'), bool_or(private.has_qty(s.data))
      into sub, started from public.count_sessions s where s.take_id = t.id;
    select count(distinct e.value ->> 'code') into cnt from public.count_sessions s cross join lateral jsonb_each(coalesce(s.data -> 'lines', '{}'::jsonb)) e
      where s.take_id = t.id and private.line_has_qty(e.value);
    out := out || jsonb_build_object('branch', b.name, 'workDays', to_jsonb(b.work_days), 'from', to_char(b.count_from, 'HH24:MI'), 'to', to_char(coalesce(t.due_to, b.count_to), 'HH24:MI'),
      'take', case when t.id is null then null else private.take_json(t) || jsonb_build_object('plan', t.plan) end,
      'why', why, 'submittedAt', sub, 'started', coalesce(started, false), 'counted', coalesce(cnt, 0),
      'late', sub is not null and ((sub at time zone 'Asia/Kuala_Lumpur')::date > d or (sub at time zone 'Asia/Kuala_Lumpur')::time > coalesce(t.due_to, b.count_to)));
  end loop;
  return jsonb_build_object('date', d, 'today', private.today(), 'rows', out,
    'snapshot', (select jsonb_build_object('date', snap_date, 'loadedAt', loaded_at) from public.snapshots order by snap_date desc limit 1));
end $$;

create or replace function public.admin_dcc_today(p_token text, p_date date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare d date := coalesce(p_date, private.today()); td date := private.today(); b public.branches; t public.stock_takes;
        m public.stock_takes := private.cur(); out jsonb := '[]'::jsonb; why text; sub timestamptz; st0 timestamptz;
        started boolean; cnt int; who text; res jsonb; sd date; stt text;
begin
  perform private.need_admin(p_token);
  perform private.roll_daily();
  for b in select * from public.branches where active order by sort, name loop
    t := null; why := null; res := null; sd := null;
    if d = td then t := private.plan_daily(b.name, d);
    else select * into t from public.stock_takes where kind = 'daily' and branch = b.name and count_date = d; end if;
    if t.id is null then
      why := case when not (extract(isodow from d)::int = any (b.work_days)) then 'off'
                  when m.status = 'open' and exists (select 1 from private.scoped_sys(m.id) s where s.branch = b.name) then 'monthly'
                  when exists (select 1 from public.daily_stop x where x.branch = b.name and x.day = d) then 'stopped'
                  when not exists (select 1 from public.snapshots x where x.snap_date = d) then case when d = private.today() then 'waiting' else 'norelease' end
                  when not exists (select 1 from public.snapshots x join public.snap_stock k on k.snap_id = x.id
                                   where x.snap_date = d and k.branch = b.name) then 'nostock'
                  else 'nothing' end;
    end if;
    select min(s.submitted_at) filter (where s.status = 'submitted'), bool_or(private.has_qty(s.data)),
           min(s.started_at) filter (where private.has_qty(s.data))
      into sub, started, st0 from public.count_sessions s where s.take_id = t.id;
    select count(distinct e.value ->> 'code') into cnt from public.count_sessions s
      cross join lateral jsonb_each(coalesce(s.data -> 'lines', '{}'::jsonb)) e
      where s.take_id = t.id and private.line_has_qty(e.value);
    select string_agg(distinct n, ', ') into who from public.count_sessions s cross join lateral private.sess_names(s.data) n
      where s.take_id = t.id and private.has_qty(s.data);
    if sub is not null then
      select jsonb_build_object('ok', count(*) filter (where f = 'OK'), 'within', count(*) filter (where f = 'WITHIN'),
                                'over', count(*) filter (where f = 'OVER'), 'nis', count(*) filter (where f = 'NOT IN SYSTEM'),
                                'notCounted', count(*) filter (where f in ('NOT COUNTED', 'PENDING')))
        into res from (select v.code, max(v.sku_flag) as f from private.variance(t.id) v where v.branch = b.name group by v.code) x;
    end if;
    if t.snap_id is not null then select snap_date into sd from public.snapshots where id = t.snap_id; end if;
    stt := case when t.id is null then coalesce(why, 'nothing')
                when t.skip_reason is not null then 'skip'
                when sub is not null then case when (sub at time zone 'Asia/Kuala_Lumpur')::date > d
                                                 or (sub at time zone 'Asia/Kuala_Lumpur')::time > coalesce(t.due_to, b.count_to) then 'late' else 'ontime' end
                when d < td then 'missed'
                when coalesce(started, false) then 'progress' else 'todo' end;
    out := out || jsonb_build_object('branch', b.name, 'region', b.region, 'nom', b.nom,
      'from', to_char(b.count_from, 'HH24:MI'), 'to', to_char(coalesce(t.due_to, b.count_to), 'HH24:MI'), 'status', stt, 'skipReason', t.skip_reason,
      'listed', coalesce(array_length(t.skus, 1), 0), 'counted', coalesce(cnt, 0), 'startedAt', st0, 'submittedAt', sub,
      'minutes', case when sub is not null and st0 is not null then round(extract(epoch from sub - st0) / 60) end,
      'who', who, 'result', res, 'snapDate', sd);
  end loop;
  return jsonb_build_object('date', d, 'today', td, 'now', now(), 'rows', out,
    'snapshot', (select jsonb_build_object('date', snap_date, 'loadedAt', loaded_at) from public.snapshots where snap_date <= d order by snap_date desc limit 1));
end $$;

create or replace function public.admin_load_daily(p_token text, p_date date, p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare sid uuid; b text; pl jsonb; n int := 0; t public.stock_takes;
begin
  perform private.need_admin(p_token);
  if p_date is null or p_date <> private.today() then raise exception 'Daily stock must be today''s MB52 (stock date %). It releases today''s daily counts.', to_char(private.today(), 'DD Mon YYYY'); end if;
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
  -- bad stock (BS00, BS01, SH00) is kept apart: daily lists, ABC and good-stock counts never use it
  for b in select jsonb_object_keys(coalesce(p_payload -> 'byBrBad', '{}'::jsonb)) loop
    insert into public.snap_stock (snap_id, branch, code, batch, qty, unit_cost, sloc, stype)
    select sid, b, r ->> 0, coalesce(r ->> 1, ''), (r ->> 2)::numeric, nullif(r ->> 3, '')::numeric, r ->> 4, 'bad'
    from jsonb_array_elements(p_payload -> 'byBrBad' -> b) r;
  end loop;
  for b, pl in select key, value from jsonb_each(coalesce(p_payload -> 'plants', '{}'::jsonb)) loop
    update public.branches set plants = array(select distinct x from unnest(plants || array(select jsonb_array_elements_text(pl))) x where x <> '')
      where name = b;
  end loop;
  insert into public.skus (code, descr)
  select d.key, d.value #>> '{}' from jsonb_each(coalesce(p_payload -> 'descs', '{}'::jsonb)) d
  on conflict (code) do update set descr = case when public.skus.descr = '' then excluded.descr else public.skus.descr end;
  insert into public.skus (code, descr) select distinct code, '' from public.snap_stock where snap_id = sid on conflict (code) do nothing;
  -- ABC of this month is redone from the newest upload until the warehouse's first count of the month is logged
  -- (so a wrong first file doesn't fix the classes for the whole month)
  delete from public.sku_class sc where sc.month = date_trunc('month', p_date)::date and not sc.override
    and sc.branch in (select jsonb_object_keys(p_payload -> 'byBr'))
    and not exists (select 1 from public.count_log l where l.branch = sc.branch and l.count_date >= date_trunc('month', p_date)::date);
  -- ...and rebuilt right away from this upload. Before 012 it was only rebuilt when the next daily list was planned,
  -- so a second upload on the same day left the ABC, the supervisor's plan and the dashboard empty until tomorrow.
  perform private.ensure_abc(x, date_trunc('month', p_date)::date, sid) from jsonb_object_keys(p_payload -> 'byBr') x;
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
    'take', private.take_json(private.take_for(b.name)), 'wait', private.daily_wait(b.name, private.today()));
end $$;

create or replace function public.counter_branch(p_token text, p_branch text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare t public.stock_takes;
begin
  perform private.need_branch(p_token, p_branch);
  t := private.take_for(p_branch);
  return jsonb_build_object(
    'branch', p_branch, 'take', private.take_json(t), 'wait', private.daily_wait(p_branch, private.today()),
    'codes', case when t.kind = 'daily' then to_jsonb(t.skus)
             else coalesce((select jsonb_agg(distinct code) from private.scoped_sys(t.id) where branch = p_branch), '[]'::jsonb) end,
    'batches', coalesce((select jsonb_object_agg(code, bs) from (
        select code, jsonb_agg(distinct private.month_of(batch)) as bs
        from private.scoped_sys(t.id) where branch = p_branch group by code) x), '{}'::jsonb),
    'recount', coalesce((select to_jsonb(items) from public.recount where take_id = t.id and branch = p_branch), '[]'::jsonb));
end $$;

create or replace function public.sup_day(p_token text, p_branch text, p_date date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare d date := coalesce(p_date, private.today()); t public.stock_takes;
begin
  perform private.need_sup(p_token, p_branch);
  perform private.roll_daily();
  if d = private.today() then t := private.plan_daily(p_branch, d);
  else select * into t from public.stock_takes where kind = 'daily' and branch = p_branch and count_date = d; end if;
  return jsonb_build_object(
    'date', d, 'today', private.today(), 'branch', p_branch, 'wait', case when d = private.today() then private.daily_wait(p_branch, d) end,
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
    'monthlyOpen', (private.cur()).status = 'open',
    'window', (select jsonb_build_object('from', to_char(count_from, 'HH24:MI'), 'to', to_char(count_to, 'HH24:MI'), 'workDays', to_jsonb(work_days), 'plant', plants[1])
               from public.branches where name = p_branch));
end $$;

create or replace function public.admin_set_status(p_token text, p_status text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare t public.stock_takes := private.cur(); bad text;
begin
  perform private.need_admin(p_token);
  if p_status = 'open' then
    if not exists (select 1 from private.scoped_sys(t.id)) then
      raise exception 'Upload the MB52 first%', case when t.scope = 'partial' then ' (and check the picked SKUs are in it)' else '' end;
    end if;
    if t.scope = 'partial' and coalesce(array_length(t.skus, 1), 0) = 0 then raise exception 'Pick at least one SKU'; end if;
    -- one count per warehouse per day: a warehouse that is counting today's daily list must be stopped first
    select string_agg(distinct d.branch, ', ') into bad from public.stock_takes d
      where d.kind = 'daily' and d.count_date = private.today()
        and d.branch in (select distinct s.branch from private.scoped_sys(t.id) s)
        and exists (select 1 from public.count_sessions s where s.take_id = d.id);
    if bad is not null then raise exception '% started today''s daily count. Stop it first (Daily → the warehouse → Stop count), then open the stock take.', bad; end if;
    delete from public.sys_stock where take_id in (select d.id from public.stock_takes d where d.kind = 'daily' and d.count_date = private.today()
      and d.branch in (select distinct s.branch from private.scoped_sys(t.id) s));
    delete from public.stock_takes d where d.kind = 'daily' and d.count_date = private.today()
      and d.branch in (select distinct s.branch from private.scoped_sys(t.id) s);
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

-- HQ: delete one count (in progress or submitted) so the team can start again. Returns photo paths to remove.
create or replace function public.admin_delete_session(p_token text, p_session uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare s public.count_sessions; t public.stock_takes; paths jsonb;
begin
  perform private.need_admin(p_token);
  select * into s from public.count_sessions where id = p_session;
  if not found then raise exception 'This count is already gone'; end if;
  select * into t from public.stock_takes where id = s.take_id;
  if t.kind = 'daily' and t.count_date <> private.today() then raise exception 'Only today''s daily counts can be deleted'; end if;
  if t.kind = 'monthly' and t.status = 'closed' then raise exception 'Reopen counting first - a closed stock take is kept as it is'; end if;
  select coalesce(jsonb_agg(p.path), '[]'::jsonb) into paths from public.session_photos p where p.session_id = s.id;
  delete from public.session_photos where session_id = s.id;
  delete from public.count_sessions where id = s.id;
  if t.kind = 'daily' then delete from public.count_log where take_id = t.id; end if;
  return jsonb_build_object('ok', true, 'paths', paths, 'branch', s.branch);
end $$;

-- HQ: stop (p_stop true) or resume today's daily count of one warehouse. Stopping removes the list and every count on it;
-- the day then doesn't count in KPI001. Resume makes a fresh list.
create or replace function public.admin_stop_daily(p_token text, p_branch text, p_stop boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare d date := private.today(); paths jsonb := '[]'::jsonb; tid uuid;
begin
  perform private.need_admin(p_token);
  if not exists (select 1 from public.branches where name = p_branch) then raise exception 'Unknown warehouse'; end if;
  if p_stop then
    select id into tid from public.stock_takes where kind = 'daily' and branch = p_branch and count_date = d;
    if tid is not null then
      select coalesce(jsonb_agg(p.path), '[]'::jsonb) into paths from public.session_photos p join public.count_sessions s on s.id = p.session_id where s.take_id = tid;
      delete from public.session_photos where session_id in (select id from public.count_sessions where take_id = tid);
      delete from public.count_sessions where take_id = tid;
      delete from public.count_log where take_id = tid;
      delete from public.recount where take_id = tid;
      delete from public.sys_stock where take_id = tid;
      delete from public.stock_takes where id = tid;
    end if;
    insert into public.daily_stop (branch, day) values (p_branch, d) on conflict (branch, day) do update set at = now();
  else
    delete from public.daily_stop where branch = p_branch and day = d;
  end if;
  return jsonb_build_object('ok', true, 'paths', paths);
end $$;

-- HQ: stop the open monthly stock take and delete every count in it; it goes back to Draft (MB52 and SKUs stay).
-- p_confirm must be the stock take's name.
create or replace function public.admin_reset_take(p_token text, p_confirm text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare t public.stock_takes := private.cur(); paths jsonb; n int;
begin
  perform private.need_admin(p_token);
  if t.id is null or t.kind <> 'monthly' then raise exception 'No stock take to reset'; end if;
  if t.status = 'closed' then raise exception 'This stock take is closed and kept as history'; end if;
  if btrim(coalesce(p_confirm, '')) <> btrim(t.name) then raise exception 'Type the stock take name exactly to confirm'; end if;
  select coalesce(jsonb_agg(p.path), '[]'::jsonb) into paths from public.session_photos p join public.count_sessions s on s.id = p.session_id where s.take_id = t.id;
  delete from public.session_photos where session_id in (select id from public.count_sessions where take_id = t.id);
  delete from public.count_sessions where take_id = t.id;
  get diagnostics n = row_count;
  delete from public.recount where take_id = t.id;
  delete from public.count_log where take_id = t.id;
  update public.stock_takes set status = 'draft', closed = false, opened_at = null, closed_at = null,
    reset_id = encode(extensions.gen_random_bytes(6), 'hex') where id = t.id returning * into t;
  return jsonb_build_object('ok', true, 'sessions', n, 'paths', paths, 'take', private.take_json(t));
end $$;

revoke all on function public.admin_delete_session(text, uuid), public.admin_stop_daily(text, text, boolean), public.admin_reset_take(text, text), private.daily_wait(text, date) from public;
grant execute on function public.admin_delete_session(text, uuid), public.admin_stop_daily(text, text, boolean), public.admin_reset_take(text, text) to anon, authenticated;

