-- Remplir le pool avec les 26 calendriers « Planning IAMS 01 » … « Planning IAMS 26 ».
-- À exécuter une fois dans Supabase → SQL Editor (après migration 007).
--
-- 1) Ouvrir la feuille Google générée par Apps Script (colonne google_calendar_id).
-- 2) Remplacer chaque PLACEHOLDER_ID_XX ci-dessous par l’ID réel du calendrier correspondant
--    (même ordre : 01 = premier calendrier créé, etc.).
-- 3) Exécuter tout le script.
--
-- Les IDs ressemblent souvent à : xxxxxxxxxxxxxxxxxxxxxxx@group.calendar.google.com
--
-- Idempotent : en cas de conflit sur google_calendar_id, la ligne existante est conservée.

insert into public.google_calendar_pool (google_calendar_id, label, sort_order)
values
    ('PLACEHOLDER_ID_01', 'Planning IAMS 01', 1),
    ('PLACEHOLDER_ID_02', 'Planning IAMS 02', 2),
    ('PLACEHOLDER_ID_03', 'Planning IAMS 03', 3),
    ('PLACEHOLDER_ID_04', 'Planning IAMS 04', 4),
    ('PLACEHOLDER_ID_05', 'Planning IAMS 05', 5),
    ('PLACEHOLDER_ID_06', 'Planning IAMS 06', 6),
    ('PLACEHOLDER_ID_07', 'Planning IAMS 07', 7),
    ('PLACEHOLDER_ID_08', 'Planning IAMS 08', 8),
    ('PLACEHOLDER_ID_09', 'Planning IAMS 09', 9),
    ('PLACEHOLDER_ID_10', 'Planning IAMS 10', 10),
    ('PLACEHOLDER_ID_11', 'Planning IAMS 11', 11),
    ('PLACEHOLDER_ID_12', 'Planning IAMS 12', 12),
    ('PLACEHOLDER_ID_13', 'Planning IAMS 13', 13),
    ('PLACEHOLDER_ID_14', 'Planning IAMS 14', 14),
    ('PLACEHOLDER_ID_15', 'Planning IAMS 15', 15),
    ('PLACEHOLDER_ID_16', 'Planning IAMS 16', 16),
    ('PLACEHOLDER_ID_17', 'Planning IAMS 17', 17),
    ('PLACEHOLDER_ID_18', 'Planning IAMS 18', 18),
    ('PLACEHOLDER_ID_19', 'Planning IAMS 19', 19),
    ('PLACEHOLDER_ID_20', 'Planning IAMS 20', 20),
    ('PLACEHOLDER_ID_21', 'Planning IAMS 21', 21),
    ('PLACEHOLDER_ID_22', 'Planning IAMS 22', 22),
    ('PLACEHOLDER_ID_23', 'Planning IAMS 23', 23),
    ('PLACEHOLDER_ID_24', 'Planning IAMS 24', 24),
    ('PLACEHOLDER_ID_25', 'Planning IAMS 25', 25),
    ('PLACEHOLDER_ID_26', 'Planning IAMS 26', 26)
on conflict (google_calendar_id) do nothing;

-- Retenter l’attribution pour les profils marqués POOL_SATURATED.
select public.planning_backfill_unassigned_calendars();
