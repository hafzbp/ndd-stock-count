-- Stock take lifecycle (draft → open → closed), Total/Partial scope, login with plant code.

alter table public.stock_takes add column if not exists status text not null default 'draft' check (status in ('draft', 'open', 'closed'));
alter table public.stock_takes add column if not exists scope text not null default 'total' check (scope in ('total', 'partial'));
alter table public.stock_takes add column if not exists skus text[] not null default '{}';
alter table public.stock_takes add column if not exists opened_at timestamptz;
alter table public.stock_takes add column if not exists closed_at timestamptz;
update public.stock_takes set status = case when closed then 'closed' else 'draft' end;
alter table public.branches add column if not exists plants text[] not null default '{}';

------------------------------------------------------------------ helpers
create or replace function private.cur()
returns public.stock_takes language sql stable set search_path = '' as $$
  select * from public.stock_takes where id = private.cur_take()
$$;

create or replace function private.take_json(t public.stock_takes)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', t.id, 'name', t.name, 'status', t.status, 'closed', t.status = 'closed',
    'scope', t.scope, 'skuCount', coalesce(array_length(t.skus, 1), 0), 'resetId', t.reset_id,
    'startedAt', t.started_at, 'openedAt', t.opened_at, 'closedAt', t.closed_at)
$$;

-- system stock of a take, limited to the partial SKU list when the take is partial
create or replace function private.scoped_sys(p_take uuid)
returns setof public.sys_stock language sql stable set search_path = '' as $$
  select s.* from public.sys_stock s join public.stock_takes t on t.id = s.take_id
  where s.take_id = p_take and (t.scope = 'total' or s.code = any (t.skus))
$$;

------------------------------------------------------------------ variance: system side limited to scope
create or replace function private.variance(p_take uuid)
returns table (branch text, code text, batch text, sys numeric, cost numeric, ops_q numeric, fin_q numeric,
               status text, phys numeric, v numeric, vv numeric, sku_flag text, sku_pct numeric)
language sql stable set search_path = '' as $$
with sy as (
  select s.branch, s.code, private.month_of(s.batch) as batch, sum(s.qty) as sys, max(nullif(s.unit_cost, 0)) as cost
  from private.scoped_sys(p_take) s group by 1, 2, 3
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
    coalesce(j.cost, max(j.cost) over (partition by j.branch, j.code)) as cost2
  from j
), st as (
  select z.*,
    case when not co and not cf then 'NOT COUNTED'
         when (co and oq is null) or (cf and fq is null) then 'NEEDS PCS FACTOR'
         when not cf then 'WAITING FINANCE'
         when not co then 'WAITING OPS'
         when abs(oq - fq) < 1e-9 then 'MATCH' else 'RECOUNT' end as status
  from z
), g as (
  select st.*,
    sum(coalesce(st.sys, 0)) over w as g_sys,
    sum(case when st.status = 'MATCH' then st.oq else 0 end) over w as g_phys,
    bool_or(st.status = 'MATCH') over w as g_cnt,
    bool_or(st.status not in ('MATCH', 'NOT COUNTED')) over w as g_pend
  from st window w as (partition by st.branch, st.code)
)
select g.branch, g.code, g.batch, g.sys, g.cost2,
  case when g.co then g.oq end, case when g.cf then g.fq end, g.status,
  case when g.status = 'MATCH' then g.oq end,
  case when g.status = 'MATCH' then g.oq - coalesce(g.sys, 0) end,
  case when g.status = 'MATCH' and g.cost2 is not null then (g.oq - coalesce(g.sys, 0)) * g.cost2 end,
  case when g.g_pend then 'PENDING'
       when not g.g_cnt then 'NOT COUNTED'
       when g.g_sys = 0 then case when g.g_phys <> 0 then 'NOT IN SYSTEM' else 'OK' end
       when abs((g.g_phys - g.g_sys) / g.g_sys) <= coalesce((private.setting('tolerance') #>> '{}')::numeric, 2) / 100 + 1e-12
         then case when abs(g.g_phys - g.g_sys) < 1e-9 then 'OK' else 'WITHIN' end
       else 'OVER' end,
  case when not g.g_pend and g.g_cnt and g.g_sys <> 0 then (g.g_phys - g.g_sys) / g.g_sys end
from g
$$;

------------------------------------------------------------------ public
create or replace function public.public_config()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'title', private.setting('title'),
    'branches', coalesce((select jsonb_agg(b.name order by b.sort, b.name) from public.branches b where b.active), '[]'::jsonb),
    'take', (select private.take_json(t) from public.stock_takes t where t.id = private.cur_take()),
    'photoMin', private.setting('photo_min'), 'photoMax', private.setting('photo_max'),
    'photoRoles', private.setting('photo_roles'),
    'ownerReady', exists (select 1 from private.secrets where key = 'owner_hash'),
    'financeReady', exists (select 1 from private.secrets where key = 'finance_hash'))
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
    'scope', tk.scope, 'skuCount', coalesce(array_length(tk.skus, 1), 0),
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

-- Counter login with the branch's SAP plant code (from MB52).
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
    'take', (select private.take_json(t) from public.stock_takes t where t.id = private.cur_take()));
end $$;

------------------------------------------------------------------ counter (scope + status)
create or replace function public.counter_branch(p_token text, p_branch text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare tk uuid := private.cur_take();
begin
  perform private.need_branch(p_token, p_branch);
  return jsonb_build_object(
    'branch', p_branch,
    'codes', coalesce((select jsonb_agg(distinct code) from private.scoped_sys(tk) where branch = p_branch), '[]'::jsonb),
    'batches', coalesce((select jsonb_object_agg(code, bs) from (
        select code, jsonb_agg(distinct private.month_of(batch)) as bs
        from private.scoped_sys(tk) where branch = p_branch group by code) x), '{}'::jsonb),
    'recount', coalesce((select to_jsonb(items) from public.recount where take_id = tk and branch = p_branch), '[]'::jsonb));
end $$;

create or replace function public.counter_sync(p_tokens text[], p_device text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with tk as (select * from public.stock_takes where id = private.cur_take()),
  ok as (select t.kind, t.branch from public.tokens t where t.token = any (p_tokens) and t.expires_at > now())
  select jsonb_build_object(
    'take', (select private.take_json(tk) from tk),
    'sessions', coalesce((select jsonb_agg(private.session_json(s)) from public.count_sessions s, tk
        where s.take_id = tk.id and s.device_id = p_device
          and (exists (select 1 from ok where kind in ('owner', 'finance')) or s.branch in (select branch from ok))), '[]'::jsonb),
    'recount', coalesce((select jsonb_object_agg(r.branch, to_jsonb(r.items)) from public.recount r, tk
        where r.take_id = tk.id and (exists (select 1 from ok where kind in ('owner', 'finance')) or r.branch in (select branch from ok))), '{}'::jsonb))
$$;

create or replace function public.counter_start(p_token text, p_device text, p_branch text, p_role text, p_data jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare k text := private.need_branch(p_token, p_branch); tk public.stock_takes; s public.count_sessions;
begin
  tk := private.cur();
  if tk.status = 'draft' and k = 'branch' then raise exception 'NOT OPEN: Counting hasn''t started yet. Your admin will open it.'; end if;
  if tk.status = 'closed' and k = 'branch' then raise exception 'CLOSED: Counting is closed.'; end if;
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
  select t.status into st from public.stock_takes t where t.id = s.take_id;
  if s.status = 'submitted' or (st <> 'open' and k = 'branch') or s.take_id <> private.cur_take() then
    return jsonb_build_object('ok', false, 'session', private.session_json(s), 'closed', st <> 'open');
  end if;
  update public.count_sessions set data = p_data, updated_at = now() where id = p_id returning * into s;
  return jsonb_build_object('ok', true, 'session', private.session_json(s));
end $$;

create or replace function public.counter_submit(p_token text, p_device text, p_id uuid, p_data jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare s public.count_sessions; k text; n int; mn int; st text;
begin
  select * into s from public.count_sessions where id = p_id;
  if not found then raise exception 'GONE: this count was cleared by the owner.'; end if;
  k := private.need_branch(p_token, s.branch);
  if s.device_id <> p_device and k = 'branch' then raise exception 'Not your count'; end if;
  select t.status into st from public.stock_takes t where t.id = s.take_id;
  if st <> 'open' and k = 'branch' then raise exception 'CLOSED: Counting is closed.'; end if;
  if s.status = 'submitted' then return jsonb_build_object('ok', true, 'session', private.session_json(s)); end if;
  mn := coalesce((private.setting('photo_min') #>> '{}')::int, 0);
  select count(*) into n from public.session_photos where session_id = p_id;
  if private.setting('photo_roles') ? s.role and n < mn then
    raise exception 'PHOTOS: add at least % warehouse photo(s) before submitting (now %).', mn, n;
  end if;
  update public.count_sessions set data = p_data, status = 'submitted', submitted_at = now(), updated_at = now()
    where id = p_id returning * into s;
  return jsonb_build_object('ok', true, 'session', private.session_json(s));
end $$;

------------------------------------------------------------------ admin
create or replace function public.admin_load(p_token text, p_take uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare k text := private.need_admin(p_token); tk uuid := coalesce(p_take, private.cur_take());
begin
  return jsonb_build_object(
    'kind', k,
    'settings', (select jsonb_object_agg(key, value) from public.settings),
    'takes', (select jsonb_agg(private.take_json(t) order by t.started_at desc) from public.stock_takes t),
    'take', tk, 'current', private.cur_take(),
    'takeInfo', (select private.take_json(t) || jsonb_build_object('skus', to_jsonb(t.skus)) from public.stock_takes t where t.id = tk),
    'branches', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'pin', coalesce(pin, ''), 'plants', to_jsonb(plants), 'active', active) order by sort, name) from public.branches), '[]'::jsonb),
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
    'financeReady', exists (select 1 from private.secrets where key = 'finance_hash'));
end $$;

-- Create or edit the draft stock take. A new draft can only start when nothing is open.
create or replace function public.admin_draft(p_token text, p_name text, p_scope text, p_skus text[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare t public.stock_takes; nid uuid;
begin
  perform private.need_admin(p_token);
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the stock take a name'; end if;
  if p_scope not in ('total', 'partial') then raise exception 'Bad type'; end if;
  t := private.cur();
  if t.status = 'open' then raise exception 'OPEN: close the current stock take first.'; end if;
  if t.status = 'draft' then
    update public.stock_takes set name = trim(p_name), scope = p_scope, skus = coalesce(p_skus, '{}') where id = t.id returning * into t;
  else
    insert into public.stock_takes (name, scope, skus, status) values (trim(p_name), p_scope, coalesce(p_skus, '{}'), 'draft') returning * into t;
    update public.settings set value = to_jsonb(t.id::text), updated_at = now() where key = 'current_take';
  end if;
  return private.take_json(t);
end $$;

-- draft → open (needs MB52, and SKUs if partial); open → closed; closed → open (reopen).
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
  elsif p_status = 'closed' then
    if t.status <> 'open' then raise exception 'Only an open stock take can be closed'; end if;
    update public.stock_takes set status = 'closed', closed = true, closed_at = now() where id = t.id returning * into t;
  else
    raise exception 'Bad status';
  end if;
  return private.take_json(t);
end $$;

create or replace function public.admin_settings(p_token text, p_patch jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare k text; v jsonb;
begin
  perform private.need_admin(p_token);
  for k, v in select * from jsonb_each(p_patch) loop
    if k in ('title', 'tolerance', 'photo_min', 'photo_max', 'photo_roles', 'dash_level') or k like 'x_%' then
      if k = 'tolerance' and ((v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric > 100) then raise exception 'Tolerance must be 0-100'; end if;
      if k = 'dash_level' and (v #>> '{}') not in ('progress', 'qty', 'value') then raise exception 'Bad dashboard level'; end if;
      insert into public.settings (key, value) values (k, v) on conflict (key) do update set value = excluded.value, updated_at = now();
    else
      raise exception 'Unknown setting %', k;
    end if;
  end loop;
end $$;

-- MB52 also records each branch's plant code(s), used for counter login.
create or replace function public.admin_load_mb52(p_token text, p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare tk uuid := private.cur_take(); b text; n int := 0; pl jsonb;
begin
  perform private.need_admin(p_token);
  if (private.cur()).status = 'closed' then raise exception 'This stock take is closed. Start a new one first.'; end if;
  insert into public.mb52_meta (take_id, data, loaded_at) values (tk, coalesce(p_payload -> 'meta', '{}'::jsonb), now())
    on conflict (take_id) do update set data = excluded.data, loaded_at = now();
  for b in select jsonb_object_keys(p_payload -> 'byBr') loop
    delete from public.sys_stock where take_id = tk and branch = b;
    insert into public.sys_stock (take_id, branch, code, batch, qty, unit_cost, sloc)
    select tk, b, r ->> 0, coalesce(r ->> 1, ''), (r ->> 2)::numeric, nullif(r ->> 3, '')::numeric, r ->> 4
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
  insert into public.skus (code, descr)
  select distinct s.code, '' from public.sys_stock s where s.take_id = tk
  on conflict (code) do nothing;
  return jsonb_build_object('branches', n);
end $$;

revoke execute on function public.pin_login(text, text) from anon, authenticated;
revoke execute on function public.owner_new_take(text, text) from anon, authenticated;
grant execute on function public.plant_login(text), public.admin_draft(text, text, text, text[]), public.admin_set_status(text, text) to anon, authenticated;
revoke execute on function private.cur(), private.take_json(public.stock_takes), private.scoped_sys(uuid) from public, anon, authenticated;
