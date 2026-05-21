/**
 * Semaines types A/B : gabarit (prof), analyse / application Google.
 */
import { isAdmin, isProf } from './auth-logic.js';
import {
    defaultTeachingDow,
    fetchTeachingDaysForUser,
    formatTeachingDaysShort,
    saveTeachingDaysForUser,
    syncTeachingDaySelectOptions
} from './teaching-days.js';
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
    formatTemplateOtherProfConflictLines,
    runTemplateGoogleBackgroundSync
} from './template-apply-engine.js';
import { deletePlanningSlotForClosureConflict } from './fermetures-planning.js';
import { saveProfWeekCycleFromApply, getProfWeekCycleForToolbar } from './week-cycle.js';
import {
    analyzeProfSlotsShift,
    defaultProfShiftEffectiveYmd,
    executeProfSlotsShift,
    formatProfShiftPrepareSummary
} from './prof-slots-shift-engine.js';
import { openPlanningRouteFromDrawer } from '../utils/planning-route-dialog.js';
import { openCourseStudentsPicker } from './course-students-picker.js';
import { focusPlanningDialogRoot } from '../utils/focus-planning-dialog.js';
import { populateTimeSelects } from '../utils/time-helpers.js';
import { setStudentsLineWithUsersIcon } from '../utils/template-cours-card-ui.js';

const ST_DELETE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7h6m2 0H7m2-3h6a1 1 0 011 1v1H8V5a1 1 0 011-1z"/></svg>';

const ST_DRAG_GRIP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>`;

/** @param {string} ownerId */
function profTintIndex(ownerId) {
    const s = String(ownerId || '0');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 8;
}

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

function setStGotoCalBusy(_busy) {
    /* Bouton Fermer retiré — conservé pour les appels existants. */
}

function setStGoogleSyncHintVisible(visible) {
    const el = document.getElementById('st-google-sync-hint');
    if (!el) return;
    el.classList.toggle('hidden', !visible);
}

function setStShiftBusyHint(visible) {
    document.getElementById('st-shift-busy-hint')?.classList.toggle('hidden', !visible);
}

function stShiftShowResult(text) {
    const ph = document.getElementById('st-shift-placeholder');
    const out = document.getElementById('st-shift-out');
    if (ph) ph.classList.add('hidden');
    if (out) {
        out.textContent = String(text || '').trim();
        out.classList.remove('hidden');
    }
}

function stShiftShowError(title, detail) {
    stShiftShowResult(`${title}\n${detail}`.trim());
}

function resetStShiftOutput() {
    const ph = document.getElementById('st-shift-placeholder');
    const out = document.getElementById('st-shift-out');
    if (ph) ph.classList.remove('hidden');
    if (out) {
        out.textContent = '';
        out.classList.add('hidden');
    }
}

/** Grise et désactive les actions pendant une opération réseau. Préparation / application aussi bloquées pendant la synchro Google en arrière-plan. */
function setStModalActionsBusy(busy) {
    const analyze = document.getElementById('st-btn-analyze');
    const apply = document.getElementById('st-btn-apply');
    const shift = document.getElementById('st-btn-shift');
    const analyzeApplyLocked = busy || stGoogleSyncInFlight;

    for (const btn of [analyze, shift]) {
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
                  '——— Conflits avec d’autres professeurs ———',
                  'Aucun conflit : tous les créneaux du gabarit peuvent être posés.',
                  ''
              ]
            : [
                  '——— Conflits avec d’autres professeurs ———',
                  `${skipped} créneau(x) en chevauchement. À l’application, confirmation puis suppression de ces créneaux avant de poser le vôtre.`,
                  ''
              ];
    return [
        alternanceLine,
        '',
        'Les créneaux des autres professeurs ne sont pas modifiés.',
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
        'Vérifiez le résumé puis « 2. Appliquer » : la base est mise à jour en premier (grille visible tout de suite), puis Google en arrière-plan par lots (général puis élèves inscrits). Pendant la synchro Google, les boutons Préparer / Appliquer restent indisponibles jusqu’à la fin.'
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
/** @type {HTMLElement | null} */
let stDnDRow = null;
/** @type {Map<string, object>} */
let stElevesByIdRef = new Map();
/** @type {HTMLElement | null} */
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

function familyNameOnly(label) {
    const parts = String(label || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (!parts.length) return '—';
    return parts.length > 1 ? parts[parts.length - 1] : parts[0];
}

/** @param {{ nom?: string, prenom?: string, display_name?: string, email?: string }} e */
function elevePrenomVirguleNom(e) {
    const n = String(e?.nom || '').trim();
    const p = String(e?.prenom || '').trim();
    if (p && n) return `${p} ${n}`;
    if (p || n) return p || n;
    const d = String(e?.display_name || '').trim();
    if (d) return d;
    return String(e?.email || '').trim() || '—';
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

/** @param {string[]} ids @param {Map<string, object>} byId */
function enrolledStudentsCommaLine(ids, byId) {
    const rows = [];
    for (const id of ids || []) {
        const e = byId.get(id);
        rows.push({
            nom: String(e?.nom || '').toLowerCase(),
            prenom: String(e?.prenom || '').toLowerCase(),
            label: e ? elevePrenomVirguleNom(e) : id
        });
    }
    rows.sort((a, b) => {
        const c = a.nom.localeCompare(b.nom, 'fr');
        if (c !== 0) return c;
        return a.prenom.localeCompare(b.prenom, 'fr');
    });
    if (!rows.length) return '';
    return rows.map((r) => r.label).join(', ');
}

/** @param {HTMLElement | null} listEl */
function sortTemplateListDOM(listEl) {
    if (!listEl) return;
    const cards = [...listEl.querySelectorAll('.st-slot-card[data-st-line]')];
    cards.sort((a, b) => {
        const da = parseInt(a.dataset.stDow || '1', 10);
        const db = parseInt(b.dataset.stDow || '1', 10);
        if (da !== db) return da - db;
        return padTime(a.dataset.stStart).localeCompare(padTime(b.dataset.stStart));
    });
    for (const card of cards) listEl.appendChild(card);
}

/** @param {HTMLElement} profEl @param {HTMLElement} card */
function renderProfTwoLines(profEl, card) {
    const prenom = String(card.dataset.stOwnerPrenom || '').trim();
    const nom = String(card.dataset.stOwnerNom || '').trim();
    profEl.replaceChildren();
    if (!prenom && !nom) {
        const label = String(card.dataset.stOwnerLabel || '').trim();
        if (!label) {
            profEl.textContent = '—';
            return;
        }
        const parts = label.split(/\s+/).filter(Boolean);
        if (parts.length <= 1) {
            profEl.textContent = label;
            return;
        }
        const l1 = document.createElement('span');
        l1.className = 'block leading-snug';
        l1.textContent = parts[0];
        const l2 = document.createElement('span');
        l2.className = 'block leading-snug';
        l2.textContent = parts.slice(1).join(' ');
        profEl.appendChild(l1);
        profEl.appendChild(l2);
        return;
    }
    if (prenom) {
        const l1 = document.createElement('span');
        l1.className = 'block leading-snug';
        l1.textContent = prenom;
        profEl.appendChild(l1);
    }
    if (nom) {
        const l2 = document.createElement('span');
        l2.className = 'block leading-snug';
        l2.textContent = nom;
        profEl.appendChild(l2);
    }
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

/** @param {HTMLElement} card */
function stWeekLetterForCard(card) {
    return card.closest('#st-list-b') ? 'B' : 'A';
}

/** @param {HTMLElement} card */
function stSlotEditRouteTitle(card) {
    const dow = dowLongLabel(parseInt(card.dataset.stDow || '1', 10));
    const st = padTime(card.dataset.stStart);
    const en = padTime(card.dataset.stEnd);
    return `${dow} / ${st} – ${en}`;
}

/** @param {HTMLElement} card */
function stStudentsEditRouteTitle(card) {
    return `${stSlotEditRouteTitle(card)} / Élèves inscrits`;
}

/** @param {object} r @param {string} lineId @param {HTMLElement | null} listA @param {HTMLElement | null} listB */
function syncTemplateCardLineId(r, lineId, listA, listB) {
    const list = r.week_type === 'B' ? listB : listA;
    if (!list || !lineId) return;
    for (const card of list.querySelectorAll('.st-slot-card[data-st-line]')) {
        const domId = card.getAttribute('data-line-id') || '';
        if (domId && domId === r.domId) {
            card.setAttribute('data-line-id', lineId);
            r.domId = lineId;
            return;
        }
        const typ = card.dataset.stSlotType === 'reservation' ? 'reservation' : 'cours';
        if (
            (!domId || domId.startsWith('new-')) &&
            typ === r.slot_type &&
            Number(card.dataset.stDow) === r.day_of_week &&
            `${padTime(card.dataset.stStart)}:00` === r.start_time &&
            `${padTime(card.dataset.stEnd)}:00` === r.end_time
        ) {
            card.setAttribute('data-line-id', lineId);
            r.domId = lineId;
            return;
        }
    }
}

/** Met à jour les libellés lisibles (sans listes factices) à partir des data-* de carte. */
function syncRowReadonlyDisplay(card, elevesById) {
    const typ = card.dataset.stSlotType || 'cours';
    const dow = parseInt(card.dataset.stDow || '1', 10);
    const periodEl = card.querySelector('.st-ro-period');
    if (periodEl) {
        periodEl.replaceChildren();
        const l1 = document.createElement('div');
        l1.className = 'gabarit-cours-card__day leading-snug';
        l1.textContent = dowLongLabel(dow);
        const l2 = document.createElement('div');
        l2.className = 'font-mono text-[10px] opacity-90 mt-0.5';
        l2.textContent = `${padTime(card.dataset.stStart)} – ${padTime(card.dataset.stEnd)}`;
        periodEl.appendChild(l1);
        periodEl.appendChild(l2);
        if (card.classList.contains('st-slot-card--off-teaching-day')) {
            const l3 = document.createElement('p');
            l3.className = 'text-[9px] text-amber-800 dark:text-amber-200 m-0 mt-1 leading-snug';
            l3.textContent = `Hors vos jours (${formatTeachingDaysShort(stTeachingDaysSet)}) — supprimez ou modifiez vos jours en haut.`;
            periodEl.appendChild(l3);
        }
    }
    const headlineEl = card.querySelector('.st-ro-headline');
    if (headlineEl) {
        const title = String(card.dataset.stTitle || '').trim() || slotTypeLabel(typ);
        headlineEl.textContent = title;
    }
    const roStudents = card.querySelector('.st-ro-students');
    if (!roStudents) return;
    if (roStudents.classList.contains('hidden') || roStudents.hasAttribute('hidden')) return;
    if (typ !== 'cours') {
        roStudents.textContent = '—';
        const profElRes = card.querySelector('.st-ro-prof');
        if (profElRes) renderProfTwoLines(profElRes, card);
        applyStSlotRowColors(card);
        return;
    }
    const ids = String(card.dataset.stStudents || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    setStudentsLineWithUsersIcon(
        roStudents,
        enrolledStudentsCommaLine(ids, elevesById) || "pas d'élèves"
    );
    const profEl = card.querySelector('.st-ro-prof');
    if (profEl) renderProfTwoLines(profEl, card);
    applyStSlotRowColors(card);
}

function applyStSlotRowColors(card) {
    const typ = card.dataset.stSlotType || 'cours';
    const lineOwnerId = card.getAttribute('data-owner-id') || '';
    const currentUserId = String(getPlanningSessionUser()?.id || '');
    card.classList.remove('st-row-cours', 'st-row-travail', 'st-row-other-prof');
    if (typ === 'cours') {
        card.classList.add('st-row-cours');
        if (lineOwnerId && lineOwnerId !== currentUserId) {
            card.classList.add('st-row-other-prof');
        }
    } else {
        card.classList.add('st-row-travail');
    }
}

function parseRowsFromList(listEl, weekLetter, ownerId) {
    const rows = [];
    for (const el of listEl?.querySelectorAll('.st-slot-card[data-st-line]') || []) {
        if (el.getAttribute('data-st-editable') !== '1') continue;
        const id = el.getAttribute('data-line-id') || '';
        const dow = parseInt(el.dataset.stDow || '1', 10);
        const st = padTime(el.dataset.stStart);
        const en = padTime(el.dataset.stEnd);
        const typ = el.dataset.stSlotType === 'reservation' ? 'reservation' : 'cours';
        const title = String(el.dataset.stTitle || '').trim();
        const studs =
            typ === 'cours'
                ? String(el.dataset.stStudents || '')
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
    const btn = document.getElementById('stle-students-manage-btn');
    const labels = enrolledLabelsSorted(stLineEditPendingStudents, stElevesByIdRef);
    if (el) {
        setStudentsLineWithUsersIcon(el, labels.length ? labels.join(', ') : '', {
            emptyFallback: 'Aucun inscrit'
        });
    }
    if (btn instanceof HTMLButtonElement) {
        btn.textContent = labels.length
            ? `Gérer les inscrits (${labels.length})`
            : 'Gérer les inscrits';
    }
}

/** @type {ReturnType<typeof setTimeout> | null} */
let stSaveDebounce = null;
/** Jours d’enseignement du prof courant (1–7). Vide = pas encore configuré. */
let stTeachingDaysSet = new Set();

function scheduleStAutoSave() {
    const u = getPlanningSessionUser();
    if (!u?.id || isAdmin(u)) return;
    if (stSaveDebounce) clearTimeout(stSaveDebounce);
    stSaveDebounce = setTimeout(() => {
        void runSemainesTypesSaveGabarit({ silent: true });
    }, 700);
}

function showStMainPanel() {
    const dlg = document.getElementById('modal_st_slot_edit');
    if (dlg instanceof HTMLDialogElement && dlg.open) dlg.close();
    stLineEditTargetTr = null;
}

function applyStSlotEditFormToCard(opts = {}) {
    const skipSave = Boolean(opts.skipSave);
    const card = stLineEditTargetTr;
    if (!card) return false;
    const typRaw = document.querySelector('#modal_st_slot_edit input[name="stle-slot-type"]:checked')?.value;
    const typ = typRaw === 'reservation' ? 'reservation' : 'cours';
    const dow = parseInt(
        /** @type {HTMLSelectElement | null} */ (document.getElementById('stle-dow'))?.value || '1',
        10
    );
    const st = padTime(/** @type {HTMLSelectElement | null} */ (document.getElementById('stle-start'))?.value);
    const en = padTime(/** @type {HTMLSelectElement | null} */ (document.getElementById('stle-end'))?.value);
    const title = String(/** @type {HTMLInputElement | null} */ (document.getElementById('stle-title'))?.value || '').trim();
    if (st >= en) {
        showToast('L’heure de fin doit être après le début.', 'error');
        return false;
    }
    card.dataset.stSlotType = typ;
    card.dataset.stDow = String(Math.min(7, Math.max(1, dow)));
    card.dataset.stStart = st;
    card.dataset.stEnd = en;
    card.dataset.stTitle = title;
    card.dataset.stStudents = typ === 'cours' ? stLineEditPendingStudents.join(',') : '';
    card.classList.remove('st-row-cours', 'st-row-travail', 'st-row-other-prof');
    card.classList.add(typ === 'cours' ? 'st-row-cours' : 'st-row-travail');
    syncRowReadonlyDisplay(card, stElevesByIdRef);
    sortTemplateListDOM(card.closest('.st-slot-list'));
    if (!skipSave) scheduleStAutoSave();
    return true;
}

function wireStLineEditModal() {
    const dlg = document.getElementById('modal_st_slot_edit');
    if (!dlg || dlg.dataset.stleWired === '1') return;
    dlg.dataset.stleWired = '1';
    populateTimeSelects('stle-start', 'stle-end');

    const onFieldChange = () => {
        applyStSlotEditFormToCard();
    };
    dlg.addEventListener('change', onFieldChange);
    dlg.addEventListener('input', (ev) => {
        const t = ev.target;
        if (t instanceof HTMLInputElement && t.id === 'stle-title') onFieldChange();
    });
    dlg.addEventListener('change', (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLInputElement) || t.name !== 'stle-slot-type') return;
        const wrap = document.getElementById('stle-students-wrap');
        wrap?.classList.toggle('hidden', t.value !== 'cours');
    });

    document.getElementById('stle-students-manage-btn')?.addEventListener('click', () => {
        void (async () => {
            const eleves = await loadEleves();
            const picked = await openCourseStudentsPicker({
                title: 'Inscriptions au cours',
                eleves,
                selectedUserIds: [...stLineEditPendingStudents]
            });
            if (picked === null) return;
            stLineEditPendingStudents = picked;
            refreshStleStudentSummary();
            applyStSlotEditFormToCard();
        })();
    });

    document.getElementById('stle-btn-apply')?.addEventListener('click', () => {
        applyStSlotEditFormToCard();
        dlg.close();
    });
    document.getElementById('stle-btn-cancel')?.addEventListener('click', () => dlg.close());

    document.getElementById('stle-delete-btn')?.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const card = stLineEditTargetTr;
        if (!card) return;
        if (!window.confirm('Supprimer ce créneau du gabarit ?')) return;
        card.remove();
        showStMainPanel();
        scheduleStAutoSave();
    });

    dlg.addEventListener('close', () => {
        if (stLineEditTargetTr) applyStSlotEditFormToCard();
        stLineEditTargetTr = null;
    });
}

function renderStStudentsEditLists() {
    const inEl = document.getElementById('st-students-list-in');
    const outEl = document.getElementById('st-students-list-out');
    if (!inEl || !outEl) return;
    const inSet = new Set(stLineEditPendingStudents);
    const rows = [...stElevesByIdRef.values()].map((e) => ({
        id: String(e.user_id),
        label: elevePrenomVirguleNom(e)
    }));
    rows.sort((a, b) => a.label.localeCompare(b.label, 'fr', { sensitivity: 'base' }));
    const mk = (id, label, enrolled) =>
        `<button type="button" draggable="true" class="st-student-pick-card ${enrolled ? 'st-student-pick-card--in' : 'st-student-pick-card--out'}" data-user-id="${escapeAttr(id)}">${escapeAttr(label)}</button>`;
    const inRows = rows.filter((r) => inSet.has(r.id));
    const outRows = rows.filter((r) => !inSet.has(r.id));
    inEl.innerHTML = inRows.length
        ? inRows.map((r) => mk(r.id, r.label, true)).join('')
        : '<p class="text-[10px] text-slate-400">Aucun inscrit.</p>';
    outEl.innerHTML = outRows.length
        ? outRows.map((r) => mk(r.id, r.label, false)).join('')
        : '<p class="text-[10px] text-slate-400">Tous les élèves sont inscrits.</p>';
}

function wireStStudentsDnDOnce() {
    const panel = document.getElementById('st-students-edit-panel');
    if (!panel || panel.dataset.dndWired === '1') return;
    panel.dataset.dndWired = '1';

    const toggle = (id) => {
        if (!id || !stElevesByIdRef.has(id)) return;
        const set = new Set(stLineEditPendingStudents);
        if (set.has(id)) set.delete(id);
        else set.add(id);
        stLineEditPendingStudents = [...set];
        renderStStudentsEditLists();
        refreshStleStudentSummary();
        applyStSlotEditFormToCard();
    };

    panel.addEventListener('click', (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('.st-student-pick-card') : null;
        if (!btn) return;
        toggle(btn.getAttribute('data-user-id') || '');
    });

    const onDragStart = (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('.st-student-pick-card') : null;
        if (!btn) return;
        ev.dataTransfer?.setData('text/plain', btn.getAttribute('data-user-id') || '');
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
    };
    panel.addEventListener('dragstart', onDragStart);

    const onDrop = (listEl, enroll) => (ev) => {
        ev.preventDefault();
        listEl?.classList.remove('st-dnd-drop-active');
        const id = String(ev.dataTransfer?.getData('text/plain') || '').trim();
        if (!id) return;
        const set = new Set(stLineEditPendingStudents);
        const has = set.has(id);
        if (enroll && !has) set.add(id);
        if (!enroll && has) set.delete(id);
        stLineEditPendingStudents = [...set];
        renderStStudentsEditLists();
        refreshStleStudentSummary();
        applyStSlotEditFormToCard();
    };

    const inEl = document.getElementById('st-students-list-in');
    const outEl = document.getElementById('st-students-list-out');
    inEl?.addEventListener('dragover', (e) => {
        e.preventDefault();
        inEl.classList.add('st-dnd-drop-active');
    });
    outEl?.addEventListener('dragover', (e) => {
        e.preventDefault();
        outEl.classList.add('st-dnd-drop-active');
    });
    inEl?.addEventListener('dragleave', () => inEl.classList.remove('st-dnd-drop-active'));
    outEl?.addEventListener('dragleave', () => outEl.classList.remove('st-dnd-drop-active'));
    inEl?.addEventListener('drop', onDrop(inEl, true));
    outEl?.addEventListener('drop', onDrop(outEl, false));
}

function openStStudentsEditPanel() {
    const card = stLineEditTargetTr;
    if (!card) return;
    wireStStudentsDnDOnce();
    renderStStudentsEditLists();
    document.getElementById('stle-students-wrap')?.classList.remove('hidden');
}

function openStSlotEditPanel(card) {
    wireStLineEditModal();
    stLineEditTargetTr = card;
    const typ = card.dataset.stSlotType === 'reservation' ? 'reservation' : 'cours';
    const coursRadio = /** @type {HTMLInputElement | null} */ (document.getElementById('stle-type-cours'));
    const resRadio = /** @type {HTMLInputElement | null} */ (document.getElementById('stle-type-reservation'));
    if (coursRadio) coursRadio.checked = typ === 'cours';
    if (resRadio) resRadio.checked = typ === 'reservation';

    const dowSel = /** @type {HTMLSelectElement | null} */ (document.getElementById('stle-dow'));
    syncTeachingDaySelectOptions(dowSel, stTeachingDaysSet);
    if (dowSel) dowSel.value = String(Math.min(7, Math.max(1, parseInt(card.dataset.stDow || '1', 10))));

    const stIn = /** @type {HTMLSelectElement | null} */ (document.getElementById('stle-start'));
    const enIn = /** @type {HTMLSelectElement | null} */ (document.getElementById('stle-end'));
    const stVal = padTime(card.dataset.stStart);
    const enVal = padTime(card.dataset.stEnd);
    if (stIn) {
        if (![...stIn.options].some((o) => o.value === stVal)) {
            stIn.add(new Option(stVal, stVal));
        }
        stIn.value = stVal;
    }
    if (enIn) {
        if (![...enIn.options].some((o) => o.value === enVal)) {
            enIn.add(new Option(enVal, enVal));
        }
        enIn.value = enVal;
    }

    const ti = /** @type {HTMLInputElement | null} */ (document.getElementById('stle-title'));
    if (ti) ti.value = String(card.dataset.stTitle || '').trim();

    stLineEditPendingStudents = String(card.dataset.stStudents || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    refreshStleStudentSummary();

    const studentsWrap = document.getElementById('stle-students-wrap');
    studentsWrap?.classList.toggle('hidden', typ !== 'cours');

    const titleEl = document.getElementById('stle-dialog-title');
    if (titleEl) titleEl.textContent = stSlotEditRouteTitle(card);

    const dlg = document.getElementById('modal_st_slot_edit');
    if (dlg instanceof HTMLDialogElement) {
        dlg.classList.remove('planning-route-page');
        dlg.showModal();
        focusPlanningDialogRoot(dlg);
    }
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
 * @param {HTMLElement} listEl
 * @param {object | null} line
 * @param {string} _optHtml réservé compat appelants (non utilisé — données élèves via data-students + édition modale).
 * @param {{ isAdmin: boolean, ownerLabel: string, lineOwnerId: string, currentUserId: string, elevesById: Map<string, object> }} ctx
 */
function appendTemplateCard(listEl, line, _optHtml, ctx) {
    const { isAdmin, ownerLabel, ownerPrenom, ownerNom, lineOwnerId, currentUserId, elevesById } = ctx;
    const isOwnRow = String(lineOwnerId) === String(currentUserId);
    const isEleve = String(getPlanningSessionUser()?.role || '').toLowerCase() === 'eleve';
    const dowN = Math.min(7, Math.max(1, Number(line?.day_of_week) || 1));
    const isOffTeachingDay = false;
    const isReadonly = isAdmin || !isOwnRow || isEleve || isOffTeachingDay;
    const slotT = line?.slot_type === 'reservation' ? 'reservation' : 'cours';
    const sid = line?.studentIds || [];

    const weekLetter = line?.week_type === 'B' ? 'B' : 'A';
    const card = document.createElement('div');
    card.className = isEleve
        ? 'st-slot-card st-slot-card--eleve-view grid grid-cols-[minmax(5rem,0.95fr)_minmax(0,1.1fr)_minmax(0,0.95fr)] gap-2 items-stretch rounded-lg border border-slate-200/90 px-2 py-2 min-w-0 text-[10px] text-slate-800'
        : 'st-slot-card grid grid-cols-[auto_minmax(5.5rem,1.15fr)_minmax(0,1fr)_minmax(0,0.95fr)] gap-2 items-stretch rounded-lg border border-slate-200/90 px-2 py-2 min-w-0 text-[10px] text-slate-800';
    card.classList.add(`st-slot-card--prof-tint-${profTintIndex(lineOwnerId)}`);
    if (isOffTeachingDay) card.classList.add('st-slot-card--off-teaching-day');
    if (!isReadonly) card.classList.add('st-slot-card--editable');
    card.setAttribute('data-st-line', '1');
    card.setAttribute('data-line-id', line?.id || '');
    card.setAttribute('data-owner-id', lineOwnerId);
    card.setAttribute('data-st-editable', isReadonly ? '0' : '1');

    card.dataset.stSlotType = slotT;
    card.dataset.stDow = String(line?.day_of_week ?? 1);
    card.dataset.stStart = String(line?.start_time || '08:00:00').slice(0, 5);
    card.dataset.stEnd = String(line?.end_time || '09:00:00').slice(0, 5);
    card.dataset.stTitle = String(line?.title || '').trim();
    card.dataset.stStudents = sid.join(',');
    card.dataset.stOwnerLabel = ownerLabel;
    card.dataset.stOwnerPrenom = ownerPrenom || '';
    card.dataset.stOwnerNom = ownerNom || '';

    const dragHtml = isReadonly
        ? '<span class="w-0" aria-hidden="true"></span>'
        : `<span class="st-drag-handle inline-flex cursor-grab active:cursor-grabbing text-slate-400 hover:text-slate-600 p-0.5 rounded hover:bg-slate-100 shrink-0 self-center" draggable="true" title="Glisser vers l’autre semaine type" aria-label="Glisser vers l’autre semaine type">${ST_DRAG_GRIP_SVG}</span>`;

    if (isEleve) {
        card.innerHTML = `
        <div class="st-slot-card__left min-w-0 self-stretch flex flex-col justify-center py-0.5">
            <div class="st-ro-period leading-snug"></div>
        </div>
        <div class="st-slot-card__right min-w-0 flex flex-col justify-center py-0.5">
            <p class="gabarit-cours-card__title st-ro-headline m-0 leading-snug"></p>
            <p class="st-ro-students text-[10px] font-normal text-slate-700 dark:text-slate-300 m-0 leading-snug break-words"></p>
        </div>
        <div class="st-slot-card__prof min-w-0 self-stretch flex items-center justify-end py-0.5">
            <span class="st-ro-prof text-[10px] font-medium text-slate-600 dark:text-slate-300 leading-snug block text-right"></span>
        </div>`;
    } else {
        card.innerHTML = `
        ${dragHtml}
        <div class="st-slot-card__left min-w-0 border-r border-slate-200/80 dark:border-slate-500/50 pr-2 self-stretch flex flex-col justify-center py-0.5">
            <div class="st-ro-period leading-snug"></div>
        </div>
        <div class="st-slot-card__right min-w-0 pl-1 flex flex-col gap-0.5 self-stretch justify-center py-0.5">
            <p class="gabarit-cours-card__title st-ro-headline m-0 leading-snug"></p>
            <p class="st-ro-students text-[10px] font-normal text-slate-700 dark:text-slate-300 m-0 leading-snug break-words"></p>
        </div>
        <div class="st-slot-card__prof min-w-0 border-l border-slate-200/80 dark:border-slate-500/50 pl-2 self-stretch flex items-center py-0.5">
            <span class="st-ro-prof text-[10px] font-medium text-slate-600 dark:text-slate-300 leading-snug block"></span>
        </div>`;
    }

    syncRowReadonlyDisplay(card, elevesById);
    if (!isReadonly) {
        card.classList.add('st-slot-card--tap-edit');
        card.addEventListener('click', (ev) => {
            const t = ev.target;
            if (!(t instanceof Element)) return;
            if (t.closest('.st-drag-handle')) return;
            openStSlotEditPanel(card);
        });
    }
    listEl.appendChild(card);
    return card;
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

/** @param {string[]} userIds @returns {Promise<Map<string, { label: string, prenom: string, nom: string }>>} */
async function loadOwnerProfiles(userIds) {
    const uniq = [...new Set((userIds || []).filter(Boolean))];
    const labels = await loadOwnerLabels(uniq);
    const m = new Map();
    if (!uniq.length) return m;
    const sb = getSupabaseClient();
    if (sb) {
        const { data, error } = await sb.from('profiles').select('id, prenom, nom').in('id', uniq);
        if (!error) {
            for (const row of data || []) {
                const id = String(row.id);
                m.set(id, {
                    label: labels.get(id) || id.slice(0, 8),
                    prenom: String(row.prenom || '').trim(),
                    nom: String(row.nom || '').trim()
                });
            }
        }
    }
    for (const id of uniq) {
        if (!m.has(id)) {
            m.set(id, { label: labels.get(id) || id.slice(0, 8), prenom: '', nom: '' });
        }
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

function readTeachingDaysFromForm() {
    const set = new Set();
    for (const cb of document.querySelectorAll('.st-teaching-day-cb')) {
        if (!(cb instanceof HTMLInputElement) || !cb.checked) continue;
        const n = parseInt(cb.value, 10);
        if (n >= 1 && n <= 7) set.add(n);
    }
    return set;
}

function writeTeachingDaysToForm(set) {
    for (const cb of document.querySelectorAll('.st-teaching-day-cb')) {
        if (!(cb instanceof HTMLInputElement)) continue;
        const n = parseInt(cb.value, 10);
        cb.checked = set.has(n);
    }
}

async function saveTeachingDaysFromModal(user) {
    const set = readTeachingDaysFromForm();
    const r = await saveTeachingDaysForUser(user.id, set);
    if (!r.ok) {
        showToast(r.error || 'Enregistrement impossible.', 'error');
        return false;
    }
    stTeachingDaysSet = set;
    const hint = document.getElementById('st-teaching-days-hint');
    if (hint) {
        hint.textContent = `Enregistré : ${formatTeachingDaysShort(set)}.`;
        hint.classList.remove('hidden');
    }
    showToast('Jours d’enseignement enregistrés.', 'success');
    return true;
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
    if (!isProf(user)) {
        showToast('Semaines A/B : réservé aux professeurs.', 'info');
        return;
    }
    showStMainPanel();
    invalidateOrganSchoolSettingsCache();
    await fetchOrganSchoolSettings();

    document.getElementById('st-tap-hint')?.classList.remove('hidden');
    document.getElementById('st-main-panel')?.classList.remove('st-main-panel--eleve');
    document.getElementById('st-gabarit-section')?.classList.remove('st-gabarit-section--eleve');
    document.getElementById('st-add-row-a')?.classList.remove('hidden');
    document.getElementById('st-add-row-b')?.classList.remove('hidden');
    document.getElementById('st-gabarit-actions')?.classList.remove('hidden');
    document.getElementById('st-actions-section')?.classList.remove('hidden');
    document.getElementById('st-teaching-days-section')?.classList.add('hidden');
    document.getElementById('st-gabarit-prof-title')?.classList.add('hidden');

    const eleves = await loadEleves();
    const elevesById = new Map(eleves.map((e) => [e.user_id, e]));
    const optHtml = makeStudentOptionsHtml(eleves);
    const { lines, byLineStudents } = await loadLinesForModal();
    const ownerIds = [...new Set(lines.map((l) => l.owner_user_id).filter(Boolean))];
    const ownerProfiles = await loadOwnerProfiles(ownerIds);

    const ta = document.getElementById('st-list-a');
    const tb = document.getElementById('st-list-b');
    if (ta) ta.replaceChildren();
    if (tb) tb.replaceChildren();

    const ctxBase = {
        isAdmin: false,
        currentUserId: String(user.id),
        elevesById
    };
    stElevesByIdRef = elevesById;

    const linesForModal = lines.filter((l) => String(l.owner_user_id || '') === String(user.id));

    for (const line of linesForModal) {
        const listEl = line.week_type === 'A' ? ta : tb;
        if (!listEl) continue;
        const sid = byLineStudents.get(line.id) || [];
        const oid = String(line.owner_user_id || '');
        const prof = ownerProfiles.get(oid) || { label: oid.slice(0, 8), prenom: '', nom: '' };
        appendTemplateCard(listEl, { ...line, studentIds: sid }, optHtml, {
            ...ctxBase,
            ownerLabel: prof.label,
            ownerPrenom: prof.prenom,
            ownerNom: prof.nom,
            lineOwnerId: oid
        });
    }
    sortTemplateListDOM(ta);
    sortTemplateListDOM(tb);

}

function openStApplyModal() {
    const dlg = document.getElementById('modal_semaines_apply');
    if (!(dlg instanceof HTMLDialogElement)) return;
    const applyStart = document.getElementById('st-apply-start');
    if (applyStart instanceof HTMLInputElement) applyStart.value = defaultApplyStartYmd();
    const applyEnd = document.getElementById('st-apply-end');
    if (applyEnd instanceof HTMLInputElement) applyEnd.value = defaultApplyEndYmd();
    resetStAnalyzeOutput();
    lastAnalysis = null;
    setStApplyButtonReady(false);
    dlg.showModal();
    focusPlanningDialogRoot(dlg);
}

function openStShiftModal() {
    const dlg = document.getElementById('modal_semaines_shift');
    if (!(dlg instanceof HTMLDialogElement)) return;
    const shiftEffective = document.getElementById('st-shift-effective');
    if (shiftEffective instanceof HTMLInputElement) {
        shiftEffective.value = defaultProfShiftEffectiveYmd();
    }
    resetStShiftOutput();
    dlg.showModal();
    focusPlanningDialogRoot(dlg);
}

function addEmptyRow(listEl, elevesHtml, user, elevesById, ownerProfiles) {
    const oid = String(user.id);
    const prof = ownerProfiles.get(oid) || {
        label: user.email || oid.slice(0, 8),
        prenom: '',
        nom: ''
    };
    const card = appendTemplateCard(
        listEl,
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
            ownerLabel: prof.label,
            ownerPrenom: prof.prenom,
            ownerNom: prof.nom,
            lineOwnerId: oid,
            currentUserId: oid,
            elevesById
        }
    );
    sortTemplateListDOM(listEl);
    // Fix UX : forcer la ligne nouvellement ajoutée à être visible.
    requestAnimationFrame(() => {
        if (!card) return;
        try {
            card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } catch {
            card.scrollIntoView();
        }
        card.classList.add('ring-2', 'ring-sky-500');
        window.setTimeout(() => card.classList.remove('ring-2', 'ring-sky-500'), 1200);
    });
}

async function runSemainesTypesSaveGabarit(opts = {}) {
    const silent = Boolean(opts.silent);
    const u = getPlanningSessionUser();
    const sb = getSupabaseClient();
    if (!u?.id || !sb || isAdmin(u)) return;
    const ta = document.getElementById('st-list-a');
    const tb = document.getElementById('st-list-b');
    const ra = parseRowsFromList(ta, 'A', u.id);
    const rb = parseRowsFromList(tb, 'B', u.id);
    const all = [...ra, ...rb];
    const err = validateNoOverlap(all);
    if (err) {
        showToast(err, 'error');
        return;
    }
    setStModalActionsBusy(true);
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
                syncTemplateCardLineId(r, lineId, ta, tb);
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
    } finally {
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
            const dow = Number(ln.day_of_week) || 1;
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
        const conflictLines = formatTemplateOtherProfConflictLines(analysis.otherProfConflicts);
        if (conflictLines.length) {
            stAnalyzeShowResult(
                `${summaryText}\n\n——— Détail des conflits ———\n${conflictLines.join('\n')}`
            );
        } else {
            stAnalyzeShowResult(summaryText);
        }
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
    const conflicts = lastAnalysis?.otherProfConflicts || [];
    if (conflicts.length) {
        const lines = formatTemplateOtherProfConflictLines(conflicts);
        const ok = confirm(
            [
                `${conflicts.length} créneau(x) d’un autre professeur chevauchent votre gabarit.`,
                'En continuant, ces créneaux seront supprimés (comme une suppression normale), puis votre gabarit sera appliqué.',
                '',
                ...lines.slice(0, 15),
                lines.length > 15 ? `… et ${lines.length - 15} autre(s).` : '',
                '',
                'Confirmer l’écrasement et l’application ?'
            ]
                .filter(Boolean)
                .join('\n')
        );
        if (!ok) return;
        setStModalActionsBusy(true);
        try {
            for (const c of conflicts) {
                const id = String(c.planningEventId || '').trim();
                if (!id) continue;
                const dr = await deletePlanningSlotForClosureConflict(
                    {
                        id,
                        title: c.title,
                        owner_email: c.ownerEmail,
                        start_at: c.start instanceof Date ? c.start.toISOString() : c.start,
                        end_at: c.end instanceof Date ? c.end.toISOString() : c.end
                    },
                    u
                );
                if (!dr.ok) {
                    showToast(dr.error || 'Suppression d’un conflit impossible.', 'error');
                    return;
                }
            }
        } finally {
            setStModalActionsBusy(false);
        }
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
                        'Libellé « Semaine A (vous) / B (vous) » dans la barre du planning : uniquement en vue Semaine, Jour ou liste Planning (pas en vue Mois).',
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
    const card = h.closest('.st-slot-card[data-st-line]');
    if (!(card instanceof HTMLElement) || card.getAttribute('data-st-editable') !== '1') return;
    stDnDRow = card;
    e.dataTransfer?.setData('text/plain', 'semaines-types-row');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    card.classList.add('opacity-40');
}

function onStTemplateDragEnd() {
    if (stDnDRow) stDnDRow.classList.remove('opacity-40');
    stDnDRow = null;
}

function onStTemplateDragOver(e) {
    if (!stDnDRow) return;
    const tb = e.target?.closest?.('#st-list-a, #st-list-b');
    if (!tb) return;
    const dlg = document.getElementById('modal_semaines_types');
    if (!dlg?.open || !dlg.contains(tb)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
}

function onStTemplateDrop(e) {
    const tb = e.target?.closest?.('#st-list-a, #st-list-b');
    if (!tb || !stDnDRow) return;
    const dlg = document.getElementById('modal_semaines_types');
    if (!dlg?.open || !dlg.contains(tb)) return;
    e.preventDefault();
    const src = stDnDRow.parentElement;
    if (src === tb) return;
    const u = getPlanningSessionUser();
    if (!u?.id) return;
    const listA = document.getElementById('st-list-a');
    const listB = document.getElementById('st-list-b');
    if (tb !== listA && tb !== listB) return;

    tb.appendChild(stDnDRow);
    const ra = parseRowsFromList(listA, 'A', u.id);
    const rb = parseRowsFromList(listB, 'B', u.id);
    const overlapErr = validateNoOverlap([...ra, ...rb]);
    if (overlapErr) {
        src.appendChild(stDnDRow);
        showToast(overlapErr, 'error');
    } else {
        scheduleStAutoSave();
    }
}

async function runSemainesTypesAddRow(week) {
    const u = getPlanningSessionUser();
    if (!u?.id) return;
    const eleves = await loadEleves();
    const elevesById = new Map(eleves.map((e) => [e.user_id, e]));
    stElevesByIdRef = elevesById;
    const ownerProfiles = await loadOwnerProfiles([u.id]);
    const listEl =
        week === 'B' ? document.getElementById('st-list-b') : document.getElementById('st-list-a');
    addEmptyRow(listEl, makeStudentOptionsHtml(eleves), u, elevesById, ownerProfiles);
}

async function runSemainesTypesShift() {
    const u = getPlanningSessionUser();
    if (!u?.email || !isProf(u)) return;
    if (stGoogleSyncInFlight) {
        showToast('Synchronisation Google du gabarit encore en cours.', 'info', 5000);
        return;
    }

    const effectiveYmd = document.getElementById('st-shift-effective')?.value?.trim() || '';
    const weeksRaw = document.querySelector('input[name="st-shift-weeks"]:checked')?.value;
    const weekDelta = weeksRaw === '2' ? 2 : 1;

    setStModalActionsBusy(true);
    setStShiftBusyHint(true);
    const shiftBtn = document.getElementById('st-btn-shift');
    const shiftLabelRest = shiftBtn?.getAttribute('data-label-rest') || 'Décaler mes créneaux';
    if (shiftBtn && !shiftBtn.getAttribute('data-label-rest')) {
        shiftBtn.setAttribute('data-label-rest', shiftLabelRest);
    }
    if (shiftBtn) shiftBtn.textContent = 'Vérification…';

    try {
        const analysis = await analyzeProfSlotsShift({
            profUserId: u.id,
            profEmail: u.email,
            effectiveYmd,
            weekDelta,
            profWeekCycle: getProfWeekCycleForToolbar()
        });

        if (!analysis.ok) {
            stShiftShowError('Décalage impossible', analysis.error || 'Aucun créneau à décaler.');
            showToast(analysis.error?.split('\n')[0] || 'Décalage impossible.', 'error', 8000);
            return;
        }

        stShiftShowResult(formatProfShiftPrepareSummary(analysis));

        const wLabel = weekDelta === 2 ? '2 semaines' : '1 semaine';
        let confirmMsg = `Décaler ${analysis.count} créneau(x) de +${wLabel} à partir du ${effectiveYmd} ?\n\nLa base est mise à jour en premier, puis Google Agenda. Votre repère semaine A/B en base ne change pas.`;
        if (analysis.conflictsToDelete?.length) {
            confirmMsg += `\n\n${analysis.conflictsToDelete.length} créneau(x) en conflit seront supprimés automatiquement.`;
        }
        if (analysis.partialAlternance?.partial) {
            confirmMsg += `\n\nAlternance A/B : certains jours de la semaine ne basculent pas comme les autres (fermetures / ponts). Les élèves d’un jour peuvent voir un décalage d’une semaine sans les autres.\n${(analysis.partialAlternance.lines || []).join('\n')}`;
        }
        if (!confirm(confirmMsg)) {
            return;
        }

        if (shiftBtn) shiftBtn.textContent = 'Décalage en cours…';
        const exec = await executeProfSlotsShift({
            profUserId: u.id,
            profEmail: u.email,
            effectiveYmd,
            weekDelta,
            currentUser: u,
            onProgress: (detail) => {
                if (shiftBtn && detail) shiftBtn.textContent = detail.slice(0, 40);
            },
            onDbComplete: () => {
                document.dispatchEvent(new CustomEvent('planning-events-changed'));
            }
        });

        if (!exec.ok) {
            stShiftShowError('Décalage interrompu', exec.error || 'Erreur inconnue.');
            showToast(exec.error?.split('\n')[0] || 'Décalage interrompu.', 'error', 8000);
            return;
        }

        const googleNote = exec.googleSkipped
            ? ' (Google non configuré — base seulement).'
            : ' Base et Google mis à jour.';
        stShiftShowResult(
            [
                `Décalage terminé : ${exec.count} créneau(x) déplacé(s) de +${wLabel}.`,
                googleNote,
                '',
                'Consultez le planning pour vérifier les nouvelles dates.'
            ].join('\n')
        );
        showToast(`${exec.count} créneau(x) décalé(s).`, 'success', 5000);
        document.dispatchEvent(new CustomEvent('planning-events-changed'));
    } catch (e) {
        console.error('[semaines-types] runSemainesTypesShift', e);
        const msg = String(e?.message || e);
        stShiftShowError('Erreur inattendue', msg);
        showToast(msg.split('\n')[0] || 'Erreur lors du décalage.', 'error', 8000);
    } finally {
        if (shiftBtn) shiftBtn.textContent = shiftLabelRest;
        setStShiftBusyHint(false);
        setStModalActionsBusy(false);
    }
}

/**
 * Clics dans la modale : délégation sur document (fiable même si le fragment HTML a été injecté
 * après un premier bind, ou si les boutons ont été recréés).
 */
function onSemainesTypesDocumentClick(e) {
    const t = e.target;
    if (!(t instanceof Element)) return;

    const applyDlg = document.getElementById('modal_semaines_apply');
    if (applyDlg?.open && applyDlg.contains(t)) {
        if (t.closest('#st-apply-close')) {
            e.preventDefault();
            applyDlg.close();
            return;
        }
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
        return;
    }

    const shiftDlg = document.getElementById('modal_semaines_shift');
    if (shiftDlg?.open && shiftDlg.contains(t)) {
        if (t.closest('#st-shift-close')) {
            e.preventDefault();
            shiftDlg.close();
            return;
        }
        if (t.closest('#st-btn-shift')) {
            e.preventDefault();
            const shiftBtn = document.getElementById('st-btn-shift');
            if (shiftBtn instanceof HTMLButtonElement && shiftBtn.disabled) return;
            void runSemainesTypesShift();
            return;
        }
        return;
    }

    const dlg = document.getElementById('modal_semaines_types');
    if (!dlg?.open || !dlg.contains(t)) return;

    if (t.closest('#st-open-apply-modal')) {
        e.preventDefault();
        openStApplyModal();
        return;
    }
    if (t.closest('#st-open-shift-modal')) {
        e.preventDefault();
        openStShiftModal();
        return;
    }
    if (t.closest('#st-teaching-days-save')) {
        e.preventDefault();
        const u = getPlanningSessionUser();
        if (u?.id && isProf(u)) void saveTeachingDaysFromModal(u);
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
}

export function initSemainesTypesUi() {
    if (!isBackendAuthConfigured()) return;
    if (stUiBound) return;
    stUiBound = true;

    stAbort?.abort();
    stAbort = new AbortController();
    const { signal } = stAbort;

    document.getElementById('menu-item-semaines-types')?.addEventListener(
        'click',
        (e) => {
            e.preventDefault();
            const u = getPlanningSessionUser();
            if (!u?.id) return;
            if (!isProf(u)) {
                showToast('Semaines A/B : réservé aux professeurs.', 'info');
                return;
            }
            if (!openPlanningRouteFromDrawer('modal_semaines_types', 'Semaines A / B', 'Menu')) {
                return;
            }
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
