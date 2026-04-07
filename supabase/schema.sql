-- Exécuter dans Supabase → SQL (nouveau projet IAMS planning)
-- Crée la table profils liée à auth.users et les politiques RLS de base.

create table if not exists public.profiles (
    id uuid primary key references auth.users (id) on delete cascade,
    display_name text,
    role text not null default 'eleve' check (role in ('admin', 'prof', 'eleve', 'consultation')),
    updated_at timestamptz default now()
);

comment on table public.profiles is 'Profil applicatif : nom affiché, rôle (auth gère email / mot de passe).';

alter table public.profiles enable row level security;

create policy "Lecture du profil par l’utilisateur" on public.profiles
    for select using (auth.uid() = id);

create policy "Mise à jour du profil par l’utilisateur" on public.profiles
    for update using (auth.uid() = id);

-- Pas de policy INSERT pour le rôle « authenticated » : la ligne est créée par le trigger ci-dessous.

-- Nouvel inscrit : créer la ligne profiles (rôle élève par défaut ; promouvoir admin/prof via tableau SQL)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.profiles (id, display_name, role)
    values (
        new.id,
        coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1), ''),
        'eleve'
    )
    on conflict (id) do nothing;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();
