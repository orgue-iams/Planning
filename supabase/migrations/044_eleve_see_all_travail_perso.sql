-- Élèves / consultation : revoir tous les créneaux d’occupation (y compris travail perso d’autrui),
-- comme 021 / 027 — évite les plages « prises » invisibles sur l’orgue partagé.
-- Les indispo restent masquées (sauf propriétaire côté prof).

drop policy if exists "planning_event_select" on public.planning_event;
create policy "planning_event_select" on public.planning_event for select to authenticated using (
    (
        exists (
            select 1
            from public.profiles p
            where p.id = auth.uid()
              and p.role = 'admin'
        )
        and slot_type <> 'indispo'
    )
    or (
        exists (
            select 1
            from public.profiles p
            where p.id = auth.uid() and p.role = 'prof'
        )
        and (slot_type <> 'indispo' or owner_user_id = auth.uid())
    )
    or (
        exists (
            select 1
            from public.profiles p
            where p.id = auth.uid() and p.role in ('eleve', 'consultation')
        )
        and slot_type <> 'indispo'
    )
);

drop function if exists public.planning_events_in_range(timestamptz, timestamptz);

create function public.planning_events_in_range(p_start timestamptz, p_end timestamptz)
returns table (
    id uuid,
    title text,
    start_at timestamptz,
    end_at timestamptz,
    slot_type text,
    owner_user_id uuid,
    owner_email text,
    main_google_event_id text,
    pool_google_event_id text,
    inscrits_emails text[],
    source_template_line_id uuid,
    gabarit_week_type text,
    created_by_user_id uuid,
    last_modified_by_user_id uuid,
    absence_period_id uuid,
    is_all_day boolean,
    series_id uuid,
    series_position int
)
language sql
stable
security definer
set search_path = public, auth
as $$
    with me as (
        select p.id, lower(trim(coalesce(p.role, ''))) as role
        from public.profiles p
        where p.id = auth.uid()
        limit 1
    )
    select
        e.id,
        e.title,
        e.start_at,
        e.end_at,
        e.slot_type,
        e.owner_user_id,
        e.owner_email,
        m_main.google_event_id,
        m_pool.google_event_id,
        coalesce(ins.emails, '{}'::text[]) as inscrits_emails,
        e.source_template_line_id,
        e.gabarit_week_type,
        e.created_by_user_id,
        e.last_modified_by_user_id,
        e.absence_period_id,
        e.is_all_day,
        e.series_id,
        e.series_position
    from public.planning_event e
    left join lateral (
        select gm.google_event_id
        from public.planning_event_google_mirror gm
        where gm.event_id = e.id
          and gm.target = 'main'
          and gm.sync_status = 'ok'
        limit 1
    ) m_main on true
    left join lateral (
        select gm.google_event_id
        from public.planning_event_google_mirror gm
        where gm.event_id = e.id
          and gm.target = 'pool_owner'
          and gm.sync_status = 'ok'
        limit 1
    ) m_pool on true
    left join lateral (
        select
            array_agg(lower(trim(u.email::text)) order by u.email) filter (
                where u.email is not null and trim(u.email::text) <> ''
            ) as emails
        from public.planning_event_enrollment en
        join auth.users u on u.id = en.student_user_id
        where en.event_id = e.id
    ) ins on true
    cross join me
    where e.start_at < p_end and e.end_at > p_start
      and (
        (me.role = 'admin' and e.slot_type <> 'indispo')
        or (me.role = 'prof' and (e.slot_type <> 'indispo' or e.owner_user_id = me.id))
        or (me.role in ('eleve', 'consultation') and e.slot_type <> 'indispo')
      )
    order by e.start_at;
$$;

comment on function public.planning_events_in_range(timestamptz, timestamptz) is
    'Créneaux visibles selon le rôle : élèves voient toute l’occupation (hors indispo), y compris travail perso d’autrui.';

revoke all on function public.planning_events_in_range(timestamptz, timestamptz) from public;
grant execute on function public.planning_events_in_range(timestamptz, timestamptz) to authenticated;
