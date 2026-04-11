-- Liste admin : libellé du calendrier perso (ex. Planning IAMS 12), pas seulement l’ID Google.

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
        'profile_role', p.role,
        'calendar_assignment_error', p.calendar_assignment_error,
        'personal_google_calendar_id', g.google_calendar_id,
        'personal_calendar_label', g.label
      )
      order by u.created_at asc nulls last
    ),
    '[]'::json
  )
  from auth.users u
  left join public.profiles p on p.id = u.id
  left join public.google_calendar_pool g on g.assigned_user_id = u.id;
$$;
