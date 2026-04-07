export function initSwipe(calendarEl, calendar) {
    const HammerRef = typeof window !== 'undefined' ? window.Hammer : undefined;
    if (!HammerRef) {
        console.warn('Hammer.js non trouvé. Le swipe est désactivé.');
        return;
    }

    // `touch-action: pan-y` : laisser le défilement vertical au navigateur (Android / Chrome).
    const mc = new HammerRef(calendarEl, { touchAction: 'pan-y' });
    mc.get('swipe').set({ direction: HammerRef.DIRECTION_HORIZONTAL, threshold: 30, velocity: 0.2 });

    mc.on('swipeleft swiperight', (ev) => {
        if (document.querySelector('dialog[open]')) return;

        if (ev.type === 'swipeleft') calendar.next();
        else calendar.prev();
    });
}
