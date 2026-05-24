/**
 * Créneaux planning : lecture depuis Postgres (RPC planning_events_in_range).
 * La grille FullCalendar ne lit jamais la liste Google ; calendar-bridge sert au miroir (upsert/delete).
 */
import {
    getSupabaseClient,
    isBackendAuthConfigured,
    isInvalidRefreshTokenError,
    clearCorruptedLocalAuthSession
} from './supabase-client.js';

/** Alignement types base → extendedProps.type (couleurs / bridge historique). */
export function slotTypeToPlanningExtendedType(slotType) {
    const s = String(slotType || '').trim();
    if (s === 'fermeture') return 'fermeture';
    if (s === 'cours') return 'cours';
    if (s === 'concert') return 'concert';
    if (s === 'autre') return 'autre';
    if (s === 'travail perso') return 'reservation';
    return s;
}

/** Colonne `slot_type` → type attendu par calendar-bridge / Google. */
export function planningDbSlotTypeToBridgeType(slotType) {
    return slotTypeToPlanningExtendedType(slotType);
}

/** `slot_type` SQL pour mise à jour drag/resize (priorité à la valeur issue de la RPC). */
export function planningDbSlotTypeForEventUpdate(ev) {
    const explicit = String(ev?.extendedProps?.planningDbSlotType || '').trim();
    if (explicit) return explicit;
    const t = String(ev?.extendedProps?.type || '').trim();
    if (t === 'fermeture') return 'fermeture';
    if (t === 'cours') return 'cours';
    if (t === 'concert') return 'concert';
    if (t === 'autre') return 'autre';
    if (t === 'reservation') return 'travail perso';
    return 'travail perso';
}

/**
 * @param {object} row — ligne RPC
 * @param {object | null} _currentUser réservé (drag/édition appliqués après import dynamique)
 */
function normalizeInscritsFromRpc(row) {
    const raw = row?.inscrits_emails;
    if (!Array.isArray(raw)) return [];
    return raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
}

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
            createdByUserId: String(row.created_by_user_id ?? row.owner_user_id ?? '').trim(),
            createdByRole: String(row.created_by_role || '').trim().toLowerCase(),
            lastModifiedByUserId: String(row.last_modified_by_user_id ?? row.owner_user_id ?? '').trim(),
            /** Colonne `slot_type` brute (déplacement / redimensionnement sans ambiguïté concert/autre). */
            planningDbSlotType: row.slot_type,
            ownerUserId: String(row.owner_user_id ?? '').trim(),
            googleEventId: mainG,
            poolGoogleEventId: poolG,
            owner,
            ownerDisplayName: owner ? owner.split('@')[0] : '',
            ownerRole: String(row.owner_role || '').trim().toLowerCase(),
            type: typ,
            inscrits: normalizeInscritsFromRpc(row),
            planningSourceTemplateLineId: row.source_template_line_id
                ? String(row.source_template_line_id)
                : '',
            planningGabaritWeekType: (() => {
                const w = String(row.gabarit_week_type || '').trim().toUpperCase();
                return w === 'A' || w === 'B' ? w : '';
            })(),
            planningAbsencePeriodId: row.absence_period_id
                ? String(row.absence_period_id).trim()
                : ''
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

    let { data: sessionData, error: sessErr } = await sb.auth.getSession();
    if (sessErr && isInvalidRefreshTokenError(sessErr)) {
        await clearCorruptedLocalAuthSession();
    }
    let session = sessionData?.session ?? null;
    if (!session) {
        const { data: refData, error: refErr } = await sb.auth.refreshSession();
        if (refErr && isInvalidRefreshTokenError(refErr)) await clearCorruptedLocalAuthSession();
        session = refData?.session ?? null;
    }
    if (!session) {
        throw new Error(
            'Session Supabase indisponible pour charger le planning. Fermez la modale de connexion puis reconnectez-vous.'
        );
    }

    const { data, error } = await sb.rpc('planning_events_in_range', {
        p_start: start.toISOString(),
        p_end: end.toISOString()
    });
    if (error) throw new Error(error.message);
    const rows = Array.isArray(data) ? data : [];
    // owner_role vient de la RPC (security definer) ; repli client limité par RLS profiles (ligne propre).
    const ownerIds = [...new Set(rows.map((r) => String(r.owner_user_id || '').trim()).filter(Boolean))];
    const creatorIds = [
        ...new Set(rows.map((r) => String(r.created_by_user_id || '').trim()).filter(Boolean))
    ];
    const roleByOwnerId = await fetchProfileRolesByUserIds(ownerIds);
    const roleByCreatorId = await fetchProfileRolesByUserIds(creatorIds);
    const { fcDragResizePropsForEvent } = await import('./calendar-logic.js');
    return rows.map((row) => {
        const oid = String(row.owner_user_id || '').trim();
        const cid = String(row.created_by_user_id || '').trim();
        const enriched = {
            ...row,
            owner_role: String(row.owner_role || roleByOwnerId.get(oid) || '').trim(),
            created_by_role: String(roleByCreatorId.get(cid) || '').trim()
        };
        const ev = mapPlanningDbRowToFcEvent(enriched, currentUser);
        return { ...ev, ...fcDragResizePropsForEvent(ev, currentUser) };
    });
}

/** @param {string[]} userIds @returns {Promise<Map<string, string>>} */
export async function fetchProfileRolesByUserIds(userIds) {
    const uniq = [...new Set((userIds || []).map((id) => String(id).trim()).filter(Boolean))];
    const m = new Map();
    if (!uniq.length) return m;
    const sb = getSupabaseClient();
    if (!sb) return m;
    const { data, error } = await sb.from('profiles').select('id, role').in('id', uniq);
    if (error) {
        console.warn('[planning-events-db] profiles roles', error.message);
        return m;
    }
    for (const row of data || []) {
        m.set(String(row.id), String(row.role || '').trim().toLowerCase());
    }
    return m;
}

/**
 * Lignes brutes RPC (sans dépendance calendar-logic) — gabarits, scripts.
 * @param {Date} start
 * @param {Date} end
 * @returns {Promise<object[]>}
 */
export async function fetchPlanningEventRowsInRange(start, end) {
    const sb = getSupabaseClient();
    if (!sb || !isBackendAuthConfigured()) return [];
    const { data, error } = await sb.rpc('planning_events_in_range', {
        p_start: start.toISOString(),
        p_end: end.toISOString()
    });
    if (error) {
        console.warn('[planning-events-db] fetchPlanningEventRowsInRange', error.message);
        return [];
    }
    return Array.isArray(data) ? data : [];
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
 *   ownerUserId: string,
 *   sourceTemplateLineId?: string | null,
 *   gabaritWeekType?: 'A' | 'B' | '' | null
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
    const tplId = p.sourceTemplateLineId !== undefined ? String(p.sourceTemplateLineId || '').trim() : undefined;
    if (tplId !== undefined) {
        row.source_template_line_id = tplId || null;
    }
    if (p.gabaritWeekType !== undefined) {
        const g = String(p.gabaritWeekType || '').trim().toUpperCase();
        row.gabarit_week_type = g === 'A' || g === 'B' ? g : null;
    }
    if (p.absencePeriodId !== undefined) {
        const ap = String(p.absencePeriodId || '').trim();
        row.absence_period_id = ap || null;
    }
    const existingId = p.id ? String(p.id).trim() : '';
    if (existingId) {
        /** Mise à jour seule (évite upsert + politique INSERT RLS sur lignes existantes). */
        const updateRow = {
            start_at: row.start_at,
            end_at: row.end_at,
            title: row.title,
            slot_type: row.slot_type,
            updated_at: row.updated_at
        };
        const { data, error } = await sb
            .from('planning_event')
            .update(updateRow)
            .eq('id', existingId)
            .select('id');
        if (error) {
            const msg = String(error.message || '');
            const denied =
                error.code === 'PGRST116' ||
                error.code === '42501' ||
                /0 rows|permission|policy/i.test(msg);
            return {
                ok: false,
                error: denied
                    ? 'Modification refusée (droits ou créneau introuvable). Rechargez la page puis réessayez.'
                    : msg,
                id: null
            };
        }
        const updatedId = Array.isArray(data) && data[0]?.id ? String(data[0].id) : '';
        if (updatedId) return { ok: true, error: null, id: updatedId };
        /* UUID client (création rapide) ou id obsolète : aucune ligne mise à jour → insertion. */
    }
    const { data, error } = await sb.from('planning_event').insert(row).select('id').single();
    if (error) return { ok: false, error: error.message, id: null };
    return { ok: true, error: null, id: data?.id ? String(data.id) : null };
}

/**
 * @param {string} eventId
 * @returns {Promise<string[]>}
 */
export async function fetchPlanningEventEnrollmentUserIds(eventId) {
    const sb = getSupabaseClient();
    if (!sb || !isBackendAuthConfigured()) return [];
    const eid = String(eventId || '').trim();
    if (!eid) return [];
    const { data, error } = await sb
        .from('planning_event_enrollment')
        .select('student_user_id')
        .eq('event_id', eid);
    if (error) {
        console.warn('[planning-events-db] fetchPlanningEventEnrollmentUserIds', error.message);
        return [];
    }
    return (data || []).map((r) => String(r.student_user_id ?? '').trim()).filter(Boolean);
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
 * @returns {Promise<{ user_id: string, email: string, display_name: string, nom: string, prenom: string }[]>}
 */
export async function fetchPlanningListElevesActifs() {
    const sb = getSupabaseClient();
    if (!sb || !isBackendAuthConfigured()) return [];
    const { data, error } = await sb.rpc('planning_list_eleves_actifs');
    if (error) {
        console.warn('[planning-events-db] planning_list_eleves_actifs', error.message);
        return [];
    }
    const rows = Array.isArray(data) ? data : [];
    return rows.map((r) => ({
        user_id: String(r.user_id ?? '').trim(),
        email: String(r.email ?? '').trim(),
        display_name: String(r.display_name ?? '').trim(),
        nom: String(r.nom ?? '').trim(),
        prenom: String(r.prenom ?? '').trim()
    }));
}

/**
 * Remplace les inscriptions (cours). `studentUserIds` = ids `auth.users` des élèves.
 * @param {string} eventId
 * @param {string[]} studentUserIds
 */
export async function replacePlanningEventEnrollment(eventId, studentUserIds) {
    const sb = getSupabaseClient();
    if (!sb || !isBackendAuthConfigured()) {
        return { ok: false, error: 'Session indisponible.' };
    }
    const eid = String(eventId || '').trim();
    if (!eid) return { ok: false, error: 'Événement manquant.' };
    const seen = new Set();
    const ids = (Array.isArray(studentUserIds) ? studentUserIds : [])
        .map((x) => String(x).trim())
        .filter((id) => {
            if (!id || seen.has(id)) return false;
            seen.add(id);
            return true;
        });
    const { error: delErr } = await sb.from('planning_event_enrollment').delete().eq('event_id', eid);
    if (delErr) return { ok: false, error: delErr.message };
    if (ids.length === 0) return { ok: true, error: null };
    const rows = ids.map((student_user_id) => ({ event_id: eid, student_user_id }));
    const { error: insErr } = await sb.from('planning_event_enrollment').insert(rows);
    if (insErr) return { ok: false, error: insErr.message };
    return { ok: true, error: null };
}

/**
 * Lignes miroir Google (pour supprimer sur les bons calendriers avant DELETE planning_event).
 * @param {string} eventId
 * @param {{ anySyncStatus?: boolean }} [options] — si `anySyncStatus`, inclut les miroirs non « ok » (purge admin).
 * @returns {Promise<{ calendarId: string, googleEventId: string }[]>}
 */
export async function fetchPlanningMirrorTargetsForDelete(eventId, options = {}) {
    const sb = getSupabaseClient();
    if (!sb || !isBackendAuthConfigured()) return [];
    const id = String(eventId || '').trim();
    if (!id) return [];
    const anySyncStatus = Boolean(options.anySyncStatus);
    const { data, error } = await sb
        .from('planning_event_google_mirror')
        .select('google_calendar_id,google_event_id,sync_status,target,target_user_id')
        .eq('event_id', id);
    if (error) {
        console.warn('[planning-events-db] mirror list', error.message);
        return [];
    }
    const rows = Array.isArray(data) ? data : [];
    return rows
        .filter((r) => {
            if (!r) return false;
            if (!String(r.google_event_id || '').trim()) return false;
            if (!String(r.google_calendar_id || '').trim()) return false;
            if (anySyncStatus) return true;
            return String(r.sync_status || '') === 'ok';
        })
        .map((r) => ({
            calendarId: String(r.google_calendar_id).trim(),
            googleEventId: String(r.google_event_id).trim(),
            target: String(r.target || '').trim(),
            targetUserId: String(r.target_user_id || '').trim()
        }));
}

/**
 * Identifiants Google « main » et « pool_owner » pour un créneau (sync ok).
 * @param {string} eventId
 * @returns {Promise<{ mainGoogleEventId: string, poolGoogleEventId: string }>}
 */
/**
 * Miroirs Google (tous targets) pour plusieurs créneaux — une requête.
 * @param {string[]} eventIds
 * @returns {Promise<Map<string, { mainGoogleEventId: string, poolGoogleEventId: string }>>}
 */
export async function fetchPlanningMainPoolGoogleIdsForEvents(eventIds) {
    const sb = getSupabaseClient();
    const out = new Map();
    if (!sb || !isBackendAuthConfigured()) return out;
    const ids = [...new Set(eventIds.map((x) => String(x || '').trim()).filter(Boolean))];
    if (!ids.length) return out;
    const { data, error } = await sb
        .from('planning_event_google_mirror')
        .select('event_id,target,google_event_id,sync_status')
        .in('event_id', ids)
        .in('target', ['main', 'pool_owner']);
    if (error) {
        console.warn('[planning-events-db] fetchPlanningMainPoolGoogleIdsForEvents', error.message);
        return out;
    }
    for (const r of Array.isArray(data) ? data : []) {
        if (String(r?.sync_status || '') !== 'ok') continue;
        const ge = String(r?.google_event_id || '').trim();
        if (!ge) continue;
        const eid = String(r.event_id || '').trim();
        if (!eid) continue;
        let entry = out.get(eid);
        if (!entry) {
            entry = { mainGoogleEventId: '', poolGoogleEventId: '' };
            out.set(eid, entry);
        }
        if (r.target === 'main') entry.mainGoogleEventId = ge;
        if (r.target === 'pool_owner') entry.poolGoogleEventId = ge;
    }
    return out;
}

/**
 * Tâches de suppression Google pour une liste de créneaux (avant DELETE base).
 * @param {string[]} eventIds
 * @param {{ anySyncStatus?: boolean }} [options]
 * @returns {Promise<{ googleEventId: string, calendarId: string }[]>}
 */
export async function fetchPlanningMirrorCleanupTasksForEvents(eventIds, options = {}) {
    const sb = getSupabaseClient();
    if (!sb || !isBackendAuthConfigured()) return [];
    const ids = [...new Set(eventIds.map((x) => String(x || '').trim()).filter(Boolean))];
    if (!ids.length) return [];
    const anySyncStatus = Boolean(options.anySyncStatus);
    const { data, error } = await sb
        .from('planning_event_google_mirror')
        .select('event_id,google_calendar_id,google_event_id,sync_status')
        .in('event_id', ids);
    if (error) {
        console.warn('[planning-events-db] fetchPlanningMirrorCleanupTasksForEvents', error.message);
        return [];
    }
    const seen = new Set();
    const tasks = [];
    for (const r of Array.isArray(data) ? data : []) {
        if (!r) continue;
        if (!String(r.google_event_id || '').trim()) continue;
        if (!String(r.google_calendar_id || '').trim()) continue;
        if (!anySyncStatus && String(r.sync_status || '') !== 'ok') continue;
        const k = `${String(r.google_calendar_id).trim().toLowerCase()}|${String(r.google_event_id).trim()}`;
        if (seen.has(k)) continue;
        seen.add(k);
        tasks.push({
            calendarId: String(r.google_calendar_id).trim(),
            googleEventId: String(r.google_event_id).trim()
        });
    }
    return tasks;
}

export async function fetchPlanningMainPoolGoogleIdsForEvent(eventId) {
    const sb = getSupabaseClient();
    if (!sb || !isBackendAuthConfigured()) return { mainGoogleEventId: '', poolGoogleEventId: '' };
    const id = String(eventId || '').trim();
    if (!id) return { mainGoogleEventId: '', poolGoogleEventId: '' };
    const { data, error } = await sb
        .from('planning_event_google_mirror')
        .select('target,google_event_id,sync_status')
        .eq('event_id', id)
        .in('target', ['main', 'pool_owner']);
    if (error) {
        console.warn('[planning-events-db] fetchPlanningMainPoolGoogleIdsForEvent', error.message);
        return { mainGoogleEventId: '', poolGoogleEventId: '' };
    }
    let mainGoogleEventId = '';
    let poolGoogleEventId = '';
    for (const r of Array.isArray(data) ? data : []) {
        if (String(r?.sync_status || '') !== 'ok') continue;
        const ge = String(r?.google_event_id || '').trim();
        if (!ge) continue;
        if (r.target === 'main') mainGoogleEventId = ge;
        if (r.target === 'pool_owner') poolGoogleEventId = ge;
    }
    return { mainGoogleEventId, poolGoogleEventId };
}

