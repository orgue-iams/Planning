/**
 * Logique métier du calendrier
 * Rendu des événements, ouverture des modales et CRUD
 */

import { showToast } from '../utils/toast.js';
import { getAccessToken, isBackendAuthConfigured, isPrivilegedUser } from './auth-logic.js';
import { invokeCalendarBridge } from './calendar-bridge.js';
import { invalidateCalendarListCache } from './calendar-events-list-cache.js';
import { getPlanningConfig, getSupabaseClient } from './supabase-client.js';
import { invokeSlotNotify } from './slot-notify-api.js';
import { getDefaultReservationTitle, getProfile } from '../utils/user-profile.js';
import { isPlanningRole } from './planning-roles.js';
import {
    RESERVATION_MOTIFS,
    normalizeMotif,
    motifToSlotType,
    motifDisplayLabel,
    motifToPlanningDbSlotType
} from './reservation-motifs.js';
import {
    planningGridUsesSupabaseDb,
    planningDbSlotTypeToBridgeType,
    upsertPlanningEventRow,
    deletePlanningEventRow,
    fetchPlanningMirrorTargetsForDelete,
    planningUserIdForEmail
} from './planning-events-db.js';

let saveReservationInFlight = false;

/** Rechargement grille depuis Google : invalide le cache mémoire des `list` pour éviter des données périmées. */
export async function refetchCalendarEventsFromGoogle(calendar) {
    invalidateCalendarListCache();
    if (calendar && typeof calendar.refetchEvents === 'function') {
        await calendar.refetchEvents();
    }
}

/** @param {string | undefined} userId */
async function fetchPoolCalendarIdForUser(userId) {
    const uid = String(userId ?? '').trim();
    if (!uid) return '';
    const sb = getSupabaseClient();
    if (!sb) return '';
    const { data, error } = await sb.rpc('planning_pool_calendar_id', { p_user_id: uid });
    if (error) {
        console.warn('[Planning] planning_pool_calendar_id :', error.message);
        return '';
    }
    return String(data ?? '').trim();
}

function calendarBridgeWanted() {
    const { calendarBridgeUrl } = getPlanningConfig();
    return Boolean(calendarBridgeUrl) && isBackendAuthConfigured();
}

/** Contrôle de conflit via liste Google : pertinent seulement si la grille ne lit pas la base. */
function googleAgendaConflictCheckWanted() {
    return calendarBridgeWanted() && !planningGridUsesSupabaseDb();
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

/** @param {import('@fullcalendar/core').EventApi | null} event */
export function ownerInfoFromEvent(event, currentUser) {
    const ownerEmail = String(
        event?.extendedProps?.owner || currentUser?.email || ''
    ).trim().toLowerCase();
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
    return { ownerEmail, ownerName, ownerRole };
}

function ownerIdentityLabel(owner) {
    const name = owner.ownerName || 'Inconnu';
    return `Réservé par ${name}`;
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

    if (r === 'eleve' || r === 'consultation') {
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
    if (r === 'eleve' || r === 'consultation') {
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

function getReservationSlotOwnerDisplayNameForSave(slotOwnerEmail) {
    const em = String(slotOwnerEmail || '').trim();
    const sel = document.getElementById('reservation-slot-owner-email');
    if (sel) {
        for (let i = 0; i < sel.options.length; i++) {
            if (sel.options[i].value === em) {
                const t = String(sel.options[i].textContent || '');
                const ix = t.indexOf(' · ');
                if (ix > 0) return t.slice(0, ix).trim();
                return em.includes('@') ? em.split('@')[0] : em;
            }
        }
    }
    return em.includes('@') ? em.split('@')[0] : em;
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
    if (isReservationStartBeforeTodayLocal({ start })) {
        return { editable: false, startEditable: false, durationEditable: false };
    }
    if (!eventLike || !canCurrentUserEditEventIgnoringPast(currentUser, eventLike)) {
        return { editable: false, startEditable: false, durationEditable: false };
    }
    const touch =
        typeof window !== 'undefined' &&
        ('ontouchstart' in window || navigator.maxTouchPoints > 0);
    return { editable: true, startEditable: true, durationEditable: !touch };
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
    if (meRole === 'consultation') return false;
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
    if (isReservationStartBeforeTodayLocal(event)) return false;
    return canCurrentUserEditEventIgnoringPast(currentUser, event);
}

function roleFromOwnerEmail(email) {
    const e = String(email || '').toLowerCase();
    if (!e) return '';
    if (e === 'admin@iams.fr' || e === 'nicolas.marestin@gmail.com') return 'admin';
    if (e.startsWith('prof')) return 'prof';
    if (e.startsWith('eleve') || e.startsWith('élève')) return 'eleve';
    if (e.startsWith('consultation')) return 'consultation';
    return '';
}

function allowedMotifsForRole(role) {
    const r = normalizeRole(role);
    if (r === 'admin') return [...RESERVATION_MOTIFS];
    return RESERVATION_MOTIFS.filter((m) => m !== 'Fermeture');
}

/**
 * Modale : élève qui réserve un cours n’a pas « Travail » (résa perso = grille rapide).
 * Édition d’un créneau perso : Travail perso. + Cours ; créneau cours : Cours seul.
 * Fermeture : liste réservée aux administrateurs.
 * @param {import('@fullcalendar/core').EventApi | null} event
 */
function allowedMotifsForReservationModal(currentUser, event) {
    const base = allowedMotifsForRole(currentUser?.role);
    if (normalizeRole(currentUser?.role) !== 'eleve') return base;
    if (!event) return ['Cours'];
    const t = String(event.extendedProps?.type ?? '').toLowerCase();
    if (t === 'cours' || t === 'maintenance') return ['Cours'];
    return base;
}

function defaultMotifForRole(role) {
    const r = normalizeRole(role);
    if (r === 'prof') return 'Cours';
    return 'Travail';
}

function slotTypeToMotif(slotType) {
    const s = String(slotType || '').trim().toLowerCase();
    if (s === 'fermeture') return 'Fermeture';
    if (s === 'cours' || s === 'maintenance') return 'Cours';
    return 'Travail';
}

/** @param {import('@fullcalendar/core').EventApi[]} localEvents */
function applyBridgeUpsertResults(localEvents, results) {
    if (!Array.isArray(results) || !Array.isArray(localEvents)) return;
    const n = Math.min(results.length, localEvents.length);
    for (let i = 0; i < n; i++) {
        const gid = results[i]?.googleEventId;
        if (!gid) continue;
        const ev = localEvents[i];
        ev.setProp('id', String(gid));
        ev.setExtendedProp('googleEventId', String(gid));
    }
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
 * Après déplacement ou redimensionnement local : pousse la plage vers Google.
 * @returns {Promise<{ ok: boolean, skipped?: boolean }>}
 */
export async function syncReservationEventToGoogle(calendarEvent) {
    if (!calendarEvent || !isBackendAuthConfigured()) {
        return { ok: false, skipped: true };
    }
    const fromDb = String(calendarEvent.extendedProps?.planningRowSource || '') === 'supabase';
    const dbGrid = planningGridUsesSupabaseDb();
    if (fromDb && !dbGrid) return { ok: true, skipped: true };
    if (!fromDb && dbGrid) return { ok: true, skipped: true };

    const token = await getAccessToken();
    if (!token) return { ok: false };
    const start = calendarEvent.start;
    const end = calendarEvent.end;
    if (!start || !end) return { ok: false };
    const owner = String(calendarEvent.extendedProps?.owner || '').trim();
    const type = calendarEvent.extendedProps?.type || 'reservation';
    const gid = bridgeGoogleIdFromFcEvent(calendarEvent);
    const title = String(calendarEvent.title || '').trim() || 'Créneau';
    const poolLink = String(calendarEvent.extendedProps?.poolGoogleEventId ?? '').trim();
    const canonicalId = String(calendarEvent.extendedProps?.planningCanonicalId || '').trim();
    if (fromDb && !canonicalId) {
        showToast('Créneau sans identifiant base : synchronisation impossible.', 'error');
        return { ok: false };
    }
    const payload = {
        ...(fromDb && canonicalId ? { planningEventId: canonicalId } : {}),
        ...(gid ? { googleEventId: gid } : {}),
        title,
        start: start.toISOString(),
        end: end.toISOString(),
        type,
        owner,
        ...(poolLink ? { poolGoogleEventId: poolLink } : {})
    };
    const r = await invokeCalendarBridge(token, { action: 'upsert', events: [payload] });
    if (!r.ok && !r.skipped) {
        showToast(`Synchronisation agenda : ${r.error || 'échec'}`, 'error');
        return { ok: false };
    }
    if (r.ok && r.data?.results?.[0]?.googleEventId && !gid) {
        const ng = String(r.data.results[0].googleEventId).trim();
        if (fromDb) {
            calendarEvent.setExtendedProp('googleEventId', ng);
            const pg = String(r.data.results[0].poolGoogleEventId || '').trim();
            if (pg) calendarEvent.setExtendedProp('poolGoogleEventId', pg);
        } else {
            calendarEvent.setProp('id', ng);
            calendarEvent.setExtendedProp('googleEventId', ng);
        }
    }
    return { ok: true, skipped: Boolean(r.skipped) };
}

/**
 * E-mail au propriétaire du créneau si un autre utilisateur vient d’agir ; toast pour l’acteur.
 * @param {'deleted'|'moved'|'modified'} action
 */
export async function maybeNotifySlotOwnerAfterThirdPartyEdit({
    currentUser,
    action,
    targetOwnerEmail,
    targetOwnerDisplayName,
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

    const r = await invokeSlotNotify({
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

    const label = String(targetOwnerDisplayName ?? '').trim() || owner;
    if (r.skipped) return;
    if (r.emailSent) {
        showToast(`Un e-mail a été envoyé à ${label} pour l’informer du changement.`, 'success');
    } else {
        showToast(
            `L’e-mail n’a pas pu être envoyé à ${label}. Merci de le ou la prévenir directement.`,
            'error'
        );
    }
}

// --- 1. RENDU VISUEL DES CRÉNEAUX ---
export function getEventContent(arg, currentUser) {
    const isMirror = Boolean(arg.isMirror);
    const title = String(arg.event.title || '').trim() || 'Occupation';
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

    let colorClass = 'event-slot-default';
    if (type === 'fermeture') {
        colorClass = 'event-fermeture';
    } else if (type === 'cours' || type === 'maintenance') {
        colorClass = 'event-cours';
    } else {
        colorClass = isMine ? 'event-travail-mine' : 'event-travail-other';
    }

    if (isMirror) {
        return {
            html: `<div class="event-box flex flex-col h-full w-full ${colorClass}" aria-hidden="true"></div>`
        };
    }

    const formatTime = (date) =>
        date.toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit'
        });

    const endDisplay = new Date(end);
    const sameCalendarDay =
        start.getFullYear() === endDisplay.getFullYear() &&
        start.getMonth() === endDisplay.getMonth() &&
        start.getDate() === endDisplay.getDate();

    const formatShortDay = (d) => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

    let timeLine;
    if (!sameCalendarDay) {
        timeLine = `${formatShortDay(start)} ${formatTime(start)} → ${formatShortDay(endDisplay)} ${formatTime(endDisplay)}`;
    } else {
        timeLine = `${formatTime(start)} – ${formatTime(endDisplay)}`;
    }

    const showTitleRow = Boolean(title) && (!sameCalendarDay || durationMin > 30);

    let innerHTML = `
        <div class="event-box flex flex-col h-full w-full ${colorClass}">
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

function isSameFcEvent(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const ida = a.id != null ? String(a.id) : '';
    const idb = b.id != null ? String(b.id) : '';
    return Boolean(ida && idb && ida === idb);
}

/**
 * Premier événement qui chevauche [rangeStart, rangeEnd), hors `excludeEvent` (édition).
 * @returns {import('@fullcalendar/core').EventApi | null}
 */
function findOverlappingCalendarEvent(calendar, rangeStart, rangeEnd, excludeEvent) {
    if (!calendar?.getEvents) return null;
    const rs = rangeStart instanceof Date ? rangeStart : new Date(rangeStart);
    const re = rangeEnd instanceof Date ? rangeEnd : new Date(rangeEnd);
    if (Number.isNaN(rs.getTime()) || Number.isNaN(re.getTime()) || re.getTime() <= rs.getTime()) {
        return null;
    }
    for (const ev of calendar.getEvents()) {
        if (isSameFcEvent(ev, excludeEvent)) continue;
        const r = eventRangeForOverlap(ev);
        if (!r) continue;
        if (calendarRangesOverlap(rs, re, r.start, r.end)) {
            return ev;
        }
    }
    return null;
}

function overlapToastMessage(conflict) {
    const t = String(conflict?.title || 'Occupation').trim() || 'Occupation';
    const r = eventRangeForOverlap(conflict);
    if (!r) return `Ce créneau chevauche une autre réservation : « ${t} ».`;
    const tf = (d) =>
        d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', weekday: 'short', day: 'numeric' });
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
    if (isReservationStartBeforeTodayLocal(info.event)) {
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
    const prev = resizePreviousRange.get(info.event);
    resizePreviousRange.delete(info.event);

    const cal = info.view?.calendar;
    if (
        cal &&
        !(await ensureGoogleAgendaSlotsFreeOrAbort(
            cal,
            [{ start, end }],
            bridgeGoogleIdFromFcEvent(info.event)
        ))
    ) {
        info.revert();
        resizePreviousRange.delete(info.event);
        return;
    }

    const sync = await syncReservationEventToGoogle(info.event);
    if (!sync.ok) return;

    const oi = ownerInfoFromEvent(info.event, currentUser);
    const me = String(currentUser?.email ?? '')
        .trim()
        .toLowerCase();
    if (oi.ownerEmail && oi.ownerEmail !== me && prev) {
        await maybeNotifySlotOwnerAfterThirdPartyEdit({
            currentUser,
            action: 'modified',
            targetOwnerEmail: oi.ownerEmail,
            targetOwnerDisplayName: oi.ownerName,
            slotTitle: info.event.title,
            slotStart: info.event.start,
            slotEnd: info.event.end,
            previousStartIso: prev.startIso,
            previousEndIso: prev.endIso
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

/** Un événement par jour (même horaire), rendu batch pour FullCalendar. @returns {import('@fullcalendar/core').EventApi[]} */
function addOneEventPerDay(
    calendar,
    days,
    title,
    tStart,
    tEnd,
    type,
    ownerEmail,
    ownerDisplayName,
    ownerRole,
    currentUser
) {
    const added = [];
    const run = () => {
        for (const d of days) {
            const s = `${d}T${tStart}:00`;
            const e = `${d}T${tEnd}:00`;
            if (new Date(e) <= new Date(s)) continue;
            const xp = {
                owner: ownerEmail,
                ownerDisplayName: ownerDisplayName || ownerEmail.split('@')[0],
                ownerRole: normalizeRole(ownerRole) || 'eleve',
                type
            };
            const ev = calendar.addEvent({
                title,
                start: s,
                end: e,
                allDay: false,
                extendedProps: xp,
                ...fcDragResizePropsForEvent({ start: s, end: e, extendedProps: xp }, currentUser)
            });
            if (ev) added.push(ev);
        }
    };
    if (typeof calendar.batchRendering === 'function') {
        calendar.batchRendering(run);
    } else {
        run();
    }
    return added;
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
    const byProfile = String(getDefaultReservationTitle(currentUser?.email) || '').trim();
    if (byProfile) return byProfile;
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
        ? slotTypeToMotif(event.extendedProps?.type)
        : normalizeRole(currentUser?.role) === 'eleve'
          ? 'Cours'
          : defaultMotifForRole(currentUser?.role);
    sel.value = allowed.includes(inferredMotif) ? inferredMotif : allowed[0] || inferredMotif;

    if (event) {
        titleInput.value = String(event.title || '').trim();
    } else {
        const fallback = String(getProfile(currentUser?.email).defaultTitle || '').trim();
        titleInput.value = fallback;
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

/** En-tête modale édition : libellé selon le rôle (élève = nom seul, sans « Réservé par »). */
function applyReservationEditorShellForRole(currentUser, event) {
    const editorOwnerEl = document.getElementById('event-editor-owner');
    const wrapTitle = document.getElementById('wrap-reservation-title');
    const wrapMotif = document.getElementById('wrap-reservation-motif');
    const hintFerm = document.getElementById('event-motif-hint-fermeture');
    const sel = document.getElementById('event-motif-select');
    const r = normalizeRole(currentUser?.role);
    const owner = ownerInfoFromEvent(event, currentUser);

    if (r === 'eleve') {
        if (editorOwnerEl) {
            editorOwnerEl.textContent = reservationDisplayTitleForCurrentUser(currentUser);
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
            editorOwnerEl.textContent = ownerIdentityLabel(owner);
            editorOwnerEl.classList.remove('hidden');
        }
        wrapTitle?.classList.remove('hidden');
        wrapMotif?.classList.remove('hidden');
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
 * Après affichage immédiat du créneau : vérif Google (si pont), upsert, refetch ou rollback.
 * @param {import('@fullcalendar/core').EventApi | null} created
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
    const slotType = motifToSlotType(motif);
    const payload = [
        {
            title,
            start: rangeStart.toISOString(),
            end: rangeEnd.toISOString(),
            type: slotType,
            owner: currentUser.email
        }
    ];

    try {
        if (googleAgendaConflictCheckWanted()) {
            const v = await verifySlotsFreeOnGoogleCalendar([{ start: rangeStart, end: rangeEnd }], '');
            if (!v.ok) {
                if (created) created.remove();
                if ('conflict' in v && v.conflict) {
                    showToast(overlapToastMessage(v.conflict), 'error');
                } else {
                    showToast(v.error || 'Impossible de vérifier l’agenda Google.', 'error');
                }
                return;
            }
        }

        if (planningGridUsesSupabaseDb()) {
            const ownerUid = await planningUserIdForEmail(currentUser.email);
            if (!ownerUid) {
                if (created) created.remove();
                showToast('Compte indisponible pour enregistrer.', 'error');
                return;
            }
            const dbSlotType = motifToPlanningDbSlotType(motif);
            const bridgeType = planningDbSlotTypeToBridgeType(dbSlotType);
            const ur = await upsertPlanningEventRow({
                id: null,
                startIso: rangeStart.toISOString(),
                endIso: rangeEnd.toISOString(),
                title,
                dbSlotType,
                ownerEmail: currentUser.email,
                ownerUserId: ownerUid
            });
            if (!ur.ok || !ur.id) {
                if (created) created.remove();
                showToast(ur.error || 'Enregistrement impossible.', 'error');
                return;
            }
            const syncDb = await trySyncGoogleCalendar([
                {
                    planningEventId: ur.id,
                    title,
                    start: rangeStart.toISOString(),
                    end: rangeEnd.toISOString(),
                    type: bridgeType,
                    owner: currentUser.email
                }
            ]);
            if (calendarBridgeWanted() && !syncDb.ok && !syncDb.skipped) {
                if (created) created.remove();
                showToast(`Synchronisation agenda : ${syncDb.error || 'échec'}`, 'error');
                return;
            }
            if (created) created.remove();
            await refetchCalendarEventsFromGoogle(calendar);
            return;
        }

        const sync = await trySyncGoogleCalendar(payload);
        if (calendarBridgeWanted() && !sync.ok && !sync.skipped) {
            if (created) created.remove();
            showToast(`Synchronisation agenda : ${sync.error || 'échec'}`, 'error');
            return;
        }
        if (calendarBridgeWanted() && sync.ok && !sync.skipped) {
            if (created) created.remove();
            await refetchCalendarEventsFromGoogle(calendar);
            return;
        }
        if (created && sync?.data?.results) {
            applyBridgeUpsertResults([created], sync.data.results);
        }
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
    const add = () => {
        created = calendar.addEvent({
            title,
            start: rangeStart,
            end: rangeEnd,
            allDay: false,
            extendedProps: {
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
        motif
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
    if (normalizeRole(currentUser.role) === 'consultation') {
        showToast('Le profil consultation est en lecture seule.', 'error');
        calendar.unselect();
        return;
    }

    if (
        selectInfo.view.type === 'dayGridMonth' ||
        selectInfo.view.type.startsWith('list') ||
        selectInfo.allDay
    ) {
        await openModal(selectInfo.start, selectInfo.end, null, currentUser);
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
    if (normalizeRole(currentUser.role) === 'consultation') {
        showToast('Le profil consultation est en lecture seule.', 'error');
        return;
    }

    if (viewType.startsWith('list')) {
        await openModal(new Date(clickDate), null, null, currentUser);
        return;
    }

    let anchor = new Date(clickDate);
    const isMonthLike = viewType === 'dayGridMonth' || viewType.startsWith('multiMonth');
    if (isMonthLike) {
        if (allDayFlag !== false) {
            anchor.setHours(8, 0, 0, 0);
        }
    }

    if (isReservationStartBeforeTodayLocal({ start: anchor })) {
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
    if (!event && normalizeRole(currentUser?.role) === 'consultation') {
        showToast('Le profil consultation est en lecture seule.', 'error');
        return;
    }
    const isPastSlot = Boolean(event && isReservationStartBeforeTodayLocal(event));
    const canEditEvent = !event || canCurrentUserEditEvent(currentUser, event);
    const owner = ownerInfoFromEvent(event, currentUser);
    const ownerText = ownerIdentityLabel(owner);

    const wrapRead = document.getElementById('wrap-reservation-readonly');
    const wrapEdit = document.getElementById('wrap-reservation-editor');
    const modalActions = document.querySelector('#modal_reservation .modal-action');
    const pastHint = document.getElementById('event-readonly-past-hint');
    if (pastHint) pastHint.classList.add('hidden');

    if (event && !canEditEvent) {
        if (wrapRead && wrapEdit) {
            wrapRead.classList.remove('hidden');
            wrapEdit.classList.add('hidden');
        }
        if (pastHint && isPastSlot) pastHint.classList.remove('hidden');
        const desc = document.getElementById('event-readonly-description');
        const ownerEl = document.getElementById('event-readonly-owner');
        const whenEl = document.getElementById('event-readonly-when');
        if (desc) desc.textContent = (event.title || 'Occupation').trim() || 'Occupation';
        if (ownerEl) ownerEl.textContent = ownerText;
        if (whenEl) whenEl.textContent = formatOccupationWhenSentence(start, end);
        modalActions?.classList.add('justify-end');
        modalActions?.classList.remove('justify-between');
        document.getElementById('btn-save')?.classList.add('hidden');
        document.getElementById('btn-delete')?.classList.add('hidden');
        modal.showModal();
        return;
    }

    if (wrapRead && wrapEdit) {
        wrapRead.classList.add('hidden');
        wrapEdit.classList.remove('hidden');
    }
    modalActions?.classList.remove('justify-end');
    modalActions?.classList.add('justify-between');

    buildReservationFormFields(currentUser, event || null);
    applyReservationEditorShellForRole(currentUser, event || null);

    const toDateInput = (d) => d.toLocaleDateString('en-CA');
    const startEl = document.getElementById('event-start');
    const endEl = document.getElementById('event-end');

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

    document.getElementById('event-date-start').value = dateStartVal;
    setSelectTime(startEl, startInstant);
    setSelectTime(endEl, endInstant);

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
        'reservation-slot-owner-email'
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
    document.getElementById('btn-delete').classList.toggle('hidden', !canEditEvent || !event);

    await prepareReservationOwnerSelect(currentUser, event || null, canEditEvent);

    modal.showModal();
    requestAnimationFrame(() => {
        if (normalizeRole(currentUser?.role) === 'eleve') {
            document.getElementById('event-date-start')?.focus();
            return;
        }
        const titleEl = document.getElementById('event-title-input');
        if (titleEl && !titleEl.disabled) titleEl.focus();
    });
}

/** @param {{ start: Date | string, end: Date | string }[]} ranges */
function unionListRangesBounds(ranges) {
    if (!Array.isArray(ranges) || ranges.length === 0) return null;
    let minT = Infinity;
    let maxT = -Infinity;
    for (const raw of ranges) {
        const s = raw.start instanceof Date ? raw.start : new Date(raw.start);
        const e = raw.end instanceof Date ? raw.end : new Date(raw.end);
        if (!Number.isNaN(s.getTime())) minT = Math.min(minT, s.getTime());
        if (!Number.isNaN(e.getTime())) maxT = Math.max(maxT, e.getTime());
    }
    if (!Number.isFinite(minT) || !Number.isFinite(maxT)) return null;
    return { min: new Date(minT), max: new Date(maxT) };
}

/**
 * Chevauchement avec un événement renvoyé par le pont (même logique que la grille locale).
 * @param {unknown[]} rows
 * @param {Date} rangeStart
 * @param {Date} rangeEnd
 * @param {string} excludeGoogleId — événement édité / déplacé
 */
function findOverlappingBridgeRow(rows, rangeStart, rangeEnd, excludeGoogleId) {
    const rs = rangeStart instanceof Date ? rangeStart : new Date(rangeStart);
    const re = rangeEnd instanceof Date ? rangeEnd : new Date(rangeEnd);
    if (Number.isNaN(rs.getTime()) || Number.isNaN(re.getTime()) || re.getTime() <= rs.getTime()) {
        return null;
    }
    const ex = String(excludeGoogleId || '').trim();
    if (!Array.isArray(rows)) return null;
    for (const row of rows) {
        const o = /** @type {Record<string, unknown>} */ (row);
        if (!o || o.start == null || o.end == null) continue;
        const xp = o.extendedProps;
        const ext =
            xp && typeof xp === 'object' && !Array.isArray(xp)
                ? /** @type {Record<string, unknown>} */ (xp)
                : {};
        const gid = String(o.id ?? ext.googleEventId ?? '').trim();
        if (ex && gid && gid === ex) continue;
        const fakeEv = {
            start: new Date(/** @type {string | Date} */ (o.start)),
            end: new Date(/** @type {string | Date} */ (o.end)),
            allDay: Boolean(o.allDay)
        };
        const r = eventRangeForOverlap(fakeEv);
        if (!r) continue;
        if (calendarRangesOverlap(rs, re, r.start, r.end)) {
            return {
                title: o.title,
                start: fakeEv.start,
                end: fakeEv.end,
                allDay: fakeEv.allDay
            };
        }
    }
    return null;
}

/**
 * Liste Google immédiate + contrôle des plages (hors pont ou sans session : ok).
 * @param {{ start: Date | string, end: Date | string }[]} ranges
 * @param {string} excludeGoogleId
 * @returns {Promise<{ ok: true } | { ok: false, conflict: object } | { ok: false, error: string }>}
 */
async function verifySlotsFreeOnGoogleCalendar(ranges, excludeGoogleId) {
    if (!googleAgendaConflictCheckWanted()) return { ok: true };
    const bounds = unionListRangesBounds(ranges);
    if (!bounds) return { ok: false, error: 'Plage horaire invalide.' };
    const token = await getAccessToken();
    if (!token) return { ok: false, error: 'Session expirée (reconnectez-vous).' };
    const r = await invokeCalendarBridge(token, {
        action: 'list',
        timeMin: bounds.min.toISOString(),
        timeMax: bounds.max.toISOString()
    });
    if (r.aborted) return { ok: false, error: 'Vérification agenda annulée.' };
    if (!r.ok || r.skipped) {
        return {
            ok: false,
            error: r.error ? String(r.error) : 'Impossible de vérifier l’agenda Google.'
        };
    }
    const data = /** @type {{ events?: unknown[] }} */ (r.data || {});
    const rows = Array.isArray(data.events) ? data.events : [];
    for (const range of ranges) {
        const rs = range.start instanceof Date ? range.start : new Date(range.start);
        const re = range.end instanceof Date ? range.end : new Date(range.end);
        const hit = findOverlappingBridgeRow(rows, rs, re, excludeGoogleId);
        if (hit) return { ok: false, conflict: hit };
    }
    return { ok: true };
}

/**
 * Contrôle concurrentiel côté Google au moment de la sauvegarde.
 * @param {import('@fullcalendar/core').Calendar} calendar
 * @param {{ start: Date | string, end: Date | string }[]} ranges
 * @param {string} excludeGoogleId
 * @returns {Promise<boolean>} true si on peut poursuivre la sauvegarde
 */
export async function ensureGoogleAgendaSlotsFreeOrAbort(calendar, ranges, excludeGoogleId) {
    const v = await verifySlotsFreeOnGoogleCalendar(ranges, excludeGoogleId);
    if (v.ok) return true;
    if (v.conflict) {
        showToast(overlapToastMessage(v.conflict), 'error');
    } else {
        showToast(v.error || 'Impossible de vérifier l’agenda Google.', 'error');
    }
    await refetchCalendarEventsFromGoogle(calendar);
    return false;
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
    if (currentEventRef && isReservationStartBeforeTodayLocal(currentEventRef)) {
        showToast('Les créneaux passés ne sont pas modifiables.', 'error');
        return;
    }

    if (saveReservationInFlight) return;
    saveReservationInFlight = true;
    const saveBtn = document.getElementById('btn-save');
    if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = true;

    try {
    const motif = getReservationMotifFromForm(currentUser, currentEventRef);
    const title = getReservationTextTitleFromForm(currentUser, motif);
    const slotOwnerEmail = getReservationSlotOwnerEmail(currentUser, currentEventRef);
    const slotOwnerDisplay = getReservationSlotOwnerDisplayNameForSave(slotOwnerEmail);
    const slotOwnerRoleNorm = normalizeRole(roleFromOwnerEmail(slotOwnerEmail)) || 'eleve';
    const slotType = motifToSlotType(motif);
    const recurOn =
        isPrivilegedUser(currentUser) &&
        document.getElementById('event-recurring')?.checked &&
        !currentEventRef;

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
        if (googleAgendaConflictCheckWanted()) {
            const ranges = days.map((d) => ({
                start: new Date(`${d}T${tRecStart}:00`),
                end: new Date(`${d}T${tRecEnd}:00`)
            }));
            const ok = await ensureGoogleAgendaSlotsFreeOrAbort(calendar, ranges, '');
            if (!ok) return;
        }

        if (planningGridUsesSupabaseDb()) {
            const ownerUid = await planningUserIdForEmail(slotOwnerEmail || currentUser.email);
            if (!ownerUid) {
                showToast('Impossible de résoudre le compte du propriétaire du créneau.', 'error');
                return;
            }
            const dbSlotType = motifToPlanningDbSlotType(motif);
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
                bridgeEventsDb.push({
                    planningEventId: ur.id,
                    title,
                    start: startIso,
                    end: endIso,
                    type: bridgeType,
                    owner: slotOwnerEmail || currentUser.email
                });
            }
            const syncMultiDb = await trySyncGoogleCalendar(bridgeEventsDb);
            if (calendarBridgeWanted() && !syncMultiDb.ok && !syncMultiDb.skipped) {
                showToast(`Synchronisation agenda : ${syncMultiDb.error || 'échec'}`, 'error');
                return;
            }
            document.getElementById('modal_reservation').close();
            showToast(`${days.length} créneau${days.length > 1 ? 'x' : ''} enregistré${days.length > 1 ? 's' : ''}.`);
            document.getElementById('event-recurring').checked = false;
            resetRecurringFormDefaults();
            setRecurringOptionsVisible(false);
            await refetchCalendarEventsFromGoogle(calendar);
            return;
        }

        const bridgeEvents = days.map((d) => ({
            title,
            start: `${d}T${tRecStart}:00`,
            end: `${d}T${tRecEnd}:00`,
            type: slotType,
            owner: slotOwnerEmail || currentUser.email
        }));
        const syncMulti = await trySyncGoogleCalendar(bridgeEvents);
        if (calendarBridgeWanted() && !syncMulti.ok && !syncMulti.skipped) {
            showToast(`Synchronisation agenda : ${syncMulti.error || 'échec'}`, 'error');
            return;
        }
        if (calendarBridgeWanted() && syncMulti.ok && !syncMulti.skipped) {
            document.getElementById('modal_reservation').close();
            showToast(`${days.length} créneau${days.length > 1 ? 'x' : ''} enregistré${days.length > 1 ? 's' : ''}.`);
            document.getElementById('event-recurring').checked = false;
            resetRecurringFormDefaults();
            setRecurringOptionsVisible(false);
            await refetchCalendarEventsFromGoogle(calendar);
            return;
        }
        const addedList = addOneEventPerDay(
            calendar,
            days,
            title,
            tRecStart,
            tRecEnd,
            slotType,
            slotOwnerEmail || currentUser.email,
            slotOwnerDisplay,
            slotOwnerRoleNorm,
            currentUser
        );
        applyBridgeUpsertResults(addedList, syncMulti?.data?.results);
        document.getElementById('modal_reservation').close();
        showToast(`${days.length} créneau${days.length > 1 ? 'x' : ''} enregistré${days.length > 1 ? 's' : ''}.`);
        document.getElementById('event-recurring').checked = false;
        resetRecurringFormDefaults();
        setRecurringOptionsVisible(false);
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
        currentEventRef
    );
    if (conflictSingle) {
        showToast(overlapToastMessage(conflictSingle), 'error');
        return;
    }

    if (currentEventRef && isReservationStartBeforeTodayLocal({ start: new Date(startStr) })) {
        showToast('Impossible d’enregistrer une date antérieure à aujourd’hui.', 'error');
        return;
    }

    /** @type {{ title: string, startStr: string, endStr: string, type: string } | null} */
    let prevSnapshot = null;
    if (currentEventRef) {
        prevSnapshot = {
            title: String(currentEventRef.title || '').trim(),
            startStr: currentEventRef.start ? new Date(currentEventRef.start).toISOString() : '',
            endStr: currentEventRef.end ? new Date(currentEventRef.end).toISOString() : '',
            type: currentEventRef.extendedProps?.type || 'reservation'
        };
    }

    const ownerForBridge = slotOwnerEmail || String(currentUser.email || '').trim();
    const gid = currentEventRef ? bridgeGoogleIdFromFcEvent(currentEventRef) : '';
    if (googleAgendaConflictCheckWanted()) {
        const ok = await ensureGoogleAgendaSlotsFreeOrAbort(
            calendar,
            [{ start: new Date(startStr), end: new Date(endStr) }],
            gid
        );
        if (!ok) return;
    }
    const poolLinkExisting = String(currentEventRef?.extendedProps?.poolGoogleEventId ?? '').trim();

    if (planningGridUsesSupabaseDb()) {
        const ownerUid = await planningUserIdForEmail(slotOwnerEmail || currentUser.email);
        if (!ownerUid) {
            showToast('Impossible de résoudre le compte du propriétaire du créneau.', 'error');
            return;
        }
        const dbSlotType = motifToPlanningDbSlotType(motif);
        const bridgeType = planningDbSlotTypeToBridgeType(dbSlotType);
        const startIso = new Date(startStr).toISOString();
        const endIso = new Date(endStr).toISOString();
        const canonicalExisting = currentEventRef
            ? String(currentEventRef.extendedProps?.planningCanonicalId || '').trim()
            : '';
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
        const payloadDb = {
            planningEventId: ur.id,
            ...(gid ? { googleEventId: gid } : {}),
            title,
            start: startIso,
            end: endIso,
            type: bridgeType,
            owner: ownerForBridge || currentUser.email,
            ...(poolLinkExisting ? { poolGoogleEventId: poolLinkExisting } : {})
        };
        const syncSingleDb = await trySyncGoogleCalendar([payloadDb]);
        if (calendarBridgeWanted() && !syncSingleDb.ok && !syncSingleDb.skipped) {
            showToast(`Synchronisation agenda : ${syncSingleDb.error || 'échec'}`, 'error');
            return;
        }
        document.getElementById('modal_reservation').close();
        showToast(currentEventRef ? 'Réservation mise à jour.' : 'Réservation enregistrée.');
        await refetchCalendarEventsFromGoogle(calendar);
        if (currentEventRef && syncSingleDb.ok && prevSnapshot) {
            const changed =
                prevSnapshot.title !== title ||
                prevSnapshot.startStr !== startIso ||
                prevSnapshot.endStr !== endIso ||
                prevSnapshot.type !== slotType;
            const actor = String(currentUser.email).trim().toLowerCase();
            const ownerLower = String(ownerForBridge || '').trim().toLowerCase();
            if (changed && ownerLower && ownerLower !== actor) {
                const oi = ownerInfoFromEvent(currentEventRef, currentUser);
                await maybeNotifySlotOwnerAfterThirdPartyEdit({
                    currentUser,
                    action: 'modified',
                    targetOwnerEmail: oi.ownerEmail,
                    targetOwnerDisplayName: oi.ownerName,
                    slotTitle: title,
                    slotStart: startIso,
                    slotEnd: endIso,
                    previousStartIso: prevSnapshot.startStr,
                    previousEndIso: prevSnapshot.endStr
                });
            }
        }
        return;
    }

    const payloadSingle = {
        ...(gid ? { googleEventId: gid } : {}),
        title,
        start: startStr,
        end: endStr,
        type: slotType,
        owner: ownerForBridge || currentUser.email,
        ...(poolLinkExisting ? { poolGoogleEventId: poolLinkExisting } : {})
    };

    const syncSingle = await trySyncGoogleCalendar([payloadSingle]);
    if (calendarBridgeWanted() && !syncSingle.ok && !syncSingle.skipped) {
        showToast(`Synchronisation agenda : ${syncSingle.error || 'échec'}`, 'error');
        return;
    }

    const xpSingle = {
        owner: ownerForBridge,
        ownerDisplayName: slotOwnerDisplay,
        ownerRole: slotOwnerRoleNorm,
        type: slotType
    };
    const eventData = {
        title: title,
        start: startStr,
        end: endStr,
        extendedProps: xpSingle,
        ...fcDragResizePropsForEvent(
            { start: startStr, end: endStr, extendedProps: xpSingle },
            currentUser
        )
    };

    let addedSingle = /** @type {import('@fullcalendar/core').EventApi | null} */ (null);
    if (currentEventRef) {
        currentEventRef.setProp('title', title);
        currentEventRef.setDates(startStr, endStr);
        currentEventRef.setExtendedProp('type', slotType);
    } else if (calendarBridgeWanted() && syncSingle.ok && !syncSingle.skipped) {
        /* En mode bridge, éviter l'optimisme local : recharger depuis Google pour ne pas dupliquer. */
        await refetchCalendarEventsFromGoogle(calendar);
    } else {
        addedSingle = calendar.addEvent(eventData);
    }

    if (!currentEventRef && addedSingle && syncSingle?.data?.results) {
        applyBridgeUpsertResults([addedSingle], syncSingle.data.results);
    }

    document.getElementById('modal_reservation').close();
    showToast(currentEventRef ? 'Réservation mise à jour.' : 'Réservation enregistrée.');

    if (currentEventRef && syncSingle.ok && prevSnapshot) {
        const changed =
            prevSnapshot.title !== title ||
            prevSnapshot.startStr !== startStr ||
            prevSnapshot.endStr !== endStr ||
            prevSnapshot.type !== slotType;
        const actor = String(currentUser.email).trim().toLowerCase();
        const ownerLower = String(ownerForBridge || '').trim().toLowerCase();
        if (changed && ownerLower && ownerLower !== actor) {
            const oi = ownerInfoFromEvent(currentEventRef, currentUser);
            await maybeNotifySlotOwnerAfterThirdPartyEdit({
                currentUser,
                action: 'modified',
                targetOwnerEmail: oi.ownerEmail,
                targetOwnerDisplayName: oi.ownerName,
                slotTitle: title,
                slotStart: startStr,
                slotEnd: endStr,
                previousStartIso: prevSnapshot.startStr,
                previousEndIso: prevSnapshot.endStr
            });
        }
    }
    } finally {
        saveReservationInFlight = false;
        if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = false;
    }
}

export async function deleteReservation(calendar, currentEventRef, currentUser) {
    if (!currentEventRef || !confirm('Supprimer cette réservation ?')) return;
    if (!currentUser?.email) {
        showToast('Connectez-vous pour supprimer.', 'error');
        return;
    }
    if (isReservationStartBeforeTodayLocal(currentEventRef)) {
        showToast('Les créneaux passés ne sont pas modifiables.', 'error');
        return;
    }
    if (!canCurrentUserEditEvent(currentUser, currentEventRef)) {
        showToast('Vous ne pouvez pas supprimer ce créneau.', 'error');
        return;
    }

    const oi = ownerInfoFromEvent(currentEventRef, currentUser);
    const titleDel = String(currentEventRef.title || '').trim() || 'Créneau';
    const startDel = currentEventRef.start;
    const endDel = currentEventRef.end;

    if (planningGridUsesSupabaseDb()) {
        const canonicalId = String(currentEventRef.extendedProps?.planningCanonicalId || '').trim();
        if (!canonicalId) {
            showToast('Créneau sans identifiant base : suppression impossible.', 'error');
            return;
        }
        const tokenDb = await getAccessToken();
        const targets = await fetchPlanningMirrorTargetsForDelete(canonicalId);
        if (tokenDb && targets.length > 0) {
            for (const t of targets) {
                const rDel = await invokeCalendarBridge(tokenDb, {
                    action: 'delete',
                    googleEventId: t.googleEventId,
                    calendarId: t.calendarId
                });
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
        currentEventRef.remove();
        invalidateCalendarListCache();
        if (calendar && typeof calendar.refetchEvents === 'function') {
            await calendar.refetchEvents();
        }
        document.getElementById('modal_reservation').close();
        showToast('Créneau supprimé.');
        const meDb = String(currentUser.email).trim().toLowerCase();
        if (oi.ownerEmail && oi.ownerEmail !== meDb && startDel && endDel) {
            await maybeNotifySlotOwnerAfterThirdPartyEdit({
                currentUser,
                action: 'deleted',
                targetOwnerEmail: oi.ownerEmail,
                targetOwnerDisplayName: oi.ownerName,
                slotTitle: titleDel,
                slotStart: startDel,
                slotEnd: endDel,
                previousStartIso: '',
                previousEndIso: ''
            });
        }
        return;
    }

    const gid = bridgeGoogleIdFromFcEvent(currentEventRef);
    const poolGid = String(currentEventRef.extendedProps?.poolGoogleEventId ?? '').trim();
    if (isBackendAuthConfigured() && gid) {
        const token = await getAccessToken();
        if (token) {
            if (poolGid) {
                const poolCal = await fetchPoolCalendarIdForUser(currentUser.id);
                if (poolCal) {
                    const rPool = await invokeCalendarBridge(token, {
                        action: 'delete',
                        googleEventId: poolGid,
                        calendarId: poolCal
                    });
                    if (!rPool.ok && !rPool.skipped) {
                        showToast(`Suppression agenda perso : ${rPool.error || 'échec'}`, 'error');
                        return;
                    }
                }
            }
            const r = await invokeCalendarBridge(token, { action: 'delete', googleEventId: gid });
            if (!r.ok && !r.skipped) {
                showToast(`Suppression agenda : ${r.error || 'échec'}`, 'error');
                return;
            }
        }
    }

    currentEventRef.remove();
    document.getElementById('modal_reservation').close();
    showToast('Créneau supprimé.');

    const me = String(currentUser.email).trim().toLowerCase();
    if (oi.ownerEmail && oi.ownerEmail !== me && startDel && endDel) {
        await maybeNotifySlotOwnerAfterThirdPartyEdit({
            currentUser,
            action: 'deleted',
            targetOwnerEmail: oi.ownerEmail,
            targetOwnerDisplayName: oi.ownerName,
            slotTitle: titleDel,
            slotStart: startDel,
            slotEnd: endDel,
            previousStartIso: '',
            previousEndIso: ''
        });
    }
}

export function canEditEvent(currentUser, event) {
    if (!currentUser?.email || !event) return false;
    return canCurrentUserEditEvent(currentUser, event);
}
