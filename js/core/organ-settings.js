/**
 * Paramètres org : année scolaire + plage horaire chapelle (table organ_school_settings).
 */
import { getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';

/** @type {Record<string, unknown> | null} */
let cache = null;

export function invalidateOrganSchoolSettingsCache() {
    cache = null;
}

/** Bornes grille FullCalendar `HH:MM:SS` */
export function getChapelSlotBounds() {
    const min = cache?.chapel_slot_min || '08:00:00';
    const max = cache?.chapel_slot_max || '22:00:00';
    return {
        slotMinTime: min.length === 5 ? `${min}:00` : min,
        slotMaxTime: max.length === 5 ? `${max}:00` : max
    };
}

export async function fetchOrganSchoolSettings() {
    if (!isBackendAuthConfigured()) {
        cache = {
            id: 1,
            school_year_start: null,
            school_year_end: null,
            chapel_slot_min: '08:00:00',
            chapel_slot_max: '22:00:00',
            planning_error_notify_email: ''
        };
        return cache;
    }
    const sb = getSupabaseClient();
    if (!sb) {
        cache = null;
        return null;
    }
    const { data, error } = await sb.from('organ_school_settings').select('*').eq('id', 1).maybeSingle();
    if (error) {
        console.warn('[organ-settings]', error.message);
        cache = null;
        return null;
    }
    cache = data;
    return cache;
}

export function getOrganSchoolSettingsCached() {
    return cache;
}

/**
 * @param {{
 *   school_year_start: string | null,
 *   school_year_end: string | null,
 *   chapel_slot_min: string,
 *   chapel_slot_max: string,
 *   planning_error_notify_email?: string | null
 * }} row
 */
export async function saveOrganSchoolSettingsAdmin(row) {
    const sb = getSupabaseClient();
    if (!sb) return { ok: false, error: 'Session indisponible.' };
    const notify = row.planning_error_notify_email != null ? String(row.planning_error_notify_email).trim() : null;
    const { error } = await sb
        .from('organ_school_settings')
        .update({
            school_year_start: row.school_year_start || null,
            school_year_end: row.school_year_end || null,
            chapel_slot_min: row.chapel_slot_min,
            chapel_slot_max: row.chapel_slot_max,
            planning_error_notify_email: notify || null,
            updated_at: new Date().toISOString()
        })
        .eq('id', 1);
    if (error) return { ok: false, error: error.message };
    invalidateOrganSchoolSettingsCache();
    await fetchOrganSchoolSettings();
    return { ok: true };
}
