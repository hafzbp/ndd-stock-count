-- NDD Stock Count: schema
-- Every table is closed to the public API (RLS on, no policies, privileges revoked).
-- The app reaches data only through the functions in 002_functions.sql, which check a token.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Key/value settings. New features add a key here instead of changing tables.
create table public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Secrets (password hashes, setup code). Never returned to any client.
create table private.secrets (
  key text primary key,
  value text not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.stock_takes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  started_at timestamptz not null default now(),
  closed boolean not null default false,
  reset_id text not null default encode(extensions.gen_random_bytes(6), 'hex')
);

create table public.branches (
  name text primary key,
  pin text,                       -- 4-6 digits, blank = no PIN. Readable only by admin functions.
  active boolean not null default true,
  sort int not null default 0
);

create table public.team (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  branch text not null references public.branches(name) on update cascade on delete cascade,
  role text not null check (role in ('Counter', 'Checker'))
);

create table public.skus (
  code text primary key,
  descr text not null default '',
  per numeric,                    -- pcs per carton
  per_box numeric,                -- pcs per box
  updated_at timestamptz not null default now()
);

create table public.barcodes (
  barcode text primary key,
  code text not null,
  uom text not null default 'PCS' check (uom in ('PCS', 'BOX', 'CTN')),
  updated_at timestamptz not null default now()
);

create table public.sys_stock (
  take_id uuid not null references public.stock_takes(id) on delete cascade,
  branch text not null,
  code text not null,
  batch text not null default '',
  qty numeric not null,
  unit_cost numeric,
  sloc text,
  primary key (take_id, branch, code, batch)
);

create table public.mb52_meta (
  take_id uuid primary key references public.stock_takes(id) on delete cascade,
  data jsonb not null,
  loaded_at timestamptz not null default now()
);

create table public.count_sessions (
  id uuid primary key default gen_random_uuid(),
  take_id uuid not null references public.stock_takes(id) on delete cascade,
  device_id text not null,
  branch text not null,
  role text not null check (role in ('ops', 'fin')),
  data jsonb not null default '{}'::jsonb,   -- member, names, countedBy, lines, extraSkus, sign, startedAt
  status text not null default 'counting' check (status in ('counting', 'submitted')),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  reopened_at timestamptz,
  unique (take_id, device_id, branch, role)
);
create index count_sessions_take_branch on public.count_sessions (take_id, branch);

create table public.recount (
  take_id uuid not null references public.stock_takes(id) on delete cascade,
  branch text not null,
  items text[] not null default '{}',
  sent_at timestamptz not null default now(),
  primary key (take_id, branch)
);

create table public.session_photos (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.count_sessions(id) on delete cascade,
  path text not null,
  created_at timestamptz not null default now()
);
create index session_photos_session on public.session_photos (session_id);

create table public.tokens (
  token text primary key,
  kind text not null check (kind in ('branch', 'finance', 'owner')),
  branch text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table public.login_attempts (
  id bigserial primary key,
  key text not null,
  ok boolean not null,
  at timestamptz not null default now()
);
create index login_attempts_key_at on public.login_attempts (key, at);

-- Lock everything down.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
alter table private.secrets enable row level security;

-- Defaults
insert into public.settings (key, value) values
  ('title', '"NDD Stock Count"'),
  ('tolerance', '2'),
  ('photo_min', '3'),
  ('photo_max', '5'),
  ('photo_roles', '["ops","fin"]'),
  ('dash_level', '"progress"');

with t as (insert into public.stock_takes (name) values ('Stock take 2026') returning id)
insert into public.settings (key, value) select 'current_take', to_jsonb(id::text) from t;

-- Private bucket for warehouse photos (written only by the photos edge function).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 3145728, array['image/jpeg']);
