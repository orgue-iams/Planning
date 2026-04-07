-- Contenu éditorial + messages planifiés (à exécuter après schema.sql initial)
-- + sécurisation du rôle à la création de compte

-- --- Règles orgue (une ligne) -------------------------------------------------
create table if not exists public.organ_rules (
    id smallint primary key default 1 check (id = 1),
    content text not null default '',
    updated_at timestamptz default now(),
    updated_by uuid references auth.users (id)
);

insert into public.organ_rules (id, content)
values (1, $$<h3>Règles d’utilisation de l’orgue — Orgue Gérard Bancells (IAMS)</h3>
<p><strong>Respect</strong> des créneaux réservés et de la signalétique sur place.</p>
<p>Ne pas toucher aux jeux, à l’électronique ou à la mécanique sans accord du professeur.</p>
<p>Arriver à l’heure ; en cas d’empêchement, libérer ou modifier votre réservation.</p>
<p>Signaler tout incident ou anomalie au responsable.</p>$$)
on conflict (id) do nothing;

alter table public.organ_rules enable row level security;

create policy "organ_rules_select_all" on public.organ_rules
    for select using (true);

create policy "organ_rules_update_privileged" on public.organ_rules
    for update to authenticated using (
        exists (
            select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('admin', 'prof')
        )
    )
    with check (true);

-- --- Messages planifiés (bandeau login + popup après connexion) ---------------
create table if not exists public.scheduled_messages (
    id uuid primary key default gen_random_uuid(),
    body text not null,
    starts_at timestamptz not null,
    ends_at timestamptz not null,
    channel text not null check (channel in ('login', 'after_login')),
    created_by uuid references auth.users (id),
    created_at timestamptz default now(),
    constraint scheduled_messages_range check (ends_at > starts_at)
);

alter table public.scheduled_messages enable row level security;

create policy "scheduled_select_login_active" on public.scheduled_messages
    for select to anon, authenticated
    using (
        channel = 'login'
        and starts_at <= now()
        and now() <= ends_at
    );

create policy "scheduled_select_after_login_active" on public.scheduled_messages
    for select to authenticated
    using (
        channel = 'after_login'
        and starts_at <= now()
        and now() <= ends_at
    );

create policy "scheduled_insert_privileged" on public.scheduled_messages
    for insert to authenticated
    with check (
        exists (
            select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('admin', 'prof')
        )
    );

create policy "scheduled_update_privileged" on public.scheduled_messages
    for update to authenticated
    using (
        exists (
            select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('admin', 'prof')
        )
    )
    with check (
        exists (
            select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('admin', 'prof')
        )
    );

create policy "scheduled_delete_privileged" on public.scheduled_messages
    for delete to authenticated
    using (
        exists (
            select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('admin', 'prof')
        )
    );

-- Liste / édition de toutes les lignes (pas seulement la fenêtre active)
create policy "scheduled_select_all_privileged" on public.scheduled_messages
    for select to authenticated
    using (
        exists (
            select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('admin', 'prof')
        )
    );

-- --- Trigger profils : rôle depuis metadata (invite), sinon élève ; jamais admin via metadata seul
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
