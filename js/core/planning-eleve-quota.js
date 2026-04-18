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
 * @param {object | null} settings
 * @param {number} addMinutes — durée du créneau à ajouter (nouveau ou delta)
 * @param {Date} weekMonday
 */
export async function eleveTravailWouldExceedWeeklyCap(settings, addMinutes, weekMonday, excludeEventId) {
    if (!settings?.eleve_weekly_travail_cap_enabled) return { ok: true };
    const capH = Number(settings.eleve_weekly_travail_cap_hours);
    if (!Number.isFinite(capH) || capH < 1 || capH > 10) return { ok: true };
    const capMin = Math.round(capH * 60);
    const w0 = mondayStartLocal(weekMonday);
    const w1 = sundayEndLocal(w0);
    if (!isBackendAuthConfigured()) return { ok: true };
    const sb = getSupabaseClient();
    if (!sb) return { ok: true };
    const { data, error } = await sb.rpc('planning_eleve_travail_effective_minutes', {
        p_range_start: w0.toISOString(),
        p_range_end: w1.toISOString()
    });
    if (error) {
        console.warn('[planning-eleve-quota]', error.message);
        return { ok: true };
    }
    const row = Array.isArray(data) ? data[0] : data;
    const active = Number(row?.active_minutes ?? 0) || 0;
    const voided = Number(row?.void_minutes ?? 0) || 0;
    let used = active + voided;
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
    if (used + addMinutes > capMin) {
        return {
            ok: false,
            message: `Plafond hebdomadaire travail perso : ${capH} h maximum (incluant les créneaux déjà réservés${settings.eleve_count_voided_travail_toward_cap ? ' ou annulés dans la semaine' : ''}).`
        };
    }
    return { ok: true };
}

/**
 * @param {{ slotStart: Date, slotEnd: Date }} p
 */
export async function logEleveTravailVoidIfNeeded(settings, p) {
    if (!settings?.eleve_count_voided_travail_toward_cap) return { ok: true };
    const sb = getSupabaseClient();
    if (!sb) return { ok: false };
    const ms = Math.max(0, p.slotEnd.getTime() - p.slotStart.getTime());
    const voided = Math.max(1, Math.round(ms / 60000));
    const { error } = await sb.from('planning_eleve_travail_void_log').insert({
        slot_start_at: p.slotStart.toISOString(),
        slot_end_at: p.slotEnd.toISOString(),
        voided_minutes: voided
    });
    if (error) {
        console.warn('[planning-eleve-quota] void log', error.message);
        return { ok: false, error: error.message };
    }
    return { ok: true };
}
