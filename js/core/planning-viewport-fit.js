/**
 * Ajuste la hauteur des créneaux (portrait smartphone) pour remplir #calendar sans scroll vertical.
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
        const shell = document.getElementById('app-shell');
        const legend = document.getElementById('planning-legend');
        const headerSec = calendarEl.querySelector('.fc-scrollgrid-section-header');
        const n = countChapelHourSlotsForFit();
        const hh = headerSec instanceof HTMLElement ? headerSec.offsetHeight : 0;

        const calTop = calendarEl.getBoundingClientRect().top;
        /*
         * Bas cible : le plus bas entre innerHeight, visualViewport et #app-shell.
         * Sur Pixel / Chrome, Math.min(shell, vv) sous-estimait et laissait du vide sous la légende.
         */
        let viewportBottom = window.innerHeight;
        const vv = window.visualViewport;
        if (vv) {
            viewportBottom = Math.max(viewportBottom, vv.offsetTop + vv.height);
        }
        if (shell instanceof HTMLElement) {
            viewportBottom = Math.max(viewportBottom, shell.getBoundingClientRect().bottom);
        }

        let legendH = 0;
        if (legend instanceof HTMLElement) {
            legendH = legend.offsetHeight;
        }

        /*
         * Hauteur du corps timegrid pour que calendrier + légende remplissent jusqu’au bas de l’écran
         * (l’espace libre est réparti sur n créneaux).
         */
        const available = Math.max(0, viewportBottom - calTop - hh - legendH);
        const slotPx = Math.max(22, available / n);
        calendarEl.setAttribute('data-planning-portrait-slot-fit', 'true');
        calendarEl.style.setProperty('--planning-slot-height-fit', `${slotPx.toFixed(3)}px`);
    };
    const pinCalendarBoxToFc = () => {
        const mqp = window.matchMedia('(max-width: 639px) and (orientation: portrait)');
        if (!mqp.matches) return;
        const fc = calendarEl.querySelector('.fc');
        if (fc instanceof HTMLElement) {
            const h = Math.ceil(fc.getBoundingClientRect().height);
            if (h > 48) {
                calendarEl.style.height = `${h}px`;
            }
        }
    };
    /** Corrige le few px restants une fois la légende positionnée (arrondis / barre d’adresse). */
    const nudgeSlotsFromLegendSlack = () => {
        const mqp = window.matchMedia('(max-width: 639px) and (orientation: portrait)');
        if (!mqp.matches) return;
        const legend = document.getElementById('planning-legend');
        if (!(legend instanceof HTMLElement)) return;
        const shell = document.getElementById('app-shell');
        let targetBottom = window.innerHeight;
        const vv = window.visualViewport;
        if (vv) {
            targetBottom = Math.max(targetBottom, vv.offsetTop + vv.height);
        }
        if (shell instanceof HTMLElement) {
            targetBottom = Math.max(targetBottom, shell.getBoundingClientRect().bottom);
        }
        const slack = targetBottom - legend.getBoundingClientRect().bottom;
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
                pinCalendarBoxToFc();
                requestAnimationFrame(() => {
                    nudgeSlotsFromLegendSlack();
                    requestAnimationFrame(pinCalendarBoxToFc);
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
