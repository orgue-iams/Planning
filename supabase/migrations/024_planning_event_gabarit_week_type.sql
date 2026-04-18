-- Semaine gabarit A/B affichée sur les créneaux « cours » issus du gabarit (pas les cours créés manuellement).

alter table public.planning_event
    add column if not exists gabarit_week_type text
    constraint planning_event_gabarit_week_type_chk
    check (gabarit_week_type is null or gabarit_week_type in ('A', 'B'));

comment on column public.planning_event.gabarit_week_type is
    'Semaine type du gabarit (A ou B) pour un cours posé depuis les semaines types ; null si cours manuel ou non concerné.';

-- Rétro-remplissage si le lien gabarit existe déjà en base.
update public.planning_event e
set gabarit_week_type = l.week_type::text
from public.organ_week_template_line l
where e.source_template_line_id = l.id
  and e.slot_type = 'cours'
  and (e.gabarit_week_type is null or e.gabarit_week_type <> l.week_type::text);

-- ---------------------------------------------------------------------------
-- planning_events_in_range : colonne gabarit_week_type
-- ---------------------------------------------------------------------------
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
    gabarit_week_type text
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
        coalesce(ins.emails, '{}'::text[]) as inscrits_emails,
        e.source_template_line_id,
        e.gabarit_week_type
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
    'Créneaux visibles + miroirs + inscrits + gabarit (ligne + semaine type A/B).';

revoke all on function public.planning_events_in_range(timestamptz, timestamptz) from public;
grant execute on function public.planning_events_in_range(timestamptz, timestamptz) to authenticated;
