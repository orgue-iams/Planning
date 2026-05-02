/**
 * Configuration de FullCalendar 6
 * Gère les vues, les contraintes de collision et le comportement tactile/souris
 */

import { showToast } from '../utils/toast.js';
import { isBackendAuthConfigured } from '../core/supabase-client.js';
import {
    calendarListCacheKey,
    cloneCachedCalendarRows,
    getCalendarListCache,
    setCalendarListCache
} from '../core/calendar-events-list-cache.js';
import {
    fcDragResizePropsForEvent,
    applyDragResizePropsToFcEvent
} from '../core/calendar-logic.js';
import { fetchPlanningEventsForFullCalendar } from '../core/planning-events-db.js';
import { scheduleTimeGridColumnSync } from '../utils/timegrid-column-sync.js';
import { getChapelSlotBounds } from '../core/organ-settings.js';

function escapeHtmlText(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

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
    const privileged =
        currentUser && (currentUser.role === 'admin' || currentUser.role === 'prof');
    const { slotMinTime, slotMaxTime } = getChapelSlotBounds();

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
            }
        },
        slotMinTime,
        slotMaxTime,
        /* Grille visuelle : une ligne par heure. Interaction (sélection, glisser) : pas 30 min. */
        slotDuration: '01:00:00',
        snapDuration: '00:30:00',
        allDaySlot: false,
        height: '100%',
        nowIndicator: true,

        selectable: true,
        selectMirror: true,
        unselectAuto: true,
        /* 0 : même timing que DateClicking (1er pixel de mouvement) — sinon la sélection restait « en retard »
         * et pouvait ne jamais atteindre le seuil si un autre gestionnaire captait le geste. */
        selectMinDistance: 0,

        longPressDelay: 250,
        selectLongPressDelay: 250,

        selectAllow: (selectInfo) => {
            /* FC appelle parfois ce hook pendant handleHitUpdate avec seulement start/end (sans `view`) :
             * accéder à `view.type` plantait et cassait toute la sélection cliquer-glisser. */
            if (!selectInfo?.start || !selectInfo?.end) return true;
            const viewType = selectInfo.view?.type ?? '';
            if (viewType.startsWith('list')) {
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

        /* editable au niveau calendrier : nécessaire pour la sélection plage ; drag/resize par événement
         * via fcDragResizePropsForEvent (droits comme la modale). */
        editable: true,
        eventStartEditable: false,
        eventDurationEditable: false,

        datesSet: () => {
            try {
                handlers.onDatesSet?.();
            } catch {
                /* */
            }
            scheduleTimeGridColumnSync(document.getElementById('calendar'));
        },

        viewDidMount: () => {
            scheduleTimeGridColumnSync(document.getElementById('calendar'));
        },

        /* Créneaux passés / droits : premier rendu + refetch (évite tout « draggable » avant navigation). */
        eventsSet: (info) => {
            try {
                for (const ev of info.events) {
                    applyDragResizePropsToFcEvent(ev, currentUser);
                }
            } catch {
                /* */
            }
        },
        eventDidMount: (info) => {
            try {
                applyDragResizePropsToFcEvent(info.event, currentUser);
            } catch {
                /* */
            }
        },

        /* Source des créneaux : toujours RPC Postgres. Cache mémoire 90 s + clé par utilisateur. */
        events: (fetchInfo, successCallback, failureCallback) => {
            void (async () => {
                try {
                    const start = fetchInfo.start;
                    const end = fetchInfo.end;
                    const loadSignal =
                        fetchInfo && typeof fetchInfo === 'object' && 'signal' in fetchInfo
                            ? /** @type {AbortSignal | undefined} */ (fetchInfo.signal)
                            : undefined;

                    let rows = [];

                    if (!isBackendAuthConfigured()) {
                        rows = [];
                    } else {
                        if (loadSignal?.aborted) return;
                        const cacheKey = calendarListCacheKey(
                            start.toISOString(),
                            end.toISOString(),
                            `db:${currentUser?.id || ''}`
                        );
                        const cached = getCalendarListCache(cacheKey);
                        if (cached) {
                            rows = cloneCachedCalendarRows(cached);
                        } else {
                            try {
                                rows = await fetchPlanningEventsForFullCalendar(start, end, currentUser);
                                setCalendarListCache(cacheKey, cloneCachedCalendarRows(rows));
                            } catch (err) {
                                const msg = err instanceof Error ? err.message : String(err);
                                showToast(`Planning (base) : ${msg}`, 'error');
                                failureCallback(err instanceof Error ? err : new Error(msg));
                                return;
                            }
                        }
                    }

                    /* Dédoublonnage défensif : évite les superpositions après navigation semaine suivante/précédente. */
                    const byKey = new Map();
                    for (const ev of rows) {
                        const id = String(ev?.id ?? ev?.extendedProps?.googleEventId ?? '').trim();
                        const startIso = String(ev?.start ?? '').trim();
                        const endIso = String(ev?.end ?? '').trim();
                        const owner = String(ev?.extendedProps?.owner ?? '').trim().toLowerCase();
                        const title = String(ev?.title ?? '').trim();
                        const key = id || `${startIso}|${endIso}|${owner}|${title}`;
                        if (!key) continue;
                        byKey.set(key, ev);
                    }
                    rows = [...byKey.values()];
                    rows = rows.map((ev) => ({
                        ...ev,
                        ...fcDragResizePropsForEvent(ev, currentUser)
                    }));

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
        eventDragStart: (info) => handlers.onEventDragStart?.(info),
        eventDragStop: (info) => handlers.onEventDragStop?.(info),
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

        eventTimeFormat: {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            meridiem: false
        },

        slotLabelFormat: {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            meridiem: false
        },
        /* dayHeaderContent remplace l’affichage ; dayHeaderFormat sert au titre / accessibilité FC. */
        dayHeaderFormat: { weekday: 'short', day: 'numeric' },

        dayHeaderContent: (arg) => {
            if (typeof window === 'undefined') {
                return { html: '' };
            }
            const d = arg.date;
            const mobile = window.matchMedia('(max-width: 640px)').matches;
            let dowText;
            if (mobile) {
                const longWd = d.toLocaleDateString('fr-FR', { weekday: 'long' });
                dowText = (longWd.slice(0, 3).charAt(0).toUpperCase() + longWd.slice(1, 3)).normalize('NFC');
            } else {
                dowText = d.toLocaleDateString('fr-FR', { weekday: 'short' });
            }
            const dom = d.getDate();
            const todayCls = arg.isToday ? ' fc-day-head-gcal--today' : '';
            const dow = escapeHtmlText(dowText);
            const domStr = escapeHtmlText(String(dom));
            return {
                html:
                    `<div class="fc-day-head-gcal${todayCls}">` +
                    `<span class="fc-day-head-gcal__dow">${dow}</span>` +
                    `<span class="fc-day-head-gcal__dom-badge">` +
                    `<span class="fc-day-head-gcal__dom">${domStr}</span>` +
                    `</span></div>`
            };
        }
    };
};
