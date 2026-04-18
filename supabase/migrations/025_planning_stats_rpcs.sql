-- Statistiques agrégées (prof / admin uniquement).
-- Occupation orgue : cours + travail perso des élèves uniquement + concerts (hors fermetures / autres).
-- Travail perso élèves : créneaux dont le propriétaire a le profil « eleve » (pas prof / admin).

-- ---------------------------------------------------------------------------
-- planning_stats_org_occupation
-- ---------------------------------------------------------------------------
drop function if exists public.planning_stats_org_occupation(timestamptz, timestamptz);

create function public.planning_stats_org_occupation(p_start timestamptz, p_end timestamptz)
returns table (
    category text,
    slot_count bigint,
    hours numeric
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
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

    return query
    with clip as (
        select
            e.slot_type,
            coalesce(pr.role, '') as owner_role,
            greatest(e.start_at, p_start) as s0,
            least(e.end_at, p_end) as e0
        from public.planning_event e
        left join public.profiles pr on pr.id = e.owner_user_id
        where e.start_at < p_end
          and e.end_at > p_start
          and greatest(e.start_at, p_start) < least(e.end_at, p_end)
          and e.slot_type in ('cours', 'travail perso', 'concert')
    ),
    classified as (
        select
            case
                when c.slot_type = 'cours' then 'cours'
                when c.slot_type = 'concert' then 'concert'
                when c.slot_type = 'travail perso' and c.owner_role = 'eleve' then 'travail_perso_eleves'
                else null
            end as cat,
            extract(epoch from (c.e0 - c.s0)) / 3600.0 as hrs
        from clip c
    ),
    per_cat as (
        select
            f.cat,
            count(*)::bigint as n,
            round(sum(f.hrs)::numeric, 2) as h
        from classified f
        where f.cat is not null
        group by f.cat
    ),
    ordered as (
        select
            p.cat as category,
            p.n as slot_count,
            p.h as hours,
            case p.cat
                when 'cours' then 1
                when 'travail_perso_eleves' then 2
                when 'concert' then 3
                else 9
            end as ord
        from per_cat p
        union all
        select
            'total_occupation'::text,
            coalesce(sum(p.n), 0)::bigint,
            coalesce(round(sum(p.h)::numeric, 2), 0::numeric),
            4
        from per_cat p
    )
    select o.category, o.slot_count, o.hours
    from ordered o
    order by o.ord;
end;
$$;

comment on function public.planning_stats_org_occupation(timestamptz, timestamptz) is
    'Heures et nombre de créneaux : cours, travail perso (propriétaires élèves seulement), concerts + ligne total occupation.';

revoke all on function public.planning_stats_org_occupation(timestamptz, timestamptz) from public;
grant execute on function public.planning_stats_org_occupation(timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- planning_stats_eleve_travail_totals (tous les élèves actifs, TP uniquement)
-- ---------------------------------------------------------------------------
drop function if exists public.planning_stats_eleve_travail_totals(timestamptz, timestamptz);

create function public.planning_stats_eleve_travail_totals(p_start timestamptz, p_end timestamptz)
returns table (
    student_user_id uuid,
    display_name text,
    slot_count bigint,
    hours numeric
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
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

    return query
    with active as (
        select
            p.id as uid,
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
        coalesce(g.h, 0::numeric)
    from active a
    left join agg g on g.sid = a.uid
    order by lower(a.dname);
end;
$$;

comment on function public.planning_stats_eleve_travail_totals(timestamptz, timestamptz) is
    'Par élève actif : nombre et heures de travail perso (créneaux réservés) sur la plage.';

revoke all on function public.planning_stats_eleve_travail_totals(timestamptz, timestamptz) from public;
grant execute on function public.planning_stats_eleve_travail_totals(timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- planning_stats_eleve_travail_daily (série temporelle, Europe/Paris)
-- ---------------------------------------------------------------------------
drop function if exists public.planning_stats_eleve_travail_daily(timestamptz, timestamptz, uuid[]);

create function public.planning_stats_eleve_travail_daily(
    p_start timestamptz,
    p_end timestamptz,
    p_student_ids uuid[]
)
returns table (
    day date,
    student_user_id uuid,
    hours numeric
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
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

    if p_student_ids is null or cardinality(p_student_ids) = 0 then
        return;
    end if;

    return query
    select
        ((greatest(e.start_at, p_start) at time zone 'Europe/Paris'))::date as d,
        e.owner_user_id as sid,
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
      and e.owner_user_id = any (p_student_ids)
    group by 1, 2
    order by 1, 2;
end;
$$;

comment on function public.planning_stats_eleve_travail_daily(timestamptz, timestamptz, uuid[]) is
    'Heures de travail perso par jour (fuseau Europe/Paris) et par élève, sur une liste d’élèves.';

revoke all on function public.planning_stats_eleve_travail_daily(timestamptz, timestamptz, uuid[]) from public;
grant execute on function public.planning_stats_eleve_travail_daily(timestamptz, timestamptz, uuid[]) to authenticated;
