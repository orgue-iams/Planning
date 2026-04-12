# Roadmap — fait et à faire

> Les évolutions **« source de vérité Postgres + miroir Google »** sont suivies en détail dans **[HANDOFF.md](./HANDOFF.md)** (livré / backlog / checklist). Ce fichier garde une vue plus large sur le produit.

## Déjà en place (résumé)

- Auth **Supabase** + mode **démo** sans backend.
- Calendrier **FullCalendar** ; sync **Google** via **`calendar-bridge`** (compte de service ou OAuth).
- **Grille en mode canonique DB** (quand `planningGridReadsFromSupabase: true`) : RPC `planning_events_in_range`, écriture `planning_event`, suppression + sync Google via `planning_event_google_mirror` ; secrets Edge **`SERVICE_ROLE_KEY`** ou auto `SUPABASE_SERVICE_ROLE_KEY` pour persistance miroir côté bridge — voir **HANDOFF.md**.
- **Rôles** admin / prof / élève / consultation avec règles d’édition dans `calendar-logic.js` ; RLS SQL alignée (prof sur créneaux élèves/prof, etc.).
- **Motifs** : Travail perso. / Cours / Fermeture ; mapping DB `motifToPlanningDbSlotType` (`travail perso`, `cours`, `fermeture`).
- **Profils** : `nom` + `prenom`, liste admin, création / invitation.
- **Pool** calendriers Google secondaires + attribution / libellés.
- **Paramètres org** : année scolaire, plage chapelle, **`planning_error_notify_email`** (UI admin) pour futur digest infra.
- **Semaines types A/B** : gabarit, analyse / application (moteur client + bridge — **vérifier** écriture pure DB si objectif 100 % Postgres).
- **PWA** : service worker, `js/config/cache-name.js` versionné.
- **Notifications** : **`planning-slot-notify`** (Brevo) si tiers modifie un créneau.
- **Contenu** : consignes / annonces / messages (Quill + tables dédiées).

## En cours / dette technique connue

- **`planning.config.js`** : anon key souvent en clair — acceptable pour anon ; dépôt public → préférer injection CI / env.
- **Retry sync, job nocturne, digest `planning_infra_error_log`** : spécifiés dans HANDOFF, **non implémentés**.
- **Inscrits cours** en grille DB : champs `inscrits` FC encore vides côté RPC mapping — à brancher sur `planning_event_enrollment`.
- **Edge Functions** : version déployée = contrat attendu par le front (déployer après chaque changement de bridge).

## Pistes « à faire » (hors track HANDOFF)

1. Édition inline `nom`/`prenom` dans le tableau admin.
2. Tests auto : `reservation-motifs`, `formatProfileFullName`, plus tard E2E Playwright.
3. Observabilité : logs structurés Edge, corrélation `user_id` / action.
4. Accessibilité : modales (focus, `aria-*`, contrastes).
5. i18n : aujourd’hui FR ; extraire chaînes si besoin.
6. Doc API interne : tableau des `action` `calendar-bridge` / `planning-admin`.
7. Export ICS / snapshot gabarits.
8. Messages conflits Google plus explicites (mode bridge historique).

## Comment mettre à jour

- Fonctionnalité **planning canonique / miroir / sync** : **HANDOFF.md** en priorité.
- Reste du produit : une ligne ici ou déplacement entre sections.
