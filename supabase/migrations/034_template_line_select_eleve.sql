-- Élèves : lecture des gabarits semaines A/B (affichage identique aux profs, sans édition).
drop policy if exists "template_line_select_eleve" on public.organ_week_template_line;
create policy "template_line_select_eleve" on public.organ_week_template_line
    for select to authenticated using (
        exists (
            select 1 from public.profiles p
            where p.id = auth.uid() and p.role = 'eleve'
        )
    );

drop policy if exists "template_line_student_select_eleve" on public.organ_week_template_line_student;
create policy "template_line_student_select_eleve" on public.organ_week_template_line_student
    for select to authenticated using (
        exists (
            select 1 from public.profiles p
            where p.id = auth.uid() and p.role = 'eleve'
        )
    );
