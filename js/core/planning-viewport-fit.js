/**
 * Ajuste la hauteur des créneaux (portrait smartphone) pour remplir le corps timegrid
 * dans #calendar (flex:1 sous la légende), sans bande sous la dernière heure.
 */
import { getChapelSlotBounds } from './organ-settings.js';

function slotBoundsToMinutes(hms) {
    const s = String(hms || '00:00:00').trim();
    const m = s.match(/^(\d{1,2}):(\d{2})/);
    if (!m) return 0;
    const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
    const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
    return h * 60 + min;
}

/** Nombre de lignes d’une heure (slotDuration 1 h) entre slotMinTime et slotMaxTime (fin exclusive FC). */
export function countChapelHourSlotsForFit() {
    const { slotMinTime, slotMaxTime } = getChapelSlotBounds();
    const minM = slotBoundsToMinutes(slotMinTime);
    const maxM = slotBoundsToMinutes(slotMaxTime);
    return Math.max(1, Math.round((maxM - minM) / 60));
}

/**
 * @param {HTMLElement | null} calendarEl `#calendar`
 */
export function applyPlanningPortraitSlotFit(calendarEl) {
    if (!(calendarEl instanceof HTMLElement) || typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 639px) and (orientation: portrait)');
    if (!mq.matches) {
        calendarEl.removeAttribute('data-planning-portrait-slot-fit');
        calendarEl.style.removeProperty('--planning-slot-height-fit');
        calendarEl.style.removeProperty('height');
        return;
    }
    const run = () => {
        const headerSec = calendarEl.querySelector('.fc-scrollgrid-section-header');
        const bodyScroller = calendarEl.querySelector('.fc-timegrid-body .fc-scroller');
        const n = countChapelHourSlotsForFit();
        const hh = headerSec instanceof HTMLElement ? headerSec.offsetHeight : 0;
        /*
         * #calendar a flex:1 dans #app-shell : sa hauteur allouée pilote le remplissage.
         * On mesure le scroller timegrid (Chrome / scrollbar-gutter) ou repli sur clientHeight − en-tête.
         */
        const fromCalendar = Math.max(0, calendarEl.clientHeight - hh);
        let available = fromCalendar;
        if (bodyScroller instanceof HTMLElement && bodyScroller.clientHeight > 48) {
            /* Scroller parfois plus petit que #calendar − en-tête (gutter) : prendre le max. */
            available = Math.max(bodyScroller.clientHeight, fromCalendar);
        }
        const slotPx = Math.max(22, available / n);
        calendarEl.setAttribute('data-planning-portrait-slot-fit', 'true');
        calendarEl.style.setProperty('--planning-slot-height-fit', `${slotPx.toFixed(3)}px`);
    };
    /** Répartit l’écart sous la légende (shell, fenêtre ou visualViewport — Chrome Android). */
    const nudgeFromLegendVsShell = () => {
        const mqp = window.matchMedia('(max-width: 639px) and (orientation: portrait)');
        if (!mqp.matches) return;
        const legend = document.getElementById('planning-legend');
        const shell = document.getElementById('app-shell');
        if (!(legend instanceof HTMLElement)) return;
        const legBottom = legend.getBoundingClientRect().bottom;
        let slack = 0;
        if (shell instanceof HTMLElement) {
            slack = Math.max(slack, shell.getBoundingClientRect().bottom - legBottom);
        }
        slack = Math.max(slack, window.innerHeight - legBottom);
        const vv = window.visualViewport;
        if (vv) {
            slack = Math.max(slack, vv.offsetTop + vv.height - legBottom);
        }
        if (slack <= 1.5) return;
        const n = countChapelHourSlotsForFit();
        const raw = calendarEl.style.getPropertyValue('--planning-slot-height-fit').trim();
        const prev = parseFloat(raw, 10);
        if (!Number.isFinite(prev) || prev <= 0) return;
        calendarEl.style.setProperty('--planning-slot-height-fit', `${(prev + slack / n).toFixed(3)}px`);
    };
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            run();
            requestAnimationFrame(() => {
                nudgeFromLegendVsShell();
                requestAnimationFrame(() => {
                    nudgeFromLegendVsShell();
                });
            });
        });
    });
}

/**
 * @param {HTMLElement | null} calendarEl
 * @returns {() => void} désinscription
 */
export function bindPlanningPortraitSlotFit(calendarEl) {
    if (!(calendarEl instanceof HTMLElement)) return () => {};
    const ro = new ResizeObserver(() => applyPlanningPortraitSlotFit(calendarEl));
    ro.observe(calendarEl);
    const shell = document.getElementById('app-shell');
    if (shell instanceof HTMLElement) {
        ro.observe(shell);
    }
    const legend = document.getElementById('planning-legend');
    if (legend instanceof HTMLElement) {
        ro.observe(legend);
    }
    const mq = window.matchMedia('(max-width: 639px) and (orientation: portrait)');
    const onChange = () => applyPlanningPortraitSlotFit(calendarEl);
    mq.addEventListener('change', onChange);
    window.addEventListener('orientationchange', onChange);
    const vv = window.visualViewport;
    if (vv) {
        vv.addEventListener('resize', onChange);
        vv.addEventListener('scroll', onChange);
    }
    return () => {
        ro.disconnect();
        mq.removeEventListener('change', onChange);
        window.removeEventListener('orientationchange', onChange);
        if (vv) {
            vv.removeEventListener('resize', onChange);
            vv.removeEventListener('scroll', onChange);
        }
    };
}
