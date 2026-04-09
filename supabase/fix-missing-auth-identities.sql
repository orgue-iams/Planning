-- Réparation ponctuelle : utilisateurs présents dans auth.users (e-mail) sans ligne auth.identities.
-- Provient souvent d’anciennes exécutions de seed-users.sql avant la correction.
-- À exécuter dans Database → SQL Editor (rôle suffisant sur auth).
-- Idempotent : ne recrée pas une identité « email » si elle existe déjà.
-- Sur PG 17 / Auth récent, identities.email est une colonne générée : ne pas l’insérer.

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
select
    gen_random_uuid(),
    u.id,
    u.id::text,
    'email',
    jsonb_build_object(
        'sub', u.id::text,
        'email', u.email,
        'email_verified', (u.email_confirmed_at is not null),
        'phone_verified', false
    ),
    coalesce(u.last_sign_in_at, u.created_at),
    u.created_at,
    coalesce(u.updated_at, now())
from auth.users u
where u.email is not null
  and trim(u.email) <> ''
  and not exists (
      select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email'
  );
