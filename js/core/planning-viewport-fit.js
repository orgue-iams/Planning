/**
 * Portrait smartphone : marque #calendar pour le CSS (scroller sans scroll).
 * Le remplissage vertical des créneaux est géré par FullCalendar `expandRows` + CSS `height: auto` sur les lignes.
 */
let layoutNotifyRaf = 0;
function queuePlanningCalendarLayoutNotify() {
    if (layoutNotifyRaf) return;
    layoutNotifyRaf = requestAnimationFrame(() => {
        layoutNotifyRaf = 0;
        document.dispatchEvent(new CustomEvent('planning-calendar-slot-layout', { bubbles: false }));
    });
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
    calendarEl.style.removeProperty('--planning-slot-height-fit');
    calendarEl.setAttribute('data-planning-portrait-slot-fit', 'true');
    requestAnimationFrame(() => {
        queuePlanningCalendarLayoutNotify();
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
