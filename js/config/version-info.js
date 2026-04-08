/**
 * Affichage build : date et heure uniquement (écran de connexion + en-tête).
 * Mettre à jour `APP_BUILD_STAMP` à chaque déploiement (ISO 8601 UTC).
 */
export const APP_BUILD_STAMP = '2026-04-08T16:42:58.659Z';

/** Libellé affiché (fuseau UTC, cohérent avec le tampon ISO). */
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
        timeZone: 'UTC'
    })} UTC`;
}
