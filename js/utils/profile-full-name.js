/**
 * Affichage unifié : prénom puis nom de famille (« Prénom Nom »).
 * @param {unknown} nom
 * @param {unknown} prenom
 */
export function formatProfileFullName(nom, prenom) {
    const n = String(nom ?? '').trim();
    const p = String(prenom ?? '').trim();
    if (n && p) return `${p} ${n}`;
    return p || n || '';
}
