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
 *
 * @param {{ suppressGridInteractionUntil?: number } | null | undefined} [touchInteractionGate]
 *        Fenêtre où FC ne doit pas traiter sélection / clic après un pincement (évite création de créneau fantôme).
 */
export function initSwipe(calendarEl, calendar, touchInteractionGate) {
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
    let pinchTracking = false;
    /** True dès qu’un geste à 2 doigts a commencé, jusqu’à ce que tous les doigts soient relevés. */
    let pinchGestureUsed = false;
    let pinchStartDistance = 0;
    let pinchStartSlotRem = 3.6;
    const NAV_COOLDOWN_MS = 350;
    const PINCH_MIN_REM = 2.2;
    const PINCH_MAX_REM = 6.4;
    const PINCH_SENSITIVITY = 1.35;

    function touchDistance(a, b) {
        const dx = b.clientX - a.clientX;
        const dy = b.clientY - a.clientY;
        return Math.hypot(dx, dy);
    }

    function currentSlotRem() {
        const root = calendarEl.querySelector('.fc');
        const ref = root instanceof HTMLElement ? root : calendarEl;
        const v = getComputedStyle(ref).getPropertyValue('--planning-slot-height').trim();
        const n = parseFloat(v);
        if (Number.isFinite(n) && n > 0) return n;
        return 3.6;
    }

    function setSlotRem(rem) {
        const clamped = Math.max(PINCH_MIN_REM, Math.min(PINCH_MAX_REM, rem));
        calendarEl.style.setProperty('--planning-slot-height', `${clamped.toFixed(2)}rem`);
        const fcRoot = calendarEl.querySelector('.fc');
        if (fcRoot instanceof HTMLElement) {
            fcRoot.style.setProperty('--planning-slot-height', `${clamped.toFixed(2)}rem`);
        }
        if (typeof calendar.updateSize === 'function') calendar.updateSize();
    }

    function bumpPinchSuppressGate() {
        if (!touchInteractionGate) return;
        const until = Date.now() + 550;
        touchInteractionGate.suppressGridInteractionUntil = Math.max(
            touchInteractionGate.suppressGridInteractionUntil ?? 0,
            until
        );
    }
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

    /** Capture + passive:false : avant FullCalendar, pour pouvoir bloquer la sélection sur les colonnes jour. */
    const onTouchStartCapture = (ev) => {
        if (ev.touches && ev.touches.length >= 2) {
            pinchGestureUsed = true;
            pinchTracking = true;
            tracking = false;
            horizontalSwipeStartedOnEvent = false;
            pinchStartDistance = touchDistance(ev.touches[0], ev.touches[1]);
            pinchStartSlotRem = currentSlotRem();
            try {
                if (typeof calendar.unselect === 'function') calendar.unselect();
            } catch {
                /* */
            }
            bumpPinchSuppressGate();
            ev.preventDefault();
            ev.stopPropagation();
            return;
        }
        if (!ev.touches || ev.touches.length !== 1) return;
        const t = ev.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        tracking = true;
        startTarget = ev.target instanceof Element ? ev.target : null;
        horizontalSwipeStartedOnEvent = targetTouchesEventSurface(ev.target);
    };

    const onTouchMoveCapture = (ev) => {
        if (!pinchTracking || !ev.touches || ev.touches.length !== 2) return;
        const d = touchDistance(ev.touches[0], ev.touches[1]);
        if (d <= 0 || pinchStartDistance <= 0) return;
        const ratio = d / pinchStartDistance;
        setSlotRem(pinchStartSlotRem * Math.pow(ratio, PINCH_SENSITIVITY));
        ev.preventDefault();
        ev.stopPropagation();
    };

    const onTouchEndCapture = (ev) => {
        if (pinchGestureUsed) {
            ev.stopPropagation();
        }
        if (pinchTracking && (!ev.touches || ev.touches.length < 2)) {
            pinchTracking = false;
            bumpPinchSuppressGate();
        }
        if (!ev.touches || ev.touches.length === 0) {
            pinchGestureUsed = false;
        }
    };

    const onTouchEnd = (ev) => {
        if (pinchTracking) {
            if (!ev.touches || ev.touches.length < 2) pinchTracking = false;
            return;
        }
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
    calendarEl.addEventListener('touchstart', onTouchStartCapture, { capture: true, passive: false });
    calendarEl.addEventListener('touchmove', onTouchMoveCapture, { capture: true, passive: false });
    calendarEl.addEventListener('touchend', onTouchEndCapture, { capture: true, passive: true });
    calendarEl.addEventListener('touchcancel', onTouchEndCapture, { capture: true, passive: true });
    calendarEl.addEventListener('touchend', onTouchEnd, { passive: true });

    /*
     * Hammer sur #calendar était évité : `touchAction: 'pan-y'` sur le conteneur faisait traiter
     * les glissements verticaux comme du scroll natif, ce qui cassait la sélection de plage
     * (appui long + drag) de FullCalendar. Le swipe horizontal (téléphone / tablette uniquement)
     * reste assuré par touchstart/touchend ci-dessus (seuils dx/dy).
     */
}
