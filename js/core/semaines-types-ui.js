/**
 * Semaines types A/B : gabarit (prof), analyse / application Google.
 */
import { isAdmin, isPrivilegedUser } from './auth-logic.js';
import { getPlanningSessionUser } from './session-user.js';
import { getSupabaseClient, isBackendAuthConfigured, getPlanningConfig } from './supabase-client.js';
import { showToast } from '../utils/toast.js';
import { populateTimeSelectElement } from '../utils/time-helpers.js';
import {
    fetchOrganSchoolSettings,
    getOrganSchoolSettingsCached,
    invalidateOrganSchoolSettingsCache
} from './organ-settings.js';
import {
    analyzeTemplateApply,
    executeTemplateApply,
    formatTemplateApplyPartialSummary
} from './template-apply-engine.js';
import { saveProfWeekCycleFromApply } from './week-cycle.js';

const DOW_OPTS = [
    { v: 1, t: 'Lun' },
    { v: 2, t: 'Mar' },
    { v: 3, t: 'Mer' },
    { v: 4, t: 'Jeu' },
    { v: 5, t: 'Ven' },
    { v: 6, t: 'Sam' },
    { v: 7, t: 'Dim' }
];

const USERS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>`;

const ST_DRAG_GRIP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>`;

const ST_ANALYZE_PLACEHOLDER_HTML =
    'Cliquez sur <strong>1. Préparer l’application</strong> : le résumé (bilan, conflits) s’affiche dans cet encadré. Ensuite activez <strong>2. Appliquer sur Google Agenda</strong> (à droite du bouton 1).';

function stAnalyzeSetLoadingMessage() {
    const ph = document.getElementById('st-analyze-placeholder');
    const out = document.getElementById('st-analyze-out');
    if (out) {
        out.textContent = '';
        out.style.display = 'none';
        out.classList.remove('text-red-700', 'font-bold');
    }
    if (ph) {
        ph.textContent = 'Préparation en cours…';
        ph.style.display = 'block';
    }
}

function stAnalyzeShowResult(text) {
    const ph = document.getElementById('st-analyze-placeholder');
    const out = document.getElementById('st-analyze-out');
    if (ph) ph.style.display = 'none';
    if (out) {
        out.classList.remove('text-red-700', 'font-bold');
        out.textContent = text;
        out.style.display = 'block';
    }
}

/** Affiche l’échec dans l’encadré (visible même si le toast est raté). */
function stAnalyzeShowError(title, detail) {
    const ph = document.getElementById('st-analyze-placeholder');
    const out = document.getElementById('st-analyze-out');
    if (ph) ph.style.display = 'none';
    if (out) {
        out.classList.add('text-red-700', 'font-bold');
        out.textContent = [title, '', detail].filter(Boolean).join('\n');
        out.style.display = 'block';
    }
}

function setStApplyButtonReady(ready) {
    const btn = document.getElementById('st-btn-apply');
    const hint = document.getElementById('st-btn-apply-hint');
    if (!btn) return;
    if (ready) {
        btn.removeAttribute('disabled');
        btn.disabled = false;
        requestAnimationFrame(() => {
            btn.removeAttribute('disabled');
            btn.disabled = false;
        });
        btn.classList.remove('btn-disabled', 'opacity-50', 'pointer-events-none');
        btn.removeAttribute('title');
        if (hint) {
            hint.innerHTML =
                'Le bouton <strong>2</strong> est actif : vous pouvez écrire dans Google Agenda (vérifiez le résumé dans l’encadré ci-dessous avant de confirmer).';
        }
    } else {
        btn.setAttribute('disabled', 'disabled');
        btn.disabled = true;
        btn.classList.add('btn-disabled', 'opacity-50', 'pointer-events-none');
        btn.setAttribute('title', 'Terminez d’abord l’étape 1 (Préparer l’application).');
        if (hint) {
            hint.innerHTML =
                'Le bouton <strong>2</strong> reste inactif tant que la préparation n’a pas réussi ; le résumé s’affiche dans l’encadré ci-dessous.';
        }
    }
}

function setStGotoCalBusy(busy) {
    const btn = document.getElementById('st-goto-cal');
    if (!btn) return;
    if (busy) {
        btn.setAttribute('disabled', 'disabled');
        btn.disabled = true;
        btn.classList.add('btn-disabled', 'opacity-50', 'pointer-events-none');
    } else {
        btn.removeAttribute('disabled');
        btn.disabled = false;
        btn.classList.remove('btn-disabled', 'opacity-50', 'pointer-events-none');
    }
}

/** Grise et désactive les actions gabarit / préparation / application / fermer pendant une opération réseau. */
function setStModalActionsBusy(busy) {
    const save = document.getElementById('st-save-gabarit');
    const analyze = document.getElementById('st-btn-analyze');
    const apply = document.getElementById('st-btn-apply');
    for (const btn of [save, analyze]) {
        if (!btn) continue;
        if (busy) {
            btn.setAttribute('disabled', 'disabled');
            btn.disabled = true;
            btn.classList.add('btn-disabled', 'opacity-50', 'pointer-events-none');
        } else {
            btn.removeAttribute('disabled');
            btn.disabled = false;
            btn.classList.remove('btn-disabled', 'opacity-50', 'pointer-events-none');
        }
    }
    setStGotoCalBusy(busy);
    if (apply) {
        if (busy) {
            apply.setAttribute('disabled', 'disabled');
            apply.disabled = true;
            apply.classList.add('btn-disabled', 'opacity-50', 'pointer-events-none');
        } else {
            apply.classList.remove('btn-disabled', 'opacity-50', 'pointer-events-none');
            setStApplyButtonReady(!!lastAnalysis?.ok);
        }
    }
}

/** @param {object} s summary from analyzeTemplateApply */
function formatPrepareSummaryText(s, applyStart, firstWeekLetter, applyEnd) {
    const skipped = Number(s?.skippedOtherProfCount ?? 0);
    const nClosure = Number(s?.closureFullWeekCount ?? 0);
    const closureLine =
        nClosure > 0
            ? `Semaines entières en fermeture sur la période (général) : ${nClosure} — gabarit non posé, alternance A/B suspendue pour ces semaines.`
            : '';
    const alternanceLine =
        nClosure > 0
            ? `Votre alternance (repère personnel) : semaine du ${applyStart} = type ${firstWeekLetter}, puis chaque lundi bascule A ↔ B jusqu’au ${applyEnd}, en ignorant les semaines entièrement en fermeture (voir ci-dessous).`
            : `Votre alternance (repère personnel) : semaine du ${applyStart} = type ${firstWeekLetter}, puis chaque lundi bascule A ↔ B jusqu’au ${applyEnd}.`;
    const conflictBlock =
        skipped === 0
            ? [
                  '——— Conflits / blocages ———',
                  'Aucun conflit détecté : pas de cours laissé de côté pour chevauchement avec un autre professeur sur le planning général.',
                  ''
              ]
            : [
                  '——— Conflits / blocages ———',
                  `${skipped} créneau(x) cours non posé(s) sur le planning général (chevauchement avec un autre professeur).`,
                  ''
              ];
    return [
        alternanceLine,
        '',
        ...(closureLine ? [closureLine, ''] : []),
        '——— Bilan des opérations prévues ———',
        `Suppressions — planning général : ${s.deleteMainCount}`,
        `Suppressions — agendas perso élèves : ${s.deleteStudentPersoCount}`,
        `Suppressions — agenda perso prof : ${s.deleteProfPersoCount}`,
        `Créations — cours (général + élève chacun) : ${s.createMainCoursCount} × 2 max`,
        `Créations — travail perso : ${s.createTravailCount}`,
        '',
        ...conflictBlock,
        'Vérifiez le résumé ci-dessus puis cliquez « 2. Appliquer sur Google Agenda » (à droite du bouton 1) pour écrire dans Google. En cas d’échec avant toute modification sur Google, une nouvelle tentative automatique peut avoir lieu ; après un début d’exécution, le message d’erreur indique ce qui a déjà été fait.'
    ].join('\n');
}

function resetStApplyProgressUi() {
    const wrap = document.getElementById('st-apply-progress-wrap');
    const bar = document.getElementById('st-apply-progress');
    const txt = document.getElementById('st-apply-progress-text');
    if (bar) bar.value = 0;
    if (txt) {
        txt.textContent = '';
        txt.classList.remove('text-red-700', 'font-bold');
    }
    wrap?.classList.add('hidden');
}

/** @param {{ phase: string; done: number; total: number; detail?: string }} ev */
function onStApplyProgress(ev) {
    const wrap = document.getElementById('st-apply-progress-wrap');
    const bar = document.getElementById('st-apply-progress');
    const txt = document.getElementById('st-apply-progress-text');
    if (!wrap || !bar || !txt) return;
    wrap.classList.remove('hidden');
    const total = ev.total > 0 ? ev.total : 1;
    const pct = Math.min(100, Math.round((100 * ev.done) / total));
    bar.value = pct;
    txt.textContent = `Progression : ${ev.done} / ${ev.total} — ${ev.detail || ''}`.trim();
}

function resetStAnalyzeOutput() {
    const ph = document.getElementById('st-analyze-placeholder');
    const out = document.getElementById('st-analyze-out');
    if (out) {
        out.textContent = '';
        out.style.display = 'none';
        out.classList.remove('text-red-700', 'font-bold');
    }
    if (ph) {
        ph.innerHTML = ST_ANALYZE_PLACEHOLDER_HTML;
        ph.style.display = 'block';
    }
    setStApplyButtonReady(false);
}

/** @type {AbortController | null} */
let stAbort = null;
/** @type {object | null} */
let lastAnalysis = null;
let stUiBound = false;
/** @type {HTMLTableRowElement | null} */
let stDnDRow = null;

export function resetSemainesTypesUiBindings() {
    stAbort?.abort();
    stAbort = null;
    lastAnalysis = null;
    stUiBound = false;
    stDnDRow = null;
}

function mainCalId() {
    return String(getPlanningConfig()?.mainGoogleCalendarId || '').trim();
}

function rowOverlap(d1, s1, e1, d2, s2, e2) {
    if (d1 !== d2) return false;
    return s1 < e2 && s2 < e1;
}

function escapeAttr(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
}

/** @param {{ nom?: string, prenom?: string, display_name?: string, email?: string }} e */
function elevePrenomNom(e) {
    const n = String(e?.nom || '').trim();
    const p = String(e?.prenom || '').trim();
    if (p || n) return [p, n].filter(Boolean).join(' ').trim();
    const d = String(e?.display_name || '').trim();
    if (d) return d;
    return String(e?.email || '').trim() || '—';
}

/** @param {string[]} ids @param {Map<string, object>} byId */
function enrolledLabelsSorted(ids, byId) {
    const rows = [];
    for (const id of ids || []) {
        const e = byId.get(id);
        rows.push({
            id,
            nom: String(e?.nom || '').toLowerCase(),
            prenom: String(e?.prenom || '').toLowerCase(),
            label: e ? elevePrenomNom(e) : id
        });
    }
    rows.sort((a, b) => {
        const c = a.nom.localeCompare(b.nom, 'fr');
        if (c !== 0) return c;
        return a.prenom.localeCompare(b.prenom, 'fr');
    });
    return rows.map((r) => r.label);
}

function syncReadonlyStudentsText(tr, studentIds, elevesById) {
    const el = tr.querySelector('.st-students-readonly-text');
    if (!el) return;
    const typ = tr.querySelector('.st-type')?.value || 'cours';
    if (typ !== 'cours') {
        el.textContent = '—';
        return;
    }
    const labels = enrolledLabelsSorted(studentIds, elevesById);
    el.textContent = labels.length ? labels.join(', ') : '—';
}

function wireStudentsToggle(tr, elevesById) {
    const btn = tr.querySelector('.st-students-toggle');
    const ro = tr.querySelector('.st-students-readonly-wrap');
    const sel = tr.querySelector('.st-students');
    if (!btn || !ro || !sel) return;
    btn.addEventListener('click', () => {
        const typ = tr.querySelector('.st-type')?.value || 'cours';
        if (typ !== 'cours') return;
        const editing = !sel.classList.contains('hidden');
        if (editing) {
            const studs = [];
            for (const o of sel.selectedOptions) {
                if (o.value) studs.push(o.value);
            }
            syncReadonlyStudentsText(tr, studs, elevesById);
            sel.classList.add('hidden');
            ro.classList.remove('hidden');
        } else {
            ro.classList.add('hidden');
            sel.classList.remove('hidden');
        }
    });
}

function parseRowsFromTbody(tbody, weekLetter, ownerId) {
    const rows = [];
    for (const tr of tbody?.querySelectorAll('tr[data-st-line]') || []) {
        if (tr.getAttribute('data-st-editable') !== '1') continue;
        const id = tr.getAttribute('data-line-id') || '';
        const dow = parseInt(tr.querySelector('.st-dow')?.value || '1', 10);
        const st = tr.querySelector('.st-start')?.value || '08:00';
        const en = tr.querySelector('.st-end')?.value || '09:00';
        const typ = tr.querySelector('.st-type')?.value || 'cours';
        const title = String(tr.querySelector('.st-title')?.value || '').trim();
        const sel = tr.querySelector('.st-students');
        const studs = [];
        if (sel && typ === 'cours') {
            for (const o of sel.selectedOptions) {
                if (o.value) studs.push(o.value);
            }
        }
        rows.push({
            domId: id,
            week_type: weekLetter,
            day_of_week: dow,
            start_time: `${st}:00`,
            end_time: `${en}:00`,
            slot_type: typ === 'cours' ? 'cours' : 'reservation',
            title,
            studentIds: studs,
            owner_user_id: ownerId
        });
    }
    return rows;
}

function validateNoOverlap(rows) {
    const byWeek = { A: [], B: [] };
    for (const r of rows) {
        byWeek[r.week_type].push(r);
    }
    for (const w of ['A', 'B']) {
        const list = byWeek[w];
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const a = list[i];
                const b = list[j];
                if (
                    rowOverlap(
                        a.day_of_week,
                        a.start_time.slice(0, 5),
                        a.end_time.slice(0, 5),
                        b.day_of_week,
                        b.start_time.slice(0, 5),
                        b.end_time.slice(0, 5)
                    )
                ) {
                    return `Chevauchement en semaine ${w} (${a.title || '…'} / ${b.title || '…'}).`;
                }
            }
        }
    }
    return null;
}

function makeStudentOptionsHtml(eleves) {
    return (eleves || [])
        .map((e) => {
            const lab = elevePrenomNom(e);
            return `<option value="${e.user_id}">${escapeAttr(lab)}</option>`;
        })
        .join('');
}

/**
 * @param {HTMLElement} tbody
 * @param {object | null} line
 * @param {string} optHtml
 * @param {{ isAdmin: boolean, ownerLabel: string, lineOwnerId: string, currentUserId: string, elevesById: Map<string, object> }} ctx
 */
function appendTemplateRow(tbody, line, optHtml, ctx) {
    const { isAdmin, ownerLabel, lineOwnerId, currentUserId, elevesById } = ctx;
    const isReadonly = isAdmin || lineOwnerId !== currentUserId;
    const tr = document.createElement('tr');
    tr.setAttribute('data-st-line', '1');
    tr.setAttribute('data-line-id', line?.id || '');
    tr.setAttribute('data-owner-id', lineOwnerId);
    tr.setAttribute('data-st-editable', isReadonly ? '0' : '1');

    const dowSel = DOW_OPTS.map(
        (o) => `<option value="${o.v}" ${line?.day_of_week === o.v ? 'selected' : ''}>${o.t}</option>`
    ).join('');
    const typeSel = `<option value="cours" ${line?.slot_type === 'cours' ? 'selected' : ''}>Cours</option>
        <option value="reservation" ${line?.slot_type === 'reservation' ? 'selected' : ''}>Travail perso.</option>`;
    const st = String(line?.start_time || '08:00:00').slice(0, 5);
    const en = String(line?.end_time || '09:00:00').slice(0, 5);
    const title = escapeAttr(line?.title || '');
    const sid = line?.studentIds || [];

    let studentsCell = '';
    if (isReadonly) {
        const labels = enrolledLabelsSorted(sid, elevesById);
        const txt = line?.slot_type === 'reservation' ? '—' : labels.length ? labels.join(', ') : '—';
        studentsCell = `<td class="st-students-cell align-top">
            <div class="st-students-readonly-wrap flex items-start gap-1 min-w-0">
                <span class="st-students-readonly-text flex-1 min-w-0 text-[9px] text-slate-700 leading-snug">${escapeAttr(txt)}</span>
            </div>
        </td>`;
    } else {
        studentsCell = `<td class="st-students-cell align-top">
            <div class="st-students-readonly-wrap flex items-start gap-1 min-w-0">
                <span class="st-students-readonly-text flex-1 min-w-0 text-[9px] text-slate-700 leading-snug"></span>
                <button type="button" class="st-students-toggle btn btn-ghost btn-xs p-0.5 min-h-0 h-auto shrink-0 border-0" title="Modifier les inscrits" aria-label="Modifier les inscrits">${USERS_SVG}</button>
            </div>
            <select multiple class="select select-xs st-students hidden w-full min-w-[8rem] max-h-24 text-[9px] bg-white border border-slate-200 rounded mt-0.5" size="4">${optHtml}</select>
        </td>`;
    }

    const dragCell = isReadonly
        ? '<td class="w-7 p-0"></td>'
        : `<td class="w-7 p-0 align-middle text-center select-none"><span class="st-drag-handle inline-flex cursor-grab active:cursor-grabbing text-slate-400 hover:text-slate-600 p-0.5 rounded hover:bg-slate-100" draggable="true" title="Glisser vers l’autre semaine type" aria-label="Glisser vers l’autre semaine type">${ST_DRAG_GRIP_SVG}</span></td>`;

    tr.innerHTML = `
        ${dragCell}
        <td class="text-[10px] font-bold text-slate-700 align-top">${escapeAttr(ownerLabel)}</td>
        <td><select class="select select-xs st-dow max-w-[4.5rem] font-bold bg-white border border-slate-200 rounded" ${isReadonly ? 'disabled' : ''}>${dowSel}</select></td>
        <td><select class="select select-xs st-start max-w-[4.5rem] font-mono bg-white border border-slate-200 rounded" ${isReadonly ? 'disabled' : ''}></select></td>
        <td><select class="select select-xs st-end max-w-[4.5rem] font-mono bg-white border border-slate-200 rounded" ${isReadonly ? 'disabled' : ''}></select></td>
        <td><select class="select select-xs st-type max-w-[5.5rem] font-bold bg-white border border-slate-200 rounded" ${isReadonly ? 'disabled' : ''}>${typeSel}</select></td>
        <td><input type="text" class="input input-xs st-title w-full min-w-[6rem] text-[10px] bg-white border border-slate-200 rounded" value="${title}" ${isReadonly ? 'readonly' : ''} /></td>
        ${studentsCell}
        <td>${isReadonly ? '' : '<button type="button" class="btn btn-ghost btn-xs st-del font-black text-error">×</button>'}</td>
    `;
    tbody.appendChild(tr);
    const ss = tr.querySelector('.st-start');
    const se = tr.querySelector('.st-end');
    populateTimeSelectElement(ss);
    populateTimeSelectElement(se);
    if (ss) ss.value = st;
    if (se) se.value = en;
    const stSel = tr.querySelector('.st-students');
    if (stSel && sid.length) {
        for (const id of sid) {
            const o = stSel.querySelector(`option[value="${id}"]`);
            if (o) o.selected = true;
        }
    }
    if (!isReadonly) {
        syncReadonlyStudentsText(tr, sid, elevesById);
        wireStudentsToggle(tr, elevesById);
    }
    tr.querySelector('.st-del')?.addEventListener('click', () => tr.remove());
    tr.querySelector('.st-type')?.addEventListener('change', () => {
        const t = tr.querySelector('.st-type')?.value;
        const mul = tr.querySelector('.st-students');
        const ro = tr.querySelector('.st-students-readonly-wrap');
        const btn = tr.querySelector('.st-students-toggle');
        if (t !== 'cours') {
            if (mul) {
                mul.classList.add('hidden');
                for (const o of mul.options) o.selected = false;
            }
            ro?.classList.remove('hidden');
            if (ro) tr.querySelector('.st-students-readonly-text').textContent = '—';
            ro?.classList.toggle('opacity-40', true);
            btn?.classList.add('hidden');
        } else {
            ro?.classList.remove('opacity-40');
            btn?.classList.remove('hidden');
            const cur = [];
            if (mul) {
                for (const o of mul.selectedOptions) {
                    if (o.value) cur.push(o.value);
                }
            }
            syncReadonlyStudentsText(tr, cur, elevesById);
        }
    });
}

async function loadEleves() {
    const sb = getSupabaseClient();
    if (!sb) return [];
    const { data, error } = await sb.rpc('planning_list_eleves_actifs');
    if (error) {
        console.warn(error.message);
        return [];
    }
    return data || [];
}

async function loadOwnerLabels(userIds) {
    const uniq = [...new Set((userIds || []).filter(Boolean))];
    if (!uniq.length) return new Map();
    const sb = getSupabaseClient();
    if (!sb) return new Map();
    const { data, error } = await sb.rpc('planning_profiles_label_for_ids', { p_ids: uniq });
    if (error) {
        console.warn(error.message);
        return new Map();
    }
    const m = new Map();
    for (const row of data || []) {
        const id = row.user_id;
        const lab = String(row.label || '').trim();
        m.set(id, lab || String(id).slice(0, 8));
    }
    for (const id of uniq) {
        if (!m.has(id)) m.set(id, String(id).slice(0, 8));
    }
    return m;
}

async function loadLinesForModal(user, isAdm) {
    const sb = getSupabaseClient();
    if (!sb) return { lines: [], byLineStudents: new Map() };
    let q = sb.from('organ_week_template_line').select('*').order('week_type').order('day_of_week');
    if (!isAdm) q = q.eq('owner_user_id', user.id);
    const { data: lines, error } = await q;
    if (error) {
        showToast(error.message, 'error');
        return { lines: [], byLineStudents: new Map() };
    }
    const lids = (lines || []).map((l) => l.id);
    const map = new Map();
    if (lids.length) {
        const { data: links } = await sb
            .from('organ_week_template_line_student')
            .select('line_id, student_user_id')
            .in('line_id', lids);
        for (const l of links || []) {
            if (!map.has(l.line_id)) map.set(l.line_id, []);
            map.get(l.line_id).push(l.student_user_id);
        }
    }
    return { lines: lines || [], byLineStudents: map };
}

function defaultApplyStartYmd() {
    const set = getOrganSchoolSettingsCached();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const ymdToday = today.toLocaleDateString('en-CA');
    if (set?.school_year_start) {
        const raw = String(set.school_year_start).slice(0, 10);
        const ss = new Date(`${raw}T12:00:00`);
        if (!Number.isNaN(ss.getTime()) && ss.getTime() > today.getTime()) return raw;
    }
    return ymdToday;
}

function defaultApplyEndYmd() {
    const set = getOrganSchoolSettingsCached();
    const endS = set?.school_year_end ? String(set.school_year_end).slice(0, 10) : '';
    if (!endS) return '';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endD = new Date(`${endS}T12:00:00`);
    if (Number.isNaN(endD.getTime()) || endD.getTime() < today.getTime()) return '';
    return endS;
}

async function openSemainesTypesModal(user) {
    const dlg = document.getElementById('modal_semaines_types');
    if (!dlg) return;
    const isAdm = isAdmin(user);
    invalidateOrganSchoolSettingsCache();
    await fetchOrganSchoolSettings();

    document.getElementById('st-gabarit-readonly-hint')?.classList.toggle('hidden', !isAdm);
    document.getElementById('st-add-row-a')?.classList.toggle('hidden', isAdm);
    document.getElementById('st-add-row-b')?.classList.toggle('hidden', isAdm);
    document.getElementById('st-gabarit-actions')?.classList.toggle('hidden', isAdm);
    document.getElementById('st-apply-admin-hint')?.classList.toggle('hidden', !isAdm);
    document.getElementById('st-apply-controls')?.classList.toggle('hidden', isAdm);

    const eleves = await loadEleves();
    const elevesById = new Map(eleves.map((e) => [e.user_id, e]));
    const optHtml = makeStudentOptionsHtml(eleves);
    const { lines, byLineStudents } = await loadLinesForModal(user, isAdm);
    const ownerIds = [...new Set(lines.map((l) => l.owner_user_id).filter(Boolean))];
    const ownerLabels = await loadOwnerLabels(ownerIds);

    const ta = document.getElementById('st-tbody-a');
    const tb = document.getElementById('st-tbody-b');
    if (ta) ta.replaceChildren();
    if (tb) tb.replaceChildren();

    const ctxBase = {
        isAdmin: isAdm,
        currentUserId: String(user.id),
        elevesById
    };

    for (const line of lines) {
        const tbody = line.week_type === 'A' ? ta : tb;
        if (!tbody) continue;
        const sid = byLineStudents.get(line.id) || [];
        const oid = String(line.owner_user_id || '');
        const ownerLabel = ownerLabels.get(oid) || oid.slice(0, 8);
        appendTemplateRow(tbody, { ...line, studentIds: sid }, optHtml, {
            ...ctxBase,
            ownerLabel,
            lineOwnerId: oid
        });
    }

    const applyStart = document.getElementById('st-apply-start');
    if (applyStart) applyStart.value = defaultApplyStartYmd();
    const applyEnd = document.getElementById('st-apply-end');
    if (applyEnd) applyEnd.value = defaultApplyEndYmd();

    resetStAnalyzeOutput();
    lastAnalysis = null;
    dlg.showModal();
}

function addEmptyRow(tbody, elevesHtml, user, elevesById, ownerLabels) {
    const oid = String(user.id);
    const ownerLabel = ownerLabels.get(oid) || user.email || oid.slice(0, 8);
    appendTemplateRow(
        tbody,
        {
            day_of_week: 1,
            start_time: '08:00:00',
            end_time: '09:00:00',
            slot_type: 'cours',
            title: '',
            studentIds: []
        },
        elevesHtml,
        {
            isAdmin: false,
            ownerLabel,
            lineOwnerId: oid,
            currentUserId: oid,
            elevesById
        }
    );
}

async function runSemainesTypesSaveGabarit() {
    const u = getPlanningSessionUser();
    const sb = getSupabaseClient();
    if (!u?.id || !sb || isAdmin(u)) return;
    const ta = document.getElementById('st-tbody-a');
    const tb = document.getElementById('st-tbody-b');
    const ra = parseRowsFromTbody(ta, 'A', u.id);
    const rb = parseRowsFromTbody(tb, 'B', u.id);
    const all = [...ra, ...rb];
    const err = validateNoOverlap(all);
    if (err) {
        showToast(err, 'error');
        return;
    }
    const saveBtn = document.getElementById('st-save-gabarit');
    const saveLabelRest =
        saveBtn?.getAttribute('data-label-rest') || 'Enregistrer le gabarit';
    if (saveBtn && !saveBtn.getAttribute('data-label-rest')) {
        saveBtn.setAttribute('data-label-rest', saveLabelRest);
    }
    setStModalActionsBusy(true);
    if (saveBtn) saveBtn.textContent = 'Enregistrement…';
    try {
        const { data: existing } = await sb.from('organ_week_template_line').select('id').eq('owner_user_id', u.id);
        const existingIds = new Set((existing || []).map((x) => x.id));
        const currentIds = new Set(
            all.map((x) => x.domId).filter((id) => id && !String(id).startsWith('new-'))
        );
        for (const id of existingIds) {
            if (!currentIds.has(id)) {
                await sb.from('organ_week_template_line').delete().eq('id', id);
            }
        }
        for (const r of all) {
            const payload = {
                week_type: r.week_type,
                owner_user_id: u.id,
                slot_type: r.slot_type,
                day_of_week: r.day_of_week,
                start_time: r.start_time,
                end_time: r.end_time,
                title: r.title,
                updated_at: new Date().toISOString()
            };
            let lineId = r.domId;
            if (!lineId || String(lineId).startsWith('new-')) {
                const { data: ins, error } = await sb
                    .from('organ_week_template_line')
                    .insert(payload)
                    .select('id')
                    .single();
                if (error) {
                    showToast(error.message, 'error');
                    return;
                }
                lineId = ins.id;
            } else {
                const { error } = await sb.from('organ_week_template_line').update(payload).eq('id', lineId);
                if (error) {
                    showToast(error.message, 'error');
                    return;
                }
            }
            await sb.from('organ_week_template_line_student').delete().eq('line_id', lineId);
            if (r.slot_type === 'cours' && r.studentIds.length) {
                const rowsIns = r.studentIds.map((sid) => ({ line_id: lineId, student_user_id: sid }));
                const { error: e2 } = await sb.from('organ_week_template_line_student').insert(rowsIns);
                if (e2) {
                    showToast(e2.message, 'error');
                    return;
                }
            }
        }
        showToast('Gabarit enregistré : semaines types A et B sauvegardées.', 'success', 5200);
    } finally {
        if (saveBtn) saveBtn.textContent = saveBtn.getAttribute('data-label-rest') || saveLabelRest;
        setStModalActionsBusy(false);
    }
}

async function runSemainesTypesAnalyze() {
    const u = getPlanningSessionUser();
    const sb = getSupabaseClient();
    if (!u?.id || !sb || isAdmin(u)) return;

    const analyzeBtn = document.getElementById('st-btn-analyze');
    const analyzeLabelRest =
        analyzeBtn?.getAttribute('data-label-rest') || '1. Préparer l’application';
    if (analyzeBtn && !analyzeBtn.getAttribute('data-label-rest')) {
        analyzeBtn.setAttribute('data-label-rest', analyzeLabelRest);
    }

    const mainId = mainCalId();
    if (!mainId) {
        const msg = 'Renseignez mainGoogleCalendarId dans planning.config.js (même calendrier que GOOGLE_CALENDAR_ID côté Edge Function).';
        stAnalyzeShowError('Configuration incomplète', msg);
        showToast('mainGoogleCalendarId manquant dans la config.', 'error');
        return;
    }
    const applyStart = document.getElementById('st-apply-start')?.value?.trim();
    const applyEnd = document.getElementById('st-apply-end')?.value?.trim();
    if (!applyStart || !applyEnd) {
        stAnalyzeShowError('Dates manquantes', 'Indiquez une date de début et une date de fin.');
        showToast('Indiquez une date de début et une date de fin.', 'error');
        return;
    }
    if (applyEnd < applyStart) {
        stAnalyzeShowError('Dates invalides', 'La date de fin doit être la même ou après le début.');
        showToast('La date de fin doit être la même ou après le début.', 'error');
        return;
    }

    setStModalActionsBusy(true);
    if (analyzeBtn) analyzeBtn.textContent = 'Préparation en cours…';
    try {
        stAnalyzeSetLoadingMessage();
        lastAnalysis = null;
        setStApplyButtonReady(false);

        const firstWeekRaw = document.querySelector('input[name="st-apply-first-week"]:checked')?.value;
        const firstWeekLetter = firstWeekRaw === 'B' ? 'B' : 'A';

        const { lines, byLineStudents } = await loadLinesForModal(u, false);
        const { data: evs } = await sb.rpc('planning_list_eleves_actifs');
        const byId = new Map((evs || []).map((e) => [e.user_id, e.email]));
        const linePayload = [];
        for (const ln of lines) {
            const emails = [];
            const ids = byLineStudents.get(ln.id) || [];
            for (const sid of ids) {
                const em = byId.get(sid);
                if (em) emails.push(em);
            }
            linePayload.push({
                ...ln,
                students: emails
            });
        }
        const emptyCours = linePayload.filter((l) => l.slot_type === 'cours').length === 0;
        if (emptyCours && linePayload.filter((l) => l.slot_type === 'reservation').length === 0) {
            if (
                !confirm(
                    'Votre gabarit ne contient aucune ligne. Tous vos cours seront retirés des agendas sur la période. Continuer la préparation ?'
                )
            ) {
                resetStAnalyzeOutput();
                return;
            }
        }
        const analysis = await analyzeTemplateApply({
            profUserId: u.id,
            profEmail: u.email,
            applyStartYmd: applyStart,
            applyEndYmd: applyEnd,
            firstWeekLetter,
            lines: linePayload,
            mainCalendarId: mainId
        });
        if (!analysis.ok) {
            const err = analysis.error || 'Préparation impossible.';
            stAnalyzeShowError('La préparation a échoué', err);
            showToast(err.split('\n')[0] || 'Préparation impossible.', 'error', 8000);
            return;
        }
        lastAnalysis = analysis;
        const s = analysis.summary;
        let summaryText;
        try {
            summaryText = formatPrepareSummaryText(s, applyStart, firstWeekLetter, applyEnd);
        } catch (e) {
            console.error('[semaines-types] formatPrepareSummaryText', e);
            stAnalyzeShowError('Erreur interne', String(e?.message || e));
            showToast('Erreur d’affichage du résumé (voir la console).', 'error');
            return;
        }
        stAnalyzeShowResult(summaryText);
        setStApplyButtonReady(true);
        showToast(
            'Préparation terminée : résumé dans l’encadré ci-dessous, bouton 2 activé à droite du bouton 1.',
            'info',
            4800
        );
        document.getElementById('st-analyze-out-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
        console.error('[semaines-types] runSemainesTypesAnalyze', e);
        const msg = String(e?.message || e);
        stAnalyzeShowError('Erreur inattendue', msg);
        showToast(msg.split('\n')[0] || 'Erreur lors de la préparation.', 'error', 8000);
    } finally {
        if (analyzeBtn) {
            analyzeBtn.textContent = analyzeBtn.getAttribute('data-label-rest') || analyzeLabelRest;
        }
        setStModalActionsBusy(false);
    }
}

async function runSemainesTypesApply() {
    const u = getPlanningSessionUser();
    if (!u?.email || !lastAnalysis?.ok) return;
    if (
        !confirm(
            'Appliquer maintenant sur Google Agenda ? Les suppressions listées seront exécutées puis les créations.'
        )
    ) {
        return;
    }
    setStModalActionsBusy(true);
    const applyBtn = document.getElementById('st-btn-apply');
    const applyLabelRest =
        applyBtn?.getAttribute('data-label-rest') || '2. Appliquer sur Google Agenda';
    if (applyBtn && !applyBtn.getAttribute('data-label-rest')) {
        applyBtn.setAttribute('data-label-rest', applyLabelRest);
    }
    if (applyBtn) applyBtn.textContent = 'Application en cours…';
    const mainId = mainCalId();
    const applyStartYmd = document.getElementById('st-apply-start')?.value?.trim() || '';
    const firstWeekRaw = document.querySelector('input[name="st-apply-first-week"]:checked')?.value;
    const letterForStartWeek = firstWeekRaw === 'B' ? 'B' : 'A';
    const analysisSnapshot = lastAnalysis;
    resetStApplyProgressUi();
    const pBar = document.getElementById('st-apply-progress');
    const pTxt = document.getElementById('st-apply-progress-text');
    const pWrap = document.getElementById('st-apply-progress-wrap');
    pWrap?.classList.remove('hidden');
    if (pTxt) pTxt.textContent = 'Démarrage de l’application…';
    try {
        if (pTxt) pTxt.textContent = 'Enregistrement du repère semaine A/B en base…';
        const sav = await saveProfWeekCycleFromApply(u.id, applyStartYmd, letterForStartWeek);
        if (!sav.ok && !sav.skipped) {
            const w = sav.error || 'Enregistrement du repère semaine A/B impossible.';
            if (pBar) pBar.value = 100;
            if (pTxt) {
                pTxt.textContent = w;
                pTxt.classList.add('text-red-700', 'font-bold');
            }
            stAnalyzeShowError('Base de données', w);
            showToast(w, 'error', 8000);
            return;
        }
        if (sav.ok) {
            document.dispatchEvent(new CustomEvent('planning-week-cycle-updated'));
        }

        const r = await executeTemplateApply(lastAnalysis, {
            profEmail: u.email,
            mainCalendarId: mainId,
            onProgress: onStApplyProgress
        });
        if (!r?.ok) {
            const detail = r?.error || 'Échec application.';
            const partialBlock = r?.partial ? formatTemplateApplyPartialSummary(r.partial) : '';
            const dbNote = sav.ok
                ? 'Le repère semaine A/B a été enregistré en base avant l’écriture Google. Les agendas peuvent être incomplets ; après correction, lancez « 1. Préparer » puis « 2. Appliquer » à nouveau.'
                : '';
            const fullDetail = [detail, partialBlock, dbNote].filter(Boolean).join('\n\n');
            const oneLine = detail.split('\n').find((l) => l.trim()) || 'Échec application.';
            if (pBar) {
                if (r?.partial && r.partial.grandTotal > 0) {
                    pBar.value = Math.min(
                        100,
                        Math.round((100 * r.partial.grandDone) / r.partial.grandTotal)
                    );
                } else {
                    pBar.value = 100;
                }
            }
            if (pTxt) {
                pTxt.textContent = r?.partial
                    ? `Interrompu après ${r.partial.grandDone} / ${r.partial.grandTotal} — ${oneLine}`
                    : `Interrompu : ${oneLine}`;
                pTxt.classList.add('text-red-700', 'font-bold');
            }
            stAnalyzeShowError('Application Google interrompue', fullDetail);
            showToast(oneLine, 'error', 9000);
            return;
        }
        if (pTxt) pTxt.classList.remove('text-red-700', 'font-bold');
        if (pBar) pBar.value = 100;
        if (pTxt) pTxt.textContent = 'Terminé avec succès — résumé dans l’encadré ci-dessous.';

        const st = r.stats || { deleteTotal: 0, upsertTotal: 0 };
        const sum = analysisSnapshot?.summary;
        const savWarn =
            sav.skipped
                ? '\n\nNote : repère semaine A/B non enregistré (auth backend non configurée). Libellé A/B dans la barre du planning : inchangé côté base.'
                : '';
        const repereBilanLine = sav.ok ? 'Repère A/B : enregistré en base avant l’écriture Google.' : null;
        const bilan =
            sum != null
                ? [
                      ...(repereBilanLine ? [repereBilanLine] : []),
                      `Suppressions prévues (analyse) — général / élèves / prof : ${sum.deleteMainCount} / ${sum.deleteStudentPersoCount} / ${sum.deleteProfPersoCount}`,
                      `Écritures exécutées cette fois : ${st.upsertTotal} événement(s) Google ; suppressions exécutées : ${st.deleteTotal}.`
                  ].join('\n')
                : sav.ok
                  ? `Repère A/B enregistré en base. Suppressions exécutées : ${st.deleteTotal}. Écritures Google : ${st.upsertTotal}.`
                  : `Suppressions exécutées : ${st.deleteTotal}. Écritures Google : ${st.upsertTotal}.`;

        stAnalyzeShowResult(
            [
                '——— Résultat de l’application Google ———',
                'Statut : succès (toutes les étapes envoyées se sont terminées sans erreur).',
                '',
                bilan,
                '',
                'Vous pouvez vérifier les agendas.',
                'Libellé « Semaine A / B » dans la barre du planning : uniquement en vue Semaine, Jour ou liste Planning (pas en vue Mois).',
                savWarn
            ]
                .join('\n')
                .trim()
        );

        showToast('Application sur Google Agenda terminée.', 'success', 6500);
        setStApplyButtonReady(false);
        lastAnalysis = null;
        document.dispatchEvent(new CustomEvent('planning-template-applied'));
    } finally {
        if (applyBtn) {
            applyBtn.textContent = applyBtn.getAttribute('data-label-rest') || applyLabelRest;
        }
        setStModalActionsBusy(false);
    }
}

function onStTemplateDragStart(e) {
    const h = e.target?.closest?.('.st-drag-handle');
    if (!h) return;
    const dlg = document.getElementById('modal_semaines_types');
    if (!dlg?.open || !dlg.contains(h)) return;
    const tr = h.closest('tr[data-st-line]');
    if (!(tr instanceof HTMLTableRowElement) || tr.getAttribute('data-st-editable') !== '1') return;
    stDnDRow = tr;
    e.dataTransfer?.setData('text/plain', 'semaines-types-row');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    tr.classList.add('opacity-40');
}

function onStTemplateDragEnd() {
    if (stDnDRow) stDnDRow.classList.remove('opacity-40');
    stDnDRow = null;
}

function onStTemplateDragOver(e) {
    if (!stDnDRow) return;
    const tb = e.target?.closest?.('#st-tbody-a, #st-tbody-b');
    if (!tb) return;
    const dlg = document.getElementById('modal_semaines_types');
    if (!dlg?.open || !dlg.contains(tb)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
}

function onStTemplateDrop(e) {
    const tb = e.target?.closest?.('#st-tbody-a, #st-tbody-b');
    if (!tb || !stDnDRow) return;
    const dlg = document.getElementById('modal_semaines_types');
    if (!dlg?.open || !dlg.contains(tb)) return;
    e.preventDefault();
    const src = stDnDRow.parentElement;
    if (src === tb) return;
    const u = getPlanningSessionUser();
    if (!u?.id) return;
    const tbodyA = document.getElementById('st-tbody-a');
    const tbodyB = document.getElementById('st-tbody-b');
    if (tb !== tbodyA && tb !== tbodyB) return;

    tb.appendChild(stDnDRow);
    const ra = parseRowsFromTbody(tbodyA, 'A', u.id);
    const rb = parseRowsFromTbody(tbodyB, 'B', u.id);
    const overlapErr = validateNoOverlap([...ra, ...rb]);
    if (overlapErr) {
        src.appendChild(stDnDRow);
        showToast(overlapErr, 'error');
    }
}

async function runSemainesTypesAddRow(week) {
    const u = getPlanningSessionUser();
    if (!u?.id) return;
    const eleves = await loadEleves();
    const elevesById = new Map(eleves.map((e) => [e.user_id, e]));
    const ownerLabels = await loadOwnerLabels([u.id]);
    const tbody =
        week === 'B' ? document.getElementById('st-tbody-b') : document.getElementById('st-tbody-a');
    addEmptyRow(tbody, makeStudentOptionsHtml(eleves), u, elevesById, ownerLabels);
}

function runSemainesTypesGotoCal() {
    document.getElementById('modal_semaines_types')?.close();
    document.getElementById('calendar')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/**
 * Clics dans la modale : délégation sur document (fiable même si le fragment HTML a été injecté
 * après un premier bind, ou si les boutons ont été recréés).
 */
function onSemainesTypesDocumentClick(e) {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const dlg = document.getElementById('modal_semaines_types');
    if (!dlg?.open || !dlg.contains(t)) return;

    if (t.closest('#st-btn-analyze')) {
        e.preventDefault();
        void runSemainesTypesAnalyze();
        return;
    }
    const applyEl = t.closest('#st-btn-apply');
    if (applyEl instanceof HTMLButtonElement) {
        e.preventDefault();
        if (applyEl.disabled) return;
        void runSemainesTypesApply();
        return;
    }
    if (t.closest('#st-save-gabarit')) {
        e.preventDefault();
        void runSemainesTypesSaveGabarit();
        return;
    }
    if (t.closest('#st-add-row-a')) {
        e.preventDefault();
        void runSemainesTypesAddRow('A');
        return;
    }
    if (t.closest('#st-add-row-b')) {
        e.preventDefault();
        void runSemainesTypesAddRow('B');
        return;
    }
    if (t.closest('#st-goto-cal')) {
        e.preventDefault();
        runSemainesTypesGotoCal();
    }
}

export function initSemainesTypesUi(currentUser) {
    const show = isBackendAuthConfigured() && isPrivilegedUser(currentUser);
    document.getElementById('menu-item-week-cycle-wrap')?.classList.toggle('hidden', !show);
    if (!show) return;
    if (stUiBound) return;
    stUiBound = true;

    stAbort?.abort();
    stAbort = new AbortController();
    const { signal } = stAbort;

    document.getElementById('menu-item-week-cycle')?.addEventListener(
        'click',
        (e) => {
            e.preventDefault();
            document.getElementById('btn-user-menu')?.blur();
            const u = getPlanningSessionUser();
            if (!u?.id) return;
            void openSemainesTypesModal(u);
        },
        { signal }
    );

    document.addEventListener('click', onSemainesTypesDocumentClick, { signal });
    document.addEventListener('dragstart', onStTemplateDragStart, { signal });
    document.addEventListener('dragend', onStTemplateDragEnd, { signal });
    document.addEventListener('dragover', onStTemplateDragOver, { signal });
    document.addEventListener('drop', onStTemplateDrop, { signal });
}
