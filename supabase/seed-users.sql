-- Provisionnement des comptes de base (Supabase Auth + public.profiles)
-- Exécuter avec un rôle propriétaire/service_role dans SQL Editor.
-- Idempotent : peut être relancé sans dupliquer les utilisateurs.
--
-- IMPORTANT :
-- - instance_id doit être celui de auth.instances (jamais 00000000-… inséré à la main sur l’hébergé).
-- - chaque utilisateur doit avoir une ligne dans auth.identities (provider email).
-- - Jetons (confirmation_token, recovery_token, …) : sur Auth récent, NULL peut casser la connexion ;
--   on utilise des chaînes vides. bcrypt : gen_salt('bf', 10). Extension pgcrypto requise (souvent déjà active).

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
            'Impossible de déterminer instance_id : auth.instances est vide et aucun utilisateur n’a un instance_id valide. '
            'Créez d’abord un compte via Dashboard → Authentication → Add user, puis relancez ce script.';
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
                confirmation_token,
                recovery_token,
                email_change,
                email_change_token_new
            )
            values (
                v_uid,
                v_instance_id,
                'authenticated',
                'authenticated',
                v_email,
                crypt(v_password, gen_salt('bf', 10)),
                now(),
                jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
                jsonb_build_object('display_name', v_display_name, 'role', v_role),
                now(),
                now(),
                '',
                '',
                '',
                ''
            );
        else
            update auth.users
            set
                encrypted_password = crypt(v_password, gen_salt('bf', 10)),
                email_confirmed_at = coalesce(email_confirmed_at, now()),
                raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('display_name', v_display_name, 'role', v_role),
                updated_at = now(),
                confirmation_token = coalesce(confirmation_token, ''),
                recovery_token = coalesce(recovery_token, ''),
                email_change = coalesce(email_change, ''),
                email_change_token_new = coalesce(email_change_token_new, '')
            where id = v_uid;
        end if;

        /* Même forme qu’un compte créé via Auth : obligatoire pour listUsers admin / GoTrue. */
        if not exists (
            select 1 from auth.identities i
            where i.user_id = v_uid and i.provider = 'email'
        ) then
            insert into auth.identities (
                id,
                user_id,
                provider_id,
                provider,
                identity_data,
                last_sign_in_at,
                created_at,
                updated_at
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
        where id = v_uid
          and instance_id is distinct from v_instance_id;

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
