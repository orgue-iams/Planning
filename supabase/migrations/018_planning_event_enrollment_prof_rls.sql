-- Prof : gérer les inscriptions des cours dont le propriétaire est un élève ou un prof (aligné sur planning_event update 016).

drop policy if exists "planning_event_enrollment_select" on public.planning_event_enrollment;
create policy "planning_event_enrollment_select" on public.planning_event_enrollment for select to authenticated using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    or student_user_id = auth.uid()
    or exists (
        select 1
        from public.planning_event e
        where e.id = event_id and e.owner_user_id = auth.uid()
    )
    or (
        exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'prof')
        and exists (
            select 1
            from public.planning_event e
            join public.profiles po on po.id = e.owner_user_id
            where e.id = event_id
              and e.slot_type = 'cours'
              and po.role in ('eleve', 'prof')
        )
    )
);

drop policy if exists "planning_event_enrollment_insert" on public.planning_event_enrollment;
create policy "planning_event_enrollment_insert" on public.planning_event_enrollment for insert to authenticated with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    or exists (
        select 1
        from public.planning_event e
        where e.id = event_id and e.owner_user_id = auth.uid() and e.slot_type = 'cours'
    )
    or (
        exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'prof')
        and exists (
            select 1
            from public.planning_event e
            join public.profiles po on po.id = e.owner_user_id
            where e.id = event_id
              and e.slot_type = 'cours'
              and po.role in ('eleve', 'prof')
        )
    )
);

drop policy if exists "planning_event_enrollment_delete" on public.planning_event_enrollment;
create policy "planning_event_enrollment_delete" on public.planning_event_enrollment for delete to authenticated using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    or exists (
        select 1
        from public.planning_event e
        where e.id = event_id and e.owner_user_id = auth.uid() and e.slot_type = 'cours'
    )
    or (
        exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'prof')
        and exists (
            select 1
            from public.planning_event e
            join public.profiles po on po.id = e.owner_user_id
            where e.id = event_id
              and e.slot_type = 'cours'
              and po.role in ('eleve', 'prof')
        )
    )
);
