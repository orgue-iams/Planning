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
import { mondayOfLocalWeek, formatLocalYmd, toLocalDateFromIsoDate } from './week-cycle.js';

const MS_DAY = 24 * 60 * 60 * 1000;
/** Mises à jour Postgres en parallèle (borné). */
const DB_SHIFT_CHUNK = 14;
/** Événements par appel calendar-bridge (pause courte entre lots). */
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
 * @param {{
 *   profUserId: string,
 *   profEmail: string,
 *   effectiveYmd: string,
 *   weekDelta: 1 | 2
 * }} p
 */
export async function analyzeProfSlotsShift(p) {
    const profUserId = String(p.profUserId || '').trim();
    const profEmail = normEmail(p.profEmail);
    const weekDelta = p.weekDelta === 2 ? 2 : 1;
    const deltaMs = weekDelta * 7 * MS_DAY;
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

    /** @type {ReturnType<typeof rowToShiftItem>[]} */
    const allItems = [];
    for (const row of rows) {
        const it = rowToShiftItem(row);
        if (!it) continue;
        it.ownerUserId = String(row.owner_user_id || '').trim();
        allItems.push(it);
    }

    const shiftItems = allItems.filter((it) => {
        if (it.ownerUserId !== profUserId) return false;
        if (it.start.getTime() < effectiveMs) return false;
        if (it.start.getTime() < nowMs) return false;
        return true;
    });

    const shiftIds = new Set(shiftItems.map((it) => it.id));
    const fixed = allItems.filter((it) => !shiftIds.has(it.id));

    /** @type {{ id: string, title: string, reason: string }[]} */
    const conflicts = [];

    for (const it of shiftItems) {
        const newStart = new Date(it.start.getTime() + deltaMs);
        const newEnd = new Date(it.end.getTime() + deltaMs);

        for (const other of fixed) {
            if (!rangesOverlap(newStart, newEnd, other.start, other.end)) continue;
            const otherIsCours = other.extType === 'cours';
            const mineIsCours = it.extType === 'cours';
            if (mineIsCours && otherIsCours && other.ownerEmail && other.ownerEmail !== profEmail) {
                conflicts.push({
                    id: it.id,
                    title: it.title,
                    reason: `chevauchement avec le cours « ${other.title} » (${other.ownerEmail}) après décalage`
                });
                break;
            }
            if (other.ownerEmail === profEmail || !mineIsCours || !otherIsCours) {
                conflicts.push({
                    id: it.id,
                    title: it.title,
                    reason: `chevauchement avec « ${other.title} » après décalage`
                });
                break;
            }
        }
    }

    if (conflicts.length) {
        const first = conflicts[0];
        return {
            ok: false,
            error: `${conflicts.length} créneau(x) en conflit après décalage. Ex. « ${first.title} » : ${first.reason}.`,
            count: shiftItems.length,
            conflictCount: conflicts.length
        };
    }

    if (!shiftItems.length) {
        return {
            ok: false,
            error: 'Aucun créneau futur à décaler à partir de cette date.',
            count: 0
        };
    }

    return {
        ok: true,
        error: null,
        count: shiftItems.length,
        weekDelta,
        effectiveYmd,
        deltaMs
    };
}

/** @param {Awaited<ReturnType<typeof analyzeProfSlotsShift>>} analysis */
export function formatProfShiftPrepareSummary(analysis) {
    if (!analysis?.ok) return '';
    const w = analysis.weekDelta === 2 ? '2' : '1';
    return [
        `Décalage prévu : +${w} semaine${analysis.weekDelta === 2 ? 's' : ''} sur ${analysis.count} créneau(x).`,
        `À partir du ${analysis.effectiveYmd} (00:00, heure locale).`,
        'Les créneaux passés et ceux des autres professeurs ne sont pas modifiés.',
        'Votre repère semaine A/B (alternance gabarit) reste inchangé.',
        '',
        'La base est mise à jour en premier (grille rafraîchie), puis Google par lots (agenda général, agenda prof, agendas des élèves inscrits uniquement).',
        'Une confirmation vous sera demandée avant d’appliquer le décalage.'
    ].join('\n');
}

/**
 * @param {{
 *   profUserId: string,
 *   profEmail: string,
 *   effectiveYmd: string,
 *   weekDelta: 1 | 2,
 *   onProgress?: (detail: string) => void,
 *   onDbComplete?: () => void
 * }} p
 */
export async function executeProfSlotsShift(p) {
    const analysis = await analyzeProfSlotsShift(p);
    if (!analysis.ok) {
        return { ok: false, error: analysis.error || 'Analyse impossible.', count: 0 };
    }

    const profUserId = String(p.profUserId || '').trim();
    const profEmail = normEmail(p.profEmail);
    const deltaMs = analysis.deltaMs;
    const effectiveMs = effectiveLocalMidnight(analysis.effectiveYmd).getTime();
    const nowMs = Date.now();

    const rangeStart = effectiveLocalMidnight(analysis.effectiveYmd);
    const rangeEnd = new Date(rangeStart);
    rangeEnd.setFullYear(rangeEnd.getFullYear() + 2);

    const rows = await fetchPlanningEventRowsInRange(rangeStart, rangeEnd);
    const shiftItems = [];
    for (const row of rows) {
        const it = rowToShiftItem(row);
        if (!it) continue;
        if (String(row.owner_user_id || '').trim() !== profUserId) continue;
        if (it.start.getTime() < effectiveMs) continue;
        if (it.start.getTime() < nowMs) continue;
        shiftItems.push(it);
    }

    const total = shiftItems.length;
    p.onProgress?.(`Mise à jour base (0 / ${total})…`);

    const mirrorByEvent = await fetchPlanningMainPoolGoogleIdsForEvents(shiftItems.map((it) => it.id));

    /** @type {{ item: typeof shiftItems[0], startIso: string, endIso: string }[]} */
    const shifted = [];
    let done = 0;

    try {
        await runInChunks(shiftItems, DB_SHIFT_CHUNK, async (chunk) => {
            const results = await Promise.all(
                chunk.map(async (it) => {
                    const newStart = new Date(it.start.getTime() + deltaMs);
                    const newEnd = new Date(it.end.getTime() + deltaMs);
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
            p.onProgress?.(`Base ${done} / ${total}`);
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
    p.onProgress?.('Google : agenda général, puis élèves inscrits…');

    for (let b = 0; b < batchTotal; b++) {
        if (b > 0) await sleepMs(GOOGLE_SHIFT_BATCH_GAP_MS);
        const slice = bridgePayloads.slice(
            b * GOOGLE_SHIFT_BATCH_SIZE,
            (b + 1) * GOOGLE_SHIFT_BATCH_SIZE
        );
        p.onProgress?.(`Google lot ${b + 1} / ${batchTotal} (${slice.length} créneau(x))`);
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
