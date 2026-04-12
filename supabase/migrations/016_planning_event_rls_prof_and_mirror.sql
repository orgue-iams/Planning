-- Prof/admin : créneaux pour un autre utilisateur (owner_user_id = cible).
-- Prof : mise à jour / suppression des créneaux élèves/prof (aligné UI).
-- RPC : résoudre auth.users.id depuis e-mail (admin/prof ou soi-même).
-- Miroirs Google : unicité (event_id, target) pour upsert bridge ; lecture pour owner/prof/admin.
-- Bump sync_generation sur changement métier (miroir / retry).

drop policy if exists "planning_event_insert" on public.planning_event;
create policy "planning_event_insert" on public.planning_event for insert to authenticated with check (
    exists (select 1 from public.profiles po where po.id = owner_user_id)
    and (
        exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'prof'))
        or (
            owner_user_id = auth.uid()
            and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'eleve')
            and slot_type = 'travail perso'
        )
    )
);

drop policy if exists "planning_event_update" on public.planning_event;
create policy "planning_event_update" on public.planning_event for update to authenticated using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    or owner_user_id = auth.uid()
    or (
        exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'prof')
        and exists (
            select 1
            from public.profiles po
            where po.id = owner_user_id and po.role in ('eleve', 'prof')
        )
    )
) with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    or owner_user_id = auth.uid()
    or (
        exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'prof')
        and exists (
            select 1
            from public.profiles po
            where po.id = owner_user_id and po.role in ('eleve', 'prof')
        )
    )
);

drop policy if exists "planning_event_delete" on public.planning_event;
create policy "planning_event_delete" on public.planning_event for delete to authenticated using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    or owner_user_id = auth.uid()
    or (
        exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'prof')
        and exists (
            select 1
            from public.profiles po
            where po.id = owner_user_id and po.role in ('eleve', 'prof')
        )
    )
);

create or replace function public.planning_user_id_for_email(p_email text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
    v_uid uuid;
    v_role text;
begin
    select p.role into v_role from public.profiles p where p.id = auth.uid();
    if v_role is null then
        return null;
    end if;

    select u.id
    into v_uid
    from auth.users u
    where lower(trim(u.email)) = lower(trim(p_email));

    if v_uid is null then
        return null;
    end if;

    if v_uid = auth.uid() then
        return v_uid;
    end if;

    if v_role in ('admin', 'prof') then
        return v_uid;
    end if;

    return null;
end;
$$;

comment on function public.planning_user_id_for_email(text) is
    'Résout l’id utilisateur depuis l’e-mail (soi-même, ou admin/prof pour un autre compte).';

revoke all on function public.planning_user_id_for_email(text) from public;
grant execute on function public.planning_user_id_for_email(text) to authenticated;

create unique index if not exists planning_event_google_mirror_event_target_uq
    on public.planning_event_google_mirror (event_id, target);

drop policy if exists "planning_event_google_mirror_select_event_visible" on public.planning_event_google_mirror;
create policy "planning_event_google_mirror_select_event_visible" on public.planning_event_google_mirror
    for select to authenticated using (
        exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
        or exists (
            select 1
            from public.planning_event e
            where e.id = event_id
              and e.owner_user_id = auth.uid()
        )
        or (
            exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'prof')
            and exists (
                select 1
                from public.planning_event e
                join public.profiles po on po.id = e.owner_user_id
                where e.id = event_id
                  and po.role in ('eleve', 'prof')
            )
        )
    );

create or replace function public.planning_event_bump_sync_generation()
returns trigger
language plpgsql
as $$
begin
    if (old.start_at, old.end_at, old.slot_type, old.title, old.owner_user_id, old.owner_email)
        is distinct from
        (new.start_at, new.end_at, new.slot_type, new.title, new.owner_user_id, new.owner_email)
    then
        new.sync_generation := coalesce(old.sync_generation, 1) + 1;
    end if;
    return new;
end;
$$;

drop trigger if exists planning_event_bump_sync_generation_trg on public.planning_event;
create trigger planning_event_bump_sync_generation_trg
    before update on public.planning_event
    for each row
    execute function public.planning_event_bump_sync_generation();

-- IDs Google connus (miroir ok) pour sync drag / delete sans liste séparée.
-- DROP obligatoire : PostgreSQL refuse CREATE OR REPLACE si le type de retour (OUT) change.
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
    pool_google_event_id text
)
language sql
stable
security invoker
set search_path = public
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
        m_pool.google_event_id
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
    where e.start_at < p_end and e.end_at > p_start
    order by e.start_at;
$$;

comment on function public.planning_events_in_range(timestamptz, timestamptz) is
    'Créneaux visibles pour auth.uid() sur [p_start, p_end) ; IDs Google miroir main/pool si sync ok.';

grant execute on function public.planning_events_in_range(timestamptz, timestamptz) to authenticated;
