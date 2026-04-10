-- Texte affiché dans la modale « Consignes » (organ_rules id = 1).
insert into public.organ_rules (id, content)
values (
    1,
    $$<h3>Consignes</h3>
<p><strong>Horaires de l'ICT</strong><br>
À compter du 8 septembre lundi, mardi, mercredi et vendredi de 9&nbsp;h à 20&nbsp;h&nbsp;45, jeudi de 9&nbsp;h à 21&nbsp;h&nbsp;45.</p>
<p><strong>Travail personnel</strong><br>
2&nbsp;h par semaine / par personne. Il est possible de réserver des créneaux sur 3 semaines consécutives.</p>
<p><strong>Messe à 12&nbsp;h&nbsp;40</strong> : il n'est pas possible de réserver entre 12&nbsp;h et 13&nbsp;h&nbsp;30.</p>
<p><strong>Chapelle réservée pour le chœur grégorien</strong> le mardi de 17&nbsp;h&nbsp;30 à 20&nbsp;h&nbsp;30 pour les dates suivantes : 25/11, 2/12, 20/01, 25/02, 17/03, 26/05, 23/06, 30/06.</p>$$
)
on conflict (id) do update
set content = excluded.content,
    updated_at = now();
