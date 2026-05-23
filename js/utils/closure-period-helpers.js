/**
 * Helpers fermetures / périodes (dates, jours de semaine, libellés).
 */

/** @param {string} startYmd @param {string} endYmd */
function enumerateYmdInRange(startYmd, endYmd) {
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

/** @type {{ iso: number, label: string, short: string }[]} */
export const CLOSURE_WEEKDAY_OPTIONS = [
    { iso: 1, label: 'Lundi', short: 'lun.' },
    { iso: 2, label: 'Mardi', short: 'mar.' },
    { iso: 3, label: 'Mercredi', short: 'mer.' },
    { iso: 4, label: 'Jeudi', short: 'jeu.' },
    { iso: 5, label: 'Vendredi', short: 'ven.' },
    { iso: 6, label: 'Samedi', short: 'sam.' },
    { iso: 7, label: 'Dimanche', short: 'dim.' }
];

const WEEKDAY_BY_ISO = new Map(CLOSURE_WEEKDAY_OPTIONS.map((o) => [o.iso, o]));

/** @param {unknown} raw */
export function normalizeWeekdays(raw) {
    if (!Array.isArray(raw)) return [];
    const set = new Set();
    for (const x of raw) {
        const n = parseInt(String(x), 10);
        if (n >= 1 && n <= 7) set.add(n);
    }
    return [...set].sort((a, b) => a - b);
}

/** @param {Date} d */
export function isoWeekdayFromDate(d) {
    const js = d.getDay();
    return js === 0 ? 7 : js;
}

/**
 * @param {number[]} weekdays ISO 1–7
 * @param {string} fromYmd
 * @param {string} toYmd
 * @param {Set<string>} [excluded]
 */
export function enumerateWeekdayYmdInRange(weekdays, fromYmd, toYmd, excluded = new Set()) {
    const wanted = new Set(normalizeWeekdays(weekdays));
    if (!wanted.size) return [];
    const out = [];
    for (const ymd of enumerateYmdInRange(fromYmd, toYmd)) {
        if (excluded.has(ymd)) continue;
        const d = new Date(`${ymd}T12:00:00`);
        if (wanted.has(isoWeekdayFromDate(d))) out.push(ymd);
    }
    return out;
}

/**
 * @param {number[]} weekdays
 * @returns {string}
 */
export function formatPeriodicClosureLabel(weekdays) {
    const list = normalizeWeekdays(weekdays);
    if (!list.length) return 'Périodique';
    if (list.length === 1) {
        const w = WEEKDAY_BY_ISO.get(list[0]);
        return w ? `Tous les ${w.label.toLowerCase()}s` : 'Périodique';
    }
    const names = list.map((n) => WEEKDAY_BY_ISO.get(n)?.label?.toLowerCase() || '?');
    if (names.length === 2) return `Tous les ${names[0]}s et ${names[1]}s`;
    return `Tous les ${names.slice(0, -1).join('s,\n')}s et ${names[names.length - 1]}s`;
}

/** @param {string} t HH:MM ou HH:MM:SS */
export function normalizeClosureTime(t) {
    const s = String(t || '').trim();
    const m = s.match(/^(\d{1,2}):(\d{2})/);
    if (!m) return '';
    const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
    const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * @param {string} ymd
 * @param {string} startHhmm
 * @param {string} endHhmm
 */
export function slotBoundsIsoFromYmdAndTimes(ymd, startHhmm, endHhmm) {
    const d = String(ymd).slice(0, 10);
    const st = normalizeClosureTime(startHhmm) || '08:00';
    const en = normalizeClosureTime(endHhmm) || '22:00';
    return {
        startIso: new Date(`${d}T${st}:00`).toISOString(),
        endIso: new Date(`${d}T${en}:00`).toISOString()
    };
}

/** @param {import('../core/organ-settings.js').*} bounds */
export function buildHalfHourTimeChoices(slotMinTime, slotMaxTime) {
    const min = normalizeClosureTime(String(slotMinTime || '08:00:00').slice(0, 8)) || '08:00';
    const max = normalizeClosureTime(String(slotMaxTime || '22:00:00').slice(0, 8)) || '22:00';
    const [mh, mm] = min.split(':').map((x) => parseInt(x, 10));
    const [xh, xm] = max.split(':').map((x) => parseInt(x, 10));
    let cur = mh * 60 + mm;
    const end = xh * 60 + xm;
    const out = [];
    while (cur < end) {
        const h = Math.floor(cur / 60);
        const m = cur % 60;
        out.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
        cur += 30;
    }
    return out;
}

/**
 * @param {HTMLSelectElement} sel
 * @param {string[]} choices
 * @param {string} [preferred]
 */
export function fillTimeSelect(sel, choices, preferred) {
    if (!(sel instanceof HTMLSelectElement)) return;
    sel.replaceChildren();
    for (const c of choices) {
        const o = document.createElement('option');
        o.value = c;
        o.textContent = c;
        sel.appendChild(o);
    }
    if (preferred && choices.includes(preferred)) sel.value = preferred;
    else if (choices.length) sel.value = choices[0];
}

/** @param {unknown} raw */
export function normalizeExcludedYmds(raw) {
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map((x) => String(x || '').slice(0, 10)).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)))];
}

/** @param {unknown} raw */
export function normalizeDayOverrides(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((row) => {
            const ymd = String(row?.ymd || '').slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
            return {
                ymd,
                slot_start_time: normalizeClosureTime(row.slot_start_time || row.start_time),
                slot_end_time: normalizeClosureTime(row.slot_end_time || row.end_time),
                title: String(row.title || '').trim() || undefined
            };
        })
        .filter(Boolean);
}

export const CLOSURE_PERIODIC_ICON_SVG =
    '<svg class="fermeture-card__periodic-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.75" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>';
