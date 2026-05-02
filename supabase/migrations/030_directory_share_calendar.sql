-- Partage du nom du planning personnel dans l’annuaire ; RPC annuaire enrichie.

alter table public.profiles
    add column if not exists directory_share_calendar boolean not null default false;

comment on column public.profiles.directory_share_calendar is
    'Si vrai, l’annuaire « Utilisateurs » affiche le libellé du calendrier personnel (pool) aux autres comptes (sinon masqué).';

drop function if exists public.planning_directory_users();

create function public.planning_directory_users()
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
    v_is_admin boolean;
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

    select exists (select 1 from public.profiles pa where pa.id = v_viewer and pa.role = 'admin')
    into v_is_admin;

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
            when v_is_admin or p.id = v_viewer then coalesce(u.email::text, '')
            when coalesce(p.directory_share_email, true) then coalesce(u.email::text, '')
            else ''
        end as email,
        case
            when v_is_admin or p.id = v_viewer then coalesce(p.telephone, '')
            when coalesce(p.directory_share_phone, false) then coalesce(p.telephone, '')
            else ''
        end as telephone,
        case
            when v_is_admin or p.id = v_viewer then coalesce(nullif(trim(both from g.label::text), ''), '')
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
    'Annuaire interne : rôle, prénom/nom, libellé, e-mail, téléphone et planning perso visibles selon partage ou admin / soi-même.';

revoke all on function public.planning_directory_users() from public;
grant execute on function public.planning_directory_users() to authenticated;
