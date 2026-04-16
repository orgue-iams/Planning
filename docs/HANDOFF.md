# Reprise de session — Planning canonique (Postgres) + miroir Google

**À lire en premier** par un agent Cursor (ou un humain) qui reprend le projet **sans refaire toute la spec** avec le porteur.

## Objectif d’architecture (cible)

| Élément | Décision |
|---------|----------|
| **Source de vérité** | PostgreSQL : table `planning_event` (+ `planning_event_enrollment` pour les inscriptions cours). |
| **Google Calendar** | **Miroir** pour les utilisateurs (lecture abonnement / confort) ; écriture par l’app via `calendar-bridge`, pas de logique métier dans Google. |
| **Grille FullCalendar** | Lecture via RPC `planning_events_in_range` uniquement (pas de mode « liste Google » côté front). |
| **Sync** | Après écriture DB → push Google (général + pool concerné) ; table `planning_event_google_mirror` pour tracer ids / statut ; `sync_generation` sur `planning_event` pour invalidation future des retries. |
| **Erreurs infra** | Table `planning_infra_error_log` + e-mail digest nocturne (paramètre `planning_error_notify_email` dans `organ_school_settings`) — **pas encore implémenté** côté job / envoi. |

## Où on en est (livré dans le dépôt)

### Base de données (migrations)

- **`015_planning_events_canonical.sql`** : `planning_event`, `planning_event_enrollment`, `planning_event_google_mirror`, `planning_infra_error_log`, RLS de base, RPC `planning_events_in_range` (évoluée en 016), `planning_error_notify_email`.
- **`016_planning_event_rls_prof_and_mirror.sql`** : RLS prof/admin (créneaux pour autrui, édition élève/prof), RPC `planning_user_id_for_email`, index unique miroir `(event_id, target)`, politique SELECT miroir pour owner/prof/admin, trigger `sync_generation`, **remplacement** de `planning_events_in_range` via `DROP FUNCTION` + `CREATE` (colonnes `main_google_event_id`, `pool_google_event_id`).
- **`017_planning_events_in_range_inscrits.sql`** : RPC `planning_events_in_range` avec colonne **`inscrits_emails`** (agrégat depuis `planning_event_enrollment` + `auth.users`) ; **`SECURITY DEFINER`** avec filtre identique à l’ancienne RLS `planning_event_select` (pas d’élévation de privilèges hors périmètre visible).
- **`022_planning_profiles_label_for_ids_allow_all_roles.sql`** : élargit `planning_profiles_label_for_ids` à tous les rôles planning (admin/prof/eleve/consultation) pour afficher partout des libellés **Prénom Nom**.

À appliquer sur l’environnement cible : `supabase db push` (déjà validé une fois le `DROP FUNCTION` ajouté pour le changement de signature).

### Front (JS)

- **`js/config/planning.config.js`** : pas de drapeau grille : la grille lit toujours Postgres si session Supabase OK.
- **`js/core/planning-events-db.js`** : RPC, mapping FC (`extendedProps.inscrits` depuis `inscrits_emails`), `upsertPlanningEventRow`, `deletePlanningEventRow`, `fetchPlanningMirrorTargetsForDelete`, `planningUserIdForEmail`, import dynamique de `calendar-logic` pour éviter cycle.
- **`js/core/calendar-logic.js`** : sauvegarde modale + récurrence + création rapide (Postgres + miroir Google) ; suppression DB + delete Google via miroirs ; `syncReservationEventToGoogle` avec `planningEventId` ; `refetchPlanningGrid` après changements.
- **`js/core/reservation-motifs.js`** : motifs alignés `Travail` / `Cours` / `Concert` / `Autre` / `Fermeture` (mapping DB explicite).
- **`js/core/calendar-logic.js`** : modale Cours (liste inscrits lecture seule, édition via icône utilisateurs, DnD + clic/double-clic, limite 5), mise à jour immédiate couleur/type local, libellés propriétaire en **Prénom Nom**.
- **`js/core/semaines-types-ui.js`** : même UX de sélection élèves que la modale créneau, affichage inscrits en multi-lignes, ajout de ligne visible (scroll + highlight).
- **`js/config/fc-settings.js`** / **`planning-courses.js`** / **`calendar-events-list-cache.js`** : cache liste grille avec clé `db:userId`.
- **`organ-settings.js`**, **`modal-config.html`**, **`config-ui.js`** : chargement / enregistrement `planning_error_notify_email` (admin).
- **Header** : menu compte (icône personne) commun à tous les rôles ; **Réglages** (engrenage) et **sem. types** (calendrier) pour prof. / admin. ; libellé UI **Calendriers des utilisateurs** pour le pool Google (admin.).

### Edge — `calendar-bridge`

- Action **`adminWipeCalendarsInRange`** (JWT **admin** uniquement) : `timeMin` / `timeMax` ISO ; liste puis supprime **tous** les événements Google sur la plage pour `GOOGLE_CALENDAR_ID` + chaque `google_calendar_pool` avec `assigned_user_id` non null (dédup). Sert le bouton « Vider semaine » quand la base et Google sont désynchronisés.
- Payload événement : `planningEventId` (UUID `planning_event`).
- Après upsert Google : persistance `planning_event_google_mirror` si **`SUPABASE_SERVICE_ROLE_KEY`** (auto) ou **`SERVICE_ROLE_KEY`** (secret Edge manuel — le dashboard **interdit** le préfixe `SUPABASE_` pour les secrets saisis à la main).
- Retour `poolGoogleEventId` optionnel dans `results[]`.

### Documentation opérationnelle

- **`supabase/SETUP.txt`** : secrets dont `SERVICE_ROLE_KEY`, déploiement.

## Ce qu’il reste à faire (backlog agent)

Numérotation indicative ; détail technique dans le code / migrations existantes.

1. **Retry / abandon sync** (spec initiale : ≤ 8 retries sur 10 min, abandon, `sync_generation` pour ignorer les retries obsolètes) — **non implémenté** (pas de file d’attente ni Edge dédiée).
2. **Job nocturne** : réaligner tous les calendriers (général + pool) sur la DB — **non implémenté** (pg_cron, Edge schedulée, ou GitHub Action + script service role).
3. **Digest nocturne erreurs infra** : lire `planning_infra_error_log` où `digest_sent_at IS NULL`, envoyer un mail à `planning_error_notify_email`, marquer `digest_sent_at` — **non implémenté** (aucune écriture systématique dans `planning_infra_error_log` depuis l’app ou le bridge pour l’instant).
4. **Écriture dans `planning_infra_error_log`** : en cas d’échec bridge / DB critique (401 service account, etc.) — partiellement spécifié ; à brancher côté bridge ou front sans spammer l’utilisateur.
5. **`planning_event_enrollment`** : RPC + mapping FC (017) ; **modale réservation** (admin/prof, motif Cours) : liste multi `planning_list_eleves_actifs` + `replacePlanningEventEnrollment` + bridge `inscrits` ; création rapide **élève** + Cours : auto-inscription à soi-même. **Migration 018** : RLS insert/select/delete enrollment pour **prof** sur cours propriétaire élève/prof.
6. **Semaines types / gabarit** : **`executeTemplateDatabasePhase`** (Postgres seul, sans Google) puis **`runTemplateGoogleBackgroundSync`** : suppressions miroirs triées **général → pool prof → autres**, upserts **un par un** avec pauses (`GOOGLE_BG_*_GAP_MS`) pour limiter les quotas ; UI bloque Préparer / Appliquer jusqu’à la fin (`stGoogleSyncInFlight`). Mode Google-only : même synchro séquentielle sans étape base.
7. **Cohérence hors modale** : tout créneau créé uniquement côté Google (ancien flux) ne doit plus exister si la grille est 100 % DB ; migrations données éventuelles hors périmètre « fresh start ».
8. **Tests / CI** : pas de tests auto sur le nouveau flux DB + bridge.
9. **TODO futur (non prioritaire)** : **contrôle de cohérence** entre Postgres et le **calendrier général** Google seul — comparer une plage (ex. semaine courante + *n* semaines), produire un **rapport d’écarts** (base sans miroir, Google sans ligne base, horaires différents) ; correction automatique éventuelle dans un second temps. Alternative plus légère au job nocturne « tous calendriers » (point 2). **Pas pour le moment.**

## Checklist rapide « environnement prêt »

- [ ] Migrations **015 → 022** appliquées (`supabase db push`).
- [ ] `calendar-bridge` **redéployé** après les changements TypeScript.
- [ ] Secret Edge **`SERVICE_ROLE_KEY`** = JWT **service_role** (Settings → API), si l’auto-injection `SUPABASE_SERVICE_ROLE_KEY` ne suffit pas.
- [ ] Front : `CACHE_NAME` incrémenté si besoin après changements JS/CSS/components (`js/config/cache-name.js`, actuel : `orgue-v158`).

## Fichiers clés (navigation)

| Sujet | Fichiers |
|-------|----------|
| Flag grille DB | `js/config/planning.config.js` |
| Lecture / upsert / delete DB | `js/core/planning-events-db.js` |
| Sauvegarde, suppression, sync drag | `js/core/calendar-logic.js` |
| Bridge Google + miroir SQL | `supabase/functions/calendar-bridge/index.ts` |
| Schéma canonique | `supabase/migrations/015_planning_events_canonical.sql`, `016_planning_event_rls_prof_and_mirror.sql` |
| Secrets / déploiement | `supabase/SETUP.txt`, `npm run deploy:supabase` |

## Mise à jour de ce document

Après chaque session qui avance l’archi canonique : ajuster les sections **Livré** et **Reste à faire** pour que le prochain agent parte du bon état.
