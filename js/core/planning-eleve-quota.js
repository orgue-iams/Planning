/**
 * Quotas / fenêtre de réservation pour les élèves (travail perso), d’après organ_school_settings.
 */
import { getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';

/** Lundi 00:00:00 local de la semaine contenant `d`. */
export function mondayStartLocal(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    const dow = x.getDay(); // 0 Sun .. 6 Sat
    const delta = dow === 0 ? -6 : 1 - dow;
    x.setDate(x.getDate() + delta);
    return x;
}

/** Dimanche 23:59:59.999 local de la même semaine que `mondayStart`. */
export function sundayEndLocal(mondayStart) {
    const x = new Date(mondayStart);
    x.setDate(x.getDate() + 6);
    x.setHours(23, 59, 59, 999);
    return x;
}

/**
 * @param {import('./organ-settings.js').OrganSchoolSettingsRow | null} settings
 * @param {Date} slotStart
 */
export function eleveBookingTooFarInFuture(settings, slotStart) {
    if (!settings?.eleve_booking_horizon_enabled) return false;
    const amt = Math.max(0, Number(settings.eleve_booking_horizon_amount || 0));
    const unit = String(settings.eleve_booking_horizon_unit || 'days') === 'weeks' ? 'weeks' : 'days';
    const days = unit === 'weeks' ? amt * 7 : amt;
    const tol = Math.max(0, Number(settings.eleve_booking_tolerance_days ?? 0));
    const limit = new Date();
    limit.setHours(23, 59, 59, 999);
    limit.setDate(limit.getDate() + days + tol);
    return slotStart.getTime() > limit.getTime();
}

/**
 * @param {string} ownerUserId
 * @param {Date} rangeStart
 * @param {Date} rangeEnd
 * @param {string | null} excludeEventId
 */
async function fetchActiveTravailMinutesForOwner(ownerUserId, rangeStart, rangeEnd, excludeEventId) {
    const sb = getSupabaseClient();
    if (!sb) return null;
    let query = sb
        .from('planning_event')
        .select('id,start_at,end_at')
        .eq('owner_user_id', ownerUserId)
        .eq('slot_type', 'travail perso')
        .lt('start_at', rangeEnd.toISOString())
        .gt('end_at', rangeStart.toISOString());
    const excludeId = String(excludeEventId || '').trim();
    if (excludeId) query = query.neq('id', excludeId);
    const { data, error } = await query;
    if (error) {
        console.warn('[planning-eleve-quota] owner active minutes', error.message);
        return null;
    }
    let total = 0;
    for (const row of data || []) {
        const s = new Date(row.start_at).getTime();
        const e = new Date(row.end_at).getTime();
        const overlapStart = Math.max(s, rangeStart.getTime());
        const overlapEnd = Math.min(e, rangeEnd.getTime());
        if (Number.isFinite(overlapStart) && Number.isFinite(overlapEnd) && overlapEnd > overlapStart) {
            total += Math.round((overlapEnd - overlapStart) / 60000);
        }
    }
    return total;
}

/**
 * @param {object | null} settings
 * @param {number} addMinutes — durée du créneau à ajouter (nouveau ou delta)
 * @param {Date} weekMonday
 * @param {string | null} excludeEventId
 * @param {string | null} [ownerUserId]
 */
export async function eleveTravailWouldExceedWeeklyCap(
    settings,
    addMinutes,
    weekMonday,
    excludeEventId,
    ownerUserId = null
) {
    if (!settings?.eleve_weekly_travail_cap_enabled) return { ok: true };
    const capH = Number(settings.eleve_weekly_travail_cap_hours);
    if (!Number.isFinite(capH) || capH < 1 || capH > 10) return { ok: true };
    const capMin = Math.round(capH * 60);
    const w0 = mondayStartLocal(weekMonday);
    const w1 = sundayEndLocal(w0);
    if (!isBackendAuthConfigured()) return { ok: true };
    const sb = getSupabaseClient();
    if (!sb) return { ok: true };
    const explicitOwnerId = String(ownerUserId || '').trim();
    let used = 0;
    if (explicitOwnerId) {
        const activeMinutes = await fetchActiveTravailMinutesForOwner(
            explicitOwnerId,
            w0,
            w1,
            excludeEventId
        );
        if (activeMinutes == null) return { ok: true };
        used = activeMinutes;
    } else {
        const { data, error } = await sb.rpc('planning_eleve_travail_effective_minutes', {
            p_range_start: w0.toISOString(),
            p_range_end: w1.toISOString()
        });
        if (error) {
            console.warn('[planning-eleve-quota]', error.message);
            return { ok: true };
        }
        const row = Array.isArray(data) ? data[0] : data;
        used = Number(row?.active_minutes ?? 0) || 0;
        if (excludeEventId) {
            const { data: ev } = await sb
                .from('planning_event')
                .select('start_at,end_at,slot_type,owner_user_id')
                .eq('id', excludeEventId)
                .maybeSingle();
            if (ev && ev.slot_type === 'travail perso') {
                const s = new Date(ev.start_at).getTime();
                const e = new Date(ev.end_at).getTime();
                if (s >= w0.getTime() && s <= w1.getTime() && e > s) {
                    used -= Math.round((e - s) / 60000);
                }
            }
        }
    }
    if (used + addMinutes > capMin) {
        return {
            ok: false,
            message: `Plafond hebdomadaire travail perso : ${capH} h maximum.`
        };
    }
    return { ok: true };
}

/**
 * @param {{ slotStart: Date, slotEnd: Date }} p
 */
export async function logEleveTravailVoidIfNeeded(settings, p) {
    void settings;
    void p;
    return { ok: true };
}
