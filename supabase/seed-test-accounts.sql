-- Comptes de test locaux (sans dépendre d'adresses e-mail réelles)
-- Exécuter avec un rôle propriétaire/service_role dans SQL Editor.
-- Idempotent : relançable sans doublons.

do $$
declare
    v_users jsonb := jsonb_build_array(
        jsonb_build_object('email', 'admin.test@iams.local', 'password', 'AdminTest1234!', 'display_name', 'Admin Test', 'role', 'admin'),
        jsonb_build_object('email', 'prof.test1@iams.local', 'password', 'ProfTest1234!', 'display_name', 'Prof Test 1', 'role', 'prof'),
        jsonb_build_object('email', 'prof.test2@iams.local', 'password', 'ProfTest2234!', 'display_name', 'Prof Test 2', 'role', 'prof'),
        jsonb_build_object('email', 'eleve.test1@iams.local', 'password', 'EleveTest1234!', 'display_name', 'Élève Test 1', 'role', 'eleve'),
        jsonb_build_object('email', 'eleve.test2@iams.local', 'password', 'EleveTest2234!', 'display_name', 'Élève Test 2', 'role', 'eleve'),
        jsonb_build_object('email', 'consult.test@iams.local', 'password', 'ConsultTest1234!', 'display_name', 'Consultation Test', 'role', 'consultation')
    );
    v_item jsonb;
    v_email text;
    v_password text;
    v_display_name text;
    v_role text;
    v_uid uuid;
    v_instance_id uuid;
begin
    select inst.id into v_instance_id from auth.instances inst order by inst.id limit 1;

    if v_instance_id is null then
        select u.instance_id into v_instance_id
        from auth.users u
        where u.instance_id is not null
          and u.instance_id <> '00000000-0000-0000-0000-000000000000'::uuid
        group by u.instance_id
        order by count(*) desc
        limit 1;
    end if;

    if v_instance_id is null then
        raise exception
            'Impossible de déterminer instance_id : créez d’abord un compte via Dashboard → Authentication → Add user, puis relancez ce script.';
    end if;

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
                id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token
            )
            values (
                v_uid,
                v_instance_id,
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
            set encrypted_password = crypt(v_password, gen_salt('bf')),
                email_confirmed_at = coalesce(email_confirmed_at, now()),
                raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('display_name', v_display_name, 'role', v_role),
                updated_at = now()
            where id = v_uid;
        end if;

        if not exists (
            select 1 from auth.identities i where i.user_id = v_uid and i.provider = 'email'
        ) then
            insert into auth.identities (
                id, user_id, provider_id, provider, identity_data,
                last_sign_in_at, created_at, updated_at
            )
            values (
                gen_random_uuid(),
                v_uid,
                v_uid::text,
                'email',
                jsonb_build_object(
                    'sub', v_uid::text,
                    'email', v_email,
                    'email_verified', true,
                    'phone_verified', false
                ),
                now(),
                now(),
                now()
            );
        end if;

        update auth.users
        set instance_id = v_instance_id
        where id = v_uid and instance_id is distinct from v_instance_id;

        insert into public.profiles (id, display_name, role, updated_at)
        values (v_uid, v_display_name, v_role, now())
        on conflict (id) do update
        set display_name = excluded.display_name,
            role = excluded.role,
            updated_at = now();
    end loop;
end $$;
