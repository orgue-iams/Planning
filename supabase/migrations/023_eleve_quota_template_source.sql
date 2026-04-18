-- Règles élèves (quota travail perso, fenêtre de réservation, journal d’annulations) + source gabarit dans la grille.

-- ---------------------------------------------------------------------------
-- organ_school_settings : colonnes élèves
-- ---------------------------------------------------------------------------
alter table public.organ_school_settings
    add column if not exists eleve_weekly_travail_cap_enabled boolean not null default false;

alter table public.organ_school_settings
    add column if not exists eleve_weekly_travail_cap_hours integer;

alter table public.organ_school_settings
    add column if not exists eleve_booking_horizon_enabled boolean not null default false;

alter table public.organ_school_settings
    add column if not exists eleve_booking_horizon_amount integer;

alter table public.organ_school_settings
    add column if not exists eleve_booking_horizon_unit text default 'days';

alter table public.organ_school_settings
    add column if not exists eleve_count_voided_travail_toward_cap boolean not null default true;

alter table public.organ_school_settings
    add column if not exists eleve_forbid_delete_after_slot_start boolean not null default true;

alter table public.organ_school_settings
    add column if not exists eleve_booking_tolerance_days integer not null default 0;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'organ_school_settings_eleve_cap_hours_chk'
    ) then
        alter table public.organ_school_settings
            add constraint organ_school_settings_eleve_cap_hours_chk
            check (
                eleve_weekly_travail_cap_hours is null
                or (
                    eleve_weekly_travail_cap_hours >= 1
                    and eleve_weekly_travail_cap_hours <= 10
                )
            );
    end if;
end $$;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'organ_school_settings_horizon_unit_chk'
    ) then
        alter table public.organ_school_settings
            add constraint organ_school_settings_horizon_unit_chk
            check (
                eleve_booking_horizon_unit is null
                or eleve_booking_horizon_unit in ('days', 'weeks')
            );
    end if;
end $$;

comment on column public.organ_school_settings.eleve_weekly_travail_cap_enabled is
    'Si vrai, limite les heures de travail perso par semaine civile (lundi 00:00 – dimanche 23:59, fuseau navigateur côté app).';
comment on column public.organ_school_settings.eleve_weekly_travail_cap_hours is
    'Entre 1 et 10 heures entières par semaine (travail perso élève).';
comment on column public.organ_school_settings.eleve_booking_horizon_enabled is
    'Si vrai, interdit de réserver un travail perso au-delà d’une fenêtre dans le futur.';
comment on column public.organ_school_settings.eleve_booking_horizon_amount is
    'Nombre d’unités (jours ou semaines) pour la fenêtre de réservation.';
comment on column public.organ_school_settings.eleve_booking_horizon_unit is
    'Unité pour la fenêtre : days ou weeks.';
comment on column public.organ_school_settings.eleve_count_voided_travail_toward_cap is
    'Si vrai, les annulations de travail perso comptent encore dans le plafond hebdo (journal void).';
comment on column public.organ_school_settings.eleve_forbid_delete_after_slot_start is
    'Si vrai, l’élève ne peut plus supprimer son travail perso une fois l’heure de début du créneau passée.';
comment on column public.organ_school_settings.eleve_booking_tolerance_days is
    'Jours supplémentaires ajoutés à la fenêtre de réservation (souplesse).';

-- ---------------------------------------------------------------------------
-- Journal « void » : annulations travail perso élève (anti contournement quota)
-- ---------------------------------------------------------------------------
create table if not exists public.planning_eleve_travail_void_log (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    slot_start_at timestamptz not null,
    slot_end_at timestamptz not null,
    voided_minutes integer not null,
    created_at timestamptz not null default now(),
    constraint planning_eleve_void_time_order check (slot_start_at < slot_end_at),
    constraint planning_eleve_void_minutes_chk check (voided_minutes > 0)
);

create index if not exists planning_eleve_void_user_idx
    on public.planning_eleve_travail_void_log (user_id, slot_start_at);

comment on table public.planning_eleve_travail_void_log is
    'Minutes de travail perso annulées par l’élève, comptabilisées pour le plafond hebdo si activé.';

alter table public.planning_eleve_travail_void_log enable row level security;

drop policy if exists "planning_eleve_void_select_self" on public.planning_eleve_travail_void_log;
create policy "planning_eleve_void_select_self" on public.planning_eleve_travail_void_log
    for select to authenticated
    using (user_id = auth.uid());

drop policy if exists "planning_eleve_void_insert_self" on public.planning_eleve_travail_void_log;
create policy "planning_eleve_void_insert_self" on public.planning_eleve_travail_void_log
    for insert to authenticated
    with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- RPC : minutes travail perso actives + void sur une fenêtre (élève connecté)
-- ---------------------------------------------------------------------------
create or replace function public.planning_eleve_travail_effective_minutes(
    p_range_start timestamptz,
    p_range_end timestamptz
)
returns table (active_minutes bigint, void_minutes bigint)
language sql
stable
security definer
set search_path = public, auth
as $$
    select
        coalesce(
            (
                select sum(
                    greatest(
                        0,
                        floor(
                            extract(
                                epoch from (
                                    least(e.end_at, p_range_end)
                                    - greatest(e.start_at, p_range_start)
                                )
                            )
                            / 60.0
                        )
                    )::bigint
                )
                from public.planning_event e
                where e.owner_user_id = auth.uid()
                  and e.slot_type = 'travail perso'
                  and e.start_at < p_range_end
                  and e.end_at > p_range_start
            ),
            0::bigint
        ) as active_minutes,
        coalesce(
            (
                select sum(v.voided_minutes::bigint)
                from public.planning_eleve_travail_void_log v
                where v.user_id = auth.uid()
                  and v.slot_start_at < p_range_end
                  and v.slot_end_at > p_range_start
            ),
            0::bigint
        ) as void_minutes;
$$;

comment on function public.planning_eleve_travail_effective_minutes(timestamptz, timestamptz) is
    'Somme des minutes travail perso actives + void (élève connecté) intersectant [p_range_start, p_range_end).';

revoke all on function public.planning_eleve_travail_effective_minutes(timestamptz, timestamptz) from public;
grant execute on function public.planning_eleve_travail_effective_minutes(timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- planning_events_in_range : exposer source_template_line_id
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
    source_template_line_id uuid
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
        e.source_template_line_id
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
    'Créneaux visibles + miroirs Google + inscrits + lien gabarit semaine type si présent.';

revoke all on function public.planning_events_in_range(timestamptz, timestamptz) from public;
grant execute on function public.planning_events_in_range(timestamptz, timestamptz) to authenticated;
