/**
 * Rôles applicatifs (alignés sur public.profiles.role et les checks Supabase).
 * Valeurs stables en API : pas d’accents, pas de synonymes.
 */
export const PLANNING_ROLES = Object.freeze(['admin', 'prof', 'eleve']);

/** @param {unknown} role */
export function isPlanningRole(role) {
    return PLANNING_ROLES.includes(String(role || '').toLowerCase());
}

/** @param {unknown} role */
export function normalizePlanningRole(role) {
    const r = String(role || '').toLowerCase();
    return PLANNING_ROLES.includes(r) ? r : 'eleve';
}

/** Options pour selects admin : value = clé stockée en base. */
export const PLANNING_ROLE_OPTIONS = Object.freeze([
    { value: 'admin', label: 'Admin' },
    { value: 'prof', label: 'Prof' },
    { value: 'eleve', label: 'Élève' },
]);
