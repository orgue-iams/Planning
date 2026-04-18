/**
 * Statistiques : RPC SQL agrégées (prof / admin). Élèves : pas d’entrée menu (menu Agenda déjà réservé au staff).
 */
import { getSupabaseClient, isBackendAuthConfigured } from './supabase-client.js';
import { isPrivilegedUser } from './auth-logic.js';
import { getPlanningSessionUser } from './session-user.js';
import { fetchOrganSchoolSettings, getOrganSchoolSettingsCached } from './organ-settings.js';
import { fetchPlanningListElevesActifs } from './planning-events-db.js';

let bound = false;
/** Réinitialiser la sélection graphique à l’ouverture de la modale. */
let chartSelectFresh = true;

/** @type {Map<string, string>} */
let lastEleveLabelsById = new Map();

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

/** @param {HTMLSelectElement} sel */
function getSelectedChartStudentIds(sel) {
    return [...sel.selectedOptions].map((o) => String(o.value).trim()).filter(Boolean);
}

function eleveDisplayName(r) {
    const p = String(r?.prenom || '').trim();
    const n = String(r?.nom || '').trim();
    const t = `${p} ${n}`.trim();
    if (t) return t;
    return String(r?.display_name || r?.email || r?.user_id || '').trim() || String(r?.user_id || '');
}

/**
 * @param {object[]} rows
 * @param {boolean} resetSelection
 */
function populateChartElevesSelect(rows, resetSelection) {
    const sel = document.getElementById('statistics-chart-eleves');
    if (!(sel instanceof HTMLSelectElement)) return;
    const prev = resetSelection ? new Set() : new Set(getSelectedChartStudentIds(sel));
    sel.innerHTML = '';
    for (const r of rows) {
        const id = String(r.user_id || '').trim();
        if (!id) continue;
        const opt = new Option(eleveDisplayName(r), id);
        sel.add(opt);
    }
    for (let i = 0; i < sel.options.length; i++) {
        const o = sel.options[i];
        if (resetSelection) {
            o.selected = i < Math.min(4, sel.options.length);
        } else {
            o.selected = prev.has(o.value);
        }
    }
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
    const stepX = n > 1 ? innerW / (n - 1) : innerW / 2;
    const hues = [217, 142, 28, 280, 12, 185, 300, 55, 330, 95];

    studentOrder.forEach((sid, idx) => {
        const arr = seriesByStudentId.get(sid) || [];
        ctx.strokeStyle = `hsl(${hues[idx % hues.length]} 62% 46%)`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const x = padL + (n > 1 ? i * stepX : innerW / 2);
            const val = arr[i] || 0;
            const y = padT + innerH - (val / maxH) * innerH;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    });

    ctx.fillStyle = '#64748b';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const tickEvery = n > 20 ? Math.ceil(n / 10) : n > 12 ? 2 : 1;
    for (let i = 0; i < n; i += tickEvery) {
        const x = padL + (n > 1 ? i * stepX : innerW / 2);
        const label = days[i].slice(5);
        ctx.fillText(label, x, cssH - 12);
    }

    ctx.textAlign = 'left';
    let lx = padL;
    let ly = 12;
    studentOrder.forEach((sid, idx) => {
        const raw = labelsById.get(sid) || sid;
        const name = raw.length > 22 ? `${raw.slice(0, 20)}…` : raw;
        const w = 18 + ctx.measureText(name).width + 10;
        if (lx + w > cssW - padR) {
            lx = padL;
            ly += 14;
        }
        ctx.fillStyle = `hsl(${hues[idx % hues.length]} 62% 36%)`;
        ctx.fillRect(lx, ly - 7, 10, 4);
        ctx.fillStyle = '#334155';
        ctx.fillText(name, lx + 14, ly + 1);
        lx += w;
    });
}

async function loadChartSeries(rangeStart, rangeEnd, fromYmd, toYmd) {
    const sel = document.getElementById('statistics-chart-eleves');
    if (!(sel instanceof HTMLSelectElement)) return;
    const ids = getSelectedChartStudentIds(sel);
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
    const elBody = document.getElementById('statistics-eleves-tbody');
    const footC = document.getElementById('statistics-eleves-foot-count');
    const footH = document.getElementById('statistics-eleves-foot-hours');
    if (!orgBody || !elBody || !footC || !footH) return;

    const user = getPlanningSessionUser();
    if (!isBackendAuthConfigured() || !isPrivilegedUser(user)) {
        if (statusEl) statusEl.textContent = 'Statistiques réservées aux professeurs et administrateurs.';
        orgBody.innerHTML = '';
        elBody.innerHTML = '';
        footC.textContent = '—';
        footH.textContent = '—';
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

    const elevesRows = await fetchPlanningListElevesActifs();
    lastEleveLabelsById = new Map(
        elevesRows.map((r) => {
            const id = String(r.user_id || '').trim();
            return [id, eleveDisplayName(r)];
        })
    );
    populateChartElevesSelect(elevesRows, chartSelectFresh);
    chartSelectFresh = false;

    const [orgRes, totRes] = await Promise.all([
        sb.rpc('planning_stats_org_occupation', { p_start: rs, p_end: re }),
        sb.rpc('planning_stats_eleve_travail_totals', { p_start: rs, p_end: re })
    ]);

    if (orgRes.error) {
        if (statusEl) statusEl.textContent = orgRes.error.message || 'Erreur occupation.';
        orgBody.innerHTML = '';
        elBody.innerHTML = '';
        footC.textContent = '—';
        footH.textContent = '—';
        return;
    }
    if (totRes.error) {
        if (statusEl) statusEl.textContent = totRes.error.message || 'Erreur élèves.';
        orgBody.innerHTML = '';
        elBody.innerHTML = '';
        footC.textContent = '—';
        footH.textContent = '—';
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
    let sumC = 0;
    let sumH = 0;
    elBody.innerHTML = totRows.length
        ? totRows
              .map((r) => {
                  const c = Number(r.slot_count) || 0;
                  const h = numHours(r.hours);
                  sumC += c;
                  sumH += h;
                  const name = String(r.display_name || '').trim() || String(r.student_user_id || '');
                  return `<tr class="border-t border-slate-100"><td class="p-2">${name}</td><td class="p-2 text-right font-mono">${c}</td><td class="p-2 text-right font-mono">${h.toFixed(1)}</td></tr>`;
              })
              .join('')
        : '<tr><td colspan="3" class="p-2 text-slate-500">Aucun élève actif.</td></tr>';

    footC.textContent = String(sumC);
    footH.textContent = sumH.toFixed(1);

    if (statusEl) {
        statusEl.textContent = `Période du ${fromStr} au ${toStr} — ${totRows.length} élève(s) actif(s) listé(s).`;
    }

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
        document.getElementById('btn-header-agenda-menu')?.blur();
        document.getElementById('modal_statistics')?.showModal();
    });
    document.getElementById('statistics-close-btn')?.addEventListener('click', () => {
        document.getElementById('modal_statistics')?.close();
    });

    const dlg = document.getElementById('modal_statistics');
    dlg?.addEventListener('show', () => {
        chartSelectFresh = true;
        void (async () => {
            await fetchOrganSchoolSettings();
            applyDefaultDatesToInputs();
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

    document.getElementById('statistics-chart-eleves')?.addEventListener('change', bindRange);

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
}
