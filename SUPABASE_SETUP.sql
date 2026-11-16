-- AnimeVault v1.3.3 — secure per-user cloud storage
-- Run once in Supabase Dashboard -> SQL Editor -> New query.

create table if not exists public.animevault_records (
  owner_id uuid not null references auth.users(id) on delete cascade,
  record_id uuid not null,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted boolean not null default false,
  primary key (owner_id, record_id)
);

create index if not exists animevault_records_owner_updated_idx
  on public.animevault_records (owner_id, updated_at desc);

alter table public.animevault_records enable row level security;

-- Recreate only this app's policies so the script can safely be run again.
drop policy if exists "AnimeVault users can read own records" on public.animevault_records;
drop policy if exists "AnimeVault users can insert own records" on public.animevault_records;
drop policy if exists "AnimeVault users can update own records" on public.animevault_records;

create policy "AnimeVault users can read own records"
  on public.animevault_records for select
  to authenticated
  using (auth.uid() = owner_id);

create policy "AnimeVault users can insert own records"
  on public.animevault_records for insert
  to authenticated
  with check (auth.uid() = owner_id);

create policy "AnimeVault users can update own records"
  on public.animevault_records for update
  to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

grant select, insert, update on public.animevault_records to authenticated;
revoke all on public.animevault_records from anon;
