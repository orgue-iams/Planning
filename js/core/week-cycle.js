/**
 * Semaine A / B (alternance 2 semaines), ancrée sur un lundi « semaine A » en base.
 */
import { getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';

/** @type {string | null} date ISO YYYY-MM-DD (lundi) ou null si désactivé */
let cachedAnchorMonday = null;

export function getWeekCycleAnchorMonday() {
    return cachedAnchorMonday;
}

/** Lundi 00:00 local de la semaine calendaire contenant `d` (firstDay lundi = même convention que FC). */
export function mondayOfLocalWeek(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dow = (x.getDay() + 6) % 7;
    x.setDate(x.getDate() - dow);
    x.setHours(0, 0, 0, 0);
    return x;
}

/** @param {string} anchorIso YYYY-MM-DD (lundi) */
export function toLocalDateFromIsoDate(anchorIso) {
    const [y, m, day] = anchorIso.split('-').map((n) => parseInt(n, 10));
    return new Date(y, m - 1, day, 12, 0, 0, 0);
}

/**
 * @param {string | null} anchorMondayIso
 * @param {Date} d
 * @returns {'' | 'Semaine A' | 'Semaine B'}
 */
export function weekCycleLabelForDate(anchorMondayIso, d) {
    if (!anchorMondayIso || !d || Number.isNaN(d.getTime())) return '';
    const anchor = mondayOfLocalWeek(toLocalDateFromIsoDate(anchorMondayIso));
    const mon = mondayOfLocalWeek(d);
    const diffWeeks = Math.round((mon.getTime() - anchor.getTime()) / (7 * 24 * 60 * 60 * 1000));
    if (!Number.isFinite(diffWeeks)) return '';
    return diffWeeks % 2 === 0 ? 'Semaine A' : 'Semaine B';
}

export async function fetchWeekCycleAnchor() {
    if (!isBackendAuthConfigured()) {
        cachedAnchorMonday = null;
        return null;
    }
    const sb = getSupabaseClient();
    if (!sb) {
        cachedAnchorMonday = null;
        return null;
    }
    const { data, error } = await sb.from('organ_week_cycle').select('anchor_monday').eq('id', 1).maybeSingle();
    if (error) {
        console.warn('[week-cycle]', error.message);
        cachedAnchorMonday = null;
        return null;
    }
    const raw = data?.anchor_monday;
    cachedAnchorMonday = raw ? String(raw).slice(0, 10) : null;
    return cachedAnchorMonday;
}

/**
 * @param {string | null} anchorMondayIso YYYY-MM-DD (sera ramené au lundi local) ou null pour désactiver
 * @param {string} userId uuid
 */
export async function saveWeekCycleAnchor(anchorMondayIso, userId) {
    if (!isBackendAuthConfigured()) {
        return { ok: false, error: 'Backend non configuré.' };
    }
    const sb = getSupabaseClient();
    if (!sb) return { ok: false, error: 'Session indisponible.' };
    let mondayIso = null;
    if (anchorMondayIso && String(anchorMondayIso).trim()) {
        const d = toLocalDateFromIsoDate(String(anchorMondayIso).slice(0, 10));
        if (Number.isNaN(d.getTime())) {
            return { ok: false, error: 'Date invalide.' };
        }
        mondayIso = mondayOfLocalWeek(d).toLocaleDateString('en-CA');
    }
    const { error } = await sb
        .from('organ_week_cycle')
        .update({
            anchor_monday: mondayIso,
            updated_at: new Date().toISOString(),
            updated_by: userId || null
        })
        .eq('id', 1);
    if (error) return { ok: false, error: error.message };
    cachedAnchorMonday = mondayIso;
    return { ok: true };
}
