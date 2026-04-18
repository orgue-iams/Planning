-- Téléphone + préférences d’annuaire ; display_name = « Prénom Nom » ; stats élèves (tri, moy./sem.) ; RPC annuaire.

alter table public.profiles
    add column if not exists telephone text not null default '',
    add column if not exists directory_share_email boolean not null default true,
    add column if not exists directory_share_phone boolean not null default false;

comment on column public.profiles.telephone is 'Numéro de téléphone (facultatif).';
comment on column public.profiles.directory_share_email is
    'Si vrai, l’annuaire « Utilisateurs » affiche l’e-mail aux autres comptes (sinon masqué).';
comment on column public.profiles.directory_share_phone is
    'Si vrai, l’annuaire affiche le téléphone aux autres comptes (sinon masqué).';

-- Libellé complet : prénom puis nom (cohérent UI / RPC libellés).
create or replace function public.profiles_sync_display_name()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_n text;
    v_p text;
begin
    v_n := nullif(trim(both from coalesce(new.nom, '')), '');
    v_p := nullif(trim(both from coalesce(new.prenom, '')), '');
    if v_n is not null or v_p is not null then
        new.display_name := nullif(trim(both from concat_ws(' ', v_p, v_n)), '');
    end if;
    return new;
end;
$$;

update public.profiles
set nom = nom
where trim(coalesce(nom, '')) <> ''
   or trim(coalesce(prenom, '')) <> '';

-- Inscription : même ordre d’affichage + libellés réservation.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_role text;
    v_nom text;
    v_prenom text;
    v_tel text;
    v_display text;
    v_reservation jsonb;
begin
    v_role := lower(trim(coalesce(new.raw_user_meta_data ->> 'role', 'eleve')));
    if v_role not in ('eleve', 'prof') then
        v_role := 'eleve';
    end if;

    v_nom := trim(coalesce(new.raw_user_meta_data ->> 'nom', ''));
    v_prenom := trim(coalesce(new.raw_user_meta_data ->> 'prenom', ''));
    v_tel := trim(coalesce(new.raw_user_meta_data ->> 'telephone', ''));

    if v_nom = '' and v_prenom = '' then
        v_nom := coalesce(
            nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
            split_part(new.email, '@', 1),
            ''
        );
    end if;

    v_display := nullif(trim(both from concat_ws(' ', nullif(v_prenom, ''), nullif(v_nom, ''))), '');

    if v_display is not null and v_display <> '' then
        v_reservation := jsonb_build_object(
            'labels', jsonb_build_array(v_display),
            'favoriteLabel', v_display
        );
    else
        v_reservation := '{"labels":[],"favoriteLabel":""}'::jsonb;
    end if;

    insert into public.profiles (id, nom, prenom, role, reservation_types, telephone)
    values (new.id, v_nom, v_prenom, v_role, v_reservation, v_tel)
    on conflict (id) do nothing;

    return new;
end;
$$;

-- Liste admin : champs contact + partage annuaire.
create or replace function public.planning_admin_list_auth_users()
returns json
language sql
security definer
set search_path = public, auth
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'id', u.id,
        'email', u.email,
        'created_at', u.created_at,
        'banned_until', u.banned_until,
        'nom', coalesce(p.nom, ''),
        'prenom', coalesce(p.prenom, ''),
        'display_name', p.display_name,
        'profile_role', p.role,
        'telephone', coalesce(p.telephone, ''),
        'directory_share_email', coalesce(p.directory_share_email, true),
        'directory_share_phone', coalesce(p.directory_share_phone, false),
        'calendar_assignment_error', p.calendar_assignment_error,
        'personal_google_calendar_id', g.google_calendar_id,
        'personal_calendar_label', g.label
      )
      order by
        lower(trim(coalesce(p.nom, ''))),
        lower(trim(coalesce(p.prenom, ''))),
        lower(coalesce(u.email, ''))
    ),
    '[]'::json
  )
  from auth.users u
  left join public.profiles p on p.id = u.id
  left join public.google_calendar_pool g on g.assigned_user_id = u.id;
$$;

-- Libellé display_name : Prénom Nom (colonnes nom / prénom inchangées pour le tri côté client).
create or replace function public.planning_list_eleves_actifs()
returns table (user_id uuid, email text, display_name text, nom text, prenom text)
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
                        nullif(trim(both from coalesce(p.prenom, '')), ''),
                        nullif(trim(both from coalesce(p.nom, '')), '')
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

-- ---------------------------------------------------------------------------
-- Statistiques : totaux élèves + moyenne hebdomadaire + tri réservations puis nom
-- ---------------------------------------------------------------------------
drop function if exists public.planning_stats_eleve_travail_totals(timestamptz, timestamptz);

create function public.planning_stats_eleve_travail_totals(p_start timestamptz, p_end timestamptz)
returns table (
    student_user_id uuid,
    display_name text,
    slot_count bigint,
    hours numeric,
    hours_per_week numeric
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
    v_weeks numeric;
begin
    if not exists (
        select 1
        from public.profiles p
        where p.id = auth.uid()
          and p.role in ('admin', 'prof')
    ) then
        raise exception 'Accès statistiques réservé aux professeurs et administrateurs.'
            using errcode = '42501';
    end if;

    if p_start is null or p_end is null or p_end <= p_start then
        return;
    end if;

    v_weeks := greatest(
        (
            (
                (p_end at time zone 'Europe/Paris')::date
                - (p_start at time zone 'Europe/Paris')::date
                + 1
            )::numeric
            / 7.0
        ),
        0.000001::numeric
    );

    return query
    with active as (
        select
            p.id as uid,
            lower(trim(both from coalesce(p.nom, ''))) as sort_nom,
            lower(trim(both from coalesce(p.prenom, ''))) as sort_prenom,
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
            ) as dname
        from public.profiles p
        join auth.users u on u.id = p.id
        where p.role = 'eleve'
          and (u.banned_until is null or u.banned_until <= now())
    ),
    agg as (
        select
            e.owner_user_id as sid,
            count(*)::bigint as n,
            round(
                sum(
                    extract(
                        epoch from (
                            least(e.end_at, p_end) - greatest(e.start_at, p_start)
                        )
                    ) / 3600.0
                )::numeric,
                2
            ) as h
        from public.planning_event e
        join public.profiles pr on pr.id = e.owner_user_id and pr.role = 'eleve'
        where e.slot_type = 'travail perso'
          and e.start_at < p_end
          and e.end_at > p_start
          and greatest(e.start_at, p_start) < least(e.end_at, p_end)
        group by e.owner_user_id
    )
    select
        a.uid,
        a.dname,
        coalesce(g.n, 0::bigint),
        coalesce(g.h, 0::numeric),
        round((coalesce(g.h, 0::numeric) / v_weeks)::numeric, 2)
    from active a
    left join agg g on g.sid = a.uid
    order by
        coalesce(g.n, 0::bigint) desc,
        coalesce(g.h, 0::numeric) desc,
        a.sort_nom,
        a.sort_prenom;
end;
$$;

comment on function public.planning_stats_eleve_travail_totals(timestamptz, timestamptz) is
    'Par élève actif : créneaux et heures TP ; moyenne h/semaine (plage en jours calendaires Paris / 7) ; tri par volume puis nom.';

revoke all on function public.planning_stats_eleve_travail_totals(timestamptz, timestamptz) from public;
grant execute on function public.planning_stats_eleve_travail_totals(timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- Annuaire « Utilisateurs » : masquage selon préférences + admin voit tout
-- ---------------------------------------------------------------------------
drop function if exists public.planning_directory_users();

create function public.planning_directory_users()
returns table (
    role text,
    user_id uuid,
    display_name text,
    email text,
    telephone text
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
        p.role::text,
        p.id,
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
        ) as dname,
        case
            when v_is_admin or p.id = v_viewer then coalesce(u.email::text, '')
            when coalesce(p.directory_share_email, true) then coalesce(u.email::text, '')
            else ''
        end as email_out,
        case
            when v_is_admin or p.id = v_viewer then coalesce(p.telephone, '')
            when coalesce(p.directory_share_phone, false) then coalesce(p.telephone, '')
            else ''
        end as phone_out
    from public.profiles p
    join auth.users u on u.id = p.id
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
    'Annuaire interne : rôle, libellé, e-mail et téléphone visibles selon partage ou compte admin / soi-même.';

revoke all on function public.planning_directory_users() from public;
grant execute on function public.planning_directory_users() to authenticated;
