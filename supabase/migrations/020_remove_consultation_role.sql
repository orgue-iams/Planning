-- Suppression du rôle « consultation » : les comptes existants passent en « eleve » (à réattribuer manuellement si besoin).

update public.profiles
set role = 'eleve', updated_at = now()
where role = 'consultation';

alter table public.profiles drop constraint if exists profiles_role_check;

alter table public.profiles
    add constraint profiles_role_check check (role in ('admin', 'prof', 'eleve'));

-- Pool : plus de cas particulier « consultation ».
create or replace function public.planning_try_assign_personal_calendar(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    v_role text;
    v_pool_id uuid;
begin
    select role into v_role from public.profiles where id = p_user_id;
    if v_role is null then
        return 'NO_PROFILE';
    end if;

    if exists (
        select 1 from public.google_calendar_pool where assigned_user_id = p_user_id
    ) then
        update public.profiles set calendar_assignment_error = null where id = p_user_id;
        return null;
    end if;

    with picked as (
        select gcp.id
        from public.google_calendar_pool gcp
        where gcp.assigned_user_id is null
          and coalesce(gcp.disabled, false) = false
        order by gcp.sort_order nulls last, gcp.created_at
        limit 1
        for update skip locked
    )
    update public.google_calendar_pool p
    set
        assigned_user_id = p_user_id,
        assigned_at = now(),
        updated_at = now()
    from picked
    where p.id = picked.id
    returning p.id into v_pool_id;

    if v_pool_id is null then
        update public.profiles
        set calendar_assignment_error = 'POOL_SATURATED'
        where id = p_user_id;
        return 'POOL_SATURATED';
    end if;

    update public.profiles set calendar_assignment_error = null where id = p_user_id;
    return null;
end;
$$;

create or replace function public.planning_backfill_unassigned_calendars()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    r record;
begin
    for r in
        select id
        from public.profiles
        where calendar_assignment_error = 'POOL_SATURATED'
    loop
        perform public.planning_try_assign_personal_calendar(r.id);
    end loop;
end;
$$;

create or replace function public.profile_calendar_pool_after()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if tg_op = 'INSERT' then
        perform public.planning_try_assign_personal_calendar(NEW.id);
        return NEW;
    end if;
    return NEW;
end;
$$;

-- Inscription : rôles autorisés sans « consultation ».
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

-- RLS planning_event : élèves seulement (plus consultation).
drop policy if exists "planning_event_select" on public.planning_event;
create policy "planning_event_select" on public.planning_event for select to authenticated using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'prof'))
    or (
        exists (
            select 1
            from public.profiles p
            where p.id = auth.uid() and p.role = 'eleve'
        )
        and (
            slot_type in ('fermeture', 'cours', 'concert', 'autre')
            or (slot_type = 'travail perso' and owner_user_id = auth.uid())
        )
    )
);

-- RPC grille : même filtre que planning_event_select.
drop function if exists public.planning_events_in_range(timestamptz, timestamptz);

create function public.planning_events_in_range(p_start timestamptz, p_end timestamptz)
returns table (
    id uuid,
    title text,
    start_at timestamptz,
    end_at timestamptz,
    slot_type text,
    owner_user_id uuid,
    owner_email text,
    main_google_event_id text,
    pool_google_event_id text,
    inscrits_emails text[]
)
language sql
stable
security definer
set search_path = public, auth
as $$
    select
        e.id,
        e.title,
        e.start_at,
        e.end_at,
        e.slot_type,
        e.owner_user_id,
        e.owner_email,
        m_main.google_event_id,
        m_pool.google_event_id,
        coalesce(ins.emails, '{}'::text[]) as inscrits_emails
    from public.planning_event e
    left join lateral (
        select gm.google_event_id
        from public.planning_event_google_mirror gm
        where gm.event_id = e.id
          and gm.target = 'main'
          and gm.sync_status = 'ok'
        limit 1
    ) m_main on true
    left join lateral (
        select gm.google_event_id
        from public.planning_event_google_mirror gm
        where gm.event_id = e.id
          and gm.target = 'pool_owner'
          and gm.sync_status = 'ok'
        limit 1
    ) m_pool on true
    left join lateral (
        select
            array_agg(lower(trim(u.email::text)) order by u.email) filter (
                where u.email is not null and trim(u.email::text) <> ''
            ) as emails
        from public.planning_event_enrollment en
        join auth.users u on u.id = en.student_user_id
        where en.event_id = e.id
    ) ins on true
    where e.start_at < p_end and e.end_at > p_start
      and (
          exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'prof'))
          or (
              exists (
                  select 1
                  from public.profiles p
                  where p.id = auth.uid() and p.role = 'eleve'
              )
              and (
                  e.slot_type in ('fermeture', 'cours', 'concert', 'autre')
                  or (e.slot_type = 'travail perso' and e.owner_user_id = auth.uid())
              )
          )
      )
    order by e.start_at;
$$;

comment on function public.planning_events_in_range(timestamptz, timestamptz) is
    'Créneaux visibles (équivalent RLS planning_event_select) + miroirs Google + e-mails inscrits cours.';

revoke all on function public.planning_events_in_range(timestamptz, timestamptz) from public;
grant execute on function public.planning_events_in_range(timestamptz, timestamptz) to authenticated;
