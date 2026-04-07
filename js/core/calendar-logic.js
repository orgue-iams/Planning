/**
 * Logique métier du calendrier
 * Rendu des événements, ouverture des modales et CRUD
 */

import { showToast } from '../utils/toast.js';
import { getAccessToken, isBackendAuthConfigured, isPrivilegedUser } from './auth-logic.js';
import { invokeCalendarBridge } from './calendar-bridge.js';
import { getProfile, getFavoriteLabel } from '../utils/user-profile.js';
import { isPlanningRole } from './planning-roles.js';

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function normalizeRole(role) {
    const r = String(role || '').toLowerCase();
    return isPlanningRole(r) ? r : '';
}

function ownerInfoFromEvent(event, currentUser) {
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

// --- 1. RENDU VISUEL DES CRÉNEAUX ---
export function getEventContent(arg, currentUser) {
    const title = arg.event.title || "Occupation";
    const start = arg.event.start;
    const end = arg.event.end;
    
    // Calcul de la durée en minutes
    const durationMs = end - start;
    const durationMin = Math.round(durationMs / (1000 * 60));

    const isMine = currentUser && arg.event.extendedProps.owner === currentUser.email;
    const type = arg.event.extendedProps.type || 'reservation';
    let ownerRole = normalizeRole(arg.event.extendedProps.ownerRole);
    if (!ownerRole && arg.event.extendedProps.owner) {
        ownerRole = roleFromOwnerEmail(String(arg.event.extendedProps.owner));
    }
    const viewerRole = normalizeRole(currentUser?.role);

    let colorClass = 'event-slot-default';

    if (type === 'fermeture') {
        colorClass = 'event-fermeture';
    } else if (type === 'cours' || type === 'maintenance') {
        colorClass = 'event-cours';
    } else if (viewerRole === 'eleve') {
        if (isMine) {
            colorClass = 'event-mine-eleve';
        } else if (ownerRole === 'prof') {
            colorClass = 'event-by-prof';
        } else if (ownerRole === 'admin') {
            colorClass = 'event-by-admin';
        } else if (ownerRole === 'consultation') {
            colorClass = 'event-by-consultation';
        } else {
            colorClass = 'event-other-eleve';
        }
    } else if (viewerRole === 'prof' || viewerRole === 'admin') {
        if (isMine) {
            colorClass = 'event-mine-staff';
        } else if (ownerRole === 'eleve') {
            colorClass = 'event-student-block';
        } else if (ownerRole === 'prof') {
            colorClass = 'event-peer-prof';
        } else if (ownerRole === 'admin') {
            colorClass = 'event-admin-block';
        } else if (ownerRole === 'consultation') {
            colorClass = 'event-by-consultation';
        } else {
            colorClass = 'event-slot-default';
        }
    } else if (viewerRole === 'consultation') {
        colorClass = isMine ? 'event-mine-consult' : 'event-readonly-consult';
    } else {
        if (isMine) colorClass = 'event-mine-staff';
        else colorClass = 'event-slot-default';
    }

    // Formatage de l'heure (HH:mm)
    const formatTime = (date) => date.toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit'
    });

    const sameCalendarDay =
        start.getFullYear() === end.getFullYear() &&
        start.getMonth() === end.getMonth() &&
        start.getDate() === end.getDate();

    const formatShortDay = (d) =>
        d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

    let timeLine;
    if (!sameCalendarDay) {
        timeLine = `${formatShortDay(start)} ${formatTime(start)} → ${formatShortDay(end)} ${formatTime(end)}`;
    } else if (durationMin > 30) {
        timeLine = `${formatTime(start)} – ${formatTime(end)}`;
    } else {
        timeLine = null;
    }

    // Construction du HTML interne
    let innerHTML = `
        <div class="event-box flex flex-col h-full w-full ${colorClass}">
            <div class="event-title event-title-fc">${escapeHtml(title)}</div>`;

    if (timeLine) {
        innerHTML += `
            <div class="event-time event-time-fc">${timeLine}</div>`;
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

/** Annule le redimensionnement si la fin dépasse sur un autre jour (fin FC = exclusive). */
export function handleEventResize(info) {
    const start = info.event.start;
    const end = info.event.end;
    if (!start || !end) return;
    const endInclusive = new Date(end.getTime() - 1);
    if (!sameCalendarDay(start, endInclusive)) {
        info.revert();
        showToast('Un créneau ne peut pas déborder sur le jour suivant.', 'error');
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

/** Un événement par jour (même horaire), rendu batch pour FullCalendar. */
function addOneEventPerDay(calendar, days, title, tStart, tEnd, type, ownerEmail, ownerDisplayName, ownerRole) {
    const run = () => {
        for (const d of days) {
            const s = `${d}T${tStart}:00`;
            const e = `${d}T${tEnd}:00`;
            if (new Date(e) <= new Date(s)) continue;
            calendar.addEvent({
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
        }
    };
    if (typeof calendar.batchRendering === 'function') {
        calendar.batchRendering(run);
    } else {
        run();
    }
}

export function getReservationTitleFromForm() {
    const sel = document.getElementById('event-title-select');
    const inp = document.getElementById('event-title-custom');
    if (sel?.value === '__custom__') {
        return (inp?.value || '').trim() || 'Sans titre';
    }
    return (sel?.value || '').trim() || 'Sans titre';
}

/** Remplit la liste déroulante des motifs + saisie libre ; préremplit le favori ou un titre existant. */
export function buildReservationTitleSelect(currentUser, existingTitle) {
    const { labels, favoriteLabel } = getProfile(currentUser?.email);
    const sel = document.getElementById('event-title-select');
    const inp = document.getElementById('event-title-custom');
    if (!sel || !inp) return;

    sel.innerHTML = '';
    for (const lab of labels) {
        sel.add(new Option(lab, lab));
    }
    sel.add(new Option('— Saisie libre —', '__custom__'));

    const str = String(existingTitle ?? '').trim();
    if (str && labels.includes(str)) {
        sel.value = str;
        inp.value = '';
        inp.classList.add('hidden');
    } else if (str) {
        sel.value = '__custom__';
        inp.value = str;
        inp.classList.remove('hidden');
    } else if (labels.length === 0) {
        sel.value = '__custom__';
        inp.value = '';
        inp.classList.remove('hidden');
    } else {
        const fav =
            favoriteLabel && labels.includes(favoriteLabel) ? favoriteLabel : labels[0];
        sel.value = fav;
        inp.value = '';
        inp.classList.add('hidden');
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
export function quickCreateFromSelection(calendar, selectInfo, currentUser) {
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

    let title = getFavoriteLabel(currentUser.email).trim();
    if (!title) title = 'Réservation';

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

    const add = () => {
        calendar.addEvent({
            title,
            start: selectInfo.start,
            end: selectInfo.end,
            allDay: false,
            extendedProps: {
                owner: currentUser.email,
                ownerDisplayName: currentUser.name || currentUser.email.split('@')[0],
                ownerRole: normalizeRole(currentUser.role) || 'eleve',
                type: 'reservation'
            }
        });
    };

    if (typeof calendar.batchRendering === 'function') {
        calendar.batchRendering(add);
    } else {
        add();
    }
    showToast('Créneau enregistré (rapide).');
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

    buildReservationTitleSelect(currentUser, event ? event.title : '');

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

    document.getElementById('wrap-event-type')?.classList.toggle('hidden', !isPrivilegedUser(currentUser));

    // Type de créneau (si existant) — `maintenance` retiré au profit de `cours`
    const typeEl = document.getElementById('event-type');
    if (event && event.extendedProps.type && typeEl) {
        let t = event.extendedProps.type;
        if (t === 'maintenance') t = 'cours';
        if (![...typeEl.options].some((o) => o.value === t)) t = 'reservation';
        typeEl.value = t;
    } else if (typeEl) {
        typeEl.value = 'reservation';
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
        'event-title-select',
        'event-title-custom',
        'event-date-start',
        'event-start',
        'event-end',
        'event-type',
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
        const custom = document.getElementById('event-title-select')?.value === '__custom__';
        const titleEl = custom
            ? document.getElementById('event-title-custom')
            : document.getElementById('event-title-select');
        if (titleEl && !titleEl.disabled) titleEl.focus();
    });
}

async function trySyncGoogleCalendar(eventsPayload) {
    if (!isBackendAuthConfigured()) return;
    const token = await getAccessToken();
    if (!token || !eventsPayload?.length) return;
    const r = await invokeCalendarBridge(token, { action: 'upsert', events: eventsPayload });
    if (!r.ok && !r.skipped) {
        showToast(`Synchronisation agenda : ${r.error || 'échec'}`, 'error');
    }
}

// --- 3. ACTIONS (SAUVEGARDE / SUPPRESSION) ---
export async function saveReservation(calendar, currentUser, currentEventRef) {
    if (!currentUser || !currentUser.email) {
        showToast('Veuillez vous connecter pour enregistrer une réservation.', 'error');
        return;
    }

    const title = getReservationTitleFromForm();
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
        const type = document.getElementById('event-type').value;
        addOneEventPerDay(
            calendar,
            days,
            title,
            tRecStart,
            tRecEnd,
            type,
            currentUser.email,
            currentUser.name || currentUser.email.split('@')[0],
            currentUser.role
        );
        document.getElementById('modal_reservation').close();
        showToast(`${days.length} créneau${days.length > 1 ? 'x' : ''} enregistré${days.length > 1 ? 's' : ''}.`);
        document.getElementById('event-recurring').checked = false;
        resetRecurringFormDefaults();
        setRecurringOptionsVisible(false);
        const bridgeEvents = days.map((d) => ({
            title,
            start: `${d}T${tRecStart}:00`,
            end: `${d}T${tRecEnd}:00`,
            type,
            owner: currentUser.email
        }));
        await trySyncGoogleCalendar(bridgeEvents);
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

    const type = document.getElementById('event-type').value;

    const eventData = {
        title: title,
        start: startStr,
        end: endStr,
        extendedProps: {
            owner: currentUser.email,
            ownerDisplayName: currentUser.name || currentUser.email.split('@')[0],
            ownerRole: normalizeRole(currentUser.role) || 'eleve',
            type: type
        }
    };

    if (currentEventRef) {
        // Mise à jour
        currentEventRef.setProp('title', title);
        currentEventRef.setDates(startStr, endStr);
        currentEventRef.setExtendedProp('type', type);
    } else {
        // Création
        calendar.addEvent(eventData);
    }

    document.getElementById('modal_reservation').close();
    showToast(currentEventRef ? 'Réservation mise à jour.' : 'Réservation enregistrée.');
    await trySyncGoogleCalendar([
        {
            title,
            start: startStr,
            end: endStr,
            type,
            owner: currentUser.email
        }
    ]);
}

export function deleteReservation(calendar, currentEventRef) {
    if (currentEventRef && confirm("Supprimer cette réservation ?")) {
        currentEventRef.remove();
        document.getElementById('modal_reservation').close();
        showToast('Créneau supprimé.');
    }
}

export function canEditEvent(currentUser, event) {
    if (!currentUser?.email || !event) return false;
    return canCurrentUserEditEvent(currentUser, event);
}
