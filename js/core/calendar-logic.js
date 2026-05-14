/**
 * Logique métier du calendrier
 * Rendu des événements, ouverture des modales et CRUD
 */

import { showPersistentToast, showToast } from '../utils/toast.js';
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
    replacePlanningEventEnrollment
} from './planning-events-db.js';
import { fetchOrganSchoolSettings, getOrganSchoolSettingsCached } from './organ-settings.js';
import {
    eleveBookingTooFarInFuture,
    eleveTravailWouldExceedWeeklyCap,
    mondayStartLocal,
    logEleveTravailVoidIfNeeded
} from './planning-eleve-quota.js';
import { openCourseStudentsPicker } from './course-students-picker.js';
import { openCoursSeriesScopeModal } from './cours-series-scope-ui.js';
import { focusPlanningDialogRoot } from '../utils/focus-planning-dialog.js';

let saveReservationInFlight = false;
let deleteReservationInFlight = false;
/** @type {AbortController | null} */
let reservationModalTimeSyncAbort = null;
/** @type {string | null} */
let reservationModalFormBaseline = null;

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
    const bits = [
        val('event-motif-select'),
        val('event-title-input'),
        val('event-date-start'),
        val('event-start'),
        val('event-end'),
        String(chk('event-recurring')),
        val('event-recur-period-start'),
        val('event-recur-period-end'),
        val('event-recur-start'),
        val('event-recur-end'),
        chk('recur-mode-all') ? 'all' : 'days',
        val('reservation-slot-owner-email'),
        ...[1, 2, 3, 4, 5, 6, 0].map((i) => String(chk(`recur-dow-${i}`)))
    ];
    return bits.join('\x1e');
}

/** À appeler après remplissage complet de la modale créneau. */
export function captureReservationModalFormBaseline() {
    reservationModalFormBaseline = snapshotReservationModalFormState();
}

export function isReservationModalDirty() {
    if (reservationModalFormBaseline === null) return false;
    return snapshotReservationModalFormState() !== reservationModalFormBaseline;
}

/** Fermeture modale (bouton Fermer, fond) : false si mutation en cours ou si l’utilisateur refuse d’abandonner. */
export function reservationModalMayCloseNow() {
    if (isReservationMutationInFlight()) return false;
    if (!isReservationModalDirty()) return true;
    return window.confirm('Abandonner les modifications ?');
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
        'btn-cancel-reservation',
        'event-date-start',
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

/** Rechargement grille (RPC Postgres) : invalide le cache mémoire puis refetch FullCalendar. */
export async function refetchPlanningGrid(calendar) {
    invalidateCalendarListCache();
    if (calendar && typeof calendar.refetchEvents === 'function') {
        await calendar.refetchEvents();
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

const MAX_COURS_STUDENTS = 5;
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

function updateReservationInscritsWrapVisibility(currentUser, canEdit) {
    const wrap = document.getElementById('wrap-reservation-inscrits');
    const multi = document.getElementById('event-inscrits-select');
    const sel = document.getElementById('event-motif-select');
    const toggle = document.getElementById('event-inscrits-users-toggle');
    if (!wrap || !multi || !sel) return;
    const show = canManageReservationInscrits(currentUser) && sel.value === 'Cours';
    wrap.classList.toggle('hidden', !show);
    multi.disabled = !canEdit || !show;
    if (toggle instanceof HTMLButtonElement) {
        toggle.disabled = !canEdit || !show;
    }
    // Deux colonnes + glisser-déposer dès que le motif est « Cours » et le créneau est éditable.
    setReservationInscritsEditMode(Boolean(show && canEdit), canEdit);
}

/**
 * @param {boolean} editMode "mode édition" (affiche la liste des non-inscrits)
 * @param {boolean} canEdit "autorisation" (admin/prof + event éditable)
 */
function setReservationInscritsEditMode(editMode, canEdit) {
    const wrap = document.getElementById('wrap-reservation-inscrits');
    const availWrap = document.getElementById('event-inscrits-available-wrap');
    const grid = document.getElementById('event-inscrits-grid');
    const multi = document.getElementById('event-inscrits-select');
    const toggle = document.getElementById('event-inscrits-users-toggle');
    const allowed = Boolean(editMode && canEdit);
    if (!wrap || !availWrap || !grid || !multi) return;
    wrap.dataset.inscritsEditMode = allowed ? '1' : '0';
    availWrap.classList.toggle('hidden', !allowed);
    grid.classList.toggle('grid-cols-2', allowed);
    grid.classList.toggle('grid-cols-1', !allowed);
    if (toggle instanceof HTMLButtonElement) toggle.setAttribute('aria-pressed', allowed ? 'true' : 'false');
    renderReservationInscritsDnD(multi, allowed);
}

function ensureReservationMotifInscritsListener() {
    const sel = document.getElementById('event-motif-select');
    if (!sel || sel.dataset.inscritsMotifBound === '1') return;
    sel.dataset.inscritsMotifBound = '1';
    sel.addEventListener('change', () => {
        updateReservationInscritsWrapVisibility(reservationModalUserRef, reservationModalCanEditRef);
        const multi = document.getElementById('event-inscrits-select');
        // Sécurise le cas "Cours -> Travail perso -> Cours" :
        // on évite de conserver une sélection d’élèves quand le motif n’est plus "Cours".
        const isCours = String(sel.value || '').trim() === 'Cours';
        if (!isCours && multi instanceof HTMLSelectElement) {
            for (const o of multi.options) o.selected = false;
        }
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
    if (toSelected && !opt.selected) {
        const chosenCount = [...multi.options].filter((o) => o.selected).length;
        if (chosenCount >= MAX_COURS_STUDENTS) {
            showToast(`Maximum ${MAX_COURS_STUDENTS} élèves pour un créneau Cours.`, 'error');
            return;
        }
    }
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
    const wrap = document.getElementById('wrap-reservation-inscrits');
    const multi = document.getElementById('event-inscrits-select');
    if (!wrap || !multi) return;
    if (!canManageReservationInscrits(currentUser)) {
        wrap.classList.add('hidden');
        return;
    }
    // Bind UI (icône + fermeture quand on clique ailleurs)
    if (!reservationInscritsUiBound) {
        reservationInscritsUiBound = true;
        const toggle = document.getElementById('event-inscrits-users-toggle');
        toggle?.addEventListener('click', async () => {
            if (!reservationModalCanEditRef) return;
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
                maxStudents: MAX_COURS_STUDENTS,
                eleves: rowsSorted,
                selectedUserIds: selected
            });
            if (!picked) return;
            for (const o of multi.options) {
                o.selected = picked.includes(o.value);
            }
            const wrapR = document.getElementById('wrap-reservation-inscrits');
            renderReservationInscritsDnD(multi, wrapR?.dataset.inscritsEditMode === '1');
        });
    }
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
        const label = `${prenom} ${nom}`.trim() || String(r.display_name || r.email || '').trim();
        const opt = new Option(label, r.user_id);
        opt.dataset.email = String(r.email || '').trim().toLowerCase();
        opt.selected = pre.has(opt.dataset.email);
        multi.add(opt);
    }
    ensureReservationInscritsDropZonesBound();
    updateReservationInscritsWrapVisibility(currentUser, canEdit);
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
    const ownerEmail = String(
        event?.extendedProps?.owner || currentUser?.email || ''
    ).trim().toLowerCase();
    const ownerUserId = String(event?.extendedProps?.ownerUserId ?? '').trim();
    const ownerName =
        String(
            event?.extendedProps?.ownerDisplayName ||
            event?.extendedProps?.ownerName ||
            ''
        ).trim() ||
        (ownerEmail ? ownerEmail.split('@')[0] : 'Inconnu');
    const ownerRoleRaw = normalizeRole(
        event?.extendedProps?.ownerRole || event?.extendedProps?.owner_role || ''
    );
    const ownerRole = ownerRoleRaw || roleFromOwnerEmail(ownerEmail);
    return { ownerEmail, ownerName, ownerRole, ownerUserId };
}

function ownerIdentityLabel(
    owner,
    currentUser = null,
    includeActor = false,
    ownerLabelOverride = '',
    actorLabelOverride = ''
) {
    const name = ownerLabelOverride || owner.ownerName || 'Inconnu';
    const me = String(currentUser?.email || '')
        .trim()
        .toLowerCase();
    if (includeActor && me && owner.ownerEmail && owner.ownerEmail !== me) {
        const actor =
            actorLabelOverride ||
            String(currentUser?.name || '').trim() ||
            me.split('@')[0] ||
            'inconnu';
        return `Réservé par ${name}. Modifié par ${actor}`;
    }
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
    const r = normalizeRole(currentUser?.role);
    if (r === 'eleve') {
        return String(currentUser?.email || '').trim();
    }
    const wrap = document.getElementById('wrap-reservation-owner-target');
    const sel = document.getElementById('reservation-slot-owner-email');
    if (currentEventRef || !wrap || wrap.classList.contains('hidden')) {
        return String(currentEventRef?.extendedProps?.owner || currentUser?.email || '').trim();
    }
    if (sel && sel.value) return String(sel.value).trim();
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
    if (meRole === 'admin') return true;

    const owner = ownerInfoFromEvent(event, currentUser);
    const ownerRole = owner.ownerRole || roleFromOwnerEmail(owner.ownerEmail);
    if (owner.ownerEmail && owner.ownerEmail === String(currentUser.email).trim().toLowerCase()) {
        return true;
    }
    if (meRole === 'prof') {
        return ownerRole === 'eleve' || ownerRole === 'prof';
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
    if (e === 'admin@iams.fr' || e === 'nicolas.marestin@gmail.com') return 'admin';
    if (e.startsWith('prof')) return 'prof';
    if (e.startsWith('eleve') || e.startsWith('élève')) return 'eleve';
    return '';
}

function allowedMotifsForRole(role) {
    const r = normalizeRole(role);
    if (r === 'admin') return [...RESERVATION_MOTIFS];
    if (r === 'prof') return RESERVATION_MOTIFS.filter((m) => m !== 'Fermeture');
    if (r === 'eleve') return ['Travail'];
    return RESERVATION_MOTIFS.filter((m) => m !== 'Fermeture');
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
 * Après déplacement ou redimensionnement : enregistre la plage en Postgres (vérité grille), puis miroir Google.
 * @param {import('@fullcalendar/core').EventApi} calendarEvent
 * @param {import('@fullcalendar/core').Calendar | null} [calendar] — chevauchements (recommandé)
 * @returns {Promise<{ ok: boolean, skipped?: boolean }>}
 */
export async function syncReservationEventToGoogle(calendarEvent, calendar = null) {
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
    const ur = await upsertPlanningEventRow({
        id: canonicalId,
        startIso,
        endIso,
        title,
        dbSlotType,
        ownerEmail: owner,
        ownerUserId: ownerUid
    });
    if (!ur.ok || !ur.id) {
        showToast(ur.error || 'Enregistrement base impossible.', 'error');
        return { ok: false };
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
    void (async () => {
        const token = await getAccessToken();
        if (!token) {
            showToast('Planning enregistré ; session indisponible pour synchroniser l’agenda.', 'error');
            return;
        }
        try {
            const r = await invokeCalendarBridge(token, { action: 'upsert', events: [payload] });
            if (!r.ok && !r.skipped) {
                showToast(
                    `Planning enregistré ; synchronisation agenda : ${r.error || 'échec'}`,
                    'error'
                );
                return;
            }
            if (r.ok && r.data?.results?.[0]) {
                const row = r.data.results[0];
                const ng = String(row.googleEventId || '').trim();
                if (ng) calendarEvent.setExtendedProp('googleEventId', ng);
                const pg = String(row.poolGoogleEventId || '').trim();
                if (pg) calendarEvent.setExtendedProp('poolGoogleEventId', pg);
            }
        } catch (e) {
            console.error(e);
            showToast('Planning enregistré ; synchronisation agenda : erreur.', 'error');
        }
    })();
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

// --- 1. RENDU VISUEL DES CRÉNEAUX ---
export function getEventContent(arg, currentUser) {
    const isMirror = Boolean(arg.isMirror);
    const title = String(arg.event.title || '').trim();
    const start = arg.event.start;
    const end = arg.event.end;

    const durationMs = end - start;
    const durationMin = Math.round(durationMs / (1000 * 60));

    const ownerEmail = String(arg.event.extendedProps?.owner || '')
        .trim()
        .toLowerCase();
    const me = String(currentUser?.email || '')
        .trim()
        .toLowerCase();
    const isMine = Boolean(me && ownerEmail && ownerEmail === me);
    const type = arg.event.extendedProps?.type || 'reservation';

    const inscritsRaw = arg.event.extendedProps?.inscrits;
    const inscritsList = Array.isArray(inscritsRaw)
        ? inscritsRaw.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
        : typeof inscritsRaw === 'string'
          ? String(inscritsRaw)
                .split(/[,;]/)
                .map((x) => x.trim().toLowerCase())
                .filter(Boolean)
          : [];
    const amInscribedInCours = Boolean(me && inscritsList.includes(me));

    let colorClass = 'event-slot-default';
    if (type === 'fermeture') {
        colorClass = 'event-fermeture';
    } else if (type === 'cours' || type === 'maintenance') {
        colorClass = amInscribedInCours || isMine ? 'event-travail-mine' : 'event-cours';
    } else if (type === 'concert') {
        colorClass = 'event-concert';
    } else if (type === 'autre') {
        colorClass = 'event-autre';
    } else if (type === 'reservation') {
        colorClass = isMine ? 'event-travail-mine' : 'event-travail-other';
    } else {
        // Repli : si un type inconnu arrive, l’aligner sur la logique Travail.
        colorClass = isMine ? 'event-travail-mine' : 'event-travail-other';
    }

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
        // Utiliser le libellé horaire calculé par FullCalendar (source affichée sur la grille),
        // pour éviter tout décalage visuel entre position du créneau et bandeau horaire.
        timeLine = timeTextFc.replace(/\s*-\s*/g, ' – ');
    } else {
        timeLine = `${formatTime(start)} – ${formatTime(endDisplay)}`;
    }

    const gw = String(arg.event.extendedProps?.planningGabaritWeekType || '').trim().toUpperCase();
    if (type === 'cours' && (gw === 'A' || gw === 'B')) {
        timeLine = `${timeLine} (${gw})`;
    }

    const showTitleRow = Boolean(title) && (!sameCalendarDay || durationMin > 30);

    const pastReadonly = isReservationNonEditablePast(currentUser, arg.event);

    /* Même contenu pour le miroir FC (drag / redimensionnement) : horaires mis à jour en direct par FC. */
    const mirrorCls = isMirror ? ' event-box--fc-mirror' : '';
    const pastCls = pastReadonly ? ' event-box--past-readonly' : '';
    const aria = isMirror ? ' aria-hidden="true"' : '';

    let innerHTML = `
        <div class="event-box flex flex-col h-full w-full ${colorClass}${mirrorCls}${pastCls}"${aria}>
            <div class="event-time event-time-fc">${timeLine}</div>`;
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

/**
 * Après refetch grille, la modale peut encore référencer le créneau optimiste supprimé (id FC interne ≠ uuid base).
 * Retrouve l’instance affichée pour exclusion au chevauchement et pour l’upsert (planningCanonicalId).
 * @returns {import('@fullcalendar/core').EventApi | null}
 */
function resolveLivePlanningEventRef(calendar, eventRef) {
    if (!eventRef || !calendar?.getEvents) return eventRef;
    const id = eventRef.id != null ? String(eventRef.id).trim() : '';
    if (id && typeof calendar.getEventById === 'function') {
        const byId = calendar.getEventById(id);
        if (byId) return byId;
    }
    const canon = String(eventRef.extendedProps?.planningCanonicalId || '').trim();
    if (canon) {
        for (const ev of calendar.getEvents()) {
            if (String(ev.extendedProps?.planningCanonicalId || '').trim() === canon) return ev;
        }
    }
    const r0 = eventRangeForOverlap(eventRef);
    const owner = String(eventRef.extendedProps?.owner || '').trim().toLowerCase();
    if (!r0 || !owner) return eventRef;
    const s0 = r0.start.getTime();
    const e0 = r0.end.getTime();
    for (const ev of calendar.getEvents()) {
        const o2 = String(ev.extendedProps?.owner || '').trim().toLowerCase();
        if (o2 !== owner) continue;
        const r = eventRangeForOverlap(ev);
        if (!r) continue;
        if (r.start.getTime() === s0 && r.end.getTime() === e0) return ev;
    }
    return eventRef;
}

function isSameFcEvent(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const ca = String(a.extendedProps?.planningCanonicalId || '').trim();
    const cb = String(b.extendedProps?.planningCanonicalId || '').trim();
    if (ca && cb && ca === cb) return true;
    const ga = String(a.extendedProps?.googleEventId || '').trim();
    const gb = String(b.extendedProps?.googleEventId || '').trim();
    if (ga && gb && ga === gb) return true;
    const ida = a.id != null ? String(a.id) : '';
    const idb = b.id != null ? String(b.id) : '';
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
    if (!r) return `Ce créneau chevauche une autre réservation : « ${t} ».`;
    const tf = (d) => formatWeekdayDayTimeFr24(d);
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

    const sync = await syncReservationEventToGoogle(info.event, info.view.calendar);
    if (!sync.ok) {
        info.revert();
        return;
    }

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
}

export function setRecurringOptionsVisible(recurringChecked) {
    document.getElementById('event-recurring-body')?.classList.toggle('hidden', !recurringChecked);
    document.getElementById('wrap-datetime-simple')?.classList.toggle('hidden', !!recurringChecked);
    if (!recurringChecked) {
        document.getElementById('recur-dow-grid')?.classList.add('hidden');
    } else {
        const custom = document.getElementById('recur-mode-days')?.checked;
        document.getElementById('recur-dow-grid')?.classList.toggle('hidden', !custom);
    }
}

function resetRecurringFormDefaults() {
    const all = document.getElementById('recur-mode-all');
    const days = document.getElementById('recur-mode-days');
    if (all) all.checked = true;
    if (days) days.checked = false;
    for (let i = 0; i <= 6; i++) {
        const cb = document.getElementById(`recur-dow-${i}`);
        if (cb) cb.checked = i >= 1 && i <= 5;
    }
    document.getElementById('recur-dow-grid')?.classList.add('hidden');
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
    const sel = document.getElementById('event-motif-select');
    const allowed = allowedMotifsForReservationModal(currentUser, eventRef);
    const fallbackMotif =
        !eventRef && normalizeRole(currentUser?.role) === 'eleve'
            ? 'Cours'
            : defaultMotifForRole(currentUser?.role);
    const v = normalizeMotif(sel?.value || fallbackMotif);
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
    return motifDisplayLabel(motif);
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

function nextExclusiveFreeBoundaryWithExclude(start, calendar, excludeEvent) {
    const limit = slotMaxInstantOnSameDay(start, calendar).getTime();
    let boundary = limit;
    const startMs = start.getTime();
    const resolvedExclude =
        excludeEvent != null ? resolveLivePlanningEventRef(calendar, excludeEvent) : null;
    for (const ev of calendar.getEvents()) {
        if (ev.display === 'background') continue;
        if (resolvedExclude && isSameFcEvent(ev, resolvedExclude)) continue;
        if (resolvedExclude && isSameLogicalEventByOwnerAndRange(ev, resolvedExclude)) continue;
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
        const boundary = nextExclusiveFreeBoundaryWithExclude(t, calendar, eventRef);
        if (boundary.getTime() >= t.getTime() + 30 * 60 * 1000) {
            startChoices.push(formatTimeForSelect(t));
        }
    }
    const preferredStart = startEl.value;
    const selectedStart = setSelectOptions(startEl, startChoices, preferredStart);
    if (!selectedStart) {
        endEl.replaceChildren();
        return;
    }
    const startAt = new Date(`${dateValue}T${selectedStart}:00`);
    const boundary = nextExclusiveFreeBoundaryWithExclude(startAt, calendar, eventRef);
    const endChoices = buildHalfHourChoices(
        new Date(startAt.getTime() + 30 * 60 * 1000),
        new Date(Math.min(boundary.getTime(), dayMax.getTime()))
    );
    const plusOneHour = formatTimeForSelect(new Date(startAt.getTime() + 60 * 60 * 1000));
    const preferredEnd = endChoices.includes(plusOneHour)
        ? plusOneHour
        : endChoices.includes(endEl.value)
          ? endEl.value
          : endChoices[0] || '';
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
    const displayEl = document.getElementById('event-date-display');
    if (!(dateEl instanceof HTMLInputElement) || !(displayEl instanceof HTMLElement)) return;
    const ymd = String(dateEl.value || '').trim();
    displayEl.textContent = ymd ? formatReservationDateLineFr(ymd) : '';
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

/** Remplit motif + titre (règles de rôle + préférence utilisateur). */
export function buildReservationFormFields(currentUser, event) {
    const sel = document.getElementById('event-motif-select');
    const titleInput = document.getElementById('event-title-input');
    if (!sel || !titleInput) return;

    const allowed = allowedMotifsForReservationModal(currentUser, event);
    sel.innerHTML = '';
    for (const lab of allowed) sel.add(new Option(motifDisplayLabel(lab), lab));

    const inferredMotif = event
        ? (() => {
              const dbType = String(event.extendedProps?.planningDbSlotType || '').trim();
              if (dbType === 'cours') return 'Cours';
              if (dbType === 'concert') return 'Concert';
              if (dbType === 'autre') return 'Autre';
              if (dbType === 'fermeture') return 'Fermeture';
              if (dbType === 'travail perso') return 'Travail';
              // Repli si l’événement ne porte pas planningDbSlotType (cas inattendu).
              return slotTypeToMotif(event.extendedProps?.type);
          })()
        : normalizeRole(currentUser?.role) === 'eleve'
          ? 'Cours'
          : defaultMotifForRole(currentUser?.role);
    sel.value = allowed.includes(inferredMotif) ? inferredMotif : allowed[0] || inferredMotif;

    if (event) {
        titleInput.value = String(event.title || '').trim();
    } else {
        const m = sel.value || inferredMotif;
        titleInput.value = motifDisplayLabel(m);
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

/**
 * En-tête modale édition : libellé selon le rôle.
 * @param {string} [createdByLabelOverride] — libellé `planning_profiles_label_for_ids` (créateur)
 * @param {string} [lastModifiedByLabelOverride] — idem (dernier modificateur)
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
    const slotOwnerName = (ownerLabelOverride || owner.ownerName || 'Inconnu').trim();
    const createdId = String(event?.extendedProps?.createdByUserId || '').trim();
    const modifiedId = String(event?.extendedProps?.lastModifiedByUserId || '').trim();

    if (r === 'eleve') {
        if (editorOwnerEl) {
            if (event) {
                const hasActorColumns = Boolean(createdId);
                if (hasActorColumns) {
                    const a = (createdByLabelOverride || '—').trim();
                    let t = `Créé par ${a}.`;
                    if (modifiedId && createdId && modifiedId !== createdId) {
                        const b = (lastModifiedByLabelOverride || '—').trim();
                        t += ` Créneau modifié par ${b}.`;
                    }
                    editorOwnerEl.textContent = t;
                } else {
                    editorOwnerEl.textContent = `Créneau pour ${slotOwnerName}.`;
                }
            } else {
                editorOwnerEl.textContent = reservationDisplayTitleForCurrentUser(currentUser);
            }
            editorOwnerEl.classList.remove('hidden');
        }
        wrapTitle?.classList.add('hidden');
        hintFerm?.classList.add('hidden');
        const nOpt = sel?.options?.length ?? 0;
        if (nOpt <= 1) wrapMotif?.classList.add('hidden');
        else wrapMotif?.classList.remove('hidden');
    } else {
        if (!event && editorOwnerEl) {
            editorOwnerEl.classList.add('hidden');
        } else if (editorOwnerEl) {
            editorOwnerEl.textContent = ownerIdentityLabel(
                owner,
                currentUser,
                true,
                ownerLabelOverride,
                actorLabelOverride
            );
            editorOwnerEl.classList.remove('hidden');
        }
        wrapTitle?.classList.remove('hidden');
        const ownerIsEleve = owner.ownerRole === 'eleve';
        const currentRole = normalizeRole(currentUser?.role);
        if (event && ownerIsEleve && (currentRole === 'admin' || currentRole === 'prof')) {
            wrapMotif?.classList.add('hidden');
        } else {
            wrapMotif?.classList.remove('hidden');
        }
        if (r === 'admin') {
            hintFerm?.classList.remove('hidden');
        } else {
            hintFerm?.classList.add('hidden');
        }
    }
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
 * Après affichage immédiat du créneau : persistance Postgres, miroir Google, refetch ou rollback.
 * @param {import('@fullcalendar/core').EventApi | null} created
 */
async function finalizeQuickReservationInBackground(
    calendar,
    currentUser,
    created,
    rangeStart,
    rangeEnd,
    title,
    motif,
    quickCanonicalId = ''
) {
    try {
        if (!isBackendAuthConfigured()) {
            if (created) created.remove();
            showToast('Connexion requise pour enregistrer.', 'error');
            return;
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
        const liveCanonicalId = String(
            created?.extendedProps?.planningCanonicalId || quickCanonicalId || ''
        ).trim();
        const liveDbSlotType = created
            ? planningDbSlotTypeForEventUpdate(created)
            : motifToPlanningDbSlotType(motif);
        if (!liveStart || !liveEnd || liveEnd.getTime() <= liveStart.getTime()) {
            if (created) created.remove();
            showToast('Plage horaire invalide pour enregistrement.', 'error');
            return;
        }
        const ownerUid = await planningUserIdForEmail(currentUser.email);
        if (!ownerUid) {
            if (created) created.remove();
            showToast('Compte indisponible pour enregistrer.', 'error');
            return;
        }
        if (normalizeRole(currentUser.role) === 'eleve' && liveDbSlotType === 'travail perso') {
            await fetchOrganSchoolSettings();
            const setQ = getOrganSchoolSettingsCached();
            if (eleveBookingTooFarInFuture(setQ, liveStart)) {
                if (created) created.remove();
                showToast('Cette plage dépasse la fenêtre de réservation autorisée pour les élèves.', 'error');
                return;
            }
            const addMin = Math.max(1, Math.round((liveEnd.getTime() - liveStart.getTime()) / 60000));
            const cap = await eleveTravailWouldExceedWeeklyCap(
                setQ,
                addMin,
                mondayStartLocal(liveStart),
                liveCanonicalId || null
            );
            if (!cap.ok) {
                if (created) created.remove();
                showToast(cap.message || 'Quota hebdomadaire dépassé.', 'error');
                return;
            }
        }
        const bridgeType = planningDbSlotTypeToBridgeType(liveDbSlotType);
        const ur = await upsertPlanningEventRow({
            id: liveCanonicalId || null,
            startIso: liveStart.toISOString(),
            endIso: liveEnd.toISOString(),
            title: liveTitle,
            dbSlotType: liveDbSlotType,
            ownerEmail: currentUser.email,
            ownerUserId: ownerUid
        });
        if (!ur.ok || !ur.id) {
            if (created) created.remove();
            showToast(ur.error || 'Enregistrement impossible.', 'error');
            return;
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
                if (created) created.remove();
                showToast(enrQ.error || 'Inscriptions impossibles.', 'error');
                return;
            }
        } else {
            await replacePlanningEventEnrollment(ur.id, []);
        }
        const syncDb = await trySyncGoogleCalendar([
            {
                planningEventId: ur.id,
                title: liveTitle,
                start: liveStart.toISOString(),
                end: liveEnd.toISOString(),
                type: bridgeType,
                owner: currentUser.email,
                ...(quickInscritsCsv ? { inscrits: quickInscritsCsv } : {})
            }
        ]);
        if (calendarBridgeWanted() && !syncDb.ok && !syncDb.skipped) {
            if (created) created.remove();
            showToast(`Synchronisation agenda : ${syncDb.error || 'échec'}`, 'error');
            return;
        }
        if (created && typeof created.setExtendedProp === 'function') {
            created.setExtendedProp('planningCanonicalId', ur.id);
            created.setExtendedProp('planningDbSlotType', liveDbSlotType);
            created.setExtendedProp('planningRowSource', 'supabase');
        }
        if (created) created.remove();
        await refetchPlanningGrid(calendar);
    } catch (e) {
        console.error(e);
        if (created) created.remove();
        showToast('L’enregistrement a échoué. Réessayez.', 'error');
    }
}

/**
 * Affiche tout de suite le créneau + toast ; persistance et contrôles Google en arrière-plan (rollback si échec).
 * @param {Date} rangeStart
 * @param {Date} rangeEnd
 */
function commitQuickReservation(calendar, currentUser, rangeStart, rangeEnd, title, motif) {
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
                planningCanonicalId: quickCanonicalId,
                owner: currentUser.email,
                ownerDisplayName: currentUser.name || currentUser.email.split('@')[0],
                ownerRole: normalizeRole(currentUser.role) || 'eleve',
                type: motifToSlotType(motif)
            },
            ...fcDragResizePropsForEventStart(rangeStart, currentUser)
        });
    };

    if (typeof calendar.batchRendering === 'function') {
        calendar.batchRendering(add);
    } else {
        add();
    }
    showToast('Créneau enregistré.');
    void finalizeQuickReservationInBackground(
        calendar,
        currentUser,
        created,
        rangeStart,
        rangeEnd,
        title,
        motif,
        quickCanonicalId
    );
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
        if (selMs <= snapMs + 1000) {
            const prop = proposeReservationRangeFromAnchor(rangeStart, calendar);
            rangeStart = prop.start;
            rangeEnd = prop.end;
            if (rangeEnd.getTime() <= rangeStart.getTime()) {
                showToast('Plage insuffisante : créneau déjà occupé ou fin de journée.', 'error');
                calendar.unselect();
                return;
            }
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

/**
 * Clic simple sur la grille (semaine / jour) : créneau 1 h ou 30 min si occupé plus tard, sans modale.
 */
export async function quickCreateFromDateClick(calendar, clickDate, currentUser, viewType, allDayFlag) {
    if (!currentUser?.email) {
        showToast('Connectez-vous pour réserver.', 'error');
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

    const { start, end } = proposeReservationRangeFromAnchor(anchor, calendar);
    if (end.getTime() <= start.getTime()) {
        showToast('Plage insuffisante : créneau déjà occupé ou fin de journée.', 'error');
        return;
    }

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
    const modal = document.getElementById('modal_reservation');
    if (!modal) return;
    const isPastSlot = Boolean(event && isReservationNonEditablePast(currentUser, event));
    const meRoleOpen = normalizeRole(currentUser?.role);
    const canEditEvent = !event || canCurrentUserEditEvent(currentUser, event);
    reservationModalUserRef = currentUser;
    reservationModalCanEditRef = canEditEvent;
    const owner = ownerInfoFromEvent(event, currentUser);
    let ownerLabelOverride = '';
    let actorLabelOverride = '';
    let createdByLabelOverride = '';
    let lastModifiedByLabelOverride = '';
    if (event) {
        const cId = String(event.extendedProps?.createdByUserId || '').trim();
        const mId = String(event.extendedProps?.lastModifiedByUserId || '').trim();
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
    }

    const ownerText = ownerIdentityLabel(owner, currentUser, false, ownerLabelOverride);

    const wrapRead = document.getElementById('wrap-reservation-readonly');
    const wrapEdit = document.getElementById('wrap-reservation-editor');
    const modalActions = document.querySelector('#modal_reservation .modal-action');
    const pastHint = document.getElementById('event-readonly-past-hint');
    if (pastHint) pastHint.classList.add('hidden');

    if (wrapRead && wrapEdit) {
        wrapRead.classList.add('hidden');
        wrapEdit.classList.remove('hidden');
    }
    modalActions?.classList.remove('justify-end');
    modalActions?.classList.add('justify-between');

    buildReservationFormFields(currentUser, event || null);
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
    setSelectTime(startEl, startInstant);
    setSelectTime(endEl, endInstant);
    syncReservationDateWeekdayLabel();
    if (calendarForClip?.getEvents) {
        syncReservationModalTimeOptions(calendarForClip, event || null);
        dateEl?.addEventListener(
            'change',
            () => {
                syncReservationDateWeekdayLabel();
                syncReservationModalTimeOptions(calendarForClip, event || null);
            },
            { signal: modalSignal }
        );
        startEl?.addEventListener(
            'change',
            () => syncReservationModalTimeOptions(calendarForClip, event || null),
            { signal: modalSignal }
        );
    } else {
        dateEl?.addEventListener('change', () => syncReservationDateWeekdayLabel(), { signal: modalSignal });
    }

    const rpStart = document.getElementById('event-recur-period-start');
    const rpEnd = document.getElementById('event-recur-period-end');
    if (rpStart && rpEnd) {
        rpStart.value = dateStartVal;
        rpEnd.value = dateStartVal;
    }
    const rsEl = document.getElementById('event-recur-start');
    const reEl = document.getElementById('event-recur-end');
    if (rsEl && reEl) {
        setSelectTime(rsEl, startInstant);
        setSelectTime(reEl, endInstant);
    }

    const recurWrap = document.getElementById('event-recurring-wrap');
    const recurCb = document.getElementById('event-recurring');
    /** Réservation sur plusieurs jours : création, admin / prof uniquement. */
    const showRecurring = isPrivilegedUser(currentUser) && !event;
    if (recurWrap) {
        if (showRecurring) {
            recurWrap.classList.remove('hidden');
            recurWrap.removeAttribute('aria-hidden');
        } else {
            recurWrap.classList.add('hidden');
            recurWrap.setAttribute('aria-hidden', 'true');
        }
    }
    if (recurCb) {
        if (!showRecurring) {
            recurCb.checked = false;
            recurCb.disabled = true;
        } else {
            recurCb.disabled = false;
            recurCb.checked = false;
            resetRecurringFormDefaults();
        }
    }
    setRecurringOptionsVisible(!!recurCb?.checked && showRecurring);

    // Sécurité : Verrouillage si le créneau appartient à quelqu'un d'autre
    const fields = [
        'event-motif-select',
        'event-title-input',
        'event-date-start',
        'event-start',
        'event-end',
        'event-recurring',
        'event-recur-period-start',
        'event-recur-period-end',
        'event-recur-start',
        'event-recur-end',
        'recur-mode-all',
        'recur-mode-days',
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

    document.getElementById('btn-save').classList.toggle('hidden', !canEditEvent);
    const showDelete =
        Boolean(event) &&
        canCurrentUserEditEventIgnoringPast(currentUser, event) &&
        (!isPastSlot || meRoleOpen === 'admin' || meRoleOpen === 'prof');
    document.getElementById('btn-delete').classList.toggle('hidden', !showDelete);

    await prepareReservationOwnerSelect(currentUser, event || null, canEditEvent);
    await prepareReservationInscritsSelect(currentUser, event || null, canEditEvent);

    captureReservationModalFormBaseline();

    modal.showModal();
    focusPlanningDialogRoot(modal instanceof HTMLDialogElement ? modal : null);
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
            return true;
        }
    }

    const enrollSync = await syncPlanningEnrollmentAfterSave(canonicalExisting, 'cours');
    if (!enrollSync.ok) {
        showToast(enrollSync.error || 'Enregistrement des inscriptions impossible.', 'error');
        return true;
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

    document.getElementById('modal_reservation').close();
    const n = siblings.length;
    showToast(n > 1 ? `${n} cours mis à jour (série gabarit).` : 'Cours mis à jour.');

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
export async function saveReservation(calendar, currentUser, currentEventRef) {
    if (!currentUser || !currentUser.email) {
        showToast('Veuillez vous connecter pour enregistrer une réservation.', 'error');
        return;
    }
    const liveEventRef = currentEventRef
        ? resolveLivePlanningEventRef(calendar, currentEventRef)
        : null;
    if (liveEventRef && isReservationNonEditablePast(currentUser, liveEventRef)) {
        showToast('Les créneaux passés ne sont pas modifiables.', 'error');
        return;
    }

    if (saveReservationInFlight) return;
    if (deleteReservationInFlight) return;
    saveReservationInFlight = true;
    const saveBtn = document.getElementById('btn-save');
    setReservationModalMutationLock(true);
    if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = true;

    try {
    if (!isBackendAuthConfigured()) {
        showToast('Connexion requise pour enregistrer.', 'error');
        return;
    }
    const motif = getReservationMotifFromForm(currentUser, liveEventRef);
    const title = getReservationTextTitleFromForm(currentUser, motif);
    const slotOwnerEmail = getReservationSlotOwnerEmail(currentUser, liveEventRef);
    const slotType = motifToSlotType(motif);
    const recurOn =
        isPrivilegedUser(currentUser) &&
        document.getElementById('event-recurring')?.checked &&
        !liveEventRef;

    if (recurOn) {
        const periodStart = document.getElementById('event-recur-period-start')?.value;
        const periodEnd = document.getElementById('event-recur-period-end')?.value;
        const tRecStart = document.getElementById('event-recur-start')?.value;
        const tRecEnd = document.getElementById('event-recur-end')?.value;
        if (!periodStart || !periodEnd) {
            showToast('Indiquez le jour de début et le jour de fin de la période.', 'error');
            return;
        }
        if (periodStart > periodEnd) {
            showToast('Le jour de fin de période doit être le même jour ou après le jour de début.', 'error');
            return;
        }
        if (!tRecStart || !tRecEnd) {
            showToast('Indiquez la plage horaire (de … à …).', 'error');
            return;
        }
        if (clockMinutes(tRecEnd) <= clockMinutes(tRecStart)) {
            showToast(
                'Pour une récurrence, l’heure de fin doit être le même jour après l’heure de début (pas de passage après minuit).',
                'error'
            );
            return;
        }
        const allPeriod = document.getElementById('recur-mode-all')?.checked;
        const pattern = allPeriod ? 'all' : 'custom';
        let dowSet = null;
        if (!allPeriod) {
            dowSet = selectedDowSet();
            if (dowSet.size === 0) {
                showToast('Cochez au moins un jour de la semaine.', 'error');
                return;
            }
        }
        const days = enumerateRecurringDays(periodStart, periodEnd, pattern, dowSet);
        if (days.length === 0) {
            showToast('Aucun jour ne correspond aux choix sur cette période.', 'error');
            return;
        }
        for (const d of days) {
            const sStr = `${d}T${tRecStart}:00`;
            const eStr = `${d}T${tRecEnd}:00`;
            const c = findOverlappingCalendarEvent(calendar, new Date(sStr), new Date(eStr), null);
            if (c) {
                showToast(overlapToastMessage(c), 'error');
                return;
            }
        }
        const ownerUid = await planningUserIdForEmail(slotOwnerEmail || currentUser.email);
        if (!ownerUid) {
            showToast('Impossible de résoudre le compte du propriétaire du créneau.', 'error');
            return;
        }
        const dbSlotType = motifToPlanningDbSlotType(motif);
        if (dbSlotType === 'cours' && getReservationInscritsSelection().userIds.length === 0) {
            showToast('Pour un cours, sélectionnez au moins un élève inscrit.', 'error');
            return;
        }
        const bridgeType = planningDbSlotTypeToBridgeType(dbSlotType);
        /** @type {Record<string, unknown>[]} */
        const bridgeEventsDb = [];
        for (const d of days) {
            const startIso = new Date(`${d}T${tRecStart}:00`).toISOString();
            const endIso = new Date(`${d}T${tRecEnd}:00`).toISOString();
            const ur = await upsertPlanningEventRow({
                id: null,
                startIso,
                endIso,
                title,
                dbSlotType,
                ownerEmail: slotOwnerEmail || currentUser.email,
                ownerUserId: ownerUid
            });
            if (!ur.ok || !ur.id) {
                showToast(ur.error || 'Enregistrement base impossible.', 'error');
                return;
            }
            const enrollR = await syncPlanningEnrollmentAfterSave(ur.id, dbSlotType);
            if (!enrollR.ok) {
                showToast(enrollR.error || 'Enregistrement des inscriptions impossible.', 'error');
                return;
            }
            bridgeEventsDb.push({
                planningEventId: ur.id,
                title,
                start: startIso,
                end: endIso,
                type: bridgeType,
                owner: slotOwnerEmail || currentUser.email,
                ...(enrollR.emailsCsv ? { inscrits: enrollR.emailsCsv } : {})
            });
        }
        document.getElementById('modal_reservation').close();
        showToast(`${days.length} créneau${days.length > 1 ? 'x' : ''} enregistré${days.length > 1 ? 's' : ''}.`);
        document.getElementById('event-recurring').checked = false;
        resetRecurringFormDefaults();
        setRecurringOptionsVisible(false);
        void (async () => {
            try {
                const syncMultiDb = await trySyncGoogleCalendar(bridgeEventsDb);
                if (calendarBridgeWanted() && !syncMultiDb.ok && !syncMultiDb.skipped) {
                    showToast(`Synchronisation agenda : ${syncMultiDb.error || 'échec'}`, 'error');
                }
            } catch (e) {
                console.error(e);
                showToast('Synchronisation agenda : erreur.', 'error');
            }
            try {
                await refetchPlanningGrid(calendar);
            } catch (e) {
                console.error(e);
            }
        })();
        return;
    }

    const dateStart = document.getElementById('event-date-start').value;
    const tStart = document.getElementById('event-start').value;
    const tEnd = document.getElementById('event-end').value;

    if (!dateStart || !tStart || !tEnd) {
        showToast('Veuillez renseigner le jour et les heures de début et de fin.', 'error');
        return;
    }

    const startStr = `${dateStart}T${tStart}:00`;
    const endStr = `${dateStart}T${tEnd}:00`;

    const startMs = new Date(startStr).getTime();
    const endMs = new Date(endStr).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
        showToast('La date et heure de fin doivent être après le début.', 'error');
        return;
    }

    const conflictSingle = findOverlappingCalendarEvent(
        calendar,
        new Date(startStr),
        new Date(endStr),
        liveEventRef
    );
    if (conflictSingle) {
        showToast(overlapToastMessage(conflictSingle), 'error');
        return;
    }

    if (liveEventRef && isReservationNonEditablePast(currentUser, { start: new Date(startStr) })) {
        showToast('Impossible d’enregistrer un créneau dans le passé.', 'error');
        return;
    }

    /** @type {{ title: string, startStr: string, endStr: string, type: string } | null} */
    let prevSnapshot = null;
    if (liveEventRef) {
        prevSnapshot = {
            title: String(liveEventRef.title || '').trim(),
            startStr: liveEventRef.start ? new Date(liveEventRef.start).toISOString() : '',
            endStr: liveEventRef.end ? new Date(liveEventRef.end).toISOString() : '',
            type: liveEventRef.extendedProps?.type || 'reservation'
        };
    }

    const ownerForBridge = slotOwnerEmail || String(currentUser.email || '').trim();
    const gid = liveEventRef ? bridgeGoogleIdFromFcEvent(liveEventRef) : '';
    const poolLinkExisting = String(liveEventRef?.extendedProps?.poolGoogleEventId ?? '').trim();

    const ownerUid = await planningUserIdForEmail(slotOwnerEmail || currentUser.email);
    if (!ownerUid) {
        showToast('Impossible de résoudre le compte du propriétaire du créneau.', 'error');
        return;
    }
    const dbSlotType = motifToPlanningDbSlotType(motif);
    if (dbSlotType === 'cours' && getReservationInscritsSelection().userIds.length === 0) {
        showToast('Pour un cours, sélectionnez au moins un élève inscrit.', 'error');
        return;
    }
    const rEleveChk = normalizeRole(currentUser?.role);
    if (rEleveChk === 'eleve' && dbSlotType === 'travail perso') {
        await fetchOrganSchoolSettings();
        const setQ = getOrganSchoolSettingsCached();
        if (eleveBookingTooFarInFuture(setQ, new Date(startStr))) {
            showToast('Cette date dépasse la fenêtre de réservation autorisée pour les élèves.', 'error');
            return;
        }
        const addMin = Math.max(1, Math.round((endMs - startMs) / 60000));
        const wMon = mondayStartLocal(new Date(startStr));
        const cap = await eleveTravailWouldExceedWeeklyCap(
            setQ,
            addMin,
            wMon,
            liveEventRef
                ? String(liveEventRef.extendedProps?.planningCanonicalId || '').trim() || null
                : null
        );
        if (!cap.ok) {
            showToast(cap.message || 'Quota hebdomadaire dépassé.', 'error');
            return;
        }
    }
    const bridgeType = planningDbSlotTypeToBridgeType(dbSlotType);
    const startIso = new Date(startStr).toISOString();
    const endIso = new Date(endStr).toISOString();
    const canonicalExisting = liveEventRef
        ? String(liveEventRef.extendedProps?.planningCanonicalId || '').trim()
        : '';

    const tplLineId =
        liveEventRef && canonicalExisting
            ? String(liveEventRef.extendedProps?.planningSourceTemplateLineId || '').trim()
            : '';
    const titleTrimForSeries = String(title || '').trim();
    const prevTitleForSeries = prevSnapshot ? String(prevSnapshot.title || '').trim() : '';
    const timeOrTitleChangedForSeries =
        Boolean(prevSnapshot) &&
        (prevTitleForSeries !== titleTrimForSeries ||
            prevSnapshot.startStr !== startIso ||
            prevSnapshot.endStr !== endIso);

    if (
        liveEventRef &&
        canonicalExisting &&
        dbSlotType === 'cours' &&
        tplLineId &&
        isPrivilegedUser(currentUser) &&
        timeOrTitleChangedForSeries
    ) {
        const scope = await openCoursSeriesScopeModal();
        if (scope === null) return;
        if (scope === 'future') {
            const seriesDone = await applyCoursTemplateLineSeriesIfNeeded({
                calendar,
                currentUser,
                liveEventRef,
                canonicalExisting,
                ownerUid,
                slotOwnerEmail: slotOwnerEmail || currentUser.email,
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
            if (seriesDone) return;
        }
    }

    const ur = await upsertPlanningEventRow({
        id: canonicalExisting || null,
        startIso,
        endIso,
        title,
        dbSlotType,
        ownerEmail: slotOwnerEmail || currentUser.email,
        ownerUserId: ownerUid
    });
    if (!ur.ok || !ur.id) {
        showToast(ur.error || 'Enregistrement base impossible.', 'error');
        return;
    }
    const enrollSync = await syncPlanningEnrollmentAfterSave(ur.id, dbSlotType);
    if (!enrollSync.ok) {
        showToast(enrollSync.error || 'Enregistrement des inscriptions impossible.', 'error');
        return;
    }
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
    document.getElementById('modal_reservation').close();
    /** @type {ReturnType<typeof showPersistentToast> | null} */
    let updateProgressToast = null;
    if (liveEventRef) {
        updateProgressToast = showPersistentToast('Mise à jour…', 'info');
    } else {
        showToast('Réservation enregistrée.');
    }
    if (liveEventRef) {
        const localInscritsEmails =
            dbSlotType === 'cours'
                ? getReservationInscritsSelection()
                      .emailsCsv.split(',')
                      .map((x) => String(x).trim())
                      .filter(Boolean)
                : [];
        try {
            if (typeof liveEventRef.setDates === 'function') {
                liveEventRef.setDates(new Date(startStr), new Date(endStr));
            }
        } catch (e) {
            console.warn('[calendar-logic] setDates après sauvegarde modale', e);
        }
        if (typeof liveEventRef.setProp === 'function') {
            liveEventRef.setProp('title', title);
        }
        if (typeof liveEventRef.setExtendedProp === 'function') {
            liveEventRef.setExtendedProp('type', slotType);
            liveEventRef.setExtendedProp('planningDbSlotType', dbSlotType);
            liveEventRef.setExtendedProp('inscrits', localInscritsEmails);
        }
    }
    const oiBeforeRefetch =
        liveEventRef && prevSnapshot ? ownerInfoFromEvent(liveEventRef, currentUser) : null;
    if (prevSnapshot && oiBeforeRefetch) {
        const changed =
            prevSnapshot.title !== title ||
            prevSnapshot.startStr !== startIso ||
            prevSnapshot.endStr !== endIso ||
            prevSnapshot.type !== slotType;
        const actor = String(currentUser.email).trim().toLowerCase();
        const ownerLower = String(ownerForBridge || '').trim().toLowerCase();
        if (changed && ownerLower && ownerLower !== actor) {
            notifySlotOwnerAfterThirdPartyEditNonBlocking({
                currentUser,
                action: 'modified',
                targetOwnerEmail: oiBeforeRefetch.ownerEmail,
                targetOwnerDisplayName: oiBeforeRefetch.ownerName,
                targetOwnerUserId: oiBeforeRefetch.ownerUserId,
                slotTitle: title,
                slotStart: startIso,
                slotEnd: endIso,
                previousStartIso: prevSnapshot.startStr,
                previousEndIso: prevSnapshot.endStr
            });
        }
    }
    void (async () => {
        try {
            const syncSingleDb = await trySyncGoogleCalendar([payloadDb]);
            if (calendarBridgeWanted() && !syncSingleDb.ok && !syncSingleDb.skipped) {
                showToast(`Synchronisation agenda : ${syncSingleDb.error || 'échec'}`, 'error');
            }
        } catch (e) {
            console.error(e);
            showToast('Synchronisation agenda : erreur.', 'error');
        }
        try {
            await refetchPlanningGrid(calendar);
        } catch (e) {
            console.error(e);
        } finally {
            updateProgressToast?.finish('Réservation mise à jour.', 'success');
        }
    })();
    } finally {
        saveReservationInFlight = false;
        setReservationModalMutationLock(false);
        if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = false;
    }
}

export async function deleteReservation(calendar, currentEventRef, currentUser) {
    if (deleteReservationInFlight || saveReservationInFlight) return;
    if (!currentEventRef || !confirm('Supprimer cette réservation ?')) return;
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
    const tokenDb = await getAccessToken();
    const targets = await fetchPlanningMirrorTargetsForDelete(canonicalId);
    if (tokenDb && targets.length > 0) {
        for (const t of targets) {
            const rDel = await bridgeDeleteEvent(tokenDb, t.googleEventId, t.calendarId);
            if (!rDel.ok && !rDel.skipped) {
                showToast(`Suppression agenda : ${rDel.error || 'échec'}`, 'error');
                return;
            }
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
    liveRef.remove();
    invalidateCalendarListCache();
    if (calendar && typeof calendar.refetchEvents === 'function') {
        await calendar.refetchEvents();
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
