-- Élèves actifs : exposer nom / prénom pour affichage « Prénom Nom » et tri par nom.
-- Libellés profil pour une liste d’ids (staff : gabarit semaines types).

drop function if exists public.planning_list_eleves_actifs();

create function public.planning_list_eleves_actifs()
returns table (
    user_id uuid,
    email text,
    display_name text,
    nom text,
    prenom text
)
language sql
security definer
set search_path = public, auth
stable
as $$
    select
        p.id,
        u.email::text,
        coalesce(
            nullif(
                trim(
                    both
                    from concat_ws(
                        ' ',
                        nullif(trim(both from coalesce(p.nom, '')), ''),
                        nullif(trim(both from coalesce(p.prenom, '')), '')
                    )
                ),
                ''
            ),
            nullif(trim(both from coalesce(p.display_name, '')), ''),
            u.email::text
        ),
        coalesce(nullif(trim(both from p.nom), ''), ''),
        coalesce(nullif(trim(both from p.prenom), ''), '')
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.role = 'eleve'
      and (u.banned_until is null or u.banned_until <= now());
$$;

revoke all on function public.planning_list_eleves_actifs() from public;
grant execute on function public.planning_list_eleves_actifs() to authenticated;

comment on function public.planning_list_eleves_actifs() is
    'Élèves actifs : id, email, display_name (nom prénom), nom, prénom pour tri et libellés.';

create or replace function public.planning_profiles_label_for_ids(p_ids uuid[])
returns table (user_id uuid, label text)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
    if p_ids is null or cardinality(p_ids) = 0 then
        return;
    end if;

    if not exists (
        select 1
        from public.profiles p0
        where p0.id = auth.uid()
          and p0.role in ('admin', 'prof')
    ) then
        return;
    end if;

    return query
    select
        p.id,
        nullif(
            trim(
                both
                from concat_ws(
                    ' ',
                    nullif(trim(both from coalesce(p.prenom, '')), ''),
                    nullif(trim(both from coalesce(p.nom, '')), '')
                )
            ),
            ''
        ) as label
    from public.profiles p
    where p.id = any (p_ids);
end;
$$;

revoke all on function public.planning_profiles_label_for_ids(uuid[]) from public;
grant execute on function public.planning_profiles_label_for_ids(uuid[]) to authenticated;

comment on function public.planning_profiles_label_for_ids(uuid[]) is
    'Libellé « Prénom Nom » pour une liste d’utilisateurs (prof/admin uniquement).';
