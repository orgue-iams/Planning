-- Ajoute le rôle "consultation" sur les bases déjà initialisées
-- (schema.sql couvre les nouvelles bases, ce script couvre l'existant).

do $$
begin
    -- Recrée proprement la contrainte role autorisée.
    if exists (
        select 1
        from pg_constraint
        where conname = 'profiles_role_check'
          and conrelid = 'public.profiles'::regclass
    ) then
        alter table public.profiles drop constraint profiles_role_check;
    end if;

    alter table public.profiles
        add constraint profiles_role_check
        check (role in ('admin', 'prof', 'eleve', 'consultation'));
exception
    when undefined_table then
        -- La table n'existe pas encore : rien à faire dans cette migration.
        null;
end $$;

-- Met à jour le trigger de bootstrap profil pour accepter "consultation" depuis metadata.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_role text;
begin
    v_role := lower(trim(coalesce(new.raw_user_meta_data ->> 'role', 'eleve')));
    if v_role not in ('eleve', 'prof', 'consultation') then
        v_role := 'eleve';
    end if;

    insert into public.profiles (id, display_name, role)
    values (
        new.id,
        coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1), ''),
        v_role
    )
    on conflict (id) do nothing;

    return new;
end;
$$;
