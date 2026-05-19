/**
 * Jours d’enseignement prof (profiles.teaching_days) : 1 = lundi … 7 = dimanche.
 */
import { getSupabaseClient } from './supabase-client.js';

const DOW_LABELS = ['', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

/** @param {unknown} raw @returns {Set<number>} */
export function parseTeachingDays(raw) {
    const set = new Set();
    const arr = Array.isArray(raw) ? raw : [];
    for (const v of arr) {
        const n = Number(v);
        if (Number.isInteger(n) && n >= 1 && n <= 7) set.add(n);
    }
    return set;
}

/** @param {Set<number>} set @returns {number[]} */
export function teachingDaysToArray(set) {
    return [...set].filter((n) => n >= 1 && n <= 7).sort((a, b) => a - b);
}

/** @param {Set<number>} set @returns {string} */
export function formatTeachingDaysShort(set) {
    const arr = teachingDaysToArray(set);
    if (!arr.length) return '—';
    return arr.map((d) => DOW_LABELS[d] || String(d)).join(', ');
}

/** @param {Set<number>} set @returns {number} premier jour (défaut 1) */
export function defaultTeachingDow(set) {
    const arr = teachingDaysToArray(set);
    return arr.length ? arr[0] : 1;
}

/**
 * @param {string} userId
 * @returns {Promise<Set<number>>}
 */
export async function fetchTeachingDaysForUser(userId) {
    const id = String(userId || '').trim();
    if (!id) return new Set();
    const sb = getSupabaseClient();
    if (!sb) return new Set();
    const { data, error } = await sb.from('profiles').select('teaching_days').eq('id', id).maybeSingle();
    if (error) {
        console.warn('[teaching-days]', error.message);
        return new Set();
    }
    return parseTeachingDays(data?.teaching_days);
}

/**
 * @param {string} userId
 * @param {Set<number> | number[]} days
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function saveTeachingDaysForUser(userId, days) {
    const id = String(userId || '').trim();
    if (!id) return { ok: false, error: 'Compte invalide.' };
    const set = days instanceof Set ? days : parseTeachingDays(days);
    if (!set.size) return { ok: false, error: 'Cochez au moins un jour.' };
    const sb = getSupabaseClient();
    if (!sb) return { ok: false, error: 'Connexion indisponible.' };
    const { error } = await sb
        .from('profiles')
        .update({ teaching_days: teachingDaysToArray(set) })
        .eq('id', id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
}

/** @param {HTMLSelectElement | null} sel @param {Set<number>} allowed */
export function syncTeachingDaySelectOptions(sel, allowed) {
    if (!sel) return;
    const arr = teachingDaysToArray(allowed);
    for (const opt of sel.options) {
        const v = parseInt(opt.value, 10);
        const show = arr.length === 0 || arr.includes(v);
        opt.hidden = !show;
        opt.disabled = !show;
    }
    const cur = parseInt(sel.value, 10);
    if (arr.length && !arr.includes(cur)) {
        sel.value = String(defaultTeachingDow(allowed));
    }
}
