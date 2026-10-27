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

/**
 * Libellé axe calendrier : initiale du prénom + nom (« N. Marestin »).
 * @param {{ prenom?: unknown, nom?: unknown, display_name?: unknown, name?: unknown } | null | undefined} user
 * @returns {{ prenomShort: string, nom: string, full: string } | null}
 */
export function formatUserAxisNameParts(user) {
    let prenom = String(user?.prenom ?? '').trim();
    let nom = String(user?.nom ?? '').trim();
    if (!prenom && !nom) {
        const fromDisplay = parseDisplayNameToNomPrenom(user?.display_name || user?.name);
        prenom = fromDisplay.prenom;
        nom = fromDisplay.nom;
    }
    const letter = prenom ? prenom.charAt(0).toLocaleUpperCase('fr-FR') : '';
    const prenomShort = letter ? `${letter}.` : '';
    if (!prenomShort && !nom) return null;
    const full = [prenomShort, nom].filter(Boolean).join(' ');
    return { prenomShort, nom, full };
}
