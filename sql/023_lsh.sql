-- 023: LSH (Laporan Stok Harian), the daily stock ledger kept by the warehouse.
-- Every movement is a row (in pcs) between areas: in, gs (good stock), stg (staging: invoiced, not loaded), bs (bad stock), out.
-- Balances are always the sum of the ledger. The Ops Manager closes the day at the cut-off; HQ's evening MB52 is then
-- compared area by area (gs with good locations, bs with bad ones; stg is already out of SAP at invoice).

------------------------------------------------------------------ schema
alter table public.branches add column if not exists lsh_enabled boolean not null default false;
alter table public.branches add column if not exists lsh_cutoff time not null default '16:00';
alter table public.branches add column if not exists lsh_start date;

create table if not exists public.lsh_moves (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null,                      -- lines saved together (one document)
  branch text not null references public.branches(name) on update cascade on delete cascade,
  day date not null,                           -- business day it counts for
  type text not null check (type in ('receive', 'invoice', 'load', 'fail_back', 'reversal', 'redeliver', 'return', 'to_bs', 'transfer_out', 'correction', 'reset')),
  code text not null,
  qty numeric not null check (qty > 0),        -- pcs
  from_area text not null check (from_area in ('in', 'gs', 'stg', 'bs', 'out')),
  to_area text not null check (to_area in ('in', 'gs', 'stg', 'bs', 'out')),
  doc_no text not null default '',
  ref_no text not null default '',             -- second document, e.g. the reversal number
  reason text,
  note text,
  by_person uuid references public.people(id) on delete set null,
  by_hq uuid references public.hq_users(id) on delete set null,
  by_name text not null default '',
  device_id uuid,
  happened_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  status text not null default 'ok' check (status in ('ok', 'pending', 'rejected', 'undone')),
  fixes_entry uuid,                            -- a correction points at the entry it changes
  decided_by_name text,
  decided_at timestamptz,
  check (from_area <> to_area)
);
create index if not exists lsh_moves_branch_code on public.lsh_moves (branch, code);
create index if not exists lsh_moves_branch_doc on public.lsh_moves (branch, doc_no);
create index if not exists lsh_moves_entry on public.lsh_moves (entry_id);
create index if not exists lsh_moves_branch_day on public.lsh_moves (branch, day);

create table if not exists public.lsh_days (
  branch text not null references public.branches(name) on update cascade on delete cascade,
  day date not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  closed_at timestamptz,
  closed_by_name text,
  late boolean not null default false,
  auto boolean not null default false,
  closing jsonb not null default '{}'::jsonb,  -- {code: {gs, stg, bs}} in pcs, at close
  warnings jsonb not null default '{}'::jsonb,
  primary key (branch, day)
);

create table if not exists public.lsh_recon (
  branch text not null references public.branches(name) on update cascade on delete cascade,
  day date not null,
  code text not null,
  area text not null check (area in ('gs', 'bs')),
  lsh_q numeric not null default 0,
  sap_q numeric not null default 0,
  diff numeric not null default 0,
  status text not null default 'open' check (status in ('match', 'open', 'explained')),
  reason text check (reason in ('sap', 'lsh_error', 'not_recorded', 'physical')),
  note text,
  set_by_name text,
  set_at timestamptz,
  due_at timestamptz,
  since_day date,                               -- first day this same difference showed
  snap_id uuid,
  primary key (branch, day, code, area)
);

do $$ declare t text; begin
  foreach t in array array['lsh_moves', 'lsh_days', 'lsh_recon'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

------------------------------------------------------------------ helpers
create or replace function private.kl_date(p timestamptz)
returns date language sql immutable set search_path = '' as $$ select (p at time zone 'Asia/Kuala_Lumpur')::date $$;
create or replace function private.kl_time(p timestamptz)
returns time language sql immutable set search_path = '' as $$ select (p at time zone 'Asia/Kuala_Lumpur')::time $$;

create or replace function private.is_workday(p_branch text, d date)
returns boolean language sql stable set search_path = '' as $$
  select coalesce((select extract(isodow from d)::int = any (work_days) from public.branches where name = p_branch), true)
$$;

create or replace function private.next_workday(p_branch text, d date)
returns date language sql stable set search_path = '' as $$
  select min(x)::date from generate_series(d, d + 14, interval '1 day') x where private.is_workday(p_branch, x::date)
$$;

-- balance per code and area at a moment (ok rows only)
create or replace function private.lsh_bal(p_branch text, p_at timestamptz)
returns table (code text, area text, qty numeric) language sql stable set search_path = '' as $$
  select code, area, sum(q) from (
    select code, to_area as area, qty as q from public.lsh_moves where branch = p_branch and status = 'ok' and happened_at <= p_at and to_area in ('gs', 'stg', 'bs')
    union all
    select code, from_area, -qty from public.lsh_moves where branch = p_branch and status = 'ok' and happened_at <= p_at and from_area in ('gs', 'stg', 'bs')
  ) x group by code, area having sum(q) <> 0
$$;

-- per invoice in staging: what waits to be loaded and what came back waiting for the SAP reversal
create or replace function private.lsh_stg(p_branch text)
returns table (doc_no text, code text, waiting numeric, failed numeric, first_at timestamptz, failed_at timestamptz, fail_reason text)
language sql stable set search_path = '' as $$
  select doc_no, code,
    sum(case when type = 'invoice' then qty when type = 'load' then -qty else 0 end),
    sum(case when type = 'fail_back' then qty when type in ('reversal', 'redeliver') then -qty else 0 end),
    min(happened_at) filter (where type = 'invoice'),
    max(happened_at) filter (where type = 'fail_back'),
    (array_agg(reason order by happened_at desc) filter (where type = 'fail_back'))[1]
  from public.lsh_moves where branch = p_branch and status = 'ok' and type in ('invoice', 'load', 'fail_back', 'reversal', 'redeliver')
  group by doc_no, code
  having sum(case when type = 'invoice' then qty when type = 'load' then -qty else 0 end) <> 0
      or sum(case when type = 'fail_back' then qty when type in ('reversal', 'redeliver') then -qty else 0 end) <> 0
$$;

-- days not closed by the end of the day are closed by the app, marked late
create or replace function private.lsh_autoclose(p_branch text)
returns void language plpgsql set search_path = '' as $$
declare b public.branches; d date; tday date := private.today();
begin
  select * into b from public.branches where name = p_branch;
  if not b.lsh_enabled or b.lsh_start is null then return; end if;
  for d in select x::date from generate_series(b.lsh_start, tday - 1, interval '1 day') x
           where private.is_workday(p_branch, x::date)
             and not exists (select 1 from public.lsh_days y where y.branch = p_branch and y.day = x::date and y.status = 'closed') loop
    insert into public.lsh_days (branch, day, status, closed_at, closed_by_name, late, auto, closing)
    values (p_branch, d, 'closed', ((d + 1)::timestamp at time zone 'Asia/Kuala_Lumpur') - interval '1 second', 'App (not closed)', true, true,
            private.lsh_closing(p_branch, ((d + 1)::timestamp at time zone 'Asia/Kuala_Lumpur') - interval '1 second'))
    on conflict (branch, day) do update set status = 'closed', closed_at = excluded.closed_at, closed_by_name = excluded.closed_by_name,
      late = true, auto = true, closing = excluded.closing;
  end loop;
end $$;

create or replace function private.lsh_closing(p_branch text, p_at timestamptz)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_object_agg(code, a), '{}'::jsonb) from (
    select code, jsonb_object_agg(area, qty) as a from private.lsh_bal(p_branch, p_at) group by code) x
$$;

-- the day an entry made now counts for: today until it is closed, then the next working day
create or replace function private.lsh_day(p_branch text)
returns date language plpgsql set search_path = '' as $$
declare d date := private.today();
begin
  perform private.lsh_autoclose(p_branch);
  if not private.is_workday(p_branch, d) or exists (select 1 from public.lsh_days where branch = p_branch and day = d and status = 'closed') then
    d := private.next_workday(p_branch, d + 1);
  end if;
  return d;
end $$;

create or replace function private.lsh_branch_ok(p_branch text)
returns public.branches language plpgsql stable set search_path = '' as $$
declare b public.branches;
begin
  select * into b from public.branches where name = p_branch;
  if not coalesce(b.lsh_enabled, false) then raise exception 'NOT ALLOWED: LSH is not switched on for this warehouse'; end if;
  return b;
end $$;

create or replace function private.ctn(p_code text, p_q numeric)
returns numeric language sql stable set search_path = '' as $$
  select case when coalesce(s.per, 0) > 0 then round(p_q / s.per, 2) else null end from public.skus s where s.code = p_code
$$;

------------------------------------------------------------------ recording
-- one entry = one document with one or more SKU lines; qty in pcs
-- p: {type, doc, ref, reason, note, happenedAt, lines: [{code, qty, area}]}
create or replace function public.lsh_add(p_token text, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare me public.people := private.need_person(p_token, array['lo', 'om']); b public.branches; e uuid := gen_random_uuid();
        ty text := p ->> 'type'; doc text := trim(coalesce(p ->> 'doc', '')); ref text := trim(coalesce(p ->> 'ref', ''));
        rsn text := nullif(trim(coalesce(p ->> 'reason', '')), ''); nt text := nullif(trim(coalesce(p ->> 'note', '')), '');
        d date; hat timestamptz := private.mw_now(); l jsonb; fa text; ta text; q numeric; c text; avail numeric; dev uuid; warn jsonb := '[]'::jsonb; nb numeric;
begin
  b := private.lsh_branch_ok(me.branch);
  d := private.lsh_day(me.branch);
  select device_id into dev from public.tokens where token = p_token;
  if ty not in ('receive', 'invoice', 'fail_back', 'reversal', 'redeliver', 'return', 'to_bs', 'transfer_out') then raise exception 'Unknown movement'; end if;
  if ty = 'to_bs' then
    if doc = '' and nt is null then raise exception 'Enter a reference or a note'; end if;
  elsif doc = '' then raise exception 'Enter the document number'; end if;
  if ty = 'fail_back' and (rsn is null or rsn not in ('outlet_closed', 'refused', 'wrong_item', 'no_time', 'other')) then raise exception 'Pick why it came back'; end if;
  if ty = 'reversal' and ref = '' then raise exception 'Enter the SAP reversal number'; end if;
  if jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) = 0 then raise exception 'Add at least one SKU'; end if;
  -- "happened at" may be set earlier today (recorded late), never in the future or before today
  if p ->> 'happenedAt' is not null and d = private.today() then
    hat := least(private.mw_now(), greatest((p ->> 'happenedAt')::timestamptz, (d::timestamp at time zone 'Asia/Kuala_Lumpur')));
  end if;
  for l in select * from jsonb_array_elements(p -> 'lines') loop
    c := trim(coalesce(l ->> 'code', '')); q := (l ->> 'qty')::numeric;
    if not exists (select 1 from public.skus where code = c) then raise exception 'Unknown SKU %', c; end if;
    if q is null or q <= 0 then raise exception 'Quantity must be more than 0 (%)', c; end if;
    fa := case ty when 'receive' then 'in' when 'return' then 'in' when 'invoice' then 'gs' when 'to_bs' then 'gs' when 'transfer_out' then 'gs'
                  when 'fail_back' then 'out' else 'stg' end;
    ta := case ty when 'receive' then case when l ->> 'area' = 'bs' then 'bs' else 'gs' end
                  when 'return' then case when l ->> 'area' = 'gs' then 'gs' else 'bs' end
                  when 'invoice' then 'stg' when 'to_bs' then 'bs' when 'transfer_out' then 'out'
                  when 'fail_back' then 'stg' when 'reversal' then 'gs' else 'out' end;
    -- failed delivery: at most what was loaded on that invoice; reversal/redeliver: at most what waits
    if ty = 'fail_back' then
      select coalesce(sum(case when type = 'load' then qty when type = 'fail_back' then -qty when type = 'redeliver' then qty else 0 end), 0) into avail
      from public.lsh_moves where branch = me.branch and doc_no = doc and code = c and status = 'ok';
      if q > avail then raise exception 'Only % pcs of % went out on this invoice', avail, c; end if;
    elsif ty in ('reversal', 'redeliver') then
      select coalesce(sum(failed), 0) into avail from private.lsh_stg(me.branch) where doc_no = doc and code = c;
      if q > avail then raise exception 'Only % pcs of % are waiting on this invoice', avail, c; end if;
    end if;
    insert into public.lsh_moves (entry_id, branch, day, type, code, qty, from_area, to_area, doc_no, ref_no, reason, note, by_person, by_name, device_id, happened_at)
    values (e, me.branch, d, ty, c, q, fa, ta, doc, ref, rsn, nt, me.id, me.name, dev, hat);
    if fa in ('gs', 'bs') then
      select coalesce(sum(qty), 0) into nb from private.lsh_bal(me.branch, private.mw_now() + interval '1 second') x where x.code = c and x.area = fa;
      if nb < 0 then warn := warn || jsonb_build_object('code', c, 'area', fa, 'qty', nb); end if;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'entry', e, 'day', d, 'negative', warn);
end $$;

-- a truck leaves: load what waits on the invoices (all of it, or the quantities given per invoice and SKU)
create or replace function public.lsh_load(p_token text, p_docs text[], p_qty jsonb default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare me public.people := private.need_person(p_token, array['lo', 'om']); e uuid := gen_random_uuid(); d date; r record; q numeric; n int := 0; dev uuid;
begin
  perform private.lsh_branch_ok(me.branch);
  d := private.lsh_day(me.branch);
  select device_id into dev from public.tokens where token = p_token;
  for r in select * from private.lsh_stg(me.branch) s where s.doc_no = any (p_docs) and s.waiting > 0 loop
    q := coalesce((p_qty -> r.doc_no ->> r.code)::numeric, r.waiting);
    if q > r.waiting then raise exception 'Only % pcs of % wait on invoice %', r.waiting, r.code, r.doc_no; end if;
    if q > 0 then
      insert into public.lsh_moves (entry_id, branch, day, type, code, qty, from_area, to_area, doc_no, by_person, by_name, device_id, happened_at)
      values (e, me.branch, d, 'load', r.code, q, 'stg', 'out', r.doc_no, me.id, me.name, dev, private.mw_now());
      n := n + 1;
    end if;
  end loop;
  if n = 0 then raise exception 'Nothing waits to be loaded on these invoices'; end if;
  return jsonb_build_object('ok', true, 'entry', e, 'lines', n);
end $$;

-- the person who saved an entry can take it back for 10 minutes while its day is open; it stays in the history
create or replace function public.lsh_undo(p_token text, p_entry uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me public.people := private.need_person(p_token); m public.lsh_moves;
begin
  select * into m from public.lsh_moves where entry_id = p_entry limit 1;
  if m.id is null then raise exception 'Entry not found'; end if;
  if m.by_person is distinct from me.id then raise exception 'NOT ALLOWED: only who saved it can undo it. Ask for a correction.'; end if;
  if m.status <> 'ok' or m.recorded_at < now() - interval '10 minutes' then raise exception 'NOT ALLOWED: undo works for 10 minutes. Ask for a correction.'; end if;
  if exists (select 1 from public.lsh_days where branch = m.branch and day = m.day and status = 'closed') then raise exception 'NOT ALLOWED: the day is closed. Ask for a correction.'; end if;
  if m.type in ('invoice') and exists (select 1 from public.lsh_moves where branch = m.branch and doc_no = m.doc_no and type = 'load' and status = 'ok') then
    raise exception 'NOT ALLOWED: this invoice is already loaded. Ask for a correction.';
  end if;
  update public.lsh_moves set status = 'undone', decided_at = now(), decided_by_name = me.name where entry_id = p_entry;
end $$;

-- a correction: lines that move stock between areas, waiting for the Ops Manager (or HQ when the OM asks)
-- p: {fixes (entry id, optional), reason, lines: [{code, qty (pcs, signed), area}]}: +qty adds to the area, -qty takes away
create or replace function public.lsh_correct(p_token text, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare me public.people := private.need_person(p_token, array['lo', 'om', 'sup', 'admin']); e uuid := gen_random_uuid(); d date; l jsonb; q numeric; a text; c text; dev uuid;
        rsn text := nullif(trim(coalesce(p ->> 'reason', '')), ''); fx uuid := nullif(p ->> 'fixes', '')::uuid;
begin
  perform private.lsh_branch_ok(me.branch);
  if rsn is null then raise exception 'Say why it needs correcting'; end if;
  if jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) = 0 then raise exception 'Add at least one line'; end if;
  if fx is not null and not exists (select 1 from public.lsh_moves where entry_id = fx and branch = me.branch) then raise exception 'Entry not found'; end if;
  d := private.lsh_day(me.branch);
  select device_id into dev from public.tokens where token = p_token;
  for l in select * from jsonb_array_elements(p -> 'lines') loop
    c := trim(coalesce(l ->> 'code', '')); q := (l ->> 'qty')::numeric; a := l ->> 'area';
    if not exists (select 1 from public.skus where code = c) then raise exception 'Unknown SKU %', c; end if;
    if a not in ('gs', 'stg', 'bs') or q is null or q = 0 then raise exception 'Each line needs an area and a quantity'; end if;
    insert into public.lsh_moves (entry_id, branch, day, type, code, qty, from_area, to_area, doc_no, reason, by_person, by_name, device_id, happened_at, status, fixes_entry)
    values (e, me.branch, d, 'correction', c, abs(q), case when q > 0 then 'in' else a end, case when q > 0 then a else 'out' end,
            coalesce(nullif(trim(p ->> 'doc'), ''), ''), rsn, me.id, me.name, dev, private.mw_now(), 'pending', fx);
  end loop;
  return jsonb_build_object('ok', true, 'entry', e);
end $$;

create or replace function public.lsh_decide(p_token text, p_entry uuid, p_ok boolean)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare m public.lsh_moves; me uuid; nm text; asker public.people;
begin
  select * into m from public.lsh_moves where entry_id = p_entry and status = 'pending' limit 1;
  if m.id is null then raise exception 'Nothing to decide'; end if;
  me := private.need_om_or_hq(p_token, m.branch);
  select * into asker from public.people where id = m.by_person;
  if me is not null and (me = m.by_person) then raise exception 'NOT ALLOWED: someone else approves your own correction'; end if;
  if me is not null and 'om' = any (private.eff_roles(asker)) then raise exception 'NOT ALLOWED: HQ approves an Ops Manager''s correction'; end if;
  nm := coalesce((select name from public.people where id = me), (private.hq_of(p_token)).name, 'HQ');
  -- approved lines count from now
  update public.lsh_moves set status = case when p_ok then 'ok' else 'rejected' end, decided_by_name = nm, decided_at = now(),
    happened_at = case when p_ok then private.mw_now() else happened_at end
  where entry_id = p_entry and status = 'pending';
end $$;

------------------------------------------------------------------ close the day
create or replace function private.lsh_warnings(p_branch text)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'stgOld', (select count(distinct doc_no) from private.lsh_stg(p_branch) where waiting > 0 and first_at < private.mw_now() - interval '24 hours'),
    'failedWaiting', (select count(distinct doc_no) from private.lsh_stg(p_branch) where failed > 0),
    'pending', (select count(distinct entry_id) from public.lsh_moves where branch = p_branch and status = 'pending'),
    'entries', (select count(distinct entry_id) from public.lsh_moves where branch = p_branch and day = private.today() and status = 'ok'))
$$;

create or replace function public.lsh_close_day(p_token text, p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare me public.people := private.need_person(p_token, array['om']); b public.branches; d date; late boolean; w jsonb;
begin
  b := private.lsh_branch_ok(me.branch);
  if me.pin_hash is null or me.pin_hash <> extensions.crypt(coalesce(p_pin, ''), me.pin_hash) then raise exception 'Wrong PIN'; end if;
  d := private.lsh_day(me.branch);
  if d > private.today() then raise exception 'NOT ALLOWED: today is already closed'; end if;
  late := private.kl_time(private.mw_now()) > b.lsh_cutoff;
  w := private.lsh_warnings(me.branch);
  insert into public.lsh_days (branch, day, status, closed_at, closed_by_name, late, closing, warnings)
  values (me.branch, d, 'closed', private.mw_now(), me.name, late, private.lsh_closing(me.branch, private.mw_now()), w)
  on conflict (branch, day) do update set status = 'closed', closed_at = excluded.closed_at, closed_by_name = excluded.closed_by_name,
    late = excluded.late, auto = false, closing = excluded.closing, warnings = excluded.warnings;
  -- an evening MB52 of this day may already be in
  perform private.lsh_build_recon(s.id) from public.snapshots s where s.snap_date = d;
  return jsonb_build_object('ok', true, 'day', d, 'late', late, 'warnings', w);
end $$;

------------------------------------------------------------------ comparison with SAP (evening MB52)
create or replace function private.lsh_build_recon(p_snap uuid)
returns void language plpgsql set search_path = '' as $$
declare s public.snapshots; b public.branches; dy public.lsh_days; r record; prev public.lsh_recon;
begin
  select * into s from public.snapshots where id = p_snap;
  if s.id is null then return; end if;
  for b in select * from public.branches where lsh_enabled loop
    perform private.lsh_autoclose(b.name);
    select * into dy from public.lsh_days where branch = b.name and day = s.snap_date and status = 'closed';
    -- only an evening file (loaded after the cut-off of that day) says how the day ended
    if dy.branch is null or s.loaded_at < (s.snap_date + b.lsh_cutoff) at time zone 'Asia/Kuala_Lumpur' then continue; end if;
    delete from public.lsh_recon where branch = b.name and day = s.snap_date;
    for r in
      with l as (select c.key as code, a.key as area, (a.value #>> '{}')::numeric as q
                 from jsonb_each(dy.closing) c, jsonb_each(c.value) a where a.key in ('gs', 'bs')),
           sp as (select code, case when stype = 'bad' then 'bs' else 'gs' end as area, sum(qty) as q
                  from public.snap_stock where snap_id = s.id and branch = b.name group by 1, 2),
           k as (select code, area from l union select code, area from sp)
      select k.code, k.area, coalesce(l.q, 0) as lq, coalesce(sp.q, 0) as sq
      from k left join l using (code, area) left join sp using (code, area)
    loop
      select * into prev from public.lsh_recon x where x.branch = b.name and x.code = r.code and x.area = r.area and x.day < s.snap_date
        order by x.day desc limit 1;
      insert into public.lsh_recon (branch, day, code, area, lsh_q, sap_q, diff, status, reason, note, set_by_name, set_at, due_at, since_day, snap_id)
      values (b.name, s.snap_date, r.code, r.area, r.lq, r.sq, r.lq - r.sq,
        case when r.lq = r.sq then 'match' when prev.diff = r.lq - r.sq and prev.status = 'explained' then 'explained' else 'open' end,
        case when r.lq <> r.sq and prev.diff = r.lq - r.sq then prev.reason end,
        case when r.lq <> r.sq and prev.diff = r.lq - r.sq then prev.note end,
        case when r.lq <> r.sq and prev.diff = r.lq - r.sq then prev.set_by_name end,
        case when r.lq <> r.sq and prev.diff = r.lq - r.sq then prev.set_at end,
        case when r.lq = r.sq then null when prev.diff = r.lq - r.sq and prev.status <> 'match' then prev.due_at else s.loaded_at + interval '24 hours' end,
        case when r.lq = r.sq then null when prev.diff = r.lq - r.sq and prev.status <> 'match' then coalesce(prev.since_day, prev.day) else s.snap_date end,
        s.id);
    end loop;
  end loop;
end $$;

-- the evening MB52 goes through the existing daily upload (latest version, 017); the comparison is built right after it
create or replace function public.admin_load_daily(p_token text, p_date date, p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare sid uuid; b text; pl jsonb; n int := 0; t public.stock_takes;
begin
  perform private.need_admin(p_token);
  if p_date is null or p_date <> private.today() then raise exception 'Daily stock must be today''s MB52 (stock date %). It releases today''s daily counts.', to_char(private.today(), 'DD Mon YYYY'); end if;
  insert into public.snapshots (snap_date, meta, loaded_at) values (p_date, coalesce(p_payload -> 'meta', '{}'::jsonb), private.mw_now())
    on conflict (snap_date) do update set meta = excluded.meta, loaded_at = excluded.loaded_at
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
  -- refresh open daily counts that use an older or the same upload, but only while their count window is still on:
  -- the evening MB52 (for LSH) must not replace the stock a morning count was compared with
  for t in select x.* from public.stock_takes x join public.snapshots s on s.id = x.snap_id join public.branches br on br.name = x.branch
           where x.kind = 'daily' and x.status = 'open' and x.count_date >= p_date and s.snap_date <= p_date
             and (x.count_date > private.today() or private.kl_time(private.mw_now()) <= coalesce(x.due_to, br.count_to)) loop
    delete from public.sys_stock where take_id = t.id;
    insert into public.sys_stock (take_id, branch, code, batch, qty, unit_cost, sloc)
    select t.id, s.branch, s.code, s.batch, s.qty, s.unit_cost, s.sloc
    from public.snap_stock s where s.snap_id = sid and s.branch = t.branch and s.stype = 'good' and s.code = any (t.skus);
    update public.stock_takes set snap_id = sid where id = t.id;
  end loop;
  perform private.lsh_build_recon(sid);
  delete from public.snapshots where id in (select id from public.snapshots order by snap_date desc offset 14)
    and id not in (select snap_id from public.stock_takes where snap_id is not null and status = 'open');
  return jsonb_build_object('branches', n, 'date', p_date,
    'lsh', (select coalesce(jsonb_agg(jsonb_build_object('branch', x.name,
              'closed', exists (select 1 from public.lsh_days y where y.branch = x.name and y.day = p_date and y.status = 'closed'),
              'built', exists (select 1 from public.lsh_recon r where r.branch = x.name and r.day = p_date))), '[]'::jsonb)
            from public.branches x where x.lsh_enabled));
end $$;

-- reason for a difference: the branch's Ops Manager or HQ
create or replace function public.lsh_reason(p_token text, p_branch text, p_day date, p_code text, p_area text, p_reason text, p_note text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me uuid := private.need_om_or_hq(p_token, p_branch); nm text;
begin
  if p_reason not in ('sap', 'lsh_error', 'not_recorded', 'physical') then raise exception 'Pick a reason'; end if;
  nm := coalesce((select name from public.people where id = me), (private.hq_of(p_token)).name, 'HQ');
  update public.lsh_recon set reason = p_reason, note = nullif(trim(coalesce(p_note, '')), ''), status = 'explained', set_by_name = nm, set_at = now()
  where branch = p_branch and day = p_day and code = p_code and area = p_area and status <> 'match';
  if not found then raise exception 'Difference not found'; end if;
end $$;

------------------------------------------------------------------ what the warehouse device shows
create or replace function private.lsh_recon_json(p_branch text, p_day date, p_all boolean)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', r.code, 'area', r.area, 'lsh', r.lsh_q, 'sap', r.sap_q, 'diff', r.diff,
      'status', r.status, 'reason', r.reason, 'note', r.note, 'setBy', r.set_by_name, 'dueAt', r.due_at, 'since', r.since_day,
      'descr', (select descr from public.skus where code = r.code), 'per', (select per from public.skus where code = r.code))
    order by r.status = 'match', abs(r.diff) desc), '[]'::jsonb)
  from public.lsh_recon r where r.branch = p_branch and r.day = p_day and (p_all or r.status <> 'match')
$$;

create or replace function private.lsh_stg_json(p_branch text)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x ->> 'firstAt'), '[]'::jsonb) from (
    select jsonb_build_object('doc', doc_no, 'firstAt', min(first_at), 'failedAt', max(failed_at), 'reason', max(fail_reason),
      'waiting', sum(waiting), 'failed', sum(failed),
      'lines', jsonb_agg(jsonb_build_object('code', code, 'waiting', waiting, 'failed', failed) order by code)) as x
    from private.lsh_stg(p_branch) group by doc_no) y
$$;

create or replace function public.lsh_today(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare me public.people := private.need_person(p_token); b public.branches; d date; last date; cday public.lsh_days;
begin
  select * into b from public.branches where name = me.branch;
  if not b.lsh_enabled then return jsonb_build_object('enabled', false); end if;
  d := private.lsh_day(me.branch);
  select max(day) into last from public.lsh_recon where branch = me.branch;
  select * into cday from public.lsh_days where branch = me.branch and day = private.today();
  return jsonb_build_object('enabled', true, 'branch', me.branch, 'day', d, 'today', private.today(), 'now', private.mw_now(),
    'cutoff', to_char(b.lsh_cutoff, 'HH24:MI'), 'started', b.lsh_start is not null,
    'todayClosed', cday.status = 'closed', 'closedAt', cday.closed_at, 'closedBy', cday.closed_by_name, 'closedLate', cday.late,
    'balance', (select coalesce(jsonb_object_agg(area, q), '{}'::jsonb) from (select area, sum(qty) q from private.lsh_bal(me.branch, private.mw_now()) group by area) x),
    'byCode', private.lsh_closing(me.branch, private.mw_now()),
    'staging', private.lsh_stg_json(me.branch),
    'warnings', private.lsh_warnings(me.branch),
    'entries', (select coalesce(jsonb_agg(e order by e ->> 'at' desc), '[]'::jsonb) from (
        select jsonb_build_object('entry', entry_id, 'type', min(type), 'doc', min(doc_no), 'ref', min(ref_no), 'reason', min(reason), 'note', min(note),
          'by', min(by_name), 'mine', bool_and(by_person = me.id), 'at', max(happened_at), 'recordedAt', max(recorded_at), 'status', min(status),
          'canUndo', bool_and(by_person = me.id and status = 'ok' and recorded_at > now() - interval '10 minutes'),
          'lines', jsonb_agg(jsonb_build_object('code', code, 'qty', qty, 'from', from_area, 'to', to_area) order by code)) e
        from public.lsh_moves where branch = me.branch and (day = d or day = private.today()) and type <> 'reset' group by entry_id) z),
    'pending', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (
        select jsonb_build_object('entry', entry_id, 'by', min(by_name), 'byOm', bool_or('om' = any (coalesce((select roles from public.people where id = by_person), '{}'))),
          'mine', bool_and(by_person = me.id), 'reason', min(reason), 'at', max(recorded_at), 'fixes', min(fixes_entry::text),
          'lines', jsonb_agg(jsonb_build_object('code', code, 'qty', qty, 'from', from_area, 'to', to_area))) e
        from public.lsh_moves where branch = me.branch and status = 'pending' group by entry_id) z),
    'reconDay', last,
    'diffs', case when last is null then '[]'::jsonb else private.lsh_recon_json(me.branch, last, false) end);
end $$;

------------------------------------------------------------------ HQ
create or replace function public.admin_lsh_branch(p_token text, p_branch text, p_login_mode text, p_lsh boolean, p_cutoff text)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.need_owner(p_token);
  if p_login_mode not in ('plant', 'people') then raise exception 'Unknown login mode'; end if;
  if p_lsh and p_login_mode <> 'people' then raise exception 'LSH needs name and PIN login'; end if;
  update public.branches set login_mode = p_login_mode, lsh_enabled = coalesce(p_lsh, false),
    lsh_cutoff = coalesce(nullif(p_cutoff, '')::time, lsh_cutoff)
  where name = p_branch;
  if not found then raise exception 'Unknown warehouse'; end if;
end $$;

-- set LSH to physical stock (a closed stock take) or to SAP (an MB52 upload), per area, at a moment
create or replace function public.admin_lsh_reset(p_token text, p_branch text, p_source text, p_ref uuid, p_at timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare b public.branches; e uuid := gen_random_uuid(); at timestamptz := coalesce(p_at, private.mw_now()); d date; r record; nm text; lbl text; n int := 0; u public.hq_users := private.hq_of(p_token);
        tk public.stock_takes;
begin
  perform private.need_owner(p_token);
  b := private.lsh_branch_ok(p_branch);
  nm := coalesce(u.name, 'HQ');
  if p_source = 'take' then
    select * into tk from public.stock_takes where id = p_ref and status = 'closed';
    if tk.id is null then raise exception 'Pick a closed stock take'; end if;
    lbl := 'Reset to stock take: ' || tk.name;
  elsif p_source = 'snapshot' then
    select 'Opening from MB52 of ' || to_char(snap_date, 'DD Mon YYYY') into lbl from public.snapshots where id = p_ref;
    if lbl is null then raise exception 'Pick an MB52 upload'; end if;
  else raise exception 'Unknown source'; end if;
  if b.lsh_start is null then update public.branches set lsh_start = private.kl_date(at) where name = p_branch; end if;
  d := private.lsh_day(p_branch);
  for r in
    with tgt as (
      select code, case when tk.stock_type = 'bad' then 'bs' else 'gs' end as area, phys_q as q
        from public.count_log where p_source = 'take' and take_id = p_ref and branch = p_branch and phys_q is not null
      union all
      select code, case when stype = 'bad' then 'bs' else 'gs' end, sum(qty)
        from public.snap_stock where p_source = 'snapshot' and snap_id = p_ref and branch = p_branch group by code, stype),
    now_b as (select code, area, qty from private.lsh_bal(p_branch, at))
    select coalesce(t.code, n2.code) as code, coalesce(t.area, n2.area) as area, coalesce(t.q, 0) - coalesce(n2.qty, 0) as delta
    from tgt t full join now_b n2 on n2.code = t.code and n2.area = t.area
    -- an MB52 opening sets good and bad stock; a stock take only the SKUs it counted, in the area it counted
    where (p_source = 'snapshot' and coalesce(t.area, n2.area) in ('gs', 'bs'))
       or (p_source = 'take' and t.code is not null)
  loop
    if r.delta <> 0 then
      insert into public.lsh_moves (entry_id, branch, day, type, code, qty, from_area, to_area, doc_no, by_hq, by_name, happened_at)
      values (e, p_branch, d, 'reset', r.code, abs(r.delta), case when r.delta > 0 then 'in' else r.area end, case when r.delta > 0 then r.area else 'out' end,
              lbl, u.id, nm, at);
      n := n + 1;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'lines', n, 'label', lbl);
end $$;

create or replace function public.admin_lsh(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare b public.branches; out jsonb := '[]'::jsonb; last date; td public.lsh_days;
begin
  perform private.need_admin(p_token);
  for b in select * from public.branches where active order by name loop
    if b.lsh_enabled then
      perform private.lsh_autoclose(b.name);
      select max(day) into last from public.lsh_recon where branch = b.name;
      select * into td from public.lsh_days where branch = b.name and day = private.today();
    else last := null; td := null; end if;
    out := out || jsonb_build_object('branch', b.name, 'plant', b.plants[1], 'loginMode', b.login_mode, 'lsh', b.lsh_enabled,
      'cutoff', to_char(b.lsh_cutoff, 'HH24:MI'), 'started', b.lsh_start,
      'people', (select count(*) from public.people p where p.branch = b.name and p.active),
      'devices', (select count(*) from public.devices d where d.branch = b.name and d.revoked_at is null),
      'todayClosed', td.status = 'closed', 'closedAt', td.closed_at, 'late', td.late,
      'reconDay', last,
      'open', case when last is null then 0 else (select count(*) from public.lsh_recon r where r.branch = b.name and r.day = last and r.status = 'open') end,
      'explained', case when last is null then 0 else (select count(*) from public.lsh_recon r where r.branch = b.name and r.day = last and r.status = 'explained') end,
      'match', case when last is null then 0 else (select count(*) from public.lsh_recon r where r.branch = b.name and r.day = last and r.status = 'match') end,
      'stg', case when b.lsh_enabled then private.lsh_stg_json(b.name) else '[]'::jsonb end,
      'onTime', case when b.lsh_start is null then null else jsonb_build_object(
         'days', (select count(*) from public.lsh_days y where y.branch = b.name and y.status = 'closed'),
         'late', (select count(*) from public.lsh_days y where y.branch = b.name and y.status = 'closed' and y.late)) end);
  end loop;
  return jsonb_build_object('branches', out, 'today', private.today(), 'now', private.mw_now(),
    'snapshots', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'date', snap_date, 'loadedAt', loaded_at) order by snap_date desc), '[]'::jsonb) from public.snapshots),
    'takes', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'stockType', stock_type, 'closedAt', closed_at) order by closed_at desc), '[]'::jsonb)
              from public.stock_takes where kind = 'monthly' and status = 'closed'));
end $$;

-- comparison of one NDD and day, with the daily count next to it (count vs LSH at the moment of the count)
create or replace function public.admin_lsh_recon(p_token text, p_branch text, p_day date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare d date := p_day; tk public.stock_takes; at timestamptz; dcc jsonb := '{}'::jsonb; r record;
begin
  perform private.need_om_or_hq(p_token, p_branch);
  if d is null then select max(day) into d from public.lsh_recon where branch = p_branch; end if;
  -- the first daily count after the day
  select * into tk from public.stock_takes where kind = 'daily' and branch = p_branch and count_date > d and status = 'closed' order by count_date limit 1;
  if tk.id is not null then
    select max(submitted_at) into at from public.count_sessions where take_id = tk.id and branch = p_branch;
    if at is not null then
      for r in select l.code, l.phys_q, coalesce((select qty from private.lsh_bal(p_branch, at) x where x.code = l.code and x.area = 'gs'), 0) as lq
               from public.count_log l where l.take_id = tk.id and l.branch = p_branch loop
        dcc := dcc || jsonb_build_object(r.code, jsonb_build_object('count', r.phys_q, 'lsh', r.lq, 'diff', r.phys_q - r.lq));
      end loop;
    end if;
  end if;
  return jsonb_build_object('branch', p_branch, 'day', d,
    'days', (select coalesce(jsonb_agg(distinct day order by day desc), '[]'::jsonb) from public.lsh_recon where branch = p_branch),
    'closedAt', (select closed_at from public.lsh_days where branch = p_branch and day = d),
    'rows', private.lsh_recon_json(p_branch, d, true), 'dcc', dcc, 'dccDate', tk.count_date, 'dccAt', at);
end $$;

-- one invoice's lines: what was invoiced, loaded, came back and waits (failed delivery screen)
create or replace function public.lsh_invoice(p_token text, p_doc text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me public.people := private.need_person(p_token);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('code', code, 'invoiced', inv, 'loaded', ld, 'canFail', cf, 'waiting', wt, 'failed', fl) order by code)
    from (select code,
      coalesce(sum(qty) filter (where type = 'invoice'), 0) as inv,
      coalesce(sum(qty) filter (where type = 'load'), 0) as ld,
      coalesce(sum(case when type = 'load' then qty when type = 'fail_back' then -qty when type = 'redeliver' then qty else 0 end), 0) as cf,
      coalesce(sum(case when type = 'invoice' then qty when type = 'load' then -qty else 0 end), 0) as wt,
      coalesce(sum(case when type = 'fail_back' then qty when type in ('reversal', 'redeliver') then -qty else 0 end), 0) as fl
      from public.lsh_moves where branch = me.branch and doc_no = trim(coalesce(p_doc, '')) and status = 'ok'
        and type in ('invoice', 'load', 'fail_back', 'reversal', 'redeliver') group by code) x), '[]'::jsonb);
end $$;

------------------------------------------------------------------ grants
revoke all on function private.kl_date(timestamptz), private.kl_time(timestamptz), private.is_workday(text, date), private.next_workday(text, date),
  private.lsh_bal(text, timestamptz), private.lsh_stg(text), private.lsh_autoclose(text), private.lsh_closing(text, timestamptz), private.lsh_day(text),
  private.lsh_branch_ok(text), private.ctn(text, numeric), private.lsh_warnings(text), private.lsh_build_recon(uuid),
  private.lsh_recon_json(text, date, boolean), private.lsh_stg_json(text) from public, anon, authenticated;
do $$ declare f text; begin
  foreach f in array array[
    'lsh_add(text, jsonb)', 'lsh_load(text, text[], jsonb)', 'lsh_undo(text, uuid)', 'lsh_correct(text, jsonb)', 'lsh_decide(text, uuid, boolean)',
    'lsh_close_day(text, text)', 'lsh_invoice(text, text)', 'lsh_reason(text, text, date, text, text, text, text)', 'lsh_today(text)',
    'admin_load_daily(text, date, jsonb)', 'admin_lsh_branch(text, text, text, boolean, text)', 'admin_lsh_reset(text, text, text, uuid, timestamptz)',
    'admin_lsh(text)', 'admin_lsh_recon(text, text, date)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
