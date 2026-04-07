/**
 * Barre d’outils type Google Agenda : Auj., ‹ ›, titre de période, menu vues.
 */

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

    if (type === 'dayGridMonth') {
        return `${ucFirst(MONTH_LONG[start.getMonth()])} ${start.getFullYear()}`;
    }

    if (type === 'multiMonthYear' || type.includes('multiMonth')) {
        return String(start.getFullYear());
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

    if (type === 'listMyPlanning') {
        return `Mon planning · 30 jours`;
    }

    if (type.startsWith('list')) {
        if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
            return `${start.getDate()} – ${end.getDate()} ${MONTH_LONG[start.getMonth()]} ${start.getFullYear()}`;
        }
        if (start.getFullYear() === end.getFullYear()) {
            return `${start.getDate()} ${MONTH_SHORT[start.getMonth()]} – ${end.getDate()} ${MONTH_SHORT[end.getMonth()]} ${start.getFullYear()}`;
        }
        return `${start.getDate()} ${MONTH_SHORT[start.getMonth()]} ${start.getFullYear()} – ${end.getDate()} ${MONTH_SHORT[end.getMonth()]} ${end.getFullYear()}`;
    }

    return view.title || '';
}

const VIEW_ITEMS = [
    { id: 'timeGridWeek', label: 'Semaine' },
    { id: 'dayGridMonth', label: 'Mois' },
    { id: 'timeGridDay', label: 'Jour' },
    { id: 'multiMonthYear', label: 'Année' },
    { id: 'listWeek', label: 'Planning' },
    { id: 'listMyPlanning', label: 'Mon planning' }
];

/** @param {import('@fullcalendar/core').CalendarApi} calendar */
export function initCalendarToolbar(calendar) {
    const titleEl = document.getElementById('cal-toolbar-title');
    const btnToday = document.getElementById('cal-btn-today');
    const btnPrev = document.getElementById('cal-btn-prev');
    const btnNext = document.getElementById('cal-btn-next');
    const viewTrigger = document.getElementById('cal-view-trigger');
    const viewLabelEl = document.getElementById('cal-view-trigger-label');
    const viewMenu = document.getElementById('cal-view-menu');
    const wrap = document.getElementById('calendar-toolbar');
    if (!titleEl || !btnToday || !btnPrev || !btnNext || !viewTrigger || !viewMenu || !wrap) return;

    const refreshTitle = () => {
        titleEl.textContent = formatCalendarToolbarTitle(calendar);
    };

    const closeMenu = () => {
        viewMenu.setAttribute('hidden', '');
        viewTrigger.setAttribute('aria-expanded', 'false');
    };

    const syncViewTriggerLabel = () => {
        const t = calendar.view.type;
        const item = VIEW_ITEMS.find((v) => v.id === t);
        const lab = item?.label ?? 'Semaine';
        if (viewLabelEl) viewLabelEl.textContent = lab;
        else viewTrigger.textContent = lab;
        for (const b of viewMenu.querySelectorAll('button[data-view]')) {
            b.classList.toggle('is-active', b.getAttribute('data-view') === t);
        }
    };

    btnToday.addEventListener('click', () => {
        calendar.today();
        refreshTitle();
        syncViewTriggerLabel();
    });
    btnPrev.addEventListener('click', () => {
        calendar.prev();
        refreshTitle();
        syncViewTriggerLabel();
    });
    btnNext.addEventListener('click', () => {
        calendar.next();
        refreshTitle();
        syncViewTriggerLabel();
    });

    viewTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = viewMenu.hasAttribute('hidden');
        if (open) {
            viewMenu.removeAttribute('hidden');
            viewTrigger.setAttribute('aria-expanded', 'true');
        } else {
            closeMenu();
        }
    });

    document.addEventListener('click', (e) => {
        if (e.target && /** @type {HTMLElement} */ (e.target).closest?.('.cal-view-dd')) return;
        closeMenu();
    });

    viewMenu.replaceChildren();
    for (const { id, label } of VIEW_ITEMS) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.setAttribute('data-view', id);
        b.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (id === 'listMyPlanning') {
                calendar.today();
            }
            calendar.changeView(id);
            closeMenu();
            refreshTitle();
            syncViewTriggerLabel();
            calendar.updateSize();
        });
        li.appendChild(b);
        viewMenu.appendChild(li);
    }

    refreshTitle();
    syncViewTriggerLabel();
    wrap.classList.remove('hidden');

    return { refreshTitle, syncViewTriggerLabel };
}
