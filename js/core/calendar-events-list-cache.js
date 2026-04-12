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

/** @param {unknown[]} rows — format déjà normalisé (ex. sortie de mapBridgeListEvents) */
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
