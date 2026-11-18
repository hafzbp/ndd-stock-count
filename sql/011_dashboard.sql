-- 011: richer DCC dashboard.
--   * branches.region / branches.nom (national operation manager), set by HQ in Settings, used as dashboard filters
--   * admin_branch_meta:  read / set region + NOM per warehouse
--   * admin_dcc_today:    one row per warehouse for a day: status, window, MB52 used, start/submit time, duration,
--                         who counted, result per SKU (ok / within / over / not in system / not counted)
--   * admin_dcc_insights: counters (PIC) performance, ABC coverage per warehouse and class, result mix per warehouse,
--                         SKUs out of tolerance again and again
-- Server flags are OK / WITHIN / OVER / NOT IN SYSTEM / PENDING / NOT COUNTED (no percent sign).

alter table public.branches add column if not exists region text not null default '';
alter table public.branches add column if not exists nom text not null default '';

create or replace function public.admin_branch_meta(p_token text, p_branch text default null, p_region text default null, p_nom text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.need_admin(p_token);
  if p_branch is not null then
    update public.branches set region = btrim(coalesce(p_region, region)), nom = btrim(coalesce(p_nom, nom)) where name = p_branch;
    if not found then raise exception 'Unknown warehouse: %', p_branch; end if;
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('branch', name, 'region', region, 'nom', nom) order by sort, name)
                   from public.branches where active), '[]'::jsonb);
end $$;

-- Names on a count session: the people who counted together on that phone.
create or replace function private.sess_names(p_data jsonb)
returns setof text language sql immutable set search_path = '' as $$
  select distinct btrim(n) from jsonb_array_elements_text(
    case when jsonb_typeof(p_data -> 'names') = 'array' and jsonb_array_length(p_data -> 'names') > 0 then p_data -> 'names'
         else jsonb_build_array(coalesce(p_data ->> 'member', '')) end) n
  where btrim(n) <> ''
$$;

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
                  when not exists (select 1 from public.snapshots x join public.snap_stock k on k.snap_id = x.id
                                   where x.snap_date <= d and k.branch = b.name) then 'nostock'
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
                                                 or (sub at time zone 'Asia/Kuala_Lumpur')::time > b.count_to then 'late' else 'ontime' end
                when d < td then 'missed'
                when coalesce(started, false) then 'progress' else 'todo' end;
    out := out || jsonb_build_object('branch', b.name, 'region', b.region, 'nom', b.nom,
      'from', to_char(b.count_from, 'HH24:MI'), 'to', to_char(b.count_to, 'HH24:MI'), 'status', stt, 'skipReason', t.skip_reason,
      'listed', coalesce(array_length(t.skus, 1), 0), 'counted', coalesce(cnt, 0), 'startedAt', st0, 'submittedAt', sub,
      'minutes', case when sub is not null and st0 is not null then round(extract(epoch from sub - st0) / 60) end,
      'who', who, 'result', res, 'snapDate', sd);
  end loop;
  return jsonb_build_object('date', d, 'today', td, 'now', now(), 'rows', out,
    'snapshot', (select jsonb_build_object('date', snap_date, 'loadedAt', loaded_at) from public.snapshots where snap_date <= d order by snap_date desc limit 1));
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
  select t.id, v.branch, v.code, t.count_date, sum(v.v), sum(v.vv), max(v.sku_flag)
  from public.stock_takes t cross join lateral private.variance(t.id) v
  where t.kind = 'daily' and t.status = 'open' and t.count_date between p_from and p_to
    and exists (select 1 from public.count_sessions s where s.take_id = t.id and s.status = 'submitted')
    and v.sku_flag not in ('PENDING', 'NOT COUNTED')
  group by t.id, v.branch, v.code, t.count_date;

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

revoke all on function public.admin_branch_meta(text, text, text, text), public.admin_dcc_today(text, date),
  public.admin_dcc_insights(text, date, date) from public;
grant execute on function public.admin_branch_meta(text, text, text, text), public.admin_dcc_today(text, date),
  public.admin_dcc_insights(text, date, date) to anon, authenticated;
