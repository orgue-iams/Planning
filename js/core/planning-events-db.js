/**
 * Créneaux planning : lecture depuis Postgres (RPC planning_events_in_range).
 * Google n’est plus la source d’affichage de la grille lorsque planningGridReadsFromSupabase est activé.
 */
import { getPlanningConfig, getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';

/** Alignement types base → extendedProps.type (couleurs / bridge historique). */
export function slotTypeToPlanningExtendedType(slotType) {
    const s = String(slotType || '').trim();
    if (s === 'travail perso' || s === 'autre') return 'reservation';
    if (s === 'concert') return 'cours';
    return s;
}

/** Colonne `slot_type` → type attendu par calendar-bridge / Google. */
export function planningDbSlotTypeToBridgeType(slotType) {
    return slotTypeToPlanningExtendedType(slotType);
}

/**
 * @param {object} row — ligne RPC
 * @param {object | null} _currentUser réservé (drag/édition appliqués après import dynamique)
 */
export function mapPlanningDbRowToFcEvent(row, _currentUser) {
    const owner = String(row.owner_email || '').trim().toLowerCase();
    const typ = slotTypeToPlanningExtendedType(row.slot_type);
    const mainG = String(row.main_google_event_id ?? '').trim();
    const poolG = String(row.pool_google_event_id ?? '').trim();
    return {
        id: row.id,
        title: row.title || 'Créneau',
        start: row.start_at,
        end: row.end_at,
        extendedProps: {
            planningRowSource: 'supabase',
            planningCanonicalId: row.id,
            googleEventId: mainG,
            poolGoogleEventId: poolG,
            owner,
            ownerDisplayName: owner ? owner.split('@')[0] : '',
            ownerRole: '',
            type: typ,
            inscrits: []
        }
    };
}

/**
 * @param {Date} start
 * @param {Date} end
 * @param {object | null} currentUser
 * @returns {Promise<object[]>} événements format FullCalendar
 */
export async function fetchPlanningEventsForFullCalendar(start, end, currentUser) {
    const sb = getSupabaseClient();
    if (!sb || !isBackendAuthConfigured()) return [];
    const { data, error } = await sb.rpc('planning_events_in_range', {
        p_start: start.toISOString(),
        p_end: end.toISOString()
    });
    if (error) throw new Error(error.message);
    const rows = Array.isArray(data) ? data : [];
    const { fcDragResizePropsForEvent } = await import('./calendar-logic.js');
    return rows.map((row) => {
        const ev = mapPlanningDbRowToFcEvent(row, currentUser);
        return { ...ev, ...fcDragResizePropsForEvent(ev, currentUser) };
    });
}

/**
 * @param {string} email
 * @returns {Promise<string | null>} uuid ou null
 */
export async function planningUserIdForEmail(email) {
    const sb = getSupabaseClient();
    if (!sb || !isBackendAuthConfigured()) return null;
    const em = String(email || '').trim().toLowerCase();
    if (!em) return null;
    const { data, error } = await sb.rpc('planning_user_id_for_email', { p_email: em });
    if (error) {
        console.warn('[planning-events-db] planning_user_id_for_email', error.message);
        return null;
    }
    return data != null ? String(data) : null;
}

/**
 * @param {{
 *   id?: string | null,
 *   startIso: string,
 *   endIso: string,
 *   title: string,
 *   dbSlotType: string,
 *   ownerEmail: string,
 *   ownerUserId: string
 * }} p
 */
export async function upsertPlanningEventRow(p) {
    const sb = getSupabaseClient();
    if (!sb || !isBackendAuthConfigured()) {
        return { ok: false, error: 'Session indisponible.', id: null };
    }
    const owner_email = String(p.ownerEmail || '').trim().toLowerCase();
    const row = {
        start_at: p.startIso,
        end_at: p.endIso,
        title: String(p.title || '').trim() || 'Créneau',
        slot_type: p.dbSlotType,
        owner_email,
        owner_user_id: p.ownerUserId,
        updated_at: new Date().toISOString()
    };
    const existingId = p.id ? String(p.id).trim() : '';
    if (existingId) {
        const { data, error } = await sb.from('planning_event').update(row).eq('id', existingId).select('id').maybeSingle();
        if (error) return { ok: false, error: error.message, id: null };
        return { ok: true, error: null, id: data?.id ? String(data.id) : existingId };
    }
    const { data, error } = await sb.from('planning_event').insert(row).select('id').single();
    if (error) return { ok: false, error: error.message, id: null };
    return { ok: true, error: null, id: data?.id ? String(data.id) : null };
}

/**
 * @param {string} canonicalId
 */
export async function deletePlanningEventRow(canonicalId) {
    const sb = getSupabaseClient();
    if (!sb || !isBackendAuthConfigured()) {
        return { ok: false, error: 'Session indisponible.' };
    }
    const id = String(canonicalId || '').trim();
    if (!id) return { ok: false, error: 'Identifiant manquant.' };
    const { error } = await sb.from('planning_event').delete().eq('id', id);
    if (error) return { ok: false, error: error.message };
    return { ok: true, error: null };
}

/**
 * Lignes miroir Google (pour supprimer sur les bons calendriers avant DELETE planning_event).
 * @param {string} eventId
 * @returns {Promise<{ calendarId: string, googleEventId: string }[]>}
 */
export async function fetchPlanningMirrorTargetsForDelete(eventId) {
    const sb = getSupabaseClient();
    if (!sb || !isBackendAuthConfigured()) return [];
    const id = String(eventId || '').trim();
    if (!id) return [];
    const { data, error } = await sb
        .from('planning_event_google_mirror')
        .select('google_calendar_id,google_event_id,sync_status')
        .eq('event_id', id);
    if (error) {
        console.warn('[planning-events-db] mirror list', error.message);
        return [];
    }
    const rows = Array.isArray(data) ? data : [];
    return rows
        .filter(
            (r) =>
                r &&
                String(r.sync_status || '') === 'ok' &&
                String(r.google_event_id || '').trim() &&
                String(r.google_calendar_id || '').trim()
        )
        .map((r) => ({
            calendarId: String(r.google_calendar_id).trim(),
            googleEventId: String(r.google_event_id).trim()
        }));
}

export function planningGridUsesSupabaseDb() {
    const c = getPlanningConfig();
    return Boolean(c?.planningGridReadsFromSupabase) && isBackendAuthConfigured();
}
