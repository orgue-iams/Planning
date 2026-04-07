-- Réservations type : stockage sur profiles + premier libellé = nom affiché à la création.

alter table public.profiles
    add column if not exists reservation_types jsonb not null default '{"labels":[],"favoriteLabel":""}'::jsonb;

comment on column public.profiles.reservation_types is 'Motifs de réservation : { "labels": string[], "favoriteLabel": string }';

-- Profils existants : liste vide + nom renseigné → même règle que pour un nouvel utilisateur.
update public.profiles p
set reservation_types = jsonb_build_object(
    'labels', jsonb_build_array(trim(p.display_name)),
    'favoriteLabel', trim(p.display_name)
)
where trim(coalesce(p.display_name, '')) <> ''
  and coalesce(jsonb_array_length(p.reservation_types -> 'labels'), 0) = 0;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_role text;
    v_display text;
    v_reservation jsonb;
begin
    v_role := lower(trim(coalesce(new.raw_user_meta_data ->> 'role', 'eleve')));
    if v_role not in ('eleve', 'prof', 'consultation') then
        v_role := 'eleve';
    end if;

    v_display := coalesce(
        nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
        split_part(new.email, '@', 1),
        ''
    );

    if trim(v_display) <> '' then
        v_reservation := jsonb_build_object(
            'labels', jsonb_build_array(trim(v_display)),
            'favoriteLabel', trim(v_display)
        );
    else
        v_reservation := '{"labels":[],"favoriteLabel":""}'::jsonb;
    end if;

    insert into public.profiles (id, display_name, role, reservation_types)
    values (new.id, v_display, v_role, v_reservation)
    on conflict (id) do nothing;

    return new;
end;
$$;
