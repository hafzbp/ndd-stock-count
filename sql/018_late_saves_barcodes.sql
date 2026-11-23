-- 018: QA fixes before the month-end stock take.
-- 1. Counts that reach the server after counting closed (phone was offline) are no longer thrown away:
--    they are parked in late_saves for HQ to take in or ignore.
-- 2. A barcode printed on several SKUs keeps the whole list (alts), so the phone asks which SKU instead of guessing.

------------------------------------------------------------------ late saves
create table if not exists public.late_saves (
  session_id uuid primary key references public.count_sessions (id) on delete cascade,
  data jsonb not null,
  device_id text,
  at timestamptz not null default now()
);
alter table public.late_saves enable row level security;

create or replace function public.counter_save(p_token text, p_device text, p_id uuid, p_data jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare s public.count_sessions; k text; st text; late boolean := false;
begin
  select * into s from public.count_sessions where id = p_id;
  if not found then raise exception 'GONE: this count was cleared by the owner.'; end if;
  k := private.need_branch(p_token, s.branch);
  if s.device_id <> p_device and k = 'branch' then raise exception 'Not your count'; end if;
  perform private.roll_daily();
  select t.status into st from public.stock_takes t where t.id = s.take_id;
  if s.status = 'submitted' or (st <> 'open' and k = 'branch') or s.take_id <> (private.take_for(s.branch)).id then
    -- counting closed while this phone still had changes: keep them for HQ instead of dropping them
    if s.status = 'counting' and k = 'branch' and (s.data -> 'lines') is distinct from (p_data -> 'lines') then
      insert into public.late_saves (session_id, data, device_id, at) values (s.id, p_data, p_device, now())
        on conflict (session_id) do update set data = excluded.data, device_id = excluded.device_id, at = now();
      late := true;
    end if;
    return jsonb_build_object('ok', false, 'session', private.session_json(s), 'closed', st <> 'open', 'late', late);
  end if;
  update public.count_sessions set data = p_data, updated_at = now() where id = p_id returning * into s;
  delete from public.late_saves where session_id = p_id;
  return jsonb_build_object('ok', true, 'session', private.session_json(s));
end $$;

-- Late counts for the stock take HQ is looking at: which phone, how many lines differ from what is in the result.
create or replace function public.admin_late(p_token text, p_take uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare tk uuid;
begin
  perform private.need_admin(p_token);
  tk := coalesce(p_take, private.cur_take());
  return coalesce((
    select jsonb_agg(jsonb_build_object('session', s.id, 'branch', s.branch, 'role', s.role, 'member', coalesce(s.data ->> 'member', ''),
      'at', l.at,
      'lines', (select count(*) from jsonb_each(coalesce(l.data -> 'lines', '{}'::jsonb)) e
                where (s.data -> 'lines' -> e.key) is distinct from e.value),
      'removed', (select count(*) from jsonb_each(coalesce(s.data -> 'lines', '{}'::jsonb)) e
                where not (coalesce(l.data -> 'lines', '{}'::jsonb) ? e.key)))
      order by s.branch, s.role)
    from public.late_saves l join public.count_sessions s on s.id = l.session_id
    where s.take_id = tk), '[]'::jsonb);
end $$;

-- HQ decides: take the late counts into the result (p_take = true) or drop them.
create or replace function public.admin_late_resolve(p_token text, p_session uuid, p_take boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare l public.late_saves;
begin
  perform private.need_admin(p_token);
  select * into l from public.late_saves where session_id = p_session;
  if not found then raise exception 'Nothing waiting for this count.'; end if;
  if p_take then
    update public.count_sessions set data = l.data, updated_at = now() where id = p_session;
  end if;
  delete from public.late_saves where session_id = p_session;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.admin_late(text, uuid), public.admin_late_resolve(text, uuid, boolean) from public;
grant execute on function public.admin_late(text, uuid), public.admin_late_resolve(text, uuid, boolean) to anon, authenticated;

------------------------------------------------------------------ barcodes on several SKUs
alter table public.barcodes add column if not exists alts text[] not null default '{}';

create or replace function public.admin_save_barcodes(p_token text, p_rows jsonb, p_replace boolean default false)
returns int language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  perform private.need_admin(p_token);
  if p_replace then delete from public.barcodes where true; end if;
  with r as (
    select trim(x ->> 'barcode') bc, trim(x ->> 'code') code, upper(coalesce(nullif(trim(x ->> 'uom'), ''), 'PCS')) uom
    from jsonb_array_elements(p_rows) x
    where coalesce(trim(x ->> 'barcode'), '') <> '' and coalesce(trim(x ->> 'code'), '') <> ''
      and upper(coalesce(nullif(trim(x ->> 'uom'), ''), 'PCS')) in ('PCS', 'BOX', 'CTN')
  ), g as (
    select bc, min(code) code, mode() within group (order by uom) uom, array_agg(distinct code order by code) codes from r group by bc
  )
  insert into public.barcodes (barcode, code, uom, alts)
  select bc, code, uom, case when cardinality(codes) > 1 then codes else '{}'::text[] end from g
  on conflict (barcode) do update set code = excluded.code, uom = excluded.uom, alts = excluded.alts, updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.counter_master(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if private.tok_kind(p_token) is null then raise exception 'AUTH: enter the branch PIN again' using errcode = '28000'; end if;
  return jsonb_build_object(
    'skus', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'desc', descr, 'per', per, 'perBox', per_box) order by code) from public.skus), '[]'::jsonb),
    'barcodes', coalesce((select jsonb_object_agg(barcode, jsonb_build_object('code', code, 'uom', uom)
        || case when cardinality(alts) > 1 then jsonb_build_object('alts', to_jsonb(alts)) else '{}'::jsonb end) from public.barcodes), '{}'::jsonb),
    'team', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'branch', branch, 'role', role) order by name) from public.team), '[]'::jsonb));
end $$;
