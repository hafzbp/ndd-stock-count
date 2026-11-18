-- 014: SKU variance = total counted minus total system, for every SKU that was counted.
-- Before, the daily log and the dashboard added up only the batches that were counted, so a batch the counter did not
-- find was left out: SKU A1 with 356 counted against 360 in the system showed +116 instead of -4, while its result
-- (WITHIN, from the totals) was right. The daily sign-off PDF and report use the same totals.
create or replace function private.sku_var(p_take uuid)
returns table (branch text, code text, sys_q numeric, phys_q numeric, var_q numeric, var_rm numeric, flag text)
language sql stable set search_path = '' as $$
  select v.branch, v.code, sum(coalesce(v.sys, 0)), sum(coalesce(v.phys, 0)),
         sum(coalesce(v.phys, 0)) - sum(coalesce(v.sys, 0)),
         sum((coalesce(v.phys, 0) - coalesce(v.sys, 0)) * v.cost),
         max(v.sku_flag)
  from private.variance(p_take) v
  where v.sku_flag not in ('PENDING', 'NOT COUNTED')
  group by v.branch, v.code
$$;

create or replace function private.log_take(p_take uuid)
returns void language plpgsql set search_path = '' as $$
declare t public.stock_takes;
begin
  select * into t from public.stock_takes where id = p_take;
  delete from public.count_log where take_id = p_take;
  insert into public.count_log (take_id, branch, code, count_date, kind, sys_q, phys_q, var_q, var_rm, flag)
  select p_take, v.branch, v.code,
         coalesce(t.count_date, (coalesce(t.closed_at, now()) at time zone 'Asia/Kuala_Lumpur')::date), t.kind,
         v.sys_q, v.phys_q, v.var_q, v.var_rm, v.flag
  from private.sku_var(p_take) v;
end $$;

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

create or replace function public.admin_dcc_insights(p_token text, p_from date, p_to date)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare mon date := date_trunc('month', p_to)::date; td date := private.today(); res jsonb;
begin
  perform private.need_admin(p_token);
  perform private.roll_daily();
  -- results per daily take: closed days from the log, today's submitted counts live
  create temp table if not exists _rs (take_id uuid, branch text, code text, count_date date, var_q numeric, var_rm numeric, flag text) on commit drop;
  delete from pg_temp._rs where true;  -- Supabase blocks DELETE without WHERE from the API
  insert into pg_temp._rs select take_id, branch, code, count_date, var_q, var_rm, flag from public.count_log
    where kind = 'daily' and count_date between p_from and p_to;
  insert into pg_temp._rs
  select t.id, v.branch, v.code, t.count_date, v.var_q, v.var_rm, v.flag
  from public.stock_takes t cross join lateral private.sku_var(t.id) v
  where t.kind = 'daily' and t.status = 'open' and t.count_date between p_from and p_to
    and exists (select 1 from public.count_sessions s where s.take_id = t.id and s.status = 'submitted');

  with ses as (
    select t.id as take_id, t.branch, s.started_at, s.submitted_at, s.data,
           (select count(distinct e.value ->> 'code') from jsonb_each(coalesce(s.data -> 'lines', '{}'::jsonb)) e where private.line_has_qty(e.value)) as skus
    from public.stock_takes t join public.count_sessions s on s.take_id = t.id
    where t.kind = 'daily' and t.count_date between p_from and p_to and s.status = 'submitted' and private.has_qty(s.data)),
  acc as (select take_id, count(*) as n, count(*) filter (where flag in ('OK', 'WITHIN')) as ok from pg_temp._rs group by take_id),
  per as (select n.n as name, ses.* from ses cross join lateral private.sess_names(ses.data) n(n)),
  cnt as (
    select per.name, string_agg(distinct per.branch, ', ') as branches, count(distinct per.take_id) as days, sum(per.skus) as skus,
           round(sum(greatest(extract(epoch from per.submitted_at - per.started_at), 0)) / 60) as minutes,
           sum(coalesce(acc.ok, 0)) as ok, sum(coalesce(acc.n, 0)) as n
    from per left join acc using (take_id) group by per.name),
  cls as (select branch, code, cls from public.sku_class where month = mon),
  tgt as (select (private.setting('dcc_target') ->> 'A')::int as a, (private.setting('dcc_target') ->> 'B')::int as b, (private.setting('dcc_target') ->> 'C')::int as c),
  times as (select l.branch, l.code, count(*) as n from public.count_log l where l.count_date >= mon and l.count_date <= p_to group by l.branch, l.code),
  times2 as (  -- today's submitted counts are not in the log yet
    select r.branch, r.code, count(*) as n from pg_temp._rs r
    where r.count_date >= mon and not exists (select 1 from public.count_log l where l.take_id = r.take_id and l.code = r.code) group by r.branch, r.code),
  abc as (
    select c.branch, c.cls, count(*) as skus,
           max(case c.cls when 'A' then tgt.a when 'B' then tgt.b else tgt.c end) as target,
           sum(coalesce(x.n, 0) + coalesce(y.n, 0)) as times,
           count(*) filter (where coalesce(x.n, 0) + coalesce(y.n, 0) > 0) as once
    from cls c cross join tgt left join times x on x.branch = c.branch and x.code = c.code left join times2 y on y.branch = c.branch and y.code = c.code
    group by c.branch, c.cls),
  pace as (select name as branch, case when private.workdays(b, mon, (mon + interval '1 month - 1 day')::date) > 0
             then round(private.workdays(b, mon, least(p_to, td))::numeric / private.workdays(b, mon, (mon + interval '1 month - 1 day')::date) * 100, 1) end as pace
           from public.branches b where active),
  mix as (select branch, count(*) filter (where flag = 'OK') as ok, count(*) filter (where flag = 'WITHIN') as within,
                 count(*) filter (where flag = 'OVER') as over, count(*) filter (where flag = 'NOT IN SYSTEM') as nis
          from pg_temp._rs group by branch),
  rep as (select branch, code, count(*) filter (where flag in ('OVER', 'NOT IN SYSTEM')) as times, sum(var_q) as net_q, sum(abs(coalesce(var_rm, 0))) as abs_rm,
                 max(count_date) filter (where flag in ('OVER', 'NOT IN SYSTEM')) as last
          from pg_temp._rs group by branch, code having count(*) filter (where flag in ('OVER', 'NOT IN SYSTEM')) >= 2)
  select jsonb_build_object('from', p_from, 'to', p_to, 'month', mon,
    'counters', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'branches', branches, 'days', days, 'skus', skus, 'minutes', minutes, 'ok', ok, 'n', n)
                          order by skus desc, name) from cnt), '[]'::jsonb),
    'abc', coalesce((select jsonb_agg(jsonb_build_object('branch', abc.branch, 'cls', abc.cls, 'skus', abc.skus, 'target', abc.target, 'times', abc.times, 'once', abc.once, 'pace', pace.pace)
                     order by abc.branch, abc.cls) from abc left join pace using (branch)), '[]'::jsonb),
    'mix', coalesce((select jsonb_agg(jsonb_build_object('branch', branch, 'ok', ok, 'within', within, 'over', over, 'nis', nis)) from mix), '[]'::jsonb),
    'repeat', coalesce((select jsonb_agg(jsonb_build_object('branch', r.branch, 'code', r.code, 'desc', (select descr from public.skus k where k.code = r.code),
                          'times', r.times, 'netQ', r.net_q, 'absRm', round(r.abs_rm, 2), 'last', r.last) order by r.times desc, r.abs_rm desc) from rep r), '[]'::jsonb)
  ) into res;
  return res;
end $$;

-- results already logged with the old rule are logged again
select private.log_take(id) from public.stock_takes where id in (select distinct take_id from public.count_log);
