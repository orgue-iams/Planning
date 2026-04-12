-- Source de vérité : événements planning en base. Google = miroirs (tables + sync dans une phase ultérieure).
-- RLS : visibilité grille alignée archi (prof/admin tout ; élève/consultation hors travail perso des autres).

-- ---------------------------------------------------------------------------
-- Paramètres : e-mail digest erreurs infra (nocturne)
-- ---------------------------------------------------------------------------
alter table public.organ_school_settings
    add column if not exists planning_error_notify_email text;

update public.organ_school_settings
set planning_error_notify_email = coalesce(
        nullif(trim(planning_error_notify_email), ''),
        'nicolas.marestin@yahoo.fr'
    )
where id = 1;

alter table public.organ_school_settings
    alter column planning_error_notify_email set default 'nicolas.marestin@yahoo.fr';

comment on column public.organ_school_settings.planning_error_notify_email is
    'Destinataire du digest nocturne des erreurs infra (DB, Google bridge, e-mail).';

-- ---------------------------------------------------------------------------
-- Événement canonique
-- ---------------------------------------------------------------------------
create table if not exists public.planning_event (
    id uuid primary key default gen_random_uuid(),
    start_at timestamptz not null,
    end_at timestamptz not null,
    slot_type text not null,
    title text not null default '',
    owner_user_id uuid not null references auth.users (id) on delete restrict,
    owner_email text not null,
    sync_generation int not null default 1,
    source_template_line_id uuid references public.organ_week_template_line (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint planning_event_time_order check (start_at < end_at),
    constraint planning_event_slot_type_check check (
        slot_type in ('cours', 'travail perso', 'fermeture', 'concert', 'autre')
    )
);

create index if not exists planning_event_range_idx on public.planning_event using btree (start_at, end_at);
create index if not exists planning_event_owner_idx on public.planning_event (owner_user_id);

comment on table public.planning_event is
    'Créneau planning (vérité). Types : cours, travail perso, fermeture, concert, autre.';

-- ---------------------------------------------------------------------------
-- Inscriptions cours
-- ---------------------------------------------------------------------------
create table if not exists public.planning_event_enrollment (
    event_id uuid not null references public.planning_event (id) on delete cascade,
    student_user_id uuid not null references auth.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (event_id, student_user_id)
);

create index if not exists planning_event_enrollment_student_idx
    on public.planning_event_enrollment (student_user_id);

comment on table public.planning_event_enrollment is
    'Élèves inscrits à un créneau slot_type = cours.';

-- ---------------------------------------------------------------------------
-- Miroirs Google (état par calendrier cible ; sync dans phase ultérieure)
-- ---------------------------------------------------------------------------
create table if not exists public.planning_event_google_mirror (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.planning_event (id) on delete cascade,
    target text not null,
    target_user_id uuid references auth.users (id) on delete cascade,
    google_calendar_id text not null default '',
    google_event_id text,
    sync_status text not null default 'pending',
    last_error text,
    attempt_count int not null default 0,
    first_attempt_at timestamptz,
    last_attempt_at timestamptz,
    sync_generation int not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint planning_event_google_mirror_target_check check (
        target in ('main', 'pool_student', 'pool_owner')
    ),
    constraint planning_event_google_mirror_status_check check (
        sync_status in ('pending', 'ok', 'error', 'abandoned')
    )
);

create index if not exists planning_event_google_mirror_event_idx
    on public.planning_event_google_mirror (event_id);

comment on table public.planning_event_google_mirror is
    'Miroir Google par cible ; pas d''accès client direct (service_role / admin).';

-- ---------------------------------------------------------------------------
-- Journal erreurs infra (digest nocturne)
-- ---------------------------------------------------------------------------
create table if not exists public.planning_infra_error_log (
    id uuid primary key default gen_random_uuid(),
    occurred_at timestamptz not null default now(),
    source text not null,
    message text not null,
    detail jsonb,
    digest_sent_at timestamptz
);

create index if not exists planning_infra_error_log_digest_idx
    on public.planning_infra_error_log (digest_sent_at, occurred_at);

comment on table public.planning_infra_error_log is
    'Erreurs infrastructure (hors métier utilisateur). Digest e-mail nocturne.';

-- ---------------------------------------------------------------------------
-- RLS planning_event
-- ---------------------------------------------------------------------------
alter table public.planning_event enable row level security;

drop policy if exists "planning_event_select" on public.planning_event;
create policy "planning_event_select" on public.planning_event for select to authenticated using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'prof'))
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
        exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'prof'))
        or (
            exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'eleve')
            and slot_type = 'travail perso'
        )
    )
);

drop policy if exists "planning_event_update" on public.planning_event;
create policy "planning_event_update" on public.planning_event for update to authenticated using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    or owner_user_id = auth.uid()
) with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    or owner_user_id = auth.uid()
);

drop policy if exists "planning_event_delete" on public.planning_event;
create policy "planning_event_delete" on public.planning_event for delete to authenticated using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    or owner_user_id = auth.uid()
);

-- ---------------------------------------------------------------------------
-- RLS enrollment
-- ---------------------------------------------------------------------------
alter table public.planning_event_enrollment enable row level security;

drop policy if exists "planning_event_enrollment_select" on public.planning_event_enrollment;
create policy "planning_event_enrollment_select" on public.planning_event_enrollment for select to authenticated using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    or student_user_id = auth.uid()
    or exists (
        select 1
        from public.planning_event e
        where e.id = event_id and e.owner_user_id = auth.uid()
    )
);

drop policy if exists "planning_event_enrollment_insert" on public.planning_event_enrollment;
create policy "planning_event_enrollment_insert" on public.planning_event_enrollment for insert to authenticated with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    or exists (
        select 1
        from public.planning_event e
        where e.id = event_id and e.owner_user_id = auth.uid() and e.slot_type = 'cours'
    )
);

drop policy if exists "planning_event_enrollment_delete" on public.planning_event_enrollment;
create policy "planning_event_enrollment_delete" on public.planning_event_enrollment for delete to authenticated using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    or exists (
        select 1
        from public.planning_event e
        where e.id = event_id and e.owner_user_id = auth.uid() and e.slot_type = 'cours'
    )
);

-- ---------------------------------------------------------------------------
-- RLS miroirs : aucun accès client (service_role bypass)
-- ---------------------------------------------------------------------------
alter table public.planning_event_google_mirror enable row level security;

drop policy if exists "planning_event_google_mirror_admin_select" on public.planning_event_google_mirror;
create policy "planning_event_google_mirror_admin_select" on public.planning_event_google_mirror for select to authenticated using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
);

-- ---------------------------------------------------------------------------
-- RLS infra log : admin lecture seulement
-- ---------------------------------------------------------------------------
alter table public.planning_infra_error_log enable row level security;

drop policy if exists "planning_infra_error_log_admin_select" on public.planning_infra_error_log;
create policy "planning_infra_error_log_admin_select" on public.planning_infra_error_log for select to authenticated using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
);

-- ---------------------------------------------------------------------------
-- RPC grille FullCalendar (security invoker → RLS)
-- ---------------------------------------------------------------------------
create or replace function public.planning_events_in_range(p_start timestamptz, p_end timestamptz)
returns table (
    id uuid,
    title text,
    start_at timestamptz,
    end_at timestamptz,
    slot_type text,
    owner_user_id uuid,
    owner_email text
)
language sql
stable
security invoker
set search_path = public
as $$
    select e.id, e.title, e.start_at, e.end_at, e.slot_type, e.owner_user_id, e.owner_email
    from public.planning_event e
    where e.start_at < p_end and e.end_at > p_start
    order by e.start_at;
$$;

comment on function public.planning_events_in_range(timestamptz, timestamptz) is
    'Créneaux visibles pour auth.uid() sur [p_start, p_end) selon RLS planning_event.';

grant execute on function public.planning_events_in_range(timestamptz, timestamptz) to authenticated;

grant select, insert, update, delete on public.planning_event to authenticated;
grant select, insert, delete on public.planning_event_enrollment to authenticated;
grant select on public.planning_event_google_mirror to authenticated;
grant select on public.planning_infra_error_log to authenticated;
