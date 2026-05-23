/**
 * Décalage +1 / +2 semaines des créneaux existants d’un professeur (phase 3).
 * Ne modifie pas organ_prof_week_cycle.
 */
import { getAccessToken } from './auth-logic.js';
import { getPlanningConfig } from './supabase-client.js';
import { bridgeUpsertEvents } from './calendar-bridge.js';
import {
    fetchPlanningEventRowsInRange,
    fetchPlanningMainPoolGoogleIdsForEvents,
    mapPlanningDbRowToFcEvent,
    planningDbSlotTypeToBridgeType,
    upsertPlanningEventRow
} from './planning-events-db.js';
import {
    collectClosureYmdSetFromDbRows,
    deletePlanningSlotForClosureConflict
} from './fermetures-planning.js';
import {
    mondayOfLocalWeek,
    formatLocalYmd,
    toLocalDateFromIsoDate,
    weekTypeLetterForAlternance
} from './week-cycle.js';
import { formatWeekdayDayTimeFr24 } from '../utils/time-helpers.js';
import { formatApplyProgressLabel, formatUniqueTitlesPreview } from '../utils/apply-progress-label.js';

const MS_DAY = 24 * 60 * 60 * 1000;
const DB_SHIFT_CHUNK = 14;
const GOOGLE_SHIFT_BATCH_SIZE = 18;
const GOOGLE_SHIFT_BATCH_GAP_MS = 140;

function sleepMs(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @param {(chunk: T[]) => Promise<void>} fn
 */
async function runInChunks(items, size, fn) {
    for (let i = 0; i < items.length; i += size) {
        await fn(items.slice(i, i + size));
    }
}

function normEmail(em) {
    return String(em || '').trim().toLowerCase();
}

/** Créneaux à exclure du décalage auto (fermetures institut, pas des cours à déplacer). */
function profSlotEligibleForShift(it) {
    const slot = String(it?.slotType || '').trim().toLowerCase();
    const ext = String(it?.extType || '').trim().toLowerCase();
    if (slot === 'fermeture' || ext === 'fermeture') return false;
    return true;
}

/** Créneau qui tombe (au moins un jour) sur un des jours de fermeture appliqués. */
export function slotOverlapsYmdSet(start, end, ymdSet) {
    if (!ymdSet?.size) return true;
    const dayStart = new Date(start);
    dayStart.setHours(0, 0, 0, 0);
    const endMs = end.getTime();
    const cur = new Date(dayStart);
    while (cur.getTime() < endMs) {
        if (ymdSet.has(formatLocalYmd(cur))) return true;
        cur.setDate(cur.getDate() + 1);
    }
    return false;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/** Lundi de la semaine prochaine (défaut date effective). */
export function defaultProfShiftEffectiveYmd() {
    const mon = mondayOfLocalWeek(new Date());
    mon.setDate(mon.getDate() + 7);
    return formatLocalYmd(mon);
}

function effectiveLocalMidnight(ymd) {
    const d = toLocalDateFromIsoDate(String(ymd || '').trim());
    d.setHours(0, 0, 0, 0);
    return d;
}

function rowToShiftItem(row) {
    const start = new Date(String(row.start_at ?? ''));
    const end = new Date(String(row.end_at ?? ''));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    const ev = mapPlanningDbRowToFcEvent(row, null);
    const xp = ev.extendedProps || {};
    return {
        id: String(row.id || '').trim(),
        title: String(row.title || '').trim() || 'Créneau',
        slotType: String(row.slot_type || '').trim(),
        extType: String(xp.type || '').toLowerCase(),
        ownerEmail: normEmail(row.owner_email || xp.owner),
        ownerUserId: '',
        start,
        end,
        inscritsCsv: Array.isArray(xp.inscrits) ? xp.inscrits.join(',') : '',
        googleEventId: String(xp.googleEventId || '').trim(),
        poolGoogleEventId: String(xp.poolGoogleEventId || '').trim()
    };
}

/**
 * Décale de `weekDelta` semaines ; si le jour d’arrivée est en fermeture, saute au même jour la semaine suivante.
 * @param {Date} start
 * @param {Date} end
 * @param {number} weekDelta
 * @param {Set<string>} closureYmdSet
 */
export function computeShiftedRange(start, end, weekDelta, closureYmdSet) {
    const ns = new Date(start);
    const ne = new Date(end);
    for (let w = 0; w < weekDelta; w++) {
        ns.setDate(ns.getDate() + 7);
        ne.setDate(ne.getDate() + 7);
        let guard = 0;
        while (closureYmdSet?.has(formatLocalYmd(ns)) && guard < 60) {
            ns.setDate(ns.getDate() + 7);
            ne.setDate(ne.getDate() + 7);
            guard += 1;
        }
    }
    return { newStart: ns, newEnd: ne };
}

/**
 * Décalage partiel d’alternance A/B : dans une même semaine calendaire, certains jours changent de lettre, d’autres non.
 * @param {ReturnType<typeof rowToShiftItem>[]} shiftItems
 * @param {Set<string>} closureYmdSet
 * @param {{ anchorMondayIso: string, letterAtAnchor: 'A'|'B' } | null} cycle
 * @param {number} weekDelta
 */
export function detectShiftPartialAlternanceImpact(shiftItems, closureYmdSet, cycle, weekDelta) {
    if (!cycle?.anchorMondayIso || !shiftItems?.length) {
        return { partial: false, lines: [] };
    }
    const anchor = cycle.anchorMondayIso;
    const letter = cycle.letterAtAnchor === 'B' ? 'B' : 'A';
    /** @type {Map<string, Set<string>>} */
    const transitionsByWeek = new Map();

    for (const it of shiftItems) {
        const oldL = weekTypeLetterForAlternance(it.start, anchor, letter);
        const { newStart } = computeShiftedRange(it.start, it.end, weekDelta, closureYmdSet);
        const newL = weekTypeLetterForAlternance(newStart, anchor, letter);
        if (!oldL || !newL || oldL === newL) continue;
        const monIso = formatLocalYmd(mondayOfLocalWeek(it.start));
        const tr = `${oldL}→${newL}`;
        if (!transitionsByWeek.has(monIso)) transitionsByWeek.set(monIso, new Set());
        transitionsByWeek.get(monIso).add(tr);
    }

    const lines = [];
    for (const [monIso, set] of transitionsByWeek) {
        if (set.size > 1) {
            lines.push(
                `Semaine du ${monIso} : alternance A/B affectée différemment selon les jours (${[...set].join(', ')}).`
            );
        }
    }
    return { partial: lines.length > 0, lines };
}

function conflictRowFromOther(other, newStart, newEnd) {
    const typ = String(other.slotType || other.extType || 'créneau').trim();
    return {
        id: other.id,
        title: other.title,
        ownerEmail: other.ownerEmail,
        ownerName: other.ownerEmail ? other.ownerEmail.split('@')[0] : '',
        slotType: typ,
        startIso: newStart.toISOString(),
        endIso: newEnd.toISOString(),
        reason: `chevauchement avec « ${other.title} » (${other.ownerEmail || 'autre'})`
    };
}

/**
 * @param {{
 *   profUserId: string,
 *   profEmail: string,
 *   effectiveYmd: string,
 *   weekDelta: 1 | 2,
 *   profWeekCycle?: { anchorMondayIso: string, letterAtAnchor: 'A'|'B' } | null,
 *   restrictToClosureYmdSet?: Set<string>
 * }} p
 */
export async function analyzeProfSlotsShift(p) {
    const profUserId = String(p.profUserId || '').trim();
    const profEmail = normEmail(p.profEmail);
    const weekDelta = p.weekDelta === 2 ? 2 : 1;
    const effectiveYmd = String(p.effectiveYmd || '').trim();
    if (!profUserId || !profEmail) {
        return { ok: false, error: 'Professeur non identifié.', count: 0 };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveYmd)) {
        return { ok: false, error: 'Date effective invalide.', count: 0 };
    }

    const effectiveMs = effectiveLocalMidnight(effectiveYmd).getTime();
    const nowMs = Date.now();
    const rangeStart = effectiveLocalMidnight(effectiveYmd);
    const rangeEnd = new Date(rangeStart);
    rangeEnd.setFullYear(rangeEnd.getFullYear() + 2);

    let rows = [];
    try {
        rows = await fetchPlanningEventRowsInRange(rangeStart, rangeEnd);
    } catch (e) {
        return { ok: false, error: String(e?.message || e), count: 0 };
    }

    const closureYmdSet = collectClosureYmdSetFromDbRows(rows);

    /** @type {ReturnType<typeof rowToShiftItem>[]} */
    const allItems = [];
    for (const row of rows) {
        const it = rowToShiftItem(row);
        if (!it) continue;
        it.ownerUserId = String(row.owner_user_id || '').trim();
        allItems.push(it);
    }

    let shiftItems = allItems.filter((it) => {
        if (!profSlotEligibleForShift(it)) return false;
        if (it.ownerUserId !== profUserId) return false;
        if (it.start.getTime() < effectiveMs) return false;
        if (it.start.getTime() < nowMs) return false;
        return true;
    });

    const restrict = p.restrictToClosureYmdSet;
    if (restrict instanceof Set && restrict.size > 0) {
        shiftItems = shiftItems.filter((it) => slotOverlapsYmdSet(it.start, it.end, restrict));
    }

    if (!shiftItems.length) {
        const restricted = restrict instanceof Set && restrict.size > 0;
        if (restricted) {
            return {
                ok: true,
                error: null,
                count: 0,
                weekDelta,
                effectiveYmd,
                deltaMs: weekDelta * 7 * MS_DAY,
                closureYmdSet,
                conflictsToDelete: [],
                partialAlternance: { partial: false, lines: [] },
                closureDaysInRange: 0
            };
        }
        return {
            ok: false,
            error: 'Aucun créneau futur à décaler à partir de cette date.',
            count: 0
        };
    }

    const shiftIds = new Set(shiftItems.map((it) => it.id));
    const fixed = allItems.filter((it) => !shiftIds.has(it.id));

    /** @type {ReturnType<typeof conflictRowFromOther>[]} */
    const conflictsToDelete = [];

    for (const it of shiftItems) {
        const { newStart, newEnd } = computeShiftedRange(it.start, it.end, weekDelta, closureYmdSet);
        for (const other of fixed) {
            if (!rangesOverlap(newStart, newEnd, other.start, other.end)) continue;
            conflictsToDelete.push(conflictRowFromOther(other, newStart, newEnd));
            break;
        }
    }

    const partialAlt = detectShiftPartialAlternanceImpact(
        shiftItems,
        closureYmdSet,
        p.profWeekCycle || null,
        weekDelta
    );

    const closureDaysInRange = [...closureYmdSet].filter((ymd) => ymd >= effectiveYmd).length;

    return {
        ok: true,
        error: null,
        count: shiftItems.length,
        weekDelta,
        effectiveYmd,
        deltaMs: weekDelta * 7 * MS_DAY,
        closureYmdSet,
        conflictsToDelete,
        partialAlternance: partialAlt,
        closureDaysInRange
    };
}

/** @param {Awaited<ReturnType<typeof analyzeProfSlotsShift>>} analysis */
export function formatProfShiftPrepareSummary(analysis) {
    if (!analysis?.ok) return '';
    const w = analysis.weekDelta === 2 ? '2' : '1';
    const nDel = analysis.conflictsToDelete?.length || 0;
    const lines = [
        `Décalage prévu : +${w} semaine${analysis.weekDelta === 2 ? 's' : ''} sur ${analysis.count} créneau(x).`,
        `À partir du ${analysis.effectiveYmd} (00:00, heure locale).`,
        'Les jours de fermeture institut sont contournés (même jour de la semaine, semaine suivante).',
        'Les créneaux passés et ceux des autres professeurs ne sont pas modifiés.',
        'Votre repère semaine A/B (alternance gabarit) reste inchangé en base.',
        ''
    ];
    if (analysis.closureDaysInRange > 0) {
        lines.push(
            `Jours fermés sur la période : ${analysis.closureDaysInRange} (prise en compte au décalage).`,
            ''
        );
    }
    if (nDel > 0) {
        lines.push(
            `——— Créneaux en conflit (suppression automatique) ———`,
            `${nDel} créneau(x) seront supprimés (comme une suppression normale, avec notification du propriétaire si besoin).`,
            ''
        );
        for (const c of analysis.conflictsToDelete.slice(0, 12)) {
            const st = new Date(c.startIso);
            const en = new Date(c.endIso);
            lines.push(
                `• ${formatWeekdayDayTimeFr24(st)} – ${formatWeekdayDayTimeFr24(en)} : « ${c.title} » (${c.ownerEmail || '?'})`
            );
        }
        if (nDel > 12) lines.push(`… et ${nDel - 12} autre(s).`);
        lines.push('');
    }
    if (analysis.partialAlternance?.partial) {
        lines.push(
            '——— Alternance A/B (par jour) ———',
            'Attention : le décalage ne déplace pas tous les jours de la même semaine de la même façon (ex. jeudi férié, vendredi normal).',
            ...(analysis.partialAlternance.lines || []),
            'Une confirmation vous sera demandée avant d’appliquer.',
            ''
        );
    }
    lines.push(
        'La base est mise à jour en premier (grille rafraîchie), puis Google par lots.',
        'Une confirmation vous sera demandée avant d’appliquer le décalage.'
    );
    return lines.join('\n');
}

/**
 * @param {{
 *   profUserId: string,
 *   profEmail: string,
 *   effectiveYmd: string,
 *   weekDelta: 1 | 2,
 *   currentUser: object,
 *   onProgress?: (detail: string) => void,
 *   onDbComplete?: () => void,
 *   restrictToClosureYmdSet?: Set<string>
 * }} p
 */
export async function executeProfSlotsShift(p) {
    const analysis = await analyzeProfSlotsShift(p);
    if (!analysis.ok) {
        return { ok: false, error: analysis.error || 'Analyse impossible.', count: 0 };
    }

    const profUserId = String(p.profUserId || '').trim();
    const profEmail = normEmail(p.profEmail);
    const closureYmdSet = analysis.closureYmdSet || new Set();
    const effectiveMs = effectiveLocalMidnight(analysis.effectiveYmd).getTime();
    const nowMs = Date.now();

    const rangeStart = effectiveLocalMidnight(analysis.effectiveYmd);
    const rangeEnd = new Date(rangeStart);
    rangeEnd.setFullYear(rangeEnd.getFullYear() + 2);

    const rows = await fetchPlanningEventRowsInRange(rangeStart, rangeEnd);
    let shiftItems = [];
    for (const row of rows) {
        const it = rowToShiftItem(row);
        if (!it) continue;
        if (!profSlotEligibleForShift(it)) continue;
        if (String(row.owner_user_id || '').trim() !== profUserId) continue;
        if (it.start.getTime() < effectiveMs) continue;
        if (it.start.getTime() < nowMs) continue;
        shiftItems.push(it);
    }
    const restrict = p.restrictToClosureYmdSet;
    if (restrict instanceof Set && restrict.size > 0) {
        shiftItems = shiftItems.filter((it) => slotOverlapsYmdSet(it.start, it.end, restrict));
    }
    if (!shiftItems.length) {
        return { ok: true, error: null, count: 0, googleSkipped: true };
    }

    const currentUser = p.currentUser || { email: profEmail };

    for (const c of analysis.conflictsToDelete || []) {
        p.onProgress?.(`Suppression conflit « ${c.title} »…`);
        const row = rows.find((r) => String(r.id) === c.id) || {
            id: c.id,
            title: c.title,
            owner_email: c.ownerEmail,
            start_at: c.startIso,
            end_at: c.endIso
        };
        const dr = await deletePlanningSlotForClosureConflict(row, currentUser);
        if (!dr.ok) {
            return {
                ok: false,
                error: dr.error || `Suppression impossible pour « ${c.title} ».`,
                count: 0
            };
        }
    }

    const total = shiftItems.length;
    p.onProgress?.(
        formatApplyProgressLabel({
            domain: 'Planning',
            detail:
                total > 0
                    ? `décalage en base de ${total} créneau(x) sur les jours fermés`
                    : 'aucun créneau à décaler'
        })
    );

    const mirrorByEvent = await fetchPlanningMainPoolGoogleIdsForEvents(shiftItems.map((it) => it.id));

    /** @type {{ item: typeof shiftItems[0], startIso: string, endIso: string }[]} */
    const shifted = [];
    let done = 0;

    try {
        await runInChunks(shiftItems, DB_SHIFT_CHUNK, async (chunk) => {
            const results = await Promise.all(
                chunk.map(async (it) => {
                    const { newStart, newEnd } = computeShiftedRange(
                        it.start,
                        it.end,
                        analysis.weekDelta,
                        closureYmdSet
                    );
                    const startIso = newStart.toISOString();
                    const endIso = newEnd.toISOString();
                    const ur = await upsertPlanningEventRow({
                        id: it.id,
                        startIso,
                        endIso,
                        title: it.title,
                        dbSlotType: it.slotType,
                        ownerEmail: profEmail,
                        ownerUserId: profUserId
                    });
                    return { it, startIso, endIso, ur };
                })
            );
            for (const { it, startIso, endIso, ur } of results) {
                if (!ur.ok) {
                    throw new Error(ur.error || `Échec base pour « ${it.title} ».`);
                }
                shifted.push({ item: it, startIso, endIso });
                done += 1;
            }
            p.onProgress?.(
                formatApplyProgressLabel({
                    domain: 'Planning',
                    step: done,
                    total,
                    detail: 'décalage en base'
                })
            );
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg, count: done };
    }

    p.onDbComplete?.();

    /** @type {Record<string, unknown>[]} */
    const bridgePayloads = shifted.map(({ item: it, startIso, endIso }) => {
        const mirrors = mirrorByEvent.get(it.id) || {
            mainGoogleEventId: '',
            poolGoogleEventId: ''
        };
        const gid = it.googleEventId || mirrors.mainGoogleEventId;
        const pool = it.poolGoogleEventId || mirrors.poolGoogleEventId;
        return {
            planningEventId: it.id,
            ...(gid ? { googleEventId: gid } : {}),
            title: it.title,
            start: startIso,
            end: endIso,
            type: planningDbSlotTypeToBridgeType(it.slotType),
            owner: profEmail,
            ...(pool ? { poolGoogleEventId: pool } : {}),
            ...(it.inscritsCsv ? { inscrits: it.inscritsCsv } : {})
        };
    });

    const { calendarBridgeUrl } = getPlanningConfig();
    if (!calendarBridgeUrl || !bridgePayloads.length) {
        return { ok: true, error: null, count: done, googleSkipped: true };
    }

    const token = await getAccessToken();
    if (!token) {
        return {
            ok: false,
            error: 'Créneaux décalés en base ; session expirée pour synchroniser Google.',
            count: done
        };
    }

    const batchTotal = Math.ceil(bridgePayloads.length / GOOGLE_SHIFT_BATCH_SIZE) || 1;

    for (let b = 0; b < batchTotal; b++) {
        if (b > 0) await sleepMs(GOOGLE_SHIFT_BATCH_GAP_MS);
        const slice = bridgePayloads.slice(
            b * GOOGLE_SHIFT_BATCH_SIZE,
            (b + 1) * GOOGLE_SHIFT_BATCH_SIZE
        );
        const preview = formatUniqueTitlesPreview(
            slice.map((ev) => String(ev.title || 'Créneau').trim())
        );
        p.onProgress?.(
            formatApplyProgressLabel({
                domain: 'Agendas Google',
                step: b + 1,
                total: batchTotal,
                detail: `${preview.text || 'créneaux'} — propriétaire et inscrits (${slice.length} opération(s))`
            })
        );
        const r = await bridgeUpsertEvents(token, slice);
        if (!r.ok && !r.skipped) {
            return {
                ok: false,
                error: `Base à jour ; Google en échec (lot ${b + 1}/${batchTotal}) : ${r.error || 'erreur'}.`,
                count: done
            };
        }
    }

    return { ok: true, error: null, count: done, googleSkipped: false };
}
