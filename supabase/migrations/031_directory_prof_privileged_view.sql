-- Annuaire : les professeurs voient les coordonnées complètes (comme les admins), pas seulement selon les cases de partage.

create or replace function public.planning_directory_users()
returns table (
    role text,
    user_id uuid,
    prenom text,
    nom text,
    display_name text,
    email text,
    telephone text,
    calendar_label text
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
    v_viewer uuid;
    v_privileged boolean;
begin
    v_viewer := auth.uid();
    if v_viewer is null then
        raise exception 'Non authentifié' using errcode = '28000';
    end if;

    if not exists (
        select 1
        from public.profiles p0
        where p0.id = v_viewer
          and p0.role in ('admin', 'prof', 'eleve')
    ) then
        raise exception 'Accès annuaire refusé.' using errcode = '42501';
    end if;

    select exists (
        select 1 from public.profiles pa where pa.id = v_viewer and pa.role in ('admin', 'prof')
    )
    into v_privileged;

    return query
    select
        p.role::text as role,
        p.id as user_id,
        coalesce(nullif(trim(both from p.prenom::text), ''), '')::text as prenom,
        coalesce(nullif(trim(both from p.nom::text), ''), '')::text as nom,
        coalesce(
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
            ),
            nullif(trim(both from coalesce(p.display_name, '')), ''),
            u.email::text
        ) as display_name,
        case
            when v_privileged or p.id = v_viewer then coalesce(u.email::text, '')
            when coalesce(p.directory_share_email, true) then coalesce(u.email::text, '')
            else ''
        end as email,
        case
            when v_privileged or p.id = v_viewer then coalesce(p.telephone, '')
            when coalesce(p.directory_share_phone, false) then coalesce(p.telephone, '')
            else ''
        end as telephone,
        case
            when v_privileged or p.id = v_viewer then coalesce(nullif(trim(both from g.label::text), ''), '')
            when coalesce(p.directory_share_calendar, false) then coalesce(nullif(trim(both from g.label::text), ''), '')
            else ''
        end as calendar_label
    from public.profiles p
    join auth.users u on u.id = p.id
    left join public.google_calendar_pool g on g.assigned_user_id = p.id
    where p.role in ('admin', 'prof', 'eleve')
      and (u.banned_until is null or u.banned_until <= now())
    order by
        case p.role
            when 'admin' then 1
            when 'prof' then 2
            else 3
        end,
        lower(trim(both from coalesce(p.nom, ''))),
        lower(trim(both from coalesce(p.prenom, '')));
end;
$$;

comment on function public.planning_directory_users() is
    'Annuaire interne : admin et prof voient toutes les coordonnées ; élèves selon préférences de partage.';
