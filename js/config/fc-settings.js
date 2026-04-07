/**
 * Configuration de FullCalendar 6
 * Gère les vues, les contraintes de collision et le comportement tactile/souris
 */

import { showToast } from '../utils/toast.js';

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

/** Recalcul du calendrier au redimensionnement (barre d’outils = HTML custom). */
export function bindResponsiveCalendarToolbar(calendar) {
    const mql = window.matchMedia('(max-width: 640px)');
    const apply = () => calendar.updateSize();
    mql.addEventListener('change', apply);
}

export const getCalendarConfig = (handlers, currentUser) => {
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const compact = isCompactCalendarToolbar();
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

        select: (info) => handlers.onSelect(info),
        dateClick: (info) => handlers.onDateClick(info),
        eventClick: (info) => handlers.onEventClick(info),
        eventDrop: (info) => handlers.onEventDrop(info),
        eventResize: (info) => handlers.onEventResize(info),

        eventContent: (arg) => handlers.renderEventContent(arg),

        slotLabelFormat: {
            hour: '2-digit',
            minute: '2-digit',
            meridiem: false
        },
        dayHeaderFormat: compact
            ? { weekday: 'narrow', day: 'numeric' }
            : { weekday: 'short', day: 'numeric' }
    };
};
