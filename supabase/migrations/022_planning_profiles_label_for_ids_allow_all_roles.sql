-- Allow planning_profiles_label_for_ids to be used by all authenticated planning roles.
-- This enables UI strings "Réservé par / Modifié par" to always show "Prénom Nom".

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

    -- Toute personne authentifiée avec un rôle planning peut récupérer des libellés.
    -- (Les données restent non sensibles : prenom/nom pour affichage UI.)
    if not exists (
        select 1
        from public.profiles p0
        where p0.id = auth.uid()
          and p0.role in ('admin', 'prof', 'eleve', 'consultation')
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

