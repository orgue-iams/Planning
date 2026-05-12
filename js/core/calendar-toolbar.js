/**
 * Barre d’outils : titre de période, navigation (desktop), synchro avec le tiroir vues.
 */

import { getProfWeekCycleForToolbar, weekCycleLabelForDate } from './week-cycle.js';
import { isProf } from './auth-logic.js';
import { getPlanningSessionUser } from './session-user.js';
import { syncDrawerViewSelection } from './planning-drawer-ui.js';

const MONTH_LONG = [
    'janvier',
    'février',
    'mars',
    'avril',
    'mai',
    'juin',
    'juillet',
    'août',
    'septembre',
    'octobre',
    'novembre',
    'décembre'
];

const MONTH_SHORT = [
    'janv.',
    'févr.',
    'mars',
    'avr.',
    'mai',
    'juin',
    'juill.',
    'août',
    'sept.',
    'oct.',
    'nov.',
    'déc.'
];

function ucFirst(s) {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Dernier instant visible (currentEnd est exclusif côté FullCalendar). */
function lastVisibleInstant(view) {
    return new Date(view.currentEnd.getTime() - 1);
}

/**
 * Titre de période façon Google Calendar (fr).
 * @param {import('@fullcalendar/core').CalendarApi} calendar
 */
export function formatCalendarToolbarTitle(calendar) {
    const view = calendar.view;
    const type = view.type;
    const start = view.currentStart;
    const end = lastVisibleInstant(view);

    let base;
    if (type === 'dayGridMonth') {
        base = `${ucFirst(MONTH_LONG[start.getMonth()])} ${start.getFullYear()}`;
    } else if (type === 'timeGridDay') {
        base = ucFirst(
            start.toLocaleDateString('fr-FR', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric'
            })
        );
    } else if (type === 'timeGridWeek') {
        if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
            base = `${ucFirst(MONTH_LONG[start.getMonth()])} ${start.getFullYear()}`;
        } else if (start.getFullYear() === end.getFullYear()) {
            base = `${ucFirst(MONTH_SHORT[start.getMonth()])} – ${ucFirst(MONTH_SHORT[end.getMonth()])} ${start.getFullYear()}`;
        } else {
            base = `${ucFirst(MONTH_SHORT[start.getMonth()])} ${start.getFullYear()} – ${ucFirst(MONTH_SHORT[end.getMonth()])} ${end.getFullYear()}`;
        }
    } else {
        base = view.title || '';
    }

    const u = getPlanningSessionUser();
    const state = isProf(u) ? getProfWeekCycleForToolbar() : null;
    const weekCycleOkView = type === 'timeGridWeek' || type === 'timeGridDay';
    const wc =
        weekCycleOkView &&
        state?.anchorMondayIso &&
        weekCycleLabelForDate(state.anchorMondayIso, state.letterAtAnchor, start);
    return wc ? `${base} · ${wc}` : base;
}

/** @param {import('@fullcalendar/core').CalendarApi} calendar */
export function initCalendarToolbar(calendar) {
    const titleEl = document.getElementById('cal-toolbar-title');
    const btnToday = document.getElementById('cal-btn-today');
    const btnPrev = document.getElementById('cal-btn-prev');
    const btnNext = document.getElementById('cal-btn-next');
    const wrap = document.getElementById('calendar-toolbar');
    if (!titleEl || !btnToday || !btnPrev || !btnNext || !wrap) return;

    const refreshTitle = () => {
        titleEl.textContent = formatCalendarToolbarTitle(calendar);
        syncDrawerViewSelection(calendar);
    };

    btnToday.addEventListener('click', () => {
        calendar.today();
        refreshTitle();
    });
    btnPrev.addEventListener('click', () => {
        calendar.prev();
        refreshTitle();
    });
    btnNext.addEventListener('click', () => {
        calendar.next();
        refreshTitle();
    });

    refreshTitle();
    wrap.classList.remove('hidden');

    return { refreshTitle };
}
