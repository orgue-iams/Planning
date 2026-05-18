-- Préférence utilisateur : afficher la colonne dimanche en vue semaine.
alter table public.profiles
    add column if not exists planning_show_sunday boolean not null default false;

comment on column public.profiles.planning_show_sunday is
    'Si vrai : afficher le dimanche en vue semaine. Si faux : masquer le dimanche (gain de largeur).';
