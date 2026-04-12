# Spécification fonctionnelle (aperçu)

Application web **PWA** de planning autour de l’orgue : consultation et gestion de créneaux sur un **Google Calendar** partagé, avec **authentification** et **profils** côté **Supabase**.

## Objectifs

- Afficher une **grille calendrier** (semaine / mois / liste) alignée sur les horaires « chapelle » configurables.
- **Créer, modifier, supprimer** des réservations selon le **rôle** et le **propriétaire** du créneau.
- Synchroniser les opérations avec **Google Calendar** via une **Edge Function** (pas d’Apps Script obligatoire en prod).
- Permettre à l’**admin** de gérer les **comptes**, le **pool de calendriers secondaires**, la **configuration org** (année scolaire, plages horaires) et les **gabarits de semaines** (A/B).
- Offrir aux **élèves** une vision de leurs **cours** (bandeau / profil) et des **consignes** / annonces selon le contenu éditorial stocké en base.

## Rôles

| Rôle | Idée générale |
|------|----------------|
| **admin** | Gestion des comptes, pool Google secondaire, configuration org, gabarits ; accès complet aux motifs de réservation (dont Fermeture). |
| **prof** | Créneaux cours / travail perso. sur le calendrier principal ou personnel (pool) ; gabarit semaines types ; pas de motif Fermeture en création. |
| **eleve** | Réservations personnelles et cours ; UI simplifiée (titres de réservation, pas de champ « titre libre » comme les profs selon les écrans). |
| **consultation** | Lecture ; pas d’édition ; pas de calendrier secondaire IAMS. |

Les règles fines (qui peut glisser-déposer quoi, passé interdit, etc.) sont dans `js/core/calendar-logic.js` et les politiques **RLS** SQL.

## Concepts métier

- **Motifs de réservation** : Travail perso. (valeur stockée `Travail`), Cours, Fermeture (admin seulement en liste). Couleur / type technique dérivés du motif (`reservation-motifs.js`).
- **Calendrier principal** : agenda Google « général » (tous les créneaux orgue).
- **Calendrier personnel (pool)** : un agenda Google secondaire **attribué** à l’utilisateur (hors consultation) pour réservations « travail » / usage perso. côté Google.
- **Semaines A/B** : ancrage sur un lundi de référence ; gabarit par semaine (lignes jour / heure / type cours–travail / élèves inscrits).
- **Inscrits** : élèves rattachés à une ligne de cours (gabarit) ; propagés vers Google (description / propriétés privées selon implémentation bridge).

## Hors périmètre assumé (ou partiel)

- Pas de remplacement complet de Google Agenda (l’app est un client riche + règles IAMS).
- Les secrets (clés Supabase, Google, Brevo) ne doivent **pas** être commités : voir `planning.config.js` (local / CI) et secrets Supabase pour les fonctions.
