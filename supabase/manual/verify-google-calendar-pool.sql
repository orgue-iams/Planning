-- Vérification du pool `google_calendar_pool`.
-- Depuis le repo (projet lié + `supabase login`) : exécuter avec la CLI, ex.
--   npx supabase db query --linked -f supabase/manual/verify-google-calendar-pool.sql -o table --agent=no
-- (Plusieurs SELECT : la CLI peut n’en afficher qu’un ; utiliser aussi des requêtes ciblées une par une.)
-- Alternative : SQL Editor dans le dashboard Supabase.

-- 1) Nombre total d’entrées (actives / désactivées)
select
    count(*) filter (where coalesce(disabled, false) = false) as actifs,
    count(*) filter (where coalesce(disabled, false) = true) as desactives,
    count(*) as total
from public.google_calendar_pool;

-- 2) Chaque ligne : format de l’ID (doit être l’ID brut, pas une URL)
select
    label,
    sort_order,
    coalesce(disabled, false) as disabled,
    case
        when trim(google_calendar_id) ilike 'http%' then 'KO : URL complète — utiliser xxx@group.calendar.google.com (ou coller l’URL : l’admin normalise à l’ajout)'
        when position('@' in trim(google_calendar_id)) = 0 then 'ATTENTION : ID sans @ (calendriers Google classiques contiennent souvent @group.calendar.google.com)'
        when trim(google_calendar_id) like '% %' then 'ATTENTION : espaces dans l’ID'
        else 'OK'
    end as controle_id,
    left(google_calendar_id, 72) || case when length(google_calendar_id) > 72 then '…' else '' end as id_apercu,
    assigned_user_id is not null as assigne
from public.google_calendar_pool
order by sort_order nulls last, created_at;

-- 3) Sort_order en double (souvent indésirable pour l’ordre d’attribution)
select sort_order, count(*) as nb
from public.google_calendar_pool
where coalesce(disabled, false) = false
group by sort_order
having count(*) > 1;

-- 4) Même google_calendar_id deux fois (contrainte unique normalement empêche)
select google_calendar_id, count(*) as nb
from public.google_calendar_pool
group by google_calendar_id
having count(*) > 1;
