/**
 * Périodes d'absence / fermeture (brouillon → application).
 */
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
        (role === 'admin' ? 'Administration' : 'Professeur');
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
        legacy: false
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
        .select('id,created_by_user_id,start_ymd,end_ymd,title,applied_at,created_at')
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
    return rows.map((r) => mapDbPeriod(r, profileById));
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
    const today = todayYmdLocal();
    if (endYmd < today) {
        return { ok: false, error: 'Impossible d’ajouter une période entièrement passée.', period: null };
    }

    const sb = getSupabaseClient();
    if (!sb) return { ok: false, error: 'Session indisponible.', period: null };

    const row = {
        start_ymd: startYmd,
        end_ymd: endYmd,
        title: String(p.title || '').trim() || 'Fermeture',
        updated_at: new Date().toISOString()
    };

    const existingId = String(p.id || '').trim();
    if (existingId && !existingId.startsWith('legacy:')) {
        const { data, error } = await sb
            .from('planning_absence_period')
            .update(row)
            .eq('id', existingId)
            .eq('created_by_user_id', u.id)
            .is('applied_at', null)
            .select('id,created_by_user_id,start_ymd,end_ymd,title,applied_at')
            .maybeSingle();
        if (error) return { ok: false, error: error.message, period: null };
        if (!data) return { ok: false, error: 'Période introuvable ou déjà appliquée.', period: null };
        const profileById = await loadProfileMap([u.id]);
        return { ok: true, error: null, period: mapDbPeriod(data, profileById) };
    }

    const { data, error } = await sb
        .from('planning_absence_period')
        .insert({
            ...row,
            created_by_user_id: u.id
        })
        .select('id,created_by_user_id,start_ymd,end_ymd,title,applied_at')
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
