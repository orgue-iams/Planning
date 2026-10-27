/**
 * Rôles applicatifs (alignés sur public.profiles.role et les checks Supabase).
 * Valeurs stables en API : pas d’accents, pas de synonymes.
 */
export const PLANNING_ROLES = Object.freeze([
    'admin_technique',
    'admin_iams',
    'prof',
    'eleve'
]);

/** Ordre d’affichage annuaire / listes admin. */
const ROLE_SORT_RANK = Object.freeze({
    admin_technique: 1,
    admin_iams: 2,
    prof: 3,
    eleve: 4
});

/** @param {unknown} role */
export function isPlanningRole(role) {
    const r = normalizePlanningRole(role);
    return PLANNING_ROLES.includes(r);
}

/**
 * Normalise un rôle (legacy `admin` → `admin_technique`).
 * @param {unknown} role
 */
export function normalizePlanningRole(role) {
    const r = String(role || '')
        .trim()
        .toLowerCase();
    if (r === 'admin') return 'admin_technique';
    return PLANNING_ROLES.includes(r) ? r : 'eleve';
}

/** @param {unknown} role */
export function isAdminRole(role) {
    const r = normalizePlanningRole(role);
    return r === 'admin_technique' || r === 'admin_iams';
}

/** @param {unknown} role */
export function isAdminTechniqueRole(role) {
    return normalizePlanningRole(role) === 'admin_technique';
}

/** @param {unknown} role */
export function roleSortRank(role) {
    return ROLE_SORT_RANK[normalizePlanningRole(role)] ?? 99;
}

/**
 * Tri : admin_technique, admin_iams, prof, élève, puis nom / prénom.
 * @param {{ role?: unknown, nom?: unknown, prenom?: unknown, email?: unknown }} a
 * @param {{ role?: unknown, nom?: unknown, prenom?: unknown, email?: unknown }} b
 */
export function compareUsersByRoleThenName(a, b) {
    const ra = roleSortRank(a?.role);
    const rb = roleSortRank(b?.role);
    if (ra !== rb) return ra - rb;
    const an = String(a?.nom ?? '')
        .trim()
        .toLowerCase();
    const bn = String(b?.nom ?? '')
        .trim()
        .toLowerCase();
    if (an !== bn) return an.localeCompare(bn, 'fr');
    const ap = String(a?.prenom ?? '')
        .trim()
        .toLowerCase();
    const bp = String(b?.prenom ?? '')
        .trim()
        .toLowerCase();
    if (ap !== bp) return ap.localeCompare(bp, 'fr');
    return String(a?.email ?? '')
        .toLowerCase()
        .localeCompare(String(b?.email ?? '').toLowerCase(), 'fr');
}

/** Options pour selects admin : value = clé stockée en base. */
export const PLANNING_ROLE_OPTIONS = Object.freeze([
    { value: 'admin_technique', label: 'Admin technique' },
    { value: 'admin_iams', label: 'Admin IAMS' },
    { value: 'prof', label: 'Prof' },
    { value: 'eleve', label: 'Élève' }
]);
