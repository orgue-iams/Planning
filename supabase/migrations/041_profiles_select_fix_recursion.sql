-- Corrige la récursion RLS introduite en 040 : ne pas relire profiles dans la policy SELECT.

create or replace function public.profiles_viewer_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
    select p.role
    from public.profiles p
    where p.id = auth.uid()
    limit 1;
$$;

comment on function public.profiles_viewer_role() is
    'Rôle du compte connecté (security definer, sans récursion RLS profiles).';

revoke all on function public.profiles_viewer_role() from public;
grant execute on function public.profiles_viewer_role() to authenticated;

drop policy if exists "profiles_select_admin_prof_peers" on public.profiles;

create policy "profiles_select_admin_prof_peers" on public.profiles
    for select
    to authenticated
    using (
        auth.uid() = id
        or public.profiles_viewer_role() in ('admin', 'prof')
    );

comment on policy "profiles_select_admin_prof_peers" on public.profiles is
    'Profil connecté ; admin/prof lisent les autres profils (via profiles_viewer_role, sans récursion).';
