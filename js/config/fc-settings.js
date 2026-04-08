/**
 * Configuration de FullCalendar 6
 * Gère les vues, les contraintes de collision et le comportement tactile/souris
 */

import { showToast } from '../utils/toast.js';
import { demoEvents } from '../data/mock-events.js';
import { getAccessToken } from '../core/auth-logic.js';
import { getPlanningConfig, isBackendAuthConfigured } from '../core/supabase-client.js';
import { invokeCalendarBridge } from '../core/calendar-bridge.js';

/** @deprecated Conservé pour d’éventuels appels ; la barre FC native est désactivée. */
export function isCompactCalendarToolbar() {
    return typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches;
}

/** Dernière « vraie » fin de sélection (FullCalendar utilise une fin exclusive). */
function selectionEndInclusive(endExclusive) {
    return new Date(endExclusive.getTime() - 1);
}

/** Tous les rôles : sélection souris/doigt limitée à une seule journée calendaire. */
function selectAllowSingleCalendarDay(selectInfo) {
    const start = selectInfo.start;
    const last = selectionEndInclusive(selectInfo.end);
    return (
        start.getFullYear() === last.getFullYear() &&
        start.getMonth() === last.getMonth() &&
        start.getDate() === last.getDate()
    );
}

/** Recalcul du calendrier au redimensionnement (barre d’outils = HTML custom + en-têtes jours mobile). */
export function bindResponsiveCalendarToolbar(calendar) {
    const mql = window.matchMedia('(max-width: 640px)');
    const apply = () => {
        calendar.render();
        calendar.updateSize();
    };
    mql.addEventListener('change', apply);
}

export const getCalendarConfig = (handlers, currentUser) => {
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const privileged =
        currentUser && (currentUser.role === 'admin' || currentUser.role === 'prof');

    return {
        initialView: 'timeGridWeek',
        headerToolbar: false,
        locale: 'fr',
        firstDay: 1,

        views: {
            multiMonthYear: {
                type: 'multiMonth',
                duration: { years: 1 },
                multiMonthMaxColumns: 3,
                multiMonthMinWidth: 260
            },
            listWeek: {
                listDayFormat: { weekday: 'long' },
                listDaySideFormat: { month: 'long', day: 'numeric', year: 'numeric' }
            },
            /** Fenêtre glissante de 30 jours ; filtre « mes créneaux » appliqué dans `events`. */
            listMyPlanning: {
                type: 'list',
                duration: { days: 30 },
                listDayFormat: { weekday: 'long' },
                listDaySideFormat: { month: 'long', day: 'numeric', year: 'numeric' }
            }
        },
        slotMinTime: '08:00:00',
        slotMaxTime: '22:00:00',
        /* Grille visuelle : une ligne par heure. Interaction (sélection, glisser) : pas 30 min. */
        slotDuration: '01:00:00',
        snapDuration: '00:30:00',
        allDaySlot: false,
        height: '100%',
        nowIndicator: true,

        selectable: true,
        selectMirror: true,
        unselectAuto: true,

        longPressDelay: 250,
        selectLongPressDelay: 250,

        selectAllow: (selectInfo) => {
            if (selectInfo.view.type.startsWith('list')) {
                showToast('Utilisez la vue Semaine ou Jour pour sélectionner une plage sur la grille.', 'info');
                return false;
            }
            if (selectAllowSingleCalendarDay(selectInfo)) return true;
            const msg = privileged
                ? 'Une seule journée à la fois sur le calendrier : pour plusieurs jours, cochez « Réservation sur plusieurs jours » dans la fenêtre.'
                : 'Une seule journée à la fois sur le calendrier : créez un créneau par jour.';
            showToast(msg, 'error');
            return false;
        },

        eventOverlap: false,
        selectOverlap: false,

        editable: !!privileged,
        eventStartEditable: !!privileged,
        eventDurationEditable: !!privileged && !isTouchDevice,

        datesSet: () => {
            try {
                handlers.onDatesSet?.();
            } catch {
                /* */
            }
        },

        events: (fetchInfo, successCallback, failureCallback) => {
            void (async () => {
                try {
                    const start = fetchInfo.start;
                    const end = fetchInfo.end;
                    const spanDays = Math.round((end.getTime() - start.getTime()) / 86400000);

                    const { calendarBridgeUrl } = getPlanningConfig();
                    const useBridge =
                        Boolean(calendarBridgeUrl) && isBackendAuthConfigured();

                    let rows = [];

                    if (useBridge) {
                        const token = await getAccessToken();
                        if (token) {
                            const bridge = await invokeCalendarBridge(token, {
                                action: 'list',
                                timeMin: start.toISOString(),
                                timeMax: end.toISOString()
                            });
                            if (!bridge.ok) {
                                const msg = bridge.error || 'Erreur de synchronisation agenda';
                                showToast(`Agenda Google : ${msg}`, 'error');
                                failureCallback(new Error(msg));
                                return;
                            }
                            const data = /** @type {{ events?: unknown[] }} */ (bridge.data || {});
                            const raw = Array.isArray(data.events) ? data.events : [];
                            rows = raw.map((ev) => {
                                const o = /** @type {Record<string, unknown>} */ (ev);
                                const ext = o.extendedProps;
                                const xp =
                                    ext && typeof ext === 'object' && !Array.isArray(ext)
                                        ? { .../** @type {Record<string, unknown>} */ (ext) }
                                        : {};
                                const gid =
                                    (typeof o.id === 'string' && o.id) ||
                                    (typeof xp.googleEventId === 'string' && xp.googleEventId) ||
                                    '';
                                if (gid) {
                                    xp.googleEventId = gid;
                                    o.id = gid;
                                }
                                return { ...o, extendedProps: xp };
                            });
                        } else {
                            rows = [];
                        }
                    } else {
                        rows = demoEvents.map((e) => ({ ...e }));
                        rows = rows.filter((ev) => {
                            const d = new Date(ev.start);
                            return d >= start && d < end;
                        });
                    }

                    if (spanDays >= 29 && spanDays <= 31 && currentUser?.email) {
                        const me = String(currentUser.email).trim().toLowerCase();
                        rows = rows.filter(
                            (ev) => String(ev.extendedProps?.owner || '').trim().toLowerCase() === me
                        );
                    } else if (spanDays >= 29 && spanDays <= 31 && !currentUser?.email) {
                        rows = [];
                    }

                    successCallback(rows);
                } catch (e) {
                    failureCallback(e);
                }
            })();
        },

        select: (info) => handlers.onSelect(info),
        dateClick: (info) => handlers.onDateClick(info),
        eventClick: (info) => handlers.onEventClick(info),
        eventResizeStart: (info) => handlers.onResizeStart?.(info),
        eventDrop: (info) => {
            const out = handlers.onEventDrop?.(info);
            if (out && typeof out.catch === 'function') {
                void out.catch((err) => console.error(err));
            }
        },
        eventResize: (info) => {
            const out = handlers.onEventResize?.(info);
            if (out && typeof out.catch === 'function') {
                void out.catch((err) => console.error(err));
            }
        },

        eventContent: (arg) => handlers.renderEventContent(arg),

        slotLabelFormat: {
            hour: '2-digit',
            minute: '2-digit',
            meridiem: false
        },
        /* Desktop / tablette : une ligne courte. Mobile (≤640px) : rendu type Google Agenda (voir dayHeaderContent + .fc-day-head-gcal). */
        dayHeaderFormat: { weekday: 'short', day: 'numeric' },

        dayHeaderContent: (arg) => {
            if (typeof window === 'undefined') {
                return { html: '' };
            }
            const d = arg.date;
            const mobile = window.matchMedia('(max-width: 640px)').matches;
            if (mobile) {
                const longWd = d.toLocaleDateString('fr-FR', { weekday: 'long' });
                const three = (longWd.slice(0, 3).charAt(0).toUpperCase() + longWd.slice(1, 3)).normalize('NFC');
                const dom = d.getDate();
                return {
                    html: `<div class="fc-day-head-gcal"><span class="fc-day-head-gcal__dow">${three}</span><span class="fc-day-head-gcal__dom">${dom}</span></div>`
                };
            }
            const line = d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' });
            return {
                html: `<div class="fc-day-head-plain">${line}</div>`
            };
        }
    };
};
