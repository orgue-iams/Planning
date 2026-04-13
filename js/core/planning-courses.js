/**
 * Cours (événements type=cours) : filtrage par rôle / inscriptions, plages de dates.
 */
import {
    calendarListCacheKey,
    cloneCachedCalendarRows,
    getCalendarListCache,
    setCalendarListCache
} from './calendar-events-list-cache.js';
import { fetchPlanningEventsForFullCalendar } from './planning-events-db.js';
import { formatTimeFr24 } from '../utils/time-helpers.js';
import { getPlanningSessionUser } from './session-user.js';
import { isBackendAuthConfigured } from './supabase-client.js';

/** Début lundi 00:00 et fin dimanche 23:59:59.999 (locale). */
export function isoWeekRangeLocal(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dow = (x.getDay() + 6) % 7;
    x.setDate(x.getDate() - dow);
    x.setHours(0, 0, 0, 0);
    const end = new Date(x);
    end.setDate(end.getDate() + 7);
    end.setMilliseconds(end.getMilliseconds() - 1);
    return { start: x, end };
}

export function filterCoursEventsForUser(events, user) {
    const me = String(user?.email ?? '')
        .trim()
        .toLowerCase();
    const role = String(user?.role ?? '').toLowerCase();
    const cours = events.filter((ev) => String(ev?.extendedProps?.type ?? '').toLowerCase() === 'cours');
    if (!me) return [];
    if (role === 'admin') return cours;
    if (role === 'prof') {
        return cours.filter((ev) => String(ev?.extendedProps?.owner ?? '').trim().toLowerCase() === me);
    }
    return cours.filter((ev) => {
        const ins = ev?.extendedProps?.inscrits;
        if (Array.isArray(ins) && ins.length > 0) {
            return ins.some((x) => String(x).trim().toLowerCase() === me);
        }
        return false;
    });
}

/**
 * @param {unknown[]} events événements déjà filtrés « mes cours »
 */
export function sortEventsByStart(events) {
    return [...events].sort((a, b) => {
        const ta = new Date(String(a?.start ?? 0)).getTime();
        const tb = new Date(String(b?.start ?? 0)).getTime();
        return ta - tb;
    });
}

/**
 * @param {{ title?: string, start?: string, end?: string, extendedProps?: { owner?: string, ownerDisplayName?: string } }} ev
 */
export function formatCoursLineFr(ev) {
    const title = String(ev?.title ?? 'Cours').trim() || 'Cours';
    const owner = String(ev?.extendedProps?.owner ?? '').trim();
    const profName =
        String(ev?.extendedProps?.ownerDisplayName ?? '').trim() ||
        (owner ? owner.split('@')[0] : '—');
    const start = ev?.start ? new Date(String(ev.start)) : null;
    const end = ev?.end ? new Date(String(ev.end)) : null;
    if (!start || Number.isNaN(start.getTime())) return `${title} — ${profName}`;
    const day = start.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
    const t0 = formatTimeFr24(start);
    const t1 = end && !Number.isNaN(end.getTime()) ? formatTimeFr24(end) : '';
    const hours = t1 ? `${t0} – ${t1}` : t0;
    return `${day}, ${hours} — ${title} — ${profName}`;
}

/**
 * @param {Date} rangeStart
 * @param {Date} rangeEnd
 */
export async function fetchCalendarEventsInRange(rangeStart, rangeEnd) {
    if (!isBackendAuthConfigured()) return [];
    const u = getPlanningSessionUser();
    const cacheKey = calendarListCacheKey(
        rangeStart.toISOString(),
        rangeEnd.toISOString(),
        `db:${u?.id || ''}`
    );
    const hit = getCalendarListCache(cacheKey);
    if (hit) return cloneCachedCalendarRows(hit);
    const rows = await fetchPlanningEventsForFullCalendar(rangeStart, rangeEnd, u);
    setCalendarListCache(cacheKey, cloneCachedCalendarRows(rows));
    return rows;
}
