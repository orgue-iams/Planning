-- Rôles admin_technique / admin_iams (remplace admin) + annuaire / RLS.

alter table public.profiles drop constraint if exists profiles_role_check;

update public.profiles
set role = 'admin_technique', updated_at = now()
where role = 'admin';

alter table public.profiles
    add constraint profiles_role_check
    check (role in ('admin_technique', 'admin_iams', 'prof', 'eleve'));

comment on column public.profiles.role is
    'admin_technique : tous les droits admin ; admin_iams : idem sauf configuration planning et statistiques.';

create or replace function public.planning_role_is_admin(p_role text)
returns boolean
language sql
immutable
as $fn$
    select lower(trim(coalesce(p_role, ''))) in ('admin_technique', 'admin_iams', 'admin');
$fn$;

create or replace function public.planning_role_is_admin_technique(p_role text)
returns boolean
language sql
immutable
as $fn$
    select lower(trim(coalesce(p_role, ''))) in ('admin_technique', 'admin');
$fn$;

create or replace function public.planning_auth_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
    select exists (
        select 1 from public.profiles p
        where p.id = auth.uid()
          and public.planning_role_is_admin(p.role)
    );
$fn$;

create or replace function public.planning_auth_is_admin_technique()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
    select exists (
        select 1 from public.profiles p
        where p.id = auth.uid()
          and public.planning_role_is_admin_technique(p.role)
    );
$fn$;

create or replace function public.planning_auth_is_admin_or_prof()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
    select exists (
        select 1 from public.profiles p
        where p.id = auth.uid()
          and (
            public.planning_role_is_admin(p.role)
            or lower(trim(coalesce(p.role, ''))) = 'prof'
          )
    );
$fn$;

DROP POLICY IF EXISTS "google_calendar_pool_delete_admin" ON public.google_calendar_pool;
CREATE POLICY "google_calendar_pool_delete_admin" ON public.google_calendar_pool AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text]))))));
DROP POLICY IF EXISTS "google_calendar_pool_insert_admin" ON public.google_calendar_pool;
CREATE POLICY "google_calendar_pool_insert_admin" ON public.google_calendar_pool AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text]))))));
DROP POLICY IF EXISTS "google_calendar_pool_select" ON public.google_calendar_pool;
CREATE POLICY "google_calendar_pool_select" ON public.google_calendar_pool AS PERMISSIVE FOR SELECT TO authenticated USING (((assigned_user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text])))))));
DROP POLICY IF EXISTS "google_calendar_pool_update_admin" ON public.google_calendar_pool;
CREATE POLICY "google_calendar_pool_update_admin" ON public.google_calendar_pool AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text]))))));
DROP POLICY IF EXISTS "organ_rules_update_privileged" ON public.organ_rules;
CREATE POLICY "organ_rules_update_privileged" ON public.organ_rules AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text, 'prof'::text])))))) WITH CHECK (true);
DROP POLICY IF EXISTS "organ_school_settings_update_admin" ON public.organ_school_settings;
CREATE POLICY "organ_school_settings_update_admin" ON public.organ_school_settings AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text])))))) WITH CHECK (true);
DROP POLICY IF EXISTS "organ_week_cycle_update_privileged" ON public.organ_week_cycle;
CREATE POLICY "organ_week_cycle_update_privileged" ON public.organ_week_cycle AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text, 'prof'::text])))))) WITH CHECK (true);
DROP POLICY IF EXISTS "template_line_select_staff" ON public.organ_week_template_line;
CREATE POLICY "template_line_select_staff" ON public.organ_week_template_line AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text, 'prof'::text]))))));
DROP POLICY IF EXISTS "template_line_student_select" ON public.organ_week_template_line_student;
CREATE POLICY "template_line_student_select" ON public.organ_week_template_line_student AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (organ_week_template_line l
     JOIN profiles p ON ((p.id = auth.uid())))
  WHERE ((l.id = organ_week_template_line_student.line_id) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text, 'prof'::text]))))));
DROP POLICY IF EXISTS "planning_absence_period_insert" ON public.planning_absence_period;
CREATE POLICY "planning_absence_period_insert" ON public.planning_absence_period AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((created_by_user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text, 'prof'::text])))))));
DROP POLICY IF EXISTS "planning_absence_period_select" ON public.planning_absence_period;
CREATE POLICY "planning_absence_period_select" ON public.planning_absence_period AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text, 'prof'::text]))))));
DROP POLICY IF EXISTS "planning_event_delete" ON public.planning_event;
CREATE POLICY "planning_event_delete" ON public.planning_event AS PERMISSIVE FOR DELETE TO authenticated USING ((((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text]))))) AND (slot_type <> 'indispo'::text)) OR (owner_user_id = auth.uid())));
DROP POLICY IF EXISTS "planning_event_insert" ON public.planning_event;
CREATE POLICY "planning_event_insert" ON public.planning_event AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((owner_user_id = auth.uid()) AND (((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text]))))) AND (slot_type = ANY (ARRAY['cours'::text, 'travail perso'::text, 'fermeture'::text, 'concert'::text, 'autre'::text]))) OR ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'prof'::text)))) AND (slot_type = ANY (ARRAY['cours'::text, 'travail perso'::text, 'concert'::text, 'autre'::text, 'indispo'::text]))) OR ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'eleve'::text)))) AND (slot_type = 'travail perso'::text)))));
DROP POLICY IF EXISTS "planning_event_select" ON public.planning_event;
CREATE POLICY "planning_event_select" ON public.planning_event AS PERMISSIVE FOR SELECT TO authenticated USING ((((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text]))))) AND (slot_type <> 'indispo'::text)) OR ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'prof'::text)))) AND ((slot_type <> 'indispo'::text) OR (owner_user_id = auth.uid()))) OR ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['eleve'::text]))))) AND (slot_type <> 'indispo'::text))));
DROP POLICY IF EXISTS "planning_event_update" ON public.planning_event;
CREATE POLICY "planning_event_update" ON public.planning_event AS PERMISSIVE FOR UPDATE TO authenticated USING ((((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text]))))) AND (slot_type <> 'indispo'::text)) OR (owner_user_id = auth.uid()))) WITH CHECK ((((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text]))))) AND (slot_type <> 'indispo'::text)) OR (owner_user_id = auth.uid())));
DROP POLICY IF EXISTS "planning_event_enrollment_delete" ON public.planning_event_enrollment;
CREATE POLICY "planning_event_enrollment_delete" ON public.planning_event_enrollment AS PERMISSIVE FOR DELETE TO authenticated USING (((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text]))))) OR (EXISTS ( SELECT 1
   FROM planning_event e
  WHERE ((e.id = planning_event_enrollment.event_id) AND (e.owner_user_id = auth.uid()) AND (e.slot_type = 'cours'::text)))) OR ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'prof'::text)))) AND (EXISTS ( SELECT 1
   FROM (planning_event e
     JOIN profiles po ON ((po.id = e.owner_user_id)))
  WHERE ((e.id = planning_event_enrollment.event_id) AND (e.slot_type = 'cours'::text) AND (po.role = ANY (ARRAY['eleve'::text, 'prof'::text]))))))));
DROP POLICY IF EXISTS "planning_event_enrollment_insert" ON public.planning_event_enrollment;
CREATE POLICY "planning_event_enrollment_insert" ON public.planning_event_enrollment AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text]))))) OR (EXISTS ( SELECT 1
   FROM planning_event e
  WHERE ((e.id = planning_event_enrollment.event_id) AND (e.owner_user_id = auth.uid()) AND (e.slot_type = 'cours'::text)))) OR ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'prof'::text)))) AND (EXISTS ( SELECT 1
   FROM (planning_event e
     JOIN profiles po ON ((po.id = e.owner_user_id)))
  WHERE ((e.id = planning_event_enrollment.event_id) AND (e.slot_type = 'cours'::text) AND (po.role = ANY (ARRAY['eleve'::text, 'prof'::text]))))))));
DROP POLICY IF EXISTS "planning_event_enrollment_select" ON public.planning_event_enrollment;
CREATE POLICY "planning_event_enrollment_select" ON public.planning_event_enrollment AS PERMISSIVE FOR SELECT TO authenticated USING (((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text]))))) OR (student_user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM planning_event e
  WHERE ((e.id = planning_event_enrollment.event_id) AND (e.owner_user_id = auth.uid())))) OR ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'prof'::text)))) AND (EXISTS ( SELECT 1
   FROM (planning_event e
     JOIN profiles po ON ((po.id = e.owner_user_id)))
  WHERE ((e.id = planning_event_enrollment.event_id) AND (e.slot_type = 'cours'::text) AND (po.role = ANY (ARRAY['eleve'::text, 'prof'::text]))))))));
DROP POLICY IF EXISTS "planning_event_google_mirror_admin_select" ON public.planning_event_google_mirror;
CREATE POLICY "planning_event_google_mirror_admin_select" ON public.planning_event_google_mirror AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text]))))));
DROP POLICY IF EXISTS "planning_event_google_mirror_select_event_visible" ON public.planning_event_google_mirror;
CREATE POLICY "planning_event_google_mirror_select_event_visible" ON public.planning_event_google_mirror AS PERMISSIVE FOR SELECT TO authenticated USING (((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text]))))) OR (EXISTS ( SELECT 1
   FROM planning_event e
  WHERE ((e.id = planning_event_google_mirror.event_id) AND (e.owner_user_id = auth.uid())))) OR ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'prof'::text)))) AND (EXISTS ( SELECT 1
   FROM (planning_event e
     JOIN profiles po ON ((po.id = e.owner_user_id)))
  WHERE ((e.id = planning_event_google_mirror.event_id) AND (po.role = ANY (ARRAY['eleve'::text, 'prof'::text]))))))));
DROP POLICY IF EXISTS "planning_event_series_delete" ON public.planning_event_series;
CREATE POLICY "planning_event_series_delete" ON public.planning_event_series AS PERMISSIVE FOR DELETE TO authenticated USING (((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text]))))) OR (owner_user_id = auth.uid())));
DROP POLICY IF EXISTS "planning_event_series_insert" ON public.planning_event_series;
CREATE POLICY "planning_event_series_insert" ON public.planning_event_series AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((owner_user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text, 'prof'::text])))))));
DROP POLICY IF EXISTS "planning_event_series_select" ON public.planning_event_series;
CREATE POLICY "planning_event_series_select" ON public.planning_event_series AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND ((p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text])) OR ((p.role = 'prof'::text) AND (planning_event_series.owner_user_id = auth.uid())))))));
DROP POLICY IF EXISTS "planning_event_series_update" ON public.planning_event_series;
CREATE POLICY "planning_event_series_update" ON public.planning_event_series AS PERMISSIVE FOR UPDATE TO authenticated USING (((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text]))))) OR (owner_user_id = auth.uid()))) WITH CHECK (((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text]))))) OR (owner_user_id = auth.uid())));
DROP POLICY IF EXISTS "planning_event_series_exception_delete" ON public.planning_event_series_exception;
CREATE POLICY "planning_event_series_exception_delete" ON public.planning_event_series_exception AS PERMISSIVE FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM (planning_event_series s
     JOIN profiles p ON ((p.id = auth.uid())))
  WHERE ((s.id = planning_event_series_exception.series_id) AND ((p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text])) OR ((p.role = 'prof'::text) AND (s.owner_user_id = auth.uid())))))));
DROP POLICY IF EXISTS "planning_event_series_exception_insert" ON public.planning_event_series_exception;
CREATE POLICY "planning_event_series_exception_insert" ON public.planning_event_series_exception AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((created_by_user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM (planning_event_series s
     JOIN profiles p ON ((p.id = auth.uid())))
  WHERE ((s.id = planning_event_series_exception.series_id) AND ((p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text])) OR ((p.role = 'prof'::text) AND (s.owner_user_id = auth.uid()))))))));
DROP POLICY IF EXISTS "planning_event_series_exception_select" ON public.planning_event_series_exception;
CREATE POLICY "planning_event_series_exception_select" ON public.planning_event_series_exception AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (planning_event_series s
     JOIN profiles p ON ((p.id = auth.uid())))
  WHERE ((s.id = planning_event_series_exception.series_id) AND ((p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text])) OR ((p.role = 'prof'::text) AND (s.owner_user_id = auth.uid())))))));
DROP POLICY IF EXISTS "planning_event_series_exception_update" ON public.planning_event_series_exception;
CREATE POLICY "planning_event_series_exception_update" ON public.planning_event_series_exception AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM (planning_event_series s
     JOIN profiles p ON ((p.id = auth.uid())))
  WHERE ((s.id = planning_event_series_exception.series_id) AND ((p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text])) OR ((p.role = 'prof'::text) AND (s.owner_user_id = auth.uid()))))))) WITH CHECK ((created_by_user_id = auth.uid()));
DROP POLICY IF EXISTS "planning_infra_error_log_admin_select" ON public.planning_infra_error_log;
CREATE POLICY "planning_infra_error_log_admin_select" ON public.planning_infra_error_log AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text]))))));
DROP POLICY IF EXISTS "profiles_select_admin_prof_peers" ON public.profiles;
CREATE POLICY "profiles_select_admin_prof_peers" ON public.profiles AS PERMISSIVE FOR SELECT TO authenticated USING (((auth.uid() = id) OR (profiles_viewer_role() = ANY (ARRAY['admin_technique'::text, 'admin_iams'::text, 'prof'::text]))));

create or replace function public.planning_directory_users()
returns table (
    role text,
    user_id uuid,
    prenom text,
    nom text,
    display_name text,
    email text,
    telephone text,
    calendar_label text
)
language plpgsql
stable
security definer
set search_path = public, auth
as $fn$
declare
    v_viewer uuid;
    v_viewer_role text;
    v_privileged boolean;
begin
    v_viewer := auth.uid();
    if v_viewer is null then
        raise exception 'Non authentifié' using errcode = '28000';
    end if;

    select p0.role into v_viewer_role
    from public.profiles p0
    where p0.id = v_viewer;

    if v_viewer_role is null
       or v_viewer_role not in ('admin_technique', 'admin_iams', 'prof', 'eleve') then
        raise exception 'Accès annuaire refusé.' using errcode = '42501';
    end if;

    v_privileged := public.planning_role_is_admin(v_viewer_role) or v_viewer_role = 'prof';

    return query
    select
        p.role::text as role,
        p.id as user_id,
        coalesce(nullif(trim(both from p.prenom::text), ''), '')::text as prenom,
        coalesce(nullif(trim(both from p.nom::text), ''), '')::text as nom,
        coalesce(
            nullif(
                trim(
                    both
                    from concat_ws(
                        ' ',
                        nullif(trim(both from coalesce(p.prenom, '')), ''),
                        nullif(trim(both from coalesce(p.nom, '')), '')
                    )
                ),
                ''
            ),
            nullif(trim(both from coalesce(p.display_name, '')), ''),
            u.email::text
        ) as display_name,
        case
            when v_privileged or p.id = v_viewer then coalesce(u.email::text, '')
            when v_viewer_role = 'eleve'
                 and p.role = 'eleve'
                 and coalesce(p.directory_share_email, true) then coalesce(u.email::text, '')
            else ''
        end as email,
        case
            when v_privileged or p.id = v_viewer then coalesce(p.telephone, '')
            when v_viewer_role = 'eleve'
                 and p.role = 'eleve'
                 and coalesce(p.directory_share_phone, false) then coalesce(p.telephone, '')
            else ''
        end as telephone,
        case
            when v_privileged or p.id = v_viewer then coalesce(nullif(trim(both from g.label::text), ''), '')
            when v_viewer_role = 'eleve'
                 and p.role = 'eleve'
                 and coalesce(p.directory_share_calendar, false) then coalesce(nullif(trim(both from g.label::text), ''), '')
            else ''
        end as calendar_label
    from public.profiles p
    join auth.users u on u.id = p.id
    left join public.google_calendar_pool g on g.assigned_user_id = p.id
    where p.role in ('admin_technique', 'admin_iams', 'prof', 'eleve')
      and (u.banned_until is null or u.banned_until <= now())
    order by
        case p.role
            when 'admin_technique' then 1
            when 'admin_iams' then 2
            when 'prof' then 3
            else 4
        end,
        lower(trim(both from coalesce(p.nom, ''))),
        lower(trim(both from coalesce(p.prenom, '')));
end;
$fn$;

comment on function public.planning_directory_users() is
    'Annuaire : staff voit tout ; le partage mail/tél/agenda ne s''applique qu''entre élèves.';

do $rewrite$
declare
    r record;
    def text;
    newdef text;
begin
    for r in
        select p.oid
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and position('''admin''' in pg_get_functiondef(p.oid)) > 0
          and p.proname not in (
            'planning_role_is_admin',
            'planning_role_is_admin_technique',
            'planning_auth_is_admin',
            'planning_auth_is_admin_technique',
            'planning_auth_is_admin_or_prof',
            'planning_directory_users'
          )
    loop
        def := pg_get_functiondef(r.oid);
        newdef := def;
        newdef := replace(newdef, '''admin'', ''prof'', ''eleve''', '''admin_technique'', ''admin_iams'', ''prof'', ''eleve''');
        newdef := replace(newdef, '''admin'', ''prof''', '''admin_technique'', ''admin_iams'', ''prof''');
        newdef := replace(newdef, 'role in (''admin'', ''prof'', ''eleve'')', 'role in (''admin_technique'', ''admin_iams'', ''prof'', ''eleve'')');
        newdef := replace(newdef, 'role in (''admin'', ''prof'')', 'role in (''admin_technique'', ''admin_iams'', ''prof'')');
        newdef := replace(newdef, 'p.role in (''admin'', ''prof'', ''eleve'')', 'p.role in (''admin_technique'', ''admin_iams'', ''prof'', ''eleve'')');
        newdef := replace(newdef, 'p.role in (''admin'', ''prof'')', 'p.role in (''admin_technique'', ''admin_iams'', ''prof'')');
        newdef := replace(newdef, 'p0.role in (''admin'', ''prof'', ''eleve'')', 'p0.role in (''admin_technique'', ''admin_iams'', ''prof'', ''eleve'')');
        newdef := replace(newdef, 'p0.role in (''admin'', ''prof'')', 'p0.role in (''admin_technique'', ''admin_iams'', ''prof'')');
        newdef := replace(newdef, 'pa.role in (''admin'', ''prof'')', 'pa.role in (''admin_technique'', ''admin_iams'', ''prof'')');
        newdef := replace(newdef, 'me.role = ''admin''', 'public.planning_role_is_admin(me.role)');
        newdef := replace(newdef, 'p.role = ''admin''', 'public.planning_role_is_admin(p.role)');
        newdef := replace(newdef, 'when ''admin'' then 1', 'when ''admin_technique'' then 1 when ''admin_iams'' then 1');
        newdef := replace(newdef, 'when ''admin'' then', 'when ''admin_technique'' then');
        if position('planning_stats_' in def) > 0 then
            newdef := replace(newdef, 'role in (''admin_technique'', ''admin_iams'', ''prof'')', 'role in (''admin_technique'', ''prof'')');
            newdef := replace(newdef, 'p.role in (''admin_technique'', ''admin_iams'', ''prof'')', 'p.role in (''admin_technique'', ''prof'')');
        end if;
        if newdef is distinct from def then
            execute newdef;
        end if;
    end loop;
end;
$rewrite$;
