/**
 * Ajuste la hauteur des créneaux (portrait smartphone) pour remplir le corps timegrid
 * dans #calendar (flex:1 sous la légende), sans bande sous la dernière heure.
 */
import { getChapelSlotBounds } from './organ-settings.js';

/** FullCalendar ne relit pas toujours le conteneur après --planning-slot-height-fit : app.js écoute et appelle updateSize. */
let layoutNotifyRaf = 0;
function queuePlanningCalendarLayoutNotify() {
    if (layoutNotifyRaf) return;
    layoutNotifyRaf = requestAnimationFrame(() => {
        layoutNotifyRaf = 0;
        document.dispatchEvent(new CustomEvent('planning-calendar-slot-layout', { bubbles: false }));
    });
}

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
        const legend = document.getElementById('planning-legend');
        const headerSec = calendarEl.querySelector('.fc-scrollgrid-section-header');
        const bodyScroller = calendarEl.querySelector('.fc-timegrid-body .fc-scroller');
        const n = countChapelHourSlotsForFit();
        const hh = headerSec instanceof HTMLElement ? headerSec.offsetHeight : 0;

        const fromCalendar = Math.max(0, calendarEl.clientHeight - hh);
        let fromScroller = 0;
        if (bodyScroller instanceof HTMLElement && bodyScroller.clientHeight > 48) {
            fromScroller = bodyScroller.clientHeight;
        }
        /*
         * Bande utile : du bas de l’en-tête jours jusqu’au haut de la légende (mesure réelle dans le flex).
         * Sur Chrome Pixel, plus fiable que le seul clientHeight du scroller.
         */
        let fromLegendBand = 0;
        if (legend instanceof HTMLElement) {
            const cr = calendarEl.getBoundingClientRect();
            const lr = legend.getBoundingClientRect();
            if (lr.top >= cr.top - 0.5) {
                fromLegendBand = Math.max(0, lr.top - cr.top - hh);
            }
        }
        const available = Math.max(fromCalendar, fromScroller, fromLegendBand);
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
        const prev = parseFloat(raw);
        if (!Number.isFinite(prev) || prev <= 0) return;
        calendarEl.style.setProperty('--planning-slot-height-fit', `${(prev + slack / n).toFixed(3)}px`);
    };
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            run();
            queuePlanningCalendarLayoutNotify();
            requestAnimationFrame(() => {
                nudgeFromLegendVsShell();
                requestAnimationFrame(() => {
                    nudgeFromLegendVsShell();
                    queuePlanningCalendarLayoutNotify();
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
    let roTimer = 0;
    const scheduleFit = () => {
        if (roTimer) window.clearTimeout(roTimer);
        roTimer = window.setTimeout(() => {
            roTimer = 0;
            applyPlanningPortraitSlotFit(calendarEl);
        }, 48);
    };
    const ro = new ResizeObserver(() => scheduleFit());
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
        vv.addEventListener('resize', scheduleFit);
        vv.addEventListener('scroll', scheduleFit);
    }
    return () => {
        if (roTimer) window.clearTimeout(roTimer);
        ro.disconnect();
        mq.removeEventListener('change', onChange);
        window.removeEventListener('orientationchange', onChange);
        if (vv) {
            vv.removeEventListener('resize', scheduleFit);
            vv.removeEventListener('scroll', scheduleFit);
        }
    };
}
