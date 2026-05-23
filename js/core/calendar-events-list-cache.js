/**
 * Cache court-terme des listes d’événements (grille : bridge Google ou RPC Postgres selon config).
 * scopeKey : ex. "bridge", ou "db:<userId>" pour différencier le cache par utilisateur (RLS).
 */

const TTL_MS = 90_000;

/** @type {Map<string, { at: number, rows: unknown[] }>} */
const cache = new Map();

export function calendarListCacheKey(timeMinIso, timeMaxIso, scopeKey = '') {
    return `${scopeKey}\x1e${timeMinIso}\x1e${timeMaxIso}`;
}

/** @param {unknown[]} rows — format événements FullCalendar (RPC planning) */
export function getCalendarListCache(key) {
    const e = cache.get(key);
    if (!e) return null;
    if (Date.now() - e.at > TTL_MS) {
        cache.delete(key);
        return null;
    }
    return e.rows;
}

/** @param {unknown[]} rows */
export function setCalendarListCache(key, rows) {
    cache.set(key, { at: Date.now(), rows });
}

export function invalidateCalendarListCache() {
    cache.clear();
}

/**
 * Précharge en arrière-plan les fenêtres adjacentes (semaine précédente / suivante).
 * @param {Date} start
 * @param {Date} end
 * @param {object | null | undefined} currentUser
 * @param {string} scopeKey
 */
export function warmAdjacentCalendarListCaches(start, end, currentUser, scopeKey = '') {
    if (!currentUser?.id) return;
    const span = end.getTime() - start.getTime();
    if (!Number.isFinite(span) || span <= 0) return;
    const windows = [
        [new Date(start.getTime() - span), new Date(start.getTime())],
        [new Date(end.getTime()), new Date(end.getTime() + span)]
    ];
    void import('../core/planning-events-db.js').then(({ fetchPlanningEventsForFullCalendar }) => {
        for (const [s, e] of windows) {
            const key = calendarListCacheKey(s.toISOString(), e.toISOString(), scopeKey);
            if (getCalendarListCache(key)) continue;
            void fetchPlanningEventsForFullCalendar(s, e, currentUser)
                .then((rows) => setCalendarListCache(key, cloneCachedCalendarRows(rows)))
                .catch(() => {});
        }
    });
}

/** Copie défensive pour FullCalendar / appelants (évite les mutations sur l’objet mis en cache). */
export function cloneCachedCalendarRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return list.map((ev) => {
        const o = /** @type {Record<string, unknown>} */ (ev);
        const xp = o.extendedProps;
        const ext =
            xp && typeof xp === 'object' && !Array.isArray(xp)
                ? { .../** @type {Record<string, unknown>} */ (xp) }
                : {};
        return { ...o, extendedProps: ext };
    });
}
