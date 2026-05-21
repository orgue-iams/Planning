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

/** Découpe « Prénom Nom » (dernier mot = nom de famille). */
export function parseDisplayNameToNomPrenom(displayName) {
    const parts = String(displayName ?? '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (!parts.length) return { nom: '', prenom: '' };
    if (parts.length === 1) return { nom: parts[0], prenom: '' };
    return { nom: parts[parts.length - 1], prenom: parts.slice(0, -1).join(' ') };
}
