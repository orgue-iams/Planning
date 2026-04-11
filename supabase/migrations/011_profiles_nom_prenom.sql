-- Nom de famille + prénom (affichage agrégé = trim(nom || ' ' || prenom), conservé dans display_name pour compatibilité).

alter table public.profiles
    add column if not exists nom text not null default '',
    add column if not exists prenom text not null default '';

comment on column public.profiles.nom is 'Nom de famille (obligatoire à la création côté app ; chaîne vide autorisée en base).';
comment on column public.profiles.prenom is 'Prénom.';
comment on column public.profiles.display_name is 'Libellé complet dérivé de nom + prénom lorsque ceux-ci sont renseignés ; sinon valeur historique.';

-- Données existantes : tout l’ancien libellé dans nom (prénom vide).
update public.profiles
set
    nom = coalesce(nullif(trim(coalesce(display_name, '')), ''), ''),
    prenom = '';

-- Si display_name était vide, laisser nom vide aussi (déjà le cas).

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

-- Recalcul display_name à partir de nom + prénom lorsque l’un des deux est non vide.
update public.profiles
set nom = nom
where trim(coalesce(nom, '')) <> ''
   or trim(coalesce(prenom, '')) <> '';

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
    if v_role not in ('eleve', 'prof', 'consultation') then
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

-- Liste admin : tri par nom, prénom, e-mail.
create or replace function public.planning_admin_list_auth_users()
returns json
language sql
security definer
set search_path = public, auth
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'id', u.id,
        'email', u.email,
        'created_at', u.created_at,
        'banned_until', u.banned_until,
        'nom', coalesce(p.nom, ''),
        'prenom', coalesce(p.prenom, ''),
        'display_name', p.display_name,
        'profile_role', p.role,
        'calendar_assignment_error', p.calendar_assignment_error,
        'personal_google_calendar_id', g.google_calendar_id,
        'personal_calendar_label', g.label
      )
      order by
        lower(trim(coalesce(p.nom, ''))),
        lower(trim(coalesce(p.prenom, ''))),
        lower(coalesce(u.email, ''))
    ),
    '[]'::json
  )
  from auth.users u
  left join public.profiles p on p.id = u.id
  left join public.google_calendar_pool g on g.assigned_user_id = u.id;
$$;

-- Élèves actifs : libellé = nom + prénom (comme display_name à jour).
create or replace function public.planning_list_eleves_actifs()
returns table (user_id uuid, email text, display_name text)
language sql
security definer
set search_path = public, auth
stable
as $$
    select
        p.id,
        u.email::text,
        coalesce(
            nullif(
                trim(
                    both
                    from concat_ws(
                        ' ',
                        nullif(trim(both from coalesce(p.nom, '')), ''),
                        nullif(trim(both from coalesce(p.prenom, '')), '')
                    )
                ),
                ''
            ),
            nullif(trim(both from coalesce(p.display_name, '')), ''),
            u.email::text
        )
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.role = 'eleve'
      and (u.banned_until is null or u.banned_until <= now());
$$;
