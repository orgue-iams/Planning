-- Prof / admin : lire id + role des autres comptes pour que les politiques RLS planning_event
-- (sous-requêtes sur profiles po) ne renvoient pas 0 ligne → 406 / 403 côté client.

drop policy if exists "profiles_select_admin_prof_peers" on public.profiles;

create policy "profiles_select_admin_prof_peers" on public.profiles
    for select
    to authenticated
    using (
        auth.uid() = id
        or exists (
            select 1
            from public.profiles viewer
            where viewer.id = auth.uid()
              and viewer.role in ('admin', 'prof')
        )
    );

comment on policy "profiles_select_admin_prof_peers" on public.profiles is
    'Lecture du profil connecté ; admin/prof peuvent lire les profils des autres (RLS planning_event / annuaire).';
