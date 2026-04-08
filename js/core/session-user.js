/**
 * Utilisateur connecté « vivant » pour les UI initialisées plusieurs fois (reconnexion).
 * Évite les fermetures sur capturage obsolète et les écouteurs dupliqués sans garde.
 */

/** @type {any} */
let planningSessionUser = null;

/** @param {any} u */
export function setPlanningSessionUser(u) {
    planningSessionUser = u;
}

export function getPlanningSessionUser() {
    return planningSessionUser;
}
