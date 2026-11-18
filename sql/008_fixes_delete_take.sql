-- 008: fixes after the first live run of the daily count.
-- 1. Supabase rejects DELETE without WHERE when it comes through the API (pg-safeupdate). plan_daily and dcc_stats
--    emptied their temp tables that way, which broke daily lists, counter login and the dashboard on live.
-- 2. The monthly ABC is redone from the newest stock upload until the warehouse's first count of the month.
-- 3. The owner can delete a closed monthly stock take (counts, results, photos).

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
  -- ABC of this month is redone from the newest upload until the warehouse's first count of the month is logged
  -- (so a wrong first file doesn't fix the classes for the whole month)
  delete from public.sku_class sc where sc.month = date_trunc('month', p_date)::date and not sc.override
    and sc.branch in (select jsonb_object_keys(p_payload -> 'byBr'))
    and not exists (select 1 from public.count_log l where l.branch = sc.branch and l.count_date >= date_trunc('month', p_date)::date);
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

-- Owner deletes a closed (or never opened) monthly stock take with everything that belongs to it.
-- Returns the photo file paths so the app can remove them from storage.
create or replace function public.owner_delete_take(p_token text, p_take uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare t public.stock_takes; paths jsonb; n int; nxt uuid;
begin
  perform private.need_owner(p_token);
  select * into t from public.stock_takes where id = p_take;
  if not found then raise exception 'Stock take not found'; end if;
  if t.kind <> 'monthly' then raise exception 'Only monthly stock takes can be deleted here'; end if;
  if t.status = 'open' then raise exception 'Close counting first - an open stock take can''t be deleted'; end if;
  select coalesce(jsonb_agg(p.path), '[]'::jsonb) into paths
    from public.session_photos p join public.count_sessions s on s.id = p.session_id where s.take_id = p_take;
  delete from public.session_photos where session_id in (select id from public.count_sessions where take_id = p_take);
  delete from public.count_sessions where take_id = p_take;
  get diagnostics n = row_count;
  delete from public.recount where take_id = p_take;
  delete from public.sys_stock where take_id = p_take;
  delete from public.mb52_meta where take_id = p_take;
  delete from public.count_log where take_id = p_take;
  delete from public.stock_takes where id = p_take;
  if private.cur_take() = p_take or private.cur_take() is null then
    select id into nxt from public.stock_takes where kind = 'monthly' order by started_at desc limit 1;
    if nxt is null then insert into public.stock_takes (name) values ('New stock take') returning id into nxt; end if;
    update public.settings set value = to_jsonb(nxt::text), updated_at = now() where key = 'current_take';
  end if;
  return jsonb_build_object('sessions', n, 'paths', paths, 'name', t.name);
end $$;

revoke execute on function public.owner_delete_take(text, uuid) from public;
grant execute on function public.owner_delete_take(text, uuid) to anon, authenticated;
