-- Repère semaine A/B : propre à chaque professeur (pas un numéro de semaine global).
-- Mis à jour quand le prof applique son gabarit (date de début + type A ou B de cette semaine).
-- Affichage barre calendrier : réservé au rôle prof (élèves / admin : pas de libellé).

create table if not exists public.organ_prof_week_cycle (
    user_id uuid primary key references auth.users (id) on delete cascade,
    anchor_monday date not null,
    letter_at_anchor char(1) not null check (letter_at_anchor in ('A', 'B')),
    updated_at timestamptz not null default now()
);

comment on table public.organ_prof_week_cycle is
    'Pour chaque prof : lundi de la semaine de référence + type A ou B sur cette semaine ; alternance ensuite chaque lundi.';

alter table public.organ_prof_week_cycle enable row level security;

drop policy if exists "organ_prof_week_cycle_select_own" on public.organ_prof_week_cycle;
drop policy if exists "organ_prof_week_cycle_insert_own_prof" on public.organ_prof_week_cycle;
drop policy if exists "organ_prof_week_cycle_update_own_prof" on public.organ_prof_week_cycle;

create policy "organ_prof_week_cycle_select_own" on public.organ_prof_week_cycle
    for select to authenticated
    using (auth.uid() = user_id);

create policy "organ_prof_week_cycle_insert_own_prof" on public.organ_prof_week_cycle
    for insert to authenticated
    with check (
        auth.uid() = user_id
        and exists (
            select 1 from public.profiles p
            where p.id = auth.uid() and p.role = 'prof'
        )
    );

create policy "organ_prof_week_cycle_update_own_prof" on public.organ_prof_week_cycle
    for update to authenticated
    using (
        auth.uid() = user_id
        and exists (
            select 1 from public.profiles p
            where p.id = auth.uid() and p.role = 'prof'
        )
    )
    with check (auth.uid() = user_id);
