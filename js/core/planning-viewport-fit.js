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
        return;
    }
    const run = () => {
        const headerSec = calendarEl.querySelector('.fc-scrollgrid-section-header');
        const n = countChapelHourSlotsForFit();
        const ch = calendarEl.clientHeight;
        const hh = headerSec instanceof HTMLElement ? headerSec.offsetHeight : 0;
        const available = Math.max(0, ch - hh - 2);
        const slotPx = Math.max(22, Math.floor(available / n));
        calendarEl.setAttribute('data-planning-portrait-slot-fit', 'true');
        calendarEl.style.setProperty('--planning-slot-height-fit', `${slotPx}px`);
    };
    requestAnimationFrame(run);
}

/**
 * @param {HTMLElement | null} calendarEl
 * @returns {() => void} désinscription
 */
export function bindPlanningPortraitSlotFit(calendarEl) {
    if (!(calendarEl instanceof HTMLElement)) return () => {};
    const ro = new ResizeObserver(() => applyPlanningPortraitSlotFit(calendarEl));
    ro.observe(calendarEl);
    const mq = window.matchMedia('(max-width: 639px) and (orientation: portrait)');
    const onChange = () => applyPlanningPortraitSlotFit(calendarEl);
    mq.addEventListener('change', onChange);
    window.addEventListener('orientationchange', onChange);
    return () => {
        ro.disconnect();
        mq.removeEventListener('change', onChange);
        window.removeEventListener('orientationchange', onChange);
    };
}
