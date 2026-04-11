/**
 * Motifs de réservation imposés (intitulé du créneau = l’un de ces libellés).
 * Le type technique (couleur / règles) est dérivé du motif.
 */

export const RESERVATION_MOTIFS = /** @type {const} */ ['Travail', 'Cours', 'Fermeture'];

/** Libellé affiché dans les listes / titres de secours (la valeur logique reste « Travail »). */
export function motifDisplayLabel(motif) {
    const m = String(motif || '').trim();
    if (m === 'Travail') return 'Travail perso.';
    return m;
}

/** @param {string} motif */
export function motifToSlotType(motif) {
    const m = String(motif || '').trim();
    if (m === 'Fermeture') return 'fermeture';
    if (m === 'Cours') return 'cours';
    return 'reservation';
}

/** @param {string} value */
export function normalizeMotif(value) {
    const s = String(value || '').trim();
    if (!s || s === 'Autre') return 'Travail';
    if (RESERVATION_MOTIFS.includes(s)) return s;
    return 'Travail';
}
