/**
 * Barre d’outils : titre de période, navigation (desktop), synchro avec le tiroir vues.
 */

import { getProfWeekCycleForToolbar, weekCycleLabelForDate } from './week-cycle.js';
import { isProf } from './auth-logic.js';
import { getPlanningSessionUser } from './session-user.js';
import { syncDrawerViewSelection, togglePlanningDrawer } from './planning-drawer-ui.js';

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
 * Titre de période (sans suffixe semaine A/B).
 * @param {import('@fullcalendar/core').ViewApi} view
 */
function toolbarPeriodBaseTitle(view) {
    const type = view.type;
    const start = view.currentStart;
    const end = lastVisibleInstant(view);

    if (type === 'dayGridMonth') {
        return `${ucFirst(MONTH_LONG[start.getMonth()])} ${start.getFullYear()}`;
    }
    if (type === 'timeGridDay') {
        return ucFirst(
            start.toLocaleDateString('fr-FR', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric'
            })
        );
    }
    if (type === 'timeGridWeek') {
        if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
            return `${ucFirst(MONTH_LONG[start.getMonth()])} ${start.getFullYear()}`;
        }
        if (start.getFullYear() === end.getFullYear()) {
            return `${ucFirst(MONTH_SHORT[start.getMonth()])} – ${ucFirst(MONTH_SHORT[end.getMonth()])} ${start.getFullYear()}`;
        }
        return `${ucFirst(MONTH_SHORT[start.getMonth()])} ${start.getFullYear()} – ${ucFirst(MONTH_SHORT[end.getMonth()])} ${end.getFullYear()}`;
    }
    return view.title || '';
}

/**
 * Libellé semaine A/B pour la vue courante (prof + repère en base), sinon chaîne vide.
 * @param {import('@fullcalendar/core').CalendarApi} calendar
 */
function toolbarWeekCycleLabel(calendar) {
    const view = calendar.view;
    const type = view.type;
    const start = view.currentStart;
    const u = getPlanningSessionUser();
    const state = isProf(u) ? getProfWeekCycleForToolbar() : null;
    const weekCycleOkView = type === 'timeGridWeek' || type === 'timeGridDay';
    const wc =
        weekCycleOkView &&
        state?.anchorMondayIso &&
        weekCycleLabelForDate(state.anchorMondayIso, state.letterAtAnchor, start);
    return wc ? String(wc) : '';
}

/**
 * Textes pour le bloc paysage (coin grille) : période + semaine type.
 * @param {import('@fullcalendar/core').CalendarApi} calendar
 */
export function getPlanningCornerHudParts(calendar) {
    return {
        period: toolbarPeriodBaseTitle(calendar.view),
        week: toolbarWeekCycleLabel(calendar)
    };
}

function isPlanningCornerHudViewport() {
    if (typeof window === 'undefined') return false;
    if (!window.matchMedia('(orientation: landscape)').matches) return false;
    return (
        window.matchMedia('(max-width: 639px)').matches || window.matchMedia('(max-height: 520px)').matches
    );
}

const CORNER_MENU_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" class="planning-fc-corner-hud__menu-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>';

/**
 * Coin gauche de l’en-tête FullCalendar (paysage étroit) : menu + mois/période + semaine A/B.
 * @param {import('@fullcalendar/core').CalendarApi | null} calendar
 */
export function syncPlanningGridCornerHud(calendar) {
    const calEl = document.getElementById('calendar');
    const axisCell = calEl?.querySelector('.fc-scrollgrid-section-header td.fc-timegrid-axis');
    if (!calEl || !axisCell || !(axisCell instanceof HTMLElement)) return;

    if (!calendar || !isPlanningCornerHudViewport()) {
        axisCell.querySelector('.planning-fc-corner-hud')?.remove();
        return;
    }

    let hud = axisCell.querySelector('.planning-fc-corner-hud');
    if (!hud) {
        hud = document.createElement('div');
        hud.className = 'planning-fc-corner-hud';
        hud.innerHTML = `
            <button type="button" id="btn-app-drawer-fc" class="planning-fc-corner-hud__menu-btn" aria-label="Menu principal" aria-controls="planning-app-drawer" title="Menu">
                ${CORNER_MENU_SVG}
            </button>
            <div class="planning-fc-corner-hud__meta">
                <span class="planning-fc-corner-hud__period" aria-live="polite"></span>
                <span class="planning-fc-corner-hud__week" aria-live="polite"></span>
            </div>`;
        axisCell.appendChild(hud);
        const menuBtn = hud.querySelector('#btn-app-drawer-fc');
        menuBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            togglePlanningDrawer();
        });
    }

    const { period, week } = getPlanningCornerHudParts(calendar);
    const pEl = hud.querySelector('.planning-fc-corner-hud__period');
    const wEl = hud.querySelector('.planning-fc-corner-hud__week');
    if (pEl) pEl.textContent = period;
    if (wEl) {
        wEl.textContent = week;
        wEl.classList.toggle('hidden', !week);
    }
}

/**
 * Titre de période façon Google Calendar (fr).
 * @param {import('@fullcalendar/core').CalendarApi} calendar
 */
export function formatCalendarToolbarTitle(calendar) {
    const base = toolbarPeriodBaseTitle(calendar.view);
    const wc = toolbarWeekCycleLabel(calendar);
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
        syncPlanningGridCornerHud(calendar);
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
