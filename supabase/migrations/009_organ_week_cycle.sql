-- Semaine A / B : un lundi de référence = « semaine A » ; les semaines alternent.
-- Édition : profils admin + prof (même logique que organ_rules).

create table if not exists public.organ_week_cycle (
    id smallint primary key default 1 check (id = 1),
    anchor_monday date,
    updated_at timestamptz default now(),
    updated_by uuid references auth.users (id)
);

insert into public.organ_week_cycle (id, anchor_monday)
values (1, null)
on conflict (id) do nothing;

alter table public.organ_week_cycle enable row level security;

drop policy if exists "organ_week_cycle_select_all" on public.organ_week_cycle;
drop policy if exists "organ_week_cycle_update_privileged" on public.organ_week_cycle;

create policy "organ_week_cycle_select_all" on public.organ_week_cycle
    for select using (true);

create policy "organ_week_cycle_update_privileged" on public.organ_week_cycle
    for update to authenticated using (
        exists (
            select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('admin', 'prof')
        )
    )
    with check (true);

comment on table public.organ_week_cycle is 'Ancrage semaine A : le lundi anchor_monday et toutes les semaines paires d’écart = A, les autres = B.';
