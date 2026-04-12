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
import { analyzeTemplateApply, executeTemplateApply } from './template-apply-engine.js';

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

const ST_ANALYZE_PLACEHOLDER_TEXT =
    'Cliquez sur « 1. Préparer l’application » : le résumé s’affiche ici. Le bouton « 2. Appliquer sur Google Agenda » est juste en dessous (il s’active après une préparation réussie).';

function setStApplyButtonReady(ready) {
    const btn = document.getElementById('st-btn-apply');
    if (!btn) return;
    btn.disabled = !ready;
    if (ready) {
        btn.removeAttribute('title');
    } else {
        btn.setAttribute('title', 'Terminez d’abord l’étape 1 (Préparer l’application).');
    }
}

function resetStAnalyzeOutput() {
    const ph = document.getElementById('st-analyze-placeholder');
    const out = document.getElementById('st-analyze-out');
    if (ph) {
        ph.textContent = ST_ANALYZE_PLACEHOLDER_TEXT;
        ph.classList.remove('hidden');
    }
    if (out) {
        out.textContent = '';
        out.classList.add('hidden');
    }
    setStApplyButtonReady(false);
}

/** @type {AbortController | null} */
let stAbort = null;
/** @type {object | null} */
let lastAnalysis = null;
let stUiBound = false;

export function resetSemainesTypesUiBindings() {
    stAbort?.abort();
    stAbort = null;
    lastAnalysis = null;
    stUiBound = false;
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

    tr.innerHTML = `
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

    document.getElementById('st-add-row-a')?.addEventListener(
        'click',
        async () => {
            const u = getPlanningSessionUser();
            if (!u?.id) return;
            const eleves = await loadEleves();
            const elevesById = new Map(eleves.map((e) => [e.user_id, e]));
            const ownerLabels = await loadOwnerLabels([u.id]);
            addEmptyRow(
                document.getElementById('st-tbody-a'),
                makeStudentOptionsHtml(eleves),
                u,
                elevesById,
                ownerLabels
            );
        },
        { signal }
    );
    document.getElementById('st-add-row-b')?.addEventListener(
        'click',
        async () => {
            const u = getPlanningSessionUser();
            if (!u?.id) return;
            const eleves = await loadEleves();
            const elevesById = new Map(eleves.map((e) => [e.user_id, e]));
            const ownerLabels = await loadOwnerLabels([u.id]);
            addEmptyRow(
                document.getElementById('st-tbody-b'),
                makeStudentOptionsHtml(eleves),
                u,
                elevesById,
                ownerLabels
            );
        },
        { signal }
    );

    document.getElementById('st-save-gabarit')?.addEventListener(
        'click',
        async () => {
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
            const { data: existing } = await sb
                .from('organ_week_template_line')
                .select('id')
                .eq('owner_user_id', u.id);
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
            showToast('Semaines types enregistrées avec succès.', 'success');
        },
        { signal }
    );

    document.getElementById('st-btn-analyze')?.addEventListener(
        'click',
        async () => {
            const u = getPlanningSessionUser();
            const sb = getSupabaseClient();
            if (!u?.id || !sb || isAdmin(u)) return;

            const ph = document.getElementById('st-analyze-placeholder');
            const out = document.getElementById('st-analyze-out');
            const wrap = document.getElementById('st-analyze-out-wrap');
            if (ph) {
                ph.textContent = 'Préparation en cours…';
                ph.classList.remove('hidden');
            }
            if (out) {
                out.classList.add('hidden');
                out.textContent = '';
            }
            setStApplyButtonReady(false);

            const mainId = mainCalId();
            if (!mainId) {
                showToast('mainGoogleCalendarId manquant dans la config.', 'error');
                resetStAnalyzeOutput();
                return;
            }
            const applyStart = document.getElementById('st-apply-start')?.value?.trim();
            const applyEnd = document.getElementById('st-apply-end')?.value?.trim();
            if (!applyStart || !applyEnd) {
                showToast('Indiquez une date de début et une date de fin.', 'error');
                resetStAnalyzeOutput();
                return;
            }
            if (applyEnd < applyStart) {
                showToast('La date de fin doit être la même ou après le début.', 'error');
                resetStAnalyzeOutput();
                return;
            }
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
                showToast(analysis.error || 'Préparation impossible.', 'error');
                resetStAnalyzeOutput();
                return;
            }
            lastAnalysis = analysis;
            const s = analysis.summary;
            if (ph) ph.classList.add('hidden');
            if (out) {
                out.classList.remove('hidden');
                out.textContent = [
                    `Alternance : semaine du ${applyStart} = type ${firstWeekLetter}, puis chaque lundi bascule A ↔ B jusqu’au ${applyEnd}.`,
                    '',
                    `Suppressions — planning général : ${s.deleteMainCount}`,
                    `Suppressions — agendas perso élèves : ${s.deleteStudentPersoCount}`,
                    `Suppressions — agenda perso prof : ${s.deleteProfPersoCount}`,
                    `Créations — cours (général + élève chacun) : ${s.createMainCoursCount} × 2 max`,
                    `Créations — travail perso : ${s.createTravailCount}`,
                    `Créneaux cours non posés (conflit autre prof) : ${s.skippedOtherProfCount}`,
                    '',
                    'Vérifiez le résumé ci-dessus puis cliquez le bouton rouge « 2. Appliquer sur Google Agenda » (3 tentatives en cas d’erreur réseau).'
                ].join('\n');
            }
            setStApplyButtonReady(true);
            showToast('Préparation terminée : résumé affiché ci-dessus, bouton 2 activé.', 'info');
            document.getElementById('st-btn-apply-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        },
        { signal }
    );

    document.getElementById('st-btn-apply')?.addEventListener(
        'click',
        async () => {
            const u = getPlanningSessionUser();
            if (!u?.email || !lastAnalysis?.ok) return;
            if (
                !confirm(
                    'Appliquer maintenant sur Google Agenda ? Les suppressions listées seront exécutées puis les créations.'
                )
            ) {
                return;
            }
            const mainId = mainCalId();
            const r = await executeTemplateApply(lastAnalysis, { profEmail: u.email, mainCalendarId: mainId });
            if (!r.ok) {
                showToast(r.error || 'Échec application.', 'error');
                return;
            }
            showToast('Application sur Google Agenda terminée.', 'success');
            setStApplyButtonReady(false);
            lastAnalysis = null;
            document.dispatchEvent(new CustomEvent('planning-template-applied'));
        },
        { signal }
    );

    document.getElementById('st-goto-cal')?.addEventListener(
        'click',
        () => {
            document.getElementById('modal_semaines_types')?.close();
            document.getElementById('calendar')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        },
        { signal }
    );
}
