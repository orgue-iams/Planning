# `organ_week_cycle` (legacy global) — déprécié

Migration : `supabase/migrations/009_organ_week_cycle.sql`

## Statut

Cette table imposait **un seul** ancrage semaine A/B pour tout l’organisme.  
L’application utilise désormais **`organ_prof_week_cycle`** (migration 014) : **un repère par professeur**.

## Application (mai 2026)

- Aucun fichier sous `js/` ne lit ni n’écrit `organ_week_cycle`.
- La barre du planning n’affiche « Semaine A / B » que pour le rôle **`prof`**, à partir de `organ_prof_week_cycle`.
- Admin et élève ne chargent pas ce repère.

La table peut rester en base pour historique ; ne pas s’y appuyer pour de nouvelles fonctionnalités.
