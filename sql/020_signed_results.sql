-- 020: signed sign-off copies per warehouse, and saved final results for the public dashboard.

-- 1) Signed copies: the scanned, signed sign-off PDF of a warehouse for a stock take.
--    Files live in the private "signoffs" bucket; only the photos edge function (service role) writes them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('signoffs', 'signoffs', false, 52428800, array['application/pdf'])
on conflict (id) do nothing;

create table if not exists public.signed_copies (
  take_id uuid not null references public.stock_takes(id) on delete cascade,
  branch text not null,
  path text not null,
  file_name text not null,
  size bigint not null default 0,
  uploaded_at timestamptz not null default now(),
  uploaded_by text,
  primary key (take_id, branch)
);
alter table public.signed_copies enable row level security;

create or replace function public.admin_signed_list(p_token text, p_take uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.need_admin(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object('branch', branch, 'name', file_name, 'size', size, 'at', uploaded_at, 'by', uploaded_by) order by branch)
    from public.signed_copies where take_id = p_take), '[]'::jsonb);
end $$;

-- 2) Final results, saved by the admin app when it shows a closed stock take (same numbers as its final view).
--    data = {v, take{...}, wh[{b, ira, final, res{...}, nSku, rm{sys,counted,net,abs}}], nat{ira, onTarget}, rm{sys,counted,net,abs,top[...]}}
--    Everything under "rm" is money and is only returned to someone with the admin password.
create table if not exists public.take_results (
  take_id uuid primary key references public.stock_takes(id) on delete cascade,
  data jsonb not null,
  saved_at timestamptz not null default now()
);
alter table public.take_results enable row level security;

create or replace function public.admin_save_results(p_token text, p_take uuid, p_data jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare st text;
begin
  perform private.need_admin(p_token);
  select status into st from public.stock_takes where id = p_take and kind = 'monthly';
  if st is null then raise exception 'Stock take not found'; end if;
  if st <> 'closed' then
    delete from public.take_results where take_id = p_take;   -- reopened: no final results any more
    return jsonb_build_object('ok', false, 'reason', 'not closed');
  end if;
  if jsonb_typeof(p_data -> 'wh') is distinct from 'array' then raise exception 'Bad results'; end if;
  insert into public.take_results (take_id, data, saved_at) values (p_take, p_data, now())
  on conflict (take_id) do update set data = excluded.data, saved_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- closed monthly stock takes that have results, newest first (no money)
create or replace function public.public_results_list()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'closedAt', t.closed_at, 'openedAt', t.opened_at,
      'kpiMonth', t.kpi_month, 'imported', coalesce((r.data -> 'take' ->> 'imported')::boolean, false))
    order by coalesce(t.closed_at, t.started_at) desc), '[]'::jsonb)
  from public.take_results r join public.stock_takes t on t.id = r.take_id
  where t.status = 'closed' and t.kind = 'monthly';
$$;

-- one stock take's results. RM only with the owner/Finance password (or an admin token from the app on this device).
create or replace function public.public_results(p_take uuid, p_password text default null, p_token text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare d jsonb; ok boolean := false; oh text; fh text;
begin
  select r.data into d from public.take_results r join public.stock_takes t on t.id = r.take_id
   where r.take_id = p_take and t.status = 'closed';
  if d is null then raise exception 'These results are not available.'; end if;
  if p_token is not null and private.tok_kind(p_token) in ('owner', 'finance') then ok := true;
  elsif coalesce(p_password, '') <> '' then
    perform private.too_many('admin');
    select value into oh from private.secrets where key = 'owner_hash';
    select value into fh from private.secrets where key = 'finance_hash';
    ok := (oh is not null and extensions.crypt(p_password, oh) = oh) or (fh is not null and extensions.crypt(p_password, fh) = fh);
    if not ok then
      insert into public.login_attempts (key, ok) values ('admin', false);   -- kept (no exception), so too_many() counts it
      return jsonb_build_object('wrongPassword', true);
    end if;
  end if;
  if not ok then
    d := d - 'rm';
    d := jsonb_set(d, '{wh}', coalesce((select jsonb_agg(e - 'rm' order by o) from jsonb_array_elements(d -> 'wh') with ordinality x(e, o)), '[]'::jsonb));
  end if;
  return d || jsonb_build_object('withRM', ok, 'savedAt', (select saved_at from public.take_results where take_id = p_take));
end $$;

revoke all on function public.admin_signed_list(text, uuid) from public;
revoke all on function public.admin_save_results(text, uuid, jsonb) from public;
revoke all on function public.public_results_list() from public;
revoke all on function public.public_results(uuid, text, text) from public;
grant execute on function public.admin_signed_list(text, uuid) to anon, authenticated;
grant execute on function public.admin_save_results(text, uuid, jsonb) to anon, authenticated;
grant execute on function public.public_results_list() to anon, authenticated;
grant execute on function public.public_results(uuid, text, text) to anon, authenticated;
