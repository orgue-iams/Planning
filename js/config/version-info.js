/**
 * Tampon de build optionnel (hors badge UI).
 * Le libellé affiché côté planning est `CACHE_NAME` dans `cache-name.js`.
 */
export const APP_BUILD_STAMP = '2026-04-08T16:42:58.659Z';

/** @deprecated Utiliser `CACHE_NAME` depuis `cache-name.js` pour l’affichage. */
export function formatVersionBadgeText() {
    const d = new Date(APP_BUILD_STAMP);
    if (Number.isNaN(d.getTime())) return APP_BUILD_STAMP;
    return `${d.toLocaleString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'UTC'
    })} UTC`;
}
