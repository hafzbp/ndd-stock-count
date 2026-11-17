-- NDD Stock Count: server functions
-- private.*  = helpers, not reachable from the API
-- public.*   = the only doors the app uses. Each one checks its token.

------------------------------------------------------------------ helpers
create or replace function private.setting(p_key text)
returns jsonb language sql stable set search_path = '' as $$
  select value from public.settings where key = p_key
$$;

create or replace function private.cur_take()
returns uuid language sql stable set search_path = '' as $$
  select (value #>> '{}')::uuid from public.settings where key = 'current_take'
$$;

create or replace function private.month_of(p text)
returns text language sql immutable set search_path = '' as $$
  select case when coalesce(p, '') ~ '^\d{4}-\d{2}-\d{2}$' then left(p, 7) else coalesce(p, '') end
$$;

create or replace function private.line_has_qty(l jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(l -> 'ctn'), 'null') <> 'null'
      or coalesce(jsonb_typeof(l -> 'box'), 'null') <> 'null'
      or coalesce(jsonb_typeof(l -> 'pcs'), 'null') <> 'null'
$$;

create or replace function private.has_qty(p_data jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select exists (select 1 from jsonb_each(coalesce(p_data -> 'lines', '{}'::jsonb)) e where private.line_has_qty(e.value))
$$;

create or replace function private.new_token(p_kind text, p_branch text, p_days int)
returns text language plpgsql set search_path = '' as $$
declare t text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  delete from public.tokens where expires_at < now();
  insert into public.tokens (token, kind, branch, expires_at) values (t, p_kind, p_branch, now() + make_interval(days => p_days));
  return t;
end $$;

-- returns 'owner' | 'finance' | 'branch' or null
create or replace function private.tok_kind(p_token text, p_branch text default null)
returns text language sql stable set search_path = '' as $$
  select kind from public.tokens
  where token = p_token and expires_at > now()
    and (kind in ('owner', 'finance') or p_branch is null or branch = p_branch)
$$;

create or replace function private.need_admin(p_token text)
returns text language plpgsql stable set search_path = '' as $$
declare k text := private.tok_kind(p_token);
begin
  if k is null or k = 'branch' then raise exception 'AUTH: Finance login needed' using errcode = '28000'; end if;
  return k;
end $$;

create or replace function private.need_owner(p_token text)
returns void language plpgsql stable set search_path = '' as $$
begin
  if private.tok_kind(p_token) is distinct from 'owner' then raise exception 'AUTH: owner login needed' using errcode = '28000'; end if;
end $$;

create or replace function private.need_branch(p_token text, p_branch text)
returns text language plpgsql stable set search_path = '' as $$
declare k text := private.tok_kind(p_token, p_branch);
begin
  if k is null then raise exception 'AUTH: enter the branch PIN again' using errcode = '28000'; end if;
  return k;
end $$;

create or replace function private.too_many(p_key text)
returns void language plpgsql set search_path = '' as $$
begin
  if (select count(*) from public.login_attempts where key = p_key and not ok and at > now() - interval '15 minutes') >= 10 then
    raise exception 'LOCKED: too many wrong attempts. Wait 15 minutes.' using errcode = '28000';
  end if;
end $$;

create or replace function private.session_json(s public.count_sessions)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', s.id, 'branch', s.branch, 'role', s.role, 'device', s.device_id, 'data', s.data,
    'status', s.status, 'startedAt', s.started_at, 'updatedAt', s.updated_at, 'submittedAt', s.submitted_at,
    'reopenedAt', s.reopened_at,
    'photos', (select count(*) from public.session_photos p where p.session_id = s.id))
$$;

------------------------------------------------------------------ variance (used by the public dashboard)
-- Same rules as variance()/skuTolerance() in js/pure.js. Tested against each other in tests/.
create or replace function private.variance(p_take uuid)
returns table (branch text, code text, batch text, sys numeric, cost numeric, ops_q numeric, fin_q numeric,
               status text, phys numeric, v numeric, vv numeric, sku_flag text, sku_pct numeric)
language sql stable set search_path = '' as $$
with sy as (
  select s.branch, s.code, private.month_of(s.batch) as batch, sum(s.qty) as sys, max(nullif(s.unit_cost, 0)) as cost
  from public.sys_stock s where s.take_id = p_take group by 1, 2, 3
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
), z as (   -- a counted 0 on one side matches a blank on the other
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

------------------------------------------------------------------ public (no login)
create or replace function public.public_config()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'title', private.setting('title'),
    'branches', coalesce((select jsonb_agg(b.name order by b.sort, b.name) from public.branches b where b.active), '[]'::jsonb),
    'take', (select jsonb_build_object('id', t.id, 'name', t.name, 'closed', t.closed, 'resetId', t.reset_id)
             from public.stock_takes t where t.id = private.cur_take()),
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
  select * into tk from public.stock_takes where id = private.cur_take();
  show_var := lvl in ('qty', 'value') and tk.closed;
  with br as (select name, sort from public.branches where active),
  ses as (select s.branch, s.role, s.status, s.updated_at, private.has_qty(s.data) as hq, s.data from public.count_sessions s where s.take_id = tk.id),
  exp as (select ss.branch, count(distinct ss.code) as n from public.sys_stock ss where ss.take_id = tk.id group by 1),
  done as (
    select s.branch, s.role, count(distinct e.value ->> 'code') as n
    from ses s cross join lateral jsonb_each(coalesce(s.data -> 'lines', '{}'::jsonb)) e
    where private.line_has_qty(e.value)
      and exists (select 1 from public.sys_stock x where x.take_id = tk.id and x.branch = s.branch and x.code = e.value ->> 'code')
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
    'title', private.setting('title'), 'take', tk.name, 'closed', tk.closed, 'level', lvl, 'showVariance', show_var,
    'generatedAt', now(),
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
    ) order by br.sort, br.name), '[]'::jsonb))
  into res
  from br left join exp on exp.branch = br.name left join vb on vb.branch = br.name
  group by ();
  return res;
end $$;

------------------------------------------------------------------ logins
create or replace function public.pin_login(p_branch text, p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare b public.branches; k text := 'pin:' || coalesce(p_branch, '');
begin
  perform private.too_many(k);
  select * into b from public.branches where name = p_branch and active;
  if not found then raise exception 'Branch not found'; end if;
  if coalesce(b.pin, '') <> '' and b.pin is distinct from trim(coalesce(p_pin, '')) then
    insert into public.login_attempts (key, ok) values (k, false);
    return jsonb_build_object('ok', false);
  end if;
  insert into public.login_attempts (key, ok) values (k, true);
  return jsonb_build_object('ok', true, 'token', private.new_token('branch', p_branch, 30), 'branch', p_branch);
end $$;

create or replace function public.admin_login(p_password text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare oh text; fh text; pw text := coalesce(p_password, '');
begin
  perform private.too_many('admin');
  select value into oh from private.secrets where key = 'owner_hash';
  select value into fh from private.secrets where key = 'finance_hash';
  if pw <> '' and oh is not null and extensions.crypt(pw, oh) = oh then
    insert into public.login_attempts (key, ok) values ('admin', true);
    return jsonb_build_object('ok', true, 'kind', 'owner', 'token', private.new_token('owner', null, 14));
  elsif pw <> '' and fh is not null and extensions.crypt(pw, fh) = fh then
    insert into public.login_attempts (key, ok) values ('admin', true);
    return jsonb_build_object('ok', true, 'kind', 'finance', 'token', private.new_token('finance', null, 14));
  end if;
  insert into public.login_attempts (key, ok) values ('admin', false);
  return jsonb_build_object('ok', false);
end $$;

-- First-time owner password, using a one-time setup code.
create or replace function public.owner_bootstrap(p_code text, p_password text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare c private.secrets;
begin
  perform private.too_many('bootstrap');
  select * into c from private.secrets where key = 'bootstrap_code';
  if c.value is null or c.expires_at < now() or extensions.crypt(coalesce(p_code, ''), c.value) <> c.value then
    insert into public.login_attempts (key, ok) values ('bootstrap', false);
    return jsonb_build_object('ok', false);
  end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'Use at least 8 characters'; end if;
  insert into private.secrets (key, value) values ('owner_hash', extensions.crypt(p_password, extensions.gen_salt('bf')))
    on conflict (key) do update set value = excluded.value, updated_at = now();
  delete from private.secrets where key = 'bootstrap_code';
  return jsonb_build_object('ok', true, 'kind', 'owner', 'token', private.new_token('owner', null, 14));
end $$;

create or replace function public.logout(p_token text)
returns void language sql volatile security definer set search_path = '' as $$
  delete from public.tokens where token = p_token
$$;

create or replace function public.whoami(p_tokens text[])
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('token', t.token, 'kind', t.kind, 'branch', t.branch)), '[]'::jsonb)
  from public.tokens t where t.token = any (p_tokens) and t.expires_at > now()
$$;

------------------------------------------------------------------ counter
-- SKU list and barcode master. No quantities.
create or replace function public.counter_master(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if private.tok_kind(p_token) is null then raise exception 'AUTH: enter the branch PIN again' using errcode = '28000'; end if;
  return jsonb_build_object(
    'skus', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'desc', descr, 'per', per, 'perBox', per_box) order by code) from public.skus), '[]'::jsonb),
    'barcodes', coalesce((select jsonb_object_agg(barcode, jsonb_build_object('code', code, 'uom', uom)) from public.barcodes), '{}'::jsonb),
    'team', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'branch', branch, 'role', role) order by name) from public.team), '[]'::jsonb));
end $$;

-- Which SKUs / batch months the system has for a branch (no quantities) + the recount list.
create or replace function public.counter_branch(p_token text, p_branch text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare tk uuid := private.cur_take();
begin
  perform private.need_branch(p_token, p_branch);
  return jsonb_build_object(
    'branch', p_branch,
    'codes', coalesce((select jsonb_agg(distinct code) from public.sys_stock where take_id = tk and branch = p_branch), '[]'::jsonb),
    'batches', coalesce((select jsonb_object_agg(code, bs) from (
        select code, jsonb_agg(distinct private.month_of(batch)) filter (where batch <> '') as bs
        from public.sys_stock where take_id = tk and branch = p_branch group by code) x where bs is not null), '{}'::jsonb),
    'recount', coalesce((select to_jsonb(items) from public.recount where take_id = tk and branch = p_branch), '[]'::jsonb));
end $$;

-- Poll: this device's sessions in the branches its tokens open, plus stock take state.
create or replace function public.counter_sync(p_tokens text[], p_device text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with tk as (select * from public.stock_takes where id = private.cur_take()),
  ok as (select t.kind, t.branch from public.tokens t where t.token = any (p_tokens) and t.expires_at > now())
  select jsonb_build_object(
    'take', (select jsonb_build_object('id', id, 'name', name, 'closed', closed, 'resetId', reset_id) from tk),
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
  select * into tk from public.stock_takes where id = private.cur_take();
  if tk.closed and k = 'branch' then raise exception 'Counting is closed by Finance.'; end if;
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
declare s public.count_sessions; k text; closed boolean;
begin
  select * into s from public.count_sessions where id = p_id;
  if not found then raise exception 'GONE: this count was cleared by the owner.'; end if;
  k := private.need_branch(p_token, s.branch);
  if s.device_id <> p_device and k = 'branch' then raise exception 'Not your count'; end if;
  select t.closed into closed from public.stock_takes t where t.id = s.take_id;
  if s.status = 'submitted' or (closed and k = 'branch') or s.take_id <> private.cur_take() then
    return jsonb_build_object('ok', false, 'session', private.session_json(s), 'closed', closed);
  end if;
  update public.count_sessions set data = p_data, updated_at = now() where id = p_id returning * into s;
  return jsonb_build_object('ok', true, 'session', private.session_json(s));
end $$;

create or replace function public.counter_submit(p_token text, p_device text, p_id uuid, p_data jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare s public.count_sessions; k text; n int; mn int; closed boolean;
begin
  select * into s from public.count_sessions where id = p_id;
  if not found then raise exception 'GONE: this count was cleared by the owner.'; end if;
  k := private.need_branch(p_token, s.branch);
  if s.device_id <> p_device and k = 'branch' then raise exception 'Not your count'; end if;
  select t.closed into closed from public.stock_takes t where t.id = s.take_id;
  if closed and k = 'branch' then raise exception 'Counting is closed by Finance.'; end if;
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

------------------------------------------------------------------ admin (Finance password or owner)
create or replace function public.admin_load(p_token text, p_take uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare k text := private.need_admin(p_token); tk uuid := coalesce(p_take, private.cur_take());
begin
  return jsonb_build_object(
    'kind', k,
    'settings', (select jsonb_object_agg(key, value) from public.settings),
    'takes', (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'closed', closed, 'startedAt', started_at, 'resetId', reset_id) order by started_at desc) from public.stock_takes),
    'take', tk,
    'branches', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'pin', coalesce(pin, ''), 'active', active) order by sort, name) from public.branches), '[]'::jsonb),
    'team', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'branch', branch, 'role', role) order by branch, name) from public.team), '[]'::jsonb),
    'skus', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'desc', descr, 'per', per, 'perBox', per_box) order by code) from public.skus), '[]'::jsonb),
    'barcodeCount', (select count(*) from public.barcodes),
    'sessions', coalesce((select jsonb_agg(private.session_json(s) order by s.branch, s.role, s.started_at) from public.count_sessions s where s.take_id = tk), '[]'::jsonb),
    'sys', coalesce((select jsonb_object_agg(branch, rows) from (
        select branch, jsonb_agg(jsonb_build_array(code, batch, qty, coalesce(unit_cost, 0), coalesce(sloc, '')) order by code, batch) as rows
        from public.sys_stock where take_id = tk group by branch) x), '{}'::jsonb),
    'meta', (select data || jsonb_build_object('loadedAt', loaded_at) from public.mb52_meta where take_id = tk),
    'recount', coalesce((select jsonb_object_agg(branch, to_jsonb(items)) from public.recount where take_id = tk), '{}'::jsonb),
    'financeReady', exists (select 1 from private.secrets where key = 'finance_hash'));
end $$;

create or replace function public.admin_settings(p_token text, p_patch jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare k text; v jsonb;
begin
  perform private.need_admin(p_token);
  for k, v in select * from jsonb_each(p_patch) loop
    if k = 'closed' then
      update public.stock_takes set closed = (v #>> '{}')::boolean where id = private.cur_take();
    elsif k in ('title', 'tolerance', 'photo_min', 'photo_max', 'photo_roles', 'dash_level') or k like 'x_%' then
      if k = 'tolerance' and ((v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric > 100) then raise exception 'Tolerance must be 0-100'; end if;
      if k = 'dash_level' and (v #>> '{}') not in ('progress', 'qty', 'value') then raise exception 'Bad dashboard level'; end if;
      insert into public.settings (key, value) values (k, v) on conflict (key) do update set value = excluded.value, updated_at = now();
    else
      raise exception 'Unknown setting %', k;
    end if;
  end loop;
end $$;

create or replace function public.admin_reopen(p_token text, p_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.need_admin(p_token);
  update public.count_sessions set status = 'counting', reopened_at = now(), updated_at = now() where id = p_id;
end $$;

create or replace function public.admin_send_recount(p_token text, p_branch text, p_items text[])
returns int language plpgsql volatile security definer set search_path = '' as $$
declare n int := 0; tk uuid := private.cur_take();
begin
  perform private.need_admin(p_token);
  insert into public.recount (take_id, branch, items, sent_at) values (tk, p_branch, coalesce(p_items, '{}'), now())
    on conflict (take_id, branch) do update set items = excluded.items, sent_at = now();
  if coalesce(array_length(p_items, 1), 0) > 0 then
    update public.count_sessions set status = 'counting', reopened_at = now(), updated_at = now()
      where take_id = tk and branch = p_branch and status = 'submitted';
    get diagnostics n = row_count;
  end if;
  return n;
end $$;

-- payload: {meta:{...}, byBr:{branch:[[code,batch,qty,cost,sloc],...]}, descs:{code:desc}}
create or replace function public.admin_load_mb52(p_token text, p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare tk uuid := private.cur_take(); b text; n int := 0;
begin
  perform private.need_admin(p_token);
  insert into public.mb52_meta (take_id, data, loaded_at) values (tk, coalesce(p_payload -> 'meta', '{}'::jsonb), now())
    on conflict (take_id) do update set data = excluded.data, loaded_at = now();
  for b in select jsonb_object_keys(p_payload -> 'byBr') loop
    delete from public.sys_stock where take_id = tk and branch = b;
    insert into public.sys_stock (take_id, branch, code, batch, qty, unit_cost, sloc)
    select tk, b, r ->> 0, coalesce(r ->> 1, ''), (r ->> 2)::numeric, nullif(r ->> 3, '')::numeric, r ->> 4
    from jsonb_array_elements(p_payload -> 'byBr' -> b) r;
    n := n + 1;
  end loop;
  insert into public.skus (code, descr)
  select x.code, coalesce(p_payload -> 'descs' ->> x.code, '')
  from (select distinct code from public.sys_stock where take_id = tk) x
  on conflict (code) do update set descr = case when public.skus.descr = '' then excluded.descr else public.skus.descr end;
  insert into public.skus (code, descr)
  select d.key, d.value #>> '{}' from jsonb_each(coalesce(p_payload -> 'descs', '{}'::jsonb)) d
  on conflict (code) do update set descr = case when public.skus.descr = '' then excluded.descr else public.skus.descr end;
  return jsonb_build_object('branches', n);
end $$;

-- items: [{code, desc?, per?, perBox?}]. Only fields present are changed.
create or replace function public.admin_save_skus(p_token text, p_items jsonb)
returns int language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  perform private.need_admin(p_token);
  insert into public.skus as s (code, descr, per, per_box)
  select i ->> 'code', coalesce(i ->> 'desc', ''), nullif(i ->> 'per', '')::numeric, nullif(i ->> 'perBox', '')::numeric
  from jsonb_array_elements(p_items) i where coalesce(i ->> 'code', '') <> ''
  on conflict (code) do update set
    descr = case when excluded.descr <> '' then excluded.descr else s.descr end,
    per = coalesce(excluded.per, s.per), per_box = coalesce(excluded.per_box, s.per_box), updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- Replace the branch list (PINs of kept branches stay) and the team.
create or replace function public.admin_save_team(p_token text, p_branches text[], p_team jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.need_admin(p_token);
  insert into public.branches (name, active, sort)
  select b, true, ord from unnest(p_branches) with ordinality as u(b, ord) where trim(b) <> ''
  on conflict (name) do update set active = true, sort = excluded.sort;
  update public.branches set active = false where name <> all (p_branches);
  delete from public.team where true;
  insert into public.team (name, branch, role)
  select t ->> 'name', t ->> 'branch', case when t ->> 'role' = 'Counter' then 'Counter' else 'Checker' end
  from jsonb_array_elements(coalesce(p_team, '[]'::jsonb)) t
  where coalesce(t ->> 'name', '') <> '' and t ->> 'branch' = any (p_branches);
end $$;

-- pins: {branch: "1234" | ""}. Changing a PIN logs that branch's phones out.
create or replace function public.admin_save_pins(p_token text, p_pins jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare b text; v text;
begin
  perform private.need_admin(p_token);
  for b, v in select key, value #>> '{}' from jsonb_each(p_pins) loop
    v := trim(coalesce(v, ''));
    if v <> '' and v !~ '^\d{4,6}$' then raise exception 'PIN for % must be 4-6 digits', b; end if;
    if exists (select 1 from public.branches where name = b and coalesce(pin, '') is distinct from v) then
      update public.branches set pin = nullif(v, '') where name = b;
      delete from public.tokens where kind = 'branch' and branch = b;
    end if;
  end loop;
end $$;

-- rows: [{barcode, code, uom}]
create or replace function public.admin_save_barcodes(p_token text, p_rows jsonb, p_replace boolean default false)
returns int language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  perform private.need_admin(p_token);
  if p_replace then delete from public.barcodes where true; end if;
  insert into public.barcodes (barcode, code, uom)
  select distinct on (trim(r ->> 'barcode')) trim(r ->> 'barcode'), trim(r ->> 'code'), upper(coalesce(nullif(trim(r ->> 'uom'), ''), 'PCS'))
  from jsonb_array_elements(p_rows) r
  where coalesce(trim(r ->> 'barcode'), '') <> '' and coalesce(trim(r ->> 'code'), '') <> ''
    and upper(coalesce(nullif(trim(r ->> 'uom'), ''), 'PCS')) in ('PCS', 'BOX', 'CTN')
  on conflict (barcode) do update set code = excluded.code, uom = excluded.uom, updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

------------------------------------------------------------------ owner only
create or replace function public.owner_set_password(p_token text, p_which text, p_password text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare pw text := trim(coalesce(p_password, ''));
begin
  perform private.need_owner(p_token);
  if p_which not in ('finance', 'owner') then raise exception 'Bad target'; end if;
  if p_which = 'finance' and pw = '' then
    delete from private.secrets where key = 'finance_hash';
  else
    if length(pw) < (case when p_which = 'owner' then 8 else 6 end) then raise exception 'Password too short'; end if;
    insert into private.secrets (key, value) values (p_which || '_hash', extensions.crypt(pw, extensions.gen_salt('bf')))
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  delete from public.tokens where kind = p_which and token <> p_token;
end $$;

-- Wipes counts of the current stock take (test data). Returns photo paths so the app can delete the files.
create or replace function public.owner_clear_counts(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare tk uuid := private.cur_take(); paths jsonb; n int;
begin
  perform private.need_owner(p_token);
  select coalesce(jsonb_agg(p.path), '[]'::jsonb) into paths
    from public.session_photos p join public.count_sessions s on s.id = p.session_id where s.take_id = tk;
  delete from public.count_sessions where take_id = tk;
  get diagnostics n = row_count;
  delete from public.recount where take_id = tk;
  update public.stock_takes set reset_id = encode(extensions.gen_random_bytes(6), 'hex') where id = tk;
  return jsonb_build_object('sessions', n, 'paths', paths);
end $$;

-- Starts a new stock take. The old one stays for history.
create or replace function public.owner_new_take(p_token text, p_name text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare nid uuid;
begin
  perform private.need_owner(p_token);
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the stock take a name'; end if;
  update public.stock_takes set closed = true where id = private.cur_take();
  insert into public.stock_takes (name) values (trim(p_name)) returning id into nid;
  update public.settings set value = to_jsonb(nid::text), updated_at = now() where key = 'current_take';
  return nid;
end $$;

create or replace function public.owner_set_take(p_token text, p_take uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.need_owner(p_token);
  if not exists (select 1 from public.stock_takes where id = p_take) then raise exception 'Unknown stock take'; end if;
  update public.settings set value = to_jsonb(p_take::text), updated_at = now() where key = 'current_take';
end $$;

-- Full backup of everything (Free plan has no automatic backups).
create or replace function public.owner_backup(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.need_owner(p_token);
  return jsonb_build_object(
    'exportedAt', now(),
    'settings', (select jsonb_agg(to_jsonb(x)) from public.settings x),
    'stock_takes', (select jsonb_agg(to_jsonb(x)) from public.stock_takes x),
    'branches', (select jsonb_agg(to_jsonb(x)) from public.branches x),
    'team', (select jsonb_agg(to_jsonb(x)) from public.team x),
    'skus', (select jsonb_agg(to_jsonb(x)) from public.skus x),
    'barcodes', (select jsonb_agg(to_jsonb(x)) from public.barcodes x),
    'sys_stock', (select jsonb_agg(to_jsonb(x)) from public.sys_stock x),
    'mb52_meta', (select jsonb_agg(to_jsonb(x)) from public.mb52_meta x),
    'count_sessions', (select jsonb_agg(to_jsonb(x)) from public.count_sessions x),
    'recount', (select jsonb_agg(to_jsonb(x)) from public.recount x),
    'session_photos', (select jsonb_agg(to_jsonb(x)) from public.session_photos x));
end $$;

------------------------------------------------------------------ grants
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant usage on schema public to anon, authenticated;
grant execute on function
  public.public_config(), public.public_dashboard(),
  public.pin_login(text, text), public.admin_login(text), public.owner_bootstrap(text, text), public.logout(text), public.whoami(text[]),
  public.counter_master(text), public.counter_branch(text, text), public.counter_sync(text[], text),
  public.counter_start(text, text, text, text, jsonb), public.counter_save(text, text, uuid, jsonb), public.counter_submit(text, text, uuid, jsonb),
  public.admin_load(text, uuid), public.admin_settings(text, jsonb), public.admin_reopen(text, uuid), public.admin_send_recount(text, text, text[]),
  public.admin_load_mb52(text, jsonb), public.admin_save_skus(text, jsonb), public.admin_save_team(text, text[], jsonb),
  public.admin_save_pins(text, jsonb), public.admin_save_barcodes(text, jsonb, boolean),
  public.owner_set_password(text, text, text), public.owner_clear_counts(text), public.owner_new_take(text, text),
  public.owner_set_take(text, uuid), public.owner_backup(text)
to anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
