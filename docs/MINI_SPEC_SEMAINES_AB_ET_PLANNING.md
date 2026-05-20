# Mini-spec UX — Semaines A/B, décalages, jours prof, élèves

Document de cadrage produit (mai 2026), issu des échanges Stéphane / Hélène / secrétariat.  
Complète [SPEC.md](./SPEC.md) sur le périmètre **alternance bi-hebdomadaire** et la **lecture élève**.

---

## Principes communs

| Rôle | Semaines A/B | Planning |
|------|----------------|----------|
| **prof** | Gabarit A/B + repère personnel + décalage / application | Complet + libellé « Semaine A/B » (pour soi) |
| **admin** | Aucun accès (ni lecture) | Complet + **fermetures** institut |
| **eleve** | Aucun accès | Créneaux réels ; marque « mes cours inscrits » |

- **Un orgue**, calendrier **général** partagé ; conflits inter-profs inchangés (chevauchement = blocage cours).
- **A/B** = outil **prof** pour modéliser une alternance de 2 semaines ; les **élèves** ne voient que des **dates** de cours.
- **Fermetures** (`template_apply_closure_ranges`) : semaines entières exclues du gabarit ; l’alternance **ne bascule pas** sur ces semaines (comportement actuel à conserver pour application et décalage).

---

## Phase 1 — Jours d’enseignement (prof)

**Objectif** : chaque prof ne construit son gabarit que sur **ses** jours (v1 : **journées entières**).

### Données

- Nouveau champ prof (ex. `profiles.teaching_days` : `integer[]` 1=lun … 7=dim, ou table dédiée).
- Valeur par défaut à l’inscription prof : vide → à renseigner à la première ouverture « Semaines A/B ».

### UX prof

- **Profil** ou bandeau en tête de `modal_semaines_types` : cases à cocher **Lun … Dim** (+ Enregistrer).
- Aucune limite imposée par l’admin.
- Gabarit : boutons « + Créneau » et édition de ligne : `day_of_week` limité aux jours cochés.
- Cartes existantes sur d’autres jours (legacy) : affichées en lecture seule avec hint « Hors vos jours — supprimez ou changez vos jours en profil ».

### Règles métier

- Application gabarit : ne génère des occurrences que sur les jours du prof **et** dans sa plage de dates.
- Décalage +1/+2 (phase 3) : inchangé sur tous les créneaux du prof.

---

## Phase 2 — Écran « Semaines A/B » (prof)

**Objectif** : clarifier **modèle (A/B)** vs **calendrier (semaines civiles)** ; supprimer l’illusion de synchro entre profs.

### Structure modale (`modal_semaines_types`)

1. **Bloc « Mes jours »** (phase 1) — rappel / édition rapide.
2. **Gabarit — onglet unique « Mon gabarit »** (prof)
   - Colonnes **Semaine type A** / **Semaine type B** (inchangé).
   - **Plus** de mélange visuel des cartes d’un autre prof dans les listes (filtrer `owner_user_id = moi`).
3. **Admin** : accès modale **interdit** ou réduit à message « Réservé aux professeurs » ; pas de listes A/B mélangées. (Aujourd’hui admin voit tous les gabarits — à retirer.)
4. **Élève** : conserver lecture gabarit **si** besoin pédagogique actuel ; **sans** section Appliquer ni repère A/B.

**Pas de tableau « preview » semaines civiles × A/B** : l’alternance se voit sur le **planning** (libellé barre prof) ; les fermetures sont déjà prises en compte à l’**application** / au résumé « Préparer ».

### Section « Appliquer le gabarit » (prof, existante — libellés)

Renommer / préciser :

- Titre : **Recréer mes créneaux depuis le gabarit**
- Sous-texte : *Efface et recrée **mes** créneaux sur la période, selon mon gabarit et **mon** alternance à partir de la date de début.*
- Conserver : date début, radio A/B pour la **semaine contenant** la date de début, date fin, Préparer → Appliquer.
- Résumé étape 1 : rappeler explicitement *« Les créneaux des autres professeurs ne sont pas modifiés. »*

### Section « Décaler mes créneaux existants » (nouvelle, phase 3 liée)

Voir phase 3 — boutons placés **sous** le bloc alternance ou à côté, **distincts** de Appliquer.

### Barre planning (prof)

- Conserver `Semaine A` / `Semaine B` (`week-cycle.js`).
- Optionnel v2 : `Semaine A (vous)`.

---

## Phase 3 — Décalage +1 / +2 semaines (prof)

**Objectif** : décaler **tous** les créneaux **existants** du prof sans repasser par le gabarit.

### Entrée UX

- Dans `modal_semaines_types` (prof) ou sous-menu planning :
  - **Date effective** (défaut : lundi de la semaine prochaine).
  - **+1 semaine** | **+2 semaines** (pas de recul).
  - Case à cocher : *« J’ai relu les dates après fermetures »* (optionnel).
- Bouton : **Décaler mes créneaux** → confirmation avec nombre de créneaux touchés.

### Comportement

- Plage : `start_at >= date effective 00:00` (local), **tous** `slot_type` / types du prof (`owner_user_id`).
- Action : `start_at` / `end_at` +7j ou +14j (même heure, même jour de semaine relatif).
- **Ne pas** modifier `organ_prof_week_cycle` (le décalage physique ≠ inversion A/B logique).
  - *Note produit* : si le besoin réel est « inverser A et B sans bouger les dates », ce serait une action séparée « Recaler mon alternance » — hors scope v1 décalage B2.
- Base : `planning_event` puis sync Google (même pipeline que sauvegarde).
- Fermetures : les créneaux **dans** une semaine fermée peuvent être décalés calendairement ; pas de recalcul de lettre A/B ici.

### Cas limites

- Chevauchement après décalage → bloquer avec message (comme création).
- Créneaux passés : **jamais** décalés.
- Mutation en cours : désactiver boutons (comme modale réservation).

### Distinction avec « Appliquer le gabarit »

| | Décaler existant | Appliquer gabarit |
|--|------------------|-------------------|
| Gabarit modifié ? | Non requis | Oui (lignes A/B) |
| Effet | +7 / +14 j sur événements | Suppression + recréation selon A/B |
| Repère `organ_prof_week_cycle` | Inchangé | Mis à jour (date début + lettre) |

---

## Phase 4 — Élève : tiroir + planning

### Tiroir (`drawer-section-next-cours`)

- **Une carte par cours** (inscription gabarit / enrollment), pas une seule carte « le prochain » global.
- Chaque carte : prof, jour/heure habituel (gabarit), **date du prochain** créneau **où l’élève est inscrit** (`planning_event` + enrollment).
- Titre section : **Mes prochains cours** (pluriel).
- Si aucun à venir sur un cours : carte grisée *« Pas de date planifiée »*.

### Planning (FullCalendar)

- **Pas** de ligne HUD « Cette semaine : X cours ».
- **V3** sur événements `cours` où l’élève est inscrit :
  - **Pastille** (coin barre ou titre) — ex. point ou icône personne.
  - **Barre du haut** : teinte verte légère (même famille que travail perso « à moi », nuance différente pour ne pas confondre).
- Les cours **non inscrits** : style actuel, sans marque.

### Données

- S’appuyer sur `planning_event_enrollment` + événements en plage (déjà partiellement en place).

---

## Phase 5 — Nettoyage & cohérence

- **Ne plus** utiliser `organ_week_cycle` côté UI (legacy global) ; documenter dépréciation → `supabase/manual/DEPRECATED_organ_week_cycle.md`, commentaire SQL 038.
- **Admin / élève** : pas de requête `organ_prof_week_cycle`, pas de suffixe « Semaine A (vous) » dans la barre (`refreshProfWeekCycleToolbarUi`, garde `isProf` dans `calendar-toolbar.js`).
- **Modale Semaines A/B** : ouverture réservée au prof (code mort admin/élève retiré).
- Tests manuels : deux profs, repères décalés d’une semaine, même semaine civile = lettres différentes barre planning ; élève voit uniquement dates + pastilles.

---

## Ordre de développement recommandé

1. Phase 1 — Jours prof (DB + filtre gabarit)  
2. Phase 2 — UI Semaines A/B (mon gabarit + libellés + retrait admin)  
3. Phase 3 — Décalage +1/+2  
4. Phase 4 — Élève cartes + pastille/vert  
5. Phase 5 — Nettoyage  

Estimation : phases 1–2 = fondation UX la plus urgente pour votre douleur « écran synchro » ; phase 3 = action métier du décalage pratique ; phase 4 = élèves.

---

## Hors périmètre v1 (mémo)

- Demi-journées (lun PM seulement).
- Décalage **arrière** (−1 semaine).
- Resynchronisation volontaire deux profs.
- Action « inverser A/B sans bouger les dates » (recaler repère seul) — à cadrer si le décalage B2 ne suffit pas en usage réel.

---

## Fichiers code concernés (implémentation future)

| Zone | Fichiers |
|------|----------|
| Cycle A/B | `js/core/week-cycle.js`, `js/core/template-apply-engine.js` |
| UI gabarit | `js/core/semaines-types-ui.js`, `components/modal-semaines-types.html` |
| Élève | `js/core/drawer-profile-extras-ui.js`, `css/calendar-theme.css` |
| Barre prof | `js/core/calendar-toolbar.js` |
| DB | migration `profiles.teaching_days`, évent. RPC admin liste profs |
