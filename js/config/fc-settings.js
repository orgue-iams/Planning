/**
 * Configuration de FullCalendar 6
 * Gère les vues, les contraintes de collision et le comportement tactile/souris
 */

import { showToast } from '../utils/toast.js';

const TOOLBAR_FULL = {
    left: 'prev,next today',
    center: 'title',
    right: 'dayGridMonth,timeGridWeek'
};

/** Même ensemble, « Aujourd’hui » regroupé à droite pour gagner de la largeur */
const TOOLBAR_COMPACT = {
    left: 'prev,next',
    center: 'title',
    right: 'today dayGridMonth,timeGridWeek'
};

const BUTTON_TEXT_FULL = {
    today: "Aujourd'hui",
    month: 'Mois',
    week: 'Semaine'
};

const BUTTON_TEXT_COMPACT = {
    today: 'Auj.',
    month: 'Mois',
    week: 'Sem.'
};

export function isCompactCalendarToolbar() {
    return typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches;
}

export function getHeaderToolbarOptions(compact) {
    return compact ? TOOLBAR_COMPACT : TOOLBAR_FULL;
}

export function getButtonTextOptions(compact) {
    return compact ? BUTTON_TEXT_COMPACT : BUTTON_TEXT_FULL;
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

/** Recalcule la barre d’outils (rotation mobile, redimensionnement). */
export function bindResponsiveCalendarToolbar(calendar) {
    const mql = window.matchMedia('(max-width: 640px)');
    const apply = () => {
        const compact = mql.matches;
        calendar.setOption('headerToolbar', getHeaderToolbarOptions(compact));
        calendar.setOption('buttonText', getButtonTextOptions(compact));
        calendar.updateSize();
    };
    mql.addEventListener('change', apply);
}

export const getCalendarConfig = (handlers, currentUser) => {
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const compact = isCompactCalendarToolbar();
    const privileged =
        currentUser && (currentUser.role === 'admin' || currentUser.role === 'prof');

    return {
        initialView: 'timeGridWeek',
        headerToolbar: getHeaderToolbarOptions(compact),
        buttonText: getButtonTextOptions(compact),
        locale: 'fr',
        firstDay: 1,
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
