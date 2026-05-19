-- Jours d’enseignement par professeur (1 = lundi … 7 = dimanche, convention gabarit / FullCalendar).

alter table public.profiles
    add column if not exists teaching_days smallint[] not null default '{}';

comment on column public.profiles.teaching_days is
    'Jours où le professeur enseigne (gabarit semaines A/B). Tableau vide = non configuré. Éditable par le prof sur sa ligne.';
