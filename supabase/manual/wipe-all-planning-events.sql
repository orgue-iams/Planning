-- Purge manuelle : tous les créneaux planning + périodes d'absence (brouillons/appliquées).
-- Les agendas Google se vident via calendar-bridge (adminWipeCalendarsInRange) ou scripts/admin-wipe-all-planning.cjs
-- À exécuter sur le projet lié : npx supabase db query --linked -f supabase/manual/wipe-all-planning-events.sql

delete from public.planning_event_enrollment;
delete from public.planning_event_google_mirror;
delete from public.planning_event;
delete from public.planning_absence_period;
