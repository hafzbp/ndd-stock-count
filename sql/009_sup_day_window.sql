-- 009: the supervisor screen also gets the count window, working days and plant code (for its "what to do today" card).

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
    'monthlyOpen', (private.cur()).status = 'open',
    'window', (select jsonb_build_object('from', to_char(count_from, 'HH24:MI'), 'to', to_char(count_to, 'HH24:MI'), 'workDays', to_jsonb(work_days), 'plant', plants[1])
               from public.branches where name = p_branch));
end $$;
