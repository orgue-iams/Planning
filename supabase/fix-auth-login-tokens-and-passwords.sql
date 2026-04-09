-- Réparation connexion après ancien seed : remplit les jetons NULL (peuvent bloquer GoTrue)
-- et réapplique les mots de passe du seed avec bcrypt cost 10.
-- Même liste d’e-mails / mots de passe que seed-users.sql.
-- À exécuter une fois dans SQL Editor après une exécution problématique de l’ancien seed.

do $$
declare
    v_users jsonb := jsonb_build_array(
        jsonb_build_object('email', 'admin@iams.fr', 'password', 'admin1234', 'display_name', 'Admin IAMS', 'role', 'admin'),
        jsonb_build_object('email', 'eleve1@iams.fr', 'password', 'eleve1234', 'display_name', 'Élève 1', 'role', 'eleve'),
        jsonb_build_object('email', 'eleve2@iams.fr', 'password', 'eleve2234', 'display_name', 'Élève 2', 'role', 'eleve'),
        jsonb_build_object('email', 'prof@iams.fr', 'password', 'prof1234', 'display_name', 'Prof IAMS', 'role', 'prof')
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

        select id into v_uid from auth.users where email = v_email;
        if v_uid is null then
            raise notice 'Utilisateur absent, ignoré : %', v_email;
            continue;
        end if;

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
    end loop;
end $$;
