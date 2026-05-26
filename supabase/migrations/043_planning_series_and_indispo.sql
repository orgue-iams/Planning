-- Séries périodiques + indisponibilités privées prof.
-- Les occurrences concrètes restent stockées dans planning_event.

create table if not exists public.planning_event_series (
    id uuid primary key default gen_random_uuid(),
    owner_user_id uuid not null references auth.users (id) on delete cascade,
    owner_email text not null,
    slot_type text not null,
    title text not null default '',
    frequency_unit text not null default 'week',
    frequency_interval int not null default 1,
    start_at_first timestamptz not null,
    until_ymd date not null,
    occurrence_limit int,
    source_legacy_template_line_id uuid references public.organ_week_template_line (id) on delete set null,
    status text not null default 'active',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint planning_event_series_slot_type_chk check (
        slot_type in ('cours', 'travail perso', 'concert', 'autre')
    ),
    constraint planning_event_series_frequency_unit_chk check (
        frequency_unit = 'week'
    ),
    constraint planning_event_series_frequency_interval_chk check (
        frequency_interval in (1, 2)
    ),
    constraint planning_event_series_occurrence_limit_chk check (
        occurrence_limit is null or occurrence_limit >= 1
    ),
    constraint planning_event_series_status_chk check (
        status in ('active', 'stopped')
    )
);

create index if not exists planning_event_series_owner_idx
    on public.planning_event_series (owner_user_id, start_at_first);

comment on table public.planning_event_series is
    'Définition des séries périodiques hebdo / bihebdo. Les occurrences restent matérialisées dans planning_event.';

create table if not exists public.planning_event_series_exception (
    id uuid primary key default gen_random_uuid(),
    series_id uuid not null references public.planning_event_series (id) on delete cascade,
    occurrence_start_at timestamptz not null,
    exception_kind text not null,
    payload jsonb not null default '{}'::jsonb,
    created_by_user_id uuid not null references auth.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint planning_event_series_exception_kind_chk check (
        exception_kind in ('skip', 'override', 'detach')
    )
);

create index if not exists planning_event_series_exception_series_idx
    on public.planning_event_series_exception (series_id, occurrence_start_at);

comment on table public.planning_event_series_exception is
    'Exceptions d''une série : suppression d''une occurrence, override local, détachement.';

alter table public.planning_event
    drop constraint if exists planning_event_slot_type_check;

alter table public.planning_event
    add constraint planning_event_slot_type_check check (
        slot_type in ('cours', 'travail perso', 'fermeture', 'concert', 'autre', 'indispo')
    );

alter table public.planning_event
    add column if not exists is_all_day boolean not null default false;

alter table public.planning_event
    add column if not exists series_id uuid references public.planning_event_series (id) on delete set null;

alter table public.planning_event
    add column if not exists series_position int;

create index if not exists planning_event_series_idx
    on public.planning_event (series_id, start_at)
    where series_id is not null;

comment on column public.planning_event.is_all_day is
    'True pour les fermetures journée entière. Les indispos prof gardent une plage horaire explicite.';
comment on column public.planning_event.series_id is
    'Série source si le créneau est généré par une périodicité.';
comment on column public.planning_event.series_position is
    'Position 1..N de l''occurrence dans sa série, utile pour les réécritures futures.';

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
        and (
            slot_type in ('fermeture', 'cours', 'concert', 'autre')
            or (slot_type = 'travail perso' and owner_user_id = auth.uid())
        )
    )
);

drop policy if exists "planning_event_insert" on public.planning_event;
create policy "planning_event_insert" on public.planning_event for insert to authenticated with check (
    owner_user_id = auth.uid()
    and (
        (
            exists (
                select 1
                from public.profiles p
                where p.id = auth.uid() and p.role = 'admin'
            )
            and slot_type in ('cours', 'travail perso', 'fermeture', 'concert', 'autre')
        )
        or (
            exists (
                select 1
                from public.profiles p
                where p.id = auth.uid() and p.role = 'prof'
            )
            and slot_type in ('cours', 'travail perso', 'concert', 'autre', 'indispo')
        )
        or (
            exists (
                select 1
                from public.profiles p
                where p.id = auth.uid() and p.role = 'eleve'
            )
            and slot_type = 'travail perso'
        )
    )
);

drop policy if exists "planning_event_update" on public.planning_event;
create policy "planning_event_update" on public.planning_event for update to authenticated using (
    (
        exists (
            select 1
            from public.profiles p
            where p.id = auth.uid() and p.role = 'admin'
        )
        and slot_type <> 'indispo'
    )
    or owner_user_id = auth.uid()
) with check (
    (
        exists (
            select 1
            from public.profiles p
            where p.id = auth.uid() and p.role = 'admin'
        )
        and slot_type <> 'indispo'
    )
    or owner_user_id = auth.uid()
);

drop policy if exists "planning_event_delete" on public.planning_event;
create policy "planning_event_delete" on public.planning_event for delete to authenticated using (
    (
        exists (
            select 1
            from public.profiles p
            where p.id = auth.uid() and p.role = 'admin'
        )
        and slot_type <> 'indispo'
    )
    or owner_user_id = auth.uid()
);

alter table public.planning_event_series enable row level security;
alter table public.planning_event_series_exception enable row level security;

drop policy if exists "planning_event_series_select" on public.planning_event_series;
create policy "planning_event_series_select" on public.planning_event_series
    for select to authenticated using (
        exists (
            select 1
            from public.profiles p
            where p.id = auth.uid()
              and (
                p.role = 'admin'
                or (p.role = 'prof' and owner_user_id = auth.uid())
              )
        )
    );

drop policy if exists "planning_event_series_insert" on public.planning_event_series;
create policy "planning_event_series_insert" on public.planning_event_series
    for insert to authenticated with check (
        owner_user_id = auth.uid()
        and exists (
            select 1
            from public.profiles p
            where p.id = auth.uid() and p.role in ('admin', 'prof')
        )
    );

drop policy if exists "planning_event_series_update" on public.planning_event_series;
create policy "planning_event_series_update" on public.planning_event_series
    for update to authenticated using (
        (
            exists (
                select 1 from public.profiles p
                where p.id = auth.uid() and p.role = 'admin'
            )
        )
        or owner_user_id = auth.uid()
    ) with check (
        (
            exists (
                select 1 from public.profiles p
                where p.id = auth.uid() and p.role = 'admin'
            )
        )
        or owner_user_id = auth.uid()
    );

drop policy if exists "planning_event_series_delete" on public.planning_event_series;
create policy "planning_event_series_delete" on public.planning_event_series
    for delete to authenticated using (
        (
            exists (
                select 1 from public.profiles p
                where p.id = auth.uid() and p.role = 'admin'
            )
        )
        or owner_user_id = auth.uid()
    );

drop policy if exists "planning_event_series_exception_select" on public.planning_event_series_exception;
create policy "planning_event_series_exception_select" on public.planning_event_series_exception
    for select to authenticated using (
        exists (
            select 1
            from public.planning_event_series s
            join public.profiles p on p.id = auth.uid()
            where s.id = series_id
              and (
                p.role = 'admin'
                or (p.role = 'prof' and s.owner_user_id = auth.uid())
              )
        )
    );

drop policy if exists "planning_event_series_exception_insert" on public.planning_event_series_exception;
create policy "planning_event_series_exception_insert" on public.planning_event_series_exception
    for insert to authenticated with check (
        created_by_user_id = auth.uid()
        and exists (
            select 1
            from public.planning_event_series s
            join public.profiles p on p.id = auth.uid()
            where s.id = series_id
              and (
                p.role = 'admin'
                or (p.role = 'prof' and s.owner_user_id = auth.uid())
              )
        )
    );

drop policy if exists "planning_event_series_exception_update" on public.planning_event_series_exception;
create policy "planning_event_series_exception_update" on public.planning_event_series_exception
    for update to authenticated using (
        exists (
            select 1
            from public.planning_event_series s
            join public.profiles p on p.id = auth.uid()
            where s.id = series_id
              and (
                p.role = 'admin'
                or (p.role = 'prof' and s.owner_user_id = auth.uid())
              )
        )
    ) with check (
        created_by_user_id = auth.uid()
    );

drop policy if exists "planning_event_series_exception_delete" on public.planning_event_series_exception;
create policy "planning_event_series_exception_delete" on public.planning_event_series_exception
    for delete to authenticated using (
        exists (
            select 1
            from public.planning_event_series s
            join public.profiles p on p.id = auth.uid()
            where s.id = series_id
              and (
                p.role = 'admin'
                or (p.role = 'prof' and s.owner_user_id = auth.uid())
              )
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
        or (
            me.role in ('eleve', 'consultation')
            and (
                e.slot_type in ('fermeture', 'cours', 'concert', 'autre')
                or (e.slot_type = 'travail perso' and e.owner_user_id = me.id)
            )
        )
      )
    order by e.start_at;
$$;

revoke all on function public.planning_events_in_range(timestamptz, timestamptz) from public;
grant execute on function public.planning_events_in_range(timestamptz, timestamptz) to authenticated;

grant select, insert, update, delete on public.planning_event_series to authenticated;
grant select, insert, update, delete on public.planning_event_series_exception to authenticated;
