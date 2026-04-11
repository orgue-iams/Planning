-- Pool de calendriers Google secondaires (un par compte élève/prof/admin, pas consultation).
-- Affectation auto à la création du profil ; libération à la suspension ou changement de rôle → consultation.

-- --- Colonne profil : erreur d’affectation (ex. pool saturé) ----------------------------
alter table public.profiles
    add column if not exists calendar_assignment_error text;

comment on column public.profiles.calendar_assignment_error is
    'Code erreur si aucun calendrier secondaire n’a pu être attribué (ex. POOL_SATURATED). NULL si OK ou consultation.';

-- --- Table pool -----------------------------------------------------------------------
create table if not exists public.google_calendar_pool (
    id uuid primary key default gen_random_uuid(),
    google_calendar_id text not null,
    label text,
    disabled boolean not null default false,
    sort_order int not null default 0,
    assigned_user_id uuid references public.profiles (id) on delete set null,
    assigned_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint google_calendar_pool_google_id_unique unique (google_calendar_id)
);

create unique index if not exists google_calendar_pool_one_user
    on public.google_calendar_pool (assigned_user_id)
    where assigned_user_id is not null;

comment on table public.google_calendar_pool is
    'Calendriers Google secondaires réutilisables ; assigned_user_id lie le compte IAMS au calendrier perso.';

create index if not exists google_calendar_pool_available_idx
    on public.google_calendar_pool (sort_order, created_at)
    where assigned_user_id is null and not disabled;

alter table public.google_calendar_pool enable row level security;

drop policy if exists "google_calendar_pool_select" on public.google_calendar_pool;
drop policy if exists "google_calendar_pool_insert_admin" on public.google_calendar_pool;
drop policy if exists "google_calendar_pool_update_admin" on public.google_calendar_pool;
drop policy if exists "google_calendar_pool_delete_admin" on public.google_calendar_pool;

create policy "google_calendar_pool_select"
    on public.google_calendar_pool
    for select
    to authenticated
    using (
        assigned_user_id = (select auth.uid())
        or exists (
            select 1 from public.profiles pr
            where pr.id = (select auth.uid()) and pr.role = 'admin'
        )
    );

create policy "google_calendar_pool_insert_admin"
    on public.google_calendar_pool
    for insert
    to authenticated
    with check (
        exists (
            select 1 from public.profiles pr
            where pr.id = (select auth.uid()) and pr.role = 'admin'
        )
    );

create policy "google_calendar_pool_update_admin"
    on public.google_calendar_pool
    for update
    to authenticated
    using (
        exists (
            select 1 from public.profiles pr
            where pr.id = (select auth.uid()) and pr.role = 'admin'
        )
    )
    with check (
        exists (
            select 1 from public.profiles pr
            where pr.id = (select auth.uid()) and pr.role = 'admin'
        )
    );

create policy "google_calendar_pool_delete_admin"
    on public.google_calendar_pool
    for delete
    to authenticated
    using (
        exists (
            select 1 from public.profiles pr
            where pr.id = (select auth.uid()) and pr.role = 'admin'
        )
    );

-- --- Fonction : tenter d’attribuer un calendrier libre ---------------------------------
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
    if v_role = 'consultation' then
        update public.profiles set calendar_assignment_error = null where id = p_user_id;
        return null;
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

comment on function public.planning_try_assign_personal_calendar(uuid) is
    'Attribue le premier calendrier secondaire libre ; retour NULL si OK, code sinon. service_role + triggers.';

revoke all on function public.planning_try_assign_personal_calendar(uuid) from public;
grant execute on function public.planning_try_assign_personal_calendar(uuid) to service_role;

-- --- Libérer le calendrier d’un utilisateur (suspension, etc.) -------------------------
create or replace function public.planning_release_personal_calendar(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.google_calendar_pool
    set
        assigned_user_id = null,
        assigned_at = null,
        updated_at = now()
    where assigned_user_id = p_user_id;

    update public.profiles
    set calendar_assignment_error = null
    where id = p_user_id;
end;
$$;

revoke all on function public.planning_release_personal_calendar(uuid) from public;
grant execute on function public.planning_release_personal_calendar(uuid) to service_role;

-- --- Après ajout d’un calendrier au pool : retenter les comptes en POOL_SATURATED -------
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
        where role <> 'consultation'
          and calendar_assignment_error = 'POOL_SATURATED'
    loop
        perform public.planning_try_assign_personal_calendar(r.id);
    end loop;
end;
$$;

comment on function public.planning_backfill_unassigned_calendars() is
    'Retente l’affectation pour les profils marqués POOL_SATURATED (après extension du pool).';

revoke all on function public.planning_backfill_unassigned_calendars() from public;
grant execute on function public.planning_backfill_unassigned_calendars() to service_role;

-- --- Trigger après insert / update profil ---------------------------------------------
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

    if tg_op = 'UPDATE' then
        if NEW.role = 'consultation' and OLD.role <> 'consultation' then
            perform public.planning_release_personal_calendar(NEW.id);
            return NEW;
        end if;

        if OLD.role = 'consultation' and NEW.role <> 'consultation' then
            perform public.planning_try_assign_personal_calendar(NEW.id);
            return NEW;
        end if;

        return NEW;
    end if;

    return NEW;
end;
$$;

drop trigger if exists profile_calendar_pool_after_ins on public.profiles;
create trigger profile_calendar_pool_after_ins
    after insert on public.profiles
    for each row
    execute function public.profile_calendar_pool_after();

drop trigger if exists profile_calendar_pool_after_upd on public.profiles;
create trigger profile_calendar_pool_after_upd
    after update of role on public.profiles
    for each row
    when (OLD.role is distinct from NEW.role)
    execute function public.profile_calendar_pool_after();

-- --- Backfill : utilisateurs existants (hors consultation) ----------------------------
do $$
declare
    r record;
begin
    for r in
        select id
        from public.profiles
        where role <> 'consultation'
        order by id
    loop
        perform public.planning_try_assign_personal_calendar(r.id);
    end loop;
end $$;

-- --- RPC liste utilisateurs : champs calendrier ---------------------------------------
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
        'display_name', p.display_name,
        'profile_role', p.role,
        'calendar_assignment_error', p.calendar_assignment_error,
        'personal_google_calendar_id', g.google_calendar_id
      )
      order by u.created_at asc nulls last
    ),
    '[]'::json
  )
  from auth.users u
  left join public.profiles p on p.id = u.id
  left join public.google_calendar_pool g on g.assigned_user_id = u.id;
$$;
