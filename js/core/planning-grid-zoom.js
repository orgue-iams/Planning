/**
 * Zoom du tableau planning (mobile / tablette) : curseur légende + pincement deux doigts.
 * Le zoom s’applique sur #calendar sans déplacer le nœud (FullCalendar mesure ce conteneur au render).
 */

const ZOOM_STORAGE_KEY = 'planning-grid-zoom-pct';
const ZOOM_MIN = 75;
const ZOOM_MAX = 150;
const ZOOM_DEFAULT = 100;

/** @type {import('@fullcalendar/core').Calendar | null} */
let zoomCalendarRef = null;
/** @type {HTMLElement | null} */
let zoomTargetEl = null;
let zoomPct = ZOOM_DEFAULT;
let pinchStartDist = 0;
let pinchStartPct = ZOOM_DEFAULT;

function readStoredZoom() {
    try {
        const v = parseInt(sessionStorage.getItem(ZOOM_STORAGE_KEY) || '', 10);
        if (Number.isFinite(v)) return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
    } catch {
        /* */
    }
    return ZOOM_DEFAULT;
}

function storeZoom(pct) {
    try {
        sessionStorage.setItem(ZOOM_STORAGE_KEY, String(pct));
    } catch {
        /* */
    }
}

/** À appeler avant `new FullCalendar` : dé-enveloppe un ancien shell zoom si présent. */
export function prepareCalendarZoomMount() {
    const host = document.getElementById('planning-calendar-zoom-host');
    const cal = document.getElementById('calendar');
    if (host && cal instanceof HTMLElement && host.contains(cal)) {
        const parent = host.parentElement;
        if (parent) {
            parent.insertBefore(cal, host);
            host.remove();
        }
    }
    if (cal instanceof HTMLElement) zoomTargetEl = cal;
    return cal;
}

function applyZoom(pct, { persist = true } = {}) {
    zoomPct = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(pct)));
    const cal = zoomTargetEl || document.getElementById('calendar');
    if (!(cal instanceof HTMLElement)) return;

    const scale = zoomPct / 100;
    if (scale === 1) {
        cal.style.zoom = '';
    } else {
        cal.style.zoom = String(scale);
    }

    const slider = document.getElementById('planning-zoom-range');
    if (slider instanceof HTMLInputElement) {
        slider.value = String(zoomPct);
    }
    const label = document.getElementById('planning-zoom-label');
    if (label) label.textContent = `${zoomPct} %`;

    if (persist) storeZoom(zoomPct);
    zoomCalendarRef?.updateSize();
    requestAnimationFrame(() => zoomCalendarRef?.updateSize());
}

function touchDistance(touches) {
    if (touches.length < 2) return 0;
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
}

function wirePinchZoom(target) {
    target.addEventListener(
        'touchstart',
        (e) => {
            if (e.touches.length === 2) {
                pinchStartDist = touchDistance(e.touches);
                pinchStartPct = zoomPct;
            }
        },
        { passive: true }
    );
    target.addEventListener(
        'touchmove',
        (e) => {
            if (e.touches.length !== 2 || pinchStartDist < 10) return;
            const dist = touchDistance(e.touches);
            const ratio = dist / pinchStartDist;
            applyZoom(pinchStartPct * ratio, { persist: false });
            if (e.cancelable) e.preventDefault();
        },
        { passive: false }
    );
    target.addEventListener('touchend', () => {
        if (pinchStartDist > 0) {
            storeZoom(zoomPct);
            pinchStartDist = 0;
        }
    });
}

function wireZoomSlider() {
    const slider = document.getElementById('planning-zoom-range');
    if (!(slider instanceof HTMLInputElement) || slider.dataset.zoomWired === '1') return;
    slider.dataset.zoomWired = '1';
    slider.min = String(ZOOM_MIN);
    slider.max = String(ZOOM_MAX);
    slider.step = '5';
    slider.value = String(zoomPct);
    slider.addEventListener('input', () => {
        applyZoom(parseInt(slider.value, 10) || ZOOM_DEFAULT);
    });
}

/**
 * @param {import('@fullcalendar/core').Calendar} calendar
 */
export function initPlanningGridZoom(calendar) {
    zoomCalendarRef = calendar;
    const cal = document.getElementById('calendar');
    if (!(cal instanceof HTMLElement)) return;
    zoomTargetEl = cal;

    if (cal.dataset.pinchWired !== '1') {
        cal.dataset.pinchWired = '1';
        wirePinchZoom(cal);
    }
    wireZoomSlider();
    zoomPct = readStoredZoom();
    applyZoom(zoomPct, { persist: false });
}
