/**
 * Paramètres org : année scolaire + plage horaire chapelle (table organ_school_settings).
 */
import { getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';

/** @type {Record<string, unknown> | null} */
let cache = null;

export function invalidateOrganSchoolSettingsCache() {
    cache = null;
}

/**
 * Normalise une valeur `time` Postgres / chaîne / objet driver en `HH:mm:ss` pour FullCalendar.
 * Évite notamment `"[object Object]"` ou formats invalides qui feraient retomber FC sur une fin de journée 24 h.
 */
function rawTimeToFcHHMMSS(raw, fallback) {
    if (raw == null || raw === '') return fallback;
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        const o = /** @type {{ hours?: number; minutes?: number; seconds?: number }} */ (raw);
        if ('hours' in o || typeof o.hours === 'number') {
            const h = Math.min(23, Math.max(0, Number(o.hours) || 0));
            const m = Math.min(59, Math.max(0, Number(o.minutes) || 0));
            const s = Math.min(59, Math.max(0, Number(o.seconds) || 0));
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        }
    }
    const s = String(raw).trim();
    if (!s || s.includes('[object Object]')) return fallback;
    const match = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return fallback;
    const h = Math.min(23, Math.max(0, parseInt(match[1], 10)));
    const m = Math.min(59, Math.max(0, parseInt(match[2], 10)));
    const sec = match[3] != null ? Math.min(59, Math.max(0, parseInt(match[3], 10))) : 0;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** Bornes grille FullCalendar `HH:MM:SS` */
export function getChapelSlotBounds() {
    const minRaw = cache?.chapel_slot_min ?? '08:00:00';
    const maxRaw = cache?.chapel_slot_max ?? '22:00:00';
    return {
        slotMinTime: rawTimeToFcHHMMSS(minRaw, '08:00:00'),
        slotMaxTime: rawTimeToFcHHMMSS(maxRaw, '22:00:00')
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
            planning_error_notify_email: '',
            eleve_weekly_travail_cap_enabled: false,
            eleve_weekly_travail_cap_hours: null,
            eleve_booking_horizon_enabled: false,
            eleve_booking_horizon_amount: null,
            eleve_booking_horizon_unit: 'days',
            eleve_count_voided_travail_toward_cap: true,
            eleve_forbid_delete_after_slot_start: true,
            eleve_booking_tolerance_days: 0,
            template_apply_closure_ranges: []
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
 *   planning_error_notify_email?: string | null,
 *   eleve_weekly_travail_cap_enabled?: boolean,
 *   eleve_weekly_travail_cap_hours?: number | string | null,
 *   eleve_booking_horizon_enabled?: boolean,
 *   eleve_booking_horizon_amount?: number | string | null,
 *   eleve_booking_horizon_unit?: string,
 *   eleve_count_voided_travail_toward_cap?: boolean,
 *   eleve_forbid_delete_after_slot_start?: boolean,
 *   eleve_booking_tolerance_days?: number | string | null
 * }} row
 */
export async function saveOrganSchoolSettingsAdmin(row) {
    const sb = getSupabaseClient();
    if (!sb) return { ok: false, error: 'Session indisponible.' };
    const notify = row.planning_error_notify_email != null ? String(row.planning_error_notify_email).trim() : null;
    const capH = row.eleve_weekly_travail_cap_hours;
    const capHours =
        capH === '' || capH === null || capH === undefined
            ? null
            : Math.max(1, Math.round(parseFloat(String(capH).replace(',', '.')) || 0)) || null;
    const { error } = await sb
        .from('organ_school_settings')
        .update({
            school_year_start: row.school_year_start || null,
            school_year_end: row.school_year_end || null,
            chapel_slot_min: row.chapel_slot_min,
            chapel_slot_max: row.chapel_slot_max,
            planning_error_notify_email: notify || null,
            eleve_weekly_travail_cap_enabled: Boolean(row.eleve_weekly_travail_cap_enabled),
            eleve_weekly_travail_cap_hours: row.eleve_weekly_travail_cap_enabled ? capHours : null,
            eleve_booking_horizon_enabled: Boolean(row.eleve_booking_horizon_enabled),
            eleve_booking_horizon_amount: row.eleve_booking_horizon_enabled
                ? Math.max(0, parseInt(String(row.eleve_booking_horizon_amount || '0'), 10) || 0)
                : null,
            eleve_booking_horizon_unit:
                String(row.eleve_booking_horizon_unit || 'days') === 'weeks' ? 'weeks' : 'days',
            eleve_count_voided_travail_toward_cap: Boolean(
                row.eleve_count_voided_travail_toward_cap ??
                    getOrganSchoolSettingsCached()?.eleve_count_voided_travail_toward_cap ??
                    true
            ),
            eleve_forbid_delete_after_slot_start: Boolean(row.eleve_forbid_delete_after_slot_start),
            eleve_booking_tolerance_days: Math.max(
                0,
                parseInt(String(row.eleve_booking_tolerance_days ?? '0'), 10) || 0
            ),
            updated_at: new Date().toISOString()
        })
        .eq('id', 1);
    if (error) return { ok: false, error: error.message };
    invalidateOrganSchoolSettingsCache();
    await fetchOrganSchoolSettings();
    return { ok: true };
}

/**
 * @param {{ startYmd: string, endYmd: string }[]} ranges
 */
export async function saveTemplateClosureRanges(ranges) {
    const sb = getSupabaseClient();
    if (!sb) return { ok: false, error: 'Session indisponible.' };
    const safe = Array.isArray(ranges)
        ? ranges
              .map((r) => ({
                  startYmd: String(r?.startYmd || '').trim(),
                  endYmd: String(r?.endYmd || '').trim()
              }))
              .filter((r) => r.startYmd && r.endYmd && r.endYmd >= r.startYmd)
        : [];
    const { error } = await sb
        .from('organ_school_settings')
        .update({
            template_apply_closure_ranges: safe,
            updated_at: new Date().toISOString()
        })
        .eq('id', 1);
    if (error) return { ok: false, error: error.message };
    invalidateOrganSchoolSettingsCache();
    await fetchOrganSchoolSettings();
    return { ok: true };
}
