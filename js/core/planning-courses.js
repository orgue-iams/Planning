/**
 * Cours (événements type=cours) : filtrage par rôle / inscriptions, plages de dates.
 */
import { getAccessToken } from './auth-logic.js';
import { invokeCalendarBridge } from './calendar-bridge.js';
import {
    calendarListCacheKey,
    cloneCachedCalendarRows,
    getCalendarListCache,
    setCalendarListCache
} from './calendar-events-list-cache.js';
import { fetchPlanningEventsForFullCalendar, planningGridUsesSupabaseDb } from './planning-events-db.js';
import { getPlanningSessionUser } from './session-user.js';
import { getPlanningConfig, isBackendAuthConfigured } from './supabase-client.js';
import { demoEvents } from '../data/mock-events.js';

/** Même normalisation que fc-settings (réponse bridge → extendedProps cohérents). */
export function mapBridgeListEvents(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return list.map((ev) => {
        const o = /** @type {Record<string, unknown>} */ (ev);
        const ext = o.extendedProps;
        const xp =
            ext && typeof ext === 'object' && !Array.isArray(ext)
                ? { .../** @type {Record<string, unknown>} */ (ext) }
                : {};
        const gid =
            (typeof o.id === 'string' && o.id) ||
            (typeof xp.googleEventId === 'string' && xp.googleEventId) ||
            '';
        if (gid) {
            xp.googleEventId = gid;
            o.id = gid;
        }
        if (!Array.isArray(xp.inscrits)) {
            if (xp.inscrits == null) xp.inscrits = [];
            else if (typeof xp.inscrits === 'string') {
                xp.inscrits = String(xp.inscrits)
                    .split(/[,;]/)
                    .map((s) => s.trim().toLowerCase())
                    .filter(Boolean);
            } else {
                xp.inscrits = [];
            }
        }
        return { ...o, extendedProps: xp };
    });
}

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
    if (role === 'consultation') return cours;
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
 * @param {{ title?: string; start?: string; end?: string; extendedProps?: { owner?: string; ownerDisplayName?: string } }} ev
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
    const t0 = start.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const t1 = end && !Number.isNaN(end.getTime()) ? end.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
    const hours = t1 ? `${t0} – ${t1}` : t0;
    return `${day}, ${hours} — ${title} — ${profName}`;
}

/**
 * @param {Date} rangeStart
 * @param {Date} rangeEnd
 */
export async function fetchCalendarEventsInRange(rangeStart, rangeEnd) {
    const { calendarBridgeUrl } = getPlanningConfig();
    const useDbGrid = planningGridUsesSupabaseDb();
    const useBridge = Boolean(calendarBridgeUrl) && isBackendAuthConfigured() && !useDbGrid;
    if (useDbGrid) {
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
    if (useBridge) {
        const cacheKey = calendarListCacheKey(
            rangeStart.toISOString(),
            rangeEnd.toISOString(),
            'bridge'
        );
        const hit = getCalendarListCache(cacheKey);
        if (hit) return cloneCachedCalendarRows(hit);
        const token = await getAccessToken();
        if (!token) return [];
        const bridge = await invokeCalendarBridge(token, {
            action: 'list',
            timeMin: rangeStart.toISOString(),
            timeMax: rangeEnd.toISOString()
        });
        if (!bridge.ok) return [];
        const data = /** @type {{ events?: unknown[] }} */ (bridge.data || {});
        const rows = mapBridgeListEvents(Array.isArray(data.events) ? data.events : []);
        setCalendarListCache(cacheKey, cloneCachedCalendarRows(rows));
        return rows;
    }
    const startMs = rangeStart.getTime();
    const endMs = rangeEnd.getTime();
    return demoEvents
        .filter((e) => {
            const t = new Date(e.start).getTime();
            return t >= startMs && t <= endMs;
        })
        .map((e) => {
            const ins = e.extendedProps?.inscrits;
            const inscrits = Array.isArray(ins)
                ? ins.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
                : [];
            return {
                ...e,
                extendedProps: { ...e.extendedProps, inscrits }
            };
        });
}
