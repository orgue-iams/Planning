/**
 * Swipe horizontal pour naviguer entre périodes (tactile natif, sans Hammer sur le calendrier).
 *
 * Désactivé sur poste classique (souris, Mac/PC) : `(pointer: fine)` + survol au pointeur principal.
 * Activé sur téléphone / tablette : pointeur principal grossier, ou pas de survol (`hover: none`) avec écran tactile.
 */
export function isTouchSwipeWeekNavigationEnabled() {
    if (typeof window === 'undefined') return false;
    if (navigator.maxTouchPoints === 0) return false;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const hoverNone = window.matchMedia('(hover: none)').matches;
    return coarse || hoverNone;
}

/**
 * Swipe horizontal pour naviguer entre périodes (tactile natif, sans Hammer sur le calendrier).
 */
export function initSwipe(calendarEl, calendar) {
    if (!(calendarEl instanceof HTMLElement) || !calendar) return;
    if (!isTouchSwipeWeekNavigationEnabled()) return;

    /** Cibles qui indiquent un geste sur un créneau (drag FC, clic, etc.). */
    const EVENT_SURFACE_SEL =
        '.fc-event, .fc-timegrid-event, .fc-timegrid-event-harness, .fc-list-event, .fc-daygrid-block-event, .fc-daygrid-dot-event, .fc-event-mirror';

    function targetTouchesEventSurface(target) {
        return target instanceof Element && Boolean(target.closest(EVENT_SURFACE_SEL));
    }

    /** Pendant un drag FC : éviter de confondre le déplacement avec un swipe « semaine suivante ». */
    function eventDragInProgress() {
        if (calendarEl.classList.contains('fc-event-dragging')) return true;
        if (calendarEl.querySelector('.fc-event-mirror')) return true;
        return false;
    }

    /** Sélection de plage (clic-glisser / appui long) : ne pas changer de semaine au relâchement. */
    function dateSelectInProgress() {
        return Boolean(calendarEl.querySelector('.fc-highlight'));
    }

    let lastNavAt = 0;
    let horizontalSwipeStartedOnEvent = false;
    const NAV_COOLDOWN_MS = 350;
    const canNavigateNow = () => Date.now() - lastNavAt > NAV_COOLDOWN_MS;
    const navigate = (dir) => {
        if (!canNavigateNow()) return;
        if (document.querySelector('dialog[open]')) return;
        if (eventDragInProgress()) return;
        if (dateSelectInProgress()) return;
        if (horizontalSwipeStartedOnEvent) return;
        lastNavAt = Date.now();
        if (dir === 'next') calendar.next();
        else calendar.prev();
    };

    // --- TouchEvent natif (swipe horizontal).
    let startX = 0;
    let startY = 0;
    let tracking = false;
    let startTarget = null;

    const onPointerDownCapture = (ev) => {
        if (!ev.isPrimary) return;
        if (ev.pointerType === 'mouse' && ev.buttons !== 1) return;
        horizontalSwipeStartedOnEvent = targetTouchesEventSurface(ev.target);
    };

    const onTouchStartCapture = (ev) => {
        if (!ev.touches || ev.touches.length !== 1) return;
        const t = ev.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        tracking = true;
        startTarget = ev.target instanceof Element ? ev.target : null;
        horizontalSwipeStartedOnEvent = targetTouchesEventSurface(ev.target);
    };

    const onTouchEnd = (ev) => {
        if (!tracking || !ev.changedTouches || ev.changedTouches.length !== 1) return;
        tracking = false;

        // Ne pas perturber les interactions sur les événements (drag/resize/clic).
        if (
            startTarget instanceof Element &&
            startTarget.closest(EVENT_SURFACE_SEL)
        ) {
            return;
        }

        const t = ev.changedTouches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);
        if (absX < 44) return;
        if (absX < absY * 1.25) return;

        if (dx < 0) navigate('next');
        else navigate('prev');
    };

    calendarEl.addEventListener('pointerdown', onPointerDownCapture, { capture: true });
    calendarEl.addEventListener('touchstart', onTouchStartCapture, { capture: true, passive: true });
    calendarEl.addEventListener('touchend', onTouchEnd, { passive: true });

    /*
     * Hammer sur #calendar était évité : `touchAction: 'pan-y'` sur le conteneur faisait traiter
     * les glissements verticaux comme du scroll natif, ce qui cassait la sélection de plage
     * (appui long + drag) de FullCalendar. Le swipe horizontal (téléphone / tablette uniquement)
     * reste assuré par touchstart/touchend ci-dessus (seuils dx/dy).
     */
}
