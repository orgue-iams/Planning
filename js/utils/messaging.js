/**
 * Consignes (texte local) — repli si pas de backend.
 */

const KEY_RULES = 'orgue_iams_rules';

const DEFAULT_RULES = `Consignes

Horaires de l'ICT:
À compter du 8 septembre lundi, mardi, mercredi et vendredi de 9h à 20h45, jeudi de 9h à 21h45.

Travail personnel :
2 h par semaine / par personne. Il est possible de réserver des créneaux sur 3 semaines consécutives.

Messe à 12h40: il n'est pas possible de réserver entre 12h et 13h30

Chapelle réservée pour le chœur grégorien le mardi de 17h30 à 20h30 pour les dates suivantes: 25/11, 2/12, 20/01, 25/02, 17/03, 26/05, 23/06, 30/06`;

export function getRulesText() {
    try {
        return localStorage.getItem(KEY_RULES) || DEFAULT_RULES;
    } catch {
        return '';
    }
}

export function setRulesText(text) {
    localStorage.setItem(KEY_RULES, text);
}
