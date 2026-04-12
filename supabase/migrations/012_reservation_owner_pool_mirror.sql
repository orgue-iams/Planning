-- Miroir pool quand un prof/admin crée pour un autre compte : résolution sécurisée du calendrier pool par e-mail propriétaire.

-- Candidats pour la liste « Créneau pour » (modale réservation) : prof = élèves actifs ; admin = élèves + profs + admins.
create or replace function public.planning_list_reservation_owner_candidates()
returns table (user_id uuid, email text, display_name text)
language plpgsql
security definer
set search_path = public, auth
stable
as $$
declare
    v_role text;
begin
    select p.role into v_role from public.profiles p where p.id = auth.uid();
    if v_role is null or v_role not in ('admin', 'prof') then
        return;
    end if;

    if v_role = 'prof' then
        return query
        select p2.id, u.email::text, coalesce(nullif(trim(p2.display_name), ''), u.email::text)
        from public.profiles p2
        join auth.users u on u.id = p2.id
        where p2.role = 'eleve'
          and (u.banned_until is null or u.banned_until <= now())
        order by coalesce(nullif(trim(p2.display_name), ''), u.email::text);
        return;
    end if;

    return query
    select p2.id, u.email::text, coalesce(nullif(trim(p2.display_name), ''), u.email::text)
    from public.profiles p2
    join auth.users u on u.id = p2.id
    where p2.role in ('eleve', 'prof', 'admin')
      and (u.banned_until is null or u.banned_until <= now())
    order by p2.role, coalesce(nullif(trim(p2.display_name), ''), u.email::text);
end;
$$;

revoke all on function public.planning_list_reservation_owner_candidates() from public;
grant execute on function public.planning_list_reservation_owner_candidates() to authenticated;

comment on function public.planning_list_reservation_owner_candidates() is
    'Prof : élèves actifs. Admin : élèves + profs + admins. Pour sélecteur « Créneau pour ».';

-- ID calendrier pool pour un propriétaire identifié par e-mail (miroir calendar-bridge).
-- Règles : soi-même ; ou prof/admin avec cible existante (prof : élève uniquement).
create or replace function public.planning_pool_calendar_id_for_owner_email(p_owner_email text)
returns text
language plpgsql
security definer
set search_path = public, auth
stable
as $$
declare
    v_me uuid := auth.uid();
    v_caller_role text;
    v_my_email text;
    v_norm text;
    v_target uuid;
begin
    if v_me is null then
        return null;
    end if;

    v_norm := lower(trim(coalesce(p_owner_email, '')));
    if v_norm = '' or position('@' in v_norm) = 0 then
        return null;
    end if;

    select lower(u.email::text) into v_my_email from auth.users u where u.id = v_me;
    select p.role into v_caller_role from public.profiles p where p.id = v_me;

    if v_my_email is not null and v_my_email = v_norm then
        return (
            select g.google_calendar_id::text
            from public.google_calendar_pool g
            where g.assigned_user_id = v_me
            limit 1
        );
    end if;

    if v_caller_role is null or v_caller_role not in ('admin', 'prof') then
        return null;
    end if;

    select u.id into v_target from auth.users u where lower(u.email::text) = v_norm limit 1;
    if v_target is null then
        return null;
    end if;

    if v_caller_role = 'prof' then
        if not exists (select 1 from public.profiles p where p.id = v_target and p.role = 'eleve') then
            return null;
        end if;
    end if;

    return (
        select g.google_calendar_id::text
        from public.google_calendar_pool g
        where g.assigned_user_id = v_target
        limit 1
    );
end;
$$;

revoke all on function public.planning_pool_calendar_id_for_owner_email(text) from public;
grant execute on function public.planning_pool_calendar_id_for_owner_email(text) to authenticated;

comment on function public.planning_pool_calendar_id_for_owner_email(text) is
    'Retourne l’ID Google du calendrier pool du propriétaire (e-mail) si l’appelant peut agir pour lui (soi / prof→élève / admin).';
