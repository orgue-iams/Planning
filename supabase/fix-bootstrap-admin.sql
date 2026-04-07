-- =============================================================================
-- Première promotion admin bloquée par : enforce_admin_role_update()
-- (souvent généré par l’IA Supabase — absent du schema.sql du dépôt Planning)
-- =============================================================================
-- Exécuter dans SQL Editor, dans l’ordre.

-- 1) Supprime le trigger + la fonction qui impose « Only admins can change role »
drop function if exists public.enforce_admin_role_update() cascade;

-- 2) (Si le nom de fonction diffère, lister les triggers sur profiles :)
-- select tgname from pg_trigger t
-- join pg_class c on c.oid = t.tgrelid
-- where c.relname = 'profiles' and not t.tgisinternal;

-- 3) Promouvoir ton compte (UUID = Authentication → Users → colonne UID)
update public.profiles
set role = 'admin'
where id = 'COLLE_ICI_L_UUID';

-- 4) Vérifier
-- select id, display_name, role from public.profiles;

-- =============================================================================
-- Après coup : sans ce trigger, un utilisateur qui peut UPDATE sa ligne profiles
-- pourrait théoriquement se mettre admin via l’API. Ton app ne doit pas exposer
-- un champ « role » côté client. Pour réintroduire une garde uniquement sur
-- les changements de rôle via JWT, il faudra un trigger qui autorise si
-- auth.uid() is null (requêtes service / dashboard) ou si l’ancien rôle est déjà admin.
-- =============================================================================
