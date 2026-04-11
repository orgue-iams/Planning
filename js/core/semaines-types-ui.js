/**
 * Semaines types A/B : repère lundi, gabarit (prof), analyse / application Google.
 */
import { isAdmin, isPrivilegedUser } from './auth-logic.js';
import { getPlanningSessionUser } from './session-user.js';
import { fetchWeekCycleAnchor, getWeekCycleAnchorMonday, saveWeekCycleAnchor } from './week-cycle.js';
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
    nextMondayStrictlyAfter
} from './template-apply-engine.js';

const DOW_OPTS = [
    { v: 1, t: 'Lun' },
    { v: 2, t: 'Mar' },
    { v: 3, t: 'Mer' },
    { v: 4, t: 'Jeu' },
    { v: 5, t: 'Ven' },
    { v: 6, t: 'Sam' },
    { v: 7, t: 'Dim' }
];

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

function parseRowsFromTbody(tbody, weekLetter, ownerId) {
    const rows = [];
    for (const tr of tbody?.querySelectorAll('tr[data-st-line]') || []) {
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
        .map(
            (e) =>
                `<option value="${e.user_id}">${escapeAttr(e.display_name || e.email)} (${escapeAttr(e.email)})</option>`
        )
        .join('');
}

function escapeAttr(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
}

function appendTemplateRow(tbody, week, line, elevesOptionsHtml, isReadonly, ownerShort) {
    const tr = document.createElement('tr');
    tr.setAttribute('data-st-line', '1');
    tr.setAttribute('data-line-id', line?.id || '');
    const dowSel = DOW_OPTS.map(
        (o) => `<option value="${o.v}" ${line?.day_of_week === o.v ? 'selected' : ''}>${o.t}</option>`
    ).join('');
    const typeSel = `<option value="cours" ${line?.slot_type === 'cours' ? 'selected' : ''}>Cours</option>
        <option value="reservation" ${line?.slot_type === 'reservation' ? 'selected' : ''}>Travail perso.</option>`;
    const st = String(line?.start_time || '08:00:00').slice(0, 5);
    const en = String(line?.end_time || '09:00:00').slice(0, 5);
    const title = escapeAttr(line?.title || '');
    const adminCell = ownerShort
        ? `<td class="text-[9px] font-mono text-slate-500">${escapeAttr(ownerShort)}</td>`
        : '';
    tr.innerHTML = `
        ${adminCell}
        <td><select class="select select-xs st-dow max-w-[4.5rem] font-bold bg-white border border-slate-200 rounded" ${isReadonly ? 'disabled' : ''}>${dowSel}</select></td>
        <td><select class="select select-xs st-start max-w-[4.5rem] font-mono bg-white border border-slate-200 rounded" ${isReadonly ? 'disabled' : ''}></select></td>
        <td><select class="select select-xs st-end max-w-[4.5rem] font-mono bg-white border border-slate-200 rounded" ${isReadonly ? 'disabled' : ''}></select></td>
        <td><select class="select select-xs st-type max-w-[5.5rem] font-bold bg-white border border-slate-200 rounded" ${isReadonly ? 'disabled' : ''}>${typeSel}</select></td>
        <td><input type="text" class="input input-xs st-title w-full min-w-[6rem] text-[10px] bg-white border border-slate-200 rounded" value="${title}" ${isReadonly ? 'readonly' : ''} /></td>
        <td><select multiple class="select select-xs st-students min-w-[8rem] max-h-20 text-[9px] bg-white border border-slate-200 rounded" size="3" ${isReadonly ? 'disabled' : ''}>${elevesOptionsHtml}</select></td>
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
    if (stSel && line?.studentIds?.length) {
        for (const id of line.studentIds) {
            const o = stSel.querySelector(`option[value="${id}"]`);
            if (o) o.selected = true;
        }
    }
    tr.querySelector('.st-del')?.addEventListener('click', () => tr.remove());
    tr.querySelector('.st-type')?.addEventListener('change', () => {
        const t = tr.querySelector('.st-type')?.value;
        const mul = tr.querySelector('.st-students');
        if (mul) mul.classList.toggle('opacity-40', t !== 'cours');
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

async function openSemainesTypesModal(user) {
    const dlg = document.getElementById('modal_semaines_types');
    if (!dlg) return;
    const isAdm = isAdmin(user);
    await fetchWeekCycleAnchor();
    const anchorInp = document.getElementById('st-anchor-date');
    if (anchorInp) anchorInp.value = getWeekCycleAnchorMonday() || '';
    document.getElementById('st-anchor-save')?.classList.toggle('hidden', false);
    document.getElementById('st-anchor-clear')?.classList.toggle('hidden', false);
    document.getElementById('st-gabarit-readonly-hint')?.classList.toggle('hidden', !isAdm);
    document.getElementById('st-add-row-a')?.classList.toggle('hidden', isAdm);
    document.getElementById('st-add-row-b')?.classList.toggle('hidden', isAdm);
    document.getElementById('st-gabarit-actions')?.classList.toggle('hidden', isAdm);
    document.getElementById('st-apply-section')?.classList.toggle('hidden', isAdm);

    const eleves = await loadEleves();
    const optHtml = makeStudentOptionsHtml(eleves);
    const { lines, byLineStudents } = await loadLinesForModal(user, isAdm);
    const ta = document.getElementById('st-tbody-a');
    const tb = document.getElementById('st-tbody-b');
    if (ta) ta.replaceChildren();
    if (tb) tb.replaceChildren();

    document.querySelectorAll('#st-gabarit-section table thead tr').forEach((tr) => {
        const hasOwner = tr.querySelector('th.st-th-owner');
        if (isAdm && !hasOwner) {
            const th = document.createElement('th');
            th.className = 'st-th-owner text-[9px]';
            th.textContent = 'Prof';
            tr.insertBefore(th, tr.firstChild);
        }
        if (!isAdm && hasOwner) hasOwner.remove();
    });

    for (const line of lines) {
        const tbody = line.week_type === 'A' ? ta : tb;
        if (!tbody) continue;
        const sid = byLineStudents.get(line.id) || [];
        const ownerShort = isAdm ? String(line.owner_user_id || '').slice(0, 8) : '';
        appendTemplateRow(
            tbody,
            line.week_type,
            { ...line, studentIds: sid },
            optHtml,
            isAdm,
            ownerShort
        );
    }

    await fetchOrganSchoolSettings();
    const set = getOrganSchoolSettingsCached();
    const endRo = document.getElementById('st-apply-end-ro');
    if (endRo) endRo.value = set?.school_year_end?.slice(0, 10) || '';
    const applyStart = document.getElementById('st-apply-start');
    if (applyStart && !applyStart.dataset.touched) {
        applyStart.value = nextMondayStrictlyAfter().toLocaleDateString('en-CA');
    }
    document.getElementById('st-analyze-out')?.classList.add('hidden');
    document.getElementById('st-btn-apply')?.classList.add('hidden');
    lastAnalysis = null;
    dlg.showModal();
}

function addEmptyRow(tbody, week, elevesHtml, user) {
    appendTemplateRow(
        tbody,
        week,
        {
            day_of_week: 1,
            start_time: '08:00:00',
            end_time: '09:00:00',
            slot_type: 'cours',
            title: '',
            studentIds: []
        },
        elevesHtml,
        false,
        ''
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

    document.getElementById('st-anchor-save')?.addEventListener(
        'click',
        async () => {
            const u = getPlanningSessionUser();
            if (!u?.id) return;
            const raw = document.getElementById('st-anchor-date')?.value?.trim() || null;
            const r = await saveWeekCycleAnchor(raw, String(u.id));
            if (!r.ok) {
                showToast(r.error || 'Erreur repère.', 'error');
                return;
            }
            showToast('Repère A/B enregistré.');
            document.dispatchEvent(new CustomEvent('planning-week-cycle-updated'));
        },
        { signal }
    );

    document.getElementById('st-anchor-clear')?.addEventListener(
        'click',
        async () => {
            const inp = document.getElementById('st-anchor-date');
            if (inp) inp.value = '';
            const u = getPlanningSessionUser();
            if (!u?.id) return;
            const r = await saveWeekCycleAnchor(null, String(u.id));
            if (!r.ok) {
                showToast(r.error || 'Erreur.', 'error');
                return;
            }
            showToast('Affichage A/B désactivé.');
            document.dispatchEvent(new CustomEvent('planning-week-cycle-updated'));
        },
        { signal }
    );

    document.getElementById('st-add-row-a')?.addEventListener(
        'click',
        async () => {
            const eleves = await loadEleves();
            addEmptyRow(document.getElementById('st-tbody-a'), 'A', makeStudentOptionsHtml(eleves), currentUser);
        },
        { signal }
    );
    document.getElementById('st-add-row-b')?.addEventListener(
        'click',
        async () => {
            const eleves = await loadEleves();
            addEmptyRow(document.getElementById('st-tbody-b'), 'B', makeStudentOptionsHtml(eleves), currentUser);
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
                    const rows = r.studentIds.map((sid) => ({ line_id: lineId, student_user_id: sid }));
                    const { error: e2 } = await sb.from('organ_week_template_line_student').insert(rows);
                    if (e2) {
                        showToast(e2.message, 'error');
                        return;
                    }
                }
            }
            showToast('Gabarit enregistré.');
        },
        { signal }
    );

    document.getElementById('st-btn-analyze')?.addEventListener(
        'click',
        async () => {
            const u = getPlanningSessionUser();
            const sb = getSupabaseClient();
            if (!u?.id || !sb || isAdmin(u)) return;
            const anchor = getWeekCycleAnchorMonday();
            if (!anchor) {
                showToast('Définissez d’abord le lundi semaine A.', 'error');
                return;
            }
            await fetchOrganSchoolSettings();
            const set = getOrganSchoolSettingsCached();
            if (!set?.school_year_start || !set?.school_year_end) {
                showToast('L’administrateur doit d’abord définir l’année scolaire (Configuration).', 'error');
                return;
            }
            const mainId = mainCalId();
            if (!mainId) {
                showToast('mainGoogleCalendarId manquant dans la config.', 'error');
                return;
            }
            const applyStart = document.getElementById('st-apply-start')?.value;
            if (!applyStart) {
                showToast('Choisissez une date de prise en compte.', 'error');
                return;
            }
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
            const out = document.getElementById('st-analyze-out');
            if (emptyCours && linePayload.filter((l) => l.slot_type === 'reservation').length === 0) {
                if (
                    !confirm(
                        'Votre gabarit ne contient aucune ligne. Tous vos cours seront retirés des agendas sur la période. Continuer l’analyse ?'
                    )
                ) {
                    return;
                }
            }
            const analysis = await analyzeTemplateApply({
                profUserId: u.id,
                profEmail: u.email,
                applyStartYmd: applyStart,
                schoolEndYmd: set.school_year_end.slice(0, 10),
                anchorMondayIso: anchor,
                lines: linePayload,
                mainCalendarId: mainId
            });
            if (!analysis.ok) {
                showToast(analysis.error || 'Analyse impossible.', 'error');
                return;
            }
            lastAnalysis = analysis;
            const s = analysis.summary;
            if (out) {
                out.classList.remove('hidden');
                out.textContent = [
                    `Suppressions — planning général : ${s.deleteMainCount}`,
                    `Suppressions — agendas perso élèves : ${s.deleteStudentPersoCount}`,
                    `Suppressions — agenda perso prof : ${s.deleteProfPersoCount}`,
                    `Créations — cours (général + élève chacun) : ${s.createMainCoursCount} × 2 max`,
                    `Créations — travail perso : ${s.createTravailCount}`,
                    `Créneaux cours non posés (conflit autre prof) : ${s.skippedOtherProfCount}`,
                    '',
                    'Vérifiez puis cliquez « Confirmer et appliquer » (3 tentatives en cas d’erreur réseau).'
                ].join('\n');
            }
            document.getElementById('st-btn-apply')?.classList.remove('hidden');
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
            showToast('Gabarit appliqué.');
            document.getElementById('st-btn-apply')?.classList.add('hidden');
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

    document.getElementById('st-apply-start')?.addEventListener('change', () => {
        const el = document.getElementById('st-apply-start');
        if (el) el.dataset.touched = '1';
    });
}
