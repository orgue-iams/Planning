export function initSwipe(calendarEl, calendar) {
    if (typeof Hammer === 'undefined') {
        console.warn("Hammer.js non trouvé. Le swipe est désactivé.");
        return;
    }

    const mc = new Hammer(calendarEl);

    mc.on("swipeleft swiperight", (ev) => {
        // Bloquer le swipe si une fenêtre est ouverte
        if (document.querySelector('dialog[open]')) return;

        if (ev.type === "swipeleft") {
            calendar.next();
        } else {
            calendar.prev();
        }
    });

    // Configuration pour ne pas bloquer le scroll vertical
    mc.get('swipe').set({ direction: Hammer.DIRECTION_HORIZONTAL });
}
