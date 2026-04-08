/**
 * Logique métier du calendrier
 * Rendu des événements, ouverture des modales et CRUD
 */

import { showToast } from '../utils/toast.js';
import { getAccessToken, isBackendAuthConfigured, isPrivilegedUser } from './auth-logic.js';
import { invokeCalendarBridge } from './calendar-bridge.js';
import { getPlanningConfig } from './supabase-client.js';
import { invokeSlotNotify } from './slot-notify-api.js';
import { getDefaultReservationTitle, getProfile } from '../utils/user-profile.js';
import { isPlanningRole } from './planning-roles.js';
import { RESERVATION_MOTIFS, normalizeMotif, motifToSlotType } from './reservation-motifs.js';

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

export function canCurrentUserEditEvent(currentUser, event) {
    if (!currentUser?.email) return false;
    const meRole = normalizeRole(currentUser.role);
    if (meRole === 'consultation') return false;
    if (meRole === 'admin') return true;

    const owner = ownerInfoFromEvent(event, currentUser);
    const ownerRole = owner.ownerRole || roleFromOwnerEmail(owner.ownerEmail);
    if (owner.ownerEmail && owner.ownerEmail === String(currentUser.email).trim().toLowerCase()) {
        return true;
    }
    if (meRole === 'prof') {
        return ownerRole === 'eleve' || ownerRole === 'consultation';
    }
    return false;
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
    if (r === 'admin' || r === 'prof') return [...RESERVATION_MOTIFS];
    return RESERVATION_MOTIFS.filter((m) => m !== 'Fermeture');
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

function bridgeGoogleIdFromFcEvent(event) {
    if (!event) return '';
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
    const token = await getAccessToken();
    if (!token) return { ok: false };
    const start = calendarEvent.start;
    const end = calendarEvent.end;
    if (!start || !end) return { ok: false };
    const owner = String(calendarEvent.extendedProps?.owner || '').trim();
    const type = calendarEvent.extendedProps?.type || 'reservation';
    const gid = bridgeGoogleIdFromFcEvent(calendarEvent);
    const title = String(calendarEvent.title || '').trim() || 'Créneau';
    const payload = {
        ...(gid ? { googleEventId: gid } : {}),
        title,
        start: start.toISOString(),
        end: end.toISOString(),
        type,
        owner
    };
    const r = await invokeCalendarBridge(token, { action: 'upsert', events: [payload] });
    if (!r.ok && !r.skipped) {
        showToast(`Synchronisation agenda : ${r.error || 'échec'}`, 'error');
        return { ok: false };
    }
    if (r.ok && r.data?.results?.[0]?.googleEventId && !gid) {
        const ng = r.data.results[0].googleEventId;
        calendarEvent.setProp('id', String(ng));
        calendarEvent.setExtendedProp('googleEventId', String(ng));
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
    const title = arg.event.title || 'Occupation';
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

    const formatTime = (date) =>
        date.toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit'
        });

    const endInclusive = new Date(end.getTime() - 1);
    const sameCalendarDay =
        start.getFullYear() === endInclusive.getFullYear() &&
        start.getMonth() === endInclusive.getMonth() &&
        start.getDate() === endInclusive.getDate();

    const formatShortDay = (d) => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

    let timeLine;
    if (!sameCalendarDay) {
        timeLine = `${formatShortDay(start)} ${formatTime(start)} → ${formatShortDay(endInclusive)} ${formatTime(endInclusive)}`;
    } else {
        timeLine = `${formatTime(start)} – ${formatTime(endInclusive)}`;
    }

    const showTitleRow = !sameCalendarDay || durationMin > 30;

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

/** Fin de sélection affichable (FullCalendar : `end` exclusif sur les plages horaires). */
function selectionEndDisplay(endExclusive) {
    return new Date(endExclusive.getTime() - 1);
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
    const endInclusive = new Date(end.getTime() - 1);
    if (!sameCalendarDay(start, endInclusive)) {
        info.revert();
        resizePreviousRange.delete(info.event);
        showToast('Un créneau ne peut pas déborder sur le jour suivant.', 'error');
        return;
    }
    const prev = resizePreviousRange.get(info.event);
    resizePreviousRange.delete(info.event);

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
function addOneEventPerDay(calendar, days, title, tStart, tEnd, type, ownerEmail, ownerDisplayName, ownerRole) {
    const added = [];
    const run = () => {
        for (const d of days) {
            const s = `${d}T${tStart}:00`;
            const e = `${d}T${tEnd}:00`;
            if (new Date(e) <= new Date(s)) continue;
            const ev = calendar.addEvent({
                title,
                start: s,
                end: e,
                allDay: false,
                extendedProps: {
                    owner: ownerEmail,
                    ownerDisplayName: ownerDisplayName || ownerEmail.split('@')[0],
                    ownerRole: normalizeRole(ownerRole) || 'eleve',
                    type
                }
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

function getReservationMotifFromForm(currentUser) {
    const sel = document.getElementById('event-motif-select');
    const allowed = allowedMotifsForRole(currentUser?.role);
    const v = normalizeMotif(sel?.value || defaultMotifForRole(currentUser?.role));
    return allowed.includes(v) ? v : defaultMotifForRole(currentUser?.role);
}

function getReservationTextTitleFromForm(currentUser, motif) {
    const input = document.getElementById('event-title-input');
    const typed = String(input?.value || '').trim();
    if (typed) return typed;
    const byProfile = String(getDefaultReservationTitle(currentUser?.email) || '').trim();
    if (byProfile) return byProfile;
    return motif;
}

/** Remplit motif + titre (règles de rôle + préférence utilisateur). */
export function buildReservationFormFields(currentUser, event) {
    const sel = document.getElementById('event-motif-select');
    const titleInput = document.getElementById('event-title-input');
    if (!sel || !titleInput) return;

    const allowed = allowedMotifsForRole(currentUser?.role);
    sel.innerHTML = '';
    for (const lab of allowed) sel.add(new Option(lab, lab));

    const inferredMotif = event ? slotTypeToMotif(event.extendedProps?.type) : defaultMotifForRole(currentUser?.role);
    sel.value = allowed.includes(inferredMotif) ? inferredMotif : defaultMotifForRole(currentUser?.role);

    if (event) {
        titleInput.value = String(event.title || '').trim();
    } else {
        const fallback = String(getProfile(currentUser?.email).defaultTitle || '').trim();
        titleInput.value = fallback;
    }
}

/** Fin de plage pour un clic simple (aligné sur snapDuration, pas sur la hauteur visuelle du slot). */
export function addSlotEndFromStart(start, calendar) {
    const snap = calendar.getOption('snapDuration');
    const fallback = calendar.getOption('slotDuration');
    const raw = typeof snap === 'string' && snap !== '' ? snap : fallback;
    let ms = 30 * 60 * 1000;
    if (typeof raw === 'string') {
        const m = raw.match(/^(\d{1,2}):(\d{2}):(\d{2})/);
        if (m) ms = (+m[1]) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000;
    }
    return new Date(start.getTime() + ms);
}

/**
 * Glisser–déposer (souris ou doigt) : enregistrement immédiat, motif favori, type réservation.
 * Sur la vue mois, ou plage « all-day », ouvre la modale complète.
 */
export async function quickCreateFromSelection(calendar, selectInfo, currentUser) {
    if (!currentUser?.email) {
        showToast('Connectez-vous pour réserver.', 'error');
        return;
    }
    if (normalizeRole(currentUser.role) === 'consultation') {
        showToast('Le profil consultation est en lecture seule.', 'error');
        return;
    }

    if (
        selectInfo.view.type === 'dayGridMonth' ||
        selectInfo.view.type.startsWith('list') ||
        selectInfo.allDay
    ) {
        openModal(selectInfo.start, selectInfo.end, null, currentUser);
        calendar.unselect();
        return;
    }

    const motif = defaultMotifForRole(currentUser.role);
    let title = String(getDefaultReservationTitle(currentUser.email) || '').trim() || motif;

    const conflict = findOverlappingCalendarEvent(
        calendar,
        selectInfo.start,
        selectInfo.end,
        null
    );
    if (conflict) {
        showToast(overlapToastMessage(conflict), 'error');
        calendar.unselect();
        return;
    }

    let created = /** @type {import('@fullcalendar/core').EventApi | null} */ (null);
    const add = () => {
        created = calendar.addEvent({
            title,
            start: selectInfo.start,
            end: selectInfo.end,
            allDay: false,
            extendedProps: {
                owner: currentUser.email,
                ownerDisplayName: currentUser.name || currentUser.email.split('@')[0],
                ownerRole: normalizeRole(currentUser.role) || 'eleve',
                type: motifToSlotType(motif)
            }
        });
    };

    if (typeof calendar.batchRendering === 'function') {
        calendar.batchRendering(add);
    } else {
        add();
    }
    showToast('Créneau enregistré (rapide).');
    const slotType = motifToSlotType(motif);
    const sync = await trySyncGoogleCalendar([
        {
            title,
            start: selectInfo.start.toISOString(),
            end: selectInfo.end.toISOString(),
            type: slotType,
            owner: currentUser.email
        }
    ]);
    if (created && sync?.data?.results) {
        applyBridgeUpsertResults([created], sync.data.results);
    }
}

// --- 2. GESTION DE LA MODALE RÉSERVATION ---
export function openModal(start, end, event, currentUser) {
    const modal = document.getElementById('modal_reservation');
    if (!modal) return;
    if (!event && normalizeRole(currentUser?.role) === 'consultation') {
        showToast('Le profil consultation est en lecture seule.', 'error');
        return;
    }
    const canEditEvent = !event || canCurrentUserEditEvent(currentUser, event);
    const owner = ownerInfoFromEvent(event, currentUser);
    const ownerText = ownerIdentityLabel(owner);

    const wrapRead = document.getElementById('wrap-reservation-readonly');
    const wrapEdit = document.getElementById('wrap-reservation-editor');
    const modalActions = document.querySelector('#modal_reservation .modal-action');

    if (event && !canEditEvent) {
        if (wrapRead && wrapEdit) {
            wrapRead.classList.remove('hidden');
            wrapEdit.classList.add('hidden');
        }
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
    const editorOwnerEl = document.getElementById('event-editor-owner');
    if (editorOwnerEl) editorOwnerEl.textContent = ownerText;
    modalActions?.classList.remove('justify-end');
    modalActions?.classList.add('justify-between');

    buildReservationFormFields(currentUser, event || null);

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

        dateStartVal = toDateInput(start);
        if (midnight) {
            const ds = new Date(start);
            ds.setHours(8, 0, 0, 0);
            startInstant = ds;
            endInstant = new Date(ds.getTime() + 60 * 60 * 1000);
        } else {
            startInstant = start;
            endInstant = new Date(start.getTime() + 60 * 60 * 1000);
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
        'recur-mode-days'
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

    modal.showModal();
    requestAnimationFrame(() => {
        const titleEl = document.getElementById('event-title-input');
        if (titleEl && !titleEl.disabled) titleEl.focus();
    });
}

function calendarBridgeWanted() {
    const { calendarBridgeUrl } = getPlanningConfig();
    return Boolean(calendarBridgeUrl) && isBackendAuthConfigured();
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

    const motif = getReservationMotifFromForm(currentUser);
    const title = getReservationTextTitleFromForm(currentUser, motif);
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
        const bridgeEvents = days.map((d) => ({
            title,
            start: `${d}T${tRecStart}:00`,
            end: `${d}T${tRecEnd}:00`,
            type: slotType,
            owner: currentUser.email
        }));
        const syncMulti = await trySyncGoogleCalendar(bridgeEvents);
        if (calendarBridgeWanted() && !syncMulti.ok && !syncMulti.skipped) {
            showToast(`Synchronisation agenda : ${syncMulti.error || 'échec'}`, 'error');
            return;
        }
        const addedList = addOneEventPerDay(
            calendar,
            days,
            title,
            tRecStart,
            tRecEnd,
            slotType,
            currentUser.email,
            currentUser.name || currentUser.email.split('@')[0],
            currentUser.role
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

    const ownerForBridge = String(
        currentEventRef?.extendedProps?.owner || currentUser.email || ''
    ).trim();
    const gid = currentEventRef ? bridgeGoogleIdFromFcEvent(currentEventRef) : '';
    const payloadSingle = {
        ...(gid ? { googleEventId: gid } : {}),
        title,
        start: startStr,
        end: endStr,
        type: slotType,
        owner: ownerForBridge || currentUser.email
    };

    const syncSingle = await trySyncGoogleCalendar([payloadSingle]);
    if (calendarBridgeWanted() && !syncSingle.ok && !syncSingle.skipped) {
        showToast(`Synchronisation agenda : ${syncSingle.error || 'échec'}`, 'error');
        return;
    }

    const eventData = {
        title: title,
        start: startStr,
        end: endStr,
        extendedProps: {
            owner: currentUser.email,
            ownerDisplayName: currentUser.name || currentUser.email.split('@')[0],
            ownerRole: normalizeRole(currentUser.role) || 'eleve',
            type: slotType
        }
    };

    let addedSingle = /** @type {import('@fullcalendar/core').EventApi | null} */ (null);
    if (currentEventRef) {
        currentEventRef.setProp('title', title);
        currentEventRef.setDates(startStr, endStr);
        currentEventRef.setExtendedProp('type', slotType);
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
}

export async function deleteReservation(calendar, currentEventRef, currentUser) {
    if (!currentEventRef || !confirm('Supprimer cette réservation ?')) return;
    if (!currentUser?.email) {
        showToast('Connectez-vous pour supprimer.', 'error');
        return;
    }

    const oi = ownerInfoFromEvent(currentEventRef, currentUser);
    const titleDel = String(currentEventRef.title || '').trim() || 'Créneau';
    const startDel = currentEventRef.start;
    const endDel = currentEventRef.end;

    const gid = bridgeGoogleIdFromFcEvent(currentEventRef);
    if (isBackendAuthConfigured() && gid) {
        const token = await getAccessToken();
        if (token) {
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
