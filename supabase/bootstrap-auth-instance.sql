-- RÉSERVÉ PROTOTYPE / RÉCUPÉRATION : si la table auth.instances est VIDE et que tous les
-- auth.users ont instance_id = 00000000-0000-0000-0000-000000000000, l’API admin Auth
-- peut échouer sans possibilité de « deviner » l’instance.
--
-- Ce script crée UNE ligne dans auth.instances et aligne tous les utilisateurs sur cet id.
-- À exécuter une seule fois dans Database → SQL Editor.
--
-- Si l’INSERT échoue (colonnes différentes selon la version), exécuter dans SQL Editor :
--   select column_name, is_nullable, data_type, column_default
--   from information_schema.columns
--   where table_schema = 'auth' and table_name = 'instances'
--   order by ordinal_position;
-- … et ajuster l’INSERT ci-dessous en conséquence.

do $$
declare
    iid uuid := gen_random_uuid();
    already int;
begin
    select count(*)::int into already from auth.instances;
    if already > 0 then
        select inst.id into iid from auth.instances inst order by inst.id limit 1;
        raise notice 'auth.instances avait déjà % ligne(s) : utilisation de id = %', already, iid;
    else
        insert into auth.instances (id, uuid, created_at, updated_at)
        values (iid, iid, now(), now());
        raise notice 'Nouvelle auth.instances.id = %', iid;
    end if;

    update auth.users u
    set instance_id = iid
    where u.instance_id is distinct from iid;
end $$;
