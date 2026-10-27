import { isAdminRole } from './planning-roles.js';
/**
 * Périodes d'absence / fermeture (brouillon → application).
 */
import { isAdmin } from './auth-logic.js';
import { getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';
import { getPlanningSessionUser } from './session-user.js';
import {
    fetchOrganSchoolSettings,
    getOrganSchoolSettingsCached,
    getSchoolYearBoundsFromSettings,
    rangeOverlapsSchoolYear
} from './organ-settings.js';
import { fetchPlanningEventRowsInRange } from './planning-events-db.js';
import { groupFermetureRowsIntoRanges } from './fermetures-planning.js';
import {
    normalizeDayOverrides,
    normalizeExcludedYmds,
    normalizeWeekdays,
    normalizeClosureTime
} from '../utils/closure-period-helpers.js';

/**
 * @typedef {object} AbsencePeriodRow
 * @property {string} id
 * @property {string} createdByUserId
 * @property {string} creatorRole — admin | prof | ''
 * @property {string} creatorLabel
 * @property {string} startYmd
 * @property {string} endYmd
 * @property {string} title
 * @property {string | null} appliedAt — ISO ou null
 * @property {string[]} eventIds
 * @property {boolean} legacy — true si dérivé d’anciens créneaux sans période
 * @property {boolean} isPeriodic
 * @property {number[]} weekdays — ISO 1=lundi … 7=dimanche
 * @property {string} slotStartTime — HH:MM
 * @property {string} slotEndTime — HH:MM
 * @property {string[]} excludedYmds
 * @property {object[]} dayOverrides
 */

function todayYmdLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function mapDbPeriod(row, profileById) {
    const id = String(row.id || '').trim();
    const createdByUserId = String(row.created_by_user_id || '').trim();
    const prof = profileById.get(createdByUserId);
    const role = String(prof?.role || '').toLowerCase();
    const label =
        [prof?.prenom, prof?.nom].filter(Boolean).join(' ').trim() ||
        String(prof?.display_name || '').trim() ||
        (isAdminRole(role) ? 'Administration' : 'Professeur');
    return {
        id,
        createdByUserId,
        creatorRole: role,
        creatorLabel: label,
        startYmd: String(row.start_ymd || '').slice(0, 10),
        endYmd: String(row.end_ymd || '').slice(0, 10),
        title: String(row.title || '').trim() || 'Fermeture',
        appliedAt: row.applied_at ? String(row.applied_at) : null,
        eventIds: [],
        legacy: false,
        isPeriodic: Boolean(row.is_periodic),
        weekdays: normalizeWeekdays(row.weekdays),
        slotStartTime: normalizeClosureTime(row.slot_start_time) || '',
        slotEndTime: normalizeClosureTime(row.slot_end_time) || '',
        excludedYmds: normalizeExcludedYmds(row.excluded_ymds),
        dayOverrides: normalizeDayOverrides(row.day_overrides)
    };
}

async function loadProfileMap(userIds) {
    const sb = getSupabaseClient();
    const map = new Map();
    if (!sb || !userIds.length) return map;
    const { data } = await sb
        .from('profiles')
        .select('id,role,nom,prenom,display_name')
        .in('id', userIds);
    for (const p of data || []) {
        map.set(String(p.id), p);
    }
    return map;
}

/** @returns {Promise<AbsencePeriodRow[]>} */
export async function fetchAbsencePeriodsForCurrentSchoolYear() {
    if (!isBackendAuthConfigured()) return [];
    await fetchOrganSchoolSettings();
    const { startYmd: sy, endYmd: ey } = getSchoolYearBoundsFromSettings();
    const sb = getSupabaseClient();
    if (!sb) return [];

    let q = sb
        .from('planning_absence_period')
        .select(
            'id,created_by_user_id,start_ymd,end_ymd,title,applied_at,created_at,is_periodic,weekdays,slot_start_time,slot_end_time,excluded_ymds,day_overrides'
        )
        .order('start_ymd', { ascending: true })
        .order('end_ymd', { ascending: true });
    if (sy) q = q.gte('end_ymd', sy);
    if (ey) q = q.lte('start_ymd', ey);

    const { data, error } = await q;
    if (error) {
        console.warn('[absence-period]', error.message);
        return [];
    }
    const rows = data || [];
    const ids = [...new Set(rows.map((r) => String(r.created_by_user_id || '').trim()).filter(Boolean))];
    const profileById = await loadProfileMap(ids);
    const periods = rows.map((r) => mapDbPeriod(r, profileById));
    return attachAbsencePeriodEventIds(periods);
}

/** @param {AbsencePeriodRow[]} periods */
async function attachAbsencePeriodEventIds(periods) {
    const sb = getSupabaseClient();
    const ids = (periods || [])
        .filter((p) => !p.legacy && p.appliedAt && p.id)
        .map((p) => String(p.id).trim())
        .filter(Boolean);
    if (!sb || !ids.length) return periods;
    const { data, error } = await sb
        .from('planning_event')
        .select('id, absence_period_id')
        .in('absence_period_id', ids);
    if (error) {
        console.warn('[absence-period] event ids', error.message);
        return periods;
    }
    const byPeriod = new Map();
    for (const row of data || []) {
        const pid = String(row.absence_period_id || '').trim();
        const eid = String(row.id || '').trim();
        if (!pid || !eid) continue;
        if (!byPeriod.has(pid)) byPeriod.set(pid, []);
        byPeriod.get(pid).push(eid);
    }
    return periods.map((p) => {
        if (p.legacy || !p.appliedAt) return p;
        const linked = byPeriod.get(p.id);
        return linked?.length ? { ...p, eventIds: linked } : p;
    });
}

/** @param {string} periodId */
export async function fetchEventIdsForAbsencePeriod(periodId) {
    const id = String(periodId || '').trim();
    if (!id || id.startsWith('legacy:')) return [];
    const sb = getSupabaseClient();
    if (!sb) return [];
    const { data, error } = await sb
        .from('planning_event')
        .select('id')
        .eq('absence_period_id', id);
    if (error) {
        console.warn('[absence-period] fetchEventIds', error.message);
        return [];
    }
    return (data || []).map((r) => String(r.id || '').trim()).filter(Boolean);
}

/** Anciens créneaux fermeture sans période (affichés comme déjà appliqués). */
export async function fetchLegacyAppliedClosureRanges() {
    if (!isBackendAuthConfigured()) return [];
    await fetchOrganSchoolSettings();
    const { startYmd: sy, endYmd: ey } = getSchoolYearBoundsFromSettings();
    const start = sy ? new Date(`${sy}T00:00:00`) : new Date();
    if (!sy) start.setMonth(start.getMonth() - 1);
    const end = ey ? new Date(`${ey}T23:59:59`) : new Date();
    if (!ey) end.setFullYear(end.getFullYear() + 1);

    const rows = await fetchPlanningEventRowsInRange(start, end);
    const ferm = rows.filter(
        (r) =>
            String(r?.slot_type || '').toLowerCase() === 'fermeture' &&
            !String(r?.absence_period_id || '').trim()
    );
    const grouped = groupFermetureRowsIntoRanges(ferm);
    /** @type {AbsencePeriodRow[]} */
    const out = [];
    for (const g of grouped) {
        if (!rangeOverlapsSchoolYear(g.startYmd, g.endYmd)) continue;
        const related = ferm.filter((r) => g.eventIds?.includes(String(r.id)));
        const first = related[0];
        const ownerId = String(first?.created_by_user_id || first?.owner_user_id || '').trim();
        out.push({
            id: `legacy:${g.startYmd}:${g.endYmd}:${ownerId}`,
            createdByUserId: ownerId,
            creatorRole: '',
            creatorLabel: 'Historique',
            startYmd: g.startYmd,
            endYmd: g.endYmd,
            title: g.title || 'Fermeture',
            appliedAt: '1970-01-01T00:00:00.000Z',
            eventIds: [...(g.eventIds || [])],
            legacy: true
        });
    }
    return out;
}

/** @param {{ startYmd: string, endYmd: string, title?: string, id?: string }} p */
export async function saveAbsencePeriodDraft(p) {
    const u = getPlanningSessionUser();
    if (!u?.id) return { ok: false, error: 'Session requise.', period: null };
    if (!isBackendAuthConfigured()) return { ok: false, error: 'Backend non configuré.', period: null };

    await fetchOrganSchoolSettings();
    const startYmd = String(p.startYmd || '').slice(0, 10);
    const endYmd = String(p.endYmd || '').slice(0, 10);
    if (!rangeOverlapsSchoolYear(startYmd, endYmd)) {
        return { ok: false, error: 'La période doit être dans l’année scolaire en cours.', period: null };
    }
    const sb = getSupabaseClient();
    if (!sb) return { ok: false, error: 'Session indisponible.', period: null };

    const isPeriodic = Boolean(p.isPeriodic);
    const weekdays = normalizeWeekdays(p.weekdays);
    const slotStart = normalizeClosureTime(p.slotStartTime);
    const slotEnd = normalizeClosureTime(p.slotEndTime);
    if (isPeriodic && !weekdays.length) {
        return { ok: false, error: 'Cochez au moins un jour de la semaine.', period: null };
    }
    if (isPeriodic && (!slotStart || !slotEnd || slotEnd <= slotStart)) {
        return { ok: false, error: 'Indiquez une plage horaire valide.', period: null };
    }

    const row = {
        start_ymd: startYmd,
        end_ymd: endYmd,
        title: String(p.title || '').trim() || 'Fermeture',
        is_periodic: isPeriodic,
        weekdays: isPeriodic ? weekdays : [],
        slot_start_time: slotStart ? `${slotStart}:00` : null,
        slot_end_time: slotEnd ? `${slotEnd}:00` : null,
        excluded_ymds: normalizeExcludedYmds(p.excludedYmds),
        day_overrides: normalizeDayOverrides(p.dayOverrides),
        updated_at: new Date().toISOString()
    };

    const existingId = String(p.id || '').trim();
    if (existingId && !existingId.startsWith('legacy:')) {
        const allowApplied = Boolean(p.allowAppliedUpdate);
        let q = sb.from('planning_absence_period').update(row).eq('id', existingId);
        if (!isAdmin(u)) {
            q = q.eq('created_by_user_id', u.id);
            if (!allowApplied) q = q.is('applied_at', null);
        } else if (!allowApplied) {
            q = q.is('applied_at', null);
        }
        const { data, error } = await q.select(
                'id,created_by_user_id,start_ymd,end_ymd,title,applied_at,is_periodic,weekdays,slot_start_time,slot_end_time,excluded_ymds,day_overrides'
            )
            .maybeSingle();
        if (error) return { ok: false, error: error.message, period: null };
        if (!data) {
            return {
                ok: false,
                error: allowApplied
                    ? 'Période introuvable ou non modifiable.'
                    : 'Période introuvable ou déjà appliquée.',
                period: null
            };
        }
        const profileById = await loadProfileMap([u.id]);
        return { ok: true, error: null, period: mapDbPeriod(data, profileById) };
    }

    const { data, error } = await sb
        .from('planning_absence_period')
        .insert({
            ...row,
            created_by_user_id: u.id
        })
        .select(
            'id,created_by_user_id,start_ymd,end_ymd,title,applied_at,is_periodic,weekdays,slot_start_time,slot_end_time,excluded_ymds,day_overrides'
        )
        .single();
    if (error) return { ok: false, error: error.message, period: null };
    const profileById = await loadProfileMap([u.id]);
    return { ok: true, error: null, period: mapDbPeriod(data, profileById) };
}

/** @param {string} periodId */
export async function deleteAbsencePeriodDraft(periodId) {
    const u = getPlanningSessionUser();
    const id = String(periodId || '').trim();
    if (!id || id.startsWith('legacy:')) return { ok: false, error: 'Suppression impossible.' };
    const sb = getSupabaseClient();
    if (!sb) return { ok: false, error: 'Session indisponible.' };
    const { error } = await sb
        .from('planning_absence_period')
        .delete()
        .eq('id', id)
        .eq('created_by_user_id', u?.id || '')
        .is('applied_at', null);
    if (error) return { ok: false, error: error.message };
    return { ok: true, error: null };
}

/** Supprime une période enregistrée (y compris déjà appliquée) si l’utilisateur en est l’auteur. */
export async function deleteAbsencePeriodOwned(periodId) {
    const u = getPlanningSessionUser();
    const id = String(periodId || '').trim();
    if (!id || id.startsWith('legacy:')) return { ok: false, error: 'Suppression impossible.' };
    const sb = getSupabaseClient();
    if (!sb) return { ok: false, error: 'Session indisponible.' };
    let q = sb.from('planning_absence_period').delete().eq('id', id);
    if (!isAdmin(u)) {
        q = q.eq('created_by_user_id', u?.id || '');
    }
    const { error } = await q;
    if (error) return { ok: false, error: error.message };
    return { ok: true, error: null };
}

/** @param {string} periodId */
export async function markAbsencePeriodApplied(periodId) {
    const sb = getSupabaseClient();
    const id = String(periodId || '').trim();
    if (!sb || !id) return { ok: false, error: 'Identifiant manquant.' };
    const { error } = await sb
        .from('planning_absence_period')
        .update({ applied_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', id);
    if (error) return { ok: false, error: error.message };
    return { ok: true, error: null };
}

/** Charge périodes table + legacy, triées. */
export async function loadAllAbsencePeriodsForUi() {
    const [tableRows, legacy] = await Promise.all([
        fetchAbsencePeriodsForCurrentSchoolYear(),
        fetchLegacyAppliedClosureRanges()
    ]);
    const legacyIds = new Set(legacy.map((l) => l.id));
    const merged = [...tableRows, ...legacy.filter((l) => !legacyIds.has(l.id))];
    merged.sort((a, b) => {
        const c = a.startYmd.localeCompare(b.startYmd);
        if (c !== 0) return c;
        return a.endYmd.localeCompare(b.endYmd);
    });
    return merged;
}

export function pendingAbsencePeriodsForUser(periods, user) {
    const uid = String(user?.id || '').trim();
    return (periods || []).filter(
        (p) => !p.legacy && !p.appliedAt && String(p.createdByUserId) === uid
    );
}
