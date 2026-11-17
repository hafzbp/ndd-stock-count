-- Count mode per stock take: 'double' (Ops and Finance count separately and must match) or
-- 'single' (one team's count is the agreed count; if both teams count a line they must still match).

alter table public.stock_takes add column if not exists mode text not null default 'double' check (mode in ('double', 'single'));

create or replace function private.take_json(t public.stock_takes)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', t.id, 'name', t.name, 'status', t.status, 'closed', t.status = 'closed',
    'scope', t.scope, 'mode', t.mode, 'skuCount', coalesce(array_length(t.skus, 1), 0), 'resetId', t.reset_id,
    'startedAt', t.started_at, 'openedAt', t.opened_at, 'closedAt', t.closed_at)
$$;

create or replace function private.variance(p_take uuid)
returns table (branch text, code text, batch text, sys numeric, cost numeric, ops_q numeric, fin_q numeric,
               status text, phys numeric, v numeric, vv numeric, sku_flag text, sku_pct numeric)
language sql stable set search_path = '' as $$
with sy as (
  select s.branch, s.code, private.month_of(s.batch) as batch, sum(s.qty) as sys, max(nullif(s.unit_cost, 0)) as cost
  from private.scoped_sys(p_take) s group by 1, 2, 3
), md as (
  select coalesce((select mode = 'single' from public.stock_takes where id = p_take), false) as single
), cl as (
  select cs.branch, cs.role, e.value ->> 'code' as code, private.month_of(coalesce(e.value ->> 'batch', '')) as batch,
         sum(coalesce((e.value ->> 'ctn')::numeric, 0)) as ctn,
         sum(coalesce((e.value ->> 'box')::numeric, 0)) as box,
         sum(coalesce((e.value ->> 'pcs')::numeric, 0)) as pcs
  from public.count_sessions cs
  cross join lateral jsonb_each(coalesce(cs.data -> 'lines', '{}'::jsonb)) e
  where cs.take_id = p_take and private.line_has_qty(e.value)
  group by 1, 2, 3, 4
), pc as (
  select cl.*, case when (cl.ctn <> 0 and coalesce(k.per, 0) = 0) or (cl.box <> 0 and coalesce(k.per_box, 0) = 0) then null
                    else cl.pcs + cl.ctn * coalesce(k.per, 0) + cl.box * coalesce(k.per_box, 0) end as q
  from cl left join public.skus k on k.code = cl.code
), keys as (
  select sy.branch, sy.code, sy.batch from sy union select pc.branch, pc.code, pc.batch from pc
), j as (
  select k.branch, k.code, k.batch, sy.sys, sy.cost,
         o.code is not null as ops_has, o.q as ops_q0, f.code is not null as fin_has, f.q as fin_q0
  from keys k
  left join sy on sy.branch = k.branch and sy.code = k.code and sy.batch = k.batch
  left join pc o on o.role = 'ops' and o.branch = k.branch and o.code = k.code and o.batch = k.batch
  left join pc f on f.role = 'fin' and f.branch = k.branch and f.code = k.code and f.batch = k.batch
), z as (
  select j.*,
    case when not ops_has and fin_has and fin_q0 = 0 then true else ops_has end as co,
    case when not ops_has and fin_has and fin_q0 = 0 then 0 else ops_q0 end as oq,
    case when not fin_has and ops_has and ops_q0 = 0 then true else fin_has end as cf,
    case when not fin_has and ops_has and ops_q0 = 0 then 0 else fin_q0 end as fq,
    coalesce(j.cost, max(j.cost) over (partition by j.branch, j.code)) as cost2, md.single
  from j cross join md
), st as (
  select z.*,
    case when not co and not cf then 'NOT COUNTED'
         when (co and oq is null) or (cf and fq is null) then 'NEEDS PCS FACTOR'
         when single and not (co and cf) then 'MATCH'
         when not cf then 'WAITING FINANCE'
         when not co then 'WAITING OPS'
         when abs(oq - fq) < 1e-9 then 'MATCH' else 'RECOUNT' end as status,
    case when co then oq else fq end as aq
  from z
), g as (
  select st.*,
    sum(coalesce(st.sys, 0)) over w as g_sys,
    sum(case when st.status = 'MATCH' then st.aq else 0 end) over w as g_phys,
    bool_or(st.status = 'MATCH') over w as g_cnt,
    bool_or(st.status not in ('MATCH', 'NOT COUNTED')) over w as g_pend
  from st window w as (partition by st.branch, st.code)
)
select g.branch, g.code, g.batch, g.sys, g.cost2,
  case when g.co then g.oq end, case when g.cf then g.fq end, g.status,
  case when g.status = 'MATCH' then g.aq end,
  case when g.status = 'MATCH' then g.aq - coalesce(g.sys, 0) end,
  case when g.status = 'MATCH' and g.cost2 is not null then (g.aq - coalesce(g.sys, 0)) * g.cost2 end,
  case when g.g_pend then 'PENDING'
       when not g.g_cnt then 'NOT COUNTED'
       when g.g_sys = 0 then case when g.g_phys <> 0 then 'NOT IN SYSTEM' else 'OK' end
       when abs((g.g_phys - g.g_sys) / g.g_sys) <= coalesce((private.setting('tolerance') #>> '{}')::numeric, 2) / 100 + 1e-12
         then case when abs(g.g_phys - g.g_sys) < 1e-9 then 'OK' else 'WITHIN' end
       else 'OVER' end,
  case when not g.g_pend and g.g_cnt and g.g_sys <> 0 then (g.g_phys - g.g_sys) / g.g_sys end
from g
$$;

create or replace function public.public_dashboard()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  tk public.stock_takes;
  lvl text := coalesce(private.setting('dash_level') #>> '{}', 'progress');
  show_var boolean;
  res jsonb;
begin
  tk := private.cur();
  show_var := lvl in ('qty', 'value') and tk.status = 'closed';
  with br as (select name, sort from public.branches where active),
  ses as (select s.branch, s.role, s.status, s.updated_at, s.data from public.count_sessions s where s.take_id = tk.id),
  ss as (select * from private.scoped_sys(tk.id)),
  exp as (select ss.branch, count(distinct ss.code) as n from ss group by 1),
  done as (
    select s.branch, s.role, count(distinct e.value ->> 'code') as n
    from ses s cross join lateral jsonb_each(coalesce(s.data -> 'lines', '{}'::jsonb)) e
    where private.line_has_qty(e.value)
      and exists (select 1 from ss x where x.branch = s.branch and x.code = e.value ->> 'code')
    group by 1, 2),
  var as (select * from private.variance(tk.id) where show_var),
  vb as (
    select v.branch,
      count(*) filter (where v.status = 'MATCH') as l_match,
      count(*) filter (where v.status = 'RECOUNT') as l_recount,
      count(*) filter (where v.status like 'WAITING%' or v.status = 'NEEDS PCS FACTOR') as l_wait,
      count(distinct v.code) filter (where v.sku_flag = 'OVER') as sku_over,
      count(distinct v.code) filter (where v.sku_flag in ('OK', 'WITHIN')) as sku_ok,
      sum(v.sys) as sys_q, sum(v.phys) as phys_q, sum(v.v) as var_q, sum(v.vv) as var_rm,
      sum(coalesce(v.sys, 0) * coalesce(v.cost, 0)) as sys_rm
    from var v group by 1)
  select jsonb_build_object(
    'title', private.setting('title'), 'take', tk.name, 'status', tk.status, 'closed', tk.status = 'closed',
    'scope', tk.scope, 'mode', tk.mode, 'skuCount', coalesce(array_length(tk.skus, 1), 0),
    'level', lvl, 'showVariance', show_var, 'generatedAt', now(),
    'branches', coalesce(jsonb_agg(jsonb_build_object(
      'branch', br.name,
      'ops', case when not exists (select 1 from ses where ses.branch = br.name and role = 'ops') then 'not_started'
                  when (select bool_and(status = 'submitted') from ses where ses.branch = br.name and role = 'ops') then 'submitted' else 'counting' end,
      'fin', case when not exists (select 1 from ses where ses.branch = br.name and role = 'fin') then 'not_started'
                  when (select bool_and(status = 'submitted') from ses where ses.branch = br.name and role = 'fin') then 'submitted' else 'counting' end,
      'expected', coalesce(exp.n, 0),
      'opsDone', coalesce((select n from done where done.branch = br.name and role = 'ops'), 0),
      'finDone', coalesce((select n from done where done.branch = br.name and role = 'fin'), 0),
      'updatedAt', (select max(updated_at) from ses where ses.branch = br.name),
      'variance', case when show_var then jsonb_build_object(
          'match', coalesce(vb.l_match, 0), 'recount', coalesce(vb.l_recount, 0), 'waiting', coalesce(vb.l_wait, 0),
          'skuOver', coalesce(vb.sku_over, 0), 'skuOk', coalesce(vb.sku_ok, 0),
          'sysQ', vb.sys_q, 'physQ', vb.phys_q, 'varQ', vb.var_q,
          'varRM', case when lvl = 'value' then vb.var_rm end, 'sysRM', case when lvl = 'value' then vb.sys_rm end) end
    ) order by br.sort, br.name) filter (where exp.n > 0 or tk.status = 'draft' or exists (select 1 from ses where ses.branch = br.name)), '[]'::jsonb))
  into res
  from br left join exp on exp.branch = br.name left join vb on vb.branch = br.name
  group by ();
  return res;
end $$;

-- Set the count mode of the draft stock take (can't change once counting is open).
create or replace function public.admin_set_mode(p_token text, p_mode text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare t public.stock_takes;
begin
  perform private.need_admin(p_token);
  if p_mode not in ('double', 'single') then raise exception 'Bad count mode'; end if;
  t := private.cur();
  if t.status <> 'draft' then raise exception 'OPEN: the count mode can only be changed before counting opens.'; end if;
  update public.stock_takes set mode = p_mode where id = t.id returning * into t;
  return private.take_json(t);
end $$;

revoke execute on function public.admin_set_mode(text, text) from public;
grant execute on function public.admin_set_mode(text, text) to anon, authenticated;
