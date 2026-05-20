/**
 * Fermetures institut : créneaux planning_event (slot_type = fermeture), un par jour.
 */
import { getAccessToken } from './auth-logic.js';
import { bridgeDeleteEvent, invokeCalendarBridge } from './calendar-bridge.js';
import { getPlanningConfig, getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';
import { getChapelSlotBounds } from './organ-settings.js';
import { getPlanningSessionUser } from './session-user.js';
import {
    deletePlanningEventRow,
    fetchPlanningEventRowsInRange,
    fetchPlanningMirrorTargetsForDelete,
    planningUserIdForEmail,
    upsertPlanningEventRow
} from './planning-events-db.js';
import {
    mondayOfLocalWeek,
    toLocalDateFromIsoDate,
    formatLocalYmd
} from './week-cycle.js';
import { formatWeekdayDayTimeFr24 } from '../utils/time-helpers.js';
import { invokeSlotNotify } from './slot-notify-api.js';

const DEFAULT_CLOSURE_TITLE = 'Fermeture';

/**
 * Lundis de semaines touchées par des plages jour → jour (gabarit A/B).
 * @param {Set<string>} closureMondaySet
 * @param {{ startYmd: string, endYmd: string }[]} ranges
 */
export function mergeClosureMondayRanges(closureMondaySet, ranges) {
    for (const r of ranges || []) {
        const start = String(r.startYmd || '').slice(0, 10);
        const end = String(r.endYmd || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) continue;
        const d0 = toLocalDateFromIsoDate(start);
        const d1 = toLocalDateFromIsoDate(end);
        if (Number.isNaN(d0.getTime()) || Number.isNaN(d1.getTime()) || d1 < d0) continue;
        let mon = mondayOfLocalWeek(d0);
        const endMon = mondayOfLocalWeek(d1);
        while (mon.getTime() <= endMon.getTime()) {
            closureMondaySet.add(formatLocalYmd(mon));
            mon.setDate(mon.getDate() + 7);
        }
    }
}

/** @param {string} startYmd @param {string} endYmd */
export function enumerateYmdInRange(startYmd, endYmd) {
    const out = [];
    const s = String(startYmd || '').slice(0, 10);
    const e = String(endYmd || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e) || e < s) return out;
    const cur = new Date(`${s}T12:00:00`);
    const end = new Date(`${e}T12:00:00`);
    while (cur.getTime() <= end.getTime()) {
        out.push(
            `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`
        );
        cur.setDate(cur.getDate() + 1);
    }
    return out;
}

/** @param {string} ymd */
export function daySlotBoundsIsoFromYmd(ymd) {
    const { slotMinTime, slotMaxTime } = getChapelSlotBounds();
    const min = String(slotMinTime || '08:00:00').slice(0, 8);
    const max = String(slotMaxTime || '22:00:00').slice(0, 8);
    const d = String(ymd).slice(0, 10);
    return {
        startIso: new Date(`${d}T${min}`).toISOString(),
        endIso: new Date(`${d}T${max}`).toISOString()
    };
}

function normClosureTitle(raw) {
    const t = String(raw || '').trim();
    return t || DEFAULT_CLOSURE_TITLE;
}

function localYmdFromIso(iso) {
    const d = new Date(String(iso || ''));
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** @param {object[]} rows — lignes RPC planning_events_in_range */
export function groupFermetureRowsIntoRanges(rows) {
    /** @type {Map<string, { ymd: string, title: string, eventIds: string[] }>} */
    const byDay = new Map();
    for (const row of rows || []) {
        if (String(row?.slot_type || '').toLowerCase() !== 'fermeture') continue;
        const ymd = localYmdFromIso(row.start_at);
        if (!ymd) continue;
        const eventId = String(row.id || '').trim();
        const title = normClosureTitle(row.title);
        const prev = byDay.get(ymd);
        if (prev) {
            if (eventId && !prev.eventIds.includes(eventId)) prev.eventIds.push(eventId);
            if (prev.title === DEFAULT_CLOSURE_TITLE && title !== DEFAULT_CLOSURE_TITLE) {
                prev.title = title;
            }
        } else {
            byDay.set(ymd, {
                ymd,
                title,
                eventIds: eventId ? [eventId] : []
            });
        }
    }
    const days = [...byDay.values()].sort((a, b) => a.ymd.localeCompare(b.ymd));
    /** @type {{ startYmd: string, endYmd: string, title: string, eventIds: string[] }[]} */
    const ranges = [];
    const nextYmd = (ymd) => {
        const x = new Date(`${ymd}T12:00:00`);
        x.setDate(x.getDate() + 1);
        return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    };
    for (const d of days) {
        const last = ranges[ranges.length - 1];
        if (last && nextYmd(last.endYmd) === d.ymd) {
            last.endYmd = d.ymd;
            for (const id of d.eventIds) {
                if (id && !last.eventIds.includes(id)) last.eventIds.push(id);
            }
        } else {
            ranges.push({
                startYmd: d.ymd,
                endYmd: d.ymd,
                title: d.title,
                eventIds: [...d.eventIds]
            });
        }
    }
    return ranges;
}

/**
 * Tous les créneaux fermeture sur une plage (y compris doublons).
 * @param {string} startYmd
 * @param {string} endYmd
 */
export async function fermetureEventIdsInRange(startYmd, endYmd) {
    const days = enumerateYmdInRange(startYmd, endYmd);
    if (!days.length) return [];
    const rangeStart = daySlotBoundsIsoFromYmd(days[0]).startIso;
    const rangeEnd = daySlotBoundsIsoFromYmd(days[days.length - 1]).endIso;
    const rows = await fetchPlanningEventRowsInRange(new Date(rangeStart), new Date(rangeEnd));
    const ids = [];
    for (const row of rows) {
        if (String(row?.slot_type || '').toLowerCase() !== 'fermeture') continue;
        const id = String(row?.id || '').trim();
        if (id) ids.push(id);
    }
    return [...new Set(ids)];
}

/**
 * Lundis de semaines « fermées » pour gabarit A/B (à partir des créneaux fermeture en base).
 * @param {object[]} fermetureRows
 * @param {Date} rangeStart
 * @param {Date} rangeEnd
 */
export function closureMondaySetFromFermetureRows(fermetureRows, rangeStart, rangeEnd) {
    const set = new Set();
    const ranges = groupFermetureRowsIntoRanges(fermetureRows).map((r) => ({
        startYmd: r.startYmd,
        endYmd: r.endYmd
    }));
    mergeClosureMondayRanges(set, ranges);
    void rangeStart;
    void rangeEnd;
    return set;
}

function rangesOverlapMs(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
}

/**
 * Créneaux non-fermeture qui chevauchent au moins un jour de la plage.
 * @param {string} startYmd
 * @param {string} endYmd
 * @param {string[]} [excludeEventIds]
 */
export async function findConflictsForClosureRange(startYmd, endYmd, excludeEventIds = []) {
    const days = enumerateYmdInRange(startYmd, endYmd);
    if (!days.length) return [];
    const exclude = new Set((excludeEventIds || []).map((x) => String(x).trim()).filter(Boolean));
    const rangeStart = daySlotBoundsIsoFromYmd(days[0]).startIso;
    const rangeEnd = daySlotBoundsIsoFromYmd(days[days.length - 1]).endIso;
    const rows = await fetchPlanningEventRowsInRange(new Date(rangeStart), new Date(rangeEnd));
    /** @type {{ id: string, title: string, slotType: string, startIso: string, endIso: string, ownerEmail: string, ownerLabel: string }[]} */
    const conflicts = [];
    const seen = new Set();
    for (const row of rows) {
        const id = String(row?.id || '').trim();
        if (!id || exclude.has(id)) continue;
        if (String(row?.slot_type || '').toLowerCase() === 'fermeture') continue;
        const st = new Date(row.start_at).getTime();
        const en = new Date(row.end_at).getTime();
        if (Number.isNaN(st) || Number.isNaN(en)) continue;
        let hits = false;
        for (const ymd of days) {
            const b = daySlotBoundsIsoFromYmd(ymd);
            const ds = new Date(b.startIso).getTime();
            const de = new Date(b.endIso).getTime();
            if (rangesOverlapMs(st, en, ds, de)) {
                hits = true;
                break;
            }
        }
        if (!hits || seen.has(id)) continue;
        seen.add(id);
        const ownerEmail = String(row.owner_email || '').trim().toLowerCase();
        conflicts.push({
            id,
            title: String(row.title || '').trim() || 'Créneau',
            slotType: String(row.slot_type || '').trim(),
            startIso: row.start_at,
            endIso: row.end_at,
            ownerEmail,
            owner_user_id: String(row.owner_user_id || '').trim(),
            ownerLabel: ownerEmail ? ownerEmail.split('@')[0] : '—'
        });
    }
    conflicts.sort((a, b) => String(a.startIso).localeCompare(String(b.startIso)));
    return conflicts;
}

export function formatConflictLineFr(c) {
    const st = new Date(c.startIso);
    const en = new Date(c.endIso);
    if (Number.isNaN(st.getTime())) return `« ${c.title} »`;
    const tf = (d) => formatWeekdayDayTimeFr24(d);
    return `« ${c.title} » — ${tf(st)} – ${tf(en)}`;
}

async function deletePlanningEventWithMirrors(eventId) {
    const canonicalId = String(eventId || '').trim();
    if (!canonicalId) return { ok: false, error: 'Identifiant manquant.' };
    const token = await getAccessToken();
    const targets = await fetchPlanningMirrorTargetsForDelete(canonicalId);
    if (token && targets.length) {
        for (const t of targets) {
            const rDel = await bridgeDeleteEvent(token, t.googleEventId, t.calendarId);
            if (!rDel.ok && !rDel.skipped) {
                return { ok: false, error: rDel.error || 'Suppression Google impossible.' };
            }
        }
    }
    const delRow = await deletePlanningEventRow(canonicalId);
    if (!delRow.ok) return { ok: false, error: delRow.error || 'Suppression base impossible.' };
    return { ok: true, error: null };
}

/**
 * Supprime un créneau (Google + base) et notifie le propriétaire si tiers.
 * @param {object} row — conflit ou ligne RPC
 * @param {object} currentUser
 */
export async function deletePlanningSlotForClosureConflict(row, currentUser) {
    const canonicalId = String(row?.id || '').trim();
    if (!canonicalId) return { ok: false, error: 'Identifiant manquant.' };

    const token = await getAccessToken();
    const targets = await fetchPlanningMirrorTargetsForDelete(canonicalId);
    if (token && targets.length) {
        for (const t of targets) {
            const rDel = await bridgeDeleteEvent(token, t.googleEventId, t.calendarId);
            if (!rDel.ok && !rDel.skipped) {
                return { ok: false, error: rDel.error || 'Suppression Google impossible.' };
            }
        }
    }
    const delRow = await deletePlanningEventRow(canonicalId);
    if (!delRow.ok) return { ok: false, error: delRow.error || 'Suppression base impossible.' };

    const ownerEmail = String(row.ownerEmail || row.owner_email || '')
        .trim()
        .toLowerCase();
    const me = String(currentUser?.email || '')
        .trim()
        .toLowerCase();
    if (ownerEmail && ownerEmail !== me) {
        const st = new Date(row.startIso || row.start_at);
        const en = new Date(row.endIso || row.end_at);
        void invokeSlotNotify({
            action: 'deleted',
            targetEmail: ownerEmail,
            actorEmail: me,
            actorDisplayName: String(currentUser?.name || '').trim() || me,
            slotTitle: String(row.title || '').trim() || 'Créneau',
            slotStartIso: st.toISOString(),
            slotEndIso: en.toISOString(),
            previousStartIso: '',
            previousEndIso: ''
        }).catch((err) => console.warn('[slot-notify] fermeture', err));
    }
    return { ok: true, error: null };
}

async function syncClosureEventsToGoogle(payloads) {
    if (!payloads.length) return { ok: true, error: null };
    const { calendarBridgeUrl } = getPlanningConfig();
    if (!calendarBridgeUrl) return { ok: true, error: null };
    const token = await getAccessToken();
    if (!token) return { ok: false, error: 'Session expirée (reconnectez-vous).' };
    const batchSize = 15;
    for (let i = 0; i < payloads.length; i += batchSize) {
        const batch = payloads.slice(i, i + batchSize);
        const r = await invokeCalendarBridge(token, { action: 'upsert', events: batch });
        if (!r.ok && !r.skipped) {
            return { ok: false, error: r.error || 'Synchronisation Google impossible.' };
        }
    }
    return { ok: true, error: null };
}

/**
 * Charge les périodes futures (groupées) depuis la base.
 * @param {{ pastDays?: number, futureDays?: number }} [opts]
 */
export async function loadClosureRangesFromPlanning(opts = {}) {
    const pastDays = Number(opts.pastDays) > 0 ? Number(opts.pastDays) : 30;
    const futureDays = Number(opts.futureDays) > 0 ? Number(opts.futureDays) : 800;
    const start = new Date();
    start.setDate(start.getDate() - pastDays);
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setDate(end.getDate() + futureDays);
    end.setHours(23, 59, 59, 999);
    const rows = await fetchPlanningEventRowsInRange(start, end);
    const ferm = rows.filter((r) => String(r?.slot_type || '').toLowerCase() === 'fermeture');
    return groupFermetureRowsIntoRanges(ferm);
}

/**
 * @param {{ startYmd: string, endYmd: string, title?: string, eventIds?: string[] }} range
 * @param {{ deleteConflicts?: boolean, conflicts?: object[] }} opts
 */
export async function saveClosureRangeToPlanning(range, opts = {}) {
    const u = getPlanningSessionUser();
    if (!u?.email || !u?.id) return { ok: false, error: 'Session requise.' };
    if (!isBackendAuthConfigured()) return { ok: false, error: 'Backend non configuré.' };

    const startYmd = String(range.startYmd || '').slice(0, 10);
    const endYmd = String(range.endYmd || '').slice(0, 10);
    const title = normClosureTitle(range.title);
    const days = enumerateYmdInRange(startYmd, endYmd);
    if (!days.length) return { ok: false, error: 'Plage de dates invalide.' };

    if (opts.deleteConflicts && Array.isArray(opts.conflicts)) {
        for (const c of opts.conflicts) {
            const dr = await deletePlanningSlotForClosureConflict(c, u);
            if (!dr.ok) return dr;
        }
    }

    const explicitOld = (range.eventIds || []).map((x) => String(x).trim()).filter(Boolean);
    const inRange = await fermetureEventIdsInRange(startYmd, endYmd);
    const toDelete = new Set([...explicitOld, ...inRange]);
    for (const id of toDelete) {
        const dr = await deletePlanningEventWithMirrors(id);
        if (!dr.ok) return dr;
    }

    const ownerEmail = String(u.email).trim().toLowerCase();
    const ownerUserId = String(u.id).trim();
    /** @type {{ planningEventId: string, title: string, start: string, end: string, type: string, owner: string }[]} */
    const googlePayloads = [];

    for (const ymd of days) {
        const { startIso, endIso } = daySlotBoundsIsoFromYmd(ymd);
        const ur = await upsertPlanningEventRow({
            startIso,
            endIso,
            title,
            dbSlotType: 'fermeture',
            ownerEmail,
            ownerUserId
        });
        if (!ur.ok || !ur.id) {
            return { ok: false, error: ur.error || 'Enregistrement fermeture impossible.' };
        }
        googlePayloads.push({
            planningEventId: ur.id,
            title,
            start: startIso,
            end: endIso,
            type: 'fermeture',
            owner: ownerEmail
        });
    }

    const sync = await syncClosureEventsToGoogle(googlePayloads);
    if (!sync.ok) {
        return {
            ok: false,
            error: sync.error || 'Fermetures en base ; synchronisation Google incomplète.'
        };
    }
    return { ok: true, error: null };
}

/** @param {string[]} eventIds */
export async function deleteClosureRangeEvents(eventIds) {
    const u = getPlanningSessionUser();
    if (!u?.email) return { ok: false, error: 'Session requise.' };
    for (const id of eventIds || []) {
        const dr = await deletePlanningEventWithMirrors(id);
        if (!dr.ok) return dr;
    }
    return { ok: true, error: null };
}
