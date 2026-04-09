-- Liste des comptes pour la modale « Gestion des comptes » : lecture directe en SQL
-- (contournement si GET /auth/v1/admin/users renvoie [] ou erreur alors que auth.users est peuplé).

create or replace function public.planning_admin_list_auth_users()
returns json
language sql
security definer
set search_path = public, auth
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'id', u.id,
        'email', u.email,
        'created_at', u.created_at,
        'banned_until', u.banned_until,
        'display_name', p.display_name,
        'profile_role', p.role
      )
      order by u.created_at asc nulls last
    ),
    '[]'::json
  )
  from auth.users u
  left join public.profiles p on p.id = u.id;
$$;

comment on function public.planning_admin_list_auth_users() is
  'Liste auth.users + profiles pour planning-admin (service_role uniquement).';

revoke all on function public.planning_admin_list_auth_users() from public;
revoke all on function public.planning_admin_list_auth_users() from anon;
revoke all on function public.planning_admin_list_auth_users() from authenticated;
grant execute on function public.planning_admin_list_auth_users() to service_role;
