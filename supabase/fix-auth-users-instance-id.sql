-- Corrige auth.users.instance_id après un ancien seed utilisant 00000000-0000-0000-0000-000000000000.
-- Cette incohérence peut provoquer « Database error finding users » sur GET /auth/v1/admin/users.
-- À exécuter dans Database → SQL Editor (rôle suffisant sur auth).
--
-- Si auth.instances est vide (projet atypique) : on réutilise l’instance_id déjà présent sur un
-- utilisateur créé via le Dashboard (≠ 0000…). Sinon, message pour créer un user via Auth d’abord.

do $$
declare
    iid uuid;
    n int;
begin
    select inst.id into iid from auth.instances inst order by inst.id limit 1;

    if iid is null then
        select u.instance_id into iid
        from auth.users u
        where u.instance_id is not null
          and u.instance_id <> '00000000-0000-0000-0000-000000000000'::uuid
        group by u.instance_id
        order by count(*) desc
        limit 1;
    end if;

    if iid is null then
        raise exception
            'Impossible de déterminer instance_id : auth.instances est vide et aucun auth.users n’a un instance_id valide (différent de 00000000-0000-0000-0000-000000000000). '
            'Créez un utilisateur via Dashboard → Authentication → Users → Add user, vérifiez que auth.instances contient une ligne (select * from auth.instances), puis réexécutez ce script. '
            'Si la table auth.instances reste vide après cela : projet Auth incohérent — nouveau projet ou support Supabase.';
    end if;

    update auth.users
    set instance_id = iid
    where instance_id is distinct from iid;

    get diagnostics n = row_count;
    raise notice 'auth.users instance_id mis à jour : % ligne(s) (instance cible = %)', n, iid;
end $$;
