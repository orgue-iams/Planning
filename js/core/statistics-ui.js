/**
 * Statistiques planning : agrégation client sur `planning_events_in_range`.
 */
import { fetchOrganSchoolSettings, getOrganSchoolSettingsCached } from './organ-settings.js';
import { fetchPlanningEventRowsInRange } from './planning-events-db.js';
import { isBackendAuthConfigured } from './auth-logic.js';

let bound = false;

const SLOT_LABELS = {
    cours: 'Cours',
    'travail perso': 'Travail personnel',
    fermeture: 'Fermeture',
    concert: 'Concert',
    autre: 'Autre'
};

function ymd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function parseYmd(s) {
    const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
}

function rowDurationHours(row) {
    const a = new Date(row.start_at).getTime();
    const b = new Date(row.end_at).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
    return (b - a) / 3600000;
}

function defaultRangeFromSettings() {
    const s = getOrganSchoolSettingsCached();
    const fromStr = s?.school_year_start ? String(s.school_year_start).slice(0, 10) : '';
    const toStr = s?.school_year_end ? String(s.school_year_end).slice(0, 10) : '';
    const from = /^\d{4}-\d{2}-\d{2}$/.test(fromStr) ? fromStr : ymd(new Date());
    let to = /^\d{4}-\d{2}-\d{2}$/.test(toStr) ? toStr : ymd(new Date());
    if (from > to) to = from;
    return { from, to };
}

async function loadStatsIntoDom() {
    const statusEl = document.getElementById('statistics-status');
    const tbody = document.getElementById('statistics-tbody');
    const footC = document.getElementById('statistics-foot-count');
    const footH = document.getElementById('statistics-foot-hours');
    if (!tbody || !footC || !footH) return;

    if (!isBackendAuthConfigured()) {
        if (statusEl) statusEl.textContent = 'Connectez-vous pour charger les statistiques.';
        tbody.innerHTML = '';
        footC.textContent = '—';
        footH.textContent = '—';
        return;
    }

    const fromIn = document.getElementById('statistics-date-from');
    const toIn = document.getElementById('statistics-date-to');
    const fromStr = fromIn instanceof HTMLInputElement ? fromIn.value : '';
    const toStr = toIn instanceof HTMLInputElement ? toIn.value : '';
    const d0 = parseYmd(fromStr);
    const d1 = parseYmd(toStr);
    if (!d0 || !d1 || d1 < d0) {
        if (statusEl) statusEl.textContent = 'Période invalide.';
        return;
    }
    if (statusEl) statusEl.textContent = 'Chargement…';

    const rangeStart = new Date(d0);
    rangeStart.setHours(0, 0, 0, 0);
    const rangeEnd = new Date(d1);
    rangeEnd.setHours(23, 59, 59, 999);

    const rows = await fetchPlanningEventRowsInRange(rangeStart, rangeEnd);
    /** @type {Record<string, { count: number, hours: number }>} */
    const by = {};
    let totalCount = 0;
    let totalHours = 0;
    for (const r of rows) {
        const key = String(r.slot_type || 'autre').trim() || 'autre';
        const h = rowDurationHours(r);
        if (!by[key]) by[key] = { count: 0, hours: 0 };
        by[key].count += 1;
        by[key].hours += h;
        totalCount += 1;
        totalHours += h;
    }

    const keys = Object.keys(by).sort((a, b) => {
        const la = SLOT_LABELS[a] || a;
        const lb = SLOT_LABELS[b] || b;
        return la.localeCompare(lb, 'fr');
    });

    tbody.innerHTML = keys
        .map((k) => {
            const lab = SLOT_LABELS[k] || k;
            const { count, hours } = by[k];
            return `<tr class="border-t border-slate-100"><td class="p-2">${lab}</td><td class="p-2 text-right font-mono">${count}</td><td class="p-2 text-right font-mono">${hours.toFixed(1)}</td></tr>`;
        })
        .join('');

    footC.textContent = String(totalCount);
    footH.textContent = totalHours.toFixed(1);
    if (statusEl) {
        statusEl.textContent = rows.length
            ? `${rows.length} créneau(x) sur la période.`
            : 'Aucun créneau sur cette période.';
    }
}

function applyDefaultDatesToInputs() {
    const { from, to } = defaultRangeFromSettings();
    const fromIn = document.getElementById('statistics-date-from');
    const toIn = document.getElementById('statistics-date-to');
    if (fromIn instanceof HTMLInputElement) fromIn.value = from;
    if (toIn instanceof HTMLInputElement) toIn.value = to;
}

export function initStatisticsUi() {
    if (bound) return;
    bound = true;

    document.getElementById('menu-item-statistics')?.addEventListener('click', (ev) => {
        ev.preventDefault();
        document.getElementById('btn-header-agenda-menu')?.blur();
        document.getElementById('modal_statistics')?.showModal();
    });
    document.getElementById('statistics-close-btn')?.addEventListener('click', () => {
        document.getElementById('modal_statistics')?.close();
    });

    const dlg = document.getElementById('modal_statistics');
    dlg?.addEventListener('show', () => {
        void (async () => {
            await fetchOrganSchoolSettings();
            applyDefaultDatesToInputs();
            await loadStatsIntoDom();
        })();
    });

    document.getElementById('statistics-apply-range')?.addEventListener('click', () => {
        void loadStatsIntoDom();
    });
    document.getElementById('statistics-school-year-btn')?.addEventListener('click', () => {
        void (async () => {
            await fetchOrganSchoolSettings();
            applyDefaultDatesToInputs();
            await loadStatsIntoDom();
        })();
    });
}

export function resetStatisticsUiBindings() {
    bound = false;
}
