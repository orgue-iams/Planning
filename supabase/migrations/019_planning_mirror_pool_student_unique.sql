-- Un miroir pool_owner / main par (event_id, target) ; un miroir pool_student par (event_id, élève).

drop index if exists planning_event_google_mirror_event_target_uq;

create unique index if not exists planning_event_google_mirror_main_owner_uq
    on public.planning_event_google_mirror (event_id, target)
    where target in ('main', 'pool_owner');

create unique index if not exists planning_event_google_mirror_pool_student_uq
    on public.planning_event_google_mirror (event_id, target_user_id)
    where target = 'pool_student' and target_user_id is not null;

comment on index planning_event_google_mirror_pool_student_uq is
    'Un enregistrement miroir Google par élève inscrit (cours), pour agendas secondaires distincts.';
