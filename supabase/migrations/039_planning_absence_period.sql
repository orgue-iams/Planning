-- Périodes d'absence / fermeture : brouillon (applied_at null) puis application (créneaux + décalage prof).

create table if not exists public.planning_absence_period (
    id uuid primary key default gen_random_uuid(),
    created_by_user_id uuid not null references auth.users (id) on delete cascade,
    start_ymd date not null,
    end_ymd date not null,
    title text not null default 'Fermeture',
    applied_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint planning_absence_period_dates_chk check (end_ymd >= start_ymd)
);

create index if not exists planning_absence_period_created_by_idx
    on public.planning_absence_period (created_by_user_id);

create index if not exists planning_absence_period_range_idx
    on public.planning_absence_period (start_ymd, end_ymd);

comment on table public.planning_absence_period is
    'Périodes d''indisponibilité (admin = institut, prof = personnelles). applied_at renseigné après application.';

alter table public.planning_event
    add column if not exists absence_period_id uuid references public.planning_absence_period (id) on delete set null;

create index if not exists planning_event_absence_period_idx
    on public.planning_event (absence_period_id)
    where absence_period_id is not null;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.planning_absence_period enable row level security;

drop policy if exists "planning_absence_period_select" on public.planning_absence_period;
create policy "planning_absence_period_select" on public.planning_absence_period
    for select to authenticated
    using (
        exists (
            select 1
            from public.profiles p
            where p.id = auth.uid() and p.role in ('admin', 'prof')
        )
    );

drop policy if exists "planning_absence_period_insert" on public.planning_absence_period;
create policy "planning_absence_period_insert" on public.planning_absence_period
    for insert to authenticated
    with check (
        created_by_user_id = auth.uid()
        and exists (
            select 1
            from public.profiles p
            where p.id = auth.uid() and p.role in ('admin', 'prof')
        )
    );

drop policy if exists "planning_absence_period_update" on public.planning_absence_period;
create policy "planning_absence_period_update" on public.planning_absence_period
    for update to authenticated
    using (created_by_user_id = auth.uid() and applied_at is null)
    with check (created_by_user_id = auth.uid());

drop policy if exists "planning_absence_period_delete" on public.planning_absence_period;
create policy "planning_absence_period_delete" on public.planning_absence_period
    for delete to authenticated
    using (created_by_user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- planning_events_in_range : absence_period_id
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
    gabarit_week_type text,
    created_by_user_id uuid,
    last_modified_by_user_id uuid,
    absence_period_id uuid
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
        e.gabarit_week_type,
        e.created_by_user_id,
        e.last_modified_by_user_id,
        e.absence_period_id
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
      and exists (select 1 from public.profiles p where p.id = auth.uid())
    order by e.start_at;
$$;

revoke all on function public.planning_events_in_range(timestamptz, timestamptz) from public;
grant execute on function public.planning_events_in_range(timestamptz, timestamptz) to authenticated;
