-- E-mails inscrits (cours) dans la RPC grille. SECURITY DEFINER + filtre = politique planning_event_select
-- (les rôles ne peuvent pas lire auth.users en invoker).

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
    inscrits_emails text[]
)
language sql
stable
security definer
set search_path = public, auth
as $$
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
        coalesce(ins.emails, '{}'::text[]) as inscrits_emails
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
    where e.start_at < p_end and e.end_at > p_start
      and (
          exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'prof'))
          or (
              exists (
                  select 1
                  from public.profiles p
                  where p.id = auth.uid() and p.role in ('eleve', 'consultation')
              )
              and (
                  e.slot_type in ('fermeture', 'cours', 'concert', 'autre')
                  or (e.slot_type = 'travail perso' and e.owner_user_id = auth.uid())
              )
          )
      )
    order by e.start_at;
$$;

comment on function public.planning_events_in_range(timestamptz, timestamptz) is
    'Créneaux visibles (équivalent RLS planning_event_select) + miroirs Google + e-mails inscrits cours.';

revoke all on function public.planning_events_in_range(timestamptz, timestamptz) from public;
grant execute on function public.planning_events_in_range(timestamptz, timestamptz) to authenticated;
