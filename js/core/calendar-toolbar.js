/**
 * Barre d’outils : titre de période, navigation (desktop), synchro avec le tiroir vues.
 */

import { getProfWeekCycleForToolbar, weekCycleLabelForDate } from './week-cycle.js';
import { isProf } from './auth-logic.js';
import { getPlanningSessionUser } from './session-user.js';
import { syncDrawerViewSelection, togglePlanningDrawer } from './planning-drawer-ui.js';
import { formatUserAxisNameParts } from '../utils/profile-full-name.js';

let headerOffsetObserver = null;
let headerOffsetSyncInited = false;
let headerOffsetRaf = 0;
let lastHeaderOffsetBottom = 0;
const SHOW_LEGACY_WEEK_CYCLE_BADGE = false;

/** Aligne le padding de #app-shell sur la hauteur réelle du bandeau fixe (évite le masquage des en-têtes FC). */
export function syncPlanningAppHeaderOffset() {
    const header = document.querySelector('#app-header .app-navbar');
    if (!(header instanceof HTMLElement)) return;
    const bottom = Math.ceil(header.getBoundingClientRect().bottom);
    if (bottom <= 0 || bottom === lastHeaderOffsetBottom) return;
    lastHeaderOffsetBottom = bottom;
    document.documentElement.style.setProperty('--planning-app-header-h', `${bottom}px`);
    window.dispatchEvent(new Event('planning-app-header-resized'));
}

export function initPlanningAppHeaderOffsetSync() {
    if (headerOffsetSyncInited) {
        syncPlanningAppHeaderOffset();
        return;
    }
    const header = document.querySelector('#app-header .app-navbar');
    if (!(header instanceof HTMLElement)) return;
    headerOffsetSyncInited = true;
    syncPlanningAppHeaderOffset();
    headerOffsetObserver?.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
        headerOffsetObserver = new ResizeObserver(() => {
            if (headerOffsetRaf) cancelAnimationFrame(headerOffsetRaf);
            headerOffsetRaf = requestAnimationFrame(() => {
                headerOffsetRaf = 0;
                syncPlanningAppHeaderOffset();
            });
        });
        headerOffsetObserver.observe(header);
    } else {
        window.addEventListener('resize', syncPlanningAppHeaderOffset);
    }
}

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
 * Libellé semaine A/B pour la vue courante (prof + repère `organ_prof_week_cycle` en base).
 * Admin / élève : toujours chaîne vide (pas de semaine type globale).
 * @param {import('@fullcalendar/core').CalendarApi} calendar
 */
function toolbarWeekCycleLabel(calendar) {
    if (!SHOW_LEGACY_WEEK_CYCLE_BADGE) return '';
    const u = getPlanningSessionUser();
    if (!isProf(u)) return '';
    const view = calendar.view;
    const type = view.type;
    const start = view.currentStart;
    const state = getProfWeekCycleForToolbar();
    const weekCycleOkView =
        type === 'timeGridWeek' || type === 'timeGridDay' || type === 'listWeek';
    const wc =
        weekCycleOkView &&
        state?.anchorMondayIso &&
        weekCycleLabelForDate(state.anchorMondayIso, state.letterAtAnchor, start);
    return wc ? String(wc) : '';
}

/** Ex. « (A) » pour le titre de période (prof uniquement). */
function toolbarWeekCycleShortSuffix(calendar) {
    const wc = toolbarWeekCycleLabel(calendar);
    if (!wc) return '';
    if (wc.includes('B')) return 'B';
    if (wc.includes('A')) return 'A';
    return '';
}

/**
 * Textes pour le bloc paysage (coin grille) : période + semaine type.
 * @param {import('@fullcalendar/core').CalendarApi} calendar
 */
export function getPlanningCornerHudParts(calendar) {
    const base = toolbarPeriodBaseTitle(calendar.view);
    const suffix = isProf(getPlanningSessionUser()) ? toolbarWeekCycleShortSuffix(calendar) : '';
    return {
        period: suffix ? `${base} (${suffix})` : base,
        week: ''
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

const USER_AXIS_LABEL_ID = 'planning-user-axis-label';
let userAxisLabelRaf = 0;
let userAxisLabelResizeBound = false;

/**
 * Glyph bounds d’un nœud texte (plus fiable que getBoundingClientRect sur un span étiré).
 * @param {Element | null} el
 */
function textGlyphRect(el) {
    if (!(el instanceof Element)) return null;
    try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const r = range.getBoundingClientRect();
        if (r.width < 1 && r.height < 1) return null;
        return r;
    } catch {
        return null;
    }
}

/**
 * Nom abrégé de l’utilisateur connecté, calé sur la ligne des jours / l’axe « 09:00 »,
 * en overlay au-dessus de la grille (sans empiéter sur « lun. »).
 */
export function syncPlanningUserAxisLabel() {
    const calEl = document.getElementById('calendar');
    if (!(calEl instanceof HTMLElement)) return;

    const existing = document.getElementById(USER_AXIS_LABEL_ID);
    const hide = () => {
        if (existing) existing.hidden = true;
    };

    /* Paysage étroit : le coin est déjà occupé par le HUD menu / période. */
    if (isPlanningCornerHudViewport()) {
        hide();
        return;
    }

    const parts = formatUserAxisNameParts(getPlanningSessionUser());
    if (!parts) {
        hide();
        return;
    }

    const axisCell = calEl.querySelector(
        '.fc-scrollgrid-section-header td.fc-timegrid-axis, .fc-scrollgrid-section-header th.fc-timegrid-axis'
    );
    if (!(axisCell instanceof HTMLElement)) {
        hide();
        return;
    }

    const headerSection = calEl.querySelector('.fc-scrollgrid-section-header');
    const slotCushion =
        calEl.querySelector('.fc-timegrid-slot-label-cushion') ||
        calEl.querySelector('.fc-timegrid-slot-label');
    const firstDow = calEl.querySelector(
        '.fc-scrollgrid-section-header .fc-col-header-cell:not(.fc-timegrid-axis) .fc-day-head-gcal__dow'
    );

    const calRect = calEl.getBoundingClientRect();
    const axisRect = axisCell.getBoundingClientRect();
    const headerRect = headerSection?.getBoundingClientRect() || axisRect;
    const slotRect = slotCushion?.getBoundingClientRect();
    const dowGlyph = textGlyphRect(firstDow);

    const left = Math.max(
        0,
        (slotRect ? slotRect.left : axisRect.left + 4) - calRect.left
    );
    const top = Math.max(0, headerRect.top - calRect.top);
    const height = Math.max(axisRect.height, headerRect.height);
    const rightLimit = dowGlyph
        ? dowGlyph.left - calRect.left - 6
        : axisRect.right - calRect.left - 2;
    const maxWidth = Math.max(0, rightLimit - left);
    if (maxWidth < 12) {
        hide();
        return;
    }

    let el = existing;
    if (!(el instanceof HTMLElement)) {
        el = document.createElement('div');
        el.id = USER_AXIS_LABEL_ID;
        el.className = 'planning-user-axis-label';
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML = '<span class="planning-user-axis-label__text"></span>';
        calEl.appendChild(el);
    }

    const textEl = el.querySelector('.planning-user-axis-label__text');
    if (textEl) {
        textEl.replaceChildren();
        textEl.classList.remove('planning-user-axis-label__text--stack');
        if (parts.prenomShort) {
            const p = document.createElement('span');
            p.className = 'planning-user-axis-label__prenom';
            p.textContent = parts.prenomShort;
            textEl.appendChild(p);
        }
        if (parts.prenomShort && parts.nom) {
            textEl.appendChild(document.createTextNode(' '));
        }
        if (parts.nom) {
            const n = document.createElement('span');
            n.className = 'planning-user-axis-label__nom';
            n.textContent = parts.nom;
            textEl.appendChild(n);
        }
    }
    el.title = parts.full;
    el.hidden = false;
    const w = Math.round(maxWidth * 100) / 100;
    el.style.left = `${Math.round(left * 100) / 100}px`;
    el.style.top = `${Math.round(top * 100) / 100}px`;
    el.style.height = `${Math.round(height * 100) / 100}px`;
    el.style.width = `${w}px`;
    el.style.maxWidth = `${w}px`;

    /* Si « N. Nom » dépasse la place avant « lun. », empiler après le prénom. */
    if (textEl && parts.prenomShort && parts.nom) {
        const probe = document.createElement('span');
        probe.style.cssText =
            'position:absolute;visibility:hidden;pointer-events:none;white-space:nowrap;font:inherit;letter-spacing:inherit';
        probe.textContent = parts.full;
        el.appendChild(probe);
        const needsStack = probe.offsetWidth > w - 1;
        probe.remove();
        textEl.classList.toggle('planning-user-axis-label__text--stack', needsStack);
        if (needsStack) {
            /* Plus d’espace littéral entre les deux lignes. */
            [...textEl.childNodes]
                .filter((n) => n.nodeType === Node.TEXT_NODE)
                .forEach((n) => n.remove());
        }
    }
}

export function schedulePlanningUserAxisLabelSync() {
    if (typeof window === 'undefined') return;
    if (userAxisLabelRaf) cancelAnimationFrame(userAxisLabelRaf);
    userAxisLabelRaf = requestAnimationFrame(() => {
        userAxisLabelRaf = 0;
        syncPlanningUserAxisLabel();
        /* 2ᵉ frame : après sync colonnes FC / sticky. */
        requestAnimationFrame(() => syncPlanningUserAxisLabel());
    });
    if (!userAxisLabelResizeBound) {
        userAxisLabelResizeBound = true;
        window.addEventListener('resize', schedulePlanningUserAxisLabelSync);
        window.addEventListener('planning-app-header-resized', schedulePlanningUserAxisLabelSync);
    }
}

/**
 * Coin gauche de l’en-tête FullCalendar (paysage étroit) : menu + mois/période + semaine A/B.
 * @param {import('@fullcalendar/core').CalendarApi | null} calendar
 */
export function syncPlanningGridCornerHud(calendar) {
    const calEl = document.getElementById('calendar');
    const axisCell = calEl?.querySelector('.fc-scrollgrid-section-header td.fc-timegrid-axis');
    schedulePlanningUserAxisLabelSync();
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
    const suffix = isProf(getPlanningSessionUser()) ? toolbarWeekCycleShortSuffix(calendar) : '';
    return suffix ? `${base} (${suffix})` : base;
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

    const goToday = () => {
        calendar.today();
        refreshTitle();
    };

    btnToday.addEventListener('click', goToday);
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
    initPlanningAppHeaderOffsetSync();
    requestAnimationFrame(() => syncPlanningAppHeaderOffset());

    return { refreshTitle };
}
