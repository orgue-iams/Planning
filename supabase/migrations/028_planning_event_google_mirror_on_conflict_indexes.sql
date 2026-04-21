-- Garantit les colonnes ON CONFLICT utilisées par calendar-bridge (upsert REST):
-- 1) (event_id, target) pour main + pool_owner
-- 2) (event_id, target_user_id) pour pool_student

drop index if exists planning_event_google_mirror_event_target_uq;
create unique index if not exists planning_event_google_mirror_event_target_uq
    on public.planning_event_google_mirror (event_id, target)
    where target in ('main', 'pool_owner');

create unique index if not exists planning_event_google_mirror_event_target_user_uq
    on public.planning_event_google_mirror (event_id, target_user_id)
    where target = 'pool_student';
