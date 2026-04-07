/**
 * Motifs / cours enregistrés par utilisateur (localStorage, démo).
 */

function storageKey(email) {
    return `orgue_iams_profile_${String(email).trim().toLowerCase()}`;
}

/** @returns {{ labels: string[], favoriteLabel: string }} */
export function getProfile(email) {
    if (!email) return { labels: [], favoriteLabel: '' };
    try {
        const raw = localStorage.getItem(storageKey(email));
        if (!raw) return { labels: [], favoriteLabel: '' };
        const p = JSON.parse(raw);
        const labels = Array.isArray(p.labels)
            ? [...new Set(p.labels.map((s) => String(s).trim()).filter(Boolean))]
            : [];
        let favoriteLabel = typeof p.favoriteLabel === 'string' ? p.favoriteLabel.trim() : '';
        if (typeof p.favoriteIndex === 'number' && labels[p.favoriteIndex]) {
            favoriteLabel = labels[p.favoriteIndex];
        }
        if (favoriteLabel && !labels.includes(favoriteLabel)) {
            favoriteLabel = labels[0] || '';
        }
        if (!favoriteLabel && labels.length) favoriteLabel = labels[0];
        return { labels, favoriteLabel };
    } catch {
        return { labels: [], favoriteLabel: '' };
    }
}

export function saveProfile(email, labels, favoriteLabel) {
    const cleaned = [...new Set(labels.map((s) => String(s).trim()).filter(Boolean))];
    let fav = String(favoriteLabel || '').trim();
    if (fav && !cleaned.includes(fav)) fav = cleaned[0] || '';
    if (!fav && cleaned.length) fav = cleaned[0];
    localStorage.setItem(
        storageKey(email),
        JSON.stringify({ labels: cleaned, favoriteLabel: fav })
    );
}

export function getFavoriteLabel(email) {
    const { favoriteLabel, labels } = getProfile(email);
    if (favoriteLabel && labels.includes(favoriteLabel)) return favoriteLabel;
    return labels[0] || '';
}
