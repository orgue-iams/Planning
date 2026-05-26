/**
 * Génération d'occurrences pour séries hebdo / bihebdo.
 */

function parseDateYmdLocal(ymd) {
    const v = String(ymd || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const d = new Date(`${v}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
}

function toYmdLocal(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
}

function normalizeSeriesExceptions(seriesExceptions) {
    const map = new Map();
    for (const ex of Array.isArray(seriesExceptions) ? seriesExceptions : []) {
        const iso = String(ex?.occurrenceStartAt || '').trim();
        if (!iso) continue;
        if (!map.has(iso)) map.set(iso, []);
        map.get(iso).push({
            exceptionKind: String(ex?.exceptionKind || '').trim(),
            payload: ex?.payload && typeof ex.payload === 'object' ? ex.payload : {}
        });
    }
    return map;
}

function exceptionAdvanceDays(exceptions, intervalDays) {
    for (const ex of exceptions || []) {
        if (String(ex?.exceptionKind || '') !== 'skip') continue;
        const shiftWeeks = Number(ex?.payload?.shiftWeeks);
        if (Number.isFinite(shiftWeeks) && shiftWeeks > 0) {
            return Math.max(1, Math.trunc(shiftWeeks)) * 7;
        }
        return intervalDays;
    }
    return 0;
}

/**
 * @param {string} startIso
 * @param {string} endIso
 * @param {string} untilYmd
 * @param {number} frequencyIntervalWeeks
 * @param {number | null | undefined} occurrenceLimit
 * @param {Array<{ occurrenceStartAt: string, exceptionKind: string, payload?: object }>} [seriesExceptions]
 * @returns {{ index: number, startIso: string, endIso: string, ymd: string }[]}
 */
export function enumerateWeeklySeriesOccurrences(
    startIso,
    endIso,
    untilYmd,
    frequencyIntervalWeeks = 1,
    occurrenceLimit = null,
    seriesExceptions = []
) {
    const firstStart = new Date(String(startIso || ''));
    const firstEnd = new Date(String(endIso || ''));
    const untilDate = parseDateYmdLocal(untilYmd);
    if (
        Number.isNaN(firstStart.getTime()) ||
        Number.isNaN(firstEnd.getTime()) ||
        firstEnd.getTime() <= firstStart.getTime() ||
        !untilDate
    ) {
        return [];
    }
    const intervalDays = Number(frequencyIntervalWeeks) === 2 ? 14 : 7;
    const exceptionMap = normalizeSeriesExceptions(seriesExceptions);
    const out = [];
    let curStart = new Date(firstStart);
    let curEnd = new Date(firstEnd);
    let index = 1;
    let safety = 0;
    const max = Number.isFinite(Number(occurrenceLimit)) && Number(occurrenceLimit) >= 1
        ? Math.trunc(Number(occurrenceLimit))
        : Number.POSITIVE_INFINITY;
    while (toYmdLocal(curStart) <= toYmdLocal(untilDate) && index <= max && safety < 2000) {
        safety += 1;
        const currentIso = curStart.toISOString();
        const advanceDays = exceptionAdvanceDays(exceptionMap.get(currentIso), intervalDays);
        if (advanceDays > 0) {
            curStart = addDays(curStart, advanceDays);
            curEnd = addDays(curEnd, advanceDays);
            continue;
        }
        out.push({
            index,
            startIso: currentIso,
            endIso: curEnd.toISOString(),
            ymd: toYmdLocal(curStart)
        });
        curStart = addDays(curStart, intervalDays);
        curEnd = addDays(curEnd, intervalDays);
        index += 1;
    }
    return out;
}

/**
 * @param {{
 *   seriesId: string,
 *   ownerUserId: string,
 *   ownerEmail: string,
 *   slotType: string,
 *   title: string,
 *   startIso: string,
 *   endIso: string,
 *   untilYmd: string,
 *   frequencyInterval?: number,
 *   occurrenceLimit?: number | null,
 *   seriesExceptions?: Array<{ occurrenceStartAt: string, exceptionKind: string, payload?: object }>,
 *   skipOccurrenceStartIsoSet?: Set<string>,
 *   isAllDay?: boolean
 * }} p
 */
export function buildPlanningEventRowsFromSeries(p) {
    const occurrences = enumerateWeeklySeriesOccurrences(
        p.startIso,
        p.endIso,
        p.untilYmd,
        p.frequencyInterval,
        p.occurrenceLimit,
        p.seriesExceptions
    );
    const skipSet = p.skipOccurrenceStartIsoSet instanceof Set ? p.skipOccurrenceStartIsoSet : new Set();
    return occurrences
        .filter((occ) => !skipSet.has(String(occ.startIso || '')))
        .map((occ) => ({
            startIso: occ.startIso,
            endIso: occ.endIso,
            title: String(p.title || '').trim() || 'Créneau',
            dbSlotType: String(p.slotType || '').trim(),
            ownerEmail: String(p.ownerEmail || '').trim().toLowerCase(),
            ownerUserId: String(p.ownerUserId || '').trim(),
            seriesId: String(p.seriesId || '').trim(),
            seriesPosition: occ.index,
            isAllDay: Boolean(p.isAllDay)
        }));
}
