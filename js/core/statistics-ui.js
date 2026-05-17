/**
 * Statistiques : RPC SQL agrégées (prof / admin). Élèves : pas d’entrée menu (menu Agenda déjà réservé au staff).
 */
import { getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';
import { isPrivilegedUser } from './auth-logic.js';
import { getPlanningSessionUser } from './session-user.js';
import { fetchOrganSchoolSettings, getOrganSchoolSettingsCached } from './organ-settings.js';
import { openPlanningRouteFromDrawer } from '../utils/planning-route-dialog.js';

let bound = false;
/** Réinitialiser la sélection graphique à l’ouverture de la modale. */
let chartSelectFresh = true;

/** @type {Map<string, string>} */
let lastEleveLabelsById = new Map();

/** @type {Set<string>} */
let chartSelectedStudentIds = new Set();

/** @type {Map<string, number>} id élève → teinte HSL (graphique + cartes) */
let chartHueByStudentId = new Map();

const CHART_HUES = [217, 142, 28, 280, 12, 185, 300, 55, 330, 95];

const ORG_LABELS = {
    cours: 'Cours',
    travail_perso_eleves: 'Travail perso (élèves)',
    concert: 'Concerts',
    total_occupation: 'Total occupation orgue'
};

let chartRedrawTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);

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

function defaultRangeFromSettings() {
    const s = getOrganSchoolSettingsCached();
    const fromStr = s?.school_year_start ? String(s.school_year_start).slice(0, 10) : '';
    const toStr = s?.school_year_end ? String(s.school_year_end).slice(0, 10) : '';
    const from = /^\d{4}-\d{2}-\d{2}$/.test(fromStr) ? fromStr : ymd(new Date());
    let to = /^\d{4}-\d{2}-\d{2}$/.test(toStr) ? toStr : ymd(new Date());
    if (from > to) to = from;
    return { from, to };
}

/** Mois civil en cours (local), du 1er au dernier jour. */
function defaultCurrentMonthYmdRange() {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { from: ymd(from), to: ymd(to) };
}

function applyDefaultMonthRangeToInputs() {
    const { from, to } = defaultCurrentMonthYmdRange();
    const fromIn = document.getElementById('statistics-date-from');
    const toIn = document.getElementById('statistics-date-to');
    if (fromIn instanceof HTMLInputElement) fromIn.value = from;
    if (toIn instanceof HTMLInputElement) toIn.value = to;
}

/** @param {string} fromYmd @param {string} toYmd */
function enumerateDaysInclusive(fromYmd, toYmd) {
    const d0 = parseYmd(fromYmd);
    const d1 = parseYmd(toYmd);
    if (!d0 || !d1 || d1 < d0) return [];
    const out = [];
    const cur = new Date(d0);
    const end = new Date(d1);
    while (cur <= end) {
        out.push(ymd(cur));
        cur.setDate(cur.getDate() + 1);
    }
    return out;
}

/** @param {unknown} v */
function numHours(v) {
    if (v == null) return 0;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const n = parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
}

function getSelectedChartStudentIds() {
    const ids = [];
    for (const el of document.querySelectorAll(
        '#statistics-eleves-list .statistics-eleve-card--selected'
    )) {
        const id = el.getAttribute('data-user-id')?.trim();
        if (id) ids.push(id);
    }
    return ids;
}

/** @param {number} n */
function formatFrDecimal(n, digits = 2) {
    return Number(n).toLocaleString('fr-FR', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
    });
}

/**
 * @param {object[]} totRows
 * @param {boolean} resetSelection
 */
function renderStatisticsEleveCards(totRows, resetSelection) {
    const list = document.getElementById('statistics-eleves-list');
    const totalsEl = document.getElementById('statistics-eleves-totals');
    if (!list) return;

    chartHueByStudentId = new Map();
    const orderIds = totRows.map((r) => String(r.student_user_id || '').trim()).filter(Boolean);
    orderIds.forEach((id, i) => chartHueByStudentId.set(id, CHART_HUES[i % CHART_HUES.length]));

    if (resetSelection) {
        chartSelectedStudentIds = new Set(orderIds.slice(0, Math.min(4, orderIds.length)));
    } else {
        const next = new Set();
        for (const id of chartSelectedStudentIds) {
            if (orderIds.includes(id)) next.add(id);
        }
        chartSelectedStudentIds = next.size ? next : new Set(orderIds.slice(0, Math.min(4, orderIds.length)));
    }

    let sumC = 0;
    let sumH = 0;
    list.innerHTML = '';

    if (!totRows.length) {
        list.innerHTML =
            '<p class="text-[11px] text-slate-500 p-2 m-0">Aucun élève actif.</p>';
        if (totalsEl) totalsEl.textContent = '';
        return;
    }

    for (const r of totRows) {
        const id = String(r.student_user_id || '').trim();
        if (!id) continue;
        const c = Number(r.slot_count) || 0;
        const h = numHours(r.hours);
        const hpw = numHours(r.hours_per_week);
        sumC += c;
        sumH += h;
        const name = String(r.display_name || '').trim() || id;
        const hue = chartHueByStudentId.get(id) ?? CHART_HUES[0];
        const selected = chartSelectedStudentIds.has(id);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `statistics-eleve-card${selected ? ' statistics-eleve-card--selected' : ''}`;
        btn.dataset.userId = id;
        btn.style.setProperty('--stat-hue', String(hue));
        const sat = selected ? 52 : 22;
        const light = selected ? 86 : 95;
        btn.style.background = `hsl(${hue} ${sat}% ${light}%)`;
        btn.innerHTML = `
            <span class="statistics-eleve-card__name">${escapeHtml(name)}</span>
            <span class="statistics-eleve-card__metric">${c} créneau${c > 1 ? 'x' : ''}</span>
            <span class="statistics-eleve-card__metric">${formatFrDecimal(h, 1)} h total</span>
            <span class="statistics-eleve-card__metric">${formatFrDecimal(hpw, 2)} h/sem</span>
        `;
        list.appendChild(btn);
    }

    if (totalsEl) {
        totalsEl.textContent = `Total — ${sumC} créneaux, ${formatFrDecimal(sumH, 1)} h`;
    }
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function toggleStatisticsEleveCard(btn) {
    if (!(btn instanceof HTMLButtonElement)) return;
    const id = btn.dataset.userId?.trim();
    if (!id) return;
    const selected = btn.classList.toggle('statistics-eleve-card--selected');
    if (selected) chartSelectedStudentIds.add(id);
    else chartSelectedStudentIds.delete(id);
    const hue = chartHueByStudentId.get(id) ?? CHART_HUES[0];
    const sat = selected ? 52 : 22;
    const light = selected ? 86 : 95;
    btn.style.background = `hsl(${hue} ${sat}% ${light}%)`;
}

/**
 * @param {{
 *   days: string[],
 *   studentOrder: string[],
 *   seriesByStudentId: Map<string, number[]>,
 *   labelsById: Map<string, string>
 * }} p
 */
function drawStatisticsChart(p) {
    const canvas = document.getElementById('statistics-chart-canvas');
    const wrap = document.getElementById('statistics-chart-wrap');
    if (!(canvas instanceof HTMLCanvasElement) || !wrap) return;

    const { days, studentOrder, seriesByStudentId, labelsById } = p;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(320, wrap.clientWidth || 800);
    const cssH = 240;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    if (!studentOrder.length || !days.length) {
        ctx.fillStyle = '#64748b';
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillText(
            studentOrder.length ? 'Aucune donnée sur cette période.' : 'Sélectionnez au moins un élève.',
            14,
            cssH / 2
        );
        return;
    }

    const padL = 48;
    const padR = 10;
    const padT = 22;
    const padB = 40;
    const innerW = cssW - padL - padR;
    const innerH = cssH - padT - padB;

    let maxH = 0.5;
    for (const sid of studentOrder) {
        for (const v of seriesByStudentId.get(sid) || []) {
            maxH = Math.max(maxH, v);
        }
    }
    maxH = Math.max(0.5, Math.ceil(maxH * 10) / 10);

    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + innerH);
    ctx.lineTo(padL + innerW, padT + innerH);
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
        const v = (maxH * i) / 4;
        const y = padT + innerH - (v / maxH) * innerH;
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(`${v.toFixed(1)} h`, padL - 6, y + 3);
        ctx.beginPath();
        ctx.strokeStyle = '#f1f5f9';
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + innerW, y);
        ctx.stroke();
    }

    const n = days.length;

    const groupW = n > 0 ? innerW / n : innerW;
    const nb = Math.max(1, studentOrder.length);
    const innerPad = Math.min(10, groupW * 0.08);
    const usable = Math.max(groupW - innerPad, 1);
    const barW = Math.min(16, usable / (nb + (nb > 1 ? 0.35 * (nb - 1) : 0)));
    const gapBars = nb > 1 ? Math.max(0, (usable - barW * nb) / Math.max(nb - 1, 1)) : 0;

    for (let i = 0; i < n; i++) {
        const gx = padL + i * groupW + innerPad / 2;
        studentOrder.forEach((sid, j) => {
            const arr = seriesByStudentId.get(sid) || [];
            const val = arr[i] || 0;
            const bh = (val / maxH) * innerH;
            const x = gx + j * (barW + gapBars);
            const y = padT + innerH - bh;
            const hue = chartHueByStudentId.get(sid) ?? CHART_HUES[j % CHART_HUES.length];
            ctx.fillStyle = `hsl(${hue} 62% 48%)`;
            ctx.fillRect(x, y, Math.max(1.2, barW - 0.5), Math.max(0, bh));
        });
    }

    ctx.fillStyle = '#64748b';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const tickEvery = n > 20 ? Math.ceil(n / 10) : n > 12 ? 2 : 1;
    const groupWTick = n > 0 ? innerW / n : innerW;
    for (let i = 0; i < n; i += tickEvery) {
        const x = padL + i * groupWTick + groupWTick / 2;
        const label = days[i].slice(5);
        ctx.fillText(label, x, cssH - 12);
    }
}

async function loadChartSeries(rangeStart, rangeEnd, fromYmd, toYmd) {
    const ids = getSelectedChartStudentIds();
    const days = enumerateDaysInclusive(fromYmd, toYmd);
    const labelsById = new Map(lastEleveLabelsById);

    if (!ids.length || !isBackendAuthConfigured()) {
        drawStatisticsChart({
            days,
            studentOrder: [],
            seriesByStudentId: new Map(),
            labelsById
        });
        return;
    }

    const sb = getSupabaseClient();
    if (!sb) return;
    const { data, error } = await sb.rpc('planning_stats_eleve_travail_daily', {
        p_start: rangeStart.toISOString(),
        p_end: rangeEnd.toISOString(),
        p_student_ids: ids
    });
    if (error) {
        console.warn('[statistics-ui] planning_stats_eleve_travail_daily', error.message);
        drawStatisticsChart({
            days,
            studentOrder: ids,
            seriesByStudentId: new Map(ids.map((id) => [id, days.map(() => 0)])),
            labelsById
        });
        return;
    }

    const dayIndex = new Map(days.map((d, i) => [d, i]));
    /** @type {Map<string, number[]>} */
    const seriesByStudentId = new Map();
    for (const id of ids) {
        seriesByStudentId.set(id, new Array(days.length).fill(0));
    }
    const rows = Array.isArray(data) ? data : [];
    for (const r of rows) {
        const dayStr = String(r.day || '').slice(0, 10);
        const sid = String(r.student_user_id || '').trim();
        const di = dayIndex.get(dayStr);
        if (di === undefined || !seriesByStudentId.has(sid)) continue;
        const arr = seriesByStudentId.get(sid);
        if (arr) arr[di] = numHours(r.hours);
    }

    drawStatisticsChart({
        days,
        studentOrder: ids,
        seriesByStudentId,
        labelsById
    });
}

function scheduleChartRedraw(rangeStart, rangeEnd, fromYmd, toYmd) {
    if (chartRedrawTimer) clearTimeout(chartRedrawTimer);
    chartRedrawTimer = setTimeout(() => {
        void loadChartSeries(rangeStart, rangeEnd, fromYmd, toYmd);
    }, 200);
}

async function loadStatsIntoDom() {
    const statusEl = document.getElementById('statistics-status');
    const orgBody = document.getElementById('statistics-org-tbody');
    const elList = document.getElementById('statistics-eleves-list');
    if (!orgBody || !elList) return;

    const user = getPlanningSessionUser();
    if (!isBackendAuthConfigured() || !isPrivilegedUser(user)) {
        if (statusEl) statusEl.textContent = 'Statistiques réservées aux professeurs et administrateurs.';
        orgBody.innerHTML = '';
        elList.innerHTML = '';
        const totalsEl = document.getElementById('statistics-eleves-totals');
        if (totalsEl) totalsEl.textContent = '';
        drawStatisticsChart({
            days: [],
            studentOrder: [],
            seriesByStudentId: new Map(),
            labelsById: new Map()
        });
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
    const rs = rangeStart.toISOString();
    const re = rangeEnd.toISOString();

    const sb = getSupabaseClient();
    if (!sb) {
        if (statusEl) statusEl.textContent = 'Session indisponible.';
        return;
    }

    const [orgRes, totRes] = await Promise.all([
        sb.rpc('planning_stats_org_occupation', { p_start: rs, p_end: re }),
        sb.rpc('planning_stats_eleve_travail_totals', { p_start: rs, p_end: re })
    ]);

    if (orgRes.error) {
        if (statusEl) statusEl.textContent = orgRes.error.message || 'Erreur occupation.';
        orgBody.innerHTML = '';
        elList.innerHTML = '';
        return;
    }
    if (totRes.error) {
        if (statusEl) statusEl.textContent = totRes.error.message || 'Erreur élèves.';
        orgBody.innerHTML = '';
        elList.innerHTML = '';
        return;
    }

    const orgRows = Array.isArray(orgRes.data) ? orgRes.data : [];
    orgBody.innerHTML = orgRows.length
        ? orgRows
              .map((r) => {
                  const key = String(r.category || '').trim();
                  const lab = ORG_LABELS[key] || key;
                  const c = r.slot_count != null ? String(r.slot_count) : '0';
                  const h = numHours(r.hours).toFixed(1);
                  return `<tr class="border-t border-slate-100"><td class="p-2">${lab}</td><td class="p-2 text-right font-mono">${c}</td><td class="p-2 text-right font-mono">${h}</td></tr>`;
              })
              .join('')
        : '<tr><td colspan="3" class="p-2 text-slate-500">Aucune donnée.</td></tr>';

    const totRows = Array.isArray(totRes.data) ? totRes.data : [];

    if (statusEl) {
        statusEl.textContent = `Période du ${fromStr} au ${toStr} — ${totRows.length} élève(s) actif(s) listé(s).`;
    }

    lastEleveLabelsById = new Map(
        totRows.map((r) => {
            const id = String(r.student_user_id || '').trim();
            return [id, String(r.display_name || '').trim() || id];
        })
    );
    renderStatisticsEleveCards(totRows, chartSelectFresh);
    chartSelectFresh = false;

    await loadChartSeries(rangeStart, rangeEnd, fromStr, toStr);
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
        openPlanningRouteFromDrawer('modal_statistics', 'Statistiques', 'Menu');
    });

    const dlg = document.getElementById('modal_statistics');
    dlg?.addEventListener('toggle', () => {
        if (!(dlg instanceof HTMLDialogElement) || !dlg.open) return;
        chartSelectFresh = true;
        void (async () => {
            await fetchOrganSchoolSettings();
            applyDefaultMonthRangeToInputs();
            await loadStatsIntoDom();
        })();
    });

    const bindRange = () => {
        const fromIn = document.getElementById('statistics-date-from');
        const toIn = document.getElementById('statistics-date-to');
        const fromStr = fromIn instanceof HTMLInputElement ? fromIn.value : '';
        const toStr = toIn instanceof HTMLInputElement ? toIn.value : '';
        const d0 = parseYmd(fromStr);
        const d1 = parseYmd(toStr);
        if (!d0 || !d1 || d1 < d0) return;
        const rangeStart = new Date(d0);
        rangeStart.setHours(0, 0, 0, 0);
        const rangeEnd = new Date(d1);
        rangeEnd.setHours(23, 59, 59, 999);
        scheduleChartRedraw(rangeStart, rangeEnd, fromStr, toStr);
    };

    document.getElementById('statistics-eleves-list')?.addEventListener('click', (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('.statistics-eleve-card') : null;
        if (!(btn instanceof HTMLButtonElement)) return;
        toggleStatisticsEleveCard(btn);
        bindRange();
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

    window.addEventListener('resize', () => {
        const fromIn = document.getElementById('statistics-date-from');
        const toIn = document.getElementById('statistics-date-to');
        const dlgOpen = document.getElementById('modal_statistics');
        if (!(dlgOpen instanceof HTMLDialogElement) || !dlgOpen.open) return;
        const fromStr = fromIn instanceof HTMLInputElement ? fromIn.value : '';
        const toStr = toIn instanceof HTMLInputElement ? toIn.value : '';
        const d0 = parseYmd(fromStr);
        const d1 = parseYmd(toStr);
        if (!d0 || !d1) return;
        const rangeStart = new Date(d0);
        rangeStart.setHours(0, 0, 0, 0);
        const rangeEnd = new Date(d1);
        rangeEnd.setHours(23, 59, 59, 999);
        scheduleChartRedraw(rangeStart, rangeEnd, fromStr, toStr);
    });
}

export function resetStatisticsUiBindings() {
    bound = false;
    chartSelectFresh = true;
    chartSelectedStudentIds = new Set();
    chartHueByStudentId = new Map();
}
