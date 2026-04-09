/**
 * Swipe horizontal pour naviguer entre périodes.
 * Robuste mobile/tablette: Hammer.js si dispo + fallback natif touch.
 */
export function initSwipe(calendarEl, calendar) {
    if (!(calendarEl instanceof HTMLElement) || !calendar) return;

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

    let lastNavAt = 0;
    let horizontalSwipeStartedOnEvent = false;
    const NAV_COOLDOWN_MS = 350;
    const canNavigateNow = () => Date.now() - lastNavAt > NAV_COOLDOWN_MS;
    const navigate = (dir) => {
        if (!canNavigateNow()) return;
        if (document.querySelector('dialog[open]')) return;
        if (eventDragInProgress()) return;
        if (horizontalSwipeStartedOnEvent) return;
        lastNavAt = Date.now();
        if (dir === 'next') calendar.next();
        else calendar.prev();
    };

    // --- Fallback natif TouchEvent (utile si Hammer ne capte pas correctement).
    let startX = 0;
    let startY = 0;
    let tracking = false;
    let startTarget = null;

    const onPointerDownCapture = (ev) => {
        if (!ev.isPrimary) return;
        if (ev.pointerType === 'mouse' && ev.buttons !== 1) return;
        horizontalSwipeStartedOnEvent = targetTouchesEventSurface(ev.target);
    };

    const onTouchStart = (ev) => {
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
    calendarEl.addEventListener('touchstart', onTouchStart, { passive: true });
    calendarEl.addEventListener('touchend', onTouchEnd, { passive: true });

    // --- Hammer.js (si dispo) : garde le comportement historique.
    const HammerRef = typeof window !== 'undefined' ? window.Hammer : undefined;
    if (!HammerRef) {
        return;
    }
    const mc = new HammerRef(calendarEl, { touchAction: 'pan-y' });
    mc.get('swipe').set({ direction: HammerRef.DIRECTION_HORIZONTAL, threshold: 30, velocity: 0.2 });
    mc.on('swipeleft swiperight', (ev) => {
        const src = ev.srcEvent ?? ev.originalEvent;
        const tgt = src && 'target' in src ? src.target : null;
        if (targetTouchesEventSurface(tgt)) return;
        if (eventDragInProgress()) return;
        if (horizontalSwipeStartedOnEvent) return;
        if (ev.type === 'swipeleft') navigate('next');
        else navigate('prev');
    });
}
