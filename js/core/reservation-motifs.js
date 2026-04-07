/**
 * Motifs de réservation imposés (intitulé du créneau = l’un de ces libellés).
 * Le type technique (couleur / règles) est dérivé du motif.
 */

export const RESERVATION_MOTIFS = /** @type {const} */ ['Travail', 'Cours', 'Fermeture', 'Autre'];

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
    if (!s) return 'Travail';
    if (RESERVATION_MOTIFS.includes(s)) return s;
    return 'Autre';
}
