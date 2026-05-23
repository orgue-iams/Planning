-- Fermetures périodiques (jours de semaine + plage horaire) et exceptions par jour.

alter table public.planning_absence_period
    add column if not exists is_periodic boolean not null default false;

alter table public.planning_absence_period
    add column if not exists weekdays jsonb not null default '[]'::jsonb;

alter table public.planning_absence_period
    add column if not exists slot_start_time time;

alter table public.planning_absence_period
    add column if not exists slot_end_time time;

alter table public.planning_absence_period
    add column if not exists excluded_ymds jsonb not null default '[]'::jsonb;

alter table public.planning_absence_period
    add column if not exists day_overrides jsonb not null default '[]'::jsonb;

comment on column public.planning_absence_period.is_periodic is
    'Si true : weekdays + plage horaire ; start_ymd/end_ymd bornent l’année scolaire (ou la fenêtre effective).';
comment on column public.planning_absence_period.weekdays is
    'Jours ISO 1=lundi … 7=dimanche, ex. [1,3,5].';
comment on column public.planning_absence_period.excluded_ymds is
    'Dates YYYY-MM-DD exclues d’une fermeture périodique (suppression d’un seul jour).';
comment on column public.planning_absence_period.day_overrides is
    'Exceptions [{ "ymd", "slot_start_time", "slot_end_time", "title"? }] pour un jour précis.';
