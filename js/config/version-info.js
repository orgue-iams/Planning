/**
 * Libellé de build affiché sur l’écran de connexion et dans l’en-tête du planning.
 * Mettre à jour `APP_VERSION_LABEL` et `APP_BUILD_STAMP` à chaque déploiement.
 */
export const APP_VERSION_LABEL = 'planning-2026.04.08';

/** Heure ISO UTC de génération / déploiement de cette build (précise). */
export const APP_BUILD_STAMP = '2026-04-08T17:45:00.000Z';

export function formatVersionBadgeText() {
    return `${APP_VERSION_LABEL} · ${APP_BUILD_STAMP}`;
}
