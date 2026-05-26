/**
 * Séries périodiques du planning : définition et exceptions.
 */
import { getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';

function normalizeSeriesSlotType(slotType) {
    const s = String(slotType || '').trim().toLowerCase();
    if (s === 'cours') return 'cours';
    if (s === 'travail perso') return 'travail perso';
    if (s === 'concert') return 'concert';
    return 'autre';
}

function normalizeSeriesStatus(status) {
    return String(status || '').trim().toLowerCase() === 'stopped' ? 'stopped' : 'active';
}

function normalizeSeriesFrequencyInterval(value) {
    return Number(value) === 2 ? 2 : 1;
}

function normalizeOccurrenceLimit(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : null;
}

function mapSeriesRow(row) {
    return {
        id: String(row?.id || '').trim(),
        ownerUserId: String(row?.owner_user_id || '').trim(),
        ownerEmail: String(row?.owner_email || '').trim().toLowerCase(),
        slotType: normalizeSeriesSlotType(row?.slot_type),
        title: String(row?.title || '').trim(),
        frequencyUnit: 'week',
        frequencyInterval: normalizeSeriesFrequencyInterval(row?.frequency_interval),
        startAtFirst: String(row?.start_at_first || ''),
        untilYmd: String(row?.until_ymd || '').slice(0, 10),
        occurrenceLimit: normalizeOccurrenceLimit(row?.occurrence_limit),
        sourceLegacyTemplateLineId: String(row?.source_legacy_template_line_id || '').trim(),
        status: normalizeSeriesStatus(row?.status),
        createdAt: String(row?.created_at || ''),
        updatedAt: String(row?.updated_at || '')
    };
}

/**
 * @param {{
 *   ownerUserId: string,
 *   ownerEmail: string,
 *   slotType: string,
 *   title: string,
 *   startAtFirst: string,
 *   untilYmd: string,
 *   frequencyInterval?: number,
 *   occurrenceLimit?: number | null,
 *   sourceLegacyTemplateLineId?: string | null,
 *   status?: string
 * }} p
 */
export async function createPlanningEventSeries(p) {
    const sb = getSupabaseClient();
    if (!sb || !isBackendAuthConfigured()) {
        return { ok: false, error: 'Session indisponible.', series: null };
    }
    const row = {
        owner_user_id: String(p.ownerUserId || '').trim(),
        owner_email: String(p.ownerEmail || '').trim().toLowerCase(),
        slot_type: normalizeSeriesSlotType(p.slotType),
        title: String(p.title || '').trim() || 'Créneau',
        frequency_unit: 'week',
        frequency_interval: normalizeSeriesFrequencyInterval(p.frequencyInterval),
        start_at_first: String(p.startAtFirst || ''),
        until_ymd: String(p.untilYmd || '').slice(0, 10),
        occurrence_limit: normalizeOccurrenceLimit(p.occurrenceLimit),
        source_legacy_template_line_id: String(p.sourceLegacyTemplateLineId || '').trim() || null,
        status: normalizeSeriesStatus(p.status),
        updated_at: new Date().toISOString()
    };
    const { data, error } = await sb
        .from('planning_event_series')
        .insert(row)
        .select(
            'id,owner_user_id,owner_email,slot_type,title,frequency_interval,start_at_first,until_ymd,occurrence_limit,source_legacy_template_line_id,status,created_at,updated_at'
        )
        .single();
    if (error) return { ok: false, error: error.message, series: null };
    return { ok: true, error: null, series: mapSeriesRow(data) };
}

/**
 * @param {string} seriesId
 * @param {Partial<{
 *   title: string,
 *   untilYmd: string,
 *   frequencyInterval: number,
 *   occurrenceLimit: number | null,
 *   status: string
 * }>} patch
 */
export async function updatePlanningEventSeries(seriesId, patch) {
    const sb = getSupabaseClient();
    const id = String(seriesId || '').trim();
    if (!sb || !isBackendAuthConfigured()) {
        return { ok: false, error: 'Session indisponible.', series: null };
    }
    if (!id) return { ok: false, error: 'Série introuvable.', series: null };
    const row = {
        updated_at: new Date().toISOString()
    };
    if (patch.title !== undefined) row.title = String(patch.title || '').trim() || 'Créneau';
    if (patch.untilYmd !== undefined) row.until_ymd = String(patch.untilYmd || '').slice(0, 10);
    if (patch.frequencyInterval !== undefined) {
        row.frequency_interval = normalizeSeriesFrequencyInterval(patch.frequencyInterval);
    }
    if (patch.occurrenceLimit !== undefined) {
        row.occurrence_limit = normalizeOccurrenceLimit(patch.occurrenceLimit);
    }
    if (patch.status !== undefined) row.status = normalizeSeriesStatus(patch.status);
    const { data, error } = await sb
        .from('planning_event_series')
        .update(row)
        .eq('id', id)
        .select(
            'id,owner_user_id,owner_email,slot_type,title,frequency_interval,start_at_first,until_ymd,occurrence_limit,source_legacy_template_line_id,status,created_at,updated_at'
        )
        .single();
    if (error) return { ok: false, error: error.message, series: null };
    return { ok: true, error: null, series: mapSeriesRow(data) };
}

/**
 * @param {string} seriesId
 */
export async function deletePlanningEventSeries(seriesId) {
    const sb = getSupabaseClient();
    const id = String(seriesId || '').trim();
    if (!sb || !isBackendAuthConfigured()) return { ok: false, error: 'Session indisponible.' };
    if (!id) return { ok: false, error: 'Série introuvable.' };
    const { error } = await sb.from('planning_event_series').delete().eq('id', id);
    if (error) return { ok: false, error: error.message };
    return { ok: true, error: null };
}

/**
 * @param {string[]} seriesIds
 */
export async function fetchPlanningEventSeriesByIds(seriesIds) {
    const sb = getSupabaseClient();
    const ids = [...new Set((seriesIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!sb || !isBackendAuthConfigured() || !ids.length) return [];
    const { data, error } = await sb
        .from('planning_event_series')
        .select(
            'id,owner_user_id,owner_email,slot_type,title,frequency_interval,start_at_first,until_ymd,occurrence_limit,source_legacy_template_line_id,status,created_at,updated_at'
        )
        .in('id', ids);
    if (error) {
        console.warn('[planning-series-db] fetchPlanningEventSeriesByIds', error.message);
        return [];
    }
    return (data || []).map(mapSeriesRow);
}

/**
 * @param {string} occurrenceStartIso
 * @param {'skip' | 'override' | 'detach'} exceptionKind
 * @param {object} payload
 * @param {string} createdByUserId
 * @param {string} seriesId
 */
export async function createPlanningSeriesException(
    occurrenceStartIso,
    exceptionKind,
    payload,
    createdByUserId,
    seriesId
) {
    const sb = getSupabaseClient();
    if (!sb || !isBackendAuthConfigured()) {
        return { ok: false, error: 'Session indisponible.' };
    }
    const kind = ['skip', 'override', 'detach'].includes(String(exceptionKind))
        ? String(exceptionKind)
        : 'override';
    const { error } = await sb.from('planning_event_series_exception').insert({
        series_id: String(seriesId || '').trim(),
        occurrence_start_at: String(occurrenceStartIso || ''),
        exception_kind: kind,
        payload: payload && typeof payload === 'object' ? payload : {},
        created_by_user_id: String(createdByUserId || '').trim(),
        updated_at: new Date().toISOString()
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, error: null };
}

/**
 * @param {string[]} seriesIds
 * @returns {Promise<Map<string, Array<{ id: string, occurrenceStartAt: string, exceptionKind: string, payload: object }>>>}
 */
export async function fetchPlanningSeriesExceptionsBySeriesIds(seriesIds) {
    const sb = getSupabaseClient();
    const ids = [...new Set((seriesIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    const out = new Map();
    if (!sb || !isBackendAuthConfigured() || !ids.length) return out;
    const { data, error } = await sb
        .from('planning_event_series_exception')
        .select('id,series_id,occurrence_start_at,exception_kind,payload')
        .in('series_id', ids)
        .order('occurrence_start_at', { ascending: true });
    if (error) {
        console.warn('[planning-series-db] fetchPlanningSeriesExceptionsBySeriesIds', error.message);
        return out;
    }
    for (const row of data || []) {
        const sid = String(row.series_id || '').trim();
        if (!sid) continue;
        if (!out.has(sid)) out.set(sid, []);
        out.get(sid).push({
            id: String(row.id || '').trim(),
            occurrenceStartAt: String(row.occurrence_start_at || ''),
            exceptionKind: String(row.exception_kind || '').trim(),
            payload: row.payload && typeof row.payload === 'object' ? row.payload : {}
        });
    }
    return out;
}
