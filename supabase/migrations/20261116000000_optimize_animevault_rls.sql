-- Keep auth.uid() evaluation stable per statement for AnimeVault row policies.
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
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
