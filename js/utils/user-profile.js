/**
 * Anciennement : préférences de titres de réservation (localStorage + profiles.reservation_types).
 * Conservé uniquement pour compatibilité avec supabase-auth (hydratation sans effet).
 */

/**
 * @param {string} _email
 * @param {unknown} _reservationTypes colonne jsonb (ignorée côté client)
 */
export function hydrateReservationTypesFromServer(_email, _reservationTypes) {
    /* Les titres par défaut ne sont plus gérés par profil : champ texte libre dans la modale. */
}
