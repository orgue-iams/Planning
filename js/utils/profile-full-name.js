/**
 * Affichage unifié : nom de famille + prénom (ordre « Nom Prénom »).
 * @param {unknown} nom
 * @param {unknown} prenom
 */
export function formatProfileFullName(nom, prenom) {
    const n = String(nom ?? '').trim();
    const p = String(prenom ?? '').trim();
    if (n && p) return `${n} ${p}`;
    return n || p || '';
}
