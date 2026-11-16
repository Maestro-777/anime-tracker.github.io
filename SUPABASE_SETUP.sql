-- AnimeVault v1.4.0 — secure per-user cloud sync (Google Drive poster files)
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
  using ((select auth.uid()) = owner_id);

create policy "AnimeVault users can insert own records"
  on public.animevault_records for insert
  to authenticated
  with check ((select auth.uid()) = owner_id);

create policy "AnimeVault users can update own records"
  on public.animevault_records for update
  to authenticated
  using (auth.uid() = owner_id)
  with check ((select auth.uid()) = owner_id);

grant select, insert, update on public.animevault_records to authenticated;
revoke all on public.animevault_records from anon;


-- AnimeVault poster storage. Bucket is public for stable image URLs;
-- uploads/replacements/deletes are restricted to the authenticated owner's folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'animevault-posters',
  'animevault-posters',
  true,
  10485760,
  array['image/jpeg','image/png','image/webp','image/gif','image/avif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "AnimeVault users can upload own posters" on storage.objects;
drop policy if exists "AnimeVault users can update own posters" on storage.objects;
drop policy if exists "AnimeVault users can delete own posters" on storage.objects;

create policy "AnimeVault users can upload own posters"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'animevault-posters'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "AnimeVault users can update own posters"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'animevault-posters'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'animevault-posters'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "AnimeVault users can delete own posters"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'animevault-posters'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
