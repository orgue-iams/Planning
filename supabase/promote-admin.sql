-- À exécuter dans Supabase → SQL Editor (compte propriétaire du projet).
-- Contourne RLS : pas besoin d’« être admin » dans l’app pour modifier profiles.
--
-- Si tu obtiens : « Only admins can change role » / enforce_admin_role_update
-- → exécute d’abord le fichier fix-bootstrap-admin.sql (drop de la fonction).

-- 1) Récupère l’UUID dans Dashboard → Authentication → Users (colonne UID).
-- 2) Remplace la valeur ci-dessous, puis Run.

update public.profiles
set role = 'admin'
where id = 'COLLE_ICI_L_UUID_DE_TON_UTILISATEUR';

-- Vérification :
-- select id, display_name, role from public.profiles;
