-- Annonces planifiées (login) : fonctionnalité retirée de l’app.
drop policy if exists "scheduled_select_login_active" on public.scheduled_messages;
drop policy if exists "scheduled_select_after_login_active" on public.scheduled_messages;
drop policy if exists "scheduled_insert_privileged" on public.scheduled_messages;
drop policy if exists "scheduled_update_privileged" on public.scheduled_messages;
drop policy if exists "scheduled_delete_privileged" on public.scheduled_messages;
drop policy if exists "scheduled_select_all_privileged" on public.scheduled_messages;

drop table if exists public.scheduled_messages;
