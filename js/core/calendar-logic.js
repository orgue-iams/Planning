/**
 * Logique métier du calendrier
 * Rendu des événements, ouverture des modales et CRUD
 */

import { showPersistentToast, showToast } from '../utils/toast.js';
import { isCoarsePointerDevice } from '../utils/touch-handler.js';
import { setStudentsLineWithUsersIcon } from '../utils/template-cours-card-ui.js';
import { formatTimeFr24, formatWeekdayDayTimeFr24 } from '../utils/time-helpers.js';
import { getAccessToken, isBackendAuthConfigured, isPrivilegedUser } from './auth-logic.js';
import { bridgeDeleteEvent, invokeCalendarBridge } from './calendar-bridge.js';
import { invalidateCalendarListCache } from './calendar-events-list-cache.js';
import { getPlanningConfig, getSupabaseClient } from './supabase-client.js';
import { invokeSlotNotify } from './slot-notify-api.js';
import { isPlanningRole } from './planning-roles.js';
import {
    RESERVATION_MOTIFS,
    normalizeMotif,
    motifToSlotType,
    motifDisplayLabel,
    motifToPlanningDbSlotType
} from './reservation-motifs.js';
import {
    planningDbSlotTypeForEventUpdate,
    planningDbSlotTypeToBridgeType,
    upsertPlanningEventRow,
    deletePlanningEventRow,
    fetchPlanningMirrorTargetsForDelete,
    fetchPlanningEventRowsInRange,
    fetchPlanningMainPoolGoogleIdsForEvent,
    planningUserIdForEmail,
    fetchPlanningListElevesActifs,
    replacePlanningEventEnrollment,
    fetchPlanningEventEnrollmentUserIds
} from './planning-events-db.js';
import {
    fetchOrganSchoolSettings,
    getOrganSchoolSettingsCached,
    getSchoolYearBoundsFromSettings
} from './organ-settings.js';
import { openFermetureEditFromCalendarEvent } from './fermeture-edit-ui.js';
import {
    createPlanningEventSeries,
    createPlanningSeriesException,
    deletePlanningEventSeries,
    fetchPlanningEventSeriesByIds,
    fetchPlanningSeriesExceptionsBySeriesIds,
    updatePlanningEventSeries
} from './planning-series-db.js';
import { buildPlanningEventRowsFromSeries } from './planning-series-engine.js';
import { openIndispoSeriesResolutionModal } from './indispo-series-resolution-ui.js';
import {
    eleveBookingTooFarInFuture,
    eleveTravailWouldExceedWeeklyCap,
    mondayStartLocal,
    logEleveTravailVoidIfNeeded
} from './planning-eleve-quota.js';
import { openCourseStudentsPicker } from './course-students-picker.js';
import { openCoursSeriesScopeModal } from './cours-series-scope-ui.js';
import { syncOrganWeekTemplateLineFromOccurrence } from './template-line-schedule-sync.js';
import { focusPlanningDialogRoot } from '../utils/focus-planning-dialog.js';

/** @type {{ getCalendar: () => import('@fullcalendar/core').Calendar | null, getUser: () => object | null, getEvent: () => import('@fullcalendar/core').EventApi | null, setEvent: (ev: import('@fullcalendar/core').EventApi | null) => void } | null} */
let reservationAutoSaveDeps = null;

let reservationAutoSaveTimer = null;

/** Auto-enregistrement modale route (sans fermer). */
let reservationAutoSaveMode = false;

/**
 * @param {typeof reservationAutoSaveDeps} deps
 */
export function setReservationAutoSaveDeps(deps) {
    reservationAutoSaveDeps = deps;
}

function scheduleReservationAutoSave() {
    const deps = reservationAutoSaveDeps;
    const cal = deps?.getCalendar?.();
    if (!deps || !cal) return;
    if (reservationAutoSaveTimer) clearTimeout(reservationAutoSaveTimer);
    reservationAutoSaveTimer = setTimeout(() => {
        if (!isReservationModalDirty()) return;
        reservationAutoSaveMode = true;
        const eventForSave = reservationModalEventRef || deps.getEvent();
        void saveReservation(cal, deps.getUser(), eventForSave)
            .then(() => {
                syncReservationModalLiveEventRef();
                captureReservationModalFormBaseline();
            })
            .finally(() => {
                reservationAutoSaveMode = false;
            });
    }, 850);
}

let saveReservationInFlight = false;
let deleteReservationInFlight = false;
/** @type {AbortController | null} */
let reservationModalTimeSyncAbort = null;
/** @type {string | null} */
/** @type {Record<string, unknown> | null} */
let reservationModalFormBaseline = null;
/** @type {string | null} — type / slot_type / titre / inscrits à l’ouverture (annuler sans toucher au planning). */
let reservationModalEventPropsBaseline = null;
/** @type {import('@fullcalendar/core').Calendar | null} */
let reservationModalCalendarRef = null;
/** @type {import('@fullcalendar/core').EventApi | null} */
let reservationModalEventRef = null;
const SHOW_LEGACY_FERMETURE_EDIT_UI = false;
/** Libellé propriétaire pour l’en-tête modale (Prénom Nom). */
let reservationModalOwnerLabelRef = '';
/** Durée initiale du créneau à l’ouverture de la modale (ajustement fin si début change). */
let reservationModalInitialDurationMs = 60 * 60 * 1000;

export function isReservationMutationInFlight() {
    return saveReservationInFlight || deleteReservationInFlight;
}

function snapshotReservationModalFormState() {
    const val = (id) => {
        const el = document.getElementById(id);
        if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) return el.value;
        return '';
    };
    const chk = (id) => {
        const el = document.getElementById(id);
        return el instanceof HTMLInputElement && el.checked;
    };
    const multi = document.getElementById('event-inscrits-select');
    const inscrits = [];
    if (multi instanceof HTMLSelectElement) {
        for (const o of multi.options) {
            if (o.selected) inscrits.push(o.value);
        }
    }
    inscrits.sort();
    return JSON.stringify({
        motif: val('event-motif-select'),
        title: val('event-title-input'),
        date: val('event-date-start'),
        dateEnd: val('event-date-end'),
        start: val('event-start'),
        end: val('event-end'),
        repeatMode: val('event-repeat-mode'),
        repeatEndMode: val('event-repeat-end-mode'),
        repeatUntil: val('event-repeat-until'),
        repeatCount: val('event-repeat-count'),
        recurring: chk('event-recurring'),
        recurStart: val('event-recur-period-start'),
        recurEnd: val('event-recur-period-end'),
        recurTStart: val('event-recur-start'),
        recurTEnd: val('event-recur-end'),
        recurMode: chk('recur-mode-all') ? 'all' : 'days',
        owner: val('reservation-slot-owner-email'),
        dows: [1, 2, 3, 4, 5, 6, 0].map((i) => chk(`recur-dow-${i}`)),
        inscrits
    });
}

function applyReservationModalFormSnapshot(json) {
    let snap;
    try {
        snap = JSON.parse(json);
    } catch {
        return;
    }
    if (!snap || typeof snap !== 'object') return;
    const setVal = (id, v) => {
        const el = document.getElementById(id);
        if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.value = String(v ?? '');
    };
    const setChk = (id, v) => {
        const el = document.getElementById(id);
        if (el instanceof HTMLInputElement) el.checked = Boolean(v);
    };
    setVal('event-motif-select', snap.motif);
    setVal('event-title-input', snap.title);
    setVal('event-date-start', snap.date);
    setVal('event-date-end', snap.dateEnd || snap.date || '');
    setVal('event-start', snap.start);
    setVal('event-end', snap.end);
    setVal('event-repeat-mode', snap.repeatMode || 'once');
    setVal('event-repeat-end-mode', snap.repeatEndMode || 'until');
    setVal('event-repeat-until', snap.repeatUntil || '');
    setVal('event-repeat-count', snap.repeatCount || '');
    setChk('event-recurring', snap.recurring);
    setVal('event-recur-period-start', snap.recurStart);
    setVal('event-recur-period-end', snap.recurEnd);
    setVal('event-recur-start', snap.recurTStart);
    setVal('event-recur-end', snap.recurTEnd);
    if (snap.recurMode === 'all') {
        setChk('recur-mode-all', true);
        setChk('recur-mode-days', false);
    } else {
        setChk('recur-mode-all', false);
        setChk('recur-mode-days', true);
    }
    setVal('reservation-slot-owner-email', snap.owner);
    const dows = Array.isArray(snap.dows) ? snap.dows : [];
    const dowIds = [1, 2, 3, 4, 5, 6, 0];
    for (let j = 0; j < dowIds.length; j++) {
        setChk(`recur-dow-${dowIds[j]}`, Boolean(dows[j]));
    }
    const multi = document.getElementById('event-inscrits-select');
    const want = new Set(Array.isArray(snap.inscrits) ? snap.inscrits.map(String) : []);
    if (multi instanceof HTMLSelectElement) {
        for (const o of multi.options) {
            o.selected = want.has(o.value);
        }
    }
    syncReservationModalLiveEventRef();
    updateReservationInscritsWrapVisibility(reservationModalUserRef, reservationModalCanEditRef);
    refreshReservationInscritsSummary();
    setRecurringOptionsVisible();
    syncReservationDateWeekdayLabel();
    updateReservationModalHeadline(reservationModalEventRef);
    if (reservationModalCalendarRef?.getEvents) {
        syncReservationModalTimeOptions(reservationModalCalendarRef, reservationModalEventRef);
    }
}

/** @param {import('@fullcalendar/core').EventApi | null} event */
function snapshotReservationModalEventProps(event) {
    if (!event) return null;
    const xp = safeEventExtendedProps(event) || {};
    return JSON.stringify({
        type: String(xp.type || '').trim(),
        planningDbSlotType: String(xp.planningDbSlotType || '').trim(),
        title: String(event.title || '').trim(),
        inscrits: Array.isArray(xp.inscrits)
            ? xp.inscrits.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
            : []
    });
}

function restoreReservationModalEventPropsFromBaseline() {
    if (!reservationModalEventPropsBaseline || !reservationModalCalendarRef || !reservationModalEventRef) {
        return;
    }
    let snap;
    try {
        snap = JSON.parse(reservationModalEventPropsBaseline);
    } catch {
        return;
    }
    if (!snap || typeof snap !== 'object') return;
    const live = resolveLivePlanningEventRef(
        reservationModalCalendarRef,
        reservationModalEventRef
    );
    if (!live) return;
    try {
        if (typeof live.setProp === 'function' && snap.title !== undefined) {
            live.setProp('title', String(snap.title || ''));
        }
        if (typeof live.setExtendedProp === 'function') {
            live.setExtendedProp('type', String(snap.type || ''));
            live.setExtendedProp('planningDbSlotType', String(snap.planningDbSlotType || ''));
            live.setExtendedProp('inscrits', Array.isArray(snap.inscrits) ? [...snap.inscrits] : []);
        }
    } catch {
        /* référence FC retirée */
    }
}

/** Rétablit les champs tels qu’à l’ouverture de la modale (bouton Annuler). */
export function restoreReservationModalFormBaseline() {
    if (reservationModalFormBaseline === null) return;
    applyReservationModalFormSnapshot(reservationModalFormBaseline);
    restoreReservationModalEventPropsFromBaseline();
}

/**
 * Ferme la modale route réservation ; optionnellement enregistre d’abord (clic planning / Sauver).
 * @param {{ save?: boolean }} [options]
 */
export async function dismissReservationRouteDialog(options = {}) {
    const modal = document.getElementById('modal_reservation');
    if (!(modal instanceof HTMLDialogElement) || !modal.open) return;
    if (isReservationMutationInFlight()) return;
    const save = Boolean(options.save);
    if (save && reservationModalCanEditRef && reservationModalCalendarRef && reservationModalUserRef) {
        syncReservationModalLiveEventRef();
        reservationAutoSaveMode = true;
        let saved = false;
        try {
            saved = await saveReservation(
                reservationModalCalendarRef,
                reservationModalUserRef,
                reservationModalEventRef
            );
        } finally {
            reservationAutoSaveMode = false;
        }
        if (saved) modal.close();
        return;
    }
    if (!(await reservationModalMayCloseNow())) return;
    restoreReservationModalFormBaseline();
    modal.close();
}

/** À appeler après remplissage complet de la modale créneau. */
export function captureReservationModalFormBaseline() {
    reservationModalFormBaseline = snapshotReservationModalFormState();
    reservationModalEventPropsBaseline = snapshotReservationModalEventProps(
        reservationModalEventRef
    );
}

export function isReservationModalDirty() {
    if (reservationModalFormBaseline === null) return false;
    return snapshotReservationModalFormState() !== reservationModalFormBaseline;
}

/** Fermeture modale (bouton Fermer, fond) : false si mutation en cours ou si l’utilisateur refuse d’abandonner. */
export async function reservationModalMayCloseNow() {
    if (isReservationMutationInFlight()) return false;
    if (!isReservationModalDirty()) return true;
    const { planningConfirm } = await import('../utils/planning-confirm.js');
    return planningConfirm('Abandonner les modifications non enregistrées ?', {
        title: 'Modifications en cours',
        confirmLabel: 'Abandonner',
        danger: true
    });
}

function setReservationModalMutationLock(locked) {
    const modal = document.getElementById('modal_reservation');
    if (!(modal instanceof HTMLDialogElement)) return;
    if (locked) {
        modal.setAttribute('data-mutation-lock', '1');
    } else {
        modal.removeAttribute('data-mutation-lock');
    }
    const controls = [
        'btn-save',
        'btn-delete',
        'event-date-start',
        'event-date-display-label',
        'event-date-picker-btn',
        'event-start',
        'event-end',
        'event-motif-select',
        'event-title-input'
    ];
    for (const id of controls) {
        const el = document.getElementById(id);
        if (!el) continue;
        if ('disabled' in el) {
            // @ts-ignore - HTML elements exposing disabled
            el.disabled = Boolean(locked);
        }
    }
}

/**
 * Supprime les doublons visuels.
 * Priorité :
 * - même `planningCanonicalId`
 * - sinon même signature logique (propriétaire + plage + titre + type), utile
 *   quand un créneau optimiste coexiste brièvement avec sa ligne chargée depuis la base.
 * Garde l’événement « source base » plutôt que le miroir optimiste en attente.
 * @param {import('@fullcalendar/core').Calendar | null} calendar
 * @param {string} [preferCanonicalId]
 */
export function dedupePlanningEventsByCanonicalId(calendar, preferCanonicalId = '') {
    if (!calendar?.getEvents) return;
    const prefer = String(preferCanonicalId || '').trim();
    /** @type {Map<string, import('@fullcalendar/core').EventApi[]>} */
    const groups = new Map();
    for (const ev of calendar.getEvents()) {
        if (ev.display === 'background') continue;
        const canon = String(ev.extendedProps?.planningCanonicalId || '').trim();
        const fcId = String(ev.id ?? '').trim();
        const owner = String(ev.extendedProps?.owner || '')
            .trim()
            .toLowerCase();
        const startIso =
            ev.start instanceof Date && !Number.isNaN(ev.start.getTime()) ? ev.start.toISOString() : '';
        const endIso =
            ev.end instanceof Date && !Number.isNaN(ev.end.getTime()) ? ev.end.toISOString() : '';
        const title = String(ev.title || '').trim().toLowerCase();
        const dbType = String(
            ev.extendedProps?.planningDbSlotType || ev.extendedProps?.type || ''
        )
            .trim()
            .toLowerCase();
        const allDay = ev.allDay ? 'all-day' : 'timed';
        const logicalKey =
            owner && startIso && endIso
                ? `${owner}|${startIso}|${endIso}|${title}|${dbType}|${allDay}`
                : '';
        const key =
            canon ||
            logicalKey ||
            (String(ev.extendedProps?.planningRowSource || '') === 'supabase' ? fcId : '');
        if (!key) continue;
        const list = groups.get(key) || [];
        list.push(ev);
        groups.set(key, list);
    }
    const scoreEvent = (ev) => {
        let s = 0;
        if (String(ev.extendedProps?.planningRowSource || '') === 'supabase') s += 8;
        if (!ev.extendedProps?.planningQuickPending) s += 4;
        const canon = String(ev.extendedProps?.planningCanonicalId || '').trim();
        const fcId = String(ev.id ?? '').trim();
        if (prefer && (canon === prefer || fcId === prefer)) s += 16;
        return s;
    };
    for (const list of groups.values()) {
        if (list.length <= 1) continue;
        list.sort((a, b) => scoreEvent(b) - scoreEvent(a));
        for (const dup of list.slice(1)) {
            try {
                dup.remove();
            } catch {
                /* */
            }
        }
    }
}

/** Rechargement grille (RPC Postgres) : invalide le cache mémoire puis refetch FullCalendar. */
export async function refetchPlanningGrid(calendar) {
    invalidateCalendarListCache();
    if (calendar && typeof calendar.refetchEvents === 'function') {
        await calendar.refetchEvents();
        dedupePlanningEventsByCanonicalId(calendar);
    }
}

function calendarBridgeWanted() {
    const { calendarBridgeUrl } = getPlanningConfig();
    return Boolean(calendarBridgeUrl) && isBackendAuthConfigured();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function normalizeRole(role) {
    const r = String(role || '').toLowerCase();
    return isPlanningRole(r) ? r : '';
}

/** Références modale réservation (listener motif → affichage inscrits). */
let reservationModalUserRef = /** @type {object | null} */ (null);
let reservationModalCanEditRef = false;

let reservationInscritsUiBound = false;

function canManageReservationInscrits(currentUser) {
    const r = normalizeRole(currentUser?.role);
    return r === 'admin' || r === 'prof';
}

function getReservationInscritsSelection() {
    const multi = document.getElementById('event-inscrits-select');
    if (!multi) return { userIds: [], emailsCsv: '' };
    const userIds = [];
    const emails = [];
    for (let i = 0; i < multi.options.length; i++) {
        const o = multi.options[i];
        if (o.selected) {
            userIds.push(o.value);
            const em = String(o.dataset.email || '').trim().toLowerCase();
            if (em) emails.push(em);
        }
    }
    return { userIds, emailsCsv: emails.join(',') };
}

function refreshReservationInscritsSummary() {
    const summary = document.getElementById('reservation-inscrits-summary');
    const multi = document.getElementById('event-inscrits-select');
    if (!summary || !multi) return;
    const labels = [...multi.selectedOptions]
        .map((o) => String(o.textContent || '').trim())
        .filter(Boolean);
    setStudentsLineWithUsersIcon(summary, labels.length ? labels.join(', ') : '', {
        emptyFallback: 'Aucun élève (optionnel)',
        textClass: 'planning-users-text reservation-inscrits-text'
    });
}

function reservationModalIsCoursContext(eventRef, motifSelect) {
    if (String(motifSelect?.value || '').trim() === 'Cours') return true;
    const xp = safeEventExtendedProps(eventRef);
    if (!xp) return false;
    const db = String(xp.planningDbSlotType || '').trim();
    if (db === 'cours') return true;
    return String(xp.type || '').trim() === 'cours';
}

function updateReservationInscritsWrapVisibility(currentUser, canEdit) {
    syncReservationModalLiveEventRef();
    const wrap = document.getElementById('wrap-reservation-inscrits');
    const multi = document.getElementById('event-inscrits-select');
    const sel = document.getElementById('event-motif-select');
    const toggle = document.getElementById('event-inscrits-users-toggle');
    if (!wrap || !multi || !sel) return;
    const show = reservationModalIsCoursContext(reservationModalEventRef, sel);
    const canManage = canManageReservationInscrits(currentUser);
    wrap.classList.toggle('hidden', !show);
    wrap.setAttribute('aria-hidden', show ? 'false' : 'true');
    multi.disabled = !canEdit || !show || !canManage;
    if (toggle instanceof HTMLButtonElement) {
        toggle.disabled = !canEdit || !show || !canManage;
        toggle.classList.toggle('hidden', !canManage || !canEdit);
    }
    if (show) refreshReservationInscritsSummary();
    setReservationInscritsEditMode(Boolean(show && canEdit && canManage), canEdit);
}

/**
 * @param {boolean} editMode "mode édition" (affiche la liste des non-inscrits)
 * @param {boolean} canEdit "autorisation" (admin/prof + event éditable)
 */
function setReservationInscritsEditMode(editMode, canEdit) {
    const wrap = document.getElementById('wrap-reservation-inscrits');
    const multi = document.getElementById('event-inscrits-select');
    const toggle = document.getElementById('event-inscrits-users-toggle');
    const allowed = Boolean(editMode && canEdit);
    if (!wrap || !multi) return;
    wrap.dataset.inscritsEditMode = allowed ? '1' : '0';
    if (toggle instanceof HTMLButtonElement) toggle.setAttribute('aria-pressed', allowed ? 'true' : 'false');
    refreshReservationInscritsSummary();
    const availWrap = document.getElementById('event-inscrits-available-wrap');
    const grid = document.getElementById('event-inscrits-grid');
    if (availWrap && grid) renderReservationInscritsDnD(multi, allowed);
}

function ensureReservationMotifInscritsListener() {
    const sel = document.getElementById('event-motif-select');
    if (!sel || sel.dataset.inscritsMotifBound === '1') return;
    sel.dataset.inscritsMotifBound = '1';
    sel.addEventListener('change', () => {
        const live = syncReservationModalLiveEventRef();
        const isCours = String(sel.value || '').trim() === 'Cours';
        const multi = document.getElementById('event-inscrits-select');
        if (!isCours && multi instanceof HTMLSelectElement) {
            for (const o of multi.options) o.selected = false;
        }
        if (isCours) {
            void populateReservationInscritsMulti(
                reservationModalEventRef,
                reservationModalUserRef,
                reservationModalCanEditRef
            );
        } else {
            updateReservationInscritsWrapVisibility(
                reservationModalUserRef,
                reservationModalCanEditRef
            );
        }
        updateReservationModalHeadline(reservationModalEventRef);
    });
}

/** @param {import('@fullcalendar/core').EventApi | null} event */
async function populateReservationInscritsMulti(event, currentUser, canEdit) {
    const multi = document.getElementById('event-inscrits-select');
    if (!multi) return;
    const rows = await fetchPlanningListElevesActifs();
    const rowsSorted = [...rows].sort((a, b) => {
        const an = String(a?.nom || '').trim().toLowerCase();
        const bn = String(b?.nom || '').trim().toLowerCase();
        if (an !== bn) return an.localeCompare(bn, 'fr');
        const ap = String(a?.prenom || '').trim().toLowerCase();
        const bp = String(b?.prenom || '').trim().toLowerCase();
        return ap.localeCompare(bp, 'fr');
    });
    multi.innerHTML = '';
    const pre = new Set(
        (event && Array.isArray(event.extendedProps?.inscrits) ? event.extendedProps.inscrits : [])
            .map((e) => String(e).trim().toLowerCase())
            .filter(Boolean)
    );
    for (const r of rowsSorted) {
        if (!r.user_id) continue;
        const prenom = String(r.prenom || '').trim();
        const nom = String(r.nom || '').trim();
        const label =
            `${prenom} ${nom}`.trim() ||
            String(r.display_name || '').trim() ||
            'Élève';
        const opt = new Option(label, r.user_id);
        opt.dataset.email = String(r.email || '').trim().toLowerCase();
        opt.selected = pre.has(opt.dataset.email);
        multi.add(opt);
    }
    ensureReservationInscritsDropZonesBound();
    updateReservationInscritsWrapVisibility(currentUser, canEdit);
}

function ensureReservationInscritsToggleBound() {
    if (reservationInscritsUiBound) return;
    const toggle = document.getElementById('event-inscrits-users-toggle');
    const multi = document.getElementById('event-inscrits-select');
    if (!toggle || !multi) return;
    reservationInscritsUiBound = true;
    toggle.addEventListener('click', async () => {
        if (!reservationModalCanEditRef) return;
        if (!canManageReservationInscrits(reservationModalUserRef)) return;
        const motifSel = document.getElementById('event-motif-select');
        if (!reservationModalIsCoursContext(reservationModalEventRef, motifSel)) return;
        if (multi.options.length === 0) {
            await populateReservationInscritsMulti(
                reservationModalEventRef,
                reservationModalUserRef,
                reservationModalCanEditRef
            );
        }
        const rowsSorted = [...(await fetchPlanningListElevesActifs())].sort((a, b) => {
            const an = String(a?.nom || '').trim().toLowerCase();
            const bn = String(b?.nom || '').trim().toLowerCase();
            if (an !== bn) return an.localeCompare(bn, 'fr');
            const ap = String(a?.prenom || '').trim().toLowerCase();
            const bp = String(b?.prenom || '').trim().toLowerCase();
            return ap.localeCompare(bp, 'fr');
        });
        const selected = [...multi.selectedOptions].map((o) => o.value).filter(Boolean);
        const picked = await openCourseStudentsPicker({
            title: 'Inscriptions au cours',
            eleves: rowsSorted,
            selectedUserIds: selected
        });
        if (!picked) return;
        if (multi.options.length === 0) {
            await populateReservationInscritsMulti(
                reservationModalEventRef,
                reservationModalUserRef,
                reservationModalCanEditRef
            );
        }
        for (const o of multi.options) {
            o.selected = picked.includes(o.value);
        }
        refreshReservationInscritsSummary();
        const wrapR = document.getElementById('wrap-reservation-inscrits');
        renderReservationInscritsDnD(multi, wrapR?.dataset.inscritsEditMode === '1');
    });
}

/**
 * @param {string} id user_id
 * @param {boolean} toSelected true = inscrire au cours
 */
function reservationInscritsMoveStudent(id, toSelected) {
    const wrap = document.getElementById('wrap-reservation-inscrits');
    const multi = document.getElementById('event-inscrits-select');
    if (!wrap || !multi || wrap.dataset.inscritsEditMode !== '1') return;
    const sid = String(id || '').trim();
    if (!sid) return;
    const opt = [...multi.options].find((o) => String(o.value) === sid);
    if (!opt) return;
    opt.selected = toSelected;
    renderReservationInscritsDnD(multi, true);
}

/** Zones de drop : une seule paire d’écouteurs (évite les empilements à chaque re-render). */
function ensureReservationInscritsDropZonesBound() {
    const avail = document.getElementById('event-inscrits-available');
    const sel = document.getElementById('event-inscrits-selected');
    if (!avail || !sel || avail.dataset.reservationDndDropBound === '1') return;
    avail.dataset.reservationDndDropBound = '1';
    sel.dataset.reservationDndDropBound = '1';

    const wire = (zone, toSelected) => {
        zone.addEventListener('dragenter', () => zone.classList.add('st-dnd-drop-active'));
        zone.addEventListener('dragleave', () => zone.classList.remove('st-dnd-drop-active'));
        zone.addEventListener('dragover', (ev) => {
            ev.preventDefault();
            if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
        });
        zone.addEventListener('drop', (ev) => {
            ev.preventDefault();
            zone.classList.remove('st-dnd-drop-active');
            const raw = ev.dataTransfer?.getData('text/plain') || '';
            reservationInscritsMoveStudent(raw, toSelected);
        });
    };
    wire(avail, false);
    wire(sel, true);
}

function renderReservationInscritsDnD(multi, canEdit) {
    const availWrap = document.getElementById('event-inscrits-available');
    const selWrap = document.getElementById('event-inscrits-selected');
    if (!multi || !availWrap || !selWrap) return;
    const rows = [];
    for (const o of multi.options) {
        rows.push({
            id: String(o.value || ''),
            label: String(o.textContent || '').trim(),
            selected: Boolean(o.selected)
        });
    }
    const mk = (r) =>
        `<button type="button" class="btn btn-ghost btn-xs h-auto min-h-0 py-1 px-1.5 justify-start text-[10px] w-full ${
            canEdit ? 'cursor-grab' : 'cursor-default'
        }" draggable="${canEdit ? 'true' : 'false'}" data-student-id="${escapeHtml(r.id)}">${escapeHtml(r.label)}</button>`;
    availWrap.innerHTML = rows.filter((r) => !r.selected).map(mk).join('');
    selWrap.innerHTML = rows.filter((r) => r.selected).map(mk).join('');
    if (!canEdit) return;
    const bindZone = (zone, dblClickToSelected) => {
        zone.querySelectorAll('[data-student-id]').forEach((el) => {
            el.addEventListener('dragstart', (ev) => {
                const dt = ev.dataTransfer;
                if (dt) {
                    dt.setData('text/plain', el.getAttribute('data-student-id') || '');
                    dt.effectAllowed = 'move';
                }
            });
            el.addEventListener('dblclick', () =>
                reservationInscritsMoveStudent(el.getAttribute('data-student-id') || '', dblClickToSelected)
            );
        });
    };
    bindZone(availWrap, true);
    bindZone(selWrap, false);
}

async function prepareReservationInscritsSelect(currentUser, event, canEdit) {
    ensureReservationMotifInscritsListener();
    ensureReservationInscritsToggleBound();
    const wrap = document.getElementById('wrap-reservation-inscrits');
    const multi = document.getElementById('event-inscrits-select');
    const motifSel = document.getElementById('event-motif-select');
    if (!wrap || !multi) return;
    if (!reservationModalIsCoursContext(event, motifSel)) {
        updateReservationInscritsWrapVisibility(currentUser, canEdit);
        return;
    }
    await populateReservationInscritsMulti(event, currentUser, canEdit);
}

/**
 * @param {string} eventId
 * @param {string} dbSlotType
 * @returns {Promise<{ ok: boolean, emailsCsv: string, error?: string | null }>}
 */
async function syncPlanningEnrollmentAfterSave(eventId, dbSlotType) {
    if (!isBackendAuthConfigured() || !eventId) return { ok: true, emailsCsv: '' };
    if (dbSlotType === 'cours') {
        const { userIds, emailsCsv } = getReservationInscritsSelection();
        const enr = await replacePlanningEventEnrollment(eventId, userIds);
        if (!enr.ok) return { ok: false, emailsCsv: '', error: enr.error };
        return { ok: true, emailsCsv, error: null };
    }
    const enr = await replacePlanningEventEnrollment(eventId, []);
    if (!enr.ok) return { ok: false, emailsCsv: '', error: enr.error };
    return { ok: true, emailsCsv: '', error: null };
}

/** @param {import('@fullcalendar/core').EventApi | null} event */
export function ownerInfoFromEvent(event, currentUser) {
    const xp = safeEventExtendedProps(event) || {};
    const ownerEmail = String(xp.owner || currentUser?.email || '')
        .trim()
        .toLowerCase();
    const ownerUserId = String(xp.ownerUserId ?? '').trim();
    const ownerName =
        String(xp.ownerDisplayName || xp.ownerName || '').trim() ||
        (ownerEmail ? ownerEmail.split('@')[0] : 'Inconnu');
    const ownerRoleRaw = normalizeRole(xp.ownerRole || xp.owner_role || '');
    const ownerRole = ownerRoleRaw || roleFromOwnerEmail(ownerEmail);
    return { ownerEmail, ownerName, ownerRole, ownerUserId };
}

/** Libellé fixe : premier créateur du créneau (pas d’historique des modifications). */
function reservationReservedByLabel(owner, ownerLabelOverride = '', createdByLabelOverride = '') {
    const name =
        (createdByLabelOverride || '').trim() ||
        (ownerLabelOverride || '').trim() ||
        owner.ownerName ||
        'Inconnu';
    return `Réservé par ${name}`;
}

async function fetchProfileLabelsForUserIds(userIds) {
    const ids = Array.isArray(userIds) ? userIds.filter(Boolean).map((x) => String(x).trim()) : [];
    if (!ids.length) return new Map();
    if (!isBackendAuthConfigured()) return new Map();
    const sb = getSupabaseClient();
    if (!sb) return new Map();
    try {
        const { data, error } = await sb.rpc('planning_profiles_label_for_ids', { p_ids: ids });
        if (error) {
            console.warn('[Planning] planning_profiles_label_for_ids', error.message);
            return new Map();
        }
        const rows = Array.isArray(data) ? data : [];
        return new Map(rows.map((r) => [String(r.user_id), String(r.label)]));
    } catch (e) {
        console.warn('[Planning] planning_profiles_label_for_ids (rpc)', e);
        return new Map();
    }
}

/**
 * Remplit le sélecteur « Créneau pour » (prof/admin, nouvelle réservation).
 * @param {import('@fullcalendar/core').EventApi | null} event
 */
async function prepareReservationOwnerSelect(currentUser, event, canEditEvent) {
    const wrap = document.getElementById('wrap-reservation-owner-target');
    const sel = document.getElementById('reservation-slot-owner-email');
    const editorOwnerEl = document.getElementById('event-editor-owner');
    const r = normalizeRole(currentUser?.role);

    if (!wrap || !sel) return;

    if (r === 'eleve') {
        wrap.classList.add('hidden');
        editorOwnerEl?.classList.remove('hidden');
        return;
    }

    if (event) {
        wrap.classList.add('hidden');
        editorOwnerEl?.classList.remove('hidden');
        return;
    }

    wrap.classList.remove('hidden');
    if (editorOwnerEl) editorOwnerEl.classList.add('hidden');

    sel.disabled = true;
    sel.innerHTML = '';
    const me = String(currentUser?.email || '').trim();
    const meLower = me.toLowerCase();
    sel.add(new Option(`Moi · ${me}`, me, true, true));

    const sb = getSupabaseClient();
    if (!sb || !isBackendAuthConfigured()) {
        sel.disabled = !canEditEvent;
        return;
    }

    try {
        const { data, error } = await sb.rpc('planning_list_reservation_owner_candidates');
        if (error) {
            console.warn('[Planning] planning_list_reservation_owner_candidates', error.message);
        } else {
            const rows = Array.isArray(data) ? data : [];
            for (const row of rows) {
                const em = String(row.email || '').trim();
                if (!em || em.toLowerCase() === meLower) continue;
                const dn = String(row.display_name || '').trim() || em;
                sel.add(new Option(`${dn} · ${em}`, em));
            }
        }
    } catch (e) {
        console.warn(e);
    }
    sel.disabled = !canEditEvent;
}

function getReservationSlotOwnerEmail(currentUser, currentEventRef) {
    if (currentEventRef) {
        const xp = safeEventExtendedProps(currentEventRef);
        return String(xp?.owner || currentUser?.email || '').trim();
    }
    return String(currentUser?.email || '').trim();
}

/** Début du créneau strictement avant aujourd’hui (minuit local). */
export function isReservationStartBeforeTodayLocal(eventLike) {
    const raw = eventLike?.start;
    if (!raw) return false;
    const start = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(start.getTime())) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const d = new Date(start);
    d.setHours(0, 0, 0, 0);
    return d.getTime() < today.getTime();
}

/**
 * Créneau à traiter comme « passé » pour désactiver édition / drag / suppression.
 * — Tous les rôles : jour calendaire avant aujourd’hui.
 * — Élève uniquement : même jour mais heure de début strictement avant maintenant (créneau déjà commencé).
 */
export function isReservationNonEditablePast(currentUser, eventLike) {
    if (!eventLike?.start) return false;
    if (isReservationStartBeforeTodayLocal(eventLike)) return true;
    if (normalizeRole(currentUser?.role) !== 'eleve') return false;
    const raw = eventLike.start;
    const start = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(start.getTime())) return false;
    return start.getTime() < Date.now();
}

/**
 * Drag / redimensionnement : le calendrier a eventStartEditable / eventDurationEditable à false par défaut ;
 * on active par événement selon les mêmes règles que la modale (propriétaire, prof sur élève/prof, admin).
 * Les créneaux passés restent non éditables ; sur tactile, pas de redimensionnement (drag déplacement ok).
 */
export function fcDragResizePropsForEvent(eventLike, currentUser) {
    const raw = eventLike?.start;
    const start = raw instanceof Date ? raw : raw != null ? new Date(raw) : null;
    if (!start || Number.isNaN(start.getTime())) {
        return { editable: false, startEditable: false, durationEditable: false };
    }
    if (isReservationNonEditablePast(currentUser, eventLike)) {
        return { editable: false, startEditable: false, durationEditable: false };
    }
    if (!eventLike || !canCurrentUserEditEventIgnoringPast(currentUser, eventLike)) {
        return { editable: false, startEditable: false, durationEditable: false };
    }
    const coarsePointer =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(pointer: coarse)').matches;
    return { editable: true, startEditable: true, durationEditable: !coarsePointer };
}

/**
 * Recalcule les drapeaux FC après déplacement / changement d’heure (évite un créneau encore « draggable »
 * alors qu’il est passé pour un élève).
 * @param {import('@fullcalendar/core').EventApi | null} eventApi
 */
export function applyDragResizePropsToFcEvent(eventApi, currentUser) {
    if (!eventApi || typeof eventApi.setProp !== 'function') return;
    const p = fcDragResizePropsForEvent(eventApi, currentUser);
    try {
        eventApi.setProp('editable', p.editable);
        eventApi.setProp('startEditable', p.startEditable);
        eventApi.setProp('durationEditable', p.durationEditable);
    } catch (e) {
        console.warn('[Planning] applyDragResizePropsToFcEvent', e);
    }
}

/** Créneau tout juste ajouté par l’utilisateur connecté (owner = moi). */
export function fcDragResizePropsForEventStart(startLike, currentUser) {
    return fcDragResizePropsForEvent(
        { start: startLike, extendedProps: { owner: currentUser?.email } },
        currentUser
    );
}

function canCurrentUserEditEventIgnoringPast(currentUser, event) {
    if (!currentUser?.email || !event) return false;
    const meRole = normalizeRole(currentUser.role);
    const xp = safeEventExtendedProps(event) || {};
    const dbType = String(xp?.planningDbSlotType || '').trim().toLowerCase();
    const typ = String(xp?.type || '').trim().toLowerCase();
    if (dbType === 'fermeture' || typ === 'fermeture') {
        return meRole === 'admin';
    }
    if (meRole === 'admin') return true;

    const ownerRoleDb = normalizeRole(xp.ownerRole || xp.owner_role || '');
    if (meRole === 'prof' && ownerRoleDb === 'eleve') return true;

    const creatorRole = String(xp.createdByRole || '').trim().toLowerCase();
    const creatorId = String(xp.createdByUserId || '').trim();
    const myId = String(currentUser.id || '').trim();
    const owner = ownerInfoFromEvent(event, currentUser);
    const ownerEmailEarly = String(owner.ownerEmail || '').trim().toLowerCase();
    const orEarly = (owner.ownerRole || roleFromOwnerEmail(owner.ownerEmail)).toLowerCase();
    const myEmailEarly = String(currentUser.email).trim().toLowerCase();
    const editingStudentSlotForProf =
        meRole === 'prof' &&
        ownerEmailEarly &&
        ownerEmailEarly !== myEmailEarly &&
        orEarly !== 'prof' &&
        orEarly !== 'admin' &&
        (orEarly === 'eleve' ||
            ownerIsEleveForReservation(event, currentUser) ||
            dbType === 'travail perso' ||
            typ === 'reservation');
    if (meRole === 'prof' && creatorRole === 'admin' && creatorId !== myId && !editingStudentSlotForProf) {
        return false;
    }

    const ownerRole = owner.ownerRole || roleFromOwnerEmail(owner.ownerEmail);
    if (owner.ownerEmail && owner.ownerEmail === String(currentUser.email).trim().toLowerCase()) {
        return true;
    }
    if (meRole === 'prof') {
        const myEmail = String(currentUser.email).trim().toLowerCase();
        const ownerEmail = String(owner.ownerEmail || '').trim().toLowerCase();
        const or = (owner.ownerRole || roleFromOwnerEmail(owner.ownerEmail)).toLowerCase();
        if (ownerEmail && ownerEmail === myEmail) return true;
        if (or === 'prof' && ownerEmail && ownerEmail !== myEmail) return false;
        if (or === 'admin') return false;
        if (or === 'eleve' || ownerIsEleveForReservation(event, currentUser)) return true;
        if (profOrAdminEditingEleveSlot(currentUser, event)) return true;
        if (
            (dbType === 'travail perso' || typ === 'reservation') &&
            ownerEmail &&
            ownerEmail !== myEmail &&
            or !== 'prof' &&
            or !== 'admin'
        ) {
            return true;
        }
        return false;
    }
    return false;
}

export function canCurrentUserEditEvent(currentUser, event) {
    if (!currentUser?.email || !event) return false;
    if (isReservationNonEditablePast(currentUser, event)) return false;
    return canCurrentUserEditEventIgnoringPast(currentUser, event);
}

function roleFromOwnerEmail(email) {
    const e = String(email || '').toLowerCase();
    if (!e) return '';
    if (e === 'admin@iams.fr') return 'admin';
    if (e.startsWith('prof')) return 'prof';
    if (e.startsWith('eleve') || e.startsWith('élève')) return 'eleve';
    return '';
}

/** Propriétaire du créneau = élève (rôle base ou heuristique e-mail). */
function ownerIsEleveForReservation(event, currentUser) {
    if (!event) return false;
    const owner = ownerInfoFromEvent(event, currentUser);
    return owner.ownerRole === 'eleve' || roleFromOwnerEmail(owner.ownerEmail) === 'eleve';
}

/** Prof / admin modifie un créneau dont le propriétaire est un élève. */
function profOrAdminEditingEleveSlot(currentUser, event) {
    if (!event) return false;
    const r = normalizeRole(currentUser?.role);
    if (r !== 'prof' && r !== 'admin') return false;
    return ownerIsEleveForReservation(event, currentUser);
}

/**
 * Fenêtre de réservation + plafond hebdo travail perso (créneau dont le propriétaire est un élève).
 * @param {{ start: Date, end: Date, extendedProps?: Record<string, unknown> }} eventLike
 * @param {string | null} [excludeEventId] id planning_event à exclure du total (édition / resize)
 */
async function validateEleveTravailPersistCap(eventLike, excludeEventId = null) {
    const dbType = planningDbSlotTypeForEventUpdate(eventLike);
    if (dbType !== 'travail perso') return { ok: true };
    const owner = ownerInfoFromEvent(eventLike, null);
    const or = (owner.ownerRole || roleFromOwnerEmail(owner.ownerEmail)).toLowerCase();
    if (or !== 'eleve') return { ok: true };
    const start = eventLike.start instanceof Date ? eventLike.start : new Date(eventLike.start);
    const end = eventLike.end instanceof Date ? eventLike.end : new Date(eventLike.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
        return { ok: true };
    }
    await fetchOrganSchoolSettings();
    const setQ = getOrganSchoolSettingsCached();
    if (eleveBookingTooFarInFuture(setQ, start)) {
        return {
            ok: false,
            message: 'Cette date dépasse la fenêtre de réservation autorisée pour les élèves.'
        };
    }
    const addMin = Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000));
    const cap = await eleveTravailWouldExceedWeeklyCap(
        setQ,
        addMin,
        mondayStartLocal(start),
        excludeEventId ? String(excludeEventId).trim() : null
    );
    if (!cap.ok) {
        return { ok: false, message: cap.message || 'Quota hebdomadaire dépassé.' };
    }
    return { ok: true };
}

function isTravailPersoReservationEvent(event) {
    if (!event) return false;
    const db = String(event.extendedProps?.planningDbSlotType || '')
        .trim()
        .toLowerCase();
    if (db === 'travail perso') return true;
    const t = String(event.extendedProps?.type || '')
        .trim()
        .toLowerCase();
    return t === 'reservation';
}

/** Créneau appartenant au compte connecté (e-mail ou uuid propriétaire). */
function isReservationOwnedByCurrentUser(event, currentUser) {
    if (!event || !currentUser) return false;
    const owner = ownerInfoFromEvent(event, currentUser);
    const myEmail = String(currentUser.email || '').trim().toLowerCase();
    const ownerEmail = String(owner.ownerEmail || '').trim().toLowerCase();
    if (myEmail && ownerEmail && myEmail === ownerEmail) return true;
    const myId = String(currentUser.id || '').trim();
    const ownerId = String(
        owner.ownerUserId || event.extendedProps?.ownerUserId || ''
    ).trim();
    return Boolean(myId && ownerId && myId === ownerId);
}

/**
 * Prof / admin : masquer le motif sur un travail perso qui n’est pas le leur
 * (créneau d’un autre utilisateur — ne pas dépendre de ownerRole sur l’événement seul).
 */
function shouldHideReservationMotifForPrivilegedEditor(currentUser, event) {
    if (!event || !currentUser) return false;
    const r = normalizeRole(currentUser?.role);
    if (r !== 'prof' && r !== 'admin') return false;
    if (!isTravailPersoReservationEvent(event)) return false;
    return !isReservationOwnedByCurrentUser(event, currentUser);
}

/** @deprecated alias interne */
function profAdminEditingEleveTravailPersoSlot(currentUser, event) {
    return shouldHideReservationMotifForPrivilegedEditor(currentUser, event);
}

/** Motif / slot_type figés (travail perso d’un autre utilisateur). */
function reservationSlotTypeLockedFromEvent(currentUser, eventRef) {
    if (!shouldHideReservationMotifForPrivilegedEditor(currentUser, eventRef)) return null;
    return 'travail perso';
}

/** Affiche ou masque le sélecteur motif (après remplissage du formulaire). */
function applyReservationMotifVisibility(currentUser, event, canEditEvent) {
    const wrapMotif = document.getElementById('wrap-reservation-motif');
    const sel = document.getElementById('event-motif-select');
    const hintFerm = document.getElementById('event-motif-hint-fermeture');
    const r = normalizeRole(currentUser?.role);
    const xp = safeEventExtendedProps(event) || {};
    const dbType = String(xp.planningDbSlotType || '').trim().toLowerCase();
    const typ = String(xp.type || '').trim().toLowerCase();
    const isFermeture = dbType === 'fermeture' || typ === 'fermeture';
    const hidePrivileged = shouldHideReservationMotifForPrivilegedEditor(currentUser, event);
    if (!wrapMotif) return;
    if (isFermeture) {
        wrapMotif.classList.add('hidden');
        wrapMotif.setAttribute('aria-hidden', 'true');
        hintFerm?.classList.remove('hidden');
        if (sel instanceof HTMLSelectElement) {
            sel.value = 'Fermeture';
            sel.disabled = true;
        }
        return;
    }
    if (r === 'eleve') {
        wrapMotif.classList.add('hidden');
        wrapMotif.setAttribute('aria-hidden', 'true');
        hintFerm?.classList.add('hidden');
        return;
    }
    if (hidePrivileged) {
        wrapMotif.classList.add('hidden');
        wrapMotif.setAttribute('aria-hidden', 'true');
        hintFerm?.classList.add('hidden');
        if (sel instanceof HTMLSelectElement) {
            sel.value = 'Travail';
            sel.disabled = true;
        }
        return;
    }
    wrapMotif.classList.remove('hidden');
    wrapMotif.setAttribute('aria-hidden', 'false');
    if (sel instanceof HTMLSelectElement) {
        sel.disabled = !canEditEvent;
    }
    hintFerm?.classList.add('hidden');
}

function allowedMotifsForRole(role) {
    const r = normalizeRole(role);
    if (r === 'admin') return RESERVATION_MOTIFS.filter((m) => m !== 'Indispo');
    if (r === 'prof') return RESERVATION_MOTIFS.filter((m) => m !== 'Fermeture');
    if (r === 'eleve') return ['Travail'];
    return RESERVATION_MOTIFS.filter((m) => m !== 'Fermeture' && m !== 'Indispo');
}

/**
 * Modale élève : toujours « Travail perso. » uniquement.
 * Fermeture : liste réservée aux administrateurs.
 * @param {import('@fullcalendar/core').EventApi | null} event
 */
function allowedMotifsForReservationModal(currentUser, event) {
    const base = allowedMotifsForRole(currentUser?.role);
    if (normalizeRole(currentUser?.role) !== 'eleve') return base;
    return ['Travail'];
}

function defaultMotifForRole(role) {
    const r = normalizeRole(role);
    return 'Travail';
}

function slotTypeToMotif(slotType) {
    const s = String(slotType || '').trim().toLowerCase();
    if (s === 'fermeture') return 'Fermeture';
    if (s === 'indispo') return 'Indispo';
    if (s === 'concert') return 'Concert';
    if (s === 'autre') return 'Autre';
    if (s === 'cours' || s === 'maintenance') return 'Cours';
    return 'Travail';
}

/** Snapshot début/fin avant redimensionnement (réf. objet événement FC). */
const resizePreviousRange = new WeakMap();

/** À brancher sur `eventResizeStart` FullCalendar. */
export function captureResizeStart(info) {
    const ev = info?.event;
    if (ev?.start && ev?.end) {
        resizePreviousRange.set(ev, {
            startIso: ev.start.toISOString(),
            endIso: ev.end.toISOString()
        });
    }
}

/** Snapshot pour annuler un relâchement hors grille (barre « semaine », en-tête app, etc.). */
let eventDragSnapshot = null;

function clientCoordsFromPointerLike(jsEvent) {
    if (!jsEvent) return null;
    if (typeof jsEvent.clientX === 'number' && typeof jsEvent.clientY === 'number') {
        return { x: jsEvent.clientX, y: jsEvent.clientY };
    }
    const te = /** @type {TouchEvent} */ (jsEvent);
    const t = te.changedTouches?.[0] || te.targetTouches?.[0] || te.touches?.[0];
    if (t && typeof t.clientX === 'number' && typeof t.clientY === 'number') {
        return { x: t.clientX, y: t.clientY };
    }
    return null;
}

/**
 * Le relâchement doit rester dans le cadre FullCalendar (`#calendar`), pas dans la barre « semaine »
 * (`#calendar-toolbar`), l’en-tête app, la légende, ni à l’extérieur du widget.
 * À l’intérieur de `#calendar`, les en-têtes de jours FC restent acceptés.
 */
export function isCalendarEventDropLocationValid(jsEvent) {
    const c = clientCoordsFromPointerLike(jsEvent);
    if (!c) return false;
    const stack = document.elementsFromPoint(c.x, c.y);
    for (const node of stack) {
        if (!(node instanceof Element)) continue;
        if (node.classList.contains('fc-event-mirror')) continue;

        if (node.closest('#calendar-toolbar')) return false;
        if (node.closest('#app-header')) return false;
        if (node.closest('#planning-legend')) return false;

        if (node.closest('#calendar')) return true;
    }
    return false;
}

export function onCalendarEventDragStart(info) {
    const e = info?.event;
    if (!e?.start || !e?.end) {
        eventDragSnapshot = null;
        return;
    }
    eventDragSnapshot = {
        start: new Date(e.start),
        end: new Date(e.end),
        allDay: Boolean(e.allDay)
    };
}

export function onCalendarEventDragStop(info) {
    const c = clientCoordsFromPointerLike(info?.jsEvent);
    const snap = eventDragSnapshot;
    eventDragSnapshot = null;
    if (!snap || !info?.event?.start || !info?.event?.end) return;
    if (c && isCalendarEventDropLocationValid(info.jsEvent)) return;
    const ev = info.event;
    const moved =
        ev.start.getTime() !== snap.start.getTime() || ev.end.getTime() !== snap.end.getTime();
    if (!moved) return;
    ev.setDates(snap.start, snap.end);
    if (typeof ev.setAllDay === 'function') ev.setAllDay(snap.allDay);
    showToast('Déposez le créneau sur la grille du planning.', 'error');
}

export function bridgeGoogleIdFromFcEvent(event) {
    if (!event) return '';
    if (String(event.extendedProps?.planningRowSource || '') === 'supabase') {
        return String(event.extendedProps?.googleEventId || '').trim();
    }
    const raw = event.id ?? event.extendedProps?.googleEventId;
    return raw != null && String(raw).trim() ? String(raw).trim() : '';
}

/**
 * @param {import('@fullcalendar/core').EventApi | null | undefined} eventLike
 * @returns {{ title: string, startStr: string, endStr: string } | null}
 */
export function seriesPrevSnapshotFromEvent(eventLike) {
    if (!eventLike?.start || !eventLike?.end) return null;
    const start = eventLike.start instanceof Date ? eventLike.start : new Date(eventLike.start);
    const end = eventLike.end instanceof Date ? eventLike.end : new Date(eventLike.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    return {
        title: String(eventLike.title || '').trim(),
        startStr: start.toISOString(),
        endStr: end.toISOString()
    };
}

async function fetchPlanningRowsForSeries(series) {
    const start = new Date(String(series?.startAtFirst || ''));
    const end = new Date(`${String(series?.untilYmd || '').slice(0, 10)}T23:59:59`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
    const sid = String(series?.id || '').trim();
    if (!sid) return [];
    const rows = await fetchPlanningEventRowsInRange(start, end);
    return rows
        .filter((row) => String(row.series_id || '').trim() === sid)
        .sort((a, b) => new Date(String(a.start_at || '')).getTime() - new Date(String(b.start_at || '')).getTime());
}

function shiftIsoByDeltaMs(iso, deltaMs) {
    const d = new Date(String(iso || ''));
    if (Number.isNaN(d.getTime())) return '';
    return new Date(d.getTime() + deltaMs).toISOString();
}

function rowOverlapsIsoRange(row, startIso, endIso) {
    const rowStartMs = new Date(String(row?.start_at || '')).getTime();
    const rowEndMs = new Date(String(row?.end_at || '')).getTime();
    const startMs = new Date(String(startIso || '')).getTime();
    const endMs = new Date(String(endIso || '')).getTime();
    return Number.isFinite(rowStartMs) && Number.isFinite(rowEndMs) && startMs < rowEndMs && rowStartMs < endMs;
}

function isBlockingRowForSeriesOwner(row, ownerUid) {
    const slotType = String(row?.slot_type || '').trim().toLowerCase();
    if (slotType === 'fermeture') return true;
    if (slotType !== 'indispo') return false;
    return String(row?.owner_user_id || '').trim() === String(ownerUid || '').trim();
}

async function planSeriesAutoPauseExceptions(p) {
    const {
        ownerUid,
        startIso,
        endIso,
        untilYmd,
        frequencyInterval,
        occurrenceLimit
    } = p;
    const horizonEnd = new Date(`${String(untilYmd || '').slice(0, 10)}T23:59:59`);
    if (Number.isNaN(horizonEnd.getTime())) {
        return { ok: false, error: 'Date de fin de série invalide.', plannedExceptions: [], plannedCount: 0 };
    }
    const existingRows = await fetchPlanningEventRowsInRange(new Date(startIso), horizonEnd);
    const intervalDays = Number(frequencyInterval) === 2 ? 14 : 7;
    const intervalMs = intervalDays * 24 * 60 * 60 * 1000;
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
    const max = Number.isFinite(Number(occurrenceLimit)) && Number(occurrenceLimit) >= 1
        ? Math.trunc(Number(occurrenceLimit))
        : Number.POSITIVE_INFINITY;
    /** @type {Array<{ occurrenceStartAt: string, exceptionKind: string, payload: object }>} */
    const plannedExceptions = [];
    let plannedCount = 0;
    let candidateStartIso = String(startIso || '');
    let candidateEndIso = String(endIso || '');
    let safety = 0;
    while (
        new Date(candidateStartIso).getTime() <= horizonEnd.getTime() &&
        plannedCount < max &&
        safety < 2000
    ) {
        safety += 1;
        const overlaps = existingRows.filter((row) => rowOverlapsIsoRange(row, candidateStartIso, candidateEndIso));
        const blocking = overlaps.filter((row) => isBlockingRowForSeriesOwner(row, ownerUid));
        if (blocking.length) {
            plannedExceptions.push({
                occurrenceStartAt: candidateStartIso,
                exceptionKind: 'skip',
                payload: {
                    shiftWeeks: 1,
                    reason: blocking.some((row) => String(row.slot_type || '').trim().toLowerCase() === 'fermeture')
                        ? 'fermeture'
                        : 'indispo'
                }
            });
            candidateStartIso = shiftIsoByDeltaMs(candidateStartIso, oneWeekMs);
            candidateEndIso = shiftIsoByDeltaMs(candidateEndIso, oneWeekMs);
            continue;
        }
        const conflict = overlaps[0] || null;
        if (conflict) {
            return {
                ok: false,
                error: `Conflit détecté le ${String(conflict.start_at || '').slice(0, 10)} avec un créneau existant.`,
                plannedExceptions,
                plannedCount
            };
        }
        plannedCount += 1;
        candidateStartIso = shiftIsoByDeltaMs(candidateStartIso, intervalMs);
        candidateEndIso = shiftIsoByDeltaMs(candidateEndIso, intervalMs);
    }
    return { ok: true, error: null, plannedExceptions, plannedCount };
}

async function recreateGeneratedSeriesOccurrences(p) {
    const {
        calendar,
        currentUser,
        ownerUid,
        ownerEmail,
        dbSlotType,
        title,
        bridgeType,
        seriesId,
        rowSpecs,
        deleteCanonicalIds
    } = p;
    const toDelete = [...new Set((deleteCanonicalIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (toDelete.length) {
        const del = await deletePlanningEventsByCanonicalIds(toDelete);
        if (!del.ok) return { ok: false, error: del.error || 'Suppression des occurrences impossible.' };
    }
    /** @type {string[]} */
    const createdIds = [];
    /** @type {Record<string, unknown>[]} */
    const bridgeEventsDb = [];
    for (const row of rowSpecs || []) {
        const ur = await upsertPlanningEventRow({
            id: null,
            startIso: row.startIso,
            endIso: row.endIso,
            title,
            dbSlotType,
            ownerEmail,
            ownerUserId: ownerUid,
            seriesId,
            seriesPosition: row.seriesPosition,
            isAllDay: Boolean(row.isAllDay)
        });
        if (!ur.ok || !ur.id) {
            for (const id of createdIds) await deletePlanningEventRow(id);
            return { ok: false, error: ur.error || 'Création des occurrences impossible.' };
        }
        createdIds.push(ur.id);
        const enrollR = await syncPlanningEnrollmentAfterSave(ur.id, dbSlotType);
        if (!enrollR.ok) {
            for (const id of createdIds) await deletePlanningEventRow(id);
            return { ok: false, error: enrollR.error || 'Enregistrement des inscriptions impossible.' };
        }
        if (dbSlotType !== 'indispo') {
            bridgeEventsDb.push({
                planningEventId: ur.id,
                title,
                start: row.startIso,
                end: row.endIso,
                type: bridgeType,
                owner: ownerEmail,
                ...(enrollR.emailsCsv ? { inscrits: enrollR.emailsCsv } : {})
            });
        }
    }
    await refetchPlanningGrid(calendar);
    if (calendarBridgeWanted() && bridgeEventsDb.length > 0) {
        voidLaunchReservationGoogleSyncWithRollback(
            calendar,
            bridgeEventsDb,
            { mode: 'create', eventId: createdIds[0] || '', createdIds }
        );
    }
    if (!reservationAutoSaveMode) {
        document.getElementById('modal_reservation')?.close();
    }
    showToast('Série mise à jour.');
    return { ok: true };
}

async function resolveGeneratedSeriesOverlapsForIndispo(p) {
    const {
        calendar,
        currentUser,
        overlaps,
        indispoStartIso,
        indispoEndIso
    } = p;
    const seriesIds = [
        ...new Set(
            (overlaps || [])
                .map((row) => String(row.series_id || '').trim())
                .filter(Boolean)
        )
    ];
    if (!seriesIds.length) {
        return {
            ok: true,
            deleteIds: overlaps.map((row) => String(row.id || '').trim()).filter(Boolean)
        };
    }
    const choice = await openIndispoSeriesResolutionModal({
        impactedSeriesCount: seriesIds.length,
        impactedOccurrenceCount: overlaps.length
    });
    if (!choice) return { ok: false, cancelled: true, deleteIds: [] };

    const seriesRows = await fetchPlanningEventSeriesByIds(seriesIds);
    const seriesById = new Map(seriesRows.map((row) => [row.id, row]));
    const nonSeriesDeleteIds = overlaps
        .filter((row) => !String(row.series_id || '').trim())
        .map((row) => String(row.id || '').trim())
        .filter(Boolean);

    if (choice === 'delete') {
        for (const row of overlaps) {
            const sid = String(row.series_id || '').trim();
            if (!sid) continue;
            const created = await createPlanningSeriesException(
                String(row.start_at || ''),
                'skip',
                { reason: 'indispo' },
                String(currentUser?.id || '').trim(),
                sid
            );
            if (!created.ok) {
                return { ok: false, error: created.error || 'Création exception série impossible.', deleteIds: [] };
            }
        }
        return {
            ok: true,
            deleteIds: overlaps.map((row) => String(row.id || '').trim()).filter(Boolean)
        };
    }

    for (const sid of seriesIds) {
        const series = seriesById.get(sid);
        if (!series?.id) continue;
        const rows = await fetchPlanningRowsForSeries(series);
        if (!rows.length) continue;
        const impactedRows = rows.filter((row) => {
            const rowStartMs = new Date(String(row.start_at || '')).getTime();
            const rowEndMs = new Date(String(row.end_at || '')).getTime();
            const blockStartMs = new Date(indispoStartIso).getTime();
            const blockEndMs = new Date(indispoEndIso).getTime();
            return blockStartMs < rowEndMs && rowStartMs < blockEndMs;
        });
        if (!impactedRows.length) continue;
        const firstImpacted = impactedRows[0];
        const firstIndex = rows.findIndex((row) => String(row.id || '').trim() === String(firstImpacted.id || '').trim());
        if (firstIndex < 0) continue;
        const prevRow = firstIndex > 0 ? rows[firstIndex - 1] : null;
        const remainingCount =
            Number.isFinite(Number(series.occurrenceLimit)) && series.occurrenceLimit != null
                ? Math.max(1, Number(series.occurrenceLimit) - firstIndex)
                : null;
        const shiftDays = Math.max(1, impactedRows.length) * 7;
        const shiftMs = shiftDays * 24 * 60 * 60 * 1000;
        const newStartIso = shiftIsoByDeltaMs(String(firstImpacted.start_at || ''), shiftMs);
        const newEndIso = shiftIsoByDeltaMs(String(firstImpacted.end_at || ''), shiftMs);
        const previewRows = buildPlanningEventRowsFromSeries({
            seriesId: series.id,
            ownerUserId: series.ownerUserId,
            ownerEmail: series.ownerEmail,
            slotType: series.slotType,
            title: series.title,
            startIso: newStartIso,
            endIso: newEndIso,
            untilYmd: series.untilYmd,
            occurrenceLimit: remainingCount,
            frequencyInterval: series.frequencyInterval
        });
        const previewDeleteIds = new Set(rows.slice(firstIndex).map((row) => String(row.id || '').trim()));
        const horizonEnd = new Date(`${String(series.untilYmd || '').slice(0, 10)}T23:59:59`);
        const existingRows = await fetchPlanningEventRowsInRange(new Date(newStartIso), horizonEnd);
        const conflict = previewRows.find((row) => {
            const rowStartMs = new Date(row.startIso).getTime();
            const rowEndMs = new Date(row.endIso).getTime();
            return existingRows.some((existing) => {
                if (previewDeleteIds.has(String(existing.id || '').trim())) return false;
                const existingStartMs = new Date(String(existing.start_at || '')).getTime();
                const existingEndMs = new Date(String(existing.end_at || '')).getTime();
                return rowStartMs < existingEndMs && existingStartMs < rowEndMs;
            });
        });
        if (conflict) {
            return {
                ok: false,
                error: `Décalage impossible : conflit détecté le ${String(conflict.startIso || '').slice(0, 10)}.`,
                deleteIds: []
            };
        }
        if (prevRow) {
            const upd = await updatePlanningEventSeries(series.id, {
                untilYmd: String(prevRow.start_at || '').slice(0, 10),
                occurrenceLimit:
                    Number.isFinite(Number(series.occurrenceLimit)) && series.occurrenceLimit != null
                        ? firstIndex
                        : null
            });
            if (!upd.ok) return { ok: false, error: upd.error || 'Mise à jour de série impossible.', deleteIds: [] };
        } else {
            const del = await deletePlanningEventSeries(series.id);
            if (!del.ok) return { ok: false, error: del.error || 'Suppression de série impossible.', deleteIds: [] };
        }
        const newSeriesRes = await createPlanningEventSeries({
            ownerUserId: series.ownerUserId,
            ownerEmail: series.ownerEmail,
            slotType: series.slotType,
            title: series.title,
            startAtFirst: newStartIso,
            untilYmd: series.untilYmd,
            occurrenceLimit: remainingCount,
            frequencyInterval: series.frequencyInterval
        });
        if (!newSeriesRes.ok || !newSeriesRes.series?.id) {
            return { ok: false, error: newSeriesRes.error || 'Décalage de série impossible.', deleteIds: [] };
        }
        const newRows = buildPlanningEventRowsFromSeries({
            seriesId: newSeriesRes.series.id,
            ownerUserId: series.ownerUserId,
            ownerEmail: series.ownerEmail,
            slotType: series.slotType,
            title: series.title,
            startIso: newStartIso,
            endIso: newEndIso,
            untilYmd: series.untilYmd,
            occurrenceLimit: remainingCount,
            frequencyInterval: series.frequencyInterval,
            skipOccurrenceStartIsoSet: new Set()
        });
        const recreated = await recreateGeneratedSeriesOccurrences({
            calendar,
            currentUser,
            ownerUid: series.ownerUserId,
            ownerEmail: series.ownerEmail,
            dbSlotType: series.slotType,
            title: series.title,
            bridgeType: planningDbSlotTypeToBridgeType(series.slotType),
            seriesId: newSeriesRes.series.id,
            rowSpecs: newRows,
            deleteCanonicalIds: rows.slice(firstIndex).map((row) => String(row.id || '').trim())
        });
        if (!recreated.ok) {
            await deletePlanningEventSeries(newSeriesRes.series.id);
            return { ok: false, error: recreated.error || 'Décalage de série impossible.', deleteIds: [] };
        }
    }
    return { ok: true, deleteIds: nonSeriesDeleteIds };
}

async function applyGeneratedSeriesScopeIfNeeded(p) {
    const {
        calendar,
        currentUser,
        liveEventRef,
        canonicalExisting,
        dbSlotType,
        prevSnapshot,
        title,
        startIso,
        endIso,
        ownerUid,
        slotOwnerEmail,
        bridgeType
    } = p;
    const seriesId = String(liveEventRef?.extendedProps?.planningSeriesId || '').trim();
    if (
        !liveEventRef ||
        !canonicalExisting ||
        !seriesId ||
        !isPrivilegedUser(currentUser) ||
        !prevSnapshot
    ) {
        return { action: 'continue', detachTemplateLink: false, detachSeriesLink: false };
    }
    const prevDbType = String(liveEventRef?.extendedProps?.planningDbSlotType || '').trim().toLowerCase();
    const titleTrim = String(title || '').trim();
    const changed =
        String(prevSnapshot.title || '').trim() !== titleTrim ||
        prevSnapshot.startStr !== startIso ||
        prevSnapshot.endStr !== endIso ||
        prevDbType !== String(dbSlotType || '').trim().toLowerCase();
    if (!changed) return { action: 'continue', detachTemplateLink: false, detachSeriesLink: false };

    const [series] = await fetchPlanningEventSeriesByIds([seriesId]);
    if (!series?.id) {
        return { action: 'continue', detachTemplateLink: false, detachSeriesLink: false };
    }
    const seriesExceptionMap = await fetchPlanningSeriesExceptionsBySeriesIds([series.id]);
    const existingSeriesExceptions = seriesExceptionMap.get(series.id) || [];
    const scope = await openCoursSeriesScopeModal();
    if (scope === null) return 'cancelled';
    if (scope === 'single') {
        return { action: 'continue', detachTemplateLink: false, detachSeriesLink: true };
    }

    const rows = await fetchPlanningRowsForSeries(series);
    if (!rows.length) return { action: 'continue', detachTemplateLink: false, detachSeriesLink: false };
    const currentIndex = rows.findIndex((row) => String(row.id || '').trim() === canonicalExisting);
    const currentRow = currentIndex >= 0 ? rows[currentIndex] : null;
    if (!currentRow) {
        return { action: 'continue', detachTemplateLink: false, detachSeriesLink: false };
    }

    const ownerEmail = String(slotOwnerEmail || currentUser.email || '').trim().toLowerCase();
    const occurrenceLimit = series.occurrenceLimit;
    const frequencyInterval = Number(series.frequencyInterval) === 2 ? 2 : 1;
    const intervalDays = frequencyInterval * 7;

    if (scope === 'future') {
        const deleteRows = rows.slice(currentIndex);
        const prevRow = currentIndex > 0 ? rows[currentIndex - 1] : null;
        const remainingCount =
            Number.isFinite(Number(occurrenceLimit)) && occurrenceLimit != null
                ? Math.max(1, Number(occurrenceLimit) - currentIndex)
                : null;
        if (prevRow) {
            await updatePlanningEventSeries(series.id, {
                untilYmd: String(prevRow.start_at || '').slice(0, 10),
                occurrenceLimit:
                    Number.isFinite(Number(occurrenceLimit)) && occurrenceLimit != null
                        ? currentIndex
                        : null
            });
        } else {
            await deletePlanningEventSeries(series.id);
        }
        const newSeriesRes = await createPlanningEventSeries({
            ownerUserId: ownerUid,
            ownerEmail,
            slotType: dbSlotType,
            title,
            startAtFirst: startIso,
            untilYmd: series.untilYmd,
            occurrenceLimit: remainingCount,
            frequencyInterval
        });
        if (!newSeriesRes.ok || !newSeriesRes.series?.id) {
            showToast(newSeriesRes.error || 'Scission de série impossible.', 'error');
            return 'cancelled';
        }
        const newRows = buildPlanningEventRowsFromSeries({
            seriesId: newSeriesRes.series.id,
            ownerUserId: ownerUid,
            ownerEmail,
            slotType: dbSlotType,
            title,
            startIso,
            endIso,
            untilYmd: series.untilYmd,
            occurrenceLimit: remainingCount,
            frequencyInterval,
            seriesExceptions: existingSeriesExceptions
        });
        const recreated = await recreateGeneratedSeriesOccurrences({
            calendar,
            currentUser,
            ownerUid,
            ownerEmail,
            dbSlotType,
            title,
            bridgeType,
            seriesId: newSeriesRes.series.id,
            rowSpecs: newRows,
            deleteCanonicalIds: deleteRows.map((row) => String(row.id || '').trim())
        });
        if (!recreated.ok) {
            await deletePlanningEventSeries(newSeriesRes.series.id);
            showToast(recreated.error || 'Mise à jour de série impossible.', 'error');
            return 'cancelled';
        }
        return 'handled';
    }

    const deltaMs = new Date(startIso).getTime() - new Date(currentRow.start_at).getTime();
    const newFirstStartIso = shiftIsoByDeltaMs(series.startAtFirst, deltaMs);
    const durationMs = new Date(endIso).getTime() - new Date(startIso).getTime();
    const newFirstEndIso = shiftIsoByDeltaMs(newFirstStartIso, durationMs);
    const newSeriesRes = await createPlanningEventSeries({
        ownerUserId: ownerUid,
        ownerEmail,
        slotType: dbSlotType,
        title,
        startAtFirst: newFirstStartIso,
        untilYmd: series.untilYmd,
        occurrenceLimit,
        frequencyInterval
    });
    if (!newSeriesRes.ok || !newSeriesRes.series?.id) {
        showToast(newSeriesRes.error || 'Réécriture de série impossible.', 'error');
        return 'cancelled';
    }
    const newRows = buildPlanningEventRowsFromSeries({
        seriesId: newSeriesRes.series.id,
        ownerUserId: ownerUid,
        ownerEmail,
        slotType: dbSlotType,
        title,
        startIso: newFirstStartIso,
        endIso: newFirstEndIso,
        untilYmd: series.untilYmd,
        occurrenceLimit,
        frequencyInterval,
        seriesExceptions: existingSeriesExceptions
    });
    const recreated = await recreateGeneratedSeriesOccurrences({
        calendar,
        currentUser,
        ownerUid,
        ownerEmail,
        dbSlotType,
        title,
        bridgeType,
        seriesId: newSeriesRes.series.id,
        rowSpecs: newRows,
        deleteCanonicalIds: rows.map((row) => String(row.id || '').trim())
    });
    if (!recreated.ok) {
        await deletePlanningEventSeries(newSeriesRes.series.id);
        showToast(recreated.error || 'Réécriture de série impossible.', 'error');
        return 'cancelled';
    }
    await deletePlanningEventSeries(series.id);
    return 'handled';
}

/**
 * Cours liés au gabarit : propose « ce créneau » / « ce créneau et les suivants » (comme Google Agenda).
 * @returns {Promise<'cancelled' | 'handled' | { action: 'continue', detachTemplateLink: boolean }>}
 */
async function maybeApplyCoursSeriesScopeBeforePersist(p) {
    const {
        calendar,
        currentUser,
        liveEventRef,
        canonicalExisting,
        dbSlotType,
        tplLineId,
        prevSnapshot,
        title,
        startIso,
        endIso,
        startStr,
        endStr,
        ownerUid,
        slotOwnerEmail,
        ownerForBridge,
        bridgeType,
        slotType
    } = p;

    const generatedSeriesResult = await applyGeneratedSeriesScopeIfNeeded({
        calendar,
        currentUser,
        liveEventRef,
        canonicalExisting,
        dbSlotType,
        prevSnapshot,
        title,
        startIso,
        endIso,
        ownerUid,
        slotOwnerEmail,
        bridgeType
    });
    if (generatedSeriesResult === 'handled' || generatedSeriesResult === 'cancelled') {
        return generatedSeriesResult;
    }

    if (
        !liveEventRef ||
        !canonicalExisting ||
        dbSlotType !== 'cours' ||
        !tplLineId ||
        !isPrivilegedUser(currentUser) ||
        !prevSnapshot
    ) {
        return { action: 'continue', detachTemplateLink: false, detachSeriesLink: false };
    }

    const titleTrim = String(title || '').trim();
    const prevTitle = String(prevSnapshot.title || '').trim();
    const timeOrTitleChanged =
        prevTitle !== titleTrim ||
        prevSnapshot.startStr !== startIso ||
        prevSnapshot.endStr !== endIso;

    if (!timeOrTitleChanged) {
        return { action: 'continue', detachTemplateLink: false, detachSeriesLink: false };
    }

    const scope = await openCoursSeriesScopeModal();
    if (scope === null) return 'cancelled';
    if (scope === 'future') {
        const seriesDone = await applyCoursTemplateLineSeriesIfNeeded({
            calendar,
            currentUser,
            liveEventRef,
            canonicalExisting,
            ownerUid,
            slotOwnerEmail,
            ownerForBridge,
            bridgeType,
            prevSnapshot,
            title,
            startIso,
            endIso,
            startStr,
            endStr,
            templateLineId: tplLineId,
            slotType
        });
        return seriesDone ? 'handled' : 'cancelled';
    }
    return { action: 'continue', detachTemplateLink: true, detachSeriesLink: false };
}

/**
 * Après déplacement ou redimensionnement : enregistre la plage en Postgres (vérité grille), puis miroir Google.
 * @param {import('@fullcalendar/core').EventApi} calendarEvent
 * @param {import('@fullcalendar/core').Calendar | null} [calendar] — chevauchements (recommandé)
 * @param {object | null} [currentUser] — requis pour la série gabarit (prof / admin)
 * @param {{ title: string, startStr: string, endStr: string } | null} [previousSnapshot] — horaire avant déplacement
 * @returns {Promise<{ ok: boolean, skipped?: boolean, cancelled?: boolean }>}
 */
export async function syncReservationEventToGoogle(
    calendarEvent,
    calendar = null,
    currentUser = null,
    previousSnapshot = null,
    callbacks = {}
) {
    if (!calendarEvent || !isBackendAuthConfigured()) {
        return { ok: false, skipped: true };
    }
    const fromDb = String(calendarEvent.extendedProps?.planningRowSource || '') === 'supabase';
    if (!fromDb) return { ok: true, skipped: true };

    const start = calendarEvent.start;
    const end = calendarEvent.end;
    if (!start || !end) return { ok: false };
    const owner = String(calendarEvent.extendedProps?.owner || '').trim();
    const gid = bridgeGoogleIdFromFcEvent(calendarEvent);
    const title = String(calendarEvent.title || '').trim() || 'Créneau';
    const poolLink = String(calendarEvent.extendedProps?.poolGoogleEventId ?? '').trim();
    const canonicalId = String(calendarEvent.extendedProps?.planningCanonicalId || '').trim();
    const tplLineId = String(calendarEvent.extendedProps?.planningSourceTemplateLineId || '').trim();
    if (!canonicalId) {
        showToast('Créneau sans identifiant base : enregistrement impossible.', 'error');
        return { ok: false };
    }

    if (calendar?.getEvents) {
        const liveEv = resolveLivePlanningEventRef(calendar, calendarEvent);
        const conflict = findOverlappingCalendarEvent(
            calendar,
            new Date(start.getTime()),
            new Date(end.getTime()),
            liveEv
        );
        if (conflict) {
            showToast(overlapToastMessage(conflict), 'error');
            return { ok: false };
        }
    }

    const ownerUid = await planningUserIdForEmail(owner);
    if (!ownerUid) {
        showToast('Impossible de résoudre le compte du propriétaire du créneau.', 'error');
        return { ok: false };
    }
    const dbSlotType = planningDbSlotTypeForEventUpdate(calendarEvent);
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    const slotType = motifToSlotType(
        normalizeMotif(String(calendarEvent.extendedProps?.type || 'cours'))
    );

    if (previousSnapshot) {
        const unchanged =
            String(previousSnapshot.title || '').trim() === title &&
            previousSnapshot.startStr === startIso &&
            previousSnapshot.endStr === endIso;
        if (unchanged) return { ok: true, skipped: true };
    }

    const capPersist = await validateEleveTravailPersistCap(
        { start, end, extendedProps: calendarEvent.extendedProps },
        canonicalId
    );
    if (!capPersist.ok) {
        showToast(capPersist.message || 'Quota hebdomadaire dépassé.', 'error');
        return { ok: false };
    }

    let detachTemplateLink = false;
    let detachSeriesLink = false;
    if (currentUser && previousSnapshot) {
        const liveRef = calendar ? resolveLivePlanningEventRef(calendar, calendarEvent) : calendarEvent;
        const seriesResult = await maybeApplyCoursSeriesScopeBeforePersist({
            calendar,
            currentUser,
            liveEventRef: liveRef,
            canonicalExisting: canonicalId,
            dbSlotType,
            tplLineId,
            prevSnapshot: previousSnapshot,
            title,
            startIso,
            endIso,
            startStr: startIso,
            endStr: endIso,
            ownerUid,
            slotOwnerEmail: owner,
            ownerForBridge: owner,
            bridgeType: planningDbSlotTypeToBridgeType(dbSlotType),
            slotType
        });
        if (seriesResult === 'cancelled') return { ok: false, cancelled: true };
        if (seriesResult === 'handled') return { ok: true, skipped: false };
        if (seriesResult?.action === 'continue') {
            detachTemplateLink = Boolean(seriesResult.detachTemplateLink);
            detachSeriesLink = Boolean(seriesResult.detachSeriesLink);
        }
    }

    let prevEnrollIds = [];
    if (dbSlotType === 'cours') {
        prevEnrollIds = await fetchPlanningEventEnrollmentUserIds(canonicalId);
    }
    /** @type {ReturnType<typeof buildModalSavePrevDbSnapshot> | null} */
    const prevDbForRollback = previousSnapshot
        ? {
              startIso: previousSnapshot.startStr,
              endIso: previousSnapshot.endStr,
              title: String(previousSnapshot.title || title).trim() || title,
              dbSlotType,
              ownerEmail: String(owner).trim().toLowerCase(),
              ownerUid,
              inscritUserIds: prevEnrollIds
          }
        : null;

    const ur = await upsertPlanningEventRow({
        id: canonicalId,
        startIso,
        endIso,
        title,
        dbSlotType,
        ownerEmail: owner,
        ownerUserId: ownerUid,
        ...(detachTemplateLink ? { sourceTemplateLineId: null } : {}),
        ...(detachSeriesLink ? { seriesId: null, seriesPosition: null } : {})
    });
    if (!ur.ok || !ur.id) {
        showToast(ur.error || 'Enregistrement base impossible.', 'error');
        return { ok: false };
    }
    if (detachTemplateLink && typeof calendarEvent.setExtendedProp === 'function') {
        calendarEvent.setExtendedProp('planningSourceTemplateLineId', '');
    }
    if (detachSeriesLink && typeof calendarEvent.setExtendedProp === 'function') {
        calendarEvent.setExtendedProp('planningSeriesId', '');
        calendarEvent.setExtendedProp('planningSeriesPosition', null);
    }

    const bridgeType = planningDbSlotTypeToBridgeType(dbSlotType);
    const inscritsArr = Array.isArray(calendarEvent.extendedProps?.inscrits)
        ? calendarEvent.extendedProps.inscrits
        : [];
    const inscritsCsv = inscritsArr
        .map((x) => String(x).trim().toLowerCase())
        .filter(Boolean)
        .join(',');
    const payload = {
        planningEventId: canonicalId,
        ...(gid ? { googleEventId: gid } : {}),
        title,
        start: startIso,
        end: endIso,
        type: bridgeType,
        owner,
        ...(poolLink ? { poolGoogleEventId: poolLink } : {}),
        ...(inscritsCsv ? { inscrits: inscritsCsv } : {})
    };
    showToast('Créneau mis à jour.', 'success');
    const liveRef = calendar ? resolveLivePlanningEventRef(calendar, calendarEvent) : calendarEvent;
    if (liveRef && typeof liveRef.setExtendedProp === 'function') {
        liveRef.setExtendedProp('planningGoogleSyncPending', calendarBridgeWanted());
    }
    voidLaunchReservationGoogleSyncWithRollback(
        calendar,
        [payload],
        {
            mode: 'edit',
            eventId: canonicalId,
            prevDb: prevDbForRollback
        },
        callbacks.onGoogleSyncSuccess
    );
    if (calendar) {
        await refetchPlanningGrid(calendar);
    }
    return { ok: true, skipped: false };
}

function buildSlotOwnerNotifyLabel(targetEmail, resolvedDisplayName) {
    const em = String(targetEmail || '')
        .trim()
        .toLowerCase();
    if (!em) return 'le destinataire';
    const name = String(resolvedDisplayName || '').trim();
    const at = em.indexOf('@');
    const local = at > 0 ? em.slice(0, at) : em;
    const n = name.toLowerCase();
    const looksLikeTrivial = !name || n === em || n === local;
    return looksLikeTrivial ? em : `${name} (${em})`;
}

/**
 * E-mail au propriétaire du créneau si un autre utilisateur vient d’agir ; toast pour l’acteur.
 * @param {'deleted'|'moved'|'modified'} action
 * @param {string} [params.targetOwnerUserId] — pour libellé « Prénom Nom » via `planning_profiles_label_for_ids`
 */
export async function maybeNotifySlotOwnerAfterThirdPartyEdit({
    currentUser,
    action,
    targetOwnerEmail,
    targetOwnerDisplayName,
    targetOwnerUserId,
    slotTitle,
    slotStart,
    slotEnd,
    previousStartIso,
    previousEndIso
}) {
    if (!isBackendAuthConfigured()) return;
    const actor = String(currentUser?.email ?? '')
        .trim()
        .toLowerCase();
    const owner = String(targetOwnerEmail ?? '')
        .trim()
        .toLowerCase();
    if (!actor || !owner || owner === actor) return;

    let display = String(targetOwnerDisplayName ?? '').trim();
    const uid = String(targetOwnerUserId ?? '').trim();
    if (uid) {
        const m = await fetchProfileLabelsForUserIds([uid]);
        const lab = m.get(uid);
        if (lab) display = String(lab).trim() || display;
    }
    const ownerLabel = buildSlotOwnerNotifyLabel(owner, display);

    let r;
    try {
        r = await invokeSlotNotify({
            action,
            targetEmail: owner,
            actorEmail: actor,
            actorDisplayName: String(currentUser?.name ?? '').trim() || actor,
            slotTitle: String(slotTitle ?? '').trim() || 'Créneau',
            slotStartIso: slotStart instanceof Date ? slotStart.toISOString() : String(slotStart ?? ''),
            slotEndIso: slotEnd instanceof Date ? slotEnd.toISOString() : String(slotEnd ?? ''),
            previousStartIso: String(previousStartIso ?? ''),
            previousEndIso: String(previousEndIso ?? '')
        });
    } catch (e) {
        console.warn('[slot-notify] échec appel', e);
        showToast(
            `L’e-mail n’a pas pu être envoyé à ${ownerLabel}. Merci de le ou la prévenir directement.`,
            'error'
        );
        return;
    }

    const label = ownerLabel;
    if (r.skipped) return;
    if (r.emailSent) {
        showToast(`Un e-mail a été envoyé à ${label} pour l’informer du changement.`, 'success');
    } else {
        const errCode = String(r.error || '');
        const detail = String(/** @type {{ detail?: string }} */ (r).detail || '').trim();
        let hint = '';
        if (errCode === 'EMAIL_NOT_CONFIGURED') {
            hint = ' Messagerie non configurée côté serveur (Brevo / expéditeur).';
        } else if (errCode === 'BREVO_SEND_FAILED' && detail) {
            hint = ` Voir console (F12) pour le détail Brevo.`;
            console.warn('[slot-notify] Brevo', detail);
            // Diagnostic serveur (sans exposer la clé) pour confirmer le secret réellement lu côté function.
            void invokeSlotNotify({
                debugBrevo: true
            }).then((dbg) => {
                const d = /** @type {{ debug?: unknown }} */ (dbg).debug;
                if (d) {
                    console.warn('[slot-notify] Brevo debug', d);
                    try {
                        console.warn('[slot-notify] Brevo debug json', JSON.stringify(d));
                    } catch {
                        /* */
                    }
                }
            }).catch(() => {
                /* non bloquant */
            });
        } else if (errCode && errCode !== 'undefined') {
            hint = ` (${errCode})`;
        }
        showToast(
            `L’e-mail n’a pas pu être envoyé à ${label}.${hint} Merci de le ou la prévenir directement.`,
            'error',
            12000
        );
    }
}

/**
 * Variante non bloquante : utilisée après une action déjà validée en base.
 * L'échec mail ne doit jamais annuler le changement métier.
 */
function notifySlotOwnerAfterThirdPartyEditNonBlocking(payload) {
    void maybeNotifySlotOwnerAfterThirdPartyEdit(payload).catch((err) => {
        console.warn('[slot-notify] non bloquant', err);
    });
}

/**
 * E-mails aux élèves inscrits quand un cours est modifié par un tiers.
 * @param {{ currentUser: object, slotTitle: string, slotStart: string|Date, slotEnd: string|Date, previousStartIso?: string, previousEndIso?: string, inscritEmails?: string[], ownerEmail?: string }} p
 */
async function maybeNotifyEnrolledStudentsOnCoursEdit(p) {
    if (!isBackendAuthConfigured()) return;
    const actor = String(p.currentUser?.email ?? '')
        .trim()
        .toLowerCase();
    if (!actor) return;
    const owner = String(p.ownerEmail ?? '')
        .trim()
        .toLowerCase();
    const raw = Array.isArray(p.inscritEmails) ? p.inscritEmails : [];
    const seen = new Set();
    for (const em of raw) {
        const t = String(em || '').trim().toLowerCase();
        if (!t || t === actor || (owner && t === owner) || seen.has(t)) continue;
        seen.add(t);
        try {
            await invokeSlotNotify({
                action: 'enrolled_modified',
                targetEmail: t,
                actorEmail: actor,
                actorDisplayName: String(p.currentUser?.name ?? '').trim() || actor,
                slotTitle: String(p.slotTitle ?? '').trim() || 'Cours',
                slotStartIso:
                    p.slotStart instanceof Date ? p.slotStart.toISOString() : String(p.slotStart ?? ''),
                slotEndIso: p.slotEnd instanceof Date ? p.slotEnd.toISOString() : String(p.slotEnd ?? ''),
                previousStartIso: String(p.previousStartIso ?? ''),
                previousEndIso: String(p.previousEndIso ?? '')
            });
        } catch (e) {
            console.warn('[slot-notify] inscrit', t, e);
        }
    }
}

function notifyEnrolledStudentsOnCoursEditNonBlocking(p) {
    void maybeNotifyEnrolledStudentsOnCoursEdit(p).catch((err) => {
        console.warn('[slot-notify] inscrits non bloquant', err);
    });
}

/**
 * Après modification d’un cours (modale, glisser-déposer, redimensionnement).
 * @param {object} currentUser
 * @param {{ title?: string, start?: Date, end?: Date, extendedProps?: Record<string, unknown> }} eventLike
 * @param {{ title?: string, startStr?: string, endStr?: string }} [previousSnapshot]
 * @param {string[]} [inscritEmails]
 */
export function notifyEnrolledStudentsAfterCoursChangeNonBlocking(
    currentUser,
    eventLike,
    previousSnapshot = null,
    inscritEmails = null
) {
    const dbSlotType = planningDbSlotTypeForEventUpdate(eventLike);
    if (dbSlotType !== 'cours') return;
    const title = String(eventLike?.title || '').trim() || 'Cours';
    const start = eventLike?.start instanceof Date ? eventLike.start : null;
    const end = eventLike?.end instanceof Date ? eventLike.end : null;
    if (!start || !end) return;
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    const prev = previousSnapshot || {};
    const changed =
        String(prev.title || '').trim() !== title ||
        String(prev.startStr || '') !== startIso ||
        String(prev.endStr || '') !== endIso;
    if (!changed) return;
    const emails =
        Array.isArray(inscritEmails) && inscritEmails.length
            ? inscritEmails
            : inscritEmailsFromExtendedProps(eventLike?.extendedProps);
    if (!emails.length) return;
    const owner = ownerInfoFromEvent(eventLike, currentUser);
    notifyEnrolledStudentsOnCoursEditNonBlocking({
        currentUser,
        slotTitle: title,
        slotStart: start,
        slotEnd: end,
        previousStartIso: String(prev.startStr || ''),
        previousEndIso: String(prev.endStr || ''),
        inscritEmails: emails,
        ownerEmail: owner.ownerEmail
    });
}

/** @param {Record<string, unknown> | undefined} xp */
function inscritEmailsFromExtendedProps(xp) {
    const raw = xp?.inscrits;
    if (Array.isArray(raw)) {
        return raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    }
    return String(raw || '')
        .split(/[,;]/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

/**
 * Élève inscrit sur un créneau « cours » (planning_event_enrollment exposé via RPC).
 * @param {{ extendedProps?: Record<string, unknown> } | null} eventLike
 * @param {object | null} currentUser
 */
export function isEleveEnrolledInCoursEvent(eventLike, currentUser) {
    const type = String(eventLike?.extendedProps?.type || '').toLowerCase();
    const dbSlot = String(eventLike?.extendedProps?.planningDbSlotType || '').toLowerCase();
    if (type !== 'cours' && dbSlot !== 'cours') return false;
    const me = String(currentUser?.email || '')
        .trim()
        .toLowerCase();
    if (!me) return false;
    return inscritEmailsFromExtendedProps(eventLike?.extendedProps).includes(me);
}

/**
 * Classe CSS créneau (alignée sur la grille FullCalendar).
 * @param {{ extendedProps?: Record<string, unknown>, title?: string } | null} eventLike
 * @param {object | null} currentUser
 */
export function getPlanningEventColorClass(eventLike, currentUser, options = {}) {
    const ownerEmail = String(eventLike?.extendedProps?.owner || '')
        .trim()
        .toLowerCase();
    const me = String(currentUser?.email || '')
        .trim()
        .toLowerCase();
    const isMine = Boolean(me && ownerEmail && ownerEmail === me);
    const type = String(eventLike?.extendedProps?.type || 'reservation').toLowerCase();
    const dbSlot = String(eventLike?.extendedProps?.planningDbSlotType || '').toLowerCase();
    const isCoursSlot = type === 'cours' || type === 'maintenance' || dbSlot === 'cours';

    if (options.selectionPreview) {
        const role = normalizeRole(currentUser?.role);
        if ((role === 'eleve' || role === 'prof') && !ownerEmail) {
            if (type === 'fermeture' || dbSlot === 'fermeture') return 'event-fermeture';
            if (type === 'indispo' || dbSlot === 'indispo') return 'event-fermeture';
            if (isCoursSlot) return 'event-cours';
            if (type === 'concert') return 'event-concert';
            if (type === 'autre') return 'event-autre';
            return 'event-travail-mine';
        }
    }

    if (type === 'fermeture' || dbSlot === 'fermeture') return 'event-fermeture';
    if (type === 'indispo' || dbSlot === 'indispo') return 'event-fermeture';
    const meRole = normalizeRole(currentUser?.role);
    if (isCoursSlot && meRole === 'prof' && isMine) {
        return 'event-cours-enrolled';
    }
    if (isCoursSlot && isEleveEnrolledInCoursEvent(eventLike, currentUser)) {
        return 'event-cours-enrolled';
    }
    if (isCoursSlot) return 'event-cours';
    if (type === 'concert') return 'event-concert';
    if (type === 'autre') return 'event-autre';
    if (dbSlot === 'travail perso' || type === 'reservation') {
        return isMine ? 'event-travail-mine' : 'event-travail-other';
    }
    return isMine ? 'event-travail-mine' : 'event-travail-other';
}

// --- 1. RENDU VISUEL DES CRÉNEAUX ---
export function getEventContent(arg, currentUser) {
    const isMirror = Boolean(arg.isMirror);
    const title = String(arg.event.title || '').trim();
    const start = arg.event.start;
    const end = arg.event.end;

    const durationMs = end - start;
    const durationMin = Math.round(durationMs / (1000 * 60));

    const colorClass = getPlanningEventColorClass(arg.event, currentUser, {
        selectionPreview: isMirror
    });

    const formatTime = (date) => formatTimeFr24(date);

    const endDisplay = new Date(end);
    const sameCalendarDay =
        start.getFullYear() === endDisplay.getFullYear() &&
        start.getMonth() === endDisplay.getMonth() &&
        start.getDate() === endDisplay.getDate();

    const formatShortDay = (d) => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

    const timeTextFc = String(arg.timeText || '').trim();
    let timeLine;
    if (!sameCalendarDay) {
        timeLine = `${formatShortDay(start)} ${formatTime(start)} → ${formatShortDay(endDisplay)} ${formatTime(endDisplay)}`;
    } else if (timeTextFc) {
        timeLine = timeTextFc.replace(/\s*-\s*/g, '–').replace(/\s+/g, '');
    } else {
        timeLine = `${formatTime(start)}–${formatTime(endDisplay)}`;
    }

    const showTitleRow = Boolean(title) && (!sameCalendarDay || durationMin > 30);

    const pastReadonly = isReservationNonEditablePast(currentUser, arg.event);

    /* Même contenu pour le miroir FC (drag / redimensionnement) : horaires mis à jour en direct par FC. */
    const mirrorCls = isMirror ? ' event-box--fc-mirror' : '';
    const pastCls = pastReadonly ? ' event-box--past-readonly' : '';
    const aria = isMirror ? ' aria-hidden="true"' : '';

    let innerHTML = `
        <div class="event-box flex flex-col h-full w-full ${colorClass}${mirrorCls}${pastCls}"${aria}>
            <div class="event-time event-time-fc">${escapeHtml(timeLine)}</div>`;
    if (showTitleRow) {
        innerHTML += `
            <div class="event-title event-title-fc">${escapeHtml(title)}</div>`;
    }
    innerHTML += `</div>`;

    return { html: innerHTML };
}

/** Fin affichée : conserver l'heure exacte de fin (ex. 12:00), sans -1 minute. */
function selectionEndDisplay(endExclusive) {
    return new Date(endExclusive);
}

/** Aligné sur les `<option>` HH:mm (toLocaleTimeString fr-FR ne correspond pas toujours). */
function formatTimeForSelect(d) {
    const h = d.getHours();
    const m = d.getMinutes();
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function setSelectTime(selectEl, d) {
    if (!selectEl || !d) return;
    const v = formatTimeForSelect(d);
    if ([...selectEl.options].some((o) => o.value === v)) {
        selectEl.value = v;
        return;
    }
    const want = d.getHours() * 60 + d.getMinutes();
    let best = selectEl.options[0]?.value ?? v;
    let bestDiff = Infinity;
    for (const o of selectEl.options) {
        const [oh, om] = o.value.split(':').map(Number);
        const t = oh * 60 + om;
        const diff = Math.abs(t - want);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = o.value;
        }
    }
    selectEl.value = best;
}

function capitalizeFrDatePhrase(s) {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Phrase type « Le lundi 6 avril 2026, de 09:00 à 10:30 » (fin d’événement FullCalendar = exclusive). */
function formatOccupationWhenSentence(start, endExclusive) {
    const endDisplay = selectionEndDisplay(endExclusive);
    const ds = start.toLocaleDateString('en-CA');
    const de = endDisplay.toLocaleDateString('en-CA');
    const tStart = formatTimeForSelect(start);
    const tEnd = formatTimeForSelect(endDisplay);
    const d1 = new Date(`${ds}T12:00:00`);
    const d2 = new Date(`${de}T12:00:00`);
    const long1 = capitalizeFrDatePhrase(
        d1.toLocaleDateString('fr-FR', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        })
    );
    if (ds === de) {
        return `Le ${long1}, de ${tStart} à ${tEnd}`;
    }
    const long2 = capitalizeFrDatePhrase(
        d2.toLocaleDateString('fr-FR', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        })
    );
    return `Du ${long1} au ${long2}, de ${tStart} à ${tEnd}`;
}

function clockMinutes(hhmm) {
    const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
    return h * 60 + m;
}

/**
 * Jours calendaires (en-CA) entre deux bornes incluses.
 * @param {'all'|'custom'} pattern — `custom` utilise dowSet (chiffres JS day : 0=dim … 6=sam).
 */
function enumerateRecurringDays(periodStartYmd, periodEndYmd, pattern, dowSet) {
    const dates = [];
    const cur = new Date(`${periodStartYmd}T12:00:00`);
    const last = new Date(`${periodEndYmd}T12:00:00`);
    if (Number.isNaN(cur.getTime()) || Number.isNaN(last.getTime()) || cur > last) return dates;

    while (cur <= last) {
        const dow = cur.getDay();
        let keep = false;
        if (pattern === 'all') keep = true;
        else if (pattern === 'custom' && dowSet && dowSet.has(dow)) keep = true;
        if (keep) dates.push(cur.toLocaleDateString('en-CA'));
        cur.setDate(cur.getDate() + 1);
    }
    return dates;
}

function sameCalendarDay(a, b) {
    return (
        a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate()
    );
}

/** Plages [aStart, aEnd) et [bStart, bEnd) (fin exclusive, comme FullCalendar). */
function calendarRangesOverlap(aStart, aEnd, bStart, bEnd) {
    if (!aStart || !aEnd || !bStart || !bEnd) return false;
    return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

function eventRangeForOverlap(ev) {
    const s = ev?.start ? new Date(ev.start) : null;
    if (!s || Number.isNaN(s.getTime())) return null;
    let e = ev.end ? new Date(ev.end) : null;
    if (ev.allDay) {
        if (!e || Number.isNaN(e.getTime())) {
            e = new Date(s);
            e.setDate(e.getDate() + 1);
        }
        return { start: s, end: e };
    }
    if (!e || Number.isNaN(e.getTime())) {
        e = new Date(s.getTime() + 60 * 1000);
    }
    return { start: s, end: e };
}

/** Lecture sûre : EventApi FC obsolète après refetch → getter extendedProps peut lever. */
function safeEventExtendedProps(eventRef) {
    if (!eventRef) return null;
    try {
        const xp = eventRef.extendedProps;
        return xp && typeof xp === 'object' ? xp : null;
    } catch {
        return null;
    }
}

function safeEventId(eventRef) {
    if (!eventRef) return '';
    try {
        return eventRef.id != null ? String(eventRef.id).trim() : '';
    } catch {
        return '';
    }
}

/** Réaligne reservationModalEventRef sur l’événement affiché après refetch / auto-save. */
function syncReservationModalLiveEventRef() {
    const cal = reservationModalCalendarRef;
    if (!cal) return reservationModalEventRef;
    const xp = safeEventExtendedProps(reservationModalEventRef);
    const canon = String(xp?.planningCanonicalId || safeEventId(reservationModalEventRef) || '').trim();
    return refreshReservationModalEventRef(cal, reservationModalEventRef, canon);
}

/**
 * Après refetch grille, la modale peut encore référencer le créneau optimiste supprimé (id FC interne ≠ uuid base).
 * Retrouve l’instance affichée pour exclusion au chevauchement et pour l’upsert (planningCanonicalId).
 * @returns {import('@fullcalendar/core').EventApi | null}
 */
function resolveLivePlanningEventRef(calendar, eventRef) {
    if (!eventRef || !calendar?.getEvents) return null;
    let id = '';
    try {
        id = eventRef.id != null ? String(eventRef.id).trim() : '';
    } catch {
        return null;
    }
    if (id && typeof calendar.getEventById === 'function') {
        try {
            const byId = calendar.getEventById(id);
            if (byId) return byId;
        } catch {
            /* référence FC obsolète après refetch */
        }
    }
    let canon = '';
    let owner = '';
    try {
        canon = String(eventRef.extendedProps?.planningCanonicalId || '').trim();
        owner = String(eventRef.extendedProps?.owner || '').trim().toLowerCase();
    } catch {
        return null;
    }
    if (canon) {
        for (const ev of calendar.getEvents()) {
            if (String(ev.extendedProps?.planningCanonicalId || '').trim() === canon) return ev;
        }
    }
    let r0 = null;
    try {
        r0 = eventRangeForOverlap(eventRef);
    } catch {
        return null;
    }
    if (!r0 || !owner) return null;
    const s0 = r0.start.getTime();
    const e0 = r0.end.getTime();
    for (const ev of calendar.getEvents()) {
        const o2 = String(ev.extendedProps?.owner || '').trim().toLowerCase();
        if (o2 !== owner) continue;
        const r = eventRangeForOverlap(ev);
        if (!r) continue;
        if (r.start.getTime() === s0 && r.end.getTime() === e0) return ev;
    }
    return null;
}

/** Met à jour la référence modale / app après sauvegarde ou refetch. */
function refreshReservationModalEventRef(calendar, eventRef, canonicalId = '') {
    const xp = safeEventExtendedProps(eventRef);
    const canon = String(
        canonicalId || xp?.planningCanonicalId || safeEventId(eventRef) || ''
    ).trim();
    let next = eventRef ? resolveLivePlanningEventRef(calendar, eventRef) : null;
    if (!next && canon && calendar?.getEvents) {
        for (const ev of calendar.getEvents()) {
            if (String(ev.extendedProps?.planningCanonicalId || '').trim() === canon) {
                next = ev;
                break;
            }
        }
    }
    if (next) {
        reservationModalEventRef = next;
        reservationAutoSaveDeps?.setEvent?.(next);
    }
    return next;
}

function isSameFcEvent(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const xa = safeEventExtendedProps(a);
    const xb = safeEventExtendedProps(b);
    const ca = String(xa?.planningCanonicalId || '').trim();
    const cb = String(xb?.planningCanonicalId || '').trim();
    if (ca && cb && ca === cb) return true;
    const ga = String(xa?.googleEventId || '').trim();
    const gb = String(xb?.googleEventId || '').trim();
    if (ga && gb && ga === gb) return true;
    const ida = safeEventId(a);
    const idb = safeEventId(b);
    return Boolean(ida && idb && ida === idb);
}

function isSameLogicalEventByOwnerAndRange(a, b) {
    if (!a || !b) return false;
    const ra = eventRangeForOverlap(a);
    const rb = eventRangeForOverlap(b);
    if (!ra || !rb) return false;
    if (ra.start.getTime() !== rb.start.getTime()) return false;
    if (ra.end.getTime() !== rb.end.getTime()) return false;
    const oa = String(a.extendedProps?.owner || '')
        .trim()
        .toLowerCase();
    const ob = String(b.extendedProps?.owner || '')
        .trim()
        .toLowerCase();
    return Boolean(oa && ob && oa === ob);
}

/**
 * Premier événement qui chevauche [rangeStart, rangeEnd), hors `excludeEvent` (édition).
 * @returns {import('@fullcalendar/core').EventApi | null}
 */
function findOverlappingCalendarEvent(calendar, rangeStart, rangeEnd, excludeEvent) {
    if (!calendar?.getEvents) return null;
    const resolvedExclude =
        excludeEvent != null ? resolveLivePlanningEventRef(calendar, excludeEvent) : null;
    const rs = rangeStart instanceof Date ? rangeStart : new Date(rangeStart);
    const re = rangeEnd instanceof Date ? rangeEnd : new Date(rangeEnd);
    if (Number.isNaN(rs.getTime()) || Number.isNaN(re.getTime()) || re.getTime() <= rs.getTime()) {
        return null;
    }
    for (const ev of calendar.getEvents()) {
        if (isSameFcEvent(ev, resolvedExclude)) continue;
        if (resolvedExclude && isSameLogicalEventByOwnerAndRange(ev, resolvedExclude)) continue;
        const r = eventRangeForOverlap(ev);
        if (!r) continue;
        if (calendarRangesOverlap(rs, re, r.start, r.end)) {
            return ev;
        }
    }
    return null;
}

function overlapToastMessage(conflict) {
    const t = String(conflict?.title || '').trim() || 'Créneau';
    const r = eventRangeForOverlap(conflict);
    const xp = safeEventExtendedProps(conflict);
    const isFerm =
        String(xp?.type || '').toLowerCase() === 'fermeture' ||
        String(xp?.planningDbSlotType || '').trim().toLowerCase() === 'fermeture';
    const isIndispo =
        String(xp?.type || '').toLowerCase() === 'indispo' ||
        String(xp?.planningDbSlotType || '').trim().toLowerCase() === 'indispo';
    const tf = (d) => formatWeekdayDayTimeFr24(d);
    if (isFerm && r) {
        return `Période de fermeture « ${t} » (${tf(r.start)} – ${tf(r.end)}). Choisissez un autre horaire.`;
    }
    if (isIndispo && r) {
        return `Indispo « ${t} » (${tf(r.start)} – ${tf(r.end)}). Choisissez un autre horaire.`;
    }
    if (!r) return `Ce créneau chevauche une autre réservation : « ${t} ».`;
    return `Chevauchement avec « ${t} » (${tf(r.start)} – ${tf(r.end)}). Choisissez un autre horaire.`;
}

/**
 * Annule le redimensionnement si la fin dépasse sur un autre jour (fin FC = exclusive).
 * Appeler après `captureResizeStart` (eventResizeStart).
 */
export async function handleEventResize(info, currentUser) {
    const start = info.event.start;
    const end = info.event.end;
    if (!start || !end) return;
    if (isReservationNonEditablePast(currentUser, info.event)) {
        info.revert();
        resizePreviousRange.delete(info.event);
        showToast('Les créneaux passés ne sont pas modifiables.', 'error');
        return;
    }
    const endInclusive = new Date(end.getTime() - 1);
    if (!sameCalendarDay(start, endInclusive)) {
        info.revert();
        resizePreviousRange.delete(info.event);
        showToast('Un créneau ne peut pas déborder sur le jour suivant.', 'error');
        return;
    }
    const prevFromMap = resizePreviousRange.get(info.event);
    resizePreviousRange.delete(info.event);

    const prevSnap = seriesPrevSnapshotFromEvent(info.oldEvent);
    const oldEv = info.oldEvent;
    let previousStartIso = '';
    let previousEndIso = '';
    if (oldEv?.start instanceof Date && oldEv?.end instanceof Date) {
        previousStartIso = oldEv.start.toISOString();
        previousEndIso = oldEv.end.toISOString();
    } else if (prevFromMap) {
        previousStartIso = prevFromMap.startIso;
        previousEndIso = prevFromMap.endIso;
    }
    const runResizeNotifications = () => {
        const oi = ownerInfoFromEvent(info.event, currentUser);
        const me = String(currentUser?.email ?? '')
            .trim()
            .toLowerCase();
        const newStartIso = info.event.start ? info.event.start.toISOString() : '';
        const newEndIso = info.event.end ? info.event.end.toISOString() : '';
        const rangeChanged =
            Boolean(previousStartIso && previousEndIso && newStartIso && newEndIso) &&
            (previousStartIso !== newStartIso || previousEndIso !== newEndIso);

        if (oi.ownerEmail && oi.ownerEmail !== me && rangeChanged) {
            notifySlotOwnerAfterThirdPartyEditNonBlocking({
                currentUser,
                action: 'modified',
                targetOwnerEmail: oi.ownerEmail,
                targetOwnerDisplayName: oi.ownerName,
                targetOwnerUserId: oi.ownerUserId,
                slotTitle: info.event.title,
                slotStart: info.event.start,
                slotEnd: info.event.end,
                previousStartIso,
                previousEndIso
            });
        }
        if (rangeChanged) {
            notifyEnrolledStudentsAfterCoursChangeNonBlocking(currentUser, info.event, {
                title: String(info.event.title || '').trim(),
                startStr: previousStartIso,
                endStr: previousEndIso
            });
        }
    };
    const sync = await syncReservationEventToGoogle(
        info.event,
        info.view.calendar,
        currentUser,
        prevSnap,
        { onGoogleSyncSuccess: runResizeNotifications }
    );
    if (!sync.ok) {
        info.revert();
        return;
    }
}

function defaultSeriesUntilYmd(startYmd = '') {
    const { endYmd } = getSchoolYearBoundsFromSettings(getOrganSchoolSettingsCached());
    if (endYmd) return endYmd;
    const start = /^\d{4}-\d{2}-\d{2}$/.test(String(startYmd || ''))
        ? new Date(`${startYmd}T00:00:00`)
        : new Date();
    const d = new Date(start);
    d.setFullYear(d.getFullYear() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function repeatModeFromForm() {
    const raw = String(document.getElementById('event-repeat-mode')?.value || 'once').trim();
    if (raw === 'weekly' || raw === 'biweekly') return raw;
    return 'once';
}

function repeatEndModeFromForm() {
    return String(document.getElementById('event-repeat-end-mode')?.value || 'until').trim() === 'count'
        ? 'count'
        : 'until';
}

function isMotifFermeture(motif) {
    return String(motif || '').trim() === 'Fermeture';
}

function isMotifIndispo(motif) {
    return String(motif || '').trim() === 'Indispo';
}

function reservationUsesDateEndRange(motif) {
    return isMotifFermeture(motif) || isMotifIndispo(motif);
}

function syncReservationRangeModeUi(currentUser, eventRef = null, canEditEvent = true) {
    const motif = getReservationMotifFromForm(currentUser, eventRef);
    const showDateEnd = reservationUsesDateEndRange(motif);
    const hideHours = isMotifFermeture(motif);
    const dateEndWrap = document.getElementById('wrap-reservation-date-end');
    const hoursWrap = document.getElementById('wrap-reservation-hours');
    const recurWrap = document.getElementById('event-recurring-wrap');
    if (dateEndWrap) {
        dateEndWrap.classList.toggle('hidden', !showDateEnd);
        dateEndWrap.setAttribute('aria-hidden', showDateEnd ? 'false' : 'true');
    }
    if (hoursWrap) {
        hoursWrap.classList.toggle('hidden', hideHours);
        hoursWrap.setAttribute('aria-hidden', hideHours ? 'true' : 'false');
    }
    if (recurWrap) {
        const canRepeat = isPrivilegedUser(currentUser) && !eventRef && !showDateEnd;
        recurWrap.classList.toggle('hidden', !canRepeat);
        recurWrap.setAttribute('aria-hidden', canRepeat ? 'false' : 'true');
        const repeatModeEl = document.getElementById('event-repeat-mode');
        const repeatEndModeEl = document.getElementById('event-repeat-end-mode');
        const repeatUntilEl = document.getElementById('event-repeat-until');
        const repeatCountEl = document.getElementById('event-repeat-count');
        if (repeatModeEl instanceof HTMLSelectElement) {
            repeatModeEl.disabled = !canRepeat || !canEditEvent;
            if (!canRepeat) repeatModeEl.value = 'once';
        }
        if (repeatEndModeEl instanceof HTMLSelectElement) repeatEndModeEl.disabled = !canRepeat || !canEditEvent;
        if (repeatUntilEl instanceof HTMLInputElement) repeatUntilEl.disabled = !canRepeat || !canEditEvent;
        if (repeatCountEl instanceof HTMLInputElement) repeatCountEl.disabled = !canRepeat || !canEditEvent;
    }
    setRecurringOptionsVisible();
}

export function setRecurringOptionsVisible() {
    const recurring = repeatModeFromForm() !== 'once';
    document.getElementById('event-repeat-options')?.classList.toggle('hidden', !recurring);
    const endMode = repeatEndModeFromForm();
    document.getElementById('event-repeat-until-wrap')?.classList.toggle(
        'hidden',
        !recurring || endMode !== 'until'
    );
    document.getElementById('event-repeat-count-wrap')?.classList.toggle(
        'hidden',
        !recurring || endMode !== 'count'
    );
}

function resetRecurringFormDefaults() {
    const mode = document.getElementById('event-repeat-mode');
    const endMode = document.getElementById('event-repeat-end-mode');
    const until = document.getElementById('event-repeat-until');
    const count = document.getElementById('event-repeat-count');
    if (mode instanceof HTMLSelectElement) mode.value = 'once';
    if (endMode instanceof HTMLSelectElement) endMode.value = 'until';
    const startYmd = String(document.getElementById('event-date-start')?.value || '').slice(0, 10);
    if (until instanceof HTMLInputElement) until.value = defaultSeriesUntilYmd(startYmd);
    if (count instanceof HTMLInputElement) count.value = '';
    setRecurringOptionsVisible();
}

function selectedDowSet() {
    const set = new Set();
    for (let i = 0; i <= 6; i++) {
        const cb = document.getElementById(`recur-dow-${i}`);
        if (cb?.checked) set.add(i);
    }
    return set;
}

function getReservationMotifFromForm(currentUser, eventRef = null) {
    const lockedType = reservationSlotTypeLockedFromEvent(currentUser, eventRef);
    if (lockedType) return slotTypeToMotif(lockedType);
    const sel = document.getElementById('event-motif-select');
    const allowed = allowedMotifsForReservationModal(currentUser, eventRef);
    const fallbackMotif =
        !eventRef && normalizeRole(currentUser?.role) === 'eleve'
            ? 'Cours'
            : defaultMotifForRole(currentUser?.role);
    const raw = String(sel?.value || '').trim();
    if (!raw) return '';
    const v = normalizeMotif(raw || fallbackMotif);
    if (allowed.includes(v)) return v;
    return allowed[0] || fallbackMotif;
}

function getReservationTextTitleFromForm(currentUser, motif) {
    if (normalizeRole(currentUser?.role) === 'eleve') {
        return reservationDisplayTitleForCurrentUser(currentUser);
    }
    const input = document.getElementById('event-title-input');
    const typed = String(input?.value || '').trim();
    if (typed) return typed;
    if (motif) return motifDisplayLabel(motif);
    return '';
}

/** Fin de journée affichable (slotMaxTime) le même jour calendaire que `start`. */
function slotMaxInstantOnSameDay(start, calendar) {
    const raw = calendar?.getOption?.('slotMaxTime');
    let h = 22;
    let m = 0;
    let s = 0;
    if (typeof raw === 'string') {
        const match = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (match) {
            h = +match[1];
            m = +match[2];
            s = +(match[3] || 0);
        }
    } else if (raw && typeof raw === 'object') {
        h = /** @type {{ hours?: number }} */ (raw).hours ?? 0;
        m = /** @type {{ minutes?: number }} */ (raw).minutes ?? 0;
        s = /** @type {{ seconds?: number }} */ (raw).seconds ?? 0;
    }
    const d = new Date(start);
    d.setHours(h, m, s, 0);
    return d;
}

/**
 * Première borne (instant) après `start` où la plage cesse d’être libre : début du prochain événement
 * le même jour, ou slotMax. [start, retour) est théoriquement libre (hors chevauchement anormal).
 */
function nextExclusiveFreeBoundary(start, calendar) {
    const limit = slotMaxInstantOnSameDay(start, calendar).getTime();
    let boundary = limit;
    const startMs = start.getTime();

    for (const ev of calendar.getEvents()) {
        if (ev.display === 'background') continue;
        const r = eventRangeForOverlap(ev);
        if (!r) continue;
        const es = r.start.getTime();
        const ee = r.end.getTime();
        if (ee <= startMs) continue;
        if (es <= startMs && ee > startMs) {
            return new Date(startMs);
        }
        if (es > startMs && sameCalendarDay(r.start, start)) {
            boundary = Math.min(boundary, es);
        }
    }
    return new Date(boundary);
}

function slotMinInstantOnSameDay(start, calendar) {
    const raw = calendar?.getOption?.('slotMinTime');
    let h = 8;
    let m = 0;
    let s = 0;
    if (typeof raw === 'string') {
        const match = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (match) {
            h = +match[1];
            m = +match[2];
            s = +(match[3] || 0);
        }
    } else if (raw && typeof raw === 'object') {
        h = /** @type {{ hours?: number }} */ (raw).hours ?? 0;
        m = /** @type {{ minutes?: number }} */ (raw).minutes ?? 0;
        s = /** @type {{ seconds?: number }} */ (raw).seconds ?? 0;
    }
    const d = new Date(start);
    d.setHours(h, m, s, 0);
    return d;
}

function nextExclusiveFreeBoundaryWithExclude(start, calendar, excludeEvent, dayIntervals = null) {
    const limit = slotMaxInstantOnSameDay(start, calendar).getTime();
    const startMs = start.getTime();
    const intervals =
        dayIntervals ||
        collectDayReservationIntervals(calendar, start, excludeEvent);
    const boundary = nextExclusiveFreeBoundaryFromIntervals(startMs, limit, intervals);
    return new Date(boundary);
}

function buildHalfHourChoices(startInclusive, endInclusive) {
    const out = [];
    const cur = new Date(startInclusive);
    cur.setSeconds(0, 0);
    while (cur.getTime() <= endInclusive.getTime()) {
        const minute = cur.getMinutes();
        if (minute === 0 || minute === 30) out.push(formatTimeForSelect(cur));
        cur.setMinutes(cur.getMinutes() + 30);
    }
    return out;
}

/** Premier créneau 30 min (local) dont le début est ≥ maintenant. */
function firstHalfHourOnOrAfterNowLocal() {
    const n = new Date();
    const totalMins = n.getHours() * 60 + n.getMinutes();
    const extra = n.getSeconds() > 0 || n.getMilliseconds() > 0 ? 1 : 0;
    const slot = Math.ceil((totalMins + extra) / 30) * 30;
    return new Date(n.getFullYear(), n.getMonth(), n.getDate(), Math.floor(slot / 60), slot % 60, 0, 0);
}

function snapInstantUpToHalfHourGrid(d) {
    const x = new Date(d);
    x.setSeconds(0, 0);
    const m = x.getMinutes();
    if (m === 0 || m === 30) return x;
    if (m < 30) {
        x.setMinutes(30, 0, 0);
        return x;
    }
    x.setHours(x.getHours() + 1, 0, 0, 0);
    return x;
}

/**
 * Borne minimale pour les listes début/fin : élève + jour courant → pas avant l’heure actuelle
 * ni avant le début du créneau édité (évite de ramener le début dans le passé).
 */
function minReservationModalStartInstant(dateYmd, calendar, eventRef) {
    if (eventRef) return null;
    const dayAnchor = new Date(`${dateYmd}T12:00:00`);
    if (Number.isNaN(dayAnchor.getTime())) return null;
    const dayStart = slotMinInstantOnSameDay(dayAnchor, calendar);
    const dayMax = slotMaxInstantOnSameDay(dayAnchor, calendar);
    const lastStart = new Date(dayMax.getTime() - 30 * 60 * 1000);
    let minT = new Date(dayStart.getTime());
    const today = new Date();
    if (sameCalendarDay(dayAnchor, today)) {
        const u = reservationModalUserRef;
        if (normalizeRole(u?.role) === 'eleve') {
            const nowB = firstHalfHourOnOrAfterNowLocal();
            minT = new Date(Math.max(minT.getTime(), nowB.getTime()));
            if (eventRef?.start) {
                const raw = eventRef.start;
                const es = raw instanceof Date ? raw : new Date(raw);
                if (!Number.isNaN(es.getTime()) && sameCalendarDay(es, dayAnchor)) {
                    minT = new Date(Math.max(minT.getTime(), es.getTime()));
                }
            }
        }
    }
    if (minT.getTime() > lastStart.getTime()) return null;
    return minT;
}

function setSelectOptions(selectEl, values, preferred) {
    if (!(selectEl instanceof HTMLSelectElement)) return '';
    const unique = [...new Set(values)];
    const fallback = unique[0] || '';
    const keep = preferred && unique.includes(preferred) ? preferred : fallback;
    selectEl.replaceChildren();
    for (const v of unique) selectEl.add(new Option(v, v));
    if (keep) selectEl.value = keep;
    return keep;
}

function endSelectInstantOnDay(dateYmd, hhmm) {
    const d = new Date(`${dateYmd}T${hhmm}:00`);
    return Number.isNaN(d.getTime()) ? NaN : d.getTime();
}

/**
 * Heure de fin affichée : conserve la fin si elle reste valide ; sinon début + durée initiale, puis repli 30 min.
 * @param {Date} startAt
 * @param {string[]} endChoices
 * @param {string} preferredEndHint valeur courante du select fin
 * @param {number} initialDurationMs
 */
function pickReservationEndTime(startAt, endChoices, preferredEndHint, initialDurationMs) {
    const dateYmd = startAt.toLocaleDateString('en-CA');
    const startMs = startAt.getTime();
    const prefMs = preferredEndHint ? endSelectInstantOnDay(dateYmd, preferredEndHint) : NaN;
    if (Number.isFinite(prefMs) && prefMs > startMs && endChoices.includes(preferredEndHint)) {
        return preferredEndHint;
    }
    const targetHhmm = formatTimeForSelect(new Date(startMs + initialDurationMs));
    if (endChoices.includes(targetHhmm)) return targetHhmm;
    let best = '';
    for (const c of endChoices) {
        const t = endSelectInstantOnDay(dateYmd, c);
        if (Number.isFinite(t) && t > startMs) best = c;
    }
    return best || endChoices[0] || '';
}

function injectEditingEventReservationTimes(eventRef, dateValue, startChoices, startAt, endChoices) {
    if (!eventRef?.start || !eventRef?.end) return;
    const es = eventRef.start instanceof Date ? eventRef.start : new Date(eventRef.start);
    const ee = eventRef.end instanceof Date ? eventRef.end : new Date(eventRef.end);
    if (Number.isNaN(es.getTime()) || Number.isNaN(ee.getTime())) return;
    if (es.toLocaleDateString('en-CA') !== dateValue) return;
    const sv = formatTimeForSelect(es);
    if (!startChoices.includes(sv)) startChoices.push(sv);
    startChoices.sort();
    const endDisp = selectionEndDisplay(ee);
    const ev = formatTimeForSelect(endDisp);
    if (startAt && formatTimeForSelect(startAt) === sv && endChoices && !endChoices.includes(ev)) {
        endChoices.push(ev);
        endChoices.sort();
    }
}

function syncReservationModalTimeOptions(calendar, eventRef) {
    const dateEl = document.getElementById('event-date-start');
    const startEl = document.getElementById('event-start');
    const endEl = document.getElementById('event-end');
    if (!(dateEl instanceof HTMLInputElement)) return;
    if (!(startEl instanceof HTMLSelectElement)) return;
    if (!(endEl instanceof HTMLSelectElement)) return;
    if (!calendar?.getEvents) return;
    const dateValue = String(dateEl.value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return;
    const dayAnchor = new Date(`${dateValue}T12:00:00`);
    if (Number.isNaN(dayAnchor.getTime())) return;
    const dayIntervals = collectDayReservationIntervals(calendar, dayAnchor, eventRef);
    const dayStart = slotMinInstantOnSameDay(dayAnchor, calendar);
    const dayMax = slotMaxInstantOnSameDay(dayAnchor, calendar);
    const lastStart = new Date(dayMax.getTime() - 30 * 60 * 1000);
    const rawMin = minReservationModalStartInstant(dateValue, calendar, eventRef);
    let loopStart = new Date(dayStart.getTime());
    if (rawMin) {
        loopStart = snapInstantUpToHalfHourGrid(new Date(Math.max(rawMin.getTime(), dayStart.getTime())));
        while (loopStart.getTime() < rawMin.getTime()) {
            loopStart = new Date(loopStart.getTime() + 30 * 60 * 1000);
        }
    }
    const startChoices = [];
    for (
        let t = new Date(loopStart);
        t.getTime() <= lastStart.getTime();
        t = new Date(t.getTime() + 30 * 60 * 1000)
    ) {
        const boundary = nextExclusiveFreeBoundaryWithExclude(t, calendar, eventRef, dayIntervals);
        if (boundary.getTime() >= t.getTime() + 30 * 60 * 1000) {
            startChoices.push(formatTimeForSelect(t));
        }
    }
    injectEditingEventReservationTimes(eventRef, dateValue, startChoices, null, null);
    const userPickedStart = String(startEl.value || '').trim();
    const userPickedEnd = String(endEl.value || '').trim();
    if (userPickedStart && !startChoices.includes(userPickedStart)) {
        startChoices.push(userPickedStart);
        startChoices.sort();
    }
    let preferredStart = userPickedStart;
    let preferredEndHint = userPickedEnd;
    if (!preferredStart && eventRef?.start) {
        const es = eventRef.start instanceof Date ? eventRef.start : new Date(eventRef.start);
        if (!Number.isNaN(es.getTime()) && es.toLocaleDateString('en-CA') === dateValue) {
            preferredStart = formatTimeForSelect(es);
        }
    }
    if (!preferredEndHint && eventRef?.end) {
        const ee = eventRef.end instanceof Date ? eventRef.end : new Date(eventRef.end);
        const endDisp = selectionEndDisplay(ee);
        if (endDisp.toLocaleDateString('en-CA') === dateValue) {
            preferredEndHint = formatTimeForSelect(endDisp);
        }
    }
    const selectedStart = setSelectOptions(startEl, startChoices, preferredStart);
    if (!selectedStart) {
        endEl.replaceChildren();
        return;
    }
    const startAt = new Date(`${dateValue}T${selectedStart}:00`);
    const boundary = nextExclusiveFreeBoundaryWithExclude(startAt, calendar, eventRef, dayIntervals);
    const boundaryCap = new Date(Math.min(boundary.getTime(), dayMax.getTime()));
    let endChoices = buildHalfHourChoices(
        new Date(startAt.getTime() + 30 * 60 * 1000),
        boundaryCap
    );
    endChoices = endChoices.filter((hhmm) => {
        const t = endSelectInstantOnDay(dateValue, hhmm);
        return Number.isFinite(t) && t <= boundary.getTime();
    });
    if (userPickedEnd) {
        const pickedMs = endSelectInstantOnDay(dateValue, userPickedEnd);
        if (Number.isFinite(pickedMs) && pickedMs <= boundary.getTime() && !endChoices.includes(userPickedEnd)) {
            endChoices.push(userPickedEnd);
            endChoices.sort();
        }
    }
    injectEditingEventReservationTimes(eventRef, dateValue, startChoices, startAt, endChoices);
    endChoices = endChoices.filter((hhmm) => {
        const t = endSelectInstantOnDay(dateValue, hhmm);
        return Number.isFinite(t) && t <= boundary.getTime();
    });
    const currentEndHint = String(endEl.value || preferredEndHint || '').trim();
    const maxDurationMs = Math.max(
        30 * 60 * 1000,
        Math.min(reservationModalInitialDurationMs, boundary.getTime() - startAt.getTime())
    );
    const preferredEnd = pickReservationEndTime(startAt, endChoices, currentEndHint, maxDurationMs);
    setSelectOptions(endEl, endChoices, preferredEnd);
}

/** Jour + date courte (ligne unique dans le sélecteur de jour). */
function formatReservationDateLineFr(ymd) {
    const d = new Date(`${ymd}T12:00:00`);
    if (Number.isNaN(d.getTime())) return '';
    const s = d.toLocaleDateString('fr-FR', {
        weekday: 'long',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
    if (!s) return '';
    return s.replace(/^([a-zà-ÿéèê])/, (ch) => ch.toUpperCase());
}

function syncReservationDateWeekdayLabel() {
    const dateEl = document.getElementById('event-date-start');
    const displayEl =
        document.getElementById('event-date-display-label') ||
        document.getElementById('event-date-display');
    if (!(dateEl instanceof HTMLInputElement) || !displayEl) return;
    const ymd = String(dateEl.value || '').trim();
    const label = ymd ? formatReservationDateLineFr(ymd) : '';
    if (displayEl instanceof HTMLInputElement) {
        displayEl.value = label;
    } else {
        displayEl.textContent = label;
    }
}

function capitalizeFrHeadlineToken(s) {
    const t = String(s || '').trim();
    if (!t) return '';
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/** Ex. « Jeudi 21 Mai » (sans année). */
function formatReservationHeadlineDayFr(ymd) {
    const d = new Date(`${ymd}T12:00:00`);
    if (Number.isNaN(d.getTime())) return '';
    const wd = capitalizeFrHeadlineToken(
        d.toLocaleDateString('fr-FR', { weekday: 'long' })
    );
    const month = capitalizeFrHeadlineToken(
        d.toLocaleDateString('fr-FR', { month: 'long' })
    );
    return `${wd} ${d.getDate()} ${month}`.trim();
}

function reservationMotifLabelForHeadline(event) {
    if (event) {
        const dbEarly = String(event.extendedProps?.planningDbSlotType || '').trim().toLowerCase();
        const typEarly = String(event.extendedProps?.type || '').trim().toLowerCase();
        if (dbEarly === 'fermeture' || typEarly === 'fermeture') {
            return motifDisplayLabel('Fermeture');
        }
    }
    const sel = document.getElementById('event-motif-select');
    if (sel instanceof HTMLSelectElement) {
        const v = String(sel.value || '').trim();
        if (v) return motifDisplayLabel(v);
    }
    if (!event) return '';
    const dbType = String(event.extendedProps?.planningDbSlotType || '').trim();
    let motif = '';
    if (dbType === 'cours') motif = 'Cours';
    else if (dbType === 'concert') motif = 'Concert';
    else if (dbType === 'autre') motif = 'Autre';
    else if (dbType === 'fermeture') motif = 'Fermeture';
    else if (dbType === 'travail perso') motif = 'Travail';
    else motif = slotTypeToMotif(event.extendedProps?.type);
    return motifDisplayLabel(motif);
}

function reservationOwnerLabelForHeadline(event, ownerLabelOverride = '') {
    const o = String(ownerLabelOverride || reservationModalOwnerLabelRef || '').trim();
    if (o) return o;
    if (!event || !reservationModalUserRef) return '';
    const info = ownerInfoFromEvent(event, reservationModalUserRef);
    return (
        String(info.ownerName || '').trim() ||
        String(info.ownerEmail || '').split('@')[0] ||
        ''
    );
}

/** En-tête modale : « Jeudi 21 Mai — Travail perso. (Stéphane Bois) » */
function updateReservationModalHeadline(event) {
    const headline = document.getElementById('reservation-modal-headline');
    if (!(headline instanceof HTMLElement)) return;
    const dateEl = document.getElementById('event-date-start');
    const ymd =
        dateEl instanceof HTMLInputElement
            ? String(dateEl.value || '').trim()
            : '';
    const dayPart = ymd ? formatReservationHeadlineDayFr(ymd) : '';
    const motifPart = reservationMotifLabelForHeadline(event);
    const ownerPart = reservationOwnerLabelForHeadline(event);
    const parts = [];
    if (dayPart && motifPart) {
        parts.push(`${dayPart} — ${motifPart}`);
    } else if (dayPart) {
        parts.push(dayPart);
    } else if (motifPart) {
        parts.push(motifPart);
    }
    let text = parts.join('');
    if (ownerPart) {
        text = text ? `${text} (${ownerPart})` : ownerPart;
    }
    headline.textContent = text;
    headline.classList.toggle('hidden', !text);
    const divider = document.getElementById('reservation-modal-headline-divider');
    if (divider instanceof HTMLElement) {
        divider.classList.toggle('hidden', !text);
        divider.setAttribute('aria-hidden', text ? 'false' : 'true');
    }
}

/**
 * Dernière heure de fin autorisée sur la grille HH:mm des `<select>` (8:00 … 22:00, pas de 22:30).
 * @param {Date} hardCap — fin exclusive max (début du prochain occupé ou slot max)
 */
function floorEndToSelectGrid(start, rawEnd, hardCap) {
    const y = start.getFullYear();
    const mo = start.getMonth();
    const d = start.getDate();
    const startMs = start.getTime();
    const capMs = Math.min(rawEnd.getTime(), hardCap.getTime());
    let bestMs = -Infinity;
    for (let hour = 8; hour <= 22; hour++) {
        for (const minute of [0, 30]) {
            if (hour === 22 && minute > 0) break;
            const t = new Date(y, mo, d, hour, minute, 0, 0).getTime();
            if (t <= startMs || t > capMs) continue;
            bestMs = Math.max(bestMs, t);
        }
    }
    if (bestMs !== -Infinity) return new Date(bestMs);
    if (capMs > startMs) return new Date(capMs);
    return new Date(startMs + 30 * 60 * 1000);
}

const DEFAULT_NEW_RESERVATION_DURATION_MS = 60 * 60 * 1000;

/** @typedef {{ ok: boolean, dbId: string | null, error?: string | null }} QuickPersistResult */

/** Promesses de persistance « clic rapide » (id FC temporaire → insert Postgres). */
/** @type {Map<string, Promise<QuickPersistResult>>} */
const quickReservationPersistByFcId = new Map();

/** @type {import('@fullcalendar/core').Calendar | null} */
let slotWorkflowCalendarRef = null;

let googleCalendarSyncInFlight = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let googleSyncBannerHideTimer = null;
/** @type {Map<string, { label: string, userLabel: string }> | null} */
let googlePoolDirectoryCache = null;
let googlePoolDirectoryCacheAt = 0;

function bridgePayloadNeedsPoolMirror(ev) {
    const t = String(ev?.type || '').toLowerCase();
    return t === 'cours' || t === 'reservation';
}

async function loadGooglePoolDirectory() {
    const now = Date.now();
    if (googlePoolDirectoryCache && now - googlePoolDirectoryCacheAt < 120_000) {
        return googlePoolDirectoryCache;
    }
    const map = new Map();
    const sb = getSupabaseClient();
    if (!sb) return map;
    const { data: pools, error } = await sb
        .from('google_calendar_pool')
        .select('assigned_user_id, label')
        .not('assigned_user_id', 'is', null);
    if (error) {
        console.warn('[calendar-logic] google_calendar_pool', error.message);
        return map;
    }
    const userIds = [
        ...new Set(
            (pools || []).map((p) => String(p.assigned_user_id || '').trim()).filter(Boolean)
        )
    ];
    const profileById = new Map();
    if (userIds.length) {
        const { data: profiles } = await sb
            .from('profiles')
            .select('id, prenom, nom, display_name')
            .in('id', userIds);
        for (const p of profiles || []) {
            const name =
                [p.prenom, p.nom].filter(Boolean).join(' ').trim() ||
                String(p.display_name || '').trim();
            if (name) profileById.set(String(p.id), name);
        }
    }
    for (const p of pools || []) {
        const uid = String(p.assigned_user_id || '').trim();
        const lab = String(p.label || '').trim() || 'Planning IAMS';
        const userLabel = profileById.get(uid) || '';
        if (uid) map.set(uid, { label: lab, userLabel });
    }
    googlePoolDirectoryCache = map;
    googlePoolDirectoryCacheAt = now;
    return map;
}

const GOOGLE_SYNC_MAIN_LABEL = 'Calendrier principal orgue IAMS';

/** @param {string} calendarLabel */
function formatGoogleSyncBannerLine(calendarLabel) {
    const raw = String(calendarLabel || '').trim();
    if (!raw || raw === GOOGLE_SYNC_MAIN_LABEL) {
        return GOOGLE_SYNC_MAIN_LABEL;
    }
    const paren = raw.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (paren) {
        return `${paren[1].trim()} - ${paren[2].trim()}`;
    }
    return raw;
}

/**
 * @param {number} stepIndex index 0-based
 * @param {number} total
 * @param {string} calendarLabel
 */
function googleSyncInProgressMessage(stepIndex, total, calendarLabel) {
    const line = formatGoogleSyncBannerLine(calendarLabel);
    if (total <= 1) return `Synchronisation Google en cours : ${line}`;
    return `Synchronisation Google en cours (${stepIndex + 1}/${total}) : ${line}`;
}

function formatPoolCalendarLabel(meta) {
    const lab = String(meta.label || 'Planning IAMS').trim();
    const user = String(meta.userLabel || '').trim();
    return user ? `${lab} (${user})` : lab;
}

function resolvePoolLabelForUserId(userId, poolByUser) {
    const meta = poolByUser.get(userId);
    return meta ? formatPoolCalendarLabel(meta) : 'Agenda personnel';
}

/** @param {Record<string, unknown>[]} eventsPayload */
async function buildGoogleSyncStepsFromPayload(eventsPayload) {
    /** @type {{ key: string; label: string }[]} */
    const steps = [];
    const seen = new Set();
    const add = (key, label) => {
        if (seen.has(key)) return;
        seen.add(key);
        steps.push({ key, label });
    };
    add('main', GOOGLE_SYNC_MAIN_LABEL);
    if (!Array.isArray(eventsPayload) || !eventsPayload.length) return steps;

    const poolByUser = await loadGooglePoolDirectory();
    for (const ev of eventsPayload) {
        const bridgeType = String(ev.type || '').toLowerCase();
        if (bridgePayloadNeedsPoolMirror(ev)) {
            const ownerEmail = String(ev.owner || '').trim();
            if (ownerEmail) {
                const ownerUid = await planningUserIdForEmail(ownerEmail);
                if (ownerUid) add(`pool_owner:${ownerUid}`, resolvePoolLabelForUserId(ownerUid, poolByUser));
            }
        }
        if (bridgeType === 'cours') {
            const inscrits = String(ev.inscrits || '')
                .split(',')
                .map((s) => s.trim().toLowerCase())
                .filter(Boolean);
            for (const email of inscrits) {
                const studentUid = await planningUserIdForEmail(email);
                if (studentUid) {
                    add(`pool_student:${studentUid}`, resolvePoolLabelForUserId(studentUid, poolByUser));
                }
            }
        }
    }
    return steps;
}

/** @param {Array<{ target?: string; targetUserId?: string }>} mirrorTargets */
async function buildGoogleSyncStepsFromMirrorTargets(mirrorTargets) {
    /** @type {{ key: string; label: string }[]} */
    const steps = [];
    const seen = new Set();
    const add = (key, label) => {
        if (seen.has(key)) return;
        seen.add(key);
        steps.push({ key, label });
    };
    const poolByUser = await loadGooglePoolDirectory();
    for (const t of mirrorTargets || []) {
        const target = String(t.target || '').trim();
        const uid = String(t.targetUserId || '').trim();
        if (target === 'main') {
            add('main', GOOGLE_SYNC_MAIN_LABEL);
        } else if (target === 'pool_owner' && uid) {
            add(`pool_owner:${uid}`, resolvePoolLabelForUserId(uid, poolByUser));
        } else if (target === 'pool_student' && uid) {
            add(`pool_student:${uid}`, resolvePoolLabelForUserId(uid, poolByUser));
        }
    }
    if (!steps.length && (mirrorTargets || []).length) add('main', GOOGLE_SYNC_MAIN_LABEL);
    return steps;
}

function setGoogleSyncBannerMessage(message) {
    const banner = document.getElementById('planning-slot-workflow-banner');
    const text = document.getElementById('planning-slot-workflow-banner-text');
    const spinner = document.getElementById('planning-slot-workflow-banner-spinner');
    if (!banner || !text) return;
    banner.classList.remove('hidden');
    banner.classList.add('planning-slot-workflow-float--sync');
    spinner?.classList.remove('hidden');
    text.textContent = message;
}

export function setSlotWorkflowCalendar(calendar) {
    slotWorkflowCalendarRef = calendar || null;
}

export function isEventDbPersistPending(eventLike) {
    return Boolean(safeEventExtendedProps(eventLike)?.planningQuickPending);
}

export function isCalendarDbPersistBusy() {
    return quickReservationPersistByFcId.size > 0;
}

function syncSlotWorkflowBanner() {
    const banner = document.getElementById('planning-slot-workflow-banner');
    const text = document.getElementById('planning-slot-workflow-banner-text');
    const spinner = document.getElementById('planning-slot-workflow-banner-spinner');
    if (!banner || !text) return;
    if (isCalendarDbPersistBusy()) {
        banner.classList.remove('hidden');
        banner.classList.remove('planning-slot-workflow-float--sync');
        spinner?.classList.remove('hidden');
        text.textContent = 'Enregistrement…';
        return;
    }
    if (googleCalendarSyncInFlight > 0) {
        return;
    }
    banner.classList.add('hidden');
    banner.classList.remove('planning-slot-workflow-float--sync');
    spinner?.classList.add('hidden');
    text.textContent = '';
}

function syncCalendarWorkflowLock() {
    const cal = slotWorkflowCalendarRef;
    const calEl = document.getElementById('calendar');
    const busy = isCalendarDbPersistBusy();
    if (cal && typeof cal.setOption === 'function') {
        try {
            cal.setOption('selectable', !busy);
        } catch {
            /* calendrier détruit */
        }
    }
    calEl?.classList.toggle('planning-calendar--db-busy', busy);
    syncSlotWorkflowBanner();
}

function hideGoogleSyncBanner(delayMs = 0) {
    if (googleSyncBannerHideTimer) clearTimeout(googleSyncBannerHideTimer);
    if (delayMs <= 0) {
        googleSyncBannerHideTimer = null;
        syncSlotWorkflowBanner();
        return;
    }
    googleSyncBannerHideTimer = setTimeout(() => {
        googleSyncBannerHideTimer = null;
        syncSlotWorkflowBanner();
    }, delayMs);
}

/**
 * @param {Array<{ calendarId: string; googleEventId: string; target?: string; targetUserId?: string }>} mirrorTargets
 */
async function runGoogleMirrorSyncWithBanner(mirrorTargets) {
    if (!calendarBridgeWanted()) return { ok: true, skipped: true };
    const token = await getAccessToken();
    if (!token) return { ok: false, error: 'Session expirée.' };

    const steps = await buildGoogleSyncStepsFromMirrorTargets(mirrorTargets);
    googleCalendarSyncInFlight += 1;
    let stepIdx = 0;
    const total = steps.length;
    const showStep = (i) => {
        const step = steps[i];
        if (step) setGoogleSyncBannerMessage(googleSyncInProgressMessage(i, total, step.label));
    };
    showStep(0);

    try {
        for (let i = 0; i < mirrorTargets.length; i++) {
            const t = mirrorTargets[i];
            const target = String(t.target || '').trim();
            let stepKey = 'main';
            if (target === 'pool_owner' && t.targetUserId) {
                stepKey = `pool_owner:${t.targetUserId}`;
            } else if (target === 'pool_student' && t.targetUserId) {
                stepKey = `pool_student:${t.targetUserId}`;
            }
            const stepPos = steps.findIndex((s) => s.key === stepKey);
            if (stepPos >= 0) showStep(stepPos);
            else showStep(Math.min(stepIdx, steps.length - 1));

            const rDel = await bridgeDeleteEvent(token, t.googleEventId, t.calendarId);
            if (!rDel.ok && !rDel.skipped) {
                setGoogleSyncBannerMessage(`Échec synchro Google : ${rDel.error || 'échec'}`);
                hideGoogleSyncBanner(5500);
                return { ok: false, error: rDel.error || 'échec' };
            }
            stepIdx = Math.min(stepIdx + 1, steps.length - 1);
        }
        hideGoogleSyncBanner(0);
        return { ok: true, skipped: false };
    } catch (e) {
        console.error(e);
        setGoogleSyncBannerMessage('Échec synchro Google : erreur inattendue.');
        hideGoogleSyncBanner(5500);
        return { ok: false, error: 'erreur' };
    } finally {
        googleCalendarSyncInFlight = Math.max(0, googleCalendarSyncInFlight - 1);
        if (googleCalendarSyncInFlight === 0 && !googleSyncBannerHideTimer) {
            syncSlotWorkflowBanner();
        }
    }
}

async function deletePlanningEventsByCanonicalIds(canonicalIds) {
    const ids = [...new Set((canonicalIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) return { ok: true, deleted: 0 };
    /** @type {Array<{ calendarId: string; googleEventId: string; target?: string; targetUserId?: string }>} */
    const mirrorTargets = [];
    for (const id of ids) {
        const targets = await fetchPlanningMirrorTargetsForDelete(id);
        if (Array.isArray(targets) && targets.length) mirrorTargets.push(...targets);
    }
    if (mirrorTargets.length) {
        const mirrorSync = await runGoogleMirrorSyncWithBanner(mirrorTargets);
        if (!mirrorSync.ok && !mirrorSync.skipped) {
            return { ok: false, error: mirrorSync.error || 'Suppression Google impossible.', deleted: 0 };
        }
    }
    for (const id of ids) {
        const del = await deletePlanningEventRow(id);
        if (!del.ok) return { ok: false, error: del.error || 'Suppression base impossible.', deleted: 0 };
    }
    return { ok: true, error: null, deleted: ids.length };
}

async function fetchPlanningRowsOverlappingRange(startIso, endIso, excludeCanonicalId = '') {
    const start = new Date(String(startIso || ''));
    const end = new Date(String(endIso || ''));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
        return [];
    }
    const rows = await fetchPlanningEventRowsInRange(start, end);
    const excludeId = String(excludeCanonicalId || '').trim();
    const startMs = start.getTime();
    const endMs = end.getTime();
    return rows.filter((row) => {
        const rowId = String(row.id || '').trim();
        if (excludeId && rowId === excludeId) return false;
        const rowStartMs = new Date(row.start_at).getTime();
        const rowEndMs = new Date(row.end_at).getTime();
        return Number.isFinite(rowStartMs) && Number.isFinite(rowEndMs) && startMs < rowEndMs && rowStartMs < endMs;
    });
}

/**
 * @param {{ startStr: string, endStr: string, title: string } | null} prevSnapshot
 * @param {string | null} formBaselineJson
 * @param {import('@fullcalendar/core').EventApi | null} liveEventRef
 * @param {string} ownerEmail
 * @param {string} ownerUid
 */
function buildModalSavePrevDbSnapshot(
    prevSnapshot,
    formBaselineJson,
    liveEventRef,
    ownerEmail,
    ownerUid
) {
    if (!prevSnapshot) return null;
    let inscritUserIds = [];
    let dbSlotType = String(liveEventRef?.extendedProps?.planningDbSlotType || '').trim();
    let title = String(prevSnapshot.title || '').trim() || 'Créneau';
    if (formBaselineJson) {
        try {
            const snap = JSON.parse(formBaselineJson);
            if (Array.isArray(snap.inscrits)) {
                inscritUserIds = snap.inscrits.map((x) => String(x).trim()).filter(Boolean);
            }
            const motifRaw = String(snap.motif || '').trim();
            if (motifRaw) {
                dbSlotType = motifToPlanningDbSlotType(normalizeMotif(motifRaw));
            }
            const t = String(snap.title || '').trim();
            if (t) title = t;
        } catch {
            /* baseline illisible */
        }
    }
    if (!dbSlotType) dbSlotType = 'travail perso';
    return {
        startIso: prevSnapshot.startStr,
        endIso: prevSnapshot.endStr,
        title,
        dbSlotType,
        ownerEmail: String(ownerEmail || '').trim().toLowerCase(),
        ownerUid: String(ownerUid || '').trim(),
        inscritUserIds,
        sourceTemplateLineId: String(
            liveEventRef?.extendedProps?.planningSourceTemplateLineId || ''
        ).trim() || null,
        seriesId: String(liveEventRef?.extendedProps?.planningSeriesId || '').trim() || null,
        seriesPosition:
            Number.isFinite(Number(liveEventRef?.extendedProps?.planningSeriesPosition)) &&
            Number(liveEventRef?.extendedProps?.planningSeriesPosition) >= 1
                ? Number(liveEventRef.extendedProps.planningSeriesPosition)
                : null
    };
}

/**
 * Affiche le créneau sur la grille après enregistrement modale (sans attendre Google).
 * @returns {import('@fullcalendar/core').EventApi | null}
 */
function applyModalReservationDisplayOnCalendar(calendar, currentUser, p) {
    if (!calendar?.addEvent) return null;
    const start = new Date(p.startIso);
    const end = new Date(p.endIso);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    const ownerEmail = String(p.ownerEmail || currentUser.email || '').trim().toLowerCase();
    const inscrits = Array.isArray(p.inscritsEmails)
        ? p.inscritsEmails.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
        : [];
    const commonXp = {
        planningRowSource: 'supabase',
        planningCanonicalId: p.eventId,
        planningGoogleSyncPending: Boolean(p.googlePending),
        owner: ownerEmail,
        ownerDisplayName: String(currentUser.name || ownerEmail.split('@')[0] || '').trim(),
        ownerRole: normalizeRole(currentUser?.role) || '',
        type: p.slotType,
        planningDbSlotType: p.dbSlotType,
        planningIsAllDay: Boolean(p.isAllDay)
    };
    if (inscrits.length) commonXp.inscrits = inscrits;

    if (p.isCreate) {
        const added = calendar.addEvent({
            id: p.eventId,
            title: p.title,
            start,
            end,
            allDay: Boolean(p.isAllDay),
            extendedProps: commonXp,
            ...fcDragResizePropsForEventStart(start, currentUser)
        });
        dedupePlanningEventsByCanonicalId(calendar, p.eventId);
        return added;
    }
    const live = p.liveEventRef;
    if (!live) return null;
    try {
        if (typeof live.setDates === 'function') live.setDates(start, end, { allDay: Boolean(p.isAllDay) });
        if (typeof live.setProp === 'function') live.setProp('title', p.title);
        if (typeof live.setExtendedProp === 'function') {
            live.setExtendedProp('planningRowSource', 'supabase');
            live.setExtendedProp('planningCanonicalId', p.eventId);
            live.setExtendedProp('planningGoogleSyncPending', Boolean(p.googlePending));
            live.setExtendedProp('type', p.slotType);
            live.setExtendedProp('planningDbSlotType', p.dbSlotType);
            live.setExtendedProp('planningIsAllDay', Boolean(p.isAllDay));
            live.setExtendedProp('inscrits', inscrits);
        }
    } catch (e) {
        console.warn('[calendar-logic] applyModalReservationDisplayOnCalendar', e);
    }
    return live;
}

/**
 * Après création rapide : promeut le créneau optimiste (sans remove + addEvent) pour éviter les doublons au refetch Google.
 * @param {import('@fullcalendar/core').EventApi | null} created
 */
function promoteQuickReservationToPersisted(calendar, currentUser, created, p) {
    if (created && typeof created.setExtendedProp === 'function') {
        try {
            if (typeof created.setProp === 'function') {
                created.setProp('id', p.eventId);
            }
        } catch (e) {
            console.warn('[calendar-logic] promoteQuickReservationToPersisted setProp id', e);
        }
        applyModalReservationDisplayOnCalendar(calendar, currentUser, {
            isCreate: false,
            liveEventRef: created,
            eventId: p.eventId,
            title: p.title,
            startIso: p.startIso,
            endIso: p.endIso,
            dbSlotType: p.dbSlotType,
            slotType: p.slotType,
            ownerEmail: p.ownerEmail,
            inscritsEmails: p.inscritsEmails,
            googlePending: p.googlePending
        });
        try {
            created.setExtendedProp('planningQuickPending', false);
        } catch {
            /* */
        }
        dedupePlanningEventsByCanonicalId(calendar, p.eventId);
        return created;
    }
    return applyModalReservationDisplayOnCalendar(calendar, currentUser, {
        isCreate: true,
        liveEventRef: null,
        eventId: p.eventId,
        title: p.title,
        startIso: p.startIso,
        endIso: p.endIso,
        dbSlotType: p.dbSlotType,
        slotType: p.slotType,
        ownerEmail: p.ownerEmail,
        inscritsEmails: p.inscritsEmails,
        googlePending: p.googlePending
    });
}

/**
 * @param {{ mode: 'create' | 'edit', eventId: string, prevDb: ReturnType<typeof buildModalSavePrevDbSnapshot> | null }} ctx
 * @param {import('@fullcalendar/core').Calendar | null} calendar
 */
async function rollbackModalSaveAfterGoogleFailure(ctx, calendar) {
    const createdIds = Array.isArray(ctx.createdIds)
        ? ctx.createdIds.map((id) => String(id).trim()).filter(Boolean)
        : [];
    if (createdIds.length > 0) {
        for (const id of createdIds) {
            await deletePlanningEventRow(id);
        }
        await refetchPlanningGrid(calendar);
        return;
    }
    const eventId = String(ctx.eventId || '').trim();
    if (ctx.mode === 'create') {
        if (!eventId) return;
        await deletePlanningEventRow(eventId);
        try {
            calendar?.getEventById?.(eventId)?.remove();
        } catch {
            /* */
        }
        return;
    }
    const prev = ctx.prevDb;
    if (!prev) {
        await refetchPlanningGrid(calendar);
        return;
    }
    const ur = await upsertPlanningEventRow({
        id: eventId,
        startIso: prev.startIso,
        endIso: prev.endIso,
        title: prev.title,
        dbSlotType: prev.dbSlotType,
        ownerEmail: prev.ownerEmail,
        ownerUserId: prev.ownerUid,
        sourceTemplateLineId: prev.sourceTemplateLineId ?? undefined,
        seriesId: prev.seriesId ?? undefined,
        seriesPosition: prev.seriesPosition ?? undefined
    });
    if (!ur.ok) {
        console.warn('[calendar-logic] rollback modale : restauration base', ur.error);
    }
    const enr = await replacePlanningEventEnrollment(eventId, prev.inscritUserIds || []);
    if (!enr.ok) {
        console.warn('[calendar-logic] rollback modale : inscriptions', enr.error);
    }
    await refetchPlanningGrid(calendar);
}

function showGoogleSyncRollbackToast(error) {
    showToast(
        `Synchronisation agenda impossible : ${error}. Modifications annulées.`,
        'error',
        9000
    );
}

/**
 * @param {import('@fullcalendar/core').Calendar | null} calendar
 * @param {Record<string, unknown>[]} payloads
 * @param {{ mode: 'create' | 'edit', eventId?: string, prevDb?: ReturnType<typeof buildModalSavePrevDbSnapshot> | null, createdIds?: string[] }} rollbackCtx
 * @param {(() => void | Promise<void>) | undefined} [onSyncSuccess]
 */
function voidLaunchReservationGoogleSyncWithRollback(
    calendar,
    payloads,
    rollbackCtx,
    onSyncSuccess
) {
    const needsSync = calendarBridgeWanted() && Array.isArray(payloads) && payloads.length > 0;
    if (!needsSync) {
        if (rollbackCtx.eventId) clearModalEventGoogleSyncPending(calendar, rollbackCtx.eventId);
        for (const id of rollbackCtx.createdIds || []) {
            clearModalEventGoogleSyncPending(calendar, id);
        }
        if (onSyncSuccess) void Promise.resolve(onSyncSuccess());
        return;
    }
    void runGoogleCalendarSyncInBackground(payloads, calendar, {
        onSyncFailed: async (error) => {
            await rollbackModalSaveAfterGoogleFailure(rollbackCtx, calendar);
            showGoogleSyncRollbackToast(error);
        },
        onSyncSuccess: async () => {
            if (rollbackCtx.eventId) clearModalEventGoogleSyncPending(calendar, rollbackCtx.eventId);
            for (const id of rollbackCtx.createdIds || []) {
                clearModalEventGoogleSyncPending(calendar, id);
            }
            if (onSyncSuccess) await onSyncSuccess();
        }
    });
}

function clearModalEventGoogleSyncPending(calendar, eventId) {
    const id = String(eventId || '').trim();
    if (!id || !calendar?.getEventById) return;
    try {
        const ev = calendar.getEventById(id);
        if (ev && typeof ev.setExtendedProp === 'function') {
            ev.setExtendedProp('planningGoogleSyncPending', false);
        }
    } catch {
        /* */
    }
}

/**
 * @param {Record<string, unknown>[]} eventsPayload
 * @param {import('@fullcalendar/core').Calendar | null} [calendar]
 * @param {{ onSyncFailed?: (error: string) => void | Promise<void>, onSyncSuccess?: (sync: { ok?: boolean, skipped?: boolean }) => void | Promise<void> }} [options]
 */
async function runGoogleCalendarSyncInBackground(eventsPayload, calendar = null, options = {}) {
    const cal = calendar || slotWorkflowCalendarRef;
    if (!calendarBridgeWanted()) {
        if (options.onSyncSuccess) await options.onSyncSuccess({ ok: true, skipped: true });
        return { ok: true, skipped: true };
    }
    const steps = await buildGoogleSyncStepsFromPayload(eventsPayload);
    googleCalendarSyncInFlight += 1;

    let stepIdx = 0;
    const total = steps.length;
    const showStep = (i) => {
        const step = steps[Math.min(i, steps.length - 1)];
        if (step) setGoogleSyncBannerMessage(googleSyncInProgressMessage(i, total, step.label));
    };
    showStep(0);

    /** @type {ReturnType<typeof setInterval> | null} */
    let advanceTimer = null;
    if (steps.length > 1) {
        advanceTimer = setInterval(() => {
            if (stepIdx < steps.length - 1) {
                stepIdx += 1;
                showStep(stepIdx);
            }
        }, 850);
    }

    /** @type {{ ok: boolean, skipped?: boolean, error?: string }} */
    let sync = { ok: true, skipped: true };
    try {
        sync = await trySyncGoogleCalendar(eventsPayload);
        if (advanceTimer) clearInterval(advanceTimer);
        if (!sync.ok && !sync.skipped) {
            if (options.onSyncFailed) {
                await options.onSyncFailed(String(sync.error || 'échec'));
            }
            setGoogleSyncBannerMessage(`Échec synchro Google : ${sync.error || 'échec'}`);
            hideGoogleSyncBanner(5500);
        } else {
            if (cal) {
                for (const row of eventsPayload) {
                    const eid = String(row?.planningEventId ?? '').trim();
                    if (eid) clearModalEventGoogleSyncPending(cal, eid);
                }
                dedupePlanningEventsByCanonicalId(cal);
            }
            if (options.onSyncSuccess) await options.onSyncSuccess(sync);
            hideGoogleSyncBanner(0);
        }
    } catch (e) {
        if (advanceTimer) clearInterval(advanceTimer);
        console.error(e);
        const msg = e instanceof Error ? e.message : 'erreur inattendue';
        if (options.onSyncFailed) await options.onSyncFailed(msg);
        setGoogleSyncBannerMessage('Échec synchro Google : erreur inattendue.');
        hideGoogleSyncBanner(5500);
        sync = { ok: false, error: msg };
    } finally {
        if (advanceTimer) clearInterval(advanceTimer);
        googleCalendarSyncInFlight = Math.max(0, googleCalendarSyncInFlight - 1);
        if (googleCalendarSyncInFlight === 0 && !googleSyncBannerHideTimer) {
            syncSlotWorkflowBanner();
        }
    }
    return sync;
}

/**
 * @param {import('@fullcalendar/core').EventApi | object | null} eventRef
 * @returns {Promise<QuickPersistResult | null>}
 */
async function awaitQuickReservationPersistIfNeeded(eventRef) {
    const fcId = safeEventId(eventRef);
    if (!fcId) return null;
    const pending = quickReservationPersistByFcId.get(fcId);
    if (pending) return pending;
    if (isEventDbPersistPending(eventRef)) {
        return { ok: false, dbId: null, error: 'Enregistrement encore en cours.' };
    }
    return null;
}

function trackQuickReservationPersist(fcId, promise) {
    quickReservationPersistByFcId.set(fcId, promise);
    syncCalendarWorkflowLock();
    void promise.finally(() => {
        quickReservationPersistByFcId.delete(fcId);
        syncCalendarWorkflowLock();
    });
}

/** Intervalles occupés sur un jour (une passe — évite O(slots × events) sur Safari). */
function collectDayReservationIntervals(calendar, dayAnchor, eventRef) {
    const resolvedExclude =
        eventRef != null ? resolveLivePlanningEventRef(calendar, eventRef) : null;
    /** @type {{ startMs: number, endMs: number }[]} */
    const intervals = [];
    for (const ev of calendar.getEvents()) {
        if (ev.display === 'background') continue;
        if (resolvedExclude && isSameFcEvent(ev, resolvedExclude)) continue;
        if (resolvedExclude && isSameLogicalEventByOwnerAndRange(ev, resolvedExclude)) continue;
        const r = eventRangeForOverlap(ev);
        if (!r || !sameCalendarDay(r.start, dayAnchor)) continue;
        intervals.push({ startMs: r.start.getTime(), endMs: r.end.getTime() });
    }
    intervals.sort((a, b) => a.startMs - b.startMs);
    if (intervals.length < 2) return intervals;
    const merged = [intervals[0]];
    for (let i = 1; i < intervals.length; i++) {
        const cur = intervals[i];
        const last = merged[merged.length - 1];
        if (cur.startMs <= last.endMs) {
            last.endMs = Math.max(last.endMs, cur.endMs);
        } else {
            merged.push(cur);
        }
    }
    return merged;
}

function nextExclusiveFreeBoundaryFromIntervals(startMs, limitMs, intervals) {
    for (const iv of intervals) {
        if (iv.endMs <= startMs) continue;
        if (iv.startMs <= startMs && iv.endMs > startMs) return startMs;
        if (iv.startMs > startMs) return Math.min(limitMs, iv.startMs);
    }
    return limitMs;
}

function generateUuidV4() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const h = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
    return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

/**
 * Clic grille / mois (8h) : fin proposée = 1h si libre, sinon réduction jusqu’au prochain créneau occupé,
 * arrondie à la grille des listes déroulantes.
 */
function proposeReservationRangeFromAnchor(anchor, calendar) {
    const boundary = nextExclusiveFreeBoundary(anchor, calendar);
    const preferredEnd = new Date(anchor.getTime() + DEFAULT_NEW_RESERVATION_DURATION_MS);
    const rawEnd = new Date(Math.min(preferredEnd.getTime(), boundary.getTime()));
    let end = floorEndToSelectGrid(anchor, rawEnd, boundary);
    if (end.getTime() <= anchor.getTime()) {
        const bumped = new Date(
            Math.min(anchor.getTime() + 30 * 60 * 1000, boundary.getTime())
        );
        end = floorEndToSelectGrid(anchor, bumped, boundary);
    }
    return { start: anchor, end };
}

/**
 * Propose une plage (1 h puis 30 min) en respectant le quota hebdo travail perso élève.
 * @returns {Promise<{ start: Date, end: Date } | null>}
 */
async function proposeQuickReservationRangeForUser(anchor, calendar, currentUser) {
    const start = new Date(anchor);
    const boundary = nextExclusiveFreeBoundary(start, calendar);
    const tryMinutes = [60, 30];
    const isEleveTravail =
        normalizeRole(currentUser?.role) === 'eleve' &&
        motifToPlanningDbSlotType(defaultMotifForRole(currentUser?.role)) === 'travail perso';

    if (!isEleveTravail) {
        const range = proposeReservationRangeFromAnchor(start, calendar);
        return range.end.getTime() > range.start.getTime() ? range : null;
    }

    await fetchOrganSchoolSettings();
    const setQ = getOrganSchoolSettingsCached();
    if (eleveBookingTooFarInFuture(setQ, start)) {
        return null;
    }

    for (const mins of tryMinutes) {
        const rawEnd = new Date(Math.min(start.getTime() + mins * 60 * 1000, boundary.getTime()));
        let end = floorEndToSelectGrid(start, rawEnd, boundary);
        if (end.getTime() <= start.getTime()) continue;
        if (findOverlappingCalendarEvent(calendar, start, end, null)) continue;
        const addMin = Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000));
        const cap = await eleveTravailWouldExceedWeeklyCap(
            setQ,
            addMin,
            mondayStartLocal(start),
            null
        );
        if (cap.ok) return { start, end };
    }
    return null;
}

/** Remplit motif + titre (règles de rôle + préférence utilisateur). */
export function buildReservationFormFields(currentUser, event) {
    const sel = document.getElementById('event-motif-select');
    const titleInput = document.getElementById('event-title-input');
    if (!sel || !titleInput) return;

    const dbTypeEarly = String(event?.extendedProps?.planningDbSlotType || '').trim().toLowerCase();
    const typEarly = String(event?.extendedProps?.type || '').trim().toLowerCase();
    if (dbTypeEarly === 'fermeture' || typEarly === 'fermeture') {
        sel.innerHTML = '';
        sel.add(new Option(motifDisplayLabel('Fermeture'), 'Fermeture', true, true));
        sel.value = 'Fermeture';
        sel.disabled = true;
        titleInput.value = String(event?.title || '').trim();
        return;
    }
    if (dbTypeEarly === 'indispo' || typEarly === 'indispo') {
        sel.innerHTML = '';
        sel.add(new Option(motifDisplayLabel('Indispo'), 'Indispo', true, true));
        sel.value = 'Indispo';
        sel.disabled = true;
        titleInput.value = String(event?.title || '').trim();
        return;
    }

    const allowed = allowedMotifsForReservationModal(currentUser, event);
    sel.innerHTML = '';
    if (!event) {
        sel.add(new Option('— Choisir un motif —', '', true, true));
        sel.required = true;
    }
    for (const lab of allowed) sel.add(new Option(motifDisplayLabel(lab), lab));

    const inferredMotif = event
        ? (() => {
              const dbType = String(event.extendedProps?.planningDbSlotType || '').trim();
              if (dbType === 'cours') return 'Cours';
              if (dbType === 'concert') return 'Concert';
              if (dbType === 'autre') return 'Autre';
              if (dbType === 'indispo') return 'Indispo';
              if (dbType === 'fermeture') return 'Fermeture';
              if (dbType === 'travail perso') return 'Travail';
              // Repli si l’événement ne porte pas planningDbSlotType (cas inattendu).
              return slotTypeToMotif(event.extendedProps?.type);
          })()
        : normalizeRole(currentUser?.role) === 'eleve'
          ? 'Cours'
          : defaultMotifForRole(currentUser?.role);
    if (event) {
        sel.value = allowed.includes(inferredMotif) ? inferredMotif : allowed[0] || inferredMotif;
        titleInput.value = String(event.title || '').trim();
    } else {
        sel.value = '';
        titleInput.value = '';
    }
}

/** Nom affiché pour titre de créneau / bandeau modale élève (cohérent avec création rapide). */
function reservationDisplayTitleForCurrentUser(currentUser) {
    const n = String(currentUser?.name || '').trim();
    if (n) return n;
    const e = String(currentUser?.email || '').trim();
    if (e.includes('@')) return e.split('@')[0];
    return e || 'Réservation';
}

function reservationEventDescriptif(event) {
    if (!event) return '—';
    const dbType = String(event.extendedProps?.planningDbSlotType || '').trim();
    let motif = '';
    if (dbType === 'cours') motif = 'Cours';
    else if (dbType === 'concert') motif = 'Concert';
    else if (dbType === 'autre') motif = 'Autre';
    else if (dbType === 'indispo') motif = 'Indispo';
    else if (dbType === 'fermeture') motif = 'Fermeture';
    else if (dbType === 'travail perso') motif = 'Travail';
    else motif = slotTypeToMotif(event.extendedProps?.type);
    const motifLabel = motifDisplayLabel(motif);
    const title = String(event.title || '').trim();
    if (!title || title === motifLabel) return motifLabel;
    return `${motifLabel} — ${title}`;
}

/**
 * Bloc « Informations » en tête de modale (édition d’un créneau existant).
 */
function applyReservationEventInfoPanel(
    event,
    start,
    end,
    owner,
    ownerLabelOverride = '',
    createdByLabelOverride = ''
) {
    const wrap = document.getElementById('wrap-reservation-info');
    const whenEl = document.getElementById('event-info-when');
    const descEl = document.getElementById('event-info-description');
    const reservedEl = document.getElementById('event-info-reserved-by');
    if (!wrap || !whenEl || !descEl || !reservedEl) return;
    if (!event) {
        wrap.classList.add('hidden');
        return;
    }
    wrap.classList.remove('hidden');
    whenEl.textContent = formatOccupationWhenSentence(start, end);
    descEl.textContent = reservationEventDescriptif(event);
    reservedEl.textContent = reservationReservedByLabel(
        owner,
        ownerLabelOverride,
        createdByLabelOverride
    );
}

/**
 * En-tête modale édition : libellé selon le rôle.
 * @param {string} [createdByLabelOverride] — libellé `planning_profiles_label_for_ids` (créateur)
 * @param {string} [_lastModifiedByLabelOverride] — conservé pour appelant (non affiché)
 */
function applyReservationEditorShellForRole(
    currentUser,
    event,
    ownerLabelOverride = '',
    actorLabelOverride = '',
    createdByLabelOverride = '',
    lastModifiedByLabelOverride = ''
) {
    const editorOwnerEl = document.getElementById('event-editor-owner');
    const wrapTitle = document.getElementById('wrap-reservation-title');
    const wrapMotif = document.getElementById('wrap-reservation-motif');
    const hintFerm = document.getElementById('event-motif-hint-fermeture');
    const sel = document.getElementById('event-motif-select');
    const r = normalizeRole(currentUser?.role);
    const owner = ownerInfoFromEvent(event, currentUser);
    if (r === 'eleve') {
        editorOwnerEl?.classList.add('hidden');
        wrapTitle?.classList.remove('hidden');
    } else {
        editorOwnerEl?.classList.add('hidden');
        wrapTitle?.classList.remove('hidden');
    }
    applyReservationMotifVisibility(currentUser, event, true);
}

/** Durée d’un pas de snap sur la grille (ex. 00:30:00 → 30 min). */
function snapDurationMs(calendar) {
    const snap = calendar?.getOption?.('snapDuration');
    const fallback = calendar?.getOption?.('slotDuration');
    const raw = typeof snap === 'string' && snap !== '' ? snap : fallback;
    let ms = 30 * 60 * 1000;
    if (typeof raw === 'string') {
        const m = raw.match(/^(\d{1,2}):(\d{2}):(\d{2})/);
        if (m) ms = (+m[1]) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000;
    }
    return ms;
}

/** Fin de plage pour un clic simple (aligné sur snapDuration, pas sur la hauteur visuelle du slot). */
export function addSlotEndFromStart(start, calendar) {
    return new Date(start.getTime() + snapDurationMs(calendar));
}

/** Titre des créations rapides (clic simple / glisser sur la grille) : nom affiché du compte. */
function quickReservationDisplayTitle(currentUser) {
    return reservationDisplayTitleForCurrentUser(currentUser);
}

/**
 * Création rapide : Postgres puis affichage optimiste ; synchro Google en arrière-plan (rollback si échec).
 * @param {import('@fullcalendar/core').EventApi | null} created
 * @returns {Promise<QuickPersistResult>}
 */
async function finalizeQuickReservationInBackground(
    calendar,
    currentUser,
    created,
    rangeStart,
    rangeEnd,
    title,
    motif
) {
    const dbToast = showPersistentToast('Enregistrement en base de données…', 'info');
    try {
        if (!isBackendAuthConfigured()) {
            if (created) created.remove();
            dbToast.finish('Connexion requise pour enregistrer.', 'error');
            return { ok: false, dbId: null, error: 'Session requise.' };
        }
        const liveStart =
            created?.start instanceof Date && Number.isFinite(created.start.getTime())
                ? new Date(created.start)
                : rangeStart;
        const liveEnd =
            created?.end instanceof Date && Number.isFinite(created.end.getTime())
                ? new Date(created.end)
                : rangeEnd;
        const liveTitle = String(created?.title || '').trim() || String(title || '').trim() || 'Créneau';
        const liveDbSlotType = created
            ? planningDbSlotTypeForEventUpdate(created)
            : motifToPlanningDbSlotType(motif);
        if (!liveStart || !liveEnd || liveEnd.getTime() <= liveStart.getTime()) {
            if (created) created.remove();
            dbToast.finish('Plage horaire invalide.', 'error');
            return { ok: false, dbId: null, error: 'Plage invalide.' };
        }
        const ownerUid = await planningUserIdForEmail(currentUser.email);
        if (!ownerUid) {
            if (created) created.remove();
            dbToast.finish('Compte indisponible pour enregistrer.', 'error');
            return { ok: false, dbId: null, error: 'Compte propriétaire introuvable.' };
        }
        if (normalizeRole(currentUser.role) === 'eleve' && liveDbSlotType === 'travail perso') {
            await fetchOrganSchoolSettings();
            const setQ = getOrganSchoolSettingsCached();
            if (eleveBookingTooFarInFuture(setQ, liveStart)) {
                if (created) created.remove();
                dbToast.finish(
                    'Cette plage dépasse la fenêtre de réservation autorisée pour les élèves.',
                    'error'
                );
                return { ok: false, dbId: null, error: 'Hors fenêtre de réservation.' };
            }
            const addMin = Math.max(1, Math.round((liveEnd.getTime() - liveStart.getTime()) / 60000));
            const cap = await eleveTravailWouldExceedWeeklyCap(
                setQ,
                addMin,
                mondayStartLocal(liveStart),
                null
            );
            if (!cap.ok) {
                if (created) created.remove();
                dbToast.finish(cap.message || 'Quota hebdomadaire dépassé.', 'error');
                return { ok: false, dbId: null, error: cap.message || 'Quota dépassé.' };
            }
        }
        const bridgeType = planningDbSlotTypeToBridgeType(liveDbSlotType);
        const ur = await upsertPlanningEventRow({
            id: null,
            startIso: liveStart.toISOString(),
            endIso: liveEnd.toISOString(),
            title: liveTitle,
            dbSlotType: liveDbSlotType,
            ownerEmail: currentUser.email,
            ownerUserId: ownerUid
        });
        if (!ur.ok || !ur.id) {
            if (created) created.remove();
            dbToast.finish(ur.error || 'Enregistrement impossible.', 'error');
            return { ok: false, dbId: null, error: ur.error || 'Enregistrement impossible.' };
        }
        let quickInscritsCsv = '';
        if (liveDbSlotType === 'cours') {
            let qIds = [];
            if (normalizeRole(currentUser.role) === 'eleve') {
                const selfId = await planningUserIdForEmail(currentUser.email);
                if (selfId) {
                    qIds = [selfId];
                    quickInscritsCsv = String(currentUser.email || '')
                        .trim()
                        .toLowerCase();
                }
            }
            const enrQ = await replacePlanningEventEnrollment(ur.id, qIds);
            if (!enrQ.ok) {
                await deletePlanningEventRow(ur.id);
                if (created) created.remove();
                dbToast.finish(enrQ.error || 'Inscriptions impossibles.', 'error');
                return { ok: false, dbId: null, error: enrQ.error || 'Inscriptions impossibles.' };
            }
        } else {
            const enrEmpty = await replacePlanningEventEnrollment(ur.id, []);
            if (!enrEmpty.ok) {
                await deletePlanningEventRow(ur.id);
                if (created) created.remove();
                dbToast.finish(enrEmpty.error || 'Enregistrement impossible.', 'error');
                return { ok: false, dbId: null, error: enrEmpty.error };
            }
        }
        const quickInscritsEmails = quickInscritsCsv
            ? quickInscritsCsv.split(',').map((x) => String(x).trim()).filter(Boolean)
            : [];
        promoteQuickReservationToPersisted(calendar, currentUser, created, {
            eventId: ur.id,
            title: liveTitle,
            startIso: liveStart.toISOString(),
            endIso: liveEnd.toISOString(),
            dbSlotType: liveDbSlotType,
            slotType: motifToSlotType(motif),
            ownerEmail: currentUser.email,
            inscritsEmails: quickInscritsEmails,
            googlePending: calendarBridgeWanted()
        });
        dbToast.finish('Créneau enregistré.', 'success', 2400);
        voidLaunchReservationGoogleSyncWithRollback(
            calendar,
            [
                {
                    planningEventId: ur.id,
                    title: liveTitle,
                    start: liveStart.toISOString(),
                    end: liveEnd.toISOString(),
                    type: bridgeType,
                    owner: currentUser.email,
                    ...(quickInscritsCsv ? { inscrits: quickInscritsCsv } : {})
                }
            ],
            { mode: 'create', eventId: ur.id, prevDb: null }
        );
        return { ok: true, dbId: ur.id, error: null };
    } catch (e) {
        console.error(e);
        if (created) created.remove();
        dbToast.finish('L’enregistrement a échoué. Réessayez.', 'error');
        return { ok: false, dbId: null, error: 'Erreur inattendue.' };
    }
}

/**
 * Affiche tout de suite le créneau + toast ; persistance et contrôles Google en arrière-plan (rollback si échec).
 * @param {Date} rangeStart
 * @param {Date} rangeEnd
 */
function commitQuickReservation(calendar, currentUser, rangeStart, rangeEnd, title, motif) {
    if (isReservationNonEditablePast(currentUser, { start: rangeStart })) {
        showToast('Impossible de réserver sur un créneau passé.', 'error');
        calendar.unselect?.();
        return;
    }
    let created = /** @type {import('@fullcalendar/core').EventApi | null} */ (null);
    const quickCanonicalId = generateUuidV4();
    const add = () => {
        created = calendar.addEvent({
            id: quickCanonicalId,
            title,
            start: rangeStart,
            end: rangeEnd,
            allDay: false,
            extendedProps: {
                planningQuickPending: true,
                owner: currentUser.email,
                ownerDisplayName: currentUser.name || currentUser.email.split('@')[0],
                ownerRole: normalizeRole(currentUser.role) || 'eleve',
                type: motifToSlotType(motif),
                planningDbSlotType: motifToPlanningDbSlotType(motif)
            },
            ...fcDragResizePropsForEventStart(rangeStart, currentUser)
        });
    };

    if (typeof calendar.batchRendering === 'function') {
        calendar.batchRendering(add);
    } else {
        add();
    }
    const persistPromise = finalizeQuickReservationInBackground(
        calendar,
        currentUser,
        created,
        rangeStart,
        rangeEnd,
        title,
        motif
    );
    trackQuickReservationPersist(quickCanonicalId, persistPromise);
}

/**
 * Glisser–déposer (souris ou doigt) : enregistrement immédiat, sans modale.
 * Sur la vue mois, liste ou plage « all-day », ouvre la modale complète.
 */
export async function quickCreateFromSelection(calendar, selectInfo, currentUser) {
    if (!currentUser?.email) {
        showToast('Connectez-vous pour réserver.', 'error');
        return;
    }
    if (isCalendarDbPersistBusy()) {
        showToast('Enregistrement en cours : attendez la fin du créneau précédent.', 'info');
        selectInfo.view?.calendar?.unselect?.();
        return;
    }
    if (isReservationNonEditablePast(currentUser, { start: selectInfo.start })) {
        showToast('Impossible de réserver sur un créneau passé.', 'error');
        selectInfo.view?.calendar?.unselect?.();
        return;
    }
    const vtSel = selectInfo.view?.type ?? '';
    const isYearLikeView =
        vtSel === 'multiMonthYear' || (typeof vtSel === 'string' && vtSel.includes('multiMonth'));
    if (
        vtSel === 'dayGridMonth' ||
        vtSel.startsWith('list') ||
        isYearLikeView ||
        selectInfo.allDay
    ) {
        await openModal(selectInfo.start, selectInfo.end, null, currentUser, calendar);
        calendar.unselect();
        return;
    }

    let rangeStart = selectInfo.start;
    let rangeEnd = selectInfo.end;
    const vt = selectInfo.view.type;
    if (vt === 'timeGridWeek' || vt === 'timeGridDay') {
        const snapMs = snapDurationMs(calendar);
        const selMs = rangeEnd.getTime() - rangeStart.getTime();
        /*
         * selectMinDistance:0 fait qu’un « clic » ouvre souvent une sélection d’une case snap (30 min)
         * et supprime dateClick : même règle métier que le clic simple (1 h si libre, sinon réduction).
         */
        const maxProposeMs = DEFAULT_NEW_RESERVATION_DURATION_MS + snapMs + 1000;
        if (selMs <= maxProposeMs) {
            const prop = await resolveQuickCreateRangeOrToast(rangeStart, calendar, currentUser);
            if (!prop) {
                calendar.unselect();
                return;
            }
            rangeStart = prop.start;
            rangeEnd = prop.end;
        }
    }

    const motif = defaultMotifForRole(currentUser.role);
    const title = quickReservationDisplayTitle(currentUser);

    const conflict = findOverlappingCalendarEvent(calendar, rangeStart, rangeEnd, null);
    if (conflict) {
        showToast(overlapToastMessage(conflict), 'error');
        calendar.unselect();
        return;
    }

    if (isReservationNonEditablePast(currentUser, { start: rangeStart })) {
        showToast('Impossible de réserver sur un créneau passé.', 'error');
        calendar.unselect();
        return;
    }

    commitQuickReservation(calendar, currentUser, rangeStart, rangeEnd, title, motif);
    calendar.unselect();
}

/** @returns {Promise<{ start: Date, end: Date } | null>} */
async function resolveQuickCreateRangeOrToast(anchor, calendar, currentUser) {
    const range = await proposeQuickReservationRangeForUser(anchor, calendar, currentUser);
    if (range?.start && range?.end && range.end.getTime() > range.start.getTime()) {
        return range;
    }
    const isEleveTravail =
        normalizeRole(currentUser?.role) === 'eleve' &&
        motifToPlanningDbSlotType(defaultMotifForRole(currentUser?.role)) === 'travail perso';
    if (isEleveTravail) {
        await fetchOrganSchoolSettings();
        const setQ = getOrganSchoolSettingsCached();
        if (eleveBookingTooFarInFuture(setQ, anchor)) {
            showToast(
                'Cette date dépasse la fenêtre de réservation autorisée pour les élèves.',
                'error',
                6000
            );
            return null;
        }
        showToast(
            'Plafond hebdomadaire atteint : essayez un créneau plus court ou une autre semaine.',
            'error',
            6000
        );
        return null;
    }
    showToast('Plage insuffisante : créneau déjà occupé ou fin de journée.', 'error');
    return null;
}

/**
 * Clic simple sur la grille (semaine / jour) : créneau 1 h ou 30 min si occupé plus tard, sans modale.
 */
export async function quickCreateFromDateClick(calendar, clickDate, currentUser, viewType, allDayFlag) {
    if (!currentUser?.email) {
        showToast('Connectez-vous pour réserver.', 'error');
        return;
    }
    if (isCalendarDbPersistBusy()) {
        showToast('Enregistrement en cours : attendez la fin du créneau précédent.', 'info');
        return;
    }
    /* Vue semaine/jour : souris = glisser (select) ; tactile = tap rapide (dateClick). */
    if ((viewType === 'timeGridWeek' || viewType === 'timeGridDay') && !isCoarsePointerDevice()) {
        return;
    }
    if (viewType.startsWith('list')) {
        await openModal(new Date(clickDate), null, null, currentUser, calendar);
        return;
    }

    const isYearLikeView =
        viewType === 'multiMonthYear' ||
        (typeof viewType === 'string' && viewType.includes('multiMonth'));
    if (isYearLikeView) {
        let anchor = new Date(clickDate);
        if (allDayFlag !== false) {
            anchor.setHours(8, 0, 0, 0);
        }
        if (isReservationNonEditablePast(currentUser, { start: anchor })) {
            showToast('Impossible de réserver sur un créneau passé.', 'error');
            return;
        }
        await openModal(anchor, null, null, currentUser, calendar);
        return;
    }

    let anchor = new Date(clickDate);
    if (viewType === 'dayGridMonth') {
        if (allDayFlag !== false) {
            anchor.setHours(8, 0, 0, 0);
        }
    }

    if (isReservationNonEditablePast(currentUser, { start: anchor })) {
        showToast('Impossible de réserver sur un créneau passé.', 'error');
        return;
    }

    const prop = await resolveQuickCreateRangeOrToast(anchor, calendar, currentUser);
    if (!prop) return;
    const { start, end } = prop;

    const conflict = findOverlappingCalendarEvent(calendar, start, end, null);
    if (conflict) {
        showToast(overlapToastMessage(conflict), 'error');
        return;
    }

    const motif = defaultMotifForRole(currentUser.role);
    const title = quickReservationDisplayTitle(currentUser);
    commitQuickReservation(calendar, currentUser, start, end, title, motif);
}

// --- 2. GESTION DE LA MODALE RÉSERVATION ---
/**
 * @param {import('@fullcalendar/core').Calendar | null} [calendarForClip] — si défini (ex. clic sur la grille),
 * propose une fin cohérente avec les occupations (max 1 h si tout est libre).
 */
export async function openModal(start, end, event, currentUser, calendarForClip = null) {
    document.dispatchEvent(new CustomEvent('planning-close-drawer-request'));
    const { isClosureDeletionBusy } = await import('./fermetures-planning.js');
    if (isClosureDeletionBusy()) {
        showToast('Une suppression de fermeture est en cours. Patientez quelques instants.', 'info', 5000);
        return;
    }
    if (event) {
        const xpF = safeEventExtendedProps(event) || {};
        const isFermetureClick =
            String(xpF.planningDbSlotType || '').toLowerCase() === 'fermeture' ||
            String(xpF.type || '').toLowerCase() === 'fermeture';
        if (SHOW_LEGACY_FERMETURE_EDIT_UI && isFermetureClick) {
            await openFermetureEditFromCalendarEvent(event);
            return;
        }
    }
    const modal = document.getElementById('modal_reservation');
    if (!modal) return;
    if (event) {
        const pr = await awaitQuickReservationPersistIfNeeded(event);
        if (pr && !pr.ok) {
            showToast(pr.error || 'Enregistrement initial impossible.', 'error');
            return;
        }
        if (calendarForClip) {
            const liveOpen = resolveLivePlanningEventRef(calendarForClip, event);
            if (liveOpen) event = liveOpen;
        }
    }
    const isPastSlot = Boolean(event && isReservationNonEditablePast(currentUser, event));
    const meRoleOpen = normalizeRole(currentUser?.role);
    const canEditEvent = !event || canCurrentUserEditEvent(currentUser, event);
    reservationModalUserRef = currentUser;
    reservationModalCanEditRef = canEditEvent;
    reservationModalCalendarRef = calendarForClip || null;
    reservationModalEventRef = event || null;
    const owner = ownerInfoFromEvent(event, currentUser);
    let ownerLabelOverride = '';
    let actorLabelOverride = '';
    let createdByLabelOverride = '';
    let lastModifiedByLabelOverride = '';

    const wrapRead = document.getElementById('wrap-reservation-readonly');
    const wrapInfo = document.getElementById('wrap-reservation-info');
    const wrapEdit = document.getElementById('wrap-reservation-editor');
    const modalActions = document.querySelector('#modal_reservation .modal-action');
    const pastHint = document.getElementById('event-readonly-past-hint');
    if (pastHint) pastHint.classList.add('hidden');

    if (wrapRead && wrapEdit) {
        wrapRead.classList.add('hidden');
        wrapEdit.classList.remove('hidden');
    }
    if (wrapInfo) wrapInfo.classList.add('hidden');
    modalActions?.classList.remove('justify-end');
    modalActions?.classList.add('justify-between');

    buildReservationFormFields(currentUser, event || null);
    reservationModalOwnerLabelRef =
        ownerLabelOverride ||
        (event
            ? String(
                  ownerInfoFromEvent(event, currentUser).ownerName ||
                      ownerInfoFromEvent(event, currentUser).ownerEmail?.split('@')[0] ||
                      ''
              ).trim()
            : reservationDisplayTitleForCurrentUser(currentUser));
    applyReservationEditorShellForRole(
        currentUser,
        event || null,
        ownerLabelOverride,
        actorLabelOverride,
        createdByLabelOverride,
        lastModifiedByLabelOverride
    );

    if (reservationModalTimeSyncAbort) reservationModalTimeSyncAbort.abort();
    reservationModalTimeSyncAbort = new AbortController();
    const modalSignal = reservationModalTimeSyncAbort.signal;
    const toDateInput = (d) => d.toLocaleDateString('en-CA');
    setReservationModalMutationLock(false);
    const startEl = document.getElementById('event-start');
    const endEl = document.getElementById('event-end');
    const dateEl = document.getElementById('event-date-start');

    let dateStartVal;
    let startInstant;
    let endInstant;

    if (event) {
        const endDisplay = selectionEndDisplay(end);
        dateStartVal = toDateInput(start);
        startInstant = start;
        endInstant = endDisplay;
    } else {
        const midnight =
            start.getHours() === 0 &&
            start.getMinutes() === 0 &&
            start.getSeconds() === 0 &&
            start.getMilliseconds() === 0;

        const endOk =
            end instanceof Date && !Number.isNaN(end.getTime()) && end.getTime() > start.getTime();

        if (midnight && endOk) {
            dateStartVal = toDateInput(start);
            startInstant = start;
            endInstant = selectionEndDisplay(end);
        } else if (calendarForClip) {
            let anchor = start;
            if (midnight) {
                anchor = new Date(start);
                anchor.setHours(8, 0, 0, 0);
            }
            dateStartVal = toDateInput(anchor);
            const range = proposeReservationRangeFromAnchor(anchor, calendarForClip);
            startInstant = range.start;
            endInstant = range.end;
        } else if (midnight) {
            dateStartVal = toDateInput(start);
            const ds = new Date(start);
            ds.setHours(8, 0, 0, 0);
            startInstant = ds;
            endInstant = new Date(ds.getTime() + 60 * 60 * 1000);
        } else {
            dateStartVal = toDateInput(start);
            startInstant = start;
            endInstant = endOk
                ? selectionEndDisplay(end)
                : new Date(start.getTime() + 60 * 60 * 1000);
        }
    }

    if (dateEl instanceof HTMLInputElement) dateEl.value = dateStartVal;
    syncReservationDateWeekdayLabel();
    updateReservationModalHeadline(event || null);
    reservationModalInitialDurationMs = Math.max(
        30 * 60 * 1000,
        endInstant.getTime() - startInstant.getTime()
    );
    setSelectTime(startEl, startInstant);
    setSelectTime(endEl, endInstant);
    if (event) {
        applyReservationEventInfoPanel(
            event,
            startInstant,
            endInstant,
            owner,
            ownerLabelOverride,
            createdByLabelOverride
        );
    }
    if (calendarForClip?.getEvents) {
        dateEl?.addEventListener(
            'change',
            () => {
                const endDateEl = document.getElementById('event-date-end');
                if (endDateEl instanceof HTMLInputElement) {
                    if (!endDateEl.value || endDateEl.value < String(dateEl?.value || '')) {
                        endDateEl.value = String(dateEl?.value || '');
                    }
                }
                syncReservationDateWeekdayLabel();
                updateReservationModalHeadline(reservationModalEventRef);
                syncReservationModalTimeOptions(calendarForClip, reservationModalEventRef);
            },
            { signal: modalSignal }
        );
        const onStartFieldChange = () => {
            syncReservationModalTimeOptions(calendarForClip, reservationModalEventRef);
        };
        startEl?.addEventListener('change', onStartFieldChange, { signal: modalSignal });
        startEl?.addEventListener('input', onStartFieldChange, { signal: modalSignal });
    } else {
        dateEl?.addEventListener(
            'change',
            () => {
                const endDateEl = document.getElementById('event-date-end');
                if (endDateEl instanceof HTMLInputElement) {
                    if (!endDateEl.value || endDateEl.value < String(dateEl?.value || '')) {
                        endDateEl.value = String(dateEl?.value || '');
                    }
                }
                syncReservationDateWeekdayLabel();
                updateReservationModalHeadline(reservationModalEventRef);
            },
            { signal: modalSignal }
        );
    }

    document.getElementById('event-date-picker-btn')?.addEventListener(
        'click',
        () => {
            if (!(dateEl instanceof HTMLInputElement) || dateEl.disabled) return;
            if (typeof dateEl.showPicker === 'function') {
                try {
                    dateEl.showPicker();
                    return;
                } catch {
                    /* navigateur sans showPicker */
                }
            }
            dateEl.click();
        },
        { signal: modalSignal }
    );

    const recurWrap = document.getElementById('event-recurring-wrap');
    /** Réservation sur plusieurs jours : création, admin / prof uniquement. */
    const dateEndEl = document.getElementById('event-date-end');
    if (dateEndEl instanceof HTMLInputElement) {
        const endYmdFromEvent =
            event?.allDay && event?.end
                ? (() => {
                      const dt = event.end instanceof Date ? new Date(event.end) : new Date(event.end);
                      if (Number.isNaN(dt.getTime())) return dateStartVal;
                      dt.setDate(dt.getDate() - 1);
                      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
                  })()
                : event?.end
                  ? (() => {
                        const dt = event.end instanceof Date ? event.end : new Date(event.end);
                        if (Number.isNaN(dt.getTime())) return dateStartVal;
                        return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
                    })()
                  : dateStartVal;
        dateEndEl.value = endYmdFromEvent || dateStartVal;
        dateEndEl.disabled = !canEditEvent;
    }
    const showRecurring = isPrivilegedUser(currentUser) && !event;
    const repeatModeEl = document.getElementById('event-repeat-mode');
    const repeatEndModeEl = document.getElementById('event-repeat-end-mode');
    const repeatUntilEl = document.getElementById('event-repeat-until');
    const repeatCountEl = document.getElementById('event-repeat-count');
    if (repeatModeEl instanceof HTMLSelectElement) {
        repeatModeEl.disabled = !showRecurring;
    }
    if (repeatEndModeEl instanceof HTMLSelectElement) {
        repeatEndModeEl.disabled = !showRecurring;
    }
    if (repeatUntilEl instanceof HTMLInputElement) {
        repeatUntilEl.disabled = !showRecurring;
    }
    if (repeatCountEl instanceof HTMLInputElement) {
        repeatCountEl.disabled = !showRecurring;
    }
    if (showRecurring) {
        resetRecurringFormDefaults();
    } else {
        const untilYmd = defaultSeriesUntilYmd(dateStartVal);
        if (repeatModeEl instanceof HTMLSelectElement) repeatModeEl.value = 'once';
        if (repeatEndModeEl instanceof HTMLSelectElement) repeatEndModeEl.value = 'until';
        if (repeatUntilEl instanceof HTMLInputElement) repeatUntilEl.value = untilYmd;
        if (repeatCountEl instanceof HTMLInputElement) repeatCountEl.value = '';
    }
    syncReservationRangeModeUi(currentUser, event, canEditEvent);

    // Sécurité : Verrouillage si le créneau appartient à quelqu'un d'autre
    const fields = [
        'event-motif-select',
        'event-title-input',
        'event-date-start',
        'event-date-end',
        'event-date-display-label',
        'event-date-picker-btn',
        'event-start',
        'event-end',
        'event-repeat-mode',
        'event-repeat-end-mode',
        'event-repeat-until',
        'event-repeat-count',
        'reservation-slot-owner-email',
        'event-inscrits-select'
    ];
    fields.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = !canEditEvent;
    });
    for (let i = 0; i <= 6; i++) {
        const cb = document.getElementById(`recur-dow-${i}`);
        if (cb) cb.disabled = !canEditEvent;
    }
    applyReservationMotifVisibility(currentUser, event, canEditEvent);

    const datePickerBtn = document.getElementById('event-date-picker-btn');
    if (datePickerBtn instanceof HTMLElement) {
        datePickerBtn.classList.toggle('hidden', !canEditEvent);
        datePickerBtn.setAttribute('aria-hidden', canEditEvent ? 'false' : 'true');
    }

    document.getElementById('btn-save')?.classList.add('hidden');
    const footerWrap = document.getElementById('reservation-modal-footer');
    const actionsWrap = document.getElementById('reservation-form-actions');
    const btnCancel = document.getElementById('btn-reservation-cancel');
    const btnSaveFooter = document.getElementById('btn-reservation-save');
    const btnCloseReadOnly = document.getElementById('btn-reservation-close');
    const btnEditFermeture = document.getElementById('btn-reservation-edit-fermeture');
    const isReadOnlyView = Boolean(event) && !canEditEvent;
    const xpOpen = safeEventExtendedProps(event) || {};
    const isFermetureSlot =
        String(xpOpen.planningDbSlotType || '').toLowerCase() === 'fermeture' ||
        String(xpOpen.type || '').toLowerCase() === 'fermeture';
    const absencePeriodId = String(xpOpen.planningAbsencePeriodId || '').trim();
    let canEditFermeturePeriod = false;
    if (isFermetureSlot && absencePeriodId && isBackendAuthConfigured()) {
        if (normalizeRole(currentUser?.role) === 'admin') {
            canEditFermeturePeriod = true;
        } else {
            const sbAp = getSupabaseClient();
            if (sbAp) {
                const { data: apRow } = await sbAp
                    .from('planning_absence_period')
                    .select('created_by_user_id')
                    .eq('id', absencePeriodId)
                    .maybeSingle();
                canEditFermeturePeriod =
                    String(apRow?.created_by_user_id || '') === String(currentUser?.id || '');
            }
        }
    }
    if (footerWrap) {
        const showFooter = canEditEvent || isReadOnlyView || (isFermetureSlot && canEditFermeturePeriod);
        footerWrap.classList.toggle('hidden', !showFooter);
        footerWrap.setAttribute('aria-hidden', showFooter ? 'false' : 'true');
    }
    if (actionsWrap) {
        actionsWrap.classList.toggle('hidden', isReadOnlyView);
        actionsWrap.setAttribute('aria-hidden', isReadOnlyView ? 'true' : 'false');
    }
    if (btnCloseReadOnly instanceof HTMLButtonElement) {
        btnCloseReadOnly.classList.toggle(
            'hidden',
            !isReadOnlyView || (isFermetureSlot && canEditFermeturePeriod)
        );
    }
    if (btnEditFermeture instanceof HTMLButtonElement) {
        const showFermetureEdit =
            SHOW_LEGACY_FERMETURE_EDIT_UI && isFermetureSlot && canEditFermeturePeriod && isReadOnlyView;
        btnEditFermeture.classList.toggle('hidden', !showFermetureEdit);
        btnEditFermeture.disabled = !showFermetureEdit;
    }
    if (btnCancel instanceof HTMLButtonElement) btnCancel.disabled = !canEditEvent;
    if (btnSaveFooter instanceof HTMLButtonElement) btnSaveFooter.disabled = !canEditEvent;
    const showDelete =
        Boolean(event) &&
        canEditEvent &&
        canCurrentUserEditEventIgnoringPast(currentUser, event) &&
        (!isPastSlot || meRoleOpen === 'admin' || meRoleOpen === 'prof');
    document.getElementById('reservation-delete-wrap')?.classList.toggle('hidden', !showDelete);

    const refreshHeadlineOnly = () => updateReservationModalHeadline(reservationModalEventRef);
    document.getElementById('event-motif-select')?.addEventListener('change', refreshHeadlineOnly, {
        signal: modalSignal
    });
    document.getElementById('event-motif-select')?.addEventListener(
        'change',
        () => syncReservationRangeModeUi(currentUser, reservationModalEventRef, canEditEvent),
        { signal: modalSignal }
    );
    document.getElementById('event-title-input')?.addEventListener('input', refreshHeadlineOnly, {
        signal: modalSignal
    });
    document.getElementById('event-repeat-mode')?.addEventListener(
        'change',
        () => {
            const until = document.getElementById('event-repeat-until');
            const startYmd = String(document.getElementById('event-date-start')?.value || '').slice(0, 10);
            if (until instanceof HTMLInputElement && !until.value) {
                until.value = defaultSeriesUntilYmd(startYmd);
            }
            setRecurringOptionsVisible();
        },
        { signal: modalSignal }
    );
    document.getElementById('event-repeat-end-mode')?.addEventListener(
        'change',
        () => setRecurringOptionsVisible(),
        { signal: modalSignal }
    );

    btnEditFermeture?.addEventListener(
        'click',
        (e) => {
            e.preventDefault();
            if (!absencePeriodId) return;
            modal.close();
            void openClosureEditByPeriodId(absencePeriodId);
        },
        { signal: modalSignal }
    );

    btnCancel?.addEventListener(
        'click',
        async (e) => {
            e.preventDefault();
            if (!(await reservationModalMayCloseNow())) return;
            restoreReservationModalFormBaseline();
            modal.close();
        },
        { signal: modalSignal }
    );
    btnSaveFooter?.addEventListener(
        'click',
        (e) => {
            e.preventDefault();
            void dismissReservationRouteDialog({ save: true });
        },
        { signal: modalSignal }
    );
    btnCloseReadOnly?.addEventListener(
        'click',
        async (e) => {
            e.preventDefault();
            if (!(await reservationModalMayCloseNow())) return;
            modal.close();
        },
        { signal: modalSignal }
    );

    modal.classList.remove('planning-route-page');
    if (!(modal instanceof HTMLDialogElement)) return;
    modal.showModal();
    focusPlanningDialogRoot(modal);

    void enrichReservationModalAfterOpen({
        currentUser,
        event,
        calendarForClip,
        canEditEvent,
        owner,
        ownerLabelOverride,
        actorLabelOverride,
        createdByLabelOverride,
        lastModifiedByLabelOverride,
        startInstant,
        endInstant
    });
}

async function enrichReservationModalAfterOpen(ctx) {
    const {
        currentUser,
        event,
        calendarForClip,
        canEditEvent,
        owner,
        startInstant,
        endInstant
    } = ctx;
    let {
        ownerLabelOverride,
        actorLabelOverride,
        createdByLabelOverride,
        lastModifiedByLabelOverride
    } = ctx;
    try {
        let liveEvent = event;
        if (liveEvent) {
            const pr = await awaitQuickReservationPersistIfNeeded(liveEvent);
            if (pr && !pr.ok) return;
            if (calendarForClip) {
                const synced = resolveLivePlanningEventRef(calendarForClip, liveEvent);
                if (synced) {
                    liveEvent = synced;
                    reservationModalEventRef = synced;
                }
            }
        }
        if (liveEvent) {
            const cId = String(liveEvent.extendedProps?.createdByUserId || '').trim();
            const mId = String(liveEvent.extendedProps?.lastModifiedByUserId || '').trim();
            const ids = [owner.ownerUserId, currentUser?.id, cId, mId]
                .filter(Boolean)
                .filter((v, i, a) => a.indexOf(v) === i);
            const labelMap = await fetchProfileLabelsForUserIds(ids);
            if (owner.ownerUserId && labelMap.has(owner.ownerUserId)) {
                ownerLabelOverride = String(labelMap.get(owner.ownerUserId) || '');
            }
            if (currentUser?.id && labelMap.has(currentUser.id)) {
                actorLabelOverride = String(labelMap.get(currentUser.id) || '');
            }
            if (cId && labelMap.has(cId)) {
                createdByLabelOverride = String(labelMap.get(cId) || '');
            }
            if (mId && labelMap.has(mId)) {
                lastModifiedByLabelOverride = String(labelMap.get(mId) || '');
            }
            if (ownerLabelOverride) {
                reservationModalOwnerLabelRef = ownerLabelOverride;
                updateReservationModalHeadline(reservationModalEventRef);
            }
            if (liveEvent) {
                applyReservationEventInfoPanel(
                    liveEvent,
                    startInstant,
                    endInstant,
                    owner,
                    ownerLabelOverride,
                    createdByLabelOverride
                );
            }
        }
        await prepareReservationInscritsSelect(currentUser, liveEvent || null, canEditEvent);
        if (calendarForClip?.getEvents) {
            const startEl = document.getElementById('event-start');
            const endEl = document.getElementById('event-end');
            setSelectTime(startEl, startInstant);
            setSelectTime(endEl, endInstant);
            syncReservationModalTimeOptions(
                calendarForClip,
                reservationModalEventRef || liveEvent || null
            );
            setSelectTime(startEl, startInstant);
            setSelectTime(endEl, endInstant);
        }
        captureReservationModalFormBaseline();
    } catch (e) {
        console.warn('[Planning] enrichReservationModalAfterOpen', e);
    }
}

function inscritsEmailsCsvFromRpcRow(row) {
    const raw = row?.inscrits_emails;
    if (!Array.isArray(raw)) return '';
    const set = new Set(raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean));
    return [...set].join(',');
}

/**
 * Décale tous les cours partageant la même ligne gabarit à partir de l’occurrence en cours (inclus).
 * @returns {Promise<boolean>} true = enregistrement terminé (succès ou erreur affichée), ne pas poursuivre la voie « créneau seul ».
 */
async function applyCoursTemplateLineSeriesIfNeeded(p) {
    const {
        calendar,
        currentUser,
        liveEventRef,
        canonicalExisting,
        ownerUid,
        slotOwnerEmail,
        ownerForBridge,
        bridgeType,
        prevSnapshot,
        title,
        startIso,
        endIso,
        startStr,
        endStr,
        templateLineId,
        slotType
    } = p;

    await fetchOrganSchoolSettings();
    const settings = getOrganSchoolSettingsCached();
    const prevStartMs = new Date(prevSnapshot.startStr).getTime();
    const rangeStart = new Date(prevStartMs);
    rangeStart.setDate(rangeStart.getDate() - 1);
    rangeStart.setHours(0, 0, 0, 0);

    let rangeEnd;
    const ymdEnd = settings?.school_year_end ? String(settings.school_year_end).slice(0, 10) : '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(ymdEnd)) {
        rangeEnd = new Date(`${ymdEnd}T23:59:59`);
    } else {
        rangeEnd = new Date(prevStartMs);
        rangeEnd.setFullYear(rangeEnd.getFullYear() + 1);
    }

    const rows = await fetchPlanningEventRowsInRange(rangeStart, rangeEnd);
    const ownerUidStr = String(ownerUid).trim();
    const tpl = String(templateLineId).trim();
    const siblings = rows
        .filter((r) => {
            if (String(r.slot_type || '') !== 'cours') return false;
            if (String(r.owner_user_id || '') !== ownerUidStr) return false;
            if (String(r.source_template_line_id || '') !== tpl) return false;
            const t = new Date(r.start_at).getTime();
            return t >= prevStartMs && t <= rangeEnd.getTime();
        })
        .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());

    if (siblings.length === 0) return false;

    const titleTrim = String(title || '').trim();
    const tplSync = await syncOrganWeekTemplateLineFromOccurrence(tpl, {
        startIso,
        endIso,
        title: titleTrim
    });
    if (!tplSync.ok) {
        console.warn('[calendar-logic] gabarit semaines A/B', tplSync.error);
    }
    const prevTitle = String(prevSnapshot.title || '').trim();
    const titleChanged = prevTitle !== titleTrim;
    const dS = new Date(startIso).getTime() - new Date(prevSnapshot.startStr).getTime();
    const dE = new Date(endIso).getTime() - new Date(prevSnapshot.endStr).getTime();

    const ownerEmailLower = String(slotOwnerEmail || currentUser.email || '').trim().toLowerCase();

    for (const row of siblings) {
        const rid = String(row.id || '').trim();
        if (!rid) continue;
        const ns = new Date(new Date(row.start_at).getTime() + dS).toISOString();
        const ne = new Date(new Date(row.end_at).getTime() + dE).toISOString();
        const nextTitle = titleChanged ? titleTrim : String(row.title || '').trim() || 'Cours';
        const ur = await upsertPlanningEventRow({
            id: rid,
            startIso: ns,
            endIso: ne,
            title: nextTitle,
            dbSlotType: 'cours',
            ownerEmail: ownerEmailLower,
            ownerUserId: ownerUidStr
        });
        if (!ur.ok) {
            showToast(ur.error || 'Enregistrement série impossible.', 'error');
            return false;
        }
    }

    const enrollSync = await syncPlanningEnrollmentAfterSave(canonicalExisting, 'cours');
    if (!enrollSync.ok) {
        showToast(enrollSync.error || 'Enregistrement des inscriptions impossible.', 'error');
        return false;
    }

    /** @type {Record<string, unknown>[]} */
    const bridgeEvents = [];
    for (const row of siblings) {
        const rid = String(row.id || '').trim();
        const ns = new Date(new Date(row.start_at).getTime() + dS).toISOString();
        const ne = new Date(new Date(row.end_at).getTime() + dE).toISOString();
        const nextTitle = titleChanged ? titleTrim : String(row.title || '').trim() || 'Cours';
        const mirrors = await fetchPlanningMainPoolGoogleIdsForEvent(rid);
        const emailsCsv =
            rid === canonicalExisting
                ? enrollSync.emailsCsv || ''
                : inscritsEmailsCsvFromRpcRow(row);
        bridgeEvents.push({
            planningEventId: rid,
            ...(mirrors.mainGoogleEventId ? { googleEventId: mirrors.mainGoogleEventId } : {}),
            title: nextTitle,
            start: ns,
            end: ne,
            type: bridgeType,
            owner: ownerForBridge || currentUser.email,
            ...(mirrors.poolGoogleEventId ? { poolGoogleEventId: mirrors.poolGoogleEventId } : {}),
            ...(emailsCsv ? { inscrits: emailsCsv } : {})
        });
    }

    if (!reservationAutoSaveMode) {
        document.getElementById('modal_reservation')?.close();
    }
    const n = siblings.length;
    showToast(n > 1 ? `${n} cours mis à jour (série gabarit).` : 'Cours mis à jour.');

    const seriesChanged =
        String(prevSnapshot.title || '').trim() !== titleTrim ||
        prevSnapshot.startStr !== startIso ||
        prevSnapshot.endStr !== endIso;
    if (seriesChanged) {
        const seriesInscrits = enrollSync.emailsCsv
            .split(',')
            .map((x) => String(x).trim().toLowerCase())
            .filter(Boolean);
        if (seriesInscrits.length) {
            notifyEnrolledStudentsOnCoursEditNonBlocking({
                currentUser,
                slotTitle: titleTrim,
                slotStart: startIso,
                slotEnd: endIso,
                previousStartIso: prevSnapshot.startStr,
                previousEndIso: prevSnapshot.endStr,
                inscritEmails: seriesInscrits,
                ownerEmail: ownerForBridge || slotOwnerEmail || currentUser.email
            });
        }
    }

    if (liveEventRef) {
        const localInscritsEmails = getReservationInscritsSelection()
            .emailsCsv.split(',')
            .map((x) => String(x).trim())
            .filter(Boolean);
        try {
            if (typeof liveEventRef.setDates === 'function') {
                liveEventRef.setDates(new Date(startStr), new Date(endStr));
            }
        } catch (e) {
            console.warn('[calendar-logic] setDates série gabarit', e);
        }
        if (typeof liveEventRef.setProp === 'function') {
            liveEventRef.setProp('title', titleTrim);
        }
        if (typeof liveEventRef.setExtendedProp === 'function') {
            liveEventRef.setExtendedProp('type', slotType);
            liveEventRef.setExtendedProp('planningDbSlotType', 'cours');
            liveEventRef.setExtendedProp('inscrits', localInscritsEmails);
        }
    }

    void (async () => {
        try {
            const syncMulti = await trySyncGoogleCalendar(bridgeEvents);
            if (calendarBridgeWanted() && !syncMulti.ok && !syncMulti.skipped) {
                showToast(`Synchronisation agenda : ${syncMulti.error || 'échec'}`, 'error');
            }
        } catch (e) {
            console.error(e);
        }
        try {
            await refetchPlanningGrid(calendar);
        } catch (e) {
            console.error(e);
        }
    })();

    return true;
}

/** Synchronisation Google ; pas de toast ici (l’appelant décide après fermeture modale / ordre des messages). */
async function trySyncGoogleCalendar(eventsPayload) {
    if (!isBackendAuthConfigured()) return { ok: true, skipped: true, data: null };
    const { calendarBridgeUrl } = getPlanningConfig();
    if (!calendarBridgeUrl) return { ok: true, skipped: true, data: null };
    if (!Array.isArray(eventsPayload) || eventsPayload.length === 0) {
        return { ok: true, skipped: true, data: null };
    }
    const token = await getAccessToken();
    if (!token) {
        return { ok: false, skipped: false, data: null, error: 'Session expirée (reconnectez-vous).' };
    }
    const r = await invokeCalendarBridge(token, { action: 'upsert', events: eventsPayload });
    if (!r.ok && !r.skipped) {
        return {
            ok: false,
            skipped: false,
            data: null,
            error: r.error ? String(r.error) : 'échec'
        };
    }
    return { ok: r.ok, skipped: Boolean(r.skipped), data: r.data, error: r.error };
}

// --- 3. ACTIONS (SAUVEGARDE / SUPPRESSION) ---
/** @returns {Promise<boolean>} true si enregistrement réussi */
export async function saveReservation(calendar, currentUser, currentEventRef) {
    if (!currentUser || !currentUser.email) {
        showToast('Veuillez vous connecter pour enregistrer une réservation.', 'error');
        return false;
    }
    let eventRef = currentEventRef;
    /** @type {QuickPersistResult | null} */
    let quickPersistResult = null;
    if (eventRef) {
        quickPersistResult = await awaitQuickReservationPersistIfNeeded(eventRef);
        if (quickPersistResult && !quickPersistResult.ok) {
            showToast(quickPersistResult.error || 'Enregistrement initial impossible.', 'error');
            return false;
        }
    }
    if (calendar && eventRef) {
        const synced = refreshReservationModalEventRef(calendar, eventRef);
        if (synced) {
            eventRef = synced;
            if (currentEventRef === reservationModalEventRef) {
                reservationModalEventRef = synced;
            }
        }
    }
    const liveEventRef = eventRef ? resolveLivePlanningEventRef(calendar, eventRef) : null;
    const xpStale = safeEventExtendedProps(eventRef);
    const staleCanonicalId =
        !liveEventRef && xpStale
            ? String(xpStale.planningCanonicalId || safeEventId(eventRef) || '').trim()
            : '';
    if (liveEventRef && isReservationNonEditablePast(currentUser, liveEventRef)) {
        showToast('Les créneaux passés ne sont pas modifiables.', 'error');
        return false;
    }

    if (
        liveEventRef &&
        reservationModalFormBaseline !== null &&
        !isReservationModalDirty()
    ) {
        if (!reservationAutoSaveMode) {
            document.getElementById('modal_reservation')?.close();
        }
        return true;
    }

    if (saveReservationInFlight) return false;
    if (deleteReservationInFlight) return false;
    saveReservationInFlight = true;
    const saveBtn = document.getElementById('btn-save');
    setReservationModalMutationLock(true);
    if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = true;

    try {
    if (!isBackendAuthConfigured()) {
        showToast('Connexion requise pour enregistrer.', 'error');
        return false;
    }
    const motif = getReservationMotifFromForm(currentUser, liveEventRef);
    if (!liveEventRef && !motif) {
        showToast('Choisissez un motif.', 'error');
        return false;
    }
    const title = getReservationTextTitleFromForm(currentUser, motif);
    const slotOwnerEmail = getReservationSlotOwnerEmail(currentUser, liveEventRef);
    const slotType = motifToSlotType(motif);
    const lockedDbSlotType = reservationSlotTypeLockedFromEvent(
        currentUser,
        liveEventRef || eventRef
    );
    const repeatMode = isPrivilegedUser(currentUser) && !liveEventRef ? repeatModeFromForm() : 'once';
    const recurOn = repeatMode !== 'once';

    if (recurOn) {
        if (slotType === 'fermeture' || slotType === 'indispo') {
            showToast('La périodicité est réservée aux cours, travail perso, concert et autre.', 'error');
            return false;
        }
        const dateStart = document.getElementById('event-date-start')?.value;
        const tStart = document.getElementById('event-start')?.value;
        const tEnd = document.getElementById('event-end')?.value;
        if (!dateStart || !tStart || !tEnd) {
            showToast('Veuillez renseigner le jour et les heures de début et de fin.', 'error');
            return false;
        }
        const startIso = new Date(`${dateStart}T${tStart}:00`).toISOString();
        const endIso = new Date(`${dateStart}T${tEnd}:00`).toISOString();
        if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
            showToast('L’heure de fin doit être après l’heure de début.', 'error');
            return false;
        }
        const repeatEndMode = repeatEndModeFromForm();
        const repeatUntilInput = String(document.getElementById('event-repeat-until')?.value || '').slice(0, 10);
        const repeatCountRaw = String(document.getElementById('event-repeat-count')?.value || '').trim();
        const repeatCount = Number.parseInt(repeatCountRaw, 10);
        const untilYmd =
            repeatEndMode === 'until'
                ? repeatUntilInput
                : defaultSeriesUntilYmd(dateStart);
        if (repeatEndMode === 'until' && !untilYmd) {
            showToast('La date de fin est obligatoire pour une série périodique.', 'error');
            return false;
        }
        if (untilYmd && untilYmd < dateStart) {
            showToast('La date de fin doit être le même jour ou après la première occurrence.', 'error');
            return false;
        }
        if (repeatEndMode === 'count' && (!Number.isFinite(repeatCount) || repeatCount < 1)) {
            showToast('Indiquez un nombre d’occurrences valide.', 'error');
            return false;
        }
        const ownerUid = await planningUserIdForEmail(slotOwnerEmail || currentUser.email);
        if (!ownerUid) {
            showToast('Impossible de résoudre le compte du propriétaire du créneau.', 'error');
            return false;
        }
        const dbSlotType = motifToPlanningDbSlotType(motif);
        const bridgeType = planningDbSlotTypeToBridgeType(dbSlotType);
        const seriesRes = await createPlanningEventSeries({
            ownerUserId: ownerUid,
            ownerEmail: slotOwnerEmail || currentUser.email,
            slotType: dbSlotType,
            title,
            startAtFirst: startIso,
            untilYmd,
            occurrenceLimit: repeatEndMode === 'count' ? repeatCount : null,
            frequencyInterval: repeatMode === 'biweekly' ? 2 : 1
        });
        if (!seriesRes.ok || !seriesRes.series?.id) {
            showToast(seriesRes.error || 'Création de la série impossible.', 'error');
            return false;
        }
        const planRes = await planSeriesAutoPauseExceptions({
            ownerUid,
            startIso,
            endIso,
            untilYmd,
            occurrenceLimit: repeatEndMode === 'count' ? repeatCount : null,
            frequencyInterval: repeatMode === 'biweekly' ? 2 : 1
        });
        if (!planRes.ok) {
            await deletePlanningEventSeries(seriesRes.series.id);
            showToast(planRes.error || 'Préparation de la série impossible.', 'error');
            return false;
        }
        for (const ex of planRes.plannedExceptions) {
            const created = await createPlanningSeriesException(
                ex.occurrenceStartAt,
                ex.exceptionKind,
                ex.payload,
                String(currentUser?.id || '').trim(),
                seriesRes.series.id
            );
            if (!created.ok) {
                await deletePlanningEventSeries(seriesRes.series.id);
                showToast(created.error || 'Création des pauses de série impossible.', 'error');
                return false;
            }
        }
        const rows = buildPlanningEventRowsFromSeries({
            seriesId: seriesRes.series.id,
            ownerUserId: ownerUid,
            ownerEmail: slotOwnerEmail || currentUser.email,
            slotType: dbSlotType,
            title,
            startIso,
            endIso,
            untilYmd,
            occurrenceLimit: repeatEndMode === 'count' ? repeatCount : null,
            frequencyInterval: repeatMode === 'biweekly' ? 2 : 1,
            seriesExceptions: planRes.plannedExceptions
        });
        if (!rows.length) {
            await deletePlanningEventSeries(seriesRes.series.id);
            showToast('Aucune occurrence à créer sur la période demandée.', 'error');
            return false;
        }
        /** @type {Record<string, unknown>[]} */
        const bridgeEventsDb = [];
        /** @type {string[]} */
        const createdIds = [];
        for (const row of rows) {
            const ur = await upsertPlanningEventRow({
                id: null,
                startIso: row.startIso,
                endIso: row.endIso,
                title,
                dbSlotType,
                ownerEmail: slotOwnerEmail || currentUser.email,
                ownerUserId: ownerUid,
                seriesId: seriesRes.series.id,
                seriesPosition: row.seriesPosition
            });
            if (!ur.ok || !ur.id) {
                for (const id of createdIds) await deletePlanningEventRow(id);
                await deletePlanningEventSeries(seriesRes.series.id);
                showToast(ur.error || 'Enregistrement base impossible.', 'error');
                return false;
            }
            createdIds.push(ur.id);
            const enrollR = await syncPlanningEnrollmentAfterSave(ur.id, dbSlotType);
            if (!enrollR.ok) {
                for (const id of createdIds) await deletePlanningEventRow(id);
                await deletePlanningEventSeries(seriesRes.series.id);
                showToast(enrollR.error || 'Enregistrement des inscriptions impossible.', 'error');
                return false;
            }
            bridgeEventsDb.push({
                planningEventId: ur.id,
                title,
                start: row.startIso,
                end: row.endIso,
                type: bridgeType,
                owner: slotOwnerEmail || currentUser.email,
                ...(enrollR.emailsCsv ? { inscrits: enrollR.emailsCsv } : {})
            });
        }
        if (!reservationAutoSaveMode) {
            document.getElementById('modal_reservation').close();
            const pausesCount = planRes.plannedExceptions.length;
            showToast(
                pausesCount > 0
                    ? `${rows.length} créneau${rows.length > 1 ? 'x' : ''} périodique${rows.length > 1 ? 's' : ''} enregistré${rows.length > 1 ? 's' : ''} (${pausesCount} pause${pausesCount > 1 ? 's' : ''} sur fermeture/indispo).`
                    : `${rows.length} créneau${rows.length > 1 ? 'x' : ''} périodique${rows.length > 1 ? 's' : ''} enregistré${rows.length > 1 ? 's' : ''}.`
            );
        }
        resetRecurringFormDefaults();
        await refetchPlanningGrid(calendar);
        if (calendarBridgeWanted()) {
            for (const id of createdIds) {
                try {
                    calendar?.getEventById?.(id)?.setExtendedProp?.('planningGoogleSyncPending', true);
                } catch {
                    /* */
                }
            }
        }
        if (bridgeEventsDb.length > 0) {
            voidLaunchReservationGoogleSyncWithRollback(
                calendar,
                bridgeEventsDb,
                { mode: 'create', eventId: createdIds[0] || '', createdIds }
            );
        }
        return true;
    }

    const dateStart = String(document.getElementById('event-date-start')?.value || '').slice(0, 10);
    const dateEndInput = String(document.getElementById('event-date-end')?.value || '').slice(0, 10);
    const tStart = String(document.getElementById('event-start')?.value || '').trim();
    const tEnd = String(document.getElementById('event-end')?.value || '').trim();
    const usesDateRange = reservationUsesDateEndRange(motif);
    const dateEnd = usesDateRange ? dateEndInput || dateStart : dateStart;

    if (!dateStart) {
        showToast('Veuillez renseigner le jour de début.', 'error');
        return false;
    }
    if (usesDateRange && !dateEnd) {
        showToast('Veuillez renseigner la date de fin.', 'error');
        return false;
    }
    if (dateEnd < dateStart) {
        showToast('La date de fin doit être le même jour ou après le début.', 'error');
        return false;
    }

    const dbSlotType = lockedDbSlotType || motifToPlanningDbSlotType(motif);
    const bridgeType = planningDbSlotTypeToBridgeType(dbSlotType);
    let startStr = '';
    let endStr = '';
    let isAllDaySingle = false;

    if (dbSlotType === 'fermeture') {
        if (normalizeRole(currentUser?.role) !== 'admin') {
            showToast('Seuls les administrateurs peuvent créer des fermetures.', 'error');
            return false;
        }
        startStr = `${dateStart}T00:00:00`;
        const endExclusive = new Date(`${dateEnd}T00:00:00`);
        endExclusive.setDate(endExclusive.getDate() + 1);
        endStr = `${endExclusive.getFullYear()}-${String(endExclusive.getMonth() + 1).padStart(2, '0')}-${String(endExclusive.getDate()).padStart(2, '0')}T00:00:00`;
        isAllDaySingle = true;
    } else if (dbSlotType === 'indispo') {
        if (normalizeRole(currentUser?.role) !== 'prof') {
            showToast('Le type indispo est réservé aux professeurs.', 'error');
            return false;
        }
        if (!tStart || !tEnd) {
            showToast('Veuillez renseigner les heures de début et de fin.', 'error');
            return false;
        }
        startStr = `${dateStart}T${tStart}:00`;
        endStr = `${dateEnd}T${tEnd}:00`;
    } else {
        if (!tStart || !tEnd) {
            showToast('Veuillez renseigner le jour et les heures de début et de fin.', 'error');
            return false;
        }
        startStr = `${dateStart}T${tStart}:00`;
        endStr = `${dateStart}T${tEnd}:00`;
    }

    const startMs = new Date(startStr).getTime();
    const endMs = new Date(endStr).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
        showToast('La date et heure de fin doivent être après le début.', 'error');
        return false;
    }

    if (liveEventRef && isReservationNonEditablePast(currentUser, { start: new Date(startStr) })) {
        showToast('Impossible d’enregistrer un créneau dans le passé.', 'error');
        return false;
    }

    /** @type {{ title: string, startStr: string, endStr: string } | null} */
    let prevSnapshot = null;
    if (reservationModalFormBaseline) {
        try {
            const snap = JSON.parse(reservationModalFormBaseline);
            const d = String(snap?.date || '').trim();
            const t0 = String(snap?.start || '').trim();
            const t1 = String(snap?.end || '').trim();
            if (d && t0 && t1) {
                prevSnapshot = {
                    title: String(snap?.title || '').trim(),
                    startStr: new Date(`${d}T${t0}:00`).toISOString(),
                    endStr: new Date(`${d}T${t1}:00`).toISOString()
                };
            }
        } catch {
            /* baseline invalide */
        }
    }
    if (!prevSnapshot && liveEventRef) {
        prevSnapshot = seriesPrevSnapshotFromEvent(liveEventRef);
    }

    const ownerForBridge = slotOwnerEmail || String(currentUser.email || '').trim();
    const gid = liveEventRef ? bridgeGoogleIdFromFcEvent(liveEventRef) : '';
    const poolLinkExisting = String(liveEventRef?.extendedProps?.poolGoogleEventId ?? '').trim();

    const startIso = new Date(startStr).toISOString();
    const endIso = new Date(endStr).toISOString();
    let canonicalExisting = liveEventRef
        ? String(liveEventRef.extendedProps?.planningCanonicalId || '').trim()
        : staleCanonicalId;
    if (!canonicalExisting && quickPersistResult?.dbId) {
        canonicalExisting = quickPersistResult.dbId;
    }
    const ownerUid = await planningUserIdForEmail(slotOwnerEmail || currentUser.email);
    if (!ownerUid) {
        showToast('Impossible de résoudre le compte du propriétaire du créneau.', 'error');
        return false;
    }
    if (dbSlotType !== 'fermeture' && dbSlotType !== 'indispo') {
        const conflictSingle = findOverlappingCalendarEvent(
            calendar,
            new Date(startStr),
            new Date(endStr),
            liveEventRef
        );
        if (conflictSingle) {
            showToast(overlapToastMessage(conflictSingle), 'error');
            return false;
        }
    }
    if (dbSlotType === 'fermeture' || dbSlotType === 'indispo') {
        const overlapsRaw = await fetchPlanningRowsOverlappingRange(startIso, endIso, canonicalExisting);
        const overlaps =
            dbSlotType === 'fermeture'
                ? overlapsRaw
                : overlapsRaw.filter((row) => String(row.owner_user_id || '').trim() === String(ownerUid).trim());
        if (overlaps.length) {
            if (dbSlotType === 'indispo') {
                const seriesResolution = await resolveGeneratedSeriesOverlapsForIndispo({
                    calendar,
                    currentUser,
                    overlaps,
                    indispoStartIso: startIso,
                    indispoEndIso: endIso
                });
                if (!seriesResolution.ok) {
                    if (seriesResolution.cancelled) return false;
                    showToast(seriesResolution.error || 'Traitement des séries touchées impossible.', 'error');
                    return false;
                }
                if (seriesResolution.deleteIds.length) {
                    const deleteRes = await deletePlanningEventsByCanonicalIds(seriesResolution.deleteIds);
                    if (!deleteRes.ok) {
                        showToast(deleteRes.error || 'Suppression des créneaux recouverts impossible.', 'error');
                        return false;
                    }
                }
            } else {
                const { planningConfirm } = await import('../utils/planning-confirm.js');
                const ok = await planningConfirm(
                    `Cette fermeture supprimera ${overlaps.length} créneau${overlaps.length > 1 ? 'x' : ''} sur la période choisie. Continuer ?`,
                    {
                        title: 'Confirmer la fermeture',
                        confirmLabel: 'Continuer',
                        danger: true
                    }
                );
                if (!ok) return false;
                const deleteRes = await deletePlanningEventsByCanonicalIds(
                    overlaps.map((row) => String(row.id || '').trim())
                );
                if (!deleteRes.ok) {
                    showToast(deleteRes.error || 'Suppression des créneaux recouverts impossible.', 'error');
                    return false;
                }
            }
        }
    }
    const capModal = await validateEleveTravailPersistCap(
        {
            start: new Date(startStr),
            end: new Date(endStr),
            extendedProps: {
                ...(safeEventExtendedProps(liveEventRef) || {}),
                planningDbSlotType: dbSlotType,
                type: motifToSlotType(motif)
            }
        },
        canonicalExisting || quickPersistResult?.dbId || null
    );
    if (!capModal.ok) {
        showToast(capModal.message || 'Quota hebdomadaire dépassé.', 'error');
        return false;
    }
    if (liveEventRef && isEventDbPersistPending(liveEventRef)) {
        showToast('Créneau encore en cours d’enregistrement en base.', 'info');
        return false;
    }

    const tplLineId =
        liveEventRef && canonicalExisting
            ? String(liveEventRef.extendedProps?.planningSourceTemplateLineId || '').trim()
            : '';
    const currentSeriesId =
        liveEventRef && canonicalExisting
            ? String(liveEventRef.extendedProps?.planningSeriesId || '').trim()
            : '';
    if (currentSeriesId && (dbSlotType === 'fermeture' || dbSlotType === 'indispo')) {
        showToast(
            'Une occurrence périodique ne peut pas être transformée en fermeture ou indispo. Créez ce blocage séparément.',
            'error'
        );
        return false;
    }

    let detachTemplateLink = false;
    let detachSeriesLink = false;
    if (liveEventRef && canonicalExisting && prevSnapshot) {
        const seriesResult = await maybeApplyCoursSeriesScopeBeforePersist({
            calendar,
            currentUser,
            liveEventRef,
            canonicalExisting,
            dbSlotType,
            tplLineId,
            prevSnapshot,
            title,
            startIso,
            endIso,
            startStr,
            endStr,
            ownerUid,
            slotOwnerEmail: slotOwnerEmail || currentUser.email,
            ownerForBridge,
            bridgeType,
            slotType
        });
        if (seriesResult === 'cancelled') return false;
        if (seriesResult === 'handled') return true;
        if (seriesResult?.action === 'continue') {
            detachTemplateLink = Boolean(seriesResult.detachTemplateLink);
            detachSeriesLink = Boolean(seriesResult.detachSeriesLink);
        }
    }

    const ur = await upsertPlanningEventRow({
        id: canonicalExisting || null,
        startIso,
        endIso,
        title,
        dbSlotType,
        ownerEmail: slotOwnerEmail || currentUser.email,
        ownerUserId: ownerUid,
        ...(detachTemplateLink ? { sourceTemplateLineId: null } : {}),
        ...(detachSeriesLink ? { seriesId: null, seriesPosition: null } : {})
    });
    if (!ur.ok || !ur.id) {
        showToast(ur.error || 'Enregistrement base impossible.', 'error');
        return false;
    }
    if (detachTemplateLink && liveEventRef && typeof liveEventRef.setExtendedProp === 'function') {
        liveEventRef.setExtendedProp('planningSourceTemplateLineId', '');
    }
    if (detachSeriesLink && liveEventRef && typeof liveEventRef.setExtendedProp === 'function') {
        liveEventRef.setExtendedProp('planningSeriesId', '');
        liveEventRef.setExtendedProp('planningSeriesPosition', null);
    }
    const enrollSync = await syncPlanningEnrollmentAfterSave(ur.id, dbSlotType);
    if (!enrollSync.ok) {
        if (!canonicalExisting && !liveEventRef) {
            await deletePlanningEventRow(ur.id);
        }
        showToast(enrollSync.error || 'Enregistrement des inscriptions impossible.', 'error');
        return false;
    }
    const inscritsEmailsForNotify =
        dbSlotType === 'cours'
            ? enrollSync.emailsCsv
                  .split(',')
                  .map((x) => String(x).trim().toLowerCase())
                  .filter(Boolean)
            : [];
    const payloadDb = {
        planningEventId: ur.id,
        ...(gid ? { googleEventId: gid } : {}),
        title,
        start: startIso,
        end: endIso,
        type: bridgeType,
        owner: ownerForBridge || currentUser.email,
        ...(poolLinkExisting ? { poolGoogleEventId: poolLinkExisting } : {}),
        ...(enrollSync.emailsCsv ? { inscrits: enrollSync.emailsCsv } : {})
    };

    let googlePayloadUnchanged =
        Boolean(prevSnapshot) &&
        prevSnapshot.title === title &&
        prevSnapshot.startStr === startIso &&
        prevSnapshot.endStr === endIso;
    if (googlePayloadUnchanged && dbSlotType === 'cours' && reservationModalFormBaseline) {
        try {
            const snap = JSON.parse(reservationModalFormBaseline);
            const baseIds = (Array.isArray(snap.inscrits) ? snap.inscrits : [])
                .map((x) => String(x))
                .filter(Boolean)
                .sort()
                .join(',');
            const curIds = getReservationInscritsSelection()
                .userIds.map((x) => String(x))
                .filter(Boolean)
                .sort()
                .join(',');
            if (baseIds !== curIds) googlePayloadUnchanged = false;
        } catch {
            googlePayloadUnchanged = false;
        }
    }

    const isModalCreate = !liveEventRef;
    const modalSaveMode = isModalCreate ? 'create' : 'edit';
    const ownerEmailNorm = String(slotOwnerEmail || currentUser.email || '').trim().toLowerCase();
    const prevDbForRollback = liveEventRef
        ? buildModalSavePrevDbSnapshot(
              prevSnapshot,
              reservationModalFormBaseline,
              liveEventRef,
              ownerEmailNorm,
              ownerUid
          )
        : null;
    const needsGoogleSync = dbSlotType !== 'indispo' && !googlePayloadUnchanged && calendarBridgeWanted();

    if (!reservationAutoSaveMode) {
        document.getElementById('modal_reservation').close();
    }
    if (!reservationAutoSaveMode && isModalCreate) {
        showToast('Réservation enregistrée.');
    }

    const localInscritsEmails =
        dbSlotType === 'cours'
            ? getReservationInscritsSelection()
                  .emailsCsv.split(',')
                  .map((x) => String(x).trim())
                  .filter(Boolean)
            : [];

    applyModalReservationDisplayOnCalendar(calendar, currentUser, {
        isCreate: isModalCreate,
        liveEventRef,
        eventId: ur.id,
        title,
        startIso,
        endIso,
        dbSlotType,
        slotType,
        ownerEmail: ownerEmailNorm,
        inscritsEmails: localInscritsEmails,
        isAllDay: isAllDaySingle,
        googlePending: needsGoogleSync
    });

    refreshReservationModalEventRef(calendar, liveEventRef || eventRef, ur.id);
    reservationModalFormBaseline = null;
    reservationModalEventPropsBaseline = null;

    const oiBeforeNotify =
        liveEventRef && prevSnapshot ? ownerInfoFromEvent(liveEventRef, currentUser) : null;
    const runModalSaveNotifications = () => {
        if (!prevSnapshot || !oiBeforeNotify) return;
        const changed =
            prevSnapshot.title !== title ||
            prevSnapshot.startStr !== startIso ||
            prevSnapshot.endStr !== endIso;
        const actor = String(currentUser.email).trim().toLowerCase();
        const ownerLower = String(ownerForBridge || '').trim().toLowerCase();
        if (changed && ownerLower && ownerLower !== actor) {
            notifySlotOwnerAfterThirdPartyEditNonBlocking({
                currentUser,
                action: 'modified',
                targetOwnerEmail: oiBeforeNotify.ownerEmail,
                targetOwnerDisplayName: oiBeforeNotify.ownerName,
                targetOwnerUserId: oiBeforeNotify.ownerUserId,
                slotTitle: title,
                slotStart: startIso,
                slotEnd: endIso,
                previousStartIso: prevSnapshot.startStr,
                previousEndIso: prevSnapshot.endStr
            });
        }
        if (changed && dbSlotType === 'cours' && inscritsEmailsForNotify.length) {
            notifyEnrolledStudentsOnCoursEditNonBlocking({
                currentUser,
                slotTitle: title,
                slotStart: startIso,
                slotEnd: endIso,
                previousStartIso: prevSnapshot.startStr,
                previousEndIso: prevSnapshot.endStr,
                inscritEmails: inscritsEmailsForNotify,
                ownerEmail: ownerForBridge
            });
        }
    };

    const rollbackCtx = {
        mode: /** @type {'create' | 'edit'} */ (modalSaveMode),
        eventId: ur.id,
        prevDb: prevDbForRollback
    };

    voidLaunchReservationGoogleSyncWithRollback(
        calendar,
        needsGoogleSync ? [payloadDb] : [],
        rollbackCtx,
        runModalSaveNotifications
    );
    if (calendar) {
        await refetchPlanningGrid(calendar);
    }

    return true;
    } finally {
        saveReservationInFlight = false;
        setReservationModalMutationLock(false);
        if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = false;
    }
    return false;
}

export async function deleteReservation(calendar, currentEventRef, currentUser) {
    if (deleteReservationInFlight || saveReservationInFlight) return;
    if (!currentEventRef) return;
    if (!currentUser?.email) {
        showToast('Connectez-vous pour supprimer.', 'error');
        return;
    }
    const liveRef = resolveLivePlanningEventRef(calendar, currentEventRef);
    const rMeDel = normalizeRole(currentUser.role);
    if (isReservationNonEditablePast(currentUser, liveRef)) {
        if (rMeDel !== 'admin' && rMeDel !== 'prof') {
            showToast('Les créneaux passés ne sont pas modifiables.', 'error');
            return;
        }
    }
    if (!canCurrentUserEditEventIgnoringPast(currentUser, liveRef)) {
        showToast('Vous ne pouvez pas supprimer ce créneau.', 'error');
        return;
    }

    deleteReservationInFlight = true;
    setReservationModalMutationLock(true);
    const dbTypeDel = planningDbSlotTypeForEventUpdate(liveRef);
    /** @type {Record<string, unknown> | null} */
    let settingsForVoid = null;
    try {
    if (rMeDel === 'eleve' && dbTypeDel === 'travail perso') {
        await fetchOrganSchoolSettings();
        settingsForVoid = getOrganSchoolSettingsCached();
        if (settingsForVoid?.eleve_forbid_delete_after_slot_start && liveRef.start) {
            const st = liveRef.start instanceof Date ? liveRef.start : new Date(liveRef.start);
            if (Number.isFinite(st.getTime()) && Date.now() >= st.getTime()) {
                showToast('Vous ne pouvez plus annuler ce créneau une fois l’heure de début passée.', 'error');
                return;
            }
        }
    }

    const oi = ownerInfoFromEvent(liveRef, currentUser);
    const titleDel = String(liveRef.title || '').trim() || 'Créneau';
    const startDel = liveRef.start;
    const endDel = liveRef.end;

    if (!isBackendAuthConfigured()) {
        showToast('Session requise pour supprimer.', 'error');
        return;
    }
    const canonicalId = String(liveRef.extendedProps?.planningCanonicalId || '').trim();
    if (!canonicalId) {
        showToast('Créneau sans identifiant base : suppression impossible.', 'error');
        return;
    }
    const targets = await fetchPlanningMirrorTargetsForDelete(canonicalId);
    if (targets.length > 0) {
        const mirrorSync = await runGoogleMirrorSyncWithBanner(targets);
        if (!mirrorSync.ok && !mirrorSync.skipped) {
            showToast(`Suppression agenda : ${mirrorSync.error || 'échec'}`, 'error');
            return;
        }
    }
    const delRow = await deletePlanningEventRow(canonicalId);
    if (!delRow.ok) {
        showToast(delRow.error || 'Suppression base impossible.', 'error');
        return;
    }
    if (
        rMeDel === 'eleve' &&
        dbTypeDel === 'travail perso' &&
        settingsForVoid &&
        liveRef.start &&
        liveRef.end
    ) {
        const s0 = liveRef.start instanceof Date ? liveRef.start : new Date(liveRef.start);
        const e0 = liveRef.end instanceof Date ? liveRef.end : new Date(liveRef.end);
        await logEleveTravailVoidIfNeeded(settingsForVoid, { slotStart: s0, slotEnd: e0 });
    }
    if (calendar?.getEvents) {
        for (const ev of [...calendar.getEvents()]) {
            if (String(ev.extendedProps?.planningCanonicalId || '').trim() === canonicalId) {
                try {
                    ev.remove();
                } catch {
                    /* */
                }
            }
        }
    } else {
        liveRef.remove();
    }
    invalidateCalendarListCache();
    if (calendar && typeof calendar.refetchEvents === 'function') {
        await calendar.refetchEvents();
        dedupePlanningEventsByCanonicalId(calendar);
    }
    document.getElementById('modal_reservation').close();
    showToast('Créneau supprimé.');
    const meDb = String(currentUser.email).trim().toLowerCase();
    if (oi.ownerEmail && oi.ownerEmail !== meDb && startDel && endDel) {
        notifySlotOwnerAfterThirdPartyEditNonBlocking({
            currentUser,
            action: 'deleted',
            targetOwnerEmail: oi.ownerEmail,
            targetOwnerDisplayName: oi.ownerName,
            targetOwnerUserId: oi.ownerUserId,
            slotTitle: titleDel,
            slotStart: startDel,
            slotEnd: endDel,
            previousStartIso: '',
            previousEndIso: ''
        });
    }
    } finally {
        deleteReservationInFlight = false;
        setReservationModalMutationLock(false);
    }
}

export function canEditEvent(currentUser, event) {
    if (!currentUser?.email || !event) return false;
    return canCurrentUserEditEvent(currentUser, event);
}
