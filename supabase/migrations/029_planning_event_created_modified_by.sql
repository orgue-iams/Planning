-- Auteur du créneau (souvent admin) vs propriétaire (élève) : affichage côté UI.

alter table public.planning_event
    add column if not exists created_by_user_id uuid references auth.users (id) on delete set null;
alter table public.planning_event
    add column if not exists last_modified_by_user_id uuid references auth.users (id) on delete set null;

update public.planning_event
set
    created_by_user_id = coalesce(created_by_user_id, owner_user_id),
    last_modified_by_user_id = coalesce(last_modified_by_user_id, owner_user_id)
where created_by_user_id is null
   or last_modified_by_user_id is null;

alter table public.planning_event alter column created_by_user_id set not null;
alter table public.planning_event alter column last_modified_by_user_id set not null;

comment on column public.planning_event.created_by_user_id is
    'Compte ayant enregistré le créneau (ex. admin pour un élève).';
comment on column public.planning_event.last_modified_by_user_id is
    'Dernier compte qui a modifié le créneau.';

-- ---------------------------------------------------------------------------
-- planning_events_in_range
-- ---------------------------------------------------------------------------
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
    inscrits_emails text[],
    source_template_line_id uuid,
    gabarit_week_type text,
    created_by_user_id uuid,
    last_modified_by_user_id uuid
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
        coalesce(ins.emails, '{}'::text[]) as inscrits_emails,
        e.source_template_line_id,
        e.gabarit_week_type,
        e.created_by_user_id,
        e.last_modified_by_user_id
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
      and exists (select 1 from public.profiles p where p.id = auth.uid())
    order by e.start_at;
$$;

comment on function public.planning_events_in_range(timestamptz, timestamptz) is
    'Tous les créneaux de la plage, miroirs Google, inscrits, métadonnées gabarit, auteur d’enregistrement.';

revoke all on function public.planning_events_in_range(timestamptz, timestamptz) from public;
grant execute on function public.planning_events_in_range(timestamptz, timestamptz) to authenticated;

-- Renseignés côté serveur (non falsifiables par le client).
create or replace function public.planning_event_set_actor_ids()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
    if tg_op = 'INSERT' then
        new.created_by_user_id := auth.uid();
        new.last_modified_by_user_id := auth.uid();
    elsif tg_op = 'UPDATE' then
        new.last_modified_by_user_id := auth.uid();
    end if;
    return new;
end;
$$;

drop trigger if exists planning_event_set_actor_ids_trg on public.planning_event;
create trigger planning_event_set_actor_ids_trg
    before insert or update on public.planning_event
    for each row
    execute function public.planning_event_set_actor_ids();
