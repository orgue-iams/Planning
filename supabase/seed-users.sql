-- Provisionnement des comptes de base (Supabase Auth + public.profiles)
-- Exécuter avec un rôle propriétaire/service_role dans SQL Editor.
-- Idempotent : peut être relancé sans dupliquer les utilisateurs.

do $$
declare
    v_users jsonb := jsonb_build_array(
        jsonb_build_object(
            'email', 'admin@iams.fr',
            'password', 'admin1234',
            'display_name', 'Admin IAMS',
            'role', 'admin'
        ),
        jsonb_build_object(
            'email', 'eleve1@iams.fr',
            'password', 'eleve1234',
            'display_name', 'Élève 1',
            'role', 'eleve'
        ),
        jsonb_build_object(
            'email', 'eleve2@iams.fr',
            'password', 'eleve2234',
            'display_name', 'Élève 2',
            'role', 'eleve'
        ),
        jsonb_build_object(
            'email', 'prof@iams.fr',
            'password', 'prof1234',
            'display_name', 'Prof IAMS',
            'role', 'prof'
        )
    );
    v_item jsonb;
    v_email text;
    v_password text;
    v_display_name text;
    v_role text;
    v_uid uuid;
begin
    for v_item in select * from jsonb_array_elements(v_users)
    loop
        v_email := lower(trim(v_item ->> 'email'));
        v_password := v_item ->> 'password';
        v_display_name := coalesce(nullif(trim(v_item ->> 'display_name'), ''), split_part(v_email, '@', 1));
        v_role := lower(coalesce(v_item ->> 'role', 'eleve'));

        if v_role not in ('admin', 'prof', 'eleve', 'consultation') then
            v_role := 'eleve';
        end if;

        select id into v_uid from auth.users where email = v_email;

        if v_uid is null then
            v_uid := gen_random_uuid();
            insert into auth.users (
                id,
                instance_id,
                aud,
                role,
                email,
                encrypted_password,
                email_confirmed_at,
                raw_app_meta_data,
                raw_user_meta_data,
                created_at,
                updated_at,
                confirmation_token
            )
            values (
                v_uid,
                '00000000-0000-0000-0000-000000000000',
                'authenticated',
                'authenticated',
                v_email,
                crypt(v_password, gen_salt('bf')),
                now(),
                jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
                jsonb_build_object('display_name', v_display_name, 'role', v_role),
                now(),
                now(),
                ''
            );
        else
            update auth.users
            set
                encrypted_password = crypt(v_password, gen_salt('bf')),
                email_confirmed_at = coalesce(email_confirmed_at, now()),
                raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('display_name', v_display_name, 'role', v_role),
                updated_at = now()
            where id = v_uid;
        end if;

        insert into public.profiles (id, display_name, role, updated_at)
        values (v_uid, v_display_name, v_role, now())
        on conflict (id) do update
        set
            display_name = excluded.display_name,
            role = excluded.role,
            updated_at = now();
    end loop;
end $$;

-- Vérification
-- select u.email, p.display_name, p.role
-- from auth.users u
-- join public.profiles p on p.id = u.id
-- where u.email in ('admin@iams.fr', 'eleve1@iams.fr', 'eleve2@iams.fr', 'prof@iams.fr')
-- order by u.email;
