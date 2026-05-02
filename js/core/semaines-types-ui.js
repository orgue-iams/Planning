/**
 * Semaines types A/B : gabarit (prof), analyse / application Google.
 */
import { isAdmin, isPrivilegedUser } from './auth-logic.js';
import { getPlanningSessionUser } from './session-user.js';
import { getSupabaseClient, isBackendAuthConfigured, getPlanningConfig } from './supabase-client.js';
import { showToast } from '../utils/toast.js';
import {
    fetchOrganSchoolSettings,
    getOrganSchoolSettingsCached,
    invalidateOrganSchoolSettingsCache
} from './organ-settings.js';
import {
    analyzeTemplateApply,
    executeTemplateDatabasePhase,
    formatTemplateApplyPartialSummary,
    runTemplateGoogleBackgroundSync
} from './template-apply-engine.js';
import { saveProfWeekCycleFromApply } from './week-cycle.js';
import { openCourseStudentsPicker } from './course-students-picker.js';

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

function setStGoogleSyncHintVisible(visible) {
    const el = document.getElementById('st-google-sync-hint');
    if (!el) return;
    el.classList.toggle('hidden', !visible);
}

/** Grise et désactive les actions pendant une opération réseau. Préparation / application aussi bloquées pendant la synchro Google en arrière-plan. */
function setStModalActionsBusy(busy) {
    const save = document.getElementById('st-save-gabarit');
    const analyze = document.getElementById('st-btn-analyze');
    const apply = document.getElementById('st-btn-apply');
    const analyzeApplyLocked = busy || stGoogleSyncInFlight;

    if (save) {
        if (busy) {
            save.setAttribute('disabled', 'disabled');
            save.disabled = true;
            save.classList.add('btn-disabled', 'opacity-50', 'pointer-events-none');
        } else {
            save.removeAttribute('disabled');
            save.disabled = false;
            save.classList.remove('btn-disabled', 'opacity-50', 'pointer-events-none');
        }
    }
    for (const btn of [analyze]) {
        if (!btn) continue;
        if (analyzeApplyLocked) {
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
        if (analyzeApplyLocked) {
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
        'Vérifiez le résumé puis « 2. Appliquer » : la base est mise à jour en premier, puis Google en arrière-plan (avec pauses anti-quota). Pendant la synchro Google, les boutons Préparer / Appliquer restent indisponibles jusqu’à la fin.'
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
/** True tant que la synchro Google du gabarit (étape 2) n’est pas terminée. */
let stGoogleSyncInFlight = false;
let stUiBound = false;
/** @type {HTMLTableRowElement | null} */
let stDnDRow = null;
/** @type {Map<string, object>} */
let stElevesByIdRef = new Map();
/** @type {HTMLTableRowElement | null} */
let stLineEditTargetTr = null;
/** @type {string[]} */
let stLineEditPendingStudents = [];

export function resetSemainesTypesUiBindings() {
    stAbort?.abort();
    stAbort = null;
    lastAnalysis = null;
    stGoogleSyncInFlight = false;
    stUiBound = false;
    stDnDRow = null;
    stElevesByIdRef = new Map();
    stLineEditTargetTr = null;
    stLineEditPendingStudents = [];
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

function firstNameOnly(label) {
    const raw = String(label || '').trim();
    if (!raw) return '';
    const parts = raw.split(/\s+/).filter(Boolean);
    return parts[0] || raw;
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

function padTime(raw) {
    const s = String(raw || '08:00').slice(0, 5);
    return /^\d{2}:\d{2}$/.test(s) ? s : '08:00';
}

function slotTypeLabel(slotType) {
    return slotType === 'cours' ? 'Cours' : 'Travail perso.';
}

const ST_DOW_LONG = ['—', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

function dowLongLabel(dow) {
    const v = Math.min(7, Math.max(1, Number(dow) || 1));
    return ST_DOW_LONG[v] || '—';
}

/** Met à jour les libellés lisibles (sans listes factices) à partir des data-* de ligne. */
function syncRowReadonlyDisplay(tr, elevesById) {
    const typ = tr.dataset.stSlotType || 'cours';
    const dow = parseInt(tr.dataset.stDow || '1', 10);
    tr.querySelector('.st-ro-type')?.replaceChildren(document.createTextNode(slotTypeLabel(typ)));
    tr.querySelector('.st-ro-dow')?.replaceChildren(document.createTextNode(dowLongLabel(dow)));
    tr.querySelector('.st-ro-start')?.replaceChildren(document.createTextNode(padTime(tr.dataset.stStart)));
    tr.querySelector('.st-ro-end')?.replaceChildren(document.createTextNode(padTime(tr.dataset.stEnd)));
    const title = String(tr.dataset.stTitle || '').trim();
    const titleEl = tr.querySelector('.st-ro-title');
    if (titleEl) titleEl.textContent = title || '—';
    const roStudents = tr.querySelector('.st-ro-students');
    if (!roStudents) return;
    if (typ !== 'cours') {
        roStudents.textContent = '—';
        return;
    }
    const ids = String(tr.dataset.stStudents || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    const labels = enrolledLabelsSorted(ids, elevesById);
    roStudents.innerHTML = labels.length ? labels.map(escapeAttr).join('<br>') : '—';
}

function parseRowsFromTbody(tbody, weekLetter, ownerId) {
    const rows = [];
    for (const tr of tbody?.querySelectorAll('tr[data-st-line]') || []) {
        if (tr.getAttribute('data-st-editable') !== '1') continue;
        const id = tr.getAttribute('data-line-id') || '';
        const dow = parseInt(tr.dataset.stDow || '1', 10);
        const st = padTime(tr.dataset.stStart);
        const en = padTime(tr.dataset.stEnd);
        const typ = tr.dataset.stSlotType === 'reservation' ? 'reservation' : 'cours';
        const title = String(tr.dataset.stTitle || '').trim();
        const studs =
            typ === 'cours'
                ? String(tr.dataset.stStudents || '')
                      .split(',')
                      .map((x) => x.trim())
                      .filter(Boolean)
                : [];
        rows.push({
            domId: id,
            week_type: weekLetter,
            day_of_week: dow,
            start_time: `${st}:00`,
            end_time: `${en}:00`,
            slot_type: typ,
            title,
            studentIds: studs,
            owner_user_id: ownerId
        });
    }
    return rows;
}

function refreshStleStudentSummary() {
    const el = document.getElementById('stle-students-summary');
    if (!el) return;
    const labels = enrolledLabelsSorted(stLineEditPendingStudents, stElevesByIdRef);
    el.textContent = labels.length ? labels.join(', ') : 'Aucun inscrit';
}

function wireStLineEditModal() {
    const dlg = document.getElementById('modal_st_line_edit');
    const btnOk = document.getElementById('stle-btn-ok');
    const btnCancel = document.getElementById('stle-btn-cancel');
    const btnStudents = document.getElementById('stle-btn-students');
    if (!dlg || !btnOk || !btnCancel || !btnStudents || dlg.dataset.stleWired === '1') return;
    dlg.dataset.stleWired = '1';

    btnStudents.addEventListener('click', async () => {
        const typ =
            dlg.querySelector('input[name="stle-slot-type"]:checked')?.value === 'reservation'
                ? 'reservation'
                : 'cours';
        if (typ !== 'cours') {
            showToast('Les inscriptions concernent uniquement les créneaux « Cours ».', 'info');
            return;
        }
        const elevesList = [...stElevesByIdRef.values()];
        const picked = await openCourseStudentsPicker({
            title: 'Inscriptions au cours (semaine type)',
            maxStudents: 5,
            eleves: elevesList,
            selectedUserIds: stLineEditPendingStudents
        });
        if (!picked) return;
        stLineEditPendingStudents = picked;
        refreshStleStudentSummary();
    });

    btnCancel.addEventListener('click', () => {
        stLineEditTargetTr = null;
        dlg.close();
    });

    btnOk.addEventListener('click', () => {
        const tr = stLineEditTargetTr;
        if (!tr) return;
        const typRaw = dlg.querySelector('input[name="stle-slot-type"]:checked')?.value;
        const typ = typRaw === 'reservation' ? 'reservation' : 'cours';
        const dowSel = /** @type {HTMLSelectElement | null} */ (document.getElementById('stle-dow'));
        const dow = parseInt(dowSel?.value || '1', 10);
        const st = padTime(/** @type {HTMLInputElement | null} */ (document.getElementById('stle-start'))?.value);
        const en = padTime(/** @type {HTMLInputElement | null} */ (document.getElementById('stle-end'))?.value);
        const title = String(/** @type {HTMLInputElement | null} */ (document.getElementById('stle-title'))?.value || '').trim();
        if (st >= en) {
            showToast('L’heure de fin doit être après le début.', 'error');
            return;
        }
        tr.dataset.stSlotType = typ;
        tr.dataset.stDow = String(Math.min(7, Math.max(1, dow)));
        tr.dataset.stStart = st;
        tr.dataset.stEnd = en;
        tr.dataset.stTitle = title;
        tr.dataset.stStudents = typ === 'cours' ? stLineEditPendingStudents.join(',') : '';
        tr.classList.remove('st-row-cours', 'st-row-travail', 'st-row-other-prof');
        tr.classList.add(typ === 'cours' ? 'st-row-cours' : 'st-row-travail');
        syncRowReadonlyDisplay(tr, stElevesByIdRef);
        stLineEditTargetTr = null;
        dlg.close();
    });

    dlg.addEventListener('close', () => {
        stLineEditTargetTr = null;
    });

    dlg.addEventListener('change', (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLInputElement) || t.name !== 'stle-slot-type') return;
        const isCours = t.value === 'cours';
        document.getElementById('stle-students-wrap')?.classList.toggle('hidden', !isCours);
    });
}

function openStLineEditModal(tr) {
    const dlg = document.getElementById('modal_st_line_edit');
    if (!dlg || !(dlg instanceof HTMLDialogElement)) return;
    wireStLineEditModal();

    stLineEditTargetTr = tr;
    const typ = tr.dataset.stSlotType === 'reservation' ? 'reservation' : 'cours';
    const coursRadio = /** @type {HTMLInputElement | null} */ (document.getElementById('stle-type-cours'));
    const resRadio = /** @type {HTMLInputElement | null} */ (document.getElementById('stle-type-reservation'));
    if (coursRadio) coursRadio.checked = typ === 'cours';
    if (resRadio) resRadio.checked = typ === 'reservation';

    const dowSel = /** @type {HTMLSelectElement | null} */ (document.getElementById('stle-dow'));
    if (dowSel) dowSel.value = String(Math.min(7, Math.max(1, parseInt(tr.dataset.stDow || '1', 10))));

    const stIn = /** @type {HTMLInputElement | null} */ (document.getElementById('stle-start'));
    const enIn = /** @type {HTMLInputElement | null} */ (document.getElementById('stle-end'));
    if (stIn) stIn.value = padTime(tr.dataset.stStart);
    if (enIn) enIn.value = padTime(tr.dataset.stEnd);

    const ti = /** @type {HTMLInputElement | null} */ (document.getElementById('stle-title'));
    if (ti) ti.value = String(tr.dataset.stTitle || '').trim();

    stLineEditPendingStudents = String(tr.dataset.stStudents || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    refreshStleStudentSummary();

    document.getElementById('stle-students-wrap')?.classList.toggle('hidden', typ !== 'cours');
    dlg.showModal();
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
 * @param {string} _optHtml réservé compat appelants (non utilisé — données élèves via data-students + édition modale).
 * @param {{ isAdmin: boolean, ownerLabel: string, lineOwnerId: string, currentUserId: string, elevesById: Map<string, object> }} ctx
 */
function appendTemplateRow(tbody, line, _optHtml, ctx) {
    const { isAdmin, ownerLabel, lineOwnerId, currentUserId, elevesById } = ctx;
    const isOwnRow = String(lineOwnerId) === String(currentUserId);
    const isReadonly = isAdmin || !isOwnRow;
    const slotT = line?.slot_type === 'reservation' ? 'reservation' : 'cours';
    const sid = line?.studentIds || [];

    const tr = document.createElement('tr');
    tr.setAttribute('data-st-line', '1');
    tr.setAttribute('data-line-id', line?.id || '');
    tr.setAttribute('data-owner-id', lineOwnerId);
    tr.setAttribute('data-st-editable', isReadonly ? '0' : '1');

    tr.dataset.stSlotType = slotT;
    tr.dataset.stDow = String(line?.day_of_week ?? 1);
    tr.dataset.stStart = String(line?.start_time || '08:00:00').slice(0, 5);
    tr.dataset.stEnd = String(line?.end_time || '09:00:00').slice(0, 5);
    tr.dataset.stTitle = String(line?.title || '').trim();
    tr.dataset.stStudents = sid.join(',');

    const otherProfCours =
        line?.slot_type === 'cours' && String(lineOwnerId) !== String(currentUserId);
    if (otherProfCours) {
        tr.classList.add('st-row-other-prof', 'st-row-travail');
    } else {
        tr.classList.add(line?.slot_type === 'cours' ? 'st-row-cours' : 'st-row-travail');
    }

    const dragCell = isReadonly
        ? '<td class="w-7 p-0"></td>'
        : `<td class="w-7 p-0 align-middle text-center select-none"><span class="st-drag-handle inline-flex cursor-grab active:cursor-grabbing text-slate-400 hover:text-slate-600 p-0.5 rounded hover:bg-slate-100" draggable="true" title="Glisser vers l’autre semaine type" aria-label="Glisser vers l’autre semaine type">${ST_DRAG_GRIP_SVG}</span></td>`;

    const actionsCell = isReadonly
        ? '<td class="p-1 align-top w-14"></td>'
        : `<td class="p-1 align-top w-14">
      <div class="flex flex-col items-end gap-0.5">
        <button type="button" class="st-row-edit btn btn-ghost btn-xs btn-square border border-slate-200 planning-icon-btn" title="Modifier le créneau" aria-label="Modifier le créneau">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 3.487a2.25 2.25 0 113.182 3.182L8.25 18.463 3 21l2.537-5.25L16.862 3.487z"/></svg>
        </button>
        <button type="button" class="btn btn-ghost btn-xs st-del font-black text-error min-h-0 h-7 leading-none" title="Supprimer la ligne">×</button>
      </div>
    </td>`;

    tr.innerHTML = `
        ${dragCell}
        <td class="text-[10px] font-bold font-sans text-slate-800 align-top p-2 break-words max-w-[9rem]">${escapeAttr(ownerLabel)}</td>
        <td class="align-top p-2 text-[10px] text-slate-800 leading-snug"><span class="st-ro-type"></span></td>
        <td class="align-top p-2 text-[10px] text-slate-800 leading-snug"><span class="st-ro-dow"></span></td>
        <td class="align-top p-2 text-[10px] font-mono text-slate-800 leading-snug whitespace-nowrap"><span class="st-ro-start"></span></td>
        <td class="align-top p-2 text-[10px] font-mono text-slate-800 leading-snug whitespace-nowrap"><span class="st-ro-end"></span></td>
        <td class="align-top p-2 text-[10px] text-slate-800 leading-snug min-w-[6rem] max-w-[14rem] break-words"><span class="st-ro-title"></span></td>
        <td class="st-students-cell align-top p-2 min-w-[9rem] max-w-[20rem]"><span class="st-ro-students text-[10px] font-normal font-sans text-slate-700 leading-snug"></span></td>
        ${actionsCell}
    `;
    tbody.appendChild(tr);
    syncRowReadonlyDisplay(tr, elevesById);
    tr.querySelector('.st-del')?.addEventListener('click', () => tr.remove());
    return tr;
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
        m.set(id, firstNameOnly(lab) || String(id).slice(0, 8));
    }
    for (const id of uniq) {
        if (!m.has(id)) m.set(id, String(id).slice(0, 8));
    }
    return m;
}

/** Charge tous les gabarits (tous profs) pour affichage A/B ; l’édition reste limitée aux lignes du prof courant côté UI. */
async function loadLinesForModal() {
    const sb = getSupabaseClient();
    if (!sb) return { lines: [], byLineStudents: new Map() };
    const { data: lines, error } = await sb
        .from('organ_week_template_line')
        .select('*')
        .order('week_type')
        .order('day_of_week');
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
    const { lines, byLineStudents } = await loadLinesForModal();
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
    stElevesByIdRef = elevesById;

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
    const tr = appendTemplateRow(
        tbody,
        {
            day_of_week: 1,
            start_time: '08:00:00',
            end_time: '09:00:00',
            slot_type: 'cours',
            title: 'Cours',
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
    // Fix UX : forcer la ligne nouvellement ajoutée à être visible.
    requestAnimationFrame(() => {
        if (!tr) return;
        try {
            tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } catch {
            tr.scrollIntoView();
        }
        tr.classList.add('ring-2', 'ring-sky-500');
        window.setTimeout(() => tr.classList.remove('ring-2', 'ring-sky-500'), 1200);
    });
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
    if (stGoogleSyncInFlight) {
        showToast(
            'Synchronisation Google du gabarit en cours : attendez la fin avant de relancer « Préparer ».',
            'info',
            7000
        );
        return;
    }

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

        const { lines: allTemplateLines, byLineStudents } = await loadLinesForModal();
        const uid = String(u.id);
        const lines = allTemplateLines.filter((l) => String(l.owner_user_id || '') === uid);
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
    if (stGoogleSyncInFlight) {
        showToast('Synchronisation Google du gabarit encore en cours.', 'info', 5000);
        return;
    }
    if (
        !confirm(
            'La base de données est mise à jour en premier, puis Google Agenda en arrière-plan (calendrier général, puis agendas concernés), avec des pauses pour limiter les quotas. Vous pourrez fermer cette fenêtre pendant la synchro Google ; les boutons Préparer / Appliquer resteront indisponibles jusqu’à la fin. Continuer ?'
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

        const dbR = await executeTemplateDatabasePhase(lastAnalysis, {
            profEmail: u.email,
            profUserId: u.id,
            mainCalendarId: mainId,
            onProgress: onStApplyProgress
        });
        if (!dbR?.ok) {
            const detail = dbR?.error || 'Échec enregistrement base.';
            if (pBar) pBar.value = 100;
            if (pTxt) {
                pTxt.textContent = detail;
                pTxt.classList.add('text-red-700', 'font-bold');
            }
            stAnalyzeShowError('Base de données', detail);
            showToast(detail.split('\n')[0] || detail, 'error', 8000);
            return;
        }

        if (pTxt) pTxt.classList.remove('text-red-700', 'font-bold');
        if (pBar) pBar.value = 100;
        if (pTxt) {
            pTxt.textContent =
                dbR.mode === 'supabase'
                    ? 'Base à jour. Synchronisation Google en cours en arrière-plan…'
                    : 'Mise à jour Google en cours en arrière-plan…';
        }

        showToast(
            dbR.mode === 'supabase'
                ? 'Gabarit enregistré en base. Les agendas Google se mettent à jour en arrière-plan (vous pouvez fermer cette fenêtre).'
                : 'Mise à jour des agendas Google en arrière-plan…',
            'success',
            7500
        );

        if (applyBtn) applyBtn.textContent = applyBtn.getAttribute('data-label-rest') || applyLabelRest;

        stGoogleSyncInFlight = true;
        setStGoogleSyncHintVisible(true);
        setStModalActionsBusy(false);
        document.dispatchEvent(new CustomEvent('planning-template-applied'));

        void runTemplateGoogleBackgroundSync({
            analysis: analysisSnapshot,
            ctx: { profEmail: u.email, profUserId: u.id, mainCalendarId: mainId },
            dbResult: dbR,
            onProgress: onStApplyProgress
        })
            .then((gR) => {
                if (!gR?.ok) {
                    const detail = gR?.error || 'Échec synchronisation Google.';
                    const partialBlock = gR?.partial ? formatTemplateApplyPartialSummary(gR.partial) : '';
                    const dbNote =
                        'La base a été modifiée : vérifiez les agendas, puis lancez « 1. Préparer » avant un nouvel essai si besoin.';
                    const fullDetail = [detail, partialBlock, dbNote].filter(Boolean).join('\n\n');
                    const oneLine = detail.split('\n').find((l) => l.trim()) || detail;
                    if (pTxt) {
                        pTxt.textContent = gR?.partial
                            ? `Google interrompu après ${gR.partial.grandDone} / ${gR.partial.grandTotal} — ${oneLine}`
                            : `Google : ${oneLine}`;
                        pTxt.classList.add('text-red-700', 'font-bold');
                    }
                    stAnalyzeShowError('Synchronisation Google interrompue', fullDetail);
                    showToast(oneLine, 'error', 9000);
                    lastAnalysis = null;
                    setStApplyButtonReady(false);
                    return;
                }

                if (pTxt) {
                    pTxt.classList.remove('text-red-700', 'font-bold');
                    pTxt.textContent = 'Synchronisation Google terminée — résumé ci-dessous.';
                }

                const st = gR.stats || { deleteTotal: 0, upsertTotal: 0 };
                const sum = analysisSnapshot?.summary;
                const savWarn =
                    sav.skipped
                        ? '\n\nNote : repère semaine A/B non enregistré (auth backend non configurée). Libellé A/B dans la barre du planning : inchangé côté base.'
                        : '';
                const repereBilanLine = sav.ok ? 'Repère A/B : enregistré en base avant la synchro Google.' : null;
                const bilan =
                    sum != null
                        ? [
                              ...(repereBilanLine ? [repereBilanLine] : []),
                              `Suppressions prévues (analyse) — général / élèves / prof : ${sum.deleteMainCount} / ${sum.deleteStudentPersoCount} / ${sum.deleteProfPersoCount}`,
                              gR.skipped
                                  ? 'Pont Google non configuré : aucune écriture distante.'
                                  : `Opérations Google exécutées : ${st.upsertTotal} écriture(s) ; ${st.deleteTotal} suppression(s) de miroirs.`
                          ].join('\n')
                        : sav.ok
                          ? `Repère A/B enregistré. Google : ${st.deleteTotal} suppression(s), ${st.upsertTotal} écriture(s).`
                          : `Google : ${st.deleteTotal} suppression(s), ${st.upsertTotal} écriture(s).`;

                stAnalyzeShowResult(
                    [
                        '——— Résultat ———',
                        gR.skipped
                            ? 'Statut : base à jour ; pont Google absent ou ignoré.'
                            : 'Statut : base et Google Agenda synchronisés.',
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

                showToast(
                    gR.skipped ? 'Base à jour (Google non synchronisé — pont absent).' : 'Synchronisation Google terminée.',
                    'success',
                    6500
                );
                lastAnalysis = null;
                setStApplyButtonReady(false);
                document.dispatchEvent(new CustomEvent('planning-template-applied'));
            })
            .catch((e) => {
                const msg = e instanceof Error ? e.message : String(e);
                showToast(msg, 'error', 8000);
                stAnalyzeShowError('Synchronisation Google', msg);
                lastAnalysis = null;
                setStApplyButtonReady(false);
            })
            .finally(() => {
                stGoogleSyncInFlight = false;
                setStGoogleSyncHintVisible(false);
                setStModalActionsBusy(false);
            });
    } finally {
        if (applyBtn) {
            applyBtn.textContent = applyBtn.getAttribute('data-label-rest') || applyLabelRest;
        }
        if (!stGoogleSyncInFlight) {
            setStModalActionsBusy(false);
        }
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
    stElevesByIdRef = elevesById;
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
        return;
    }
    const editLineBtn = t.closest('.st-row-edit');
    if (editLineBtn instanceof HTMLButtonElement) {
        e.preventDefault();
        const tr = editLineBtn.closest('tr[data-st-line]');
        if (tr instanceof HTMLTableRowElement && tr.getAttribute('data-st-editable') === '1') {
            openStLineEditModal(tr);
        }
    }
}

export function initSemainesTypesUi(currentUser) {
    const show = isBackendAuthConfigured() && isPrivilegedUser(currentUser);
    if (!show) return;
    if (stUiBound) return;
    stUiBound = true;

    stAbort?.abort();
    stAbort = new AbortController();
    const { signal } = stAbort;

    document.getElementById('menu-item-semaines-types')?.addEventListener(
        'click',
        (e) => {
            e.preventDefault();
            document.getElementById('btn-header-agenda-menu')?.blur();
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
