/**
 * Version affichée : vXX.YY.ZZ
 * - XX : déploiement officiel (incrémenter lors d’une release majeure / changement d’infra)
 * - YY : incrément fonctionnel (évolutions utilisateur)
 * - ZZ : correctif debug / hotfix
 */
export const APP_VERSION = 'v00.00.69';

/** Nom du cache service worker (lié à la version). */
export const CACHE_NAME = `planning-cache-${APP_VERSION}`;
