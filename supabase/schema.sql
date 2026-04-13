-- Exécuter dans Supabase → SQL (nouveau projet IAMS planning)
-- Crée la table profils liée à auth.users et les politiques RLS de base.

create table if not exists public.profiles (
    id uuid primary key references auth.users (id) on delete cascade,
    nom text not null default '',
    prenom text not null default '',
    display_name text,
    role text not null default 'eleve' check (role in ('admin', 'prof', 'eleve')),
    reservation_types jsonb not null default '{"labels":[],"favoriteLabel":""}'::jsonb,
    updated_at timestamptz default now()
);

comment on table public.profiles is 'Profil applicatif : nom, prénom, libellé agrégé (display_name), rôle (auth gère email / mot de passe).';

alter table public.profiles enable row level security;

create policy "Lecture du profil par l’utilisateur" on public.profiles
    for select using (auth.uid() = id);

create policy "Mise à jour du profil par l’utilisateur" on public.profiles
    for update using (auth.uid() = id);

-- Pas de policy INSERT pour le rôle « authenticated » : la ligne est créée par le trigger ci-dessous.

create or replace function public.profiles_sync_display_name()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_n text;
    v_p text;
begin
    v_n := nullif(trim(both from coalesce(new.nom, '')), '');
    v_p := nullif(trim(both from coalesce(new.prenom, '')), '');
    if v_n is not null or v_p is not null then
        new.display_name := nullif(trim(both from concat_ws(' ', v_n, v_p)), '');
    end if;
    return new;
end;
$$;

drop trigger if exists profiles_sync_display_name_bi on public.profiles;
create trigger profiles_sync_display_name_bi
    before insert or update of nom, prenom on public.profiles
    for each row
    execute function public.profiles_sync_display_name();

-- Nouvel inscrit : créer la ligne profiles (rôle élève par défaut ; promouvoir admin/prof via tableau SQL)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_role text;
    v_nom text;
    v_prenom text;
    v_display text;
    v_reservation jsonb;
begin
    v_role := lower(trim(coalesce(new.raw_user_meta_data ->> 'role', 'eleve')));
    if v_role not in ('eleve', 'prof') then
        v_role := 'eleve';
    end if;

    v_nom := trim(coalesce(new.raw_user_meta_data ->> 'nom', ''));
    v_prenom := trim(coalesce(new.raw_user_meta_data ->> 'prenom', ''));

    if v_nom = '' and v_prenom = '' then
        v_nom := coalesce(
            nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
            split_part(new.email, '@', 1),
            ''
        );
    end if;

    v_display := nullif(trim(both from concat_ws(' ', nullif(v_nom, ''), nullif(v_prenom, ''))), '');

    if v_display is not null and v_display <> '' then
        v_reservation := jsonb_build_object(
            'labels', jsonb_build_array(v_display),
            'favoriteLabel', v_display
        );
    else
        v_reservation := '{"labels":[],"favoriteLabel":""}'::jsonb;
    end if;

    insert into public.profiles (id, nom, prenom, role, reservation_types)
    values (new.id, v_nom, v_prenom, v_role, v_reservation)
    on conflict (id) do nothing;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();
