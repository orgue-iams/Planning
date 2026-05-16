-- Semaines de fermeture (application gabarit) + plafond heures élève sans max 10

alter table public.organ_school_settings
    add column if not exists template_apply_closure_ranges jsonb not null default '[]'::jsonb;

comment on column public.organ_school_settings.template_apply_closure_ranges is
    'Périodes de fermeture (dates incluses) exclues lors de l’application des semaines types A/B. [{ "startYmd": "2026-01-01", "endYmd": "2026-01-07" }, …]';

alter table public.organ_school_settings
    drop constraint if exists organ_school_settings_eleve_cap_hours_chk;

alter table public.organ_school_settings
    add constraint organ_school_settings_eleve_cap_hours_chk check (
        eleve_weekly_travail_cap_hours is null
        or eleve_weekly_travail_cap_hours >= 1
    );
