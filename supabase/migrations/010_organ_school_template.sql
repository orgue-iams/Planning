-- Paramètres année scolaire + plage horaire chapelle (une ligne id = 1).
-- Gabarit semaines A/B : lignes par prof (cours | travail perso) + élèves par ligne cours.

create table if not exists public.organ_school_settings (
    id smallint primary key default 1 check (id = 1),
    school_year_start date,
    school_year_end date,
    chapel_slot_min time not null default '08:00:00',
    chapel_slot_max time not null default '22:00:00',
    updated_at timestamptz default now(),
    updated_by uuid references auth.users (id)
);

insert into public.organ_school_settings (id)
values (1)
on conflict (id) do nothing;

alter table public.organ_school_settings enable row level security;

drop policy if exists "organ_school_settings_select_auth" on public.organ_school_settings;
drop policy if exists "organ_school_settings_update_admin" on public.organ_school_settings;

create policy "organ_school_settings_select_auth" on public.organ_school_settings
    for select to authenticated using (true);

create policy "organ_school_settings_update_admin" on public.organ_school_settings
    for update to authenticated using (
        exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    )
    with check (true);

comment on table public.organ_school_settings is
    'Dates année scolaire + bornes grille (chapelle). Écriture : admin uniquement.';

-- Gabarit : 1 = lundi … 7 = dimanche (aligné firstDay=1 FullCalendar).
create table if not exists public.organ_week_template_line (
    id uuid primary key default gen_random_uuid(),
    week_type char(1) not null check (week_type in ('A', 'B')),
    owner_user_id uuid not null references auth.users (id) on delete cascade,
    slot_type text not null check (slot_type in ('cours', 'reservation')),
    day_of_week smallint not null check (day_of_week between 1 and 7),
    start_time time not null,
    end_time time not null,
    title text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint organ_week_template_line_time_order check (start_time < end_time)
);

create index if not exists organ_week_template_line_owner_idx
    on public.organ_week_template_line (owner_user_id);

comment on table public.organ_week_template_line is
    'Gabarit semaine A/B : créneaux cours ou travail (reservation) par prof titulaire.';

create table if not exists public.organ_week_template_line_student (
    line_id uuid not null references public.organ_week_template_line (id) on delete cascade,
    student_user_id uuid not null references auth.users (id) on delete cascade,
    primary key (line_id, student_user_id)
);

comment on table public.organ_week_template_line_student is
    'Élèves actifs rattachés à une ligne cours du gabarit.';

alter table public.organ_week_template_line enable row level security;
alter table public.organ_week_template_line_student enable row level security;

drop policy if exists "template_line_select_staff" on public.organ_week_template_line;
drop policy if exists "template_line_insert_own_prof" on public.organ_week_template_line;
drop policy if exists "template_line_update_own_prof" on public.organ_week_template_line;
drop policy if exists "template_line_delete_own_prof" on public.organ_week_template_line;

create policy "template_line_select_staff" on public.organ_week_template_line
    for select to authenticated using (
        exists (
            select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('admin', 'prof')
        )
    );

create policy "template_line_insert_own_prof" on public.organ_week_template_line
    for insert to authenticated with check (
        owner_user_id = auth.uid()
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'prof')
    );

create policy "template_line_update_own_prof" on public.organ_week_template_line
    for update to authenticated using (
        owner_user_id = auth.uid()
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'prof')
    )
    with check (
        owner_user_id = auth.uid()
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'prof')
    );

create policy "template_line_delete_own_prof" on public.organ_week_template_line
    for delete to authenticated using (
        owner_user_id = auth.uid()
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'prof')
    );

drop policy if exists "template_line_student_all" on public.organ_week_template_line_student;

create policy "template_line_student_select" on public.organ_week_template_line_student
    for select to authenticated using (
        exists (
            select 1 from public.organ_week_template_line l
            join public.profiles p on p.id = auth.uid()
            where l.id = line_id and p.role in ('admin', 'prof')
        )
    );

create policy "template_line_student_insert" on public.organ_week_template_line_student
    for insert to authenticated with check (
        exists (
            select 1 from public.organ_week_template_line l
            where l.id = line_id and l.owner_user_id = auth.uid()
        )
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'prof')
    );

create policy "template_line_student_delete" on public.organ_week_template_line_student
    for delete to authenticated using (
        exists (
            select 1 from public.organ_week_template_line l
            where l.id = line_id and l.owner_user_id = auth.uid()
        )
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'prof')
    );

-- Élèves « actifs » (non bannis) pour multiselect gabarit
create or replace function public.planning_list_eleves_actifs()
returns table (user_id uuid, email text, display_name text)
language sql
security definer
set search_path = public, auth
stable
as $$
    select p.id, u.email::text, coalesce(nullif(trim(p.display_name), ''), u.email::text)
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.role = 'eleve'
      and (u.banned_until is null or u.banned_until <= now());
$$;

revoke all on function public.planning_list_eleves_actifs() from public;
grant execute on function public.planning_list_eleves_actifs() to authenticated;

comment on function public.planning_list_eleves_actifs() is
    'Liste élèves actifs (profils eleve, non banned_until) pour gabarit cours.';

-- ID calendrier Google secondaire (pool) pour un utilisateur — prof/admin pour appliquer le gabarit.
create or replace function public.planning_pool_calendar_id(p_user_id uuid)
returns text
language sql
security definer
set search_path = public
stable
as $$
    select g.google_calendar_id::text
    from public.google_calendar_pool g
    where g.assigned_user_id = p_user_id
    limit 1;
$$;

revoke all on function public.planning_pool_calendar_id(uuid) from public;
grant execute on function public.planning_pool_calendar_id(uuid) to authenticated;

comment on function public.planning_pool_calendar_id(uuid) is
    'Retourne l’ID Google du calendrier perso pool pour un user (null si aucun).';
