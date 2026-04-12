# Roadmap — fait et à faire

> Document d’orientation : à ajuster au fil des sprints. Les dates ne sont pas imposées.

## Déjà en place (résumé)

- Auth **Supabase** + mode **démo** sans backend.
- Calendrier **FullCalendar** branché sur **Google** via **`calendar-bridge`** (compte de service ou OAuth).
- **Rôles** admin / prof / élève / consultation avec règles d’édition dans `calendar-logic.js`.
- **Motifs** : Travail perso. / Cours / Fermeture (Fermeture réservée admin en UI) ; sync étendue (inscrits, calendrier ciblé, etc.).
- **Profils** : `nom` + `prenom` en base, `display_name` dérivé ; liste admin triée et formulaire création / invitation.
- **Pool** de calendriers Google secondaires + attribution / libellés.
- **Paramètres org** : année scolaire, plage horaire chapelle (`organ_school_settings`).
- **Semaines types A/B** : ancrage, gabarit, analyse / application (moteur client + bridge).
- **PWA** : service worker, cache versionné.
- **Notifications** optionnelles : **`planning-slot-notify`** (Brevo) si tiers modifie un créneau.
- **Contenu** : consignes / annonces / diffusion (Quill + tables dédiées selon migrations).

## En cours / dette technique connue

- **`planning.config.js`** : contient souvent l’**anon key** Supabase — acceptable pour une anon key mais à **ne pas dupliquer** dans la doc ; pour dépôts publics, préférer variables d’environnement / build injecté.
- **Cohérence migrations** : les environnements doivent appliquer **toutes** les migrations jusqu’à `011` (et suivantes) avant de déployer un front qui sélectionne `nom`/`prenom`.
- **Edge Functions** : version déployée doit correspondre au contrat attendu par le front (champs `nom`/`prenom`, tri liste admin, etc.).

## Pistes « à faire » (backlog suggéré)

Prioriser selon besoins pédagogiques / secrétariat.

1. **Édition inline** des `nom`/`prenom` dans le tableau admin (au lieu de seulement à la création).
2. **Tests automatisés** : au minimum tests unitaires sur `reservation-motifs`, `formatProfileFullName`, normalisation rôles ; plus tard E2E sur flux login + création créneau (Playwright).
3. **Observabilité** : logs structurés côté Edge, corrélation `user_id` / `action` pour diagnostiquer erreurs Google API.
4. **Accessibilité** : audit ciblé des modales (focus trap, `aria-*`, contrastes).
5. **Internationalisation** : aujourd’hui FR assumé ; extraire chaînes si besoin EN/DE.
6. **Documentation API interne** : OpenAPI ou tableau des `action` acceptées par `calendar-bridge` et `planning-admin` (au-delà des commentaires dans le code).
7. **Sauvegarde / export** : export ICS ou snapshot pédagogique des gabarits (hors Google).
8. **Gestion des conflits Google** : messages utilisateur plus explicites lorsque `409` / ressources occupées.

## Comment mettre à jour ce fichier

Après une fonctionnalité livrée : ajouter une ligne courte dans **Déjà en place** ou déplacer depuis **à faire**.  
Après un incident : ajouter sous **dette** si la cause est structurelle.
